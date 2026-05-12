import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  DayEvent,
  EntityKind,
  EntityRecord,
  IIndexStrategy,
  IModelAdapter,
  IStorage,
  Logger,
  Meeting,
  MemoryChunk,
  MemoryChunkKind,
} from '@cofounderos/interfaces';

export interface EmbeddingWorkerOptions {
  enabled?: boolean;
  modelName?: string;
  batchSize?: number;
  /** Optional wiki strategy used to materialise summary/page chunks. */
  strategy?: IIndexStrategy;
  /**
   * How long (ms) to keep the model loaded after the last embedding tick
   * before calling `model.unload()`. Defaults to 30 000 ms (30 s).
   * Set to 0 to unload immediately after each tick (legacy behaviour).
   */
  unloadAfterIdleMs?: number;
}

interface MemoryChunkInput {
  kind: MemoryChunkKind;
  sourceId: string;
  title: string;
  body: string;
  entityPath: string | null;
  entityKind: EntityKind | null;
  day: string | null;
  timestamp: string | null;
  sourceRefs: string[];
  now: string;
}

const MAX_MEMORY_CHUNK_CHARS = 8000;

function makeMemoryChunk(input: MemoryChunkInput): MemoryChunk {
  const title = normaliseWhitespace(input.title).slice(0, 240) || input.sourceId;
  const body = normaliseBody(input.body);
  const sourceRefs = [...new Set(input.sourceRefs.filter(Boolean))];
  const createdAt = input.timestamp ?? input.now;
  const updatedAt = input.now;
  const identity = [
    input.kind,
    input.sourceId,
    input.entityPath ?? '',
    input.day ?? '',
  ].join('\n');
  return {
    id: `mem_${input.kind}_${sha256Text(identity).slice(0, 20)}`,
    kind: input.kind,
    sourceId: input.sourceId,
    title,
    body,
    entityPath: input.entityPath,
    entityKind: input.entityKind,
    day: input.day,
    timestamp: input.timestamp,
    sourceRefs,
    contentHash: sha256Text(memoryChunkEmbeddingContent({
      kind: input.kind,
      title,
      body,
      entityPath: input.entityPath,
      day: input.day,
      timestamp: input.timestamp,
    })),
    createdAt,
    updatedAt,
  };
}

async function walkMarkdownPages(rootPath: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(abs: string, relPrefix = ''): Promise<void> {
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const full = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        await visit(full, rel);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (entry.name === 'index.md' || entry.name === 'log.md') continue;
      out.push(rel);
    }
  }
  await visit(rootPath);
  out.sort();
  return out;
}

function extractMarkdownTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+?)\s*$/m);
  return match ? normaliseWhitespace(match[1] ?? '') : null;
}

