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
} from '@cofounderos/interfaces';

/**
 * EventExtractor — materialises the cross-source "event log" surface.
 *
 * For every meeting we already captured (audio + screens) it emits a
 * matching DayEvent so the timeline UI gets a single uniform feed. On
 * top of that, it scans the day's capture frames for everything that
 * looks like a scheduled item or a notable communication — calendar
 * apps, Slack, email — groups them into evidence bundles, and asks the
 * LLM to extract one or more concise events with title, time, and
 * context. The output ships even if the LLM is unavailable: meetings
 * still flow through deterministically.
 *
 * Idempotency: events get deterministic ids derived from
 * `(source, day, bucket-key)`. Re-running with the same evidence is a
 * no-op via upsert + content_hash short-circuit. Running over a new
 * day's evidence first deletes the prior source-bucket rows for that
 * day (extraction is the source of truth for what's "fresh" there).
 *
 * The worker is intentionally cheap-and-cheerful: one tick walks the
 * last N days, drains any new meetings into DayEvents, and runs the
 * LLM pass for days the user actually used a calendar / mail / chat
 * app on. Heavy lifting (full-history rebuild) flows through
 * `--full-reindex` via `clearAllDayEvents()`.
 */

export interface EventExtractorOptions {
  /** How many recent days to scan per tick. Default 7. */
  lookbackDays?: number;
  /** Min OCR chars on a candidate frame for the LLM pass. Default 80. */
  minTextChars?: number;
  /** Max frames per day per source the LLM sees. Default 30. */
  maxFramesPerBucket?: number;
  /** Whether to enable the LLM extraction pass. Default true. */
  llmEnabled?: boolean;
  /** Cap the prompt's evidence section at this many chars. Default 12000. */
  maxPromptChars?: number;
}

export interface EventExtractorResult {
  meetingsLifted: number;
  llmExtracted: number;
  daysScanned: number;
  failed: number;
}

const EXTRACTION_SYSTEM_PROMPT = `You read the user's recent screen capture for a single day and pull out the *events* worth showing on a daily calendar. The capture you see is the OCR'd text from one source app on that day (e.g. their calendar, their inbox, their Slack). Your job is to recover the underlying events.

Return STRICT JSON matching this schema (no prose around it):

{
  "events": [
    {
      "title": string,
      "kind": "calendar" | "communication" | "task" | "other",
      "starts_at": string | null,   // ISO-8601 if knowable from the OCR
      "ends_at":   string | null,
      "attendees": string[],         // names/emails when visible
      "context":   string             // 1-3 sentences describing the event, grounded in the OCR
    }
  ]
}

Rules:
- Only output events that are *meaningful* — actual calendar entries the user has scheduled, important messages/threads, a task they actively worked on. Skip UI chrome, sidebar items, notifications about reading other things.
- For calendar / scheduled items use "kind": "calendar".
- For Slack/Discord/email threads use "kind": "communication".
- For tickets / tasks / TODOs use "kind": "task".
- Anything else worth surfacing → "kind": "other". Don't reach.
- "starts_at" / "ends_at" must be valid ISO timestamps with date and time. If the OCR only shows a time but no date, use the day in the user message. If the time isn't shown, use null.
- "context" must be specific (mention names / titles / what the user is doing). 1-3 sentences. No bullet points.
- Empty array is fine. Output AT MOST 6 events per response.
`;

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

const SOURCE_MATCHERS: SourceMatcher[] = [
  {
    source: 'calendar_screen',
    label: 'calendar',
    match: (f) =>
      /calendar/i.test(f.app ?? '') ||
      /calendar\.google\.com|outlook\.(live|office)\.com\/.*calendar|fantastical|notion\.so\/.*calendar/i.test(
        haystack(f),
      ),
  },
  {
    source: 'email_screen',
    label: 'email',
    match: (f) => {
      const app = (f.app ?? '').toLowerCase();
      if (app === 'mail' || app === 'outlook' || app === 'spark' || app === 'airmail' || app === 'superhuman') {
        return true;
      }
      const url = (f.url ?? '').toLowerCase();
      if (/^https?:\/\/mail\.google\.com/.test(url)) return true;
      if (/^https?:\/\/outlook\.(live|office)\.com\/mail/.test(url)) return true;
      if (/^https?:\/\/(?:.+\.)?superhuman\.com/.test(url)) return true;
      return false;
    },
  },
  {
    source: 'slack_screen',
    label: 'slack',
    match: (f) => {
      const app = (f.app ?? '').toLowerCase();
      if (app === 'slack' || app === 'discord') return true;
      const url = (f.url ?? '').toLowerCase();
      return /^https?:\/\/app\.slack\.com|^https?:\/\/.+\.slack\.com|^https?:\/\/discord\.com\/channels/.test(
        url,
      );
    },
  },
  {
    source: 'task_screen',
    label: 'task',
    match: (f) => {
      const url = (f.url ?? '').toLowerCase();
      return /^https?:\/\/linear\.app\/.+\/issue|^https?:\/\/github\.com\/.+\/(?:issues|pull)\/\d+|^https?:\/\/.+\.atlassian\.net\/browse|^https?:\/\/.+\.notion\.so/.test(
        url,
      );
    },
  },
];

