import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DayEvent, EntityKind, EntityRecord, IIndexStrategy, IModelAdapter, IStorage, Logger, Meeting, MemoryChunk, MemoryChunkKind } from '@cofounderos/interfaces';

export interface EmbeddingWorkerOptions { enabled?: boolean; modelName?: string; batchSize?: number; strategy?: IIndexStrategy; unloadAfterIdleMs?: number; }
export interface EmbeddingWorkerResult { processed: number; failed: number; remaining: number; }

interface MemoryChunkInput { kind: MemoryChunkKind; sourceId: string; title: string; body: string; entityPath: string | null; entityKind: EntityKind | null; day: string | null; timestamp: string | null; sourceRefs: string[]; now: string; }

const MAX_MEMORY_CHUNK_CHARS = 8000;

function makeMemoryChunk(i: MemoryChunkInput): MemoryChunk {
  const t = i.title.replace(/\s+/g, ' ').trim().slice(0, 240) || i.sourceId, b = i.body.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{4,}/g, '\n\n\n').trim();
  const id = `mem_${i.kind}_${createHash('sha256').update([i.kind, i.sourceId, i.entityPath ?? '', i.day ?? ''].join('\n')).digest('hex').slice(0, 20)}`;
  const hash = createHash('sha256').update([`Kind: ${i.kind}`, t ? `Title: ${t}` : null, i.entityPath ? `Entity: ${i.entityPath}` : null, i.day ? `Day: ${i.day}` : null, i.timestamp ? `Timestamp: ${i.timestamp}` : null, b ? `Body: ${b.replace(/\s+/g, ' ').trim().slice(0, 2400).trimEnd()}` : null].filter(Boolean).join('\n').trim()).digest('hex');
  return { id, kind: i.kind, sourceId: i.sourceId, title: t, body: b, entityPath: i.entityPath, entityKind: i.entityKind, day: i.day, timestamp: i.timestamp, sourceRefs: [...new Set(i.sourceRefs.filter(Boolean))], contentHash: hash, createdAt: i.timestamp ?? i.now, updatedAt: i.now };
}

