import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import type {
  IStorage,
  Logger,
  FrameAsset,
} from '@beside/interfaces';

/**
 * StorageVacuum — sliding-window retention for screenshot assets.
 *
 * Two monotonic stages:
 *
 *   original   →   compressed   →   deleted
 *   (capture)      (lower q)        (gone)
 *
 * Frame metadata + OCR text stay in SQLite forever; only the on-disk
 * image evolves. Each stage is idempotent and resumable: if a vacuum
 * tick is interrupted halfway through, the next tick picks up where it
 * left off because we promote the `vacuum_tier` column atomically with
 * the file write.
 */

export interface StorageVacuumConfig {
  storageRoot: string;
  /** Days before each stage runs. 0 disables the stage. */
  compressAfterDays: number;
  compressQuality: number;
  deleteAfterDays: number;
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
  async tick(): Promise<{ compressed: number; deleted: number }> {
    const now = Date.now();
    const compressed = await this.runCompressPass(now);
    const deleted = await this.runDeletePass(now);
    if (compressed + deleted > 0) {
      this.logger.info(`vacuum: compressed ${compressed}, deleted ${deleted}`);
    }
    return { compressed, deleted };
  }

  /**
   * Drain — call `tick()` until all stages report zero work. Used by
   * `--full-reindex` so a long-running install can pull all the way down
   * to its retention floor in one shot.
   */
  async drain(): Promise<{ compressed: number; deleted: number }> {
    const totals = { compressed: 0, deleted: 0 };
    for (let i = 0; i < 1000; i++) {
      const r = await this.tick();
      totals.compressed += r.compressed;
      totals.deleted += r.deleted;
      if (r.compressed + r.deleted === 0) break;
    }
    return totals;
  }

  // ---------------------------------------------------------------------------
  // Stages
  // ---------------------------------------------------------------------------

  private async runCompressPass(nowMs: number): Promise<number> {
    if (this.config.compressAfterDays <= 0) return 0;
    const olderThan = isoMsAgo(nowMs, this.config.compressAfterDays * 86400000);
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

  private async runDeletePass(nowMs: number): Promise<number> {
    if (this.config.deleteAfterDays <= 0) return 0;
    const olderThan = isoMsAgo(nowMs, this.config.deleteAfterDays * 86400000);
    // Compressed and (legacy) thumbnail tiers are both eligible for deletion.
    let n = 0;
    for (const tier of ['thumbnail', 'compressed'] as const) {
      const candidates = await this.storage.listFramesForVacuum(
        tier,
        olderThan,
        this.config.batchSize,
      );
      for (const c of candidates) {
        await this.storage.updateFrameAsset(c.id, {
          assetPath: null,
          tier: 'deleted',
        });
        try {
          await this.deleteOne(c);
        } catch (err) {
          this.logger.debug('delete failed (file may be gone)', {
            err: String(err),
            id: c.id,
          });
        }
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

  private async deleteOne(asset: FrameAsset): Promise<void> {
    await this.storage.deleteAssetIfUnreferenced(asset.asset_path);
  }

  /**
   * If a compress fails (file missing, corrupt, etc.) we still want to
   * mark the frame as "moved past original" so the worker doesn't
   * retry it on every tick.
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