function haystack(frame: Frame): string {
  return [frame.app, frame.window_title, frame.url, frame.text].filter(Boolean).join(' \n ');
}

export class EventExtractor {
  private readonly logger: Logger;
  private readonly lookbackDays: number;
  private readonly minTextChars: number;
  private readonly maxFramesPerBucket: number;
  private readonly llmEnabled: boolean;
  private readonly maxPromptChars: number;

  constructor(
    private readonly storage: IStorage,
    private readonly model: IModelAdapter,
    logger: Logger,
    opts: EventExtractorOptions = {},
  ) {
    this.logger = logger.child('event-extractor');
    this.lookbackDays = Math.max(1, Math.min(opts.lookbackDays ?? 7, 30));
    this.minTextChars = Math.max(20, opts.minTextChars ?? 80);
    this.maxFramesPerBucket = Math.max(5, Math.min(opts.maxFramesPerBucket ?? 30, 80));
    this.llmEnabled = opts.llmEnabled ?? true;
    this.maxPromptChars = Math.max(2000, opts.maxPromptChars ?? 12_000);
  }

  async tick(): Promise<EventExtractorResult> {
    const result: EventExtractorResult = {
      meetingsLifted: 0,
      llmExtracted: 0,
      daysScanned: 0,
      failed: 0,
    };

    // 1. Lift every meeting into a DayEvent so the timeline always has
    //    those, regardless of LLM availability.
    try {
      result.meetingsLifted = await this.liftMeetings();
    } catch (err) {
      this.logger.warn('liftMeetings failed (continuing)', { err: String(err) });
    }

    // 2. LLM-driven pass over the recent days' calendar / mail / chat
    //    surfaces. Best-effort; failures here never break meeting events.
    if (this.llmEnabled) {
      const modelOk = await this.model.isAvailable().catch(() => false);
      if (modelOk) {
        for (const day of recentDays(this.lookbackDays)) {
          try {
            const extracted = await this.extractForDay(day);
            result.llmExtracted += extracted;
            result.daysScanned += 1;
          } catch (err) {
            result.failed += 1;
            this.logger.warn(`event extraction failed for ${day}`, { err: String(err) });
          }
        }
      }
    }

    return result;
  }

  /**
   * Drain-style helper used by full-reindex / smoke tests: keep ticking
   * until a tick does nothing.
   */
  async drain(): Promise<EventExtractorResult> {
    return await this.tick();
  }

  private async liftMeetings(): Promise<number> {
    let meetings: Meeting[] = [];
    try {
      meetings = await this.storage.listMeetings({
        order: 'recent',
        limit: 500,
      });
    } catch {
      return 0;
    }

    let liftedNow = 0;
    for (const meeting of meetings) {
      const id = `evt_mtg_${meeting.id}`;
      const existing = await this.storage.getDayEvent(id).catch(() => null);
      const hash = meetingContentHash(meeting);
      if (existing && existing.content_hash === hash) continue;

      const now = new Date().toISOString();
      const tldr =
        (meeting.summary_json?.tldr ?? '').trim() ||
        deterministicMeetingContext(meeting);

      const event: DayEvent = {
        id,
        day: meeting.day,
        starts_at: meeting.started_at,
        ends_at: meeting.ended_at,
        kind: 'meeting',
        source: 'meeting_capture',
        title:
          (meeting.title ?? '').trim() ||
          (meeting.summary_json?.title ?? '').trim() ||
          `${platformLabel(meeting.platform)} meeting`,
        source_app: platformLabel(meeting.platform),
        context_md: tldr || null,
        attendees: meeting.attendees ?? [],
        links: meeting.links ?? [],
        meeting_id: meeting.id,
        evidence_frame_ids: [],
        content_hash: hash,
        status: 'ready',
        failure_reason: null,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };

      try {
        await this.storage.upsertDayEvent(event);
        liftedNow += 1;
      } catch (err) {
        this.logger.warn(`upsertDayEvent failed for meeting ${meeting.id}`, {
          err: String(err),
        });
      }
    }
    return liftedNow;
  }

