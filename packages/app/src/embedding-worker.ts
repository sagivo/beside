import type { IModelAdapter, IStorage, Logger } from '@cofounderos/interfaces';

export interface EmbeddingWorkerOptions {
  enabled?: boolean;
  modelName?: string;
  batchSize?: number;
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
  private warnedUnavailable = false;

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
  }

  async tick(): Promise<EmbeddingWorkerResult> {
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

    try {
      const vectors = await this.model.embed(tasks.map((t) => t.content));
      let processed = 0;
      let failed = 0;
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i]!;
        const vector = vectors[i];
        if (!vector || vector.length === 0) {
          failed += 1;
          continue;
        }
        await this.storage.upsertFrameEmbedding(
          task.id,
          this.modelName,
          task.content_hash,
          vector,
        );
        processed += 1;
      }
      if (processed > 0) {
        this.logger.debug(`embedded ${processed} frame(s), ${failed} failed`);
      }
      return {
        processed,
        failed,
        remaining: Math.max(0, tasks.length - processed),
      };
    } catch (err) {
      this.logger.warn('embedding batch failed', { err: String(err) });
      return { processed: 0, failed: tasks.length, remaining: tasks.length };
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
