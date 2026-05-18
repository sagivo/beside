import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DayEvent, EntityKind, EntityRecord, Frame, IIndexStrategy, IModelAdapter, IStorage, Logger, Meeting, MemoryChunk, MemoryChunkKind, MemoryJob, MemoryLeaf, MemoryLeafKind, MemoryNode, MemoryScope } from '@beside/interfaces';

export interface EmbeddingWorkerOptions { enabled?: boolean; modelName?: string; batchSize?: number; strategy?: IIndexStrategy; unloadAfterIdleMs?: number; }
export interface EmbeddingWorkerResult { processed: number; failed: number; remaining: number; }

interface MemoryChunkInput { kind: MemoryChunkKind; sourceId: string; title: string; body: string; entityPath: string | null; entityKind: EntityKind | null; day: string | null; timestamp: string | null; sourceRefs: string[]; now: string; }

const MAX_MEMORY_CHUNK_CHARS = 8000;
const MAX_OBSERVATION_FRAME_LEAVES_PER_REFRESH = 500;
const MAX_USER_NOTE_CHARS = 12000;
const OBSERVATION_STALE_DAYS = 45;
const MAX_NODE_SUMMARY_LEAVES = 12;
const GLOBAL_OBSERVATION_SUMMARY_LIMIT = 3;
const GLOBAL_ENTITY_SUMMARY_LIMIT = 2;
const GLOBAL_KIND_SUMMARY_LIMIT = 4;

function makeMemoryChunk(i: MemoryChunkInput): MemoryChunk {
  const t = i.title.replace(/\s+/g, ' ').trim().slice(0, 240) || i.sourceId, b = i.body.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{4,}/g, '\n\n\n').trim();
  const id = `mem_${i.kind}_${createHash('sha256').update([i.kind, i.sourceId, i.entityPath ?? '', i.day ?? ''].join('\n')).digest('hex').slice(0, 20)}`;
  const hash = createHash('sha256').update([`Kind: ${i.kind}`, t ? `Title: ${t}` : null, i.entityPath ? `Entity: ${i.entityPath}` : null, i.day ? `Day: ${i.day}` : null, i.timestamp ? `Timestamp: ${i.timestamp}` : null, b ? `Body: ${b.replace(/\s+/g, ' ').trim().slice(0, 2400).trimEnd()}` : null].filter(Boolean).join('\n').trim()).digest('hex');
  return { id, kind: i.kind, sourceId: i.sourceId, title: t, body: b, entityPath: i.entityPath, entityKind: i.entityKind, day: i.day, timestamp: i.timestamp, sourceRefs: [...new Set(i.sourceRefs.filter(Boolean))], contentHash: hash, createdAt: i.timestamp ?? i.now, updatedAt: i.now };
}

