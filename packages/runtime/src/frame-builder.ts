import type { IStorage, RawEvent, Frame, Logger } from '@cofounderos/interfaces';
import { dayKey } from '@cofounderos/core';
import { redactPii } from './pii.js';

export interface FrameBuilderResult { framesCreated: number; eventsProcessed: number; eventsDropped: number; }
export interface FrameBuilderOptions { batchSize?: number; sensitiveKeywords?: string[]; }

export class FrameBuilder {
  private readonly logger: Logger;
  private readonly batchSize: number;
  private readonly sensitiveKeywords: string[];

  constructor(private readonly storage: IStorage, logger: Logger, opts: FrameBuilderOptions = {}) {
    this.logger = logger.child('frame-builder');
    this.batchSize = opts.batchSize ?? 500;
    this.sensitiveKeywords = opts.sensitiveKeywords ?? [];
  }

  async tick(): Promise<FrameBuilderResult> {
    const events = await this.storage.readEvents({ unframed_only: true, limit: this.batchSize });
    if (!events.length) return { framesCreated: 0, eventsProcessed: 0, eventsDropped: 0 };

    const cands = events.filter(e => new Set(['screenshot', 'window_focus', 'window_blur', 'url_change', 'audio_transcript']).has(e.type)).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const usedIds = new Set<string>(), frames: Frame[] = [];

    const ms = cands.map(e => Date.parse(e.timestamp));
    for (const s of cands.filter(e => e.type === 'screenshot')) {
      const sMs = Date.parse(s.timestamp), rel: RawEvent[] = [];
      for (let i = lowerBound(ms, sMs - 400); i < cands.length && ms[i]! <= sMs + 400; i++) {
        const e = cands[i]!; if (!usedIds.has(e.id) && e.id !== s.id && e.session_id === s.session_id && e.type !== 'screenshot') rel.push(e);
      }
      const f = buildFrame(s, rel, this.sensitiveKeywords);
      if (!(isUnknown(f))) { frames.push(f); usedIds.add(s.id); rel.forEach(r => usedIds.add(r.id)); }
    }

    let grp: RawEvent[] = [];
    const flush = () => {
      if (!grp.length) return;
      const f = buildTextOnlyFrame(grp), gap = Date.parse(grp[grp.length - 1]!.timestamp) - Date.parse(grp[0]!.timestamp);
      if (!(grp.length === 1 && gap === 0 && isUnknownEvent(grp[0]!)) && !(isUnknown(f)) && (gap >= 1500 || grp.length > 1 || f.url || f.text_source === 'audio')) frames.push(f);
      grp.forEach(e => usedIds.add(e.id)); grp = [];
    };

    for (const e of cands.filter(x => !usedIds.has(x.id) && ['window_focus', 'url_change', 'audio_transcript'].includes(x.type))) {
      const l = grp[grp.length - 1];
      if (l && l.app === e.app && l.window_title === e.window_title && l.url === e.url) grp.push(e);
      else { flush(); grp.push(e); }
    }
    flush();

    for (const b of cands.filter(e => e.type === 'window_blur')) {
      if (usedIds.has(b.id)) continue;
      const bMs = Date.parse(b.timestamp); let best: Frame | null = null, bDt = Infinity;
      for (const f of frames) {
        if (f.session_id !== b.session_id || f.app !== b.app) continue;
        const dt = bMs - Date.parse(f.timestamp);
        if (dt >= 0 && dt <= 60000 && dt < bDt) { best = f; bDt = dt; }
      }
      if (best && best.duration_ms == null && b.duration_ms != null) { best.duration_ms = b.duration_ms; best.source_event_ids.push(b.id); }
      usedIds.add(b.id);
    }

    for (const f of frames) await this.storage.upsertFrame(f);
    await this.storage.markFramed(events.map(e => e.id));

    const drp = cands.length - usedIds.size;
    if (frames.length > 0 || drp > 0) this.logger.debug(`built ${frames.length} frames (${drp} dropped, ${events.length - cands.length} bypassed)`);
    return { framesCreated: frames.length, eventsProcessed: events.length, eventsDropped: drp + (events.length - cands.length) };
  }