function stripIndexMetadata(content: string): string {
  let text = content.replace(/^---\n[\s\S]*?\n---\n?/u, '');
  text = text.replace(/<!--\s*cofounderos:[\s\S]*?-->\n?/giu, '');
  text = text.replace(/^#\s+.+?\s*$/m, '').trim();
  return text;
}

function entityKindFromPagePath(relPath: string): EntityKind | null {
  const first = relPath.split('/')[0]?.toLowerCase();
  switch (first) {
    case 'projects': return 'project';
    case 'repos': return 'repo';
    case 'meetings': return 'meeting';
    case 'contacts': return 'contact';
    case 'channels': return 'channel';
    case 'docs': return 'doc';
    case 'webpages': return 'webpage';
    case 'apps': return 'app';
    default: return null;
  }
}

function dayFromText(content: string): string | null {
  const explicit = content.match(/\b(?:day|date|last_seen|first_seen)\s*:\s*(\d{4}-\d{2}-\d{2})\b/i);
  if (explicit) return explicit[1] ?? null;
  const anyDate = content.match(/\b(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/);
  return anyDate?.[1] ?? null;
}

function deterministicMeetingBody(meeting: Meeting): string {
  const pieces = [
    meeting.title ?? meeting.entity_path,
    `Meeting from ${meeting.started_at} to ${meeting.ended_at}.`,
    `Platform: ${meeting.platform}.`,
    `Frames: ${meeting.frame_count}; audio chunks: ${meeting.audio_chunk_count}; transcript chars: ${meeting.transcript_chars}.`,
  ];
  return pieces.filter(Boolean).join('\n');
}

function truncateForChunk(text: string, maxChars = MAX_MEMORY_CHUNK_CHARS): string {
  const body = normaliseBody(text);
  if (body.length <= maxChars) return body;
  return `${body.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n[truncated]`;
}

function memoryChunkEmbeddingContent(chunk: {
  kind: MemoryChunkKind;
  title: string;
  body: string;
  entityPath: string | null;
  day: string | null;
  timestamp: string | null;
}): string {
  const parts = [
    `Kind: ${chunk.kind}`,
    chunk.title ? `Title: ${chunk.title}` : null,
    chunk.entityPath ? `Entity: ${chunk.entityPath}` : null,
    chunk.day ? `Day: ${chunk.day}` : null,
    chunk.timestamp ? `Timestamp: ${chunk.timestamp}` : null,
    chunk.body ? `Body: ${truncateForEmbedding(chunk.body, 2400)}` : null,
  ].filter((p): p is string => Boolean(p));
  return parts.join('\n').trim();
}

function truncateForEmbedding(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars).trimEnd();
}

function normaliseBody(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
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
  private modelName: string;
  private readonly batchSize: number;
  private readonly unloadAfterIdleMs: number;
  private warnedUnavailable = false;
  private unloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly storage: IStorage,
    private model: IModelAdapter,
    logger: Logger,
    opts: EmbeddingWorkerOptions = {},
  ) {
    this.logger = logger.child('embedding-worker');
    this.enabled = opts.enabled ?? true;
    this.modelName = opts.modelName ?? model.getModelInfo().name;
    this.batchSize = opts.batchSize ?? 32;
    this.unloadAfterIdleMs = opts.unloadAfterIdleMs ?? 30_000;
    this.strategy = opts.strategy;
  }

  private strategy?: IIndexStrategy;

  setModel(model: IModelAdapter, modelName: string = model.getModelInfo().name): void {
    this.model = model;
    this.modelName = modelName;
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

    try {
      await this.refreshMemoryChunks().catch((err) => {
        this.logger.debug('memory chunk refresh failed (continuing)', { err: String(err) });
      });

      const frameResult = await this.embedFrameBatch();
      const chunkResult = await this.embedMemoryChunkBatch();
      return {
        processed: frameResult.processed + chunkResult.processed,
        failed: frameResult.failed + chunkResult.failed,
        remaining: frameResult.remaining + chunkResult.remaining,
      };
    } finally {
      this.scheduleUnload();
    }
  }

  private async embedFrameBatch(): Promise<EmbeddingWorkerResult> {
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
        ? await this.embedWithIsolation(uncachedContent)
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
      this.logger.warn('embedding write failed', { err: String(err) });
      return { processed: 0, failed: tasks.length, remaining: tasks.length };
    }
  }

  private async embedMemoryChunkBatch(): Promise<EmbeddingWorkerResult> {
    const tasks = await this.storage.listMemoryChunksNeedingEmbedding(
      this.modelName,
      this.batchSize,
    );
    if (tasks.length === 0) return { processed: 0, failed: 0, remaining: 0 };

    const tasksByHash = new Map<string, typeof tasks>();
    for (const task of tasks) {
      const bucket = tasksByHash.get(task.content_hash);
      if (bucket) bucket.push(task);
      else tasksByHash.set(task.content_hash, [task]);
    }

    const cached = new Map<string, number[]>();
    const hashes = Array.from(tasksByHash.keys());
    if (typeof this.storage.findExistingMemoryChunkEmbeddings === 'function') {
      try {
        const hits = await this.storage.findExistingMemoryChunkEmbeddings(
          this.modelName,
          hashes,
        );
        for (const [hash, hit] of hits) {
          if (hit.vector.length > 0) cached.set(hash, hit.vector);
        }
      } catch (err) {
        this.logger.debug('memory chunk cached embedding lookup failed (continuing)', {
          err: String(err),
        });
      }
    }

    const uncachedHashes: string[] = [];
    const uncachedContent: string[] = [];
    for (const [hash, bucket] of tasksByHash) {
      if (cached.has(hash)) continue;
      uncachedHashes.push(hash);
      uncachedContent.push(bucket[0]!.content);
    }

    try {
      const vectors = uncachedContent.length > 0
        ? await this.embedWithIsolation(uncachedContent)
        : [];
      const fresh = new Map<string, number[]>();
      for (let i = 0; i < uncachedHashes.length; i++) {
        const v = vectors[i];
        if (v && v.length > 0) fresh.set(uncachedHashes[i]!, v);
      }

      let processed = 0;
      let failed = 0;
      const embeddingsToWrite: Array<{
        chunkId: string;
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
            chunkId: task.id,
            model: this.modelName,
            contentHash: task.content_hash,
            vector,
          });
          processed += 1;
        }
      }
      await this.storage.upsertMemoryChunkEmbeddings(embeddingsToWrite);
      if (processed > 0) {
        this.logger.debug(`embedded ${processed} memory chunk(s), ${failed} failed`);
      }
      return {
        processed,
        failed,
        remaining: Math.max(0, tasks.length - processed),
      };
    } catch (err) {
      this.logger.warn('memory chunk embedding write failed', { err: String(err) });
      return { processed: 0, failed: tasks.length, remaining: tasks.length };
    }
  }

  private async refreshMemoryChunks(): Promise<void> {
    const chunks: MemoryChunk[] = [];
    const generatedKinds: MemoryChunkKind[] = [
      'index_page',
      'entity_summary',
      'meeting_summary',
      'day_event',
    ];
    const now = new Date().toISOString();

    for (const page of await this.listIndexPageChunks(now)) chunks.push(page);
    for (const chunk of await this.listEntityChunks(now)) chunks.push(chunk);
    for (const chunk of await this.listMeetingChunks(now)) chunks.push(chunk);
    for (const chunk of await this.listDayEventChunks(now)) chunks.push(chunk);

    await this.storage.replaceMemoryChunks(generatedKinds, chunks);
  }

  private async listIndexPageChunks(now: string): Promise<MemoryChunk[]> {
    if (!this.strategy) return [];
    let rootPath: string;
    try {
      rootPath = (await this.strategy.getState()).rootPath;
    } catch {
      return [];
    }
    const paths = await walkMarkdownPages(rootPath);
    const chunks: MemoryChunk[] = [];
    for (const rel of paths) {
      const page = await this.strategy.readPage(rel).catch(() => null);
      if (!page?.content) continue;
      const title = extractMarkdownTitle(page.content) ?? rel.replace(/\.md$/, '');
      const body = stripIndexMetadata(page.content);
      if (!body.trim()) continue;
      const sourceRefs = [
        `index:${rel}`,
        ...page.sourceEventIds.slice(0, 20).map((id) => `event:${id}`),
      ];
      chunks.push(makeMemoryChunk({
        kind: 'index_page',
        sourceId: rel,
        title,
        body: truncateForChunk(body, 6000),
        entityPath: rel.replace(/\.md$/, ''),
        entityKind: entityKindFromPagePath(rel),
        day: dayFromText(page.content),
        timestamp: page.lastUpdated,
        sourceRefs,
        now,
      }));
    }
    return chunks;
  }

  private async listEntityChunks(now: string): Promise<MemoryChunk[]> {
    const entities = await this.storage.listEntities({ limit: 1000 }).catch(() => [] as EntityRecord[]);
    return entities.map((entity) => {
      const body = [
        `${entity.title} is a ${entity.kind} observed from ${entity.firstSeen} to ${entity.lastSeen}.`,
        `It has ${entity.frameCount} captured frame(s) and about ${Math.round(entity.totalFocusedMs / 60_000)} focused minute(s).`,
        `Stable path: ${entity.path}.`,
      ].join('\n');
      return makeMemoryChunk({
        kind: 'entity_summary',
        sourceId: entity.path,
        title: entity.title,
        body,
        entityPath: entity.path,
        entityKind: entity.kind,
        day: entity.lastSeen.slice(0, 10),
        timestamp: entity.lastSeen,
        sourceRefs: [`entity:${entity.path}`],
        now,
      });
    });
  }

  private async listMeetingChunks(now: string): Promise<MemoryChunk[]> {
    const meetings = await this.storage.listMeetings({
      order: 'recent',
      limit: 1000,
    }).catch(() => [] as Meeting[]);
    return meetings
      .filter((meeting) => meeting.summary_status === 'ready' || meeting.summary_md)
      .map((meeting) => {
        const summary = meeting.summary_json;
        const body = [
          summary?.tldr ?? meeting.summary_md ?? deterministicMeetingBody(meeting),
          summary?.decisions?.length ? `Decisions: ${summary.decisions.map((d) => d.text).join(' | ')}` : null,
          summary?.action_items?.length ? `Actions: ${summary.action_items.map((a) => `${a.owner ? `${a.owner}: ` : ''}${a.task}`).join(' | ')}` : null,
          summary?.open_questions?.length ? `Open questions: ${summary.open_questions.map((q) => q.text).join(' | ')}` : null,
        ].filter((part): part is string => Boolean(part && part.trim())).join('\n');
        return makeMemoryChunk({
          kind: 'meeting_summary',
          sourceId: meeting.id,
          title: summary?.title ?? meeting.title ?? meeting.entity_path,
          body: truncateForChunk(body, 6000),
          entityPath: meeting.entity_path,
          entityKind: 'meeting',
          day: meeting.day,
          timestamp: meeting.started_at,
          sourceRefs: [`meeting:${meeting.id}`, `entity:${meeting.entity_path}`],
          now,
        });
      });
  }

  private async listDayEventChunks(now: string): Promise<MemoryChunk[]> {
    const events = await this.storage.listDayEvents({
      order: 'recent',
      limit: 1000,
    }).catch(() => [] as DayEvent[]);
    return events.map((event) => {
      const body = [
        `${event.title} (${event.kind}) at ${event.starts_at}${event.ends_at ? ` to ${event.ends_at}` : ''}.`,
        event.context_md,
        event.attendees.length ? `Attendees: ${event.attendees.join(', ')}` : null,
        event.links.length ? `Links: ${event.links.join(', ')}` : null,
      ].filter((part): part is string => Boolean(part && part.trim())).join('\n');
      return makeMemoryChunk({
        kind: 'day_event',
        sourceId: event.id,
        title: event.title,
        body: truncateForChunk(body, 4000),
        entityPath: null,
        entityKind: null,
        day: event.day,
        timestamp: event.starts_at,
        sourceRefs: [
          `day_event:${event.id}`,
          ...event.evidence_frame_ids.slice(0, 12).map((id) => `frame:${id}`),
          ...(event.meeting_id ? [`meeting:${event.meeting_id}`] : []),
        ],
        now,
      });
    });
  }

  private async embedWithIsolation(contents: string[]): Promise<number[][]> {
    try {
      return await this.model.embed!(contents);
    } catch (err) {
      this.logger.warn('embedding batch failed; retrying frames individually', {
        err: String(err),
      });
    }

    const vectors: number[][] = [];
    for (let i = 0; i < contents.length; i++) {
      try {
        const one = await this.model.embed!([contents[i]!]);
        vectors.push(one[0] ?? []);
      } catch (err) {
        vectors.push([]);
        this.logger.debug('single frame embedding failed', {
          index: i,
          chars: contents[i]?.length ?? 0,
          err: String(err),
        });
      }
    }
    return vectors;
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
