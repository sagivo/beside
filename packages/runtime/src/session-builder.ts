import type { IStorage, Frame, ActivitySession, EntityKind, Logger } from '@beside/interfaces';
import { newActivitySessionId, dayKey } from '@beside/core';
import { isSupportingAppEntity, CODE_APPS, TERMINAL_APPS } from './entity-resolver.js';

const LIFT_TARGET_KINDS: ReadonlySet<EntityKind> = new Set(['project', 'repo']);
const LIFT_TRIGGER_APPS: ReadonlySet<string> = new Set([...CODE_APPS, ...TERMINAL_APPS]);
const LIFT_MIN_TARGET_MS = 20_000;

export interface SessionBuilderOptions { idleThresholdMs?: number; fallbackFrameAttentionMs?: number; minActiveMs?: number; batchSize?: number; }
export interface SessionBuilderResult { framesProcessed: number; sessionsCreated: number; sessionsExtended: number; }

interface SessionAccumulator { id: string; startedAt: string; endedAt: string; day: string; frameIds: string[]; entityWeights: Map<string, { kind: EntityKind; ms: number }>; appWeights: Map<string, number>; activeMs: number; isExisting: boolean; }

export class SessionBuilder {
  private readonly logger: Logger;
  private readonly idleThresholdMs: number;
  private readonly fallbackFrameAttentionMs: number;
  private readonly minActiveMs: number;
  private readonly batchSize: number;

  constructor(private readonly storage: IStorage, logger: Logger, opts: SessionBuilderOptions = {}) {
    this.logger = logger.child('session-builder');
    this.idleThresholdMs = opts.idleThresholdMs ?? 300000;
    this.fallbackFrameAttentionMs = opts.fallbackFrameAttentionMs ?? 5000;
    this.minActiveMs = opts.minActiveMs ?? 30000;
    this.batchSize = opts.batchSize ?? 2000;
  }

  async tick(): Promise<SessionBuilderResult> {
    const pending = await this.storage.listFramesNeedingSessionAssignment(this.batchSize);
    if (!pending.length) return { framesProcessed: 0, sessionsCreated: 0, sessionsExtended: 0 };

    let acc: SessionAccumulator | null = null, created = 0, extended = 0;
    const cand = (await this.storage.listSessions({ day: pending[0]!.day, limit: 1, order: 'recent' }))[0];
    if (cand && Date.parse(pending[0]!.timestamp) - Date.parse(cand.ended_at) <= this.idleThresholdMs && cand.day === pending[0]!.day) {
      acc = await this.hydrateExistingSession(cand); extended++;
    }

    let pTs = acc ? Date.parse(acc.endedAt) : null;
    for (const f of pending) {
      const ts = Date.parse(f.timestamp), g = pTs == null ? null : ts - pTs, sd = acc ? acc.day === f.day : true;
      if (acc && ((g != null && g > this.idleThresholdMs) || !sd)) { await this.persist(acc); acc = null; }
      if (!acc) { acc = this.newAccumulator(f); created++; }

      const attn = f.duration_ms ?? (g != null && g <= this.idleThresholdMs ? Math.min(g, this.idleThresholdMs) : this.fallbackFrameAttentionMs);
      acc.frameIds.push(f.id); acc.endedAt = f.timestamp;
      if (g != null && g <= this.idleThresholdMs) acc.activeMs += g;
      if (f.entity_path && f.entity_kind) { const c = acc.entityWeights.get(f.entity_path); if (c) c.ms += attn; else acc.entityWeights.set(f.entity_path, { kind: f.entity_kind, ms: attn }); }
      if (f.app) acc.appWeights.set(f.app, (acc.appWeights.get(f.app) ?? 0) + attn);
      pTs = ts;
    }
    if (acc) await this.persist(acc);
    this.logger.debug(`processed ${pending.length}${pending.length === this.batchSize ? '+' : ''} frames into ${created} new + ${extended} extended sessions`);
    return { framesProcessed: pending.length, sessionsCreated: created, sessionsExtended: extended };
  }

  async drain(): Promise<SessionBuilderResult> {
    const tot = { framesProcessed: 0, sessionsCreated: 0, sessionsExtended: 0 };
    for (let i = 0; i < 10000; i++) { const r = await this.tick(); tot.framesProcessed += r.framesProcessed; tot.sessionsCreated += r.sessionsCreated; tot.sessionsExtended += r.sessionsExtended; if (r.framesProcessed < this.batchSize) break; }
    return tot;
  }