  async drain(): Promise<FrameBuilderResult> {
    const tot = { framesCreated: 0, eventsProcessed: 0, eventsDropped: 0 };
    for (let i = 0; i < 10000; i++) {
      const r = await this.tick(); tot.framesCreated += r.framesCreated; tot.eventsProcessed += r.eventsProcessed; tot.eventsDropped += r.eventsDropped;
      if (r.eventsProcessed < this.batchSize) break;
    }
    return tot;
  }
}

function buildFrame(anchor: RawEvent, rel: RawEvent[], sk: string[]): Frame {
  const m = anchor.metadata?.metadata && typeof anchor.metadata.metadata === 'object' ? { ...anchor.metadata, ...(anchor.metadata.metadata as object) } : anchor.metadata ?? {};
  const ax = typeof m.ax_text === 'string' && m.ax_text.length >= 8 ? redactPii(m.ax_text, sk) : null, vt = typeof m.vision_text === 'string' && m.vision_text.length >= 8 ? redactPii(m.vision_text, sk) : null;
  const t = vt && ax ? merge(vt, ax) : vt || ax, ts = vt && ax ? 'ocr_accessibility' : vt ? 'ocr' : ax ? 'accessibility' : null;
  const d = dayKey(new Date(anchor.timestamp));
  return { id: `frm_${anchor.id.slice(4)}`, timestamp: anchor.timestamp, day: d, monitor: anchor.screen_index ?? 0, app: anchor.app ?? '', app_bundle_id: anchor.app_bundle_id ?? '', window_title: anchor.window_title || rel.find(e => e.window_title)?.window_title || '', url: anchor.url ?? rel.find(e => e.url)?.url ?? null, text: t, text_source: ts, asset_path: anchor.asset_path ? anchor.asset_path.replace(/(^|\/)NaN-NaN-NaN(?=\/screenshots\/)/, `$1${d}`) : null, perceptual_hash: typeof m.perceptual_hash === 'string' ? m.perceptual_hash : null, trigger: typeof m.trigger === 'string' ? m.trigger : 'screenshot', session_id: anchor.session_id, duration_ms: null, entity_path: null, entity_kind: null, activity_session_id: null, meeting_id: null, source_event_ids: [anchor.id, ...rel.map(e => e.id)] };
}

function buildTextOnlyFrame(g: RawEvent[]): Frame {
  const h = g[0]!, at = g.filter(e => e.type === 'audio_transcript' && e.content).map(e => e.content).join('\n\n').trim(), ia = at.length > 0;
  return { id: `frm_${h.id.slice(4)}`, timestamp: h.timestamp, day: dayKey(new Date(h.timestamp)), monitor: h.screen_index ?? 0, app: h.app ?? '', app_bundle_id: h.app_bundle_id ?? '', window_title: g.find(e => e.window_title)?.window_title ?? '', url: g.find(e => e.url)?.url ?? null, text: ia ? at : null, text_source: ia ? 'audio' : 'none', asset_path: null, perceptual_hash: null, trigger: h.type === 'audio_transcript' ? 'audio' : h.type === 'url_change' ? 'url' : 'focus', session_id: h.session_id, duration_ms: ia ? (g.filter(e => e.type === 'audio_transcript').map(e => e.duration_ms).filter(n => typeof n === 'number' && n > 0).sort((a, b) => b! - a!)[0] || null) : null, entity_path: null, entity_kind: null, activity_session_id: null, meeting_id: null, source_event_ids: g.map(e => e.id) };
}

function merge(o: string, a: string) { const l: string[] = [], s = new Set<string>(); for (const b of [o, a]) for (const r of b.split(/\r?\n/)) { const c = r.replace(/\s+/g, ' ').trim(); if (c && !s.has(c.toLowerCase())) { s.add(c.toLowerCase()); l.push(c); } } return l.join('\n').trim(); }
function isUnknown(f: Frame) { return (!f.app || f.app === 'unknown') && (!f.window_title || f.window_title === 'unknown') && !f.url; }
function isUnknownEvent(e: RawEvent) { return (!e.app || e.app === 'unknown') && (!e.window_title || e.window_title === 'unknown') && !e.url; }
function lowerBound(a: number[], t: number) { let l = 0, h = a.length; while (l < h) { const m = (l + h) >>> 1; if (a[m]! < t) l = m + 1; else h = m; } return l; }
