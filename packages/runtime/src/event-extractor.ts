import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type {
  IStorage,
  IModelAdapter,
  Logger,
  DayEvent,
  DayEventKind,
  DayEventSource,
  Frame,
  Meeting,
} from '@beside/interfaces';

export interface EventExtractorOptions {
  dataDir?: string;
  lookbackDays?: number;
  minTextChars?: number;
  maxFramesPerBucket?: number;
  llmEnabled?: boolean;
  maxPromptChars?: number;
  maxEventsPerResponse?: number;
  contextWindowMs?: number;
  maxContextEventsPerTick?: number;
  visionAttachments?: number;
}

export interface EventExtractorResult {
  meetingsLifted: number;
  llmExtracted: number;
  contextEnriched: number;
  daysScanned: number;
  bucketsScanned: number;
  framesScanned: number;
  modelAvailable: boolean;
  failed: number;
}

export interface EventExtractorTickOptions {
  lookbackDays?: number;
  sources?: DayEventSource[];
  enrichContexts?: boolean;
}

const EXTRACTION_SYSTEM_PROMPT = `You are looking at the user's recent screen capture for a single source app. Recover meaningful EVENTS shown on screen and emit them as JSON.
Return STRICT JSON matching:
{
  "events": [
    {
      "title": string,
      "kind": "calendar" | "communication" | "task" | "other",
      "starts_at": string,
      "ends_at": string | null,
      "attendees": string[],
      "context": string
    }
  ]
}
General rules:
- Only output meaningful events.
- "starts_at" should be a real ISO timestamp.
- "context" must be 1-2 specific sentences.
- AT MOST 25 events.
If CALENDAR APP:
- The dates displayed are on screen. Treat all-day items as starting at midnight.
If EMAIL, CHAT, or TASK: surface notable threads / tickets.`;

const CONTEXT_SYSTEM_PROMPT = `You are filling in a missing context line for an event. Write a SINGLE 1-3 sentence description based on screenshots. Return PLAIN TEXT.`;

const LATEST_CALENDAR_CAPTURE_WINDOW_MS = 1000;

interface SourceBucket {
  source: DayEventSource;
  app: string;
  frames: Frame[];
}

type SourceMatcher = {
  source: DayEventSource;
  label: string;
  match: (frame: Frame) => boolean;
};

const CALENDAR_APP_NAMES = new Set(['calendar', 'fantastical', 'notion calendar', 'cron', 'amie', 'busycal', 'mimestream', 'outlook']);
const CALENDAR_BUNDLE_PREFIXES = ['com.apple.ical', 'com.flexibits.fantastical', 'notion.id.notion-calendar', 'com.cron', 'com.busymac.busycal', 'co.amie'];

function isNativeCalendarAppFrame(frame: Frame): boolean {
  const app = (frame.app ?? '').toLowerCase();
  const bundle = (frame.app_bundle_id ?? '').toLowerCase();
  return CALENDAR_APP_NAMES.has(app) || CALENDAR_BUNDLE_PREFIXES.some((p) => bundle.startsWith(p));
}

const CALENDAR_HOSTS = new Set([
  'calendar.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com',
  'outlook.com', 'icloud.com', 'www.icloud.com', 'calendar.proton.me', 'calendar.yahoo.com',
  'calendar.zoho.com', 'app.fastmail.com', 'fastmail.com', 'app.tuta.com', 'vimcal.com',
  'app.vimcal.com', 'cal.com', 'app.cal.com', 'cron.com', 'amie.so', 'web.morgen.so',
  'app.akiflow.com', 'app.reclaim.ai', 'app.usemotion.com', 'app.sunsama.com', 'calendly.com',
  'notion.so', 'www.notion.so', 'linear.app', 'asana.com', 'app.asana.com', 'app.clickup.com',
  'monday.com', 'github.com'
]);

const CALENDAR_HOST_PATH_REQUIREMENT: Record<string, RegExp> = {
  'icloud.com': /\/calendar\b/i,
  'www.icloud.com': /\/calendar\b/i,
  'app.fastmail.com': /\/calendar\b/i,
  'fastmail.com': /\/calendar\b/i,
  'outlook.live.com': /\/calendar\b|\/owa\b.*calendar/i,
  'outlook.office.com': /\/calendar\b|\/owa\b.*calendar/i,
  'outlook.office365.com': /\/calendar\b|\/owa\b.*calendar/i,
  'outlook.com': /\/calendar\b/i,
  'notion.so': /\/calendar\b|view=calendar|\?v=.*calendar/i,
  'www.notion.so': /\/calendar\b|view=calendar|\?v=.*calendar/i,
  'linear.app': /\/views?\/calendar\b|\?layout=calendar/i,
  'asana.com': /\/calendar\b|\?view=calendar/i,
  'app.asana.com': /\/calendar\b|\?view=calendar/i,
  'app.clickup.com': /\/calendar\b|\?view=calendar/i,
  'monday.com': /\bcalendar\b/i,
  'github.com': /\/projects\/.+\/views\/.*\bcalendar\b/i,
};

function urlPartsOf(url: string | null | undefined): { host: string; path: string } | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return { host: parsed.host.toLowerCase(), path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return null;
  }
}

function isCalendarUrl(url: string | null | undefined): boolean {
  const parts = urlPartsOf(url);
  if (!parts) return false;
  const { host, path } = parts;

  let matchedHost = CALENDAR_HOSTS.has(host) ? host : [...CALENDAR_HOSTS].find((entry) => host.endsWith('.' + entry));
  if (!matchedHost) return false;

  const pathReq = CALENDAR_HOST_PATH_REQUIREMENT[matchedHost];
  return pathReq ? pathReq.test(path) : true;
}