function hashText(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function chunkScope(chunk: MemoryChunk): { scope: MemoryScope; scopeId: string } {
  if (chunk.kind === 'day_event' && chunk.day) return { scope: 'day', scopeId: chunk.day };
  if (chunk.entityPath) return { scope: 'topic', scopeId: chunk.entityPath };
  if (chunk.day) return { scope: 'day', scopeId: chunk.day };
  if (chunk.kind === 'fact' || chunk.kind === 'procedure') return { scope: 'global', scopeId: 'manual' };
  return { scope: 'source', scopeId: chunk.sourceId };
}

function leafImportance(kind: MemoryChunkKind): number {
  if (kind === 'fact' || kind === 'procedure') return 0.9;
  if (kind === 'meeting_summary' || kind === 'day_event') return 0.75;
  if (kind === 'entity_summary') return 0.65;
  return 0.55;
}

function memoryLeafFromChunk(chunk: MemoryChunk): MemoryLeaf {
  const { scope, scopeId } = chunkScope(chunk);
  const ts = chunk.timestamp ?? chunk.updatedAt;
  return {
    id: `leaf_${hashText([chunk.kind, chunk.sourceId, chunk.entityPath ?? '', chunk.day ?? '', chunk.contentHash].join('\n')).slice(0, 24)}`,
    kind: chunk.kind,
    sourceId: chunk.sourceId,
    sourceKind: chunk.kind,
    scope,
    scopeId,
    title: chunk.title,
    body: chunk.body,
    entityPath: chunk.entityPath,
    entityKind: chunk.entityKind,
    day: chunk.day,
    timestamp: chunk.timestamp,
    timeStart: ts,
    timeEnd: ts,
    evidenceRefs: chunk.sourceRefs,
    contentHash: chunk.contentHash,
    status: 'admitted',
    confidence: chunk.kind === 'fact' || chunk.kind === 'procedure' ? 1 : 0.75,
    importance: leafImportance(chunk.kind),
    createdAt: chunk.createdAt,
    updatedAt: chunk.updatedAt,
  };
}

function memoryLeafFromFrame(frame: Frame, now: string): MemoryLeaf | null {
  const text = frame.text?.replace(/\s+/g, ' ').trim() ?? '';
  const visible = [
    frame.window_title ? `Window: ${frame.window_title}` : null,
    frame.url ? `URL: ${frame.url}` : null,
    text ? `Text: ${text.slice(0, 3000)}` : null,
  ].filter(Boolean).join('\n');
  const body = visible || [
    `App: ${frame.app}`,
    frame.window_title ? `Window: ${frame.window_title}` : null,
    frame.asset_path ? `Screenshot: ${frame.asset_path}` : null,
  ].filter(Boolean).join('\n');
  if (!body.trim()) return null;

  const startMs = Date.parse(frame.timestamp);
  const end = frame.duration_ms != null && Number.isFinite(frame.duration_ms) && Number.isFinite(startMs)
    ? new Date(startMs + frame.duration_ms).toISOString()
    : frame.timestamp;
  const scope = frame.entity_path
    ? { scope: 'topic' as const, scopeId: frame.entity_path }
    : { scope: 'day' as const, scopeId: frame.day };
  const titleParts = [
    frame.timestamp.slice(11, 19),
    frame.app,
    frame.window_title ? frame.window_title.slice(0, 120) : null,
  ].filter(Boolean);
  const contentHash = hashText([
    frame.id,
    frame.timestamp,
    frame.text_source ?? '',
    frame.window_title,
    frame.url ?? '',
    body,
  ].join('\n'));
  const confidence = frame.text_source === 'audio'
    ? 0.9
    : frame.text_source === 'ocr' || frame.text_source === 'ocr_accessibility'
      ? 0.72
      : frame.text_source === 'accessibility'
        ? 0.8
        : frame.asset_path
          ? 0.45
          : 0.35;
  return {
    id: `leaf_obs_${hashText(frame.id).slice(0, 24)}`,
    kind: 'observation',
    sourceId: frame.id,
    sourceKind: `frame:${frame.text_source ?? 'unknown'}`,
    scope: scope.scope,
    scopeId: scope.scopeId,
    title: titleParts.join(' - ') || frame.id,
    body,
    entityPath: frame.entity_path,
    entityKind: frame.entity_kind,
    day: frame.day,
    timestamp: frame.timestamp,
    timeStart: frame.timestamp,
    timeEnd: end,
    evidenceRefs: [`frame:${frame.id}`, ...frame.source_event_ids.slice(0, 8).map((id) => `event:${id}`)],
    contentHash,
    status: 'admitted',
    confidence,
    importance: frame.entity_path ? 0.5 : 0.35,
    createdAt: frame.timestamp,
    updatedAt: now,
  };
}

function isLowSignalStaleObservation(leaf: MemoryLeaf, cutoff: string): boolean {
  if (leaf.kind !== 'observation') return false;
  if ((leaf.importance ?? 0) >= 0.55) return false;
  const observedAt = leaf.timestamp ?? leaf.timeEnd ?? leaf.updatedAt;
  return Boolean(observedAt && observedAt < cutoff);
}

async function memoryLeavesFromUserNotes(rootPath: string, now: string): Promise<MemoryLeaf[]> {
  const roots = [...new Set([
    path.join(rootPath, 'notes'),
    path.join(path.dirname(rootPath), 'notes'),
  ])];
  const leaves: MemoryLeaf[] = [];
  for (const root of roots) {
    for (const rel of await walkMarkdownPages(root).catch(() => [])) {
      const abs = path.join(root, rel);
      let raw = '';
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        [raw, stat] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
      } catch {
        continue;
      }
      const parsed = parseUserNote(raw);
      if (!parsed.body.trim()) continue;
      const entityPath = parsed.frontmatter.entity_path ?? parsed.frontmatter.entity ?? null;
      const day = parsed.frontmatter.day ?? parsed.frontmatter.date ?? null;
      const ts = stat.mtime.toISOString();
      const scope = entityPath
        ? { scope: 'topic' as const, scopeId: entityPath }
        : day
          ? { scope: 'day' as const, scopeId: day }
          : { scope: 'global' as const, scopeId: 'notes' };
      const sourceId = rel.replace(/\\/g, '/');
      const body = parsed.body.slice(0, MAX_USER_NOTE_CHARS);
      const contentHash = hashText([sourceId, parsed.title, body, entityPath ?? '', day ?? ''].join('\n'));
      leaves.push({
        id: `leaf_note_${hashText(sourceId).slice(0, 24)}`,
        kind: 'note',
        sourceId,
        sourceKind: 'user_note',
        scope: scope.scope,
        scopeId: scope.scopeId,
        title: parsed.title,
        body,
        entityPath,
        entityKind: entityKindFromPagePath(entityPath ?? ''),
        day,
        timestamp: ts,
        timeStart: ts,
        timeEnd: ts,
        evidenceRefs: [`note:${sourceId}`],
        contentHash,
        status: 'admitted',
        confidence: 1,
        importance: 0.85,
        createdAt: stat.birthtime.toISOString(),
        updatedAt: now,
      });
    }
  }
  return leaves;
}

