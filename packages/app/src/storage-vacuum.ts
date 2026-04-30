import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import type {
  IStorage,
  Logger,
  FrameAsset,
  FrameAssetTier,
} from '@cofounderos/interfaces';

/**
 * StorageVacuum — sliding-window retention for screenshot assets.
 *
 * Three monotonic stages:
 *
 *   original   →   compressed   →   thumbnail   →   deleted
 *   (capture)      (lower q)        (downscaled)     (gone)
 *
 * Frame metadata + OCR text stay in SQLite forever; only the on-disk
 * image evolves. Each stage is idempotent and resumable: if a vacuum
 * tick is interrupted halfway through, the next tick picks up where it
 * left off because we promote the `vacuum_tier` column atomically with
 * the file write.
 *
 * The worker mirrors `OcrWorker`'s shape — small batches, throttled,
 * never blocks indexing.
 */

export interface StorageVacuumConfig {
  storageRoot: string;
  /**
   * Window in **milliseconds** before each stage runs. 0 disables the
   * stage. Expressed in ms (rather than days) so callers can tune
   * vacuum at minute-granularity for testing / tight retention.
   */
  compressAfterMs: number;
  compressQuality: number;
  thumbnailAfterMs: number;
  thumbnailMaxDim: number;
  deleteAfterMs: number;
  batchSize: number;
}

export class StorageVacuum {
  private readonly logger: Logger;

  constructor(
    private readonly storage: IStorage,
    logger: Logger,
    private readonly config: StorageVacuumConfig,
  ) {
    this.logger = logger.child('storage-vacuum');
  }

  /**
   * Run one vacuum pass across all enabled stages. Returns counts so
   * the orchestrator can log a one-line summary.
   */
  async tick(): Promise<{
    compressed: number;
    thumbnailed: number;
    deleted: number;
  }> {
    const now = Date.now();
    const compressed = await this.runCompressPass(now);
    const thumbnailed = await this.runThumbnailPass(now);
    const deleted = await this.runDeletePass(now);
    if (compressed + thumbnailed + deleted > 0) {
      this.logger.info(
        `vacuum: compressed ${compressed}, thumbnailed ${thumbnailed}, deleted ${deleted}`,
      );
    }
    return { compressed, thumbnailed, deleted };
  }

  /**
   * Drain — call `tick()` until all stages report zero work. Used by
   * `--full-reindex` so a long-running install can pull all the way down
   * to its retention floor in one shot.
   */
  async drain(): Promise<{ compressed: number; thumbnailed: number; deleted: number }> {
    const totals = { compressed: 0, thumbnailed: 0, deleted: 0 };
    for (let i = 0; i < 1000; i++) {
      const r = await this.tick();
      totals.compressed += r.compressed;
      totals.thumbnailed += r.thumbnailed;
      totals.deleted += r.deleted;
      if (r.compressed + r.thumbnailed + r.deleted === 0) break;
    }
    return totals;
  }

  // ---------------------------------------------------------------------------
  // Stages
  // ---------------------------------------------------------------------------

  private async runCompressPass(nowMs: number): Promise<number> {
    if (this.config.compressAfterMs <= 0) return 0;
    const olderThan = isoMsAgo(nowMs, this.config.compressAfterMs);
    const candidates = await this.storage.listFramesForVacuum(
      'original',
      olderThan,
      this.config.batchSize,
    );
    let n = 0;
    for (const c of candidates) {
      try {
        const newRel = await this.compressOne(c);
        await this.storage.updateFrameAsset(c.id, {
          assetPath: newRel,
          tier: 'compressed',
        });
        n += 1;
      } catch (err) {
        this.logger.warn('compress failed', { err: String(err), id: c.id });
        // Mark as compressed anyway to avoid endless retries on a
        // permanently broken file (e.g., asset deleted out of band).
        await this.tryMarkBrokenAsCompressed(c);
      }
    }
    return n;
  }