const MONTH_NAME_PATTERN = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTHS_RE = new RegExp(`\b(?:${MONTH_NAME_PATTERN})\b`, 'i');
const FULL_ENGLISH_DATE_RE = new RegExp(`\b(?:${MONTH_NAME_PATTERN})\s+\d{1,2},\s*\d{4}\b`, 'i');
const MONTH_YEAR_RE = new RegExp(`\b(?<month>${MONTH_NAME_PATTERN})\s*,?\s*(?<year>\d{4})\b`, 'i');
const WEEKDAY_ABBREV_RE = /\b(?:sun|mon|tue|wed|thu|fri|sat)\b/gi;
const WEEKDAY_LABEL_RE = /\b(?<weekday>sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)(?:\s+(?<day>\d{1,2}))?\b/i;
const HOUR_12H_RE = /\b(?:1[0-2]|0?[1-9])\s?(?:am|pm)\b/gi;
const HOUR_24H_RE = /\b(?:[01]\d|2[0-3]):[0-5]\d\b/g;

function looksLikeCalendarText(text: string | null): boolean {
  if (!text || text.length < 60) return false;
  let signals = 0;

  const monthMatch = MONTHS_RE.exec(text);
  if (monthMatch && /\b(?:20\d{2}|19\d{2})\b/.test(text.slice(monthMatch.index, monthMatch.index + 40))) signals++;

  const dayHits = [...text.matchAll(WEEKDAY_ABBREV_RE)].map((m) => m.index);
  if (dayHits.length >= 3 && dayHits.some((hit, i) => dayHits[i + 2] - hit <= 120)) signals++;

  const collectHits = (re: RegExp) => [...text.matchAll(re)].map((m) => m.index);
  const hourHits = [...collectHits(HOUR_12H_RE), ...collectHits(HOUR_24H_RE)].sort((a, b) => a - b);
  if (hourHits.length >= 3 && hourHits.some((hit, i) => hourHits[i + 2] - hit <= 200)) signals++;

  return signals >= 2;
}