function parseUserNote(raw: string): { title: string; body: string; frontmatter: Record<string, string> } {
  const fm: Record<string, string> = {};
  let body = raw.replace(/\r\n/g, '\n');
  const match = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (match) {
    body = body.slice(match[0].length);
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && value) fm[key] = value;
    }
  }
  const title = body.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim()
    ?? fm.title
    ?? 'Memory note';
  body = body.replace(/^#\s+.+?\s*$/m, '').trim();
  return { title: title.slice(0, 240), body, frontmatter: fm };
}

function buildMemoryNodes(leaves: MemoryLeaf[], now: string): MemoryNode[] {
  const nodes = new Map<string, MemoryNode>();
  const admitted = leaves.filter((leaf) => leaf.status === 'admitted' && leaf.body.trim());
  const addGroup = (scope: MemoryScope, scopeId: string, group: MemoryLeaf[]) => {
    if (!group.length) return;
    const sorted = rankLeavesForNode(scope, group, now);
    const title = titleForNode(scope, scopeId, sorted);
    const summary = renderNodeSummary(sorted, scope);
    const childRefs = sorted.map((leaf) => leaf.id);
    const evidenceRefs = [...new Set(sorted.flatMap((leaf) => leaf.evidenceRefs))].slice(0, 200);
    const times = sorted.map((leaf) => leaf.timestamp ?? leaf.timeEnd ?? leaf.updatedAt).filter(Boolean).sort();
    const first = sorted.find((leaf) => leaf.entityPath);
    const contentHash = hashText([scope, scopeId, summary, childRefs.join('|')].join('\n'));
    const id = `node_${scope}_${hashText(`${scope}\n${scopeId}\n1`).slice(0, 24)}`;
    nodes.set(id, {
      id,
      scope,
      scopeId,
      level: 1,
      title,
      summary,
      entityPath: scope === 'topic' ? scopeId : first?.entityPath ?? null,
      entityKind: scope === 'topic' ? first?.entityKind ?? null : first?.entityKind ?? null,
      day: scope === 'day' ? scopeId : sorted.find((leaf) => leaf.day)?.day ?? null,
      timeStart: times[0] ?? null,
      timeEnd: times[times.length - 1] ?? null,
      childRefs,
      evidenceRefs,
      contentHash,
      status: 'open',
      createdAt: times[0] ?? now,
      updatedAt: now,
    });
  };

  groupLeaves(admitted, (leaf) => `source\0${leaf.sourceId}`).forEach((group) => addGroup('source', group[0]!.sourceId, group));
  groupLeaves(admitted.filter((leaf) => leaf.entityPath), (leaf) => `topic\0${leaf.entityPath}`).forEach((group) => addGroup('topic', group[0]!.entityPath!, group));
  groupLeaves(admitted.filter((leaf) => leaf.day), (leaf) => `day\0${leaf.day}`).forEach((group) => addGroup('day', group[0]!.day!, group));
  addGroup('global', 'all', admitted);
  return [...nodes.values()];
}

