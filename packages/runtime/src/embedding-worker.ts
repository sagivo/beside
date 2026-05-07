import type { IModelAdapter, IStorage, Logger } from '@cofounderos/interfaces';

export interface EmbeddingWorkerOptions {
  enabled?: boolean;
  modelName?: string;
  batchSize?: number;
  /**
   * How long (ms) to keep the model loaded after the last embedding tick
   * before calling `model.unload()`. Defaults to 30 000 ms (30 s).
   * Set to 0 to unload immediately after each tick (legacy behaviour).
   */
  unloadAfterIdleMs?: number;
}

export interface EmbeddingWorkerResult {
  processed: number;
  failed: number;
  remaining: number;
}

/**
 * EmbeddingWorker — materialises semantic vectors for frames.
 *
 * The worker is deliberately small and incremental:
 *  - storage decides which frames are stale for a given embedding model
 *    by comparing content hashes;
 *  - the active model adapter embeds one batch of frame text/title/url;
 *  - vectors are stored as normalised JSON in SQLite.
 *
 * We avoid a hard sqlite-vec dependency in V2.1 so installs stay simple
 * across macOS/Linux; the IStorage methods are already shaped so the
 * local adapter can swap to sqlite-vec later without touching workers
 * or MCP tools.
 */
export class EmbeddingWorker {
  private readonly logger: Logger;
  private readonly enabled: boolean;
  private readonly modelName: string;
  private readonly batchSize: number;
  private readonly unloadAfterIdleMs: number;
  private warnedUnavailable = false;
  private unloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly storage: IStorage,
    private readonly model: IModelAdapter,
    logger: Logger,
    opts: EmbeddingWorkerOptions = {},
  ) {
    this.logger = logger.child('embedding-worker');
    this.enabled = opts.enabled ?? true;
    this.modelName = opts.modelName ?? model.getModelInfo().name;
    this.batchSize = opts.batchSize ?? 32;
    this.unloadAfterIdleMs = opts.unloadAfterIdleMs ?? 30_000;
  }

  private scheduleUnload(): void {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    if (this.unloadAfterIdleMs <= 0) {
      void this.model.unload?.().catch((err: unknown) => {
        this.logger.debug('model unload failed', { err: String(err) });
      });
      return;
    }
    this.unloadTimer = setTimeout(() => {
      this.unloadTimer = null;
      void this.model.unload?.().catch((err: unknown) => {
        this.logger.debug('model unload after idle failed', { err: String(err) });
      });
    }, this.unloadAfterIdleMs);
  }

  async tick(): Promise<EmbeddingWorkerResult> {
    if (this.unloadTimer) {
      clearTimeout(this.unloadTimer);
      this.unloadTimer = null;
    }
    if (!this.enabled) return { processed: 0, failed: 0, remaining: 0 };
    if (typeof this.model.embed !== 'function') {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        this.logger.warn('model adapter does not support embeddings; semantic search disabled');
      }
      return { processed: 0, failed: 0, remaining: 0 };
    }

    const tasks = await this.storage.listFramesNeedingEmbedding(
      this.modelName,
      this.batchSize,
    );
    if (tasks.length === 0) return { processed: 0, failed: 0, remaining: 0 };

    // Dedupe by content_hash. A user dwelling on one Slack channel /
    // browser tab / editor buffer produces many frames whose
    // App + Window + URL + Entity + Text content is byte-identical, so
    // we'd otherwise call `model.embed` once per duplicate (which is
    // both wasteful and the slowest part of any indexing tick).
    const tasksByHash = new Map<string, typeof tasks>();
    for (const task of tasks) {
      const bucket = tasksByHash.get(task.content_hash);
      if (bucket) bucket.push(task);
      else tasksByHash.set(task.content_hash, [task]);
    }

    // Cross-batch reuse: if storage already has an embedding for this
    // exact content_hash on any *other* frame, we can reuse the
    // vector without going to the model at all. Storage decides
    // whether it exposes this capability; if not, we fall through to
    // the in-batch dedupe alone.
    const cached = new Map<string, number[]>();
    const hashes = Array.from(tasksByHash.keys());
    if (typeof this.storage.findExistingFrameEmbeddings === 'function') {
      // Batch path: single IN query for all hashes.
      try {
        const hits = await this.storage.findExistingFrameEmbeddings(this.modelName, hashes);
        for (const [hash, hit] of hits) {
          if (hit.vector.length > 0) cached.set(hash, hit.vector);
        }
      } catch (err) {
        this.logger.debug('batch cached embedding lookup failed (continuing)', {
          err: String(err),
        });
      }
    } else if (typeof this.storage.findExistingFrameEmbedding === 'function') {
      // Fallback: sequential lookups for storage plugins without the batch method.
      for (const hash of hashes) {
        try {
          const hit = await this.storage.findExistingFrameEmbedding(this.modelName, hash);
          if (hit && hit.vector.length > 0) cached.set(hash, hit.vector);
        } catch (err) {
          this.logger.debug('cached embedding lookup failed (continuing)', {
            err: String(err),
          });
        }
      }
    }

    // Hashes still needing a fresh embedding: the in-batch unique set
    // minus anything we just resurrected from storage.
    const uncachedHashes: string[] = [];
    const uncachedContent: string[] = [];
    for (const [hash, bucket] of tasksByHash) {
      if (cached.has(hash)) continue;
      uncachedHashes.push(hash);
      uncachedContent.push(bucket[0]!.content);
    }

    try {
      const vectors = uncachedContent.length > 0
        ? await this.model.embed(uncachedContent)
        : [];
      const fresh = new Map<string, number[]>();
      for (let i = 0; i < uncachedHashes.length; i++) {
        const v = vectors[i];
        if (v && v.length > 0) fresh.set(uncachedHashes[i]!, v);
      }

      let processed = 0;
      let failed = 0;
      let cacheHits = 0;
      let dedupeHits = 0;
      const embeddingsToWrite: Array<{
        frameId: string;
        model: string;
        contentHash: string;
        vector: number[];
      }> = [];
      for (const [hash, bucket] of tasksByHash) {
        const vector = cached.get(hash) ?? fresh.get(hash);
        if (!vector || vector.length === 0) {
          failed += bucket.length;
          continue;
        }
        for (const task of bucket) {
          embeddingsToWrite.push({
            frameId: task.id,
            model: this.modelName,
            contentHash: task.content_hash,
            vector,
          });
          processed += 1;
        }
        if (cached.has(hash)) cacheHits += bucket.length;
        else if (bucket.length > 1) dedupeHits += bucket.length - 1;
      }
      if (typeof this.storage.upsertFrameEmbeddings === 'function') {
        await this.storage.upsertFrameEmbeddings(embeddingsToWrite);
      } else {
        for (const item of embeddingsToWrite) {
          await this.storage.upsertFrameEmbedding(
            item.frameId,
            item.model,
            item.contentHash,
            item.vector,
          );
        }
      }
      if (processed > 0) {
        const reused = cacheHits + dedupeHits;
        this.logger.debug(
          reused > 0
            ? `embedded ${processed} frame(s), ${failed} failed (${cacheHits} cache hit, ${dedupeHits} in-batch dedupe; ${uncachedContent.length} model calls)`
            : `embedded ${processed} frame(s), ${failed} failed`,
        );
      }
      return {
        processed,
        failed,
        remaining: Math.max(0, tasks.length - processed),
      };
    } catch (err) {
      this.logger.warn('embedding batch failed', { err: String(err) });
      return { processed: 0, failed: tasks.length, remaining: tasks.length };
    } finally {
      this.scheduleUnload();
    }
  }

  async drain(): Promise<EmbeddingWorkerResult> {
    const total: EmbeddingWorkerResult = { processed: 0, failed: 0, remaining: 0 };
    for (let i = 0; i < 10_000; i++) {
      const r = await this.tick();
      total.processed += r.processed;
      total.failed += r.failed;
      total.remaining = r.remaining;
      if (r.processed === 0) break;
      if (r.processed < this.batchSize) break;
    }
    return total;
  }

  getModelName(): string {
    return this.modelName;
  }
}