const SOURCE_MATCHERS: SourceMatcher[] = [
  {
    source: 'calendar_screen', label: 'calendar', match: (f) => {
      if (isNativeCalendarAppFrame(f)) return looksLikeCalendarText(f.text ?? null);
      if (isCalendarUrl(f.url)) return true;
      if (/^https?:\/\//i.test(f.url ?? '') && looksLikeCalendarText(f.text ?? null)) return true;
      return false;
    },
  },
  {
    source: 'email_screen', label: 'email', match: (f) => {
      const app = (f.app ?? '').toLowerCase();
      if (['mail', 'outlook', 'spark', 'airmail', 'superhuman', 'hey'].includes(app)) return true;
      const url = (f.url ?? '').toLowerCase();
      return /^https?:\/\/mail\.google\.com/.test(url) || /^https?:\/\/outlook\.(live|office|office365)\.com\/(?:mail|owa)/.test(url) || /^https?:\/\/(?:.+\.)?superhuman\.com/.test(url);
    },
  },
  {
    source: 'slack_screen', label: 'chat', match: (f) => {
      const app = (f.app ?? '').toLowerCase();
      if (['slack', 'discord', 'microsoft teams', 'teams'].includes(app)) return true;
      return /^https?:\/\/app\.slack\.com|^https?:\/\/.+\.slack\.com|^https?:\/\/teams\.microsoft\.com|^https?:\/\/discord\.com\/channels/.test(f.url ?? '');
    },
  },
  {
    source: 'task_screen', label: 'task', match: (f) => {
      return /^https?:\/\/linear\.app\/.+\/issue|^https?:\/\/github\.com\/.+\/(?:issues|pull)\/\d+|^https?:\/\/.+\.atlassian\.net\/browse|^https?:\/\/.+\.notion\.so/.test(f.url ?? '');
    },
  },
];

export class EventExtractor {
  private readonly logger: Logger;
  private readonly lookbackDays: number;
  private readonly minTextChars: number;
  private readonly maxFramesPerBucket: number;
  private readonly llmEnabled: boolean;
  private readonly maxPromptChars: number;
  private readonly maxEventsPerResponse: number;
  private readonly contextWindowMs: number;
  private readonly maxContextEventsPerTick: number;
  private readonly visionAttachments: number;
  private readonly dataDir: string;

  constructor(private readonly storage: IStorage, private readonly model: IModelAdapter, logger: Logger, opts: EventExtractorOptions = {}) {
    this.logger = logger.child('event-extractor');
    this.dataDir = opts.dataDir ?? '';
    this.lookbackDays = Math.max(1, Math.min(opts.lookbackDays ?? 7, 30));
    this.minTextChars = Math.max(20, opts.minTextChars ?? 80);
    this.maxFramesPerBucket = Math.max(5, Math.min(opts.maxFramesPerBucket ?? 40, 120));
    this.llmEnabled = opts.llmEnabled ?? true;
    this.maxPromptChars = Math.max(2000, opts.maxPromptChars ?? 14_000);
    this.maxEventsPerResponse = Math.max(4, Math.min(opts.maxEventsPerResponse ?? 25, 50));
    this.contextWindowMs = Math.max(15 * 60_000, opts.contextWindowMs ?? 90 * 60_000);
    this.maxContextEventsPerTick = Math.max(0, opts.maxContextEventsPerTick ?? 12);
    this.visionAttachments = Math.max(0, Math.min(opts.visionAttachments ?? 3, 6));
  }

  async tick(opts: EventExtractorTickOptions = {}): Promise<EventExtractorResult> {
    const result: EventExtractorResult = {
      meetingsLifted: 0, llmExtracted: 0, contextEnriched: 0, daysScanned: 0, bucketsScanned: 0, framesScanned: 0, modelAvailable: false, failed: 0,
    };

    try {
      result.meetingsLifted = await this.liftMeetings();
    } catch (err) {
      this.logger.warn('liftMeetings failed', { err: String(err) });
    }

    if (!this.llmEnabled) return result;
    result.modelAvailable = await this.model.isAvailable().catch(() => false);
    if (!result.modelAvailable) return result;

    const scanLookback = Math.max(1, Math.min(opts.lookbackDays ?? this.lookbackDays, 30));
    const sourceFilter = opts.sources?.length ? new Set<DayEventSource>(opts.sources) : null;

    for (const captureDay of recentDays(scanLookback)) {
      try {
        const stats = await this.extractForCaptureDay(captureDay, sourceFilter);
        result.llmExtracted += stats.extracted;
        result.bucketsScanned += stats.buckets;
        result.framesScanned += stats.frames;
        result.daysScanned += 1;
      } catch (err) {
        result.failed += 1;
        this.logger.warn(`extraction failed for ${captureDay}`, { err: String(err) });
      }
    }

    if (opts.enrichContexts ?? true) {
      try {
        result.contextEnriched = await this.enrichContexts();
      } catch (err) {
        this.logger.warn('context enrichment failed', { err: String(err) });
      }
    }

    return result;
  }

  async drain(): Promise<EventExtractorResult> {
    return await this.tick();
  }

  private async liftMeetings(): Promise<number> {
    const meetings = await this.storage.listMeetings({ order: 'recent', limit: 500 }).catch(() => []);
    let liftedNow = 0;
    for (const meeting of meetings) {
      const id = `evt_mtg_${meeting.id}`;
      const existing = await this.storage.getDayEvent(id).catch(() => null);
      const hash = meetingContentHash(meeting);
      if (existing && existing.content_hash === hash) continue;

      const now = new Date().toISOString();
      const tldr = (meeting.summary_json?.tldr ?? '').trim() || deterministicMeetingContext(meeting);

      const event: DayEvent = {
        id, day: meeting.day, starts_at: meeting.started_at, ends_at: meeting.ended_at,
        kind: 'meeting', source: 'meeting_capture',
        title: (meeting.title ?? '').trim() || (meeting.summary_json?.title ?? '').trim() || `${platformLabel(meeting.platform)} meeting`,
        source_app: platformLabel(meeting.platform), context_md: tldr || null,
        attendees: meeting.attendees, links: meeting.links, meeting_id: meeting.id,
        evidence_frame_ids: [], content_hash: hash, status: 'ready', failure_reason: null,
        created_at: existing?.created_at ?? now, updated_at: now,
      };

      try {
        await this.storage.upsertDayEvent(event);
        liftedNow++;
      } catch (err) {
        this.logger.warn(`upsert failed for meeting ${meeting.id}`, { err: String(err) });
      }
    }
    return liftedNow;
  }

  private async extractForCaptureDay(captureDay: string, sourceFilter: Set<DayEventSource> | null): Promise<{ extracted: number; buckets: number; frames: number }> {
    const frames = await this.storage.getJournal(captureDay).catch(() => [] as Frame[]);
    if (!frames.length) return { extracted: 0, buckets: 0, frames: 0 };

    const buckets = this.bucketFrames(frames, sourceFilter);
    let extractedTotal = 0, framesTotal = 0;
    for (const bucket of buckets) {
      framesTotal += bucket.frames.length;
      extractedTotal += await this.runLlmExtraction(captureDay, bucket);
    }
    return { extracted: extractedTotal, buckets: buckets.length, frames: framesTotal };
  }

  private bucketFrames(frames: Frame[], sourceFilter: Set<DayEventSource> | null): SourceBucket[] {
    const groups = new Map<string, SourceBucket>();
    for (const frame of frames) {
      const matcher = SOURCE_MATCHERS.find((m) => m.match(frame));
      if (!matcher || (sourceFilter && !sourceFilter.has(matcher.source)) || (frame.text ?? '').trim().length < this.minTextChars) continue;

      const appKey = frame.app ?? matcher.label;
      const groupKey = matcher.source === 'calendar_screen' ? `${matcher.source}|*` : `${matcher.source}|${appKey}`;
      if (!groups.has(groupKey)) groups.set(groupKey, { source: matcher.source, app: appKey, frames: [] });
      groups.get(groupKey)!.frames.push(frame);
    }

    for (const bucket of groups.values()) {
      const seen = new Set<string>();
      bucket.frames = bucket.frames.filter((f) => {
        const key = f.perceptual_hash ?? `${f.window_title ?? ''}|${(f.text ?? '').slice(0, 200)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).slice(-this.maxFramesPerBucket);
    }
    return Array.from(groups.values()).filter((b) => b.frames.length > 0).sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source));
  }

  private async runLlmExtraction(captureDay: string, bucket: SourceBucket): Promise<number> {
    const extractionBucket = bucket.source === 'calendar_screen' ? latestCalendarCaptureBucket(bucket) : bucket;
    const useVision = this.visionAttachments > 0 && extractionBucket.source === 'calendar_screen' && this.model.getModelInfo().supportsVision === true;
    const visionImages = useVision ? await this.loadVisionImages(extractionBucket) : [];
    const prompt = buildExtractionPrompt(captureDay, extractionBucket, this.maxPromptChars, visionImages.length > 0);

    let parsed: ExtractionPayload | null = null;
    let usedDeterministicFallback = false;
    let canReplaceCalendarView = false;

    try {
      const raw = visionImages.length > 0
        ? await this.model.completeWithVision(prompt, visionImages, { systemPrompt: EXTRACTION_SYSTEM_PROMPT, temperature: 0.2, maxTokens: 2400, responseFormat: 'json' })
        : await this.model.complete(prompt, { systemPrompt: EXTRACTION_SYSTEM_PROMPT, temperature: 0.2, maxTokens: 2400, responseFormat: 'json' });
      parsed = safeParseExtraction(raw);
      canReplaceCalendarView = extractionBucket.source === 'calendar_screen' && parsed !== null;
    } catch {
      if (extractionBucket.source === 'calendar_screen') {
        parsed = { events: deterministicCalendarCandidates(captureDay, extractionBucket) };
        usedDeterministicFallback = parsed.events.length > 0;
        canReplaceCalendarView = usedDeterministicFallback;
      } else return 0;
    }

    if (!parsed) {
      if (extractionBucket.source === 'calendar_screen') {
        parsed = { events: deterministicCalendarCandidates(captureDay, extractionBucket) };
        usedDeterministicFallback = parsed.events.length > 0;
        canReplaceCalendarView = usedDeterministicFallback;
      }
      if (!parsed) return 0;
    }

    if (extractionBucket.source === 'calendar_screen') {
      const structured = structuredCalendarCandidates(extractionBucket);
      if (structured.length > 0) {
        parsed = { events: mergeStructuredCalendarCandidates(parsed.events, structured, captureDay) };
        canReplaceCalendarView = true;
      }
      if (parsed.events.length === 0) {
        const fallback = deterministicCalendarCandidates(captureDay, extractionBucket);
        if (fallback.length > 0) {
          parsed = { events: fallback };
          usedDeterministicFallback = true;
          canReplaceCalendarView = true;
        }
      }
      if (parsed.events.length > 0 && !usedDeterministicFallback) {
        const grounded = parsed.events.filter((candidate) => calendarCandidateIsGrounded(candidate, extractionBucket));
        parsed = grounded.length > 0 ? { events: grounded } : { events: deterministicCalendarCandidates(captureDay, extractionBucket) };
        if (grounded.length === 0) {
          usedDeterministicFallback = parsed.events.length > 0;
          canReplaceCalendarView = parsed.events.length > 0;
        }
      }
    }

    const candidatesToPersist = parsed.events.slice(0, this.maxEventsPerResponse);
    if (extractionBucket.source === 'calendar_screen' && canReplaceCalendarView) {
      await this.replaceCalendarDaysWithCandidates(captureDay, extractionBucket, candidatesToPersist);
    }

    let count = 0;
    const now = new Date().toISOString();
    for (const candidate of candidatesToPersist) {
      const title = (candidate?.title ?? '').trim();
      if (!title) continue;

      const startsAt = parseEventTimestamp(candidate?.starts_at) ?? coerceTimeOnCaptureDay(candidate?.starts_at, captureDay) ?? defaultStartOnDay(captureDay);
      const eventDay = localDayKey(new Date(startsAt));
      if (!isValidEventDay(eventDay)) continue;

      const endsAt = parseEventTimestamp(candidate?.ends_at) ?? coerceTimeOnCaptureDay(candidate?.ends_at, eventDay);
      const hourBucket = localHourBucket(startsAt);
      const id = deterministicEventId(bucket.source, eventDay, hourBucket, title);
      const contentHash = sha1(`${eventDay}|${hourBucket}|${title}|${endsAt ?? ''}`);

      const existing = await this.storage.getDayEvent(id).catch(() => null);
      if (existing && existing.content_hash === contentHash && existing.context_md) continue;

      const event: DayEvent = {
        id, day: eventDay, starts_at: startsAt, ends_at: endsAt, kind: normaliseKind(candidate?.kind),
        source: extractionBucket.source, title: title.slice(0, 200), source_app: extractionBucket.app,
        context_md: (candidate?.context ?? '').trim().slice(0, 1200) || null,
        attendees: Array.isArray(candidate?.attendees) ? candidate.attendees.filter((s): s is string => typeof s === 'string').slice(0, 20) : [],
        links: [], meeting_id: null, evidence_frame_ids: extractionBucket.frames.map((f) => f.id).slice(-10),
        content_hash: contentHash, status: 'ready', failure_reason: null, created_at: existing?.created_at ?? now, updated_at: now,
      };

      try {
        await this.storage.upsertDayEvent(event);
        count++;
      } catch (err) {
        this.logger.debug(`upsertDayEvent failed`, { err: String(err) });
      }
    }
    return count;
  }

  private async replaceCalendarDaysWithCandidates(captureDay: string, bucket: SourceBucket, candidates: ExtractionCandidate[]): Promise<void> {
    const visibleDays = visibleCalendarDays(captureDay, bucket, candidates);
    for (const day of visibleDays) {
      await this.storage.deleteDayEventsBySourceForDay(day, 'calendar_screen').catch(() => {});
    }
  }

  private async loadVisionImages(bucket: SourceBucket): Promise<Buffer[]> {
    if (this.visionAttachments <= 0) return [];
    const candidates = bucket.frames.filter((f) => f.asset_path).slice(-this.visionAttachments * 2).reverse();
    const out: Buffer[] = [];
    for (const f of candidates) {
      if (out.length >= this.visionAttachments) break;
      const buf = await this.readAsset(f.asset_path!);
      if (buf) out.push(buf);
    }
    return out;
  }

  private async readAsset(assetPath: string): Promise<Buffer | null> {
    if (path.isAbsolute(assetPath)) return fs.readFile(assetPath).catch(() => null);
    if (this.dataDir) return fs.readFile(path.join(this.dataDir, assetPath)).catch(() => this.storage.readAsset(assetPath).catch(() => null));
    return this.storage.readAsset(assetPath).catch(() => null);
  }

  private async enrichContexts(): Promise<number> {
    const cutoffFrom = new Date(Date.now() - this.lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    const events = await this.storage.listDayEvents({ from: cutoffFrom, order: 'recent', limit: 500 }).catch(() => []);
    const candidates = events.filter((ev) => ev.kind !== 'meeting' && (!ev.context_md || ev.context_md.length < 40)).slice(0, this.maxContextEventsPerTick);

    let enriched = 0;
    for (const event of candidates) {
      if (await this.enrichOne(event)) enriched++;
    }
    return enriched;
  }

  private async enrichOne(event: DayEvent): Promise<boolean> {
    const start = Date.parse(event.starts_at);
    if (Number.isNaN(start)) return false;
    const from = new Date(start - this.contextWindowMs).toISOString(), to = new Date(start + this.contextWindowMs).toISOString();

    const frames = await this.storage.searchFrames({ from, to, limit: 80 }).catch(() => []);
    const contextFrames = frames.filter((f) => !SOURCE_MATCHERS.some((m) => m.match(f)) && (f.text ?? '').trim().length >= 40);
    if (contextFrames.length === 0) return false;

    const byApp = new Map<string, Frame>();
    for (const f of contextFrames) if (!byApp.has(f.app ?? 'unknown')) byApp.set(f.app ?? 'unknown', f);
    const picks = Array.from(byApp.values()).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).slice(0, 6);

    const prompt = buildContextPrompt(event, picks);
    const raw = await this.model.complete(prompt, { systemPrompt: CONTEXT_SYSTEM_PROMPT, temperature: 0.2, maxTokens: 240 }).catch(() => '');
    const cleaned = (raw ?? '').trim().slice(0, 800);
    if (!cleaned || /^no related context found$/i.test(cleaned)) return false;

    const merged = mergeContext(event.context_md, cleaned);
    try {
      await this.storage.upsertDayEvent({
        ...event, context_md: merged,
        evidence_frame_ids: Array.from(new Set([...event.evidence_frame_ids, ...picks.map((p) => p.id)])).slice(-12),
        content_hash: sha1(`${event.content_hash}|enriched|${cleaned.length}`), updated_at: new Date().toISOString(),
      });
      return true;
    } catch {
      return false;
    }
  }
}

function latestCalendarCaptureBucket(bucket: SourceBucket): SourceBucket {
  if (bucket.frames.length <= 1) return bucket;
  const frames = bucket.frames.slice().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const latest = frames[frames.length - 1];
  const latestMs = Date.parse(latest.timestamp);
  const latestFrames = Number.isFinite(latestMs) ? frames.filter((f) => f.id === latest.id || Math.abs(Date.parse(f.timestamp) - latestMs) <= LATEST_CALENDAR_CAPTURE_WINDOW_MS) : [latest];
  return { ...bucket, frames: latestFrames.length > 0 ? latestFrames : [latest] };
}

function recentDays(lookback: number): string[] {
  return Array.from({ length: lookback }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - i); return localDayKey(d);
  });
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function meetingContentHash(meeting: Meeting): string {
  return sha1([meeting.id, meeting.title ?? '', meeting.summary_json?.title ?? '', meeting.summary_json?.tldr ?? '', meeting.started_at, meeting.ended_at, meeting.duration_ms, meeting.attendees.join(','), meeting.summary_status, meeting.content_hash].join('|')).slice(0, 16);
}

function deterministicMeetingContext(meeting: Meeting): string {
  const mins = Math.max(1, Math.round(meeting.duration_ms / 60_000));
  const att = meeting.attendees.length > 0 ? ` with ${meeting.attendees.slice(0, 6).join(', ')}` : '';
  const trans = meeting.transcript_chars > 0 ? ` (${(meeting.transcript_chars / 1000).toFixed(1)}k chars)` : ' (no audio)';
  return `${mins}-min ${platformLabel(meeting.platform)} meeting${att}${trans}.`;
}

function platformLabel(platform: Meeting['platform']): string {
  return { zoom: 'Zoom', meet: 'Google Meet', teams: 'Microsoft Teams', webex: 'Webex', whereby: 'Whereby', around: 'Around', other: 'Meeting' }[platform] || 'Meeting';
}

function deterministicEventId(source: DayEventSource, eventDay: string, hourBucket: string, title: string): string {
  return `evt_${source.split('_')[0]}_${eventDay.replace(/-/g, '')}_${sha1([source, eventDay, hourBucket, normaliseTitleForKey(title)].join('|')).slice(0, 12)}`;
}

function sourcePriority(source: DayEventSource): number {
  return { calendar_screen: 0 as const, meeting_capture: 1 as const, email_screen: 2 as const, slack_screen: 3 as const, task_screen: 4 as const, other_screen: 9 as const }[source] ?? 9;
}

function normaliseTitleForKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '');
}

function buildExtractionPrompt(captureDay: string, bucket: SourceBucket, maxChars: number, vision: boolean): string {
  const hints = {
    calendar_screen: `These captures come from the user's calendar app (${bucket.app}). ${vision ? 'Use attached screenshots.' : 'OCR text is primary.'}`,
    email_screen: 'These screenshots are from the user’s email app. Surface meaningful threads.',
    slack_screen: 'These screenshots are from a chat app. Surface notable conversations.',
    task_screen: 'These screenshots are from a task tracker. Surface tickets.',
  };
  const header = [`Day: ${captureDay}`, `App: ${bucket.app}`, `Surface: ${bucket.source}`, '', hints[bucket.source as keyof typeof hints] || '', ''].join('\n');
  let used = header.length, blocks = [];
  for (const frame of bucket.frames) {
    const block = `\n[FRAME ${frame.id}] "${frame.window_title ?? ''}"\n${(frame.text ?? '').trim().slice(0, 2200)}\n`;
    if (used + block.length > maxChars) break;
    blocks.push(block); used += block.length;
  }
  return `${header}${blocks.join('')}\n\nExtract every meaningful event.`;
}

function buildContextPrompt(event: DayEvent, frames: Frame[]): string {
  return [`Event: ${event.title}`, `At: ${event.starts_at}`, `Source: ${event.source_app ?? event.source}`, '',
    ...frames.map((f) => `\n[${f.app ?? 'unknown'}] "${f.window_title ?? ''}"\n${(f.text ?? '').trim().slice(0, 900)}\n`),
    '', 'Write context description.'].join('\n');
}

interface ExtractionCandidate { title?: string; kind?: string; starts_at?: string | null; ends_at?: string | null; attendees?: unknown; context?: string; }
interface ExtractionPayload { events: ExtractionCandidate[]; }

function safeParseExtraction(raw: string): ExtractionPayload | null {
  const trimmed = raw.trim();
  const cands = [trimmed, trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim(), trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)].filter(Boolean) as string[];
  for (const c of cands) {
    try {
      const parsed = JSON.parse(c);
      if (Array.isArray(parsed)) return { events: parsed };
      if (parsed && Array.isArray(parsed.events)) return parsed;
    } catch {}
  }
  return null;
}

function normaliseKind(kind: string | undefined): DayEventKind {
  const k = (kind ?? '').toLowerCase();
  return ['calendar', 'communication', 'task'].includes(k) ? k as DayEventKind : ['message', 'chat', 'email'].includes(k) ? 'communication' : ['todo', 'ticket'].includes(k) ? 'task' : 'other';
}

function coerceTimeOnCaptureDay(raw: string | null | undefined, day: string): string | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const m = String(raw).trim().match(/^(\d{1,2})[:.]?(\d{2})?\s*(am|pm)?$/i);
  if (!m) return null;
  let [_, h, min, ampm] = m, hour = parseInt(h, 10), minute = min ? parseInt(min, 10) : 0;
  if (ampm?.toLowerCase() === 'pm' && hour < 12) hour += 12;
  if (ampm?.toLowerCase() === 'am' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const synth = new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`);
  return Number.isNaN(synth.getTime()) ? null : synth.toISOString();
}

function deterministicCalendarCandidates(captureDay: string, bucket: SourceBucket): ExtractionCandidate[] {
  const structured = structuredCalendarCandidates(bucket);
  if (structured.length > 0) return structured;

  const out: ExtractionCandidate[] = [];
  const seen = new Set<string>();
  for (const frame of bucket.frames.slice().sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))) {
    if (out.length >= 25) break;
    const text = (frame.text ?? '').trim();
    if (!looksLikeCalendarText(text)) continue;

    let currentHour = null, minuteOffset = 0, inAllDay = false;
    for (const line of text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
      if (/^all[-\s]?day$/i.test(line)) { inAllDay = true; currentHour = null; minuteOffset = 0; continue; }
      const time = parseCalendarTimeLabel(line);
      if (time) { currentHour = time; minuteOffset = 0; inAllDay = false; continue; }

      const title = cleanCalendarFallbackTitle(line);
      if (!title) continue;

      const startsAt = inAllDay ? defaultStartOnDay(captureDay) : currentHour ? coerceTimeOnCaptureDay(`${String(currentHour.hour).padStart(2, '0')}:${String(Math.min(55, currentHour.minute + minuteOffset)).padStart(2, '0')}`, captureDay) : null;
      if (!startsAt) continue;

      const key = `${localDayKey(new Date(startsAt))}|${localHourBucket(startsAt)}|${normaliseTitleForKey(title)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const startMs = Date.parse(startsAt);
      out.push({ title, kind: 'calendar', starts_at: startsAt, ends_at: Number.isNaN(startMs) ? null : new Date(startMs + (inAllDay ? 24 * 60 : 30) * 60_000).toISOString(), attendees: [], context: 'Visible in OCR.' });
      if (!inAllDay) minuteOffset += 15;
      if (out.length >= 25) break;
    }
  }
  return out;
}

function structuredCalendarCandidates(bucket: SourceBucket): ExtractionCandidate[] {
  const out: ExtractionCandidate[] = [];
  const seen = new Set<string>();
  for (const frame of bucket.frames.slice().sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))) {
    if (out.length >= 25) break;
    if (!looksLikeCalendarText((frame.text ?? '').trim())) continue;
    for (const candidate of structuredCalendarCandidatesFromText(frame.text ?? '', frame)) {
      const startsAt = parseEventTimestamp(candidate.starts_at);
      if (!startsAt) continue;
      const key = `${localDayKey(new Date(startsAt))}|${localHourBucket(startsAt)}|${normaliseTitleForKey(candidate.title ?? '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
      if (out.length >= 25) break;
    }
  }
  return out;
}

function mergeStructuredCalendarCandidates(candidates: ExtractionCandidate[], structured: ExtractionCandidate[], captureDay: string): ExtractionCandidate[] {
  if (!structured.length) return candidates;
  const out: ExtractionCandidate[] = [], used = new Set<number>();

  for (const s of structured) {
    const matchIdx = candidates.findIndex((c, i) => !used.has(i) && calendarCandidatesLikelySame(c, s, captureDay));
    if (matchIdx >= 0) {
      used.add(matchIdx);
      out.push({ ...candidates[matchIdx]!, kind: 'calendar', starts_at: s.starts_at, ends_at: s.ends_at, title: (candidates[matchIdx]!.title ?? '').trim() || s.title, context: (candidates[matchIdx]!.context ?? '').trim() || s.context });
    } else out.push(s);
  }
  candidates.forEach((c, i) => !used.has(i) && out.push(c));
  return dedupeExtractionCandidates(out, captureDay);
}

function dedupeExtractionCandidates(candidates: ExtractionCandidate[], captureDay: string): ExtractionCandidate[] {
  const out: ExtractionCandidate[] = [], seen = new Set<string>();
  for (const c of candidates) {
    const titleKey = normaliseTitleForKey(c.title ?? '');
    if (!titleKey) continue;
    const startsAt = parseEventTimestamp(c.starts_at) ?? coerceTimeOnCaptureDay(c.starts_at, captureDay);
    const key = `${startsAt ? localDayKey(new Date(startsAt)) : captureDay}|${startsAt ? localHourBucket(startsAt) : '00'}|${titleKey}`;
    if (!seen.has(key)) { seen.add(key); out.push(c); }
  }
  return out;
}

function calendarCandidatesLikelySame(a: ExtractionCandidate, b: ExtractionCandidate, captureDay: string): boolean {
  return calendarCandidateDatesOverlap(a, b, captureDay) && calendarTitlesLikelySame(a.title ?? '', b.title ?? '');
}

function calendarCandidateDatesOverlap(a: ExtractionCandidate, b: ExtractionCandidate, captureDay: string): boolean {
  const aKeys = calendarCandidateDateKeys(a, captureDay), bKeys = calendarCandidateDateKeys(b, captureDay);
  return !aKeys.size || !bKeys.size || [...aKeys].some((k) => bKeys.has(k));
}

function calendarCandidateDateKeys(candidate: ExtractionCandidate, captureDay: string): Set<string> {
  const startsAt = parseEventTimestamp(candidate.starts_at) ?? coerceTimeOnCaptureDay(candidate.starts_at, captureDay);
  if (!startsAt || Number.isNaN(Date.parse(startsAt))) return new Set();
  return new Set([`local:${localDayKey(new Date(startsAt))}`, `iso:${startsAt.slice(0, 10)}`]);
}

function calendarTitlesLikelySame(a: string, b: string): boolean {
  const aNorm = normaliseTitleForKey(a), bNorm = normaliseTitleForKey(b);
  if (!aNorm || !bNorm) return false;
  if (aNorm === bNorm || (aNorm.length >= 8 && bNorm.includes(aNorm)) || (bNorm.length >= 8 && aNorm.includes(bNorm))) return true;
  const aTokens = aNorm.split(/\s+/).filter((t) => t.length >= 3), bTokens = new Set(bNorm.split(/\s+/).filter((t) => t.length >= 3));
  return aTokens.length >= 2 && bTokens.size >= 2 && aTokens.filter((t) => bTokens.has(t)).length >= Math.max(2, Math.ceil(Math.min(aTokens.length, bTokens.size) * 0.7));
}

function visibleCalendarDays(captureDay: string, bucket: SourceBucket, candidates: ExtractionCandidate[]): Set<string> {
  const days = new Set<string>();
  candidates.forEach((c) => {
    const startsAt = parseEventTimestamp(c.starts_at) ?? coerceTimeOnCaptureDay(c.starts_at, captureDay);
    if (startsAt && isValidEventDay(localDayKey(new Date(startsAt)))) days.add(localDayKey(new Date(startsAt)));
  });
  let sawText = false;
  bucket.frames.forEach((f) => {
    if (looksLikeCalendarText(f.text ?? '')) {
      sawText = true;
      calendarVisibleDaysFromText(f.text ?? '').forEach((d) => days.add(d));
    }
  });
  if (!days.size && sawText && isValidEventDay(captureDay)) days.add(captureDay);
  return days;
}

function calendarVisibleDaysFromText(text: string): Set<string> {
  const days = new Set<string>();
  [...text.matchAll(new RegExp(FULL_ENGLISH_DATE_RE.source, 'gi'))].forEach((m) => {
    const d = parseEnglishDateDay(m[0]); if (d) days.add(d);
  });
  const monthYear = parseCalendarMonthYear(text);
  if (monthYear) calendarWeekdayLabelDays(text, monthYear.year, monthYear.monthIndex).forEach((d) => days.add(d));
  return days;
}

function parseCalendarMonthYear(text: string): { monthIndex: number; year: number } | null {
  const m = MONTH_YEAR_RE.exec(text);
  if (!m?.groups) return null;
  const monthIndex = monthIndexFromName(m.groups.month), year = Number(m.groups.year);
  return monthIndex !== null && Number.isInteger(year) && year >= 1000 && year <= 9999 ? { monthIndex, year } : null;
}

function calendarWeekdayLabelDays(text: string, year: number, monthIndex: number): Set<string> {
  const days = new Set<string>();
  const labels = [...text.matchAll(new RegExp(WEEKDAY_LABEL_RE.source, 'gi'))].map((m) => ({ index: m.index, weekday: weekdayIndexFromName(m.groups?.weekday ?? ''), dayNumber: Number(m.groups?.day) || null })).filter((l) => l.weekday !== null).slice(0, 40) as { index: number; weekday: number; dayNumber: number | null }[];
  const header = labels.length < 3 ? labels.filter((l) => l.dayNumber).slice(0, 7) : labels.slice(0, 7); // Simplified header detection
  const numbered = header.filter((l) => l.dayNumber !== null);

  numbered.forEach((l) => { const d = localDayFromCalendarParts(year, monthIndex, l.dayNumber!, true); if (d) days.add(d); });
  header.filter((l) => !l.dayNumber).forEach((l) => {
    const nearest = numbered.sort((a, b) => Math.abs(a.index - l.index) - Math.abs(b.index - l.index))[0];
    if (nearest) {
      let offset = l.weekday - nearest.weekday;
      if (l.index > nearest.index && offset < 0) offset += 7;
      if (l.index < nearest.index && offset > 0) offset -= 7;
      const d = localDayFromCalendarParts(year, monthIndex, nearest.dayNumber! + offset, false);
      if (d) days.add(d);
    }
  });
  return days;
}

function localDayFromCalendarParts(year: number, monthIndex: number, dayNumber: number, requireSameMonth: boolean): string | null {
  const d = new Date(year, monthIndex, dayNumber, 12, 0, 0);
  if (Number.isNaN(d.getTime()) || (requireSameMonth && d.getMonth() !== monthIndex)) return null;
  return isValidEventDay(localDayKey(d)) ? localDayKey(d) : null;
}

function structuredCalendarCandidatesFromText(text: string, frame: Frame): ExtractionCandidate[] {
  const out: ExtractionCandidate[] = [];
  [...text.matchAll(/(?<title>[A-Za-z0-9][^.\n]{2,140}?)\.\s*Starts on (?<startDate>[A-Za-z]+ \d{1,2}, \d{4}) at (?<startTime>\d{1,2}(?::\d{2})?\s*(?:AM|PM)) and ends (?:on (?<endDate>[A-Za-z]+ \d{1,2}, \d{4}) at |at )(?<endTime>\d{1,2}(?::\d{2})?\s*(?:AM|PM))/gi)].forEach((m) => {
    const startsAt = parseEnglishDateTime(m.groups?.startDate, m.groups?.startTime);
    if (startsAt && cleanCalendarFallbackTitle(m.groups?.title ?? '')) out.push({ title: cleanCalendarFallbackTitle(m.groups!.title)!, kind: 'calendar', starts_at: startsAt, ends_at: parseEnglishDateTime(m.groups?.endDate || m.groups?.startDate, m.groups?.endTime), attendees: [], context: 'Visible in accessibility text.' });
  });
  [...text.matchAll(/(?<title>[A-Za-z0-9][^.\n]{2,140}?)\.\s*(?<date>[A-Za-z]+ \d{1,2}, \d{4}),\s*All-Day/gi)].forEach((m) => {
    const startsAt = parseEnglishDateTime(m.groups?.date, '12:00 AM');
    if (startsAt && cleanCalendarFallbackTitle(m.groups?.title ?? '')) out.push({ title: cleanCalendarFallbackTitle(m.groups!.title)!, kind: 'calendar', starts_at: startsAt, ends_at: new Date(Date.parse(startsAt) + 24 * 60 * 60_000).toISOString(), attendees: [], context: 'Visible in accessibility text.' });
  });
  return out.slice(0, 25);
}

function parseEnglishDateTime(date?: string, time?: string): string | null {
  return date && time && !Number.isNaN(Date.parse(`${date} ${time}`)) ? new Date(Date.parse(`${date} ${time}`)).toISOString() : null;
}

function parseEnglishDateDay(date?: string): string | null {
  const d = date ? localDayKey(new Date(Date.parse(`${date} 12:00 PM`))) : null;
  return d && isValidEventDay(d) ? d : null;
}

function monthIndexFromName(raw: string): number | null {
  const idx = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(raw.trim().toLowerCase().slice(0, 3));
  return idx >= 0 ? idx : null;
}

function weekdayIndexFromName(raw: string): number | null {
  const idx = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(raw.trim().toLowerCase().slice(0, 3));
  return idx >= 0 ? idx : null;
}

function calendarCandidateIsGrounded(candidate: ExtractionCandidate, bucket: SourceBucket): boolean {
  const titleNorm = (candidate.title ?? '').trim().toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (titleNorm.length < 3) return false;
  const ev = bucket.frames.filter((f) => looksLikeCalendarText(f.text ?? null)).map((f) => f.text ?? '').join('\n').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  if (!ev) return false;
  if (ev.includes(titleNorm)) return true;
  const tokens = titleNorm.split(' ').filter((t) => t.length >= 3 && !new Set(['and', 'the', 'with', 'for', 'from', 'meeting', 'sync', 'call']).has(t));
  return tokens.length >= 2 && tokens.filter((t) => ev.includes(t)).length >= Math.max(2, Math.ceil(tokens.length * 0.65));
}

function parseCalendarTimeLabel(line: string): { hour: number; minute: number } | null {
  const m = line.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!m) return null;
  let hour = Number(m[1]), minute = m[2] ? Number(m[2]) : 0, ampm = m[3]!.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
}

function cleanCalendarFallbackTitle(line: string): string | null {
  const s = line.replace(/^[•*·\-\\u2022]\s*/, '').replace(/\s+/g, ' ').trim();
  if (s.length < 3 || s.length > 120 || /^(calendar|file|edit|view|window|help|today|week|month|day|inbox|meeting|join|notes?|add|search|settings)$/i.test(s) || /^(sun|mon|tue|wed|thu|fri|sat)(?:day)?$/i.test(s) || /^(?:\/\s*)?(?:AM|PM)$/i.test(s) || /^\d{1,2}(?::\d{2})?\s*(?:AM|PM)$/i.test(s) || /^https?:\/\//i.test(s) || /\b(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com)\b/i.test(s) || /^[+<>()[\]{}|/\\]+$/.test(s)) return null;
  return s;
}

function defaultStartOnDay(day: string): string {
  return coerceTimeOnCaptureDay('12:00', day) ?? `${day}T12:00:00.000Z`;
}

function localHourBucket(iso: string): string {
  return Number.isNaN(Date.parse(iso)) ? '00' : String(new Date(iso).getHours()).padStart(2, '0');
}

function parseEventTimestamp(raw: string | null | undefined): string | null {
  const d = raw ? new Date(Date.parse(String(raw).trim())) : null;
  return d && !Number.isNaN(d.getTime()) && d.getFullYear() >= 1000 && d.getFullYear() <= 9999 ? d.toISOString() : null;
}

function isValidEventDay(day: string): boolean {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return !!m && Number(m[1]) >= 1000 && Number(m[1]) <= 9999 && localDayKey(new Date(`${day}T12:00:00`)) === day;
}

function mergeContext(existing: string | null, addition: string): string {
  const a = (existing ?? '').trim(), b = addition.trim();
  return !a ? b : a.toLowerCase().includes(b.toLowerCase()) ? a : `${a}\n\n${b}`.slice(0, 1500);
}

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}