async function walkMarkdownPages(rootPath: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (abs: string, rel = '') => {
    try {
      for (const e of await fs.readdir(abs, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name, f = path.join(abs, e.name);
        if (e.isDirectory()) await walk(f, r);
        else if (e.isFile() && e.name.endsWith('.md') && !['index.md', 'log.md'].includes(e.name)) out.push(r);
      }
    } catch {}
  };
  await walk(rootPath); return out.sort();
}

function entityKindFromPagePath(p: string): EntityKind | null {
  const k = p.split('/')[0]?.toLowerCase();
  return k === 'projects' ? 'project' : k === 'repos' ? 'repo' : k === 'meetings' ? 'meeting' : k === 'contacts' ? 'contact' : k === 'channels' ? 'channel' : k === 'docs' ? 'doc' : k === 'webpages' ? 'webpage' : k === 'apps' ? 'app' : null;
}

export class EmbeddingWorker {
  private readonly logger: Logger;
  private readonly enabled: boolean;
  private modelName: string;
  private readonly batchSize: number;
  private readonly unloadAfterIdleMs: number;
  private warnedUnavailable = false;
  private unloadTimer: ReturnType<typeof setTimeout> | null = null;
  private strategy?: IIndexStrategy;

  constructor(private readonly storage: IStorage, private model: IModelAdapter, logger: Logger, opts: EmbeddingWorkerOptions = {}) {
    this.logger = logger.child('embedding-worker');
    this.enabled = opts.enabled ?? true; this.modelName = opts.modelName ?? model.getModelInfo().name;
    this.batchSize = opts.batchSize ?? 32; this.unloadAfterIdleMs = opts.unloadAfterIdleMs ?? 30000; this.strategy = opts.strategy;
  }

  setModel(model: IModelAdapter, modelName = model.getModelInfo().name) { this.model = model; this.modelName = modelName; }
  getModelName() { return this.modelName; }

  private scheduleUnload() {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    if (this.unloadAfterIdleMs <= 0) return this.model.unload?.().catch(() => {});
    this.unloadTimer = setTimeout(() => { this.unloadTimer = null; this.model.unload?.().catch(() => {}); }, this.unloadAfterIdleMs);
  }

  async tick(): Promise<EmbeddingWorkerResult> {
    if (this.unloadTimer) { clearTimeout(this.unloadTimer); this.unloadTimer = null; }
    if (!this.enabled) return { processed: 0, failed: 0, remaining: 0 };
    if (typeof this.model.embed !== 'function') { if (!this.warnedUnavailable) { this.warnedUnavailable = true; this.logger.warn('semantic search disabled'); } return { processed: 0, failed: 0, remaining: 0 }; }
    try {
      await this.refreshMemoryChunks().catch(() => {});
      const fRes = await this.embedBatch(() => this.storage.listFramesNeedingEmbedding(this.modelName, this.batchSize), this.storage.findExistingFrameEmbeddings?.bind(this.storage), this.storage.findExistingFrameEmbedding?.bind(this.storage), async (b) => this.storage.upsertFrameEmbeddings ? this.storage.upsertFrameEmbeddings(b.map(i => ({ frameId: i.id, model: i.model, contentHash: i.contentHash, vector: i.vector }))) : Promise.all(b.map(i => this.storage.upsertFrameEmbedding(i.id, i.model, i.contentHash, i.vector))).then(() => {}));
      const cRes = await this.embedBatch(() => this.storage.listMemoryChunksNeedingEmbedding(this.modelName, this.batchSize), this.storage.findExistingMemoryChunkEmbeddings?.bind(this.storage), undefined, async (b) => this.storage.upsertMemoryChunkEmbeddings(b.map(i => ({ chunkId: i.id, model: i.model, contentHash: i.contentHash, vector: i.vector }))));
      return { processed: fRes.processed + cRes.processed, failed: fRes.failed + cRes.failed, remaining: fRes.remaining + cRes.remaining };
    } finally { this.scheduleUnload(); }
  }

  async drain(): Promise<EmbeddingWorkerResult> {
    const tot = { processed: 0, failed: 0, remaining: 0 };
    for (let i = 0; i < 10000; i++) { const r = await this.tick(); tot.processed += r.processed; tot.failed += r.failed; tot.remaining = r.remaining; if (r.processed < this.batchSize) break; }
    return tot;
  }

  private async embedBatch(listTasks: () => Promise<any[]>, findBatch?: (m: string, h: string[]) => Promise<Map<string, any>>, findSingle?: (m: string, h: string) => Promise<any>, upsert?: (batch: any[]) => Promise<void>): Promise<EmbeddingWorkerResult> {
    const tasks = await listTasks(); if (!tasks.length) return { processed: 0, failed: 0, remaining: 0 };
    const tasksByHash = new Map<string, any[]>(); tasks.forEach(t => tasksByHash.has(t.content_hash) ? tasksByHash.get(t.content_hash)!.push(t) : tasksByHash.set(t.content_hash, [t]));
    const cached = new Map<string, number[]>(), hashes = Array.from(tasksByHash.keys());

    if (findBatch) try { const hits = await findBatch(this.modelName, hashes); hits.forEach((hit, hash) => hit.vector.length && cached.set(hash, hit.vector)); } catch {}
    else if (findSingle) for (const h of hashes) try { const hit = await findSingle(this.modelName, h); if (hit?.vector.length) cached.set(h, hit.vector); } catch {}

    const unC = [...tasksByHash.entries()].filter(([h]) => !cached.has(h));
    const vecs = unC.length ? await this.embedWithIsolation(unC.map(([, b]) => b[0].content)) : [], fresh = new Map<string, number[]>();
    unC.forEach(([h], i) => vecs[i]?.length && fresh.set(h, vecs[i]));

    let p = 0, f = 0, writes: any[] = [];
    tasksByHash.forEach((b, h) => {
      const v = cached.get(h) ?? fresh.get(h);
      if (!v?.length) { f += b.length; return; }
      b.forEach(t => { writes.push({ id: t.id, model: this.modelName, contentHash: t.content_hash, vector: v }); p++; });
    });
    if (upsert && writes.length) await upsert(writes).catch(() => { p = 0; f = tasks.length; });
    return { processed: p, failed: f, remaining: Math.max(0, tasks.length - p) };
  }

  private async embedWithIsolation(contents: string[]): Promise<number[][]> {
    try { return await this.model.embed!(contents); } catch {
      const v: number[][] = [];
      for (const c of contents) { try { const o = await this.model.embed!([c]); v.push(o[0] ?? []); } catch { v.push([]); } }
      return v;
    }
  }

  private async refreshMemoryChunks() {
    const chunks: MemoryChunk[] = [], n = new Date().toISOString(), tr = (t: string, max: number = MAX_MEMORY_CHUNK_CHARS) => t.length <= max ? t : `${t.slice(0, max - 24).trimEnd()}\n[truncated]`;
    if (this.strategy) {
      try {
        const root = (await this.strategy.getState()).rootPath;
        for (const rel of await walkMarkdownPages(root)) {
          const pg = await this.strategy.readPage(rel).catch(() => null); if (!pg?.content) continue;
          const b = pg.content.replace(/^---\n[\s\S]*?\n---\n?/u, '').replace(/<!--\s*cofounderos:[\s\S]*?-->\n?/giu, '').replace(/^#\s+.+?\s*$/m, '').trim();
          if (b) chunks.push(makeMemoryChunk({ kind: 'index_page', sourceId: rel, title: pg.content.match(/^#\s+(.+?)\s*$/m)?.[1]?.replace(/\s+/g, ' ').trim() ?? rel.replace(/\.md$/, ''), body: tr(b, 6000), entityPath: rel.replace(/\.md$/, ''), entityKind: entityKindFromPagePath(rel), day: pg.content.match(/\b(?:day|date|last_seen|first_seen)\s*:\s*(\d{4}-\d{2}-\d{2})\b/i)?.[1] ?? pg.content.match(/\b(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/)?.[1] ?? null, timestamp: pg.lastUpdated, sourceRefs: [`index:${rel}`, ...pg.sourceEventIds.slice(0, 20).map(id => `event:${id}`)], now: n }));
        }
      } catch {}
    }
    const ents = await this.storage.listEntities({ limit: 1000 }).catch(() => [] as EntityRecord[]);
    ents.forEach(e => chunks.push(makeMemoryChunk({ kind: 'entity_summary', sourceId: e.path, title: e.title, body: `${e.title} is a ${e.kind} observed from ${e.firstSeen} to ${e.lastSeen}.\nIt has ${e.frameCount} captured frame(s) and about ${Math.round(e.totalFocusedMs / 60000)} focused minute(s).\nStable path: ${e.path}.`, entityPath: e.path, entityKind: e.kind, day: e.lastSeen.slice(0, 10), timestamp: e.lastSeen, sourceRefs: [`entity:${e.path}`], now: n })));
    const mtgs = await this.storage.listMeetings({ order: 'recent', limit: 1000 }).catch(() => [] as Meeting[]);
    mtgs.filter(m => m.summary_status === 'ready' || m.summary_md).forEach(m => chunks.push(makeMemoryChunk({ kind: 'meeting_summary', sourceId: m.id, title: m.summary_json?.title ?? m.title ?? m.entity_path, body: tr([m.summary_json?.tldr ?? m.summary_md ?? [m.title ?? m.entity_path, `Meeting from ${m.started_at} to ${m.ended_at}.`, `Platform: ${m.platform}.`, `Frames: ${m.frame_count}; audio chunks: ${m.audio_chunk_count}; transcript chars: ${m.transcript_chars}.`].filter(Boolean).join('\n'), m.summary_json?.decisions?.length ? `Decisions: ${m.summary_json.decisions.map((d: any) => d.text).join(' | ')}` : null, m.summary_json?.action_items?.length ? `Actions: ${m.summary_json.action_items.map((a: any) => `${a.owner ? `${a.owner}: ` : ''}${a.task}`).join(' | ')}` : null, m.summary_json?.open_questions?.length ? `Open questions: ${m.summary_json.open_questions.map((q: any) => q.text).join(' | ')}` : null].filter(Boolean).join('\n'), 6000), entityPath: m.entity_path, entityKind: 'meeting', day: m.day, timestamp: m.started_at, sourceRefs: [`meeting:${m.id}`, `entity:${m.entity_path}`], now: n })));
    const evs = await this.storage.listDayEvents({ order: 'recent', limit: 1000 }).catch(() => [] as DayEvent[]);
    evs.forEach(e => chunks.push(makeMemoryChunk({ kind: 'day_event', sourceId: e.id, title: e.title, body: tr([`${e.title} (${e.kind}) at ${e.starts_at}${e.ends_at ? ` to ${e.ends_at}` : ''}.`, e.context_md, e.attendees.length ? `Attendees: ${e.attendees.join(', ')}` : null, e.links.length ? `Links: ${e.links.join(', ')}` : null].filter(Boolean).join('\n'), 4000), entityPath: null, entityKind: null, day: e.day, timestamp: e.starts_at, sourceRefs: [`day_event:${e.id}`, ...e.evidence_frame_ids.slice(0, 12).map(id => `frame:${id}`), ...(e.meeting_id ? [`meeting:${e.meeting_id}`] : [])], now: n })));
    await this.storage.replaceMemoryChunks(['index_page', 'entity_summary', 'meeting_summary', 'day_event'], chunks);
  }
}