function preserveSealedNodes(next: MemoryNode[], previous: MemoryNode[]): MemoryNode[] {
  const sealedById = new Map(previous.filter((node) => node.status === 'sealed').map((node) => [node.id, node]));
  return next.map((node) => {
    const sealed = sealedById.get(node.id);
    if (!sealed || sealed.contentHash !== node.contentHash) return node;
    return {
      ...node,
      status: 'sealed',
      createdAt: sealed.createdAt,
    };
  });
}

function groupLeaves(leaves: MemoryLeaf[], keyFn: (leaf: MemoryLeaf) => string): MemoryLeaf[][] {
  const groups = new Map<string, MemoryLeaf[]>();
  for (const leaf of leaves) {
    const key = keyFn(leaf);
    const group = groups.get(key);
    if (group) group.push(leaf);
    else groups.set(key, [leaf]);
  }
  return [...groups.values()];
}

function titleForNode(scope: MemoryScope, scopeId: string, leaves: MemoryLeaf[]): string {
  if (scope === 'day') return `Memory for ${scopeId}`;
  if (scope === 'topic') return leaves.find((leaf) => leaf.kind === 'entity_summary' && leaf.entityPath === scopeId)?.title ?? leaves.find((leaf) => leaf.entityPath === scopeId)?.title ?? scopeId;
  if (scope === 'source') return leaves[0]?.title ?? scopeId;
  return 'Global memory';
}

function rankLeavesForNode(scope: MemoryScope, leaves: MemoryLeaf[], now: string): MemoryLeaf[] {
  const referenceTimeMs = Date.parse(now);
  return [...leaves].sort((a, b) => {
    const byScore = leafRankScore(b, scope, referenceTimeMs) - leafRankScore(a, scope, referenceTimeMs);
    if (Math.abs(byScore) > 0.0001) return byScore;
    return observedTimeMs(b) - observedTimeMs(a);
  });
}

function leafRankScore(leaf: MemoryLeaf, scope: MemoryScope, referenceTimeMs: number): number {
  const ageDays = Math.max(0, (referenceTimeMs - observedTimeMs(leaf)) / 86400_000);
  const recency = Math.max(0, 30 - Math.min(30, ageDays));
  const confidence = (leaf.confidence ?? 0.5) * 15;
  const importance = (leaf.importance ?? 0.5) * 25;
  let score = leafKindPriority(leaf.kind) + recency + confidence + importance;

  if (leaf.kind === 'meeting_summary' && /\b(decisions?|actions?|open questions?)\b/i.test(leaf.body)) score += 8;
  if (leaf.kind === 'observation') {
    score -= scope === 'global' ? 30 : 8;
    if (leaf.sourceKind?.startsWith('frame:ocr')) score -= 6;
  }
  if (leaf.kind === 'note') score += 8;
  return score;
}

function leafKindPriority(kind: MemoryLeafKind): number {
  switch (kind) {
    case 'fact':
    case 'procedure':
      return 120;
    case 'note':
      return 112;
    case 'meeting_summary':
      return 105;
    case 'day_event':
      return 92;
    case 'entity_summary':
      return 78;
    case 'index_page':
      return 74;
    case 'observation':
      return 38;
    default:
      return 50;
  }
}

