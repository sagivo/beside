import { createHash } from 'node:crypto';
import type { IStorage, Frame, Logger, Meeting, MeetingPlatform, MeetingTurn, MeetingTurnSource } from '@beside/interfaces';

export interface MeetingBuilderOptions { meetingIdleMs?: number; minDurationMs?: number; audioGraceMs?: number; audioLeadMs?: number; batchSize?: number; }
export interface MeetingBuilderResult { framesProcessed: number; meetingsCreated: number; meetingsExtended: number; audioFramesAttached: number; turnsBuilt: number; }
interface MeetingAccumulator { id: string; entityPath: string; startedAt: string; endedAt: string; day: string; screenFrames: Frame[]; titleHint?: string | null; platformHint?: MeetingPlatform | null; isExisting: boolean; }
interface RecordingContextMeta { confidence: number; frame_id: string | null; platform: MeetingPlatform | null; title: string | null; meeting_url: string | null; entity_path: string | null; entity_kind: string | null; }
interface ScheduledMeetingWindow { startedAt: string; endedAt: string; title: string | null; sourceFrameId: string | null; }

const METADATA_PLATFORM_HINTS: Array<{ test: (f: Frame) => boolean; platform: MeetingPlatform }> = [
  { test: (f) => /\bzoom\b/i.test(f.app) || /zoom\.us/i.test(meetingMetadataHaystack(f)), platform: 'zoom' },
  { test: (f) => /google meet/i.test(f.app) || /meet\.google\.com/i.test(meetingMetadataHaystack(f)), platform: 'meet' },
  { test: (f) => /microsoft teams/i.test(f.app) || /teams\.microsoft\.com/i.test(meetingMetadataHaystack(f)), platform: 'teams' },
  { test: (f) => /webex/i.test(f.app) || /webex\.com/i.test(meetingMetadataHaystack(f)), platform: 'webex' },
  { test: (f) => /whereby/i.test(f.app) || /whereby\.com/i.test(meetingMetadataHaystack(f)), platform: 'whereby' },
  { test: (f) => /around/i.test(f.app) || /around\.co/i.test(meetingMetadataHaystack(f)), platform: 'around' },
];