  private newAccumulator(f: Frame): SessionAccumulator { return { id: newActivitySessionId(new Date(f.timestamp)), startedAt: f.timestamp, endedAt: f.timestamp, day: f.day || dayKey(new Date(f.timestamp)), frameIds: [], entityWeights: new Map(), appWeights: new Map(), activeMs: 0, isExisting: false }; }

  private async hydrateExistingSession(s: ActivitySession): Promise<SessionAccumulator> {
    const acc: SessionAccumulator = { id: s.id, startedAt: s.started_at, endedAt: s.ended_at, day: s.day, frameIds: [], entityWeights: new Map(), appWeights: new Map(), activeMs: s.active_ms, isExisting: true };
    let pTs: number | null = null;
    for (const f of await this.storage.getSessionFrames(s.id)) {
      acc.frameIds.push(f.id);
      const ts = Date.parse(f.timestamp), g = pTs == null ? null : ts - pTs, attn = f.duration_ms ?? (g != null && g <= this.idleThresholdMs ? Math.min(g, this.idleThresholdMs) : this.fallbackFrameAttentionMs);
      if (f.entity_path && f.entity_kind) { const c = acc.entityWeights.get(f.entity_path); if (c) c.ms += attn; else acc.entityWeights.set(f.entity_path, { kind: f.entity_kind, ms: attn }); }
      if (f.app) acc.appWeights.set(f.app, (acc.appWeights.get(f.app) ?? 0) + attn);
      pTs = ts;
    }
    return acc;
  }

  private async persist(acc: SessionAccumulator) {
    if (!acc.frameIds.length) return;
    await this.maybeLiftSupportingAppFrames(acc);
    const eR = rankSessionEntities(acc.entityWeights), pE = eR[0], pA = [...acc.appWeights.entries()].sort((a, b) => b[1] - a[1])[0];
    const s: ActivitySession = { id: acc.id, started_at: acc.startedAt, ended_at: acc.endedAt, day: acc.day, duration_ms: Math.max(0, Date.parse(acc.endedAt) - Date.parse(acc.startedAt)), active_ms: acc.activeMs, frame_count: acc.frameIds.length, primary_entity_path: pE?.[0] ?? null, primary_entity_kind: pE?.[1].kind ?? null, primary_app: pA?.[0] ?? null, entities: eR.map(e => e[0]) };
    await this.storage.upsertSession(s); await this.storage.assignFramesToSession(acc.frameIds, acc.id);
  }

  private async maybeLiftSupportingAppFrames(acc: SessionAccumulator) {
    let pA = null, pAMs = -1; for (const [a, m] of acc.appWeights) if (m > pAMs) { pAMs = m; pA = a; }
    if (!pA || !LIFT_TRIGGER_APPS.has(pA)) return;

    let t: { path: string; kind: EntityKind; ms: number } | null = null; const os: { path: string; ms: number }[] = [];
    for (const [p, i] of acc.entityWeights) {
      if (LIFT_TARGET_KINDS.has(i.kind)) { if (!t || i.ms > t.ms) t = { path: p, kind: i.kind, ms: i.ms }; }
      else if (i.kind === 'app' && isSupportingAppEntity(p)) os.push({ path: p, ms: i.ms });
    }
    if (!t || !os.length || t.ms < LIFT_MIN_TARGET_MS) return;

    const fp = os.map(o => o.path), r = await this.storage.reattributeFrames({ frameIds: acc.frameIds, fromAppPaths: fp, target: { path: t.path, kind: t.kind, title: (await this.storage.getEntity(t.path))?.title ?? (t.path.split('/').pop()?.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || t.path) } });
    if (!r.moved) return;

    let lMs = 0; for (const o of os) { lMs += o.ms; acc.entityWeights.delete(o.path); }
    const c = acc.entityWeights.get(t.path); if (c) c.ms += lMs; else acc.entityWeights.set(t.path, { kind: t.kind, ms: lMs });
  }
}

function rankSessionEntities(w: Map<string, { kind: EntityKind; ms: number }>) {
  const e = [...w.entries()], h = e.some(i => i[1].kind !== 'app' && i[1].ms >= LIFT_MIN_TARGET_MS);
  return e.sort((a, b) => { const d = (h && b[1].kind === 'app' ? b[1].ms * 0.25 : b[1].ms) - (h && a[1].kind === 'app' ? a[1].ms * 0.25 : a[1].ms); return d !== 0 ? d : a[0].localeCompare(b[0]); });
}