function observedTimeMs(leaf: MemoryLeaf): number {
  const raw = leaf.timestamp ?? leaf.timeEnd ?? leaf.updatedAt ?? leaf.createdAt;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function renderNodeSummary(leaves: MemoryLeaf[], scope: MemoryScope): string {
  const lines: string[] = [];
  for (const leaf of selectNodeSummaryLeaves(leaves, scope)) {
    const ts = (leaf.timestamp ?? leaf.updatedAt).slice(0, 10);
    const body = renderLeafForNodeSummary(leaf, 420);
    if (!body) continue;
    lines.push(`- ${ts} - ${leaf.title}: ${body}`);
  }
  return lines.join('\n');
}

function selectNodeSummaryLeaves(leaves: MemoryLeaf[], scope: MemoryScope): MemoryLeaf[] {
  if (scope !== 'global') return leaves.slice(0, MAX_NODE_SUMMARY_LEAVES);

  const selected: MemoryLeaf[] = [];
  const byEntity = new Map<string, number>();
  const byKind = new Map<string, number>();
  const add = (leaf: MemoryLeaf, strict: boolean) => {
    if (selected.some((item) => item.id === leaf.id)) return;
    const kindCount = byKind.get(leaf.kind) ?? 0;
    if (leaf.kind === 'observation' && kindCount >= GLOBAL_OBSERVATION_SUMMARY_LIMIT) return;
    if (strict && kindCount >= kindSummaryCap(leaf.kind)) return;
    const entityKey = leaf.entityPath ?? (leaf.day ? `day:${leaf.day}` : `${leaf.scope}:${leaf.scopeId}`);
    const entityCount = byEntity.get(entityKey) ?? 0;
    if (strict && entityCount >= GLOBAL_ENTITY_SUMMARY_LIMIT) return;
    selected.push(leaf);
    byKind.set(leaf.kind, kindCount + 1);
    byEntity.set(entityKey, entityCount + 1);
  };

  for (const leaf of leaves) {
    if (selected.length >= MAX_NODE_SUMMARY_LEAVES) break;
    add(leaf, true);
  }
  for (const leaf of leaves) {
    if (selected.length >= MAX_NODE_SUMMARY_LEAVES) break;
    add(leaf, false);
  }
  return selected;
}

function kindSummaryCap(kind: MemoryLeafKind): number {
  if (kind === 'observation') return GLOBAL_OBSERVATION_SUMMARY_LIMIT;
  if (kind === 'fact' || kind === 'procedure' || kind === 'note') return 5;
  return GLOBAL_KIND_SUMMARY_LIMIT;
}

function renderLeafForNodeSummary(leaf: MemoryLeaf, maxChars: number): string {
  if (leaf.kind === 'observation') return renderObservationLeafSummary(leaf, maxChars);
  return trimToWord(cleanMemoryBody(leaf.body), maxChars);
}

function renderObservationLeafSummary(leaf: MemoryLeaf, maxChars: number): string {
  const fields = parseFieldLines(leaf.body);
  const parts = [
    fields.get('window') ? `Window: ${trimToWord(fields.get('window')!, 180)}` : null,
    fields.get('url') ? `URL: ${trimToWord(fields.get('url')!, 180)}` : null,
    leaf.entityPath ? `Entity: ${leaf.entityPath}` : null,
    leaf.evidenceRefs.find((ref) => ref.startsWith('frame:')) ? `Evidence: ${leaf.evidenceRefs.find((ref) => ref.startsWith('frame:'))}` : null,
  ].filter(Boolean) as string[];
  return trimToWord(parts.join('; ') || `Observed screen evidence ${leaf.sourceId}.`, maxChars);
}

function parseFieldLines(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9 _-]{0,32}):\s*(.+)$/);
    if (!match) continue;
    fields.set(match[1].trim().toLowerCase(), match[2].replace(/\s+/g, ' ').trim());
  }
  return fields;
}