const TEXT_PLATFORM_HINTS: Array<{ test: (f: Frame) => boolean; platform: MeetingPlatform }> = [
  { test: (f) => /(?:^|\n)[\s•*·-]*(?:google\s+)?meet\s*[-–—]/i.test(f.text ?? '') || /\bmeet\.google\.com\/(?!landing\b)[a-z]{3}-[a-z]{4}-[a-z]{3}\b/i.test(f.text ?? ''), platform: 'meet' },
  { test: (f) => /(?:^|\n)[\s•*·-]*zoom(?:\s+meeting)?\s*[-–—]/i.test(f.text ?? '') || /\bzoom\.us\/(?:j|my|wc)\//i.test(f.text ?? ''), platform: 'zoom' },
  { test: (f) => /(?:^|\n)[\s•*·-]*(?:microsoft\s+)?teams\s*[-–—]/i.test(f.text ?? '') || /\bteams\.microsoft\.com\/(?:l\/meetup-join|_\\#\/meetup)\b/i.test(f.text ?? ''), platform: 'teams' },
  { test: (f) => /\bwebex\.com\b/i.test(f.text ?? ''), platform: 'webex' },
  { test: (f) => /\bwhereby\.com\b/i.test(f.text ?? ''), platform: 'whereby' },
  { test: (f) => /\baround\.co\b/i.test(f.text ?? ''), platform: 'around' },
];

function inferPlatform(frames: Frame[]): MeetingPlatform {
  for (const hints of [METADATA_PLATFORM_HINTS, TEXT_PLATFORM_HINTS]) for (const f of frames) for (const hint of hints) if (hint.test(f)) return hint.platform;
  return 'other';
}

function meetingMetadataHaystack(f: Frame): string { return [f.app, f.window_title, f.url].filter(Boolean).join('\n'); }

const TITLE_STRIP_RE = [ /\s*[-|–—]\s*(zoom\s*meeting|zoom|google\s*meet|meet|microsoft\s*teams|teams|webex|whereby|around)\s*$/i, /^(zoom\s*meeting|zoom|google\s*meet|meet|microsoft\s*teams|teams|webex|whereby|around)\s*[-|–—]\s*/i, /\s*[-|–—]\s*(video\s*call|audio\s*call|screen\s*share)\s*$/i ];
const GENERIC_TITLE_RE = /^(zoom(\s+(meeting|workplace|us))?(\s+40\s+minutes)?|google\s*meet|meet|microsoft\s*teams|teams|webex|whereby|around|video\s*call|audio\s*call|meeting|untitled\s*meeting|you have ended the meeting|google chrome|chrome|profile)$/i;
const TITLE_NOISE_SEGMENT_RE = /^(camera and microphone recording|microphone recording|audio playing|screen share|presenting|high memory usage\b.*|\d+(?:\.\d+)?\s*(?:kb|mb|gb)|google chrome|chrome|you \(your chrome\)|profile)$/i;

function extractTopicFromTitle(raw: string): string | null {
  let s = raw.replace(/\s+/g, ' ').trim();
  for (const re of TITLE_STRIP_RE) s = s.replace(re, '').trim();
  const parts = s.split(/\s+[-–—]\s+/).map(p => p.trim()).filter(Boolean).filter(p => !TITLE_NOISE_SEGMENT_RE.test(p));
  s = parts.length > 0 ? parts.join(' - ') : '';
  return s.length >= 3 && !GENERIC_TITLE_RE.test(s) ? s : null;
}

function inferTitle(screens: Frame[]): string | null {
  const freq = new Map<string, number>();
  for (const f of screens) {
    [f.window_title, ...extractMeetingTitleHints(f.text)].forEach(rc => {
      const topic = extractTopicFromTitle((rc ?? '').replace(/\s+/g, ' ').trim());
      if (topic) freq.set(topic, (freq.get(topic) ?? 0) + 1);
    });
  }
  if (!freq.size) return null;
  let best = null, bestCount = 0;
  for (const [t, c] of freq) if (c > bestCount) { best = t; bestCount = c; }
  return best;
}

function extractMeetingTitleHints(text: string | null): string[] {
  if (!text) return [];
  return text.split(/\r?\n/).map(l => l.replace(/^[\s•*·-]+/, '').replace(/\s+/g, ' ').trim()).filter(l => /^(?:(?:Google\s+)?Meet|Zoom(?:\s+Meeting)?|(?:Microsoft\s+)?Teams|Webex|Whereby|Around)\s*[-–—]\s*.{3,80}$/i.test(l));
}

function meetingIdFor(entityPath: string, startedAt: string): string {
  const hash = createHash('sha1').update(entityPath).update('|').update(startedAt).digest('hex').slice(0, 12);
  return `mtg_${new Date(startedAt).getTime().toString(36)}_${hash}`;
}

export class MeetingBuilder {
  private readonly logger: Logger;
  private readonly meetingIdleMs: number;
  private readonly minDurationMs: number;
  private readonly audioGraceMs: number;
  private readonly audioLeadMs: number;
  private readonly batchSize: number;

  constructor(private readonly storage: IStorage, logger: Logger, opts: MeetingBuilderOptions = {}) {
    this.logger = logger.child('meeting-builder');
    this.meetingIdleMs = opts.meetingIdleMs ?? 300000;
    this.minDurationMs = opts.minDurationMs ?? 180000;
    this.audioGraceMs = opts.audioGraceMs ?? 60000;
    this.audioLeadMs = opts.audioLeadMs ?? 300000;
    this.batchSize = opts.batchSize ?? 1000;
  }

  async tick(): Promise<MeetingBuilderResult> {
    const empty: MeetingBuilderResult = { framesProcessed: 0, meetingsCreated: 0, meetingsExtended: 0, audioFramesAttached: 0, turnsBuilt: 0 };
    const pending = await this.storage.listFramesNeedingMeetingAssignment(this.batchSize);
    const open = new Map<string, MeetingAccumulator>();
    let created = 0, extended = 0;

    const flush = async (acc: MeetingAccumulator) => {
      const res = await this.persist(acc);
      empty.audioFramesAttached += res.audioFramesAttached; empty.turnsBuilt += res.turnsBuilt;
    };

    for (const frame of pending) {
      const ep = frame.entity_path; if (!ep) continue;
      const ts = Date.parse(frame.timestamp);
      let acc = open.get(ep);

      for (const [op, oa] of open) {
        if (op !== ep && ts - Date.parse(oa.endedAt) > this.meetingIdleMs) { await flush(oa); open.delete(op); }
      }

      if (acc && ts - Date.parse(acc.endedAt) > this.meetingIdleMs) { await flush(acc); open.delete(ep); acc = undefined; }

      if (!acc) {
        const ex = await this.findExtensibleMeeting(ep, frame.timestamp);
        if (ex) {
          acc = { id: ex.id, entityPath: ep, startedAt: ex.started_at, endedAt: ex.ended_at, day: ex.day, screenFrames: (await this.storage.getMeetingFrames(ex.id)).filter(f => f.entity_kind === 'meeting'), titleHint: ex.title, platformHint: ex.platform, isExisting: true };
          extended++;
        } else {
          acc = { id: meetingIdFor(ep, frame.timestamp), entityPath: ep, startedAt: frame.timestamp, endedAt: frame.timestamp, day: frame.day, screenFrames: [], titleHint: null, platformHint: null, isExisting: false };
          created++;
        }
        open.set(ep, acc);
      }
      acc.screenFrames.push(frame); acc.endedAt = frame.timestamp;
    }

    for (const acc of open.values()) await flush(acc);
    const ctxAud = await this.persistContextualAudioMeetings();

    return { framesProcessed: pending.length + ctxAud.audioFramesProcessed, meetingsCreated: created + ctxAud.meetingsCreated, meetingsExtended: extended + ctxAud.meetingsExtended, audioFramesAttached: empty.audioFramesAttached + ctxAud.audioFramesAttached, turnsBuilt: empty.turnsBuilt + ctxAud.turnsBuilt };
  }

  async drain(): Promise<MeetingBuilderResult> {
    const tot: MeetingBuilderResult = { framesProcessed: 0, meetingsCreated: 0, meetingsExtended: 0, audioFramesAttached: 0, turnsBuilt: 0 };
    for (let i = 0; i < 10000; i++) {
      const r = await this.tick();
      tot.framesProcessed += r.framesProcessed; tot.meetingsCreated += r.meetingsCreated; tot.meetingsExtended += r.meetingsExtended; tot.audioFramesAttached += r.audioFramesAttached; tot.turnsBuilt += r.turnsBuilt;
      if (r.framesProcessed < this.batchSize) break;
    }
    return tot;
  }

  private async findExtensibleMeeting(ep: string, nts: string): Promise<Meeting | null> {
    for (const m of await this.storage.listMeetings({ day: nts.slice(0, 10), limit: 200, order: 'recent' })) {
      if (m.entity_path === ep && Date.parse(m.ended_at) >= Date.parse(nts) - this.meetingIdleMs) return m;
    }
    return null;
  }

  private async persistContextualAudioMeetings() {
    const r = { audioFramesProcessed: 0, meetingsCreated: 0, meetingsExtended: 0, audioFramesAttached: 0, turnsBuilt: 0 };
    const auds = (await this.storage.searchFrames({ textSource: 'audio', limit: this.batchSize }).catch(() => [])).filter(f => !f.meeting_id).sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    for (const aud of auds) {
      const meta = await this.readAudioMetadata(aud);
      const ctx = parseRecordingContext(meta?.recording_context);
      if (!ctx || ctx.confidence < 45) continue;
      const ep = entityPathFromRecordingContext(ctx, aud.day); if (!ep) continue;

      const dur = audioDurationMs(aud, meta), aEnd = new Date(Date.parse(aud.timestamp) + Math.max(dur, 60000)).toISOString();
      const ex = await this.findExtensibleMeeting(ep, aud.timestamp);
      const ctxFs = await this.findContextFramesForAudio(aud, ctx, aEnd);

      const acc: MeetingAccumulator = ex ? { id: ex.id, entityPath: ep, startedAt: ex.started_at, endedAt: maxIso(ex.ended_at, aEnd), day: ex.day, screenFrames: dedupeFrames([...(await this.storage.getMeetingFrames(ex.id)).filter(f => f.text_source !== 'audio'), ...ctxFs]), titleHint: ex.title ?? ctx.title, platformHint: ex.platform !== 'other' ? ex.platform : ctx.platform, isExisting: true } : { id: meetingIdFor(ep, aud.timestamp), entityPath: ep, startedAt: aud.timestamp, endedAt: aEnd, day: aud.day, screenFrames: ctxFs, titleHint: ctx.title, platformHint: ctx.platform, isExisting: false };

      const p = await this.persist(acc);
      r.audioFramesProcessed++; r.audioFramesAttached += p.audioFramesAttached; r.turnsBuilt += p.turnsBuilt;
      ex ? r.meetingsExtended++ : r.meetingsCreated++;
    }
    return r;
  }

  private async findContextFramesForAudio(aud: Frame, ctx: RecordingContextMeta, aEnd: string): Promise<Frame[]> {
    const fs = await this.storage.searchFrames({ from: new Date(Date.parse(aud.timestamp) - 600000).toISOString(), to: new Date(Date.parse(aEnd) + 120000).toISOString(), limit: 80 }).catch(() => []);
    return dedupeFrames(fs.filter(f => f.text_source !== 'audio' && isContextFrameRelevant(f, ctx)).sort((a, b) => a.timestamp.localeCompare(b.timestamp))).slice(-16);
  }

  private async persist(acc: MeetingAccumulator): Promise<{ audioFramesAttached: number; turnsBuilt: number }> {
    const screens = acc.screenFrames.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const inferredTitle = acc.titleHint ?? inferTitle(screens);
    const sw = await this.findScheduledWindow(acc, screens, inferredTitle);
    const startedAt = sw?.startedAt ?? acc.startedAt, endedAt = sw ? maxIso(sw.endedAt, acc.endedAt) : acc.endedAt;
    const dur = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
    const platform = acc.platformHint ?? inferPlatform(screens);

    const sMs = Date.parse(startedAt), aEndMs = Date.parse(endedAt) + this.audioGraceMs;
    const candAuds = await this.storage.listAudioFramesInRange(new Date(sMs - this.audioLeadMs).toISOString(), new Date(aEndMs).toISOString());
    const aMetas = new Map<string, Record<string, unknown> | null>(), aFs: Frame[] = [];
    for (const aud of candAuds) {
      const am = await this.readAudioMetadata(aud); aMetas.set(aud.id, am);
      const aSMs = Date.parse(aud.timestamp); if (!Number.isFinite(aSMs)) continue;
      if (aSMs <= aEndMs && aSMs + Math.max(1000, audioDurationMs(aud, am)) >= sMs) aFs.push(aud);
    }

    if (!screens.length && !aFs.length) return { audioFramesAttached: 0, turnsBuilt: 0 };

    const turns: Array<Omit<MeetingTurn, 'id' | 'meeting_id'>> = [];
    let tChars = 0;
    for (const aud of aFs) {
      const am = aMetas.has(aud.id) ? aMetas.get(aud.id)! : await this.readAudioMetadata(aud);
      const aTurns = extractTurnsFromAudioFrame(aud, am);
      tChars += (aud.text ?? '').length;
      for (const t of aTurns) turns.push({ ...t, visual_frame_id: pickVisualFrameId(screens, t.t_start) });
    }
    turns.sort((a, b) => a.t_start.localeCompare(b.t_start));

    const atts = collectAttendees(turns), links = collectLinks(aFs, screens);
    const mIds = [...screens.map(f => f.id), ...aFs.map(f => f.id)], sCount = screens.filter(f => f.asset_path).length;
    const chash = createHash('sha1').update(turns.map(t => `${t.t_start}|${t.text}`).join('||')).update('||').update(screens.map(f => `${f.timestamp}|${f.asset_path ?? ''}`).join('||')).digest('hex').slice(0, 16);

    const mtg: Meeting = { id: acc.id, entity_path: acc.entityPath, title: inferredTitle ?? sw?.title ?? null, platform, started_at: startedAt, ended_at: endedAt, day: acc.day, duration_ms: dur, frame_count: mIds.length, screenshot_count: sCount, audio_chunk_count: aFs.length, transcript_chars: tChars, content_hash: chash, summary_status: dur < this.minDurationMs && !aFs.length ? 'skipped_short' : 'pending', summary_md: null, summary_json: null, attendees: atts, links, failure_reason: null, updated_at: new Date().toISOString() };

    await this.storage.upsertMeeting(mtg);
    await this.storage.assignFramesToMeeting(mIds, mtg.id);
    if (turns.length > 0) await this.storage.setMeetingTurns(mtg.id, turns);

    if (!acc.isExisting) this.logger.info(`meeting ${mtg.id} (${mtg.entity_path}, ${platform}, ${Math.round(dur / 60000)} min, ${screens.length} screens, ${aFs.length} audio)`);
    return { audioFramesAttached: aFs.length, turnsBuilt: turns.length };
  }

  private async readAudioMetadata(frame: Frame): Promise<Record<string, unknown> | null> {
    if (!frame.source_event_ids?.length) return null;
    try {
      const evs = await this.storage.readEvents({ ids: frame.source_event_ids, types: ['audio_transcript'], limit: frame.source_event_ids.length });
      let m: Record<string, unknown> | null = null;
      for (const ev of evs) if (ev.metadata && typeof ev.metadata === 'object') m = { ...(m ?? {}), ...(ev.metadata.metadata && typeof ev.metadata.metadata === 'object' ? ev.metadata.metadata : {}), ...Object.fromEntries(Object.entries(ev.metadata).filter(([k]) => k !== 'metadata')) };
      return m;
    } catch { return null; }
  }

  private async findScheduledWindow(acc: MeetingAccumulator, screens: Frame[], title: string | null): Promise<ScheduledMeetingWindow | null> {
    const sMs = Date.parse(acc.startedAt), eMs = Date.parse(acc.endedAt);
    if (!Number.isFinite(sMs) || !Number.isFinite(eMs)) return null;

    const fs = await this.storage.searchFrames({ from: new Date(sMs - 7200000).toISOString(), to: new Date(Math.max(sMs, eMs) + 7200000).toISOString(), limit: 300 }).catch(() => []);
    const cands = dedupeFrames([...screens, ...fs]).filter(f => f.text_source !== 'audio' && (f.text || f.window_title || f.url));

    let best: { window: ScheduledMeetingWindow; score: number } | null = null;
    for (const f of cands) for (const w of extractScheduledWindowsFromFrame(f)) {
      const s = scoreScheduledWindow(w, acc, title);
      if (s > 0 && (!best || s > best.score)) best = { window: w, score: s };
    }
    return best?.window ?? null;
  }
}

function parseRecordingContext(raw: unknown): RecordingContextMeta | null {
  if (!raw || typeof raw !== 'object') return null; const obj = raw as any;
  return { confidence: typeof obj.confidence === 'number' ? obj.confidence : 0, frame_id: typeof obj.frame_id === 'string' ? obj.frame_id : null, platform: ['zoom', 'meet', 'teams', 'webex', 'whereby', 'around', 'other'].includes(obj.platform) ? obj.platform : null, title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : null, meeting_url: typeof obj.meeting_url === 'string' && obj.meeting_url.trim() ? obj.meeting_url.trim() : null, entity_path: typeof obj.entity_path === 'string' && obj.entity_path.trim() ? obj.entity_path.trim() : null, entity_kind: typeof obj.entity_kind === 'string' && obj.entity_kind.trim() ? obj.entity_kind.trim() : null };
}

function entityPathFromRecordingContext(ctx: RecordingContextMeta, day: string): string | null {
  if (ctx.entity_kind === 'meeting' && ctx.entity_path) return ctx.entity_path;
  const t = ctx.title ?? (ctx.meeting_url ? (/(meet\.google\.com)/i.test(ctx.meeting_url) ? 'Google Meet' : /(zoom\.us)/i.test(ctx.meeting_url) ? 'Zoom' : /(teams\.microsoft\.com)/i.test(ctx.meeting_url) ? 'Microsoft Teams' : null) : null) ?? ctx.platform ?? 'meeting';
  const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return slug ? `meetings/${day}-${slug}` : null;
}

function audioDurationMs(aud: Frame, meta: Record<string, unknown> | null): number {
  if (typeof aud.duration_ms === 'number' && aud.duration_ms > 0) return aud.duration_ms;
  if (typeof meta?.duration_ms === 'number' && meta.duration_ms > 0) return meta.duration_ms;
  return Math.max(60000, Math.round((aud.text ?? '').length * 80));
}

function maxIso(a: string, b: string): string { return Date.parse(a) >= Date.parse(b) ? a : b; }
function dedupeFrames(frames: Frame[]): Frame[] { const s = new Set(); return frames.filter(f => { if (s.has(f.id)) return false; s.add(f.id); return true; }); }

function isContextFrameRelevant(f: Frame, ctx: RecordingContextMeta): boolean {
  if (ctx.frame_id === f.id || f.entity_kind === 'meeting' || (ctx.entity_path && f.entity_path === ctx.entity_path)) return true;
  const h = [f.app, f.window_title, f.url, f.text].filter(Boolean).join('\n').toLowerCase();
  if (ctx.meeting_url && h.includes(ctx.meeting_url.replace(/^https?:\/\//i, '').toLowerCase())) return true;
  if (ctx.title && h.includes(ctx.title.toLowerCase())) return true;
  if (ctx.platform === 'meet' && /meet\.google\.com|google meet/i.test(h)) return true;
  if (ctx.platform === 'zoom' && /zoom(?:\.us|\s+meeting)?/i.test(h)) return true;
  if (ctx.platform === 'teams' && /teams\.microsoft\.com|microsoft teams/i.test(h)) return true;
  return false;
}

function extractScheduledWindowsFromFrame(f: Frame): ScheduledMeetingWindow[] {
  const t = f.text; if (!t || !/\bStarts on\b/i.test(t) || !/\bends\b/i.test(t)) return [];
  const out: ScheduledMeetingWindow[] = [], s = new Set<string>();
  const pm = (g: any) => {
    const t = (g.title || '').replace(/^[\s•*·\-:|,;.]+/, '').replace(/\s+/g, ' ').trim();
    if (!t || t.length < 3 || t.length > 120) return;
    const sd = parseLocalDateTime(g.startDate, g.startTime), ed = parseLocalDateTime(g.endDate ?? g.startDate, g.endTime);
    if (!sd || !ed) return;
    const ne = Date.parse(ed) <= Date.parse(sd) ? new Date(Date.parse(ed) + 86400000).toISOString() : ed;
    const k = `${t.toLowerCase()}|${sd}|${ne}`; if (!s.has(k)) { s.add(k); out.push({ title: t, startedAt: sd, endedAt: ne, sourceFrameId: f.id }); }
  };
  t.split(/\r?\n/).forEach(l => l.replace(/\s+/g, ' ').trim().match(/^\s*(?<title>.+?)\.\s*Starts on (?<startDate>[A-Za-z]+ \d{1,2}, \d{4}) at (?<startTime>\d{1,2}(?::\d{2})?\s*(?:AM|PM)) and ends (?:on (?<endDate>[A-Za-z]+ \d{1,2}, \d{4}) at |at )(?<endTime>\d{1,2}(?::\d{2})?\s*(?:AM|PM))/i)?.groups && pm(l.match(/^\s*(?<title>.+?)\.\s*Starts on (?<startDate>[A-Za-z]+ \d{1,2}, \d{4}) at (?<startTime>\d{1,2}(?::\d{2})?\s*(?:AM|PM)) and ends (?:on (?<endDate>[A-Za-z]+ \d{1,2}, \d{4}) at |at )(?<endTime>\d{1,2}(?::\d{2})?\s*(?:AM|PM))/i)!.groups));
  for (const m of t.replace(/\s+/g, ' ').trim().matchAll(/(?<title>[A-Za-z0-9][^.\n]{2,120}?)\.\s*Starts on (?<startDate>[A-Za-z]+ \d{1,2}, \d{4}) at (?<startTime>\d{1,2}(?::\d{2})?\s*(?:AM|PM)) and ends (?:on (?<endDate>[A-Za-z]+ \d{1,2}, \d{4}) at |at )(?<endTime>\d{1,2}(?::\d{2})?\s*(?:AM|PM))/gi)) if (m.groups) pm(m.groups);
  return out;
}

function scoreScheduledWindow(w: ScheduledMeetingWindow, acc: MeetingAccumulator, t: string | null): number {
  const sm = Date.parse(w.startedAt), em = Date.parse(w.endedAt), om = Date.parse(acc.startedAt), oem = Date.parse(acc.endedAt);
  if (!Number.isFinite(sm) || !Number.isFinite(em) || !Number.isFinite(om) || !Number.isFinite(oem) || em <= sm) return 0;
  const nr = (v: string | null | undefined) => (v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const st = nr(w.title), cands = [nr(t), nr(acc.entityPath.replace(/^meetings\/\d{4}-\d{2}-\d{2}-/, '').replace(/-/g, ' '))].filter(Boolean);
  if (!st || !cands.some(c => st === c || (st.length >= 8 && c.length >= 8 && (st.includes(c) || c.includes(st))))) return 0;
  const oo = sm <= oem + 900000 && em >= om - 900000;
  if (!oo && Math.abs(sm - om) > 2700000) return 0;
  return 70 + (oo ? 40 : 0) + ((sm <= om && em >= oem) ? 20 : 0) + (w.sourceFrameId ? 5 : 0);
}

function parseLocalDateTime(dl: string, tl: string): string | null {
  const d = dl.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/), t = tl.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!d || !t) return null;
  const mo = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 }[d[1]!.toLowerCase()];
  if (mo === undefined) return null;
  let h = Number(t[1]), m = Number(t[2] ?? '0');
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 1 || h > 12 || m < 0 || m > 59) return null;
  if (t[3]!.toLowerCase() === 'pm' && h < 12) h += 12; if (t[3]!.toLowerCase() === 'am' && h === 12) h = 0;
  const p = new Date(Number(d[3]), mo, Number(d[2]), h, m, 0, 0);
  return Number.isNaN(p.getTime()) ? null : p.toISOString();
}

function extractTurnsFromAudioFrame(f: Frame, m: Record<string, unknown> | null): Array<Omit<MeetingTurn, 'id' | 'meeting_id' | 'visual_frame_id'>> {
  const ex = Array.isArray(m?.turns) ? (m!.turns as any[]) : null, txt = (f.text ?? '').trim(), sMs = Date.parse(f.timestamp), dur = typeof m?.duration_ms === 'number' && m.duration_ms > 0 ? m.duration_ms : Math.max(2000, Math.round(txt.length * 80));
  if (ex?.length) {
    const o = ex.map(t => {
      const text = typeof t.text === 'string' ? t.text.trim() : ''; if (!text) return null;
      const rts = (iso: any, oMs: any, oSec: any) => (typeof iso === 'string' && iso.length >= 19 && !Number.isNaN(Date.parse(iso))) ? new Date(Date.parse(iso)).toISOString() : (typeof oMs === 'number' && Number.isFinite(oMs)) ? new Date(sMs + oMs).toISOString() : (typeof oSec === 'number' && Number.isFinite(oSec)) ? new Date(sMs + oSec * 1000).toISOString() : null;
      const t_start = rts(t.t_start ?? t.start_iso, t.offset_ms ?? t.start_ms, t.start); if (!t_start) return null;
      return { t_start, t_end: rts(t.t_end ?? t.end_iso, t.end_ms, t.end) ?? new Date(Date.parse(t_start) + Math.max(2000, Math.min(dur, text.length * 80))).toISOString(), speaker: typeof t.speaker === 'string' && t.speaker.trim() ? t.speaker.trim() : null, text, source: ['vtt', 'srt', 'whisper', 'import'].includes(t.source) ? t.source : 'whisper' };
    }).filter(Boolean) as any[];
    if (o.length) return o;
  }
  if (!txt) return [];
  const ps = txt.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const sens = ps.length >= 4 ? ps : txt.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z(])/).map(s => s.trim()).filter(Boolean);
  const mrg: string[] = []; let cur = '';
  if (sens.length >= 12) { for (const s of sens) { if ((cur + ' ' + s).length > 360) { if (cur) mrg.push(cur); cur = s; } else cur = cur ? `${cur} ${s}` : s; } if (cur) mrg.push(cur); }
  const fnls = mrg.length ? mrg : sens.length ? sens : [txt];
  const sl = dur / Math.max(1, fnls.length);
  return fnls.map((text, i) => ({ t_start: new Date(sMs + Math.round(i * sl)).toISOString(), t_end: new Date(sMs + Math.round((i + 1) * sl)).toISOString(), speaker: null, text, source: ['whisper', 'import', 'vtt', 'srt'].includes(m?.source as any) ? m!.source as any : 'whisper' }));
}

function pickVisualFrameId(s: Frame[], t: string): string | null { if (!s.length) return null; const tMs = Date.parse(t); let c = s[0]!.id; for (const f of s) { if (Date.parse(f.timestamp) <= tMs) c = f.id; else break; } return c; }
function collectAttendees(t: any[]): string[] { const s = new Set<string>(); for (const r of t) if (r.speaker && !s.has(r.speaker)) s.add(r.speaker); return [...s]; }
function collectLinks(a: Frame[], s: Frame[]): string[] { const u = new Set<string>(), p = (url: string | null) => { if (url) u.add(url.replace(/[).,;]+$/g, '')); }; s.forEach(f => p(f.url)); [...a, ...s].forEach(f => (f.text ?? '').match(/https?:\/\/[^\s<>"')]+/g)?.forEach(p)); return [...u].slice(0, 50); }