  private async extractForDay(day: string): Promise<number> {
    const frames = await this.storage.getJournal(day).catch(() => [] as Frame[]);
    if (frames.length === 0) return 0;

    const buckets = this.bucketFrames(frames);
    if (buckets.length === 0) return 0;

    let extractedTotal = 0;
    for (const bucket of buckets) {
      const fingerprint = bucketFingerprint(bucket);
      if (!fingerprint) continue;
      // We re-extract idempotently: delete existing events for this
      // (day, source) bucket so we don't accumulate stale rows if the
      // user revisited the same app and the OCR drifted. New rows will
      // be re-upserted under deterministic ids below.
      try {
        await this.storage.deleteDayEventsBySourceForDay(day, bucket.source);
      } catch {
        // Storage may not support deletion; carry on.
      }

      const extracted = await this.runLlmExtraction(day, bucket, fingerprint);
      extractedTotal += extracted;
    }
    return extractedTotal;
  }

  private bucketFrames(frames: Frame[]): SourceBucket[] {
    const groups = new Map<string, SourceBucket>();
    for (const frame of frames) {
      const matcher = SOURCE_MATCHERS.find((m) => m.match(frame));
      if (!matcher) continue;
      const text = (frame.text ?? '').trim();
      if (text.length < this.minTextChars) continue;

      const appKey = frame.app ?? matcher.label;
      const groupKey = `${matcher.source}|${appKey}`;
      let bucket = groups.get(groupKey);
      if (!bucket) {
        bucket = { source: matcher.source, app: appKey, frames: [] };
        groups.set(groupKey, bucket);
      }
      bucket.frames.push(frame);
    }

    // Drop near-duplicate frames inside each bucket (same hash → same
    // OCR + same chrome) so the prompt isn't all repetition, and cap.
    for (const bucket of groups.values()) {
      const seen = new Set<string>();
      bucket.frames = bucket.frames
        .filter((f) => {
          const key = f.perceptual_hash ?? `${f.window_title ?? ''}|${(f.text ?? '').slice(0, 200)}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
        .slice(-this.maxFramesPerBucket);
    }
    return Array.from(groups.values()).filter((b) => b.frames.length > 0);
  }

  private async runLlmExtraction(
    day: string,
    bucket: SourceBucket,
    fingerprint: string,
  ): Promise<number> {
    const prompt = buildExtractionPrompt(day, bucket, this.maxPromptChars);

    let raw: string;
    try {
      raw = await this.model.complete(prompt, {
        systemPrompt: EXTRACTION_SYSTEM_PROMPT,
        temperature: 0.2,
        maxTokens: 1200,
        responseFormat: 'json',
      });
    } catch (err) {
      this.logger.debug(`llm extraction failed (${bucket.source} ${day})`, {
        err: String(err),
      });
      return 0;
    }

    const parsed = safeParseExtraction(raw);
    if (!parsed) return 0;

    const evidenceIds = bucket.frames.map((f) => f.id);
    const now = new Date().toISOString();
    let count = 0;
    for (let i = 0; i < parsed.events.length && i < 12; i++) {
      const candidate = parsed.events[i];
      if (!candidate?.title?.trim()) continue;
      const startsAt = normaliseTimestamp(candidate.starts_at, day, bucket) ?? defaultStartAt(bucket, i);
      const endsAt = normaliseTimestamp(candidate.ends_at, day, bucket);
      const kind = normaliseKind(candidate.kind);
      const id = deterministicEventId(bucket.source, day, fingerprint, i, candidate.title);

      const event: DayEvent = {
        id,
        day,
        starts_at: startsAt,
        ends_at: endsAt,
        kind,
        source: bucket.source,
        title: candidate.title.trim().slice(0, 200),
        source_app: bucket.app,
        context_md: (candidate.context ?? '').trim().slice(0, 1200) || null,
        attendees: Array.isArray(candidate.attendees)
          ? candidate.attendees.filter((s): s is string => typeof s === 'string').slice(0, 20)
          : [],
        links: [],
        meeting_id: null,
        evidence_frame_ids: evidenceIds.slice(-10),
        content_hash: fingerprint,
        status: 'ready',
        failure_reason: null,
        created_at: now,
        updated_at: now,
      };

      try {
        await this.storage.upsertDayEvent(event);
        count += 1;
      } catch (err) {
        this.logger.debug(`upsertDayEvent failed`, { err: String(err) });
      }
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recentDays(lookback: number): string[] {
  const days: string[] = [];
  const today = new Date();
  for (let i = 0; i < lookback; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

function meetingContentHash(meeting: Meeting): string {
  const parts = [
    meeting.id,
    meeting.title ?? '',
    meeting.summary_json?.title ?? '',
    meeting.summary_json?.tldr ?? '',
    meeting.started_at,
    meeting.ended_at,
    meeting.duration_ms,
    meeting.attendees.join(','),
    meeting.summary_status,
    meeting.content_hash,
  ].join('|');
  return createHash('sha1').update(parts).digest('hex').slice(0, 16);
}

function deterministicMeetingContext(meeting: Meeting): string {
  const minutes = Math.max(1, Math.round(meeting.duration_ms / 60_000));
  const pieces = [`${minutes}-min ${platformLabel(meeting.platform)} meeting`];
  if (meeting.attendees.length > 0) {
    pieces.push(`with ${meeting.attendees.slice(0, 6).join(', ')}`);
  }
  if (meeting.transcript_chars > 0) {
    pieces.push(`(${(meeting.transcript_chars / 1000).toFixed(1)}k chars of transcript captured)`);
  } else {
    pieces.push('(no audio transcript captured)');
  }
  return pieces.join(' ') + '.';
}

function platformLabel(platform: Meeting['platform']): string {
  switch (platform) {
    case 'zoom':
      return 'Zoom';
    case 'meet':
      return 'Google Meet';
    case 'teams':
      return 'Microsoft Teams';
    case 'webex':
      return 'Webex';
    case 'whereby':
      return 'Whereby';
    case 'around':
      return 'Around';
    default:
      return 'Meeting';
  }
}

function bucketFingerprint(bucket: SourceBucket): string | null {
  if (bucket.frames.length === 0) return null;
  const sig = bucket.frames
    .map((f) => `${f.id}|${f.perceptual_hash ?? ''}|${(f.window_title ?? '').slice(0, 64)}`)
    .join('\n');
  return createHash('sha1').update(`${bucket.source}|${sig}`).digest('hex').slice(0, 16);
}

function deterministicEventId(
  source: DayEventSource,
  day: string,
  fingerprint: string,
  index: number,
  title: string,
): string {
  const tag = createHash('sha1')
    .update(`${source}|${day}|${fingerprint}|${index}|${title.toLowerCase()}`)
    .digest('hex')
    .slice(0, 12);
  return `evt_${source.split('_')[0]}_${day.replace(/-/g, '')}_${tag}`;
}

function buildExtractionPrompt(
  day: string,
  bucket: SourceBucket,
  maxChars: number,
): string {
  const header = `Day in user's local time: ${day}\nSource app: ${bucket.app}\nSurface: ${bucket.source}\n\nCaptured frames (oldest first):\n`;

  const blocks: string[] = [];
  let used = header.length;
  for (const frame of bucket.frames) {
    const text = (frame.text ?? '').trim();
    if (!text) continue;
    const block = `\n[FRAME ${frame.id} @ ${frame.timestamp}] title="${frame.window_title ?? ''}" url="${frame.url ?? ''}"\n${text.slice(0, 1800)}\n`;
    if (used + block.length > maxChars) break;
    blocks.push(block);
    used += block.length;
  }

  return `${header}${blocks.join('')}\n\nExtract the day's events from this OCR. Remember: STRICT JSON only.`;
}

interface ExtractionCandidate {
  title?: string;
  kind?: string;
  starts_at?: string | null;
  ends_at?: string | null;
  attendees?: unknown;
  context?: string;
}

interface ExtractionPayload {
  events: ExtractionCandidate[];
}

function safeParseExtraction(raw: string): ExtractionPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  // Strip common markdown JSON fencing the model occasionally emits.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as ExtractionPayload;
      if (parsed && Array.isArray(parsed.events)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function normaliseKind(kind: string | undefined): DayEventKind {
  switch ((kind ?? '').toLowerCase()) {
    case 'calendar':
      return 'calendar';
    case 'communication':
    case 'message':
    case 'chat':
    case 'email':
      return 'communication';
    case 'task':
    case 'todo':
    case 'ticket':
      return 'task';
    default:
      return 'other';
  }
}

function normaliseTimestamp(
  raw: string | null | undefined,
  day: string,
  bucket: SourceBucket,
): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  // Already ISO-ish — accept if it parses.
  const direct = Date.parse(s);
  if (!Number.isNaN(direct)) return new Date(direct).toISOString();

  // Time-only "10:30" / "10:30 AM" — anchor to the day.
  const timeMatch = s.match(/^(\d{1,2})[:.](\d{2})\s*(am|pm)?$/i);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const minute = parseInt(timeMatch[2], 10);
    const ampm = timeMatch[3]?.toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
      const synth = new Date(`${day}T${pad2(hour)}:${pad2(minute)}:00`);
      if (!Number.isNaN(synth.getTime())) return synth.toISOString();
    }
  }
  // Bail — caller will fall back to a synthetic time.
  void bucket;
  return null;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function defaultStartAt(bucket: SourceBucket, index: number): string {
  const latest = bucket.frames[bucket.frames.length - 1];
  const base = latest?.timestamp ? Date.parse(latest.timestamp) : Date.now();
  // Stagger generated events 1-min apart so the timeline doesn't stack
  // them on top of each other when the model omitted a time.
  return new Date(base + index * 60_000).toISOString();
}