function cleanMemoryBody(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^---\n[\s\S]*?\n---\n?/u, ' ')
    .replace(/^#+\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimToWord(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const clipped = value.slice(0, maxChars - 3).replace(/\s+\S*$/, '').trim();
  return `${clipped || value.slice(0, maxChars - 3).trim()}...`;
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
    const canEmbed = this.enabled && typeof this.model.embed === 'function';
    try {
      await this.refreshMemoryChunks().catch(() => {});
      await this.processMemoryJobs().catch((err) => this.logger.debug('memory lifecycle jobs failed', { err: String(err) }));
      if (!this.enabled) return { processed: 0, failed: 0, remaining: 0 };
      if (!canEmbed) {
        if (!this.warnedUnavailable) { this.warnedUnavailable = true; this.logger.warn('semantic search disabled'); }
        return { processed: 0, failed: 0, remaining: 0 };
      }
      const fRes = await this.embedBatch(() => this.storage.listFramesNeedingEmbedding(this.modelName, this.batchSize), this.storage.findExistingFrameEmbeddings?.bind(this.storage), this.storage.findExistingFrameEmbedding?.bind(this.storage), async (b) => this.storage.upsertFrameEmbeddings ? this.storage.upsertFrameEmbeddings(b.map(i => ({ frameId: i.id, model: i.model, contentHash: i.contentHash, vector: i.vector }))) : Promise.all(b.map(i => this.storage.upsertFrameEmbedding(i.id, i.model, i.contentHash, i.vector))).then(() => {}));
      const cRes = await this.embedBatch(() => this.storage.listMemoryChunksNeedingEmbedding(this.modelName, this.batchSize), this.storage.findExistingMemoryChunkEmbeddings?.bind(this.storage), undefined, async (b) => this.storage.upsertMemoryChunkEmbeddings(b.map(i => ({ chunkId: i.id, model: i.model, contentHash: i.contentHash, vector: i.vector }))));
      return { processed: fRes.processed + cRes.processed, failed: fRes.failed + cRes.failed, remaining: fRes.remaining + cRes.remaining };
    } finally { if (canEmbed) this.scheduleUnload(); }
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

  private async processMemoryJobs(): Promise<void> {
    if (!this.storage.claimMemoryJobs || !this.storage.completeMemoryJob || !this.storage.failMemoryJob) return;
    const jobs = await this.storage.claimMemoryJobs(4);
    for (const job of jobs) {
      try {
        if (job.kind === 'rebuild_tree') await this.handleRebuildTreeJob();
        else if (job.kind === 'seal_nodes') await this.handleSealNodesJob();
        else if (job.kind === 'flush_stale') await this.handleFlushStaleJob(job);
        await this.storage.completeMemoryJob(job.id);
      } catch (err) {
        await this.storage.failMemoryJob(job.id, String(err));
      }
    }
  }

  private async handleRebuildTreeJob(): Promise<void> {
    if (!this.storage.listMemoryLeaves || !this.storage.replaceMemoryNodes) return;
    const now = new Date().toISOString();
    const leaves = await this.storage.listMemoryLeaves({ status: 'admitted', limit: 10000 });
    const previous = this.storage.listMemoryNodes
      ? await this.storage.listMemoryNodes({ limit: 10000 }).catch(() => [] as MemoryNode[])
      : [];
    const nodes = preserveSealedNodes(buildMemoryNodes(leaves, now), previous);
    await this.storage.replaceMemoryNodes(['source', 'topic', 'day', 'global'], nodes);
  }

  private async handleSealNodesJob(): Promise<void> {
    if (!this.storage.listMemoryNodes || !this.storage.upsertMemoryNodes) return;
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const open = await this.storage.listMemoryNodes({ status: 'open', limit: 10000 });
    const sealable = open.filter((node) => (
      node.scope === 'day' ||
      node.childRefs.length >= 8 ||
      Boolean(node.timeEnd && node.timeEnd < cutoff)
    ));
    if (sealable.length === 0) return;
    await this.storage.upsertMemoryNodes(sealable.map((node) => ({
      ...node,
      status: 'sealed',
      updatedAt: now,
    })));
  }

  private async handleFlushStaleJob(job: MemoryJob): Promise<void> {
    if (!this.storage.listMemoryLeaves || !this.storage.upsertMemoryLeaves) return;
    const days = typeof job.payload.olderThanDays === 'number' ? job.payload.olderThanDays : OBSERVATION_STALE_DAYS;
    const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000).toISOString();
    const stale = await this.storage.listMemoryLeaves({
      kind: 'observation',
      status: 'admitted',
      to: cutoff,
      limit: 1000,
    });
    const lowSignal = stale.filter((leaf) => isLowSignalStaleObservation(leaf, cutoff));
    if (lowSignal.length === 0) return;
    const now = new Date().toISOString();
    await this.storage.upsertMemoryLeaves(lowSignal.map((leaf) => ({
      ...leaf,
      status: 'superseded',
      updatedAt: now,
    })));
    if (this.storage.enqueueMemoryJob) {
      await this.storage.enqueueMemoryJob('rebuild_tree', { reason: 'flush_stale' }, { dedupeKey: 'memory:rebuild_tree' });
    }
  }

  private async refreshMemoryChunks() {
    const chunks: MemoryChunk[] = [], n = new Date().toISOString(), tr = (t: string, max: number = MAX_MEMORY_CHUNK_CHARS) => t.length <= max ? t : `${t.slice(0, max - 24).trimEnd()}\n[truncated]`;
    let strategyRoot: string | null = null;
    if (this.strategy) {
      try {
        const root = (await this.strategy.getState()).rootPath;
        strategyRoot = root;
        for (const rel of await walkMarkdownPages(root)) {
          const pg = await this.strategy.readPage(rel).catch(() => null); if (!pg?.content) continue;
          const b = pg.content.replace(/^---\n[\s\S]*?\n---\n?/u, '').replace(/<!--\s*beside:[\s\S]*?-->\n?/giu, '').replace(/^#\s+.+?\s*$/m, '').trim();
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
    const staleObservationCutoff = new Date(Date.now() - OBSERVATION_STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const observationLeaves = this.storage.upsertMemoryLeaves
      ? (await this.storage.searchFrames({ limit: MAX_OBSERVATION_FRAME_LEAVES_PER_REFRESH }).catch(() => [] as Frame[]))
        .map((frame) => memoryLeafFromFrame(frame, n))
        .filter((leaf): leaf is MemoryLeaf => leaf != null)
        .map((leaf) => isLowSignalStaleObservation(leaf, staleObservationCutoff)
          ? { ...leaf, status: 'superseded' as const, updatedAt: n }
          : leaf)
      : [];
    const noteLeaves = strategyRoot
      ? await memoryLeavesFromUserNotes(strategyRoot, n).catch(() => [] as MemoryLeaf[])
      : [];
    await this.storage.replaceMemoryChunks(['index_page', 'entity_summary', 'meeting_summary', 'day_event'], chunks);
    if (this.storage.replaceMemoryLeaves && this.storage.replaceMemoryNodes) {
      const generatedKinds: MemoryLeafKind[] = ['index_page', 'entity_summary', 'meeting_summary', 'day_event'];
      const generatedLeaves = chunks.map(memoryLeafFromChunk);
      await this.storage.replaceMemoryLeaves(generatedKinds, generatedLeaves);
      await this.storage.replaceMemoryLeaves(['note'], noteLeaves);
      if (observationLeaves.length && this.storage.upsertMemoryLeaves) {
        await this.storage.upsertMemoryLeaves(observationLeaves);
      }
      const leaves = this.storage.listMemoryLeaves
        ? await this.storage.listMemoryLeaves({ status: 'admitted', limit: 10000 }).catch(() => [...generatedLeaves, ...noteLeaves, ...observationLeaves])
        : [...generatedLeaves, ...noteLeaves, ...observationLeaves];
      const previousNodes = this.storage.listMemoryNodes
        ? await this.storage.listMemoryNodes({ limit: 10000 }).catch(() => [] as MemoryNode[])
        : [];
      await this.storage.replaceMemoryNodes(['source', 'topic', 'day', 'global'], preserveSealedNodes(buildMemoryNodes(leaves, n), previousNodes));
      if (this.storage.enqueueMemoryJob) {
        await this.storage.enqueueMemoryJob('seal_nodes', { source: 'embedding_tick' }, { dedupeKey: 'memory:seal_nodes' });
        await this.storage.enqueueMemoryJob('flush_stale', { olderThanDays: OBSERVATION_STALE_DAYS }, { dedupeKey: 'memory:flush_stale' });
      }
    }
  }
}