  private async runThumbnailPass(nowMs: number): Promise<number> {
    if (this.config.thumbnailAfterMs <= 0) return 0;
    const olderThan = isoMsAgo(nowMs, this.config.thumbnailAfterMs);
    const candidates = await this.storage.listFramesForVacuum(
      'compressed',
      olderThan,
      this.config.batchSize,
    );
    let n = 0;
    for (const c of candidates) {
      try {
        await this.thumbnailOne(c);
        await this.storage.updateFrameAsset(c.id, { tier: 'thumbnail' });
        n += 1;
      } catch (err) {
        this.logger.warn('thumbnail failed', { err: String(err), id: c.id });
        await this.storage.updateFrameAsset(c.id, { tier: 'thumbnail' });
      }
    }
    return n;
  }

  private async runDeletePass(nowMs: number): Promise<number> {
    if (this.config.deleteAfterMs <= 0) return 0;
    const olderThan = isoMsAgo(nowMs, this.config.deleteAfterMs);
    // Both compressed and thumbnail tiers are eligible for deletion once
    // they're old enough — query both in turn.
    let n = 0;
    for (const tier of ['thumbnail', 'compressed'] as const) {
      const candidates = await this.storage.listFramesForVacuum(
        tier,
        olderThan,
        this.config.batchSize,
      );
      for (const c of candidates) {
        try {
          await this.deleteOne(c);
        } catch (err) {
          this.logger.debug('delete failed (file may be gone)', {
            err: String(err),
            id: c.id,
          });
        }
        await this.storage.updateFrameAsset(c.id, {
          assetPath: null,
          tier: 'deleted',
        });
        n += 1;
      }
    }
    return n;
  }

  // ---------------------------------------------------------------------------
  // File-level operations
  // ---------------------------------------------------------------------------

  /**
   * Re-encode an asset to WebP at low quality. If the source file is
   * already WebP the operation is a same-format quality drop; if it's
   * JPEG (legacy capture) we additionally swap the file extension and
   * return the new relative path.
   */
  private async compressOne(asset: FrameAsset): Promise<string> {
    const absSrc = path.join(this.config.storageRoot, asset.asset_path);
    const ext = path.extname(asset.asset_path).toLowerCase();
    const isJpeg = ext === '.jpg' || ext === '.jpeg';
    const newRel = isJpeg
      ? asset.asset_path.replace(/\.(jpg|jpeg)$/i, '.webp')
      : asset.asset_path;
    const absDst = path.join(this.config.storageRoot, newRel);
    const buf = await fs.readFile(absSrc);
    const out = await sharp(buf)
      .webp({ quality: this.config.compressQuality })
      .toBuffer();
    await fs.writeFile(absDst, out);
    if (newRel !== asset.asset_path) {
      // Source was JPEG; remove it so we don't double-store the same
      // moment. Failure to unlink is non-fatal (e.g., readonly volume).
      try {
        await fs.unlink(absSrc);
      } catch {
        // ignore
      }
    }
    return newRel;
  }

  /**
   * Downscale the asset to `thumbnailMaxDim` on its longest edge, in
   * place. We don't change the format here — the file is already WebP
   * after the compress pass.
   */
  private async thumbnailOne(asset: FrameAsset): Promise<void> {
    const abs = path.join(this.config.storageRoot, asset.asset_path);
    const buf = await fs.readFile(abs);
    const out = await sharp(buf)
      .resize({
        width: this.config.thumbnailMaxDim,
        height: this.config.thumbnailMaxDim,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 70 })
      .toBuffer();
    await fs.writeFile(abs, out);
  }

  private async deleteOne(asset: FrameAsset): Promise<void> {
    const abs = path.join(this.config.storageRoot, asset.asset_path);
    await fs.unlink(abs);
  }

  /**
   * If a compress fails (file missing, corrupt, etc.) we still want to
   * mark the frame as "moved past original" so the worker doesn't
   * retry it on every tick. We do not promote past compressed because
   * a future thumbnail pass would also fail and produce noise.
   */
  private async tryMarkBrokenAsCompressed(asset: FrameAsset): Promise<void> {
    try {
      await this.storage.updateFrameAsset(asset.id, { tier: 'compressed' });
    } catch {
      // ignore
    }
  }
}

function isoMsAgo(nowMs: number, ms: number): string {
  return new Date(nowMs - ms).toISOString();
}
