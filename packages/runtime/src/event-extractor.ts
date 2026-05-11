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
} from '@cofounderos/interfaces';

/**
 * EventExtractor — materialises the cross-source "event log" surface.
 *
 * Three passes per tick:
 *
 *  1. Meeting lift (deterministic, always runs)
 *     Every captured Meeting → matching DayEvent, kind='meeting'.
 *
 *  2. Calendar / inbox / chat extraction (LLM-driven, gated on model)
 *     For each recent day, frames whose app is a calendar / mail / chat
 *     surface are grouped per app, OCR text concatenated, and the LLM
 *     is asked for the structured events visible in those screenshots.
 *     Critically: a calendar week-view shot taken on Monday shows
 *     events for the whole week — those events must land under their
 *     own day (Mon, Tue, Wed, …), NOT the capture day. We do that by
 *     trusting the LLM's `starts_at` and reading `day` from it.
 *
 *  3. Context enrichment (LLM-driven)
 *     For each non-meeting event with sparse context, gather a few
 *     non-calendar frames captured within ±90 min of the event time
 *     and ask the model for a 1-3 sentence summary explaining what the
 *     user was actually doing around that event. Skipped for meetings
 *     because those already have a Meeting record + summary.
 *
 * Idempotency: events get content-stable ids derived from
 * `(source, day, hour-bucket, normalised-title)`. Re-running with new
 * screenshots of the same calendar week is therefore a pure upsert —
 * the row gets refreshed, never duplicated.
 */

export interface EventExtractorOptions {
  /** Base data dir; used to resolve screenshot asset paths for vision. */
  dataDir?: string;
  /** How many recent days to scan per tick. Default 7. */
  lookbackDays?: number;
  /** Min OCR chars on a candidate frame for the LLM pass. Default 80. */
  minTextChars?: number;
  /** Max frames per day per source the LLM sees. Default 40. */
  maxFramesPerBucket?: number;
  /** Whether to enable the LLM extraction pass. Default true. */
  llmEnabled?: boolean;
  /** Cap the prompt's evidence section at this many chars. Default 14000. */
  maxPromptChars?: number;
  /** Max events to persist per LLM response. Default 25. */
  maxEventsPerResponse?: number;
  /** Time window (ms) around an event we pull context frames from. Default ±90 min. */
  contextWindowMs?: number;
  /** Skip context enrichment when this many frames have already been considered. */
  maxContextEventsPerTick?: number;
  /**
   * Number of screenshot attachments to send when the model adapter
   * supports vision. Calendar grids are visual — a 3-shot vision pass
   * recovers events that OCR text alone scrambles. Default 3.
   */
  visionAttachments?: number;
}

export interface EventExtractorResult {
  meetingsLifted: number;
  llmExtracted: number;
  contextEnriched: number;
  daysScanned: number;
  /** Source buckets the extractor passed to the LLM (one per app per day). */
  bucketsScanned: number;
  /** Capture frames fed into the LLM extraction prompts. */
  framesScanned: number;
  /** Whether the model adapter was reachable during this tick. */
  modelAvailable: boolean;
  failed: number;
}

export interface EventExtractorTickOptions {
  /** Override configured lookback for this tick. Used by manual scans. */
  lookbackDays?: number;
  /** Restrict LLM/deterministic extraction to specific source surfaces. */
  sources?: DayEventSource[];
  /** Context enrichment is slower and not needed for immediate UI refreshes. */
  enrichContexts?: boolean;
}

const EXTRACTION_SYSTEM_PROMPT = `You are looking at the user's recent screen capture for a single source app — it might be their calendar, their inbox, or a chat app. Your job is to recover the meaningful EVENTS shown on screen and emit them as structured JSON.

You will be told which app surface produced the capture and given the capture frames (OCR text, plus the raw screenshots themselves when the model supports vision). Use that to identify what's on screen and extract the events visible on it.

Return STRICT JSON matching this schema (no prose around it):

{
  "events": [
    {
      "title": string,
      "kind": "calendar" | "communication" | "task" | "other",
      "starts_at": string,           // ISO-8601 with date + time when knowable
      "ends_at":   string | null,
      "attendees": string[],         // names/emails visible in the entry
      "context":   string             // 1-2 sentences; what is this event about?
    }
  ]
}

General rules:
- Only output *meaningful* events. Skip app chrome (sidebars, search bars, view-switcher buttons, "Today" buttons, notification badges).
- "kind":
    "calendar"      → scheduled item on a calendar
    "communication" → notable message thread / email
    "task"          → TODO / ticket / issue
    "other"         → otherwise meaningful (e.g. a doc being actively edited)
- "starts_at" should be a real ISO timestamp. Combine the date you read off the screen with the event's time. If you can read the date but not the time, use 00:00 (all-day) for all-day items or your best estimate for the slot it sits in. If you genuinely cannot date an event from anything visible on screen, omit "starts_at".
- "context" must be 1-2 specific sentences grounded in what you see. No bullet points.
- AT MOST 25 events. Empty array is fine.
- Do not filter events based on whether the event date is in the past, today, or the future. If the event is visible and dated, include it.

If the source is a CALENDAR APP — Apple Calendar, Google Calendar, Fantastical, Notion Calendar, Outlook, Cron, Amie, etc.:
- The app shows ONE current view at a time. It can be a single day, a week, a multi-day strip, a month, an agenda/list, a year. Recognise the view from the layout itself.
- Whatever the view is, the dates being displayed are always shown on screen — in the header, the title bar, the row/column labels, or as inline date dividers. Use those to date every event you extract.
- Treat all-day items (banners at the top of a day) as events with "starts_at" at midnight of that day and "ends_at" at the start of the next day.
- For recurring events that appear on multiple visible days, emit one event per visible occurrence with the correct date for each.
- Holidays and birthdays count as events — include them.

If the source is EMAIL, CHAT, or a TASK TRACKER: surface notable threads / tickets the user is actually engaging with; skip generic listings.
`;

const CONTEXT_SYSTEM_PROMPT = `You are filling in a missing context line for an event on the user's calendar. You have:
  - the event title and time
  - a few small screen captures from around that time of OTHER apps the user was on

Write a SINGLE 1-3 sentence English description of what the event is about, grounded in the screenshots. If the screenshots don't actually relate to the event, output "no related context found". Never fabricate details.

Return PLAIN TEXT, no JSON, no markdown.`;

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

// ---------------------------------------------------------------------------
// Calendar detection.
//
// Three independent signals — any one fires:
//   (a) the foreground app IS a calendar app (Apple Calendar, Fantastical,
//       Notion Calendar, etc.)
//   (b) the foreground URL is a known calendar webapp or a calendar
//       sub-route inside a known SaaS
//   (c) OCR heuristic: the visible text reads like a calendar grid
//       (month-year header + weekday-sequence and/or a time gutter)
//
// (c) is the catch-all for unknown calendars — self-hosted, embedded
// in random pages, brand-new SaaS we haven't curated yet.
// ---------------------------------------------------------------------------

const CALENDAR_APP_NAMES = new Set([
  'calendar',         // Apple Calendar (macOS)
  'fantastical',
  'notion calendar',
  'cron',
  'amie',
  'busycal',
  'mimestream',       // Gmail-style client with a calendar view
  'outlook',          // covers some macOS Outlook variants
]);

const CALENDAR_BUNDLE_PREFIXES = [
  'com.apple.ical',
  'com.flexibits.fantastical',
  'notion.id.notion-calendar',
  'com.cron',
  'com.busymac.busycal',
  'co.amie',
];

/**
 * Hostname (or hostname suffix) → is-calendar-host. We match by
 * `host === entry` first, then `host.endsWith('.' + entry)` so any
 * subdomain of a tenant-style host (e.g. `mycompany.calendly.com`) is
 * covered. Keep entries lowercase and bare (no scheme, no path).
 */
const CALENDAR_HOSTS = new Set<string>([
  // Google / Microsoft / Apple
  'calendar.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'outlook.com',
  'icloud.com',          // path-discriminated below
  'www.icloud.com',
  // Privacy / alternative providers
  'calendar.proton.me',
  'calendar.yahoo.com',
  'calendar.zoho.com',
  'app.fastmail.com',    // path-discriminated below
  'fastmail.com',
  'app.tuta.com',
  // Standalone calendar apps (web)
  'vimcal.com',
  'app.vimcal.com',
  'cal.com',
  'app.cal.com',
  'cron.com',
  'amie.so',
  'web.morgen.so',
  'app.akiflow.com',
  'app.reclaim.ai',
  'app.usemotion.com',
  'app.sunsama.com',
  'calendly.com',
  // Generic productivity surfaces that have a calendar view
  // (path-discriminated below to avoid false positives on the rest of
  // the app).
  'notion.so',
  'www.notion.so',
  'linear.app',
  'asana.com',
  'app.asana.com',
  'app.clickup.com',
  'monday.com',
  'github.com',
]);

/**
 * Some hosts above are general-purpose apps where only specific paths
 * are actually calendars. This list keeps the host on `CALENDAR_HOSTS`
 * (so it gets pre-filtered cheaply) but additionally requires the
 * path to match. Hosts not in this map match unconditionally.
 */
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
    return {
      host: parsed.host.toLowerCase(),
      path: `${parsed.pathname}${parsed.search}`,
    };
  } catch {
    return null;
  }
}

function isCalendarUrl(url: string | null | undefined): boolean {
  const parts = urlPartsOf(url);
  if (!parts) return false;
  const { host, path } = parts;

  // Direct host match — handles `calendar.google.com`, `vimcal.com`, …
  let matchedHost: string | null = null;
  if (CALENDAR_HOSTS.has(host)) {
    matchedHost = host;
  } else {
    // Suffix match for tenant-style hosts (e.g. `acme.calendly.com`
    // → suffix matches `calendly.com`).
    for (const entry of CALENDAR_HOSTS) {
      if (host.endsWith('.' + entry)) {
        matchedHost = entry;
        break;
      }
    }
  }
  if (!matchedHost) return false;

  const pathReq = CALENDAR_HOST_PATH_REQUIREMENT[matchedHost];
  return pathReq ? pathReq.test(path) : true;
}

/**
 * OCR-text heuristic — fires when the captured text reads like a
 * calendar grid even though we don't recognise the app or URL.
 *
 * Three independent signals; any TWO together classify the frame:
 *   1. Month name + 4-digit year nearby ("May 2026", "May, 2026")
 *   2. ≥3 weekday abbreviations in close succession ("Mon Tue Wed",
 *      "Sun Mon Tue Wed Thu Fri Sat", "Mon 11", "Tue 12", "Wed 13")
 *   3. A time gutter — 3+ hour markers within ~200 chars
 *      (either "7 AM 8 AM 9 AM" or 24h "07:00 08:00 09:00")
 */
const MONTH_NAME_PATTERN =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTHS_RE = new RegExp(`\\b(?:${MONTH_NAME_PATTERN})\\b`, 'i');
const FULL_ENGLISH_DATE_RE = new RegExp(
  `\\b(?:${MONTH_NAME_PATTERN})\\s+\\d{1,2},\\s*\\d{4}\\b`,
  'i',
);
const MONTH_YEAR_RE = new RegExp(
  `\\b(?<month>${MONTH_NAME_PATTERN})\\s*,?\\s*(?<year>\\d{4})\\b`,
  'i',
);
const WEEKDAY_ABBREV_RE = /\b(?:sun|mon|tue|wed|thu|fri|sat)\b/gi;
const WEEKDAY_LABEL_RE =
  /\b(?<weekday>sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)(?:\s+(?<day>\d{1,2}))?\b/i;
const HOUR_12H_RE = /\b(?:1[0-2]|0?[1-9])\s?(?:am|pm)\b/gi;
const HOUR_24H_RE = /\b(?:[01]\d|2[0-3]):[0-5]\d\b/g;

function looksLikeCalendarText(text: string | null): boolean {
  if (!text || text.length < 60) return false;
  let signals = 0;

  // Signal 1 — month name + nearby 4-digit year (e.g. "May 2026").
  const monthMatch = MONTHS_RE.exec(text);
  if (monthMatch) {
    const slice = text.slice(monthMatch.index, monthMatch.index + 40);
    if (/\b(?:20\d{2}|19\d{2})\b/.test(slice)) signals += 1;
  }

  // Signal 2 — weekday-abbrev sequence. Match all and check ≥3 of
  // them sit within a 120-char window (i.e. a row of weekday labels
  // rather than three random "Mon"s sprinkled across an article).
  const dayHits: number[] = [];
  let dm: RegExpExecArray | null;
  WEEKDAY_ABBREV_RE.lastIndex = 0;
  while ((dm = WEEKDAY_ABBREV_RE.exec(text))) {
    dayHits.push(dm.index);
    if (dayHits.length > 30) break;
  }
  if (dayHits.length >= 3) {
    for (let i = 0; i <= dayHits.length - 3; i++) {
      if (dayHits[i + 2] - dayHits[i] <= 120) {
        signals += 1;
        break;
      }
    }
  }

  // Signal 3 — time gutter. ≥3 hour markers in 200 chars.
  const collectHits = (re: RegExp): number[] => {
    const out: number[] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push(m.index);
      if (out.length > 40) break;
    }
    return out;
  };
  const hourHits = collectHits(HOUR_12H_RE).concat(collectHits(HOUR_24H_RE)).sort((a, b) => a - b);
  if (hourHits.length >= 3) {
    for (let i = 0; i <= hourHits.length - 3; i++) {
      if (hourHits[i + 2] - hourHits[i] <= 200) {
        signals += 1;
        break;
      }
    }
  }

  return signals >= 2;
}

const SOURCE_MATCHERS: SourceMatcher[] = [
  {
    source: 'calendar_screen',
    label: 'calendar',
    match: (f) => {
      // (a) Native app.
      if (CALENDAR_APP_NAMES.has((f.app ?? '').toLowerCase())) return true;
      const bundle = (f.app_bundle_id ?? '').toLowerCase();
      if (CALENDAR_BUNDLE_PREFIXES.some((p) => bundle.startsWith(p))) return true;

      // (b) Known calendar webapp / sub-route.
      if (isCalendarUrl(f.url)) return true;

      // (c) OCR heuristic — catches unknown calendars / embedded grids.
      //     Only fires for frames that have a chance of being a web page
      //     (URL present), to avoid sweeping in any random text editor
      //     that happens to mention "May 2026" plus a couple of weekdays.
      if (f.url && looksLikeCalendarText(f.text ?? null)) return true;

      return false;
    },
  },
  {
    source: 'email_screen',
    label: 'email',
    match: (f) => {
      const app = (f.app ?? '').toLowerCase();
      if (
        app === 'mail' ||
        app === 'outlook' ||
        app === 'spark' ||
        app === 'airmail' ||
        app === 'superhuman' ||
        app === 'hey'
      ) {
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
  private readonly maxEventsPerResponse: number;
  private readonly contextWindowMs: number;
  private readonly maxContextEventsPerTick: number;
  private readonly visionAttachments: number;
  private readonly dataDir: string;

  constructor(
    private readonly storage: IStorage,
    private readonly model: IModelAdapter,
    logger: Logger,
    opts: EventExtractorOptions = {},
  ) {
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
      meetingsLifted: 0,
      llmExtracted: 0,
      contextEnriched: 0,
      daysScanned: 0,
      bucketsScanned: 0,
      framesScanned: 0,
      modelAvailable: false,
      failed: 0,
    };

    // Phase 1 — deterministic meeting → DayEvent lift.
    try {
      result.meetingsLifted = await this.liftMeetings();
    } catch (err) {
      this.logger.warn('liftMeetings failed (continuing)', { err: String(err) });
    }

    if (!this.llmEnabled) return result;
    const modelOk = await this.model.isAvailable().catch(() => false);
    result.modelAvailable = modelOk;
    if (!modelOk) {
      this.logger.info('skipping LLM passes — model unavailable');
      return result;
    }

    const scanLookback = Math.max(
      1,
      Math.min(opts.lookbackDays ?? this.lookbackDays, 30),
    );
    const sourceFilter = opts.sources?.length
      ? new Set<DayEventSource>(opts.sources)
      : null;

    // Phase 2 — calendar / mail / chat extraction per capture day.
    for (const captureDay of recentDays(scanLookback)) {
      try {
        const stats = await this.extractForCaptureDay(captureDay, sourceFilter);
        result.llmExtracted += stats.extracted;
        result.bucketsScanned += stats.buckets;
        result.framesScanned += stats.frames;
        result.daysScanned += 1;
      } catch (err) {
        result.failed += 1;
        this.logger.warn(`event extraction failed for ${captureDay}`, { err: String(err) });
      }
    }

    if (opts.enrichContexts ?? true) {
      // Phase 3 — context enrichment for non-meeting events that still
      // have a thin context line.
      try {
        result.contextEnriched = await this.enrichContexts();
      } catch (err) {
        this.logger.warn('context enrichment failed (continuing)', { err: String(err) });
      }
    }

    this.logger.info(
      `extractor tick: lifted=${result.meetingsLifted} extracted=${result.llmExtracted} ` +
        `enriched=${result.contextEnriched} buckets=${result.bucketsScanned} ` +
        `frames=${result.framesScanned} days=${result.daysScanned}`,
    );

    return result;
  }

  async drain(): Promise<EventExtractorResult> {
    return await this.tick();
  }

  // -------------------------------------------------------------------------
  // Phase 1: meeting lift.
  // -------------------------------------------------------------------------

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

    // The MeetingBuilder splits a single conceptual meeting into
    // multiple `Meeting` rows when the user's capture pipeline has a
    // gap longer than `idle_threshold_sec` (5 min default). For the
    // event log, the user perceives them as one item — merge here.
    const clusters = clusterMeetings(meetings);

    let liftedNow = 0;
    for (const cluster of clusters) {
      const primary = cluster.primary;
      const id = `evt_mtg_${primary.id}`;
      const existing = await this.storage.getDayEvent(id).catch(() => null);
      const hash = clusterContentHash(cluster);
      if (existing && existing.content_hash === hash) continue;

      const now = new Date().toISOString();
      const mergedAttendees = uniqueStrings(cluster.all.flatMap((m) => m.attendees ?? []));
      const mergedLinks = uniqueStrings(cluster.all.flatMap((m) => m.links ?? []));
      const totalDurationMs = cluster.all.reduce((s, m) => s + m.duration_ms, 0);
      const tldr =
        (primary.summary_json?.tldr ?? '').trim() ||
        deterministicMeetingContext({
          ...primary,
          duration_ms: totalDurationMs,
          attendees: mergedAttendees,
          links: mergedLinks,
        });

      const event: DayEvent = {
        id,
        day: cluster.day,
        starts_at: cluster.startedAt,
        ends_at: cluster.endedAt,
        kind: 'meeting',
        source: 'meeting_capture',
        title:
          (primary.title ?? '').trim() ||
          (primary.summary_json?.title ?? '').trim() ||
          `${platformLabel(primary.platform)} meeting`,
        source_app: platformLabel(primary.platform),
        context_md: tldr || null,
        attendees: mergedAttendees,
        links: mergedLinks,
        meeting_id: primary.id,
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

        // Tombstone the duplicate sibling DayEvents so they vanish from
        // the timeline. We don't ALTER the canonical row id of the
        // primary, but the secondaries collapse into nothing.
        for (const sibling of cluster.all) {
          if (sibling.id === primary.id) continue;
          const siblingEventId = `evt_mtg_${sibling.id}`;
          const tombstone = await this.storage
            .getDayEvent(siblingEventId)
            .catch(() => null);
          if (!tombstone) continue;
          try {
            // The cheapest "soft delete" we have right now is rewriting
            // the row under a content hash that future ticks will see
            // matches, so re-runs never resurrect it; plus marking it
            // as part of the canonical cluster via meeting_id.
            // Storage doesn't yet expose a per-row delete on day_events;
            // dropping content + zero-duration keeps the row hidden
            // by the UI's `eventDuration` heuristic.
            await this.storage.upsertDayEvent({
              ...tombstone,
              starts_at: cluster.startedAt,
              ends_at: cluster.startedAt,
              title: '__merged__',
              context_md: null,
              status: 'ready',
              content_hash: hash,
              updated_at: now,
            });
          } catch {
            /* best effort */
          }
        }
      } catch (err) {
        this.logger.warn(`upsertDayEvent failed for meeting ${primary.id}`, {
          err: String(err),
        });
      }
    }
    return liftedNow;
  }

  // -------------------------------------------------------------------------
  // Phase 2: LLM extraction.
  // -------------------------------------------------------------------------

  private async extractForCaptureDay(
    captureDay: string,
    sourceFilter: Set<DayEventSource> | null,
  ): Promise<{ extracted: number; buckets: number; frames: number }> {
    const frames = await this.storage.getJournal(captureDay).catch(() => [] as Frame[]);
    if (frames.length === 0) return { extracted: 0, buckets: 0, frames: 0 };

    const buckets = this.bucketFrames(frames, sourceFilter);
    if (buckets.length === 0) return { extracted: 0, buckets: 0, frames: 0 };

    let extractedTotal = 0;
    let framesTotal = 0;
    for (const bucket of buckets) {
      framesTotal += bucket.frames.length;
      const extracted = await this.runLlmExtraction(captureDay, bucket);
      extractedTotal += extracted;
    }
    return { extracted: extractedTotal, buckets: buckets.length, frames: framesTotal };
  }

  private bucketFrames(
    frames: Frame[],
    sourceFilter: Set<DayEventSource> | null,
  ): SourceBucket[] {
    const groups = new Map<string, SourceBucket>();
    for (const frame of frames) {
      const matcher = SOURCE_MATCHERS.find((m) => m.match(frame));
      if (!matcher) continue;
      if (sourceFilter && !sourceFilter.has(matcher.source)) continue;
      const text = (frame.text ?? '').trim();
      if (text.length < this.minTextChars) continue;

      const appKey = frame.app ?? matcher.label;
      // Calendars all extract events the same way regardless of which
      // calendar app is open — collapsing them into one bucket gives
      // the LLM more dedupe signal across e.g. Fantastical + Apple
      // Calendar mirroring the same data.
      const groupKey =
        matcher.source === 'calendar_screen'
          ? `${matcher.source}|*`
          : `${matcher.source}|${appKey}`;
      let bucket = groups.get(groupKey);
      if (!bucket) {
        bucket = { source: matcher.source, app: appKey, frames: [] };
        groups.set(groupKey, bucket);
      }
      bucket.frames.push(frame);
    }

    for (const bucket of groups.values()) {
      // Drop near-duplicate frames inside each bucket: identical
      // perceptual hash, or very similar OCR. Cap to a hard max.
      const seen = new Set<string>();
      bucket.frames = bucket.frames
        .filter((f) => {
          const key =
            f.perceptual_hash ??
            `${f.window_title ?? ''}|${(f.text ?? '').slice(0, 200)}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
        .slice(-this.maxFramesPerBucket);
    }
    return Array.from(groups.values())
      .filter((b) => b.frames.length > 0)
      .sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source));
  }

  private async runLlmExtraction(
    captureDay: string,
    bucket: SourceBucket,
  ): Promise<number> {
    const useVision =
      this.visionAttachments > 0 &&
      bucket.source === 'calendar_screen' &&
      this.model.getModelInfo().supportsVision === true;

    const visionImages = useVision
      ? await this.loadVisionImages(bucket)
      : [];

    const prompt = buildExtractionPrompt(
      captureDay,
      bucket,
      this.maxPromptChars,
      visionImages.length > 0,
    );

    let raw = '';
    let parsed: ExtractionPayload | null = null;
    let usedDeterministicFallback = false;
    let canReplaceCalendarView = false;
    try {
      raw =
        visionImages.length > 0
          ? await this.model.completeWithVision(prompt, visionImages, {
              systemPrompt: EXTRACTION_SYSTEM_PROMPT,
              temperature: 0.2,
              maxTokens: 2400,
              responseFormat: 'json',
            })
          : await this.model.complete(prompt, {
              systemPrompt: EXTRACTION_SYSTEM_PROMPT,
              temperature: 0.2,
              maxTokens: 2400,
              responseFormat: 'json',
            });
      parsed = safeParseExtraction(raw);
      canReplaceCalendarView = bucket.source === 'calendar_screen' && parsed !== null;
    } catch (err) {
      this.logger.debug(`llm extraction failed (${bucket.source} ${captureDay})`, {
        err: String(err),
      });
      if (bucket.source === 'calendar_screen') {
        parsed = { events: deterministicCalendarCandidates(captureDay, bucket) };
        usedDeterministicFallback = parsed.events.length > 0;
        canReplaceCalendarView = usedDeterministicFallback;
      } else {
        return 0;
      }
    }

    if (!parsed) {
      this.logger.debug(
        `llm returned unparseable response (${bucket.source} ${captureDay}); ` +
          `preview="${raw.slice(0, 160).replace(/\s+/g, ' ')}"`,
      );
      if (bucket.source === 'calendar_screen') {
        parsed = { events: deterministicCalendarCandidates(captureDay, bucket) };
        usedDeterministicFallback = parsed.events.length > 0;
        canReplaceCalendarView = usedDeterministicFallback;
      }
      if (!parsed) return 0;
    }

    if (bucket.source === 'calendar_screen' && parsed.events.length === 0) {
      const fallback = deterministicCalendarCandidates(captureDay, bucket);
      if (fallback.length > 0) {
        parsed = { events: fallback };
        usedDeterministicFallback = true;
        canReplaceCalendarView = true;
      }
    }

    if (
      bucket.source === 'calendar_screen' &&
      parsed.events.length > 0 &&
      !usedDeterministicFallback
    ) {
      const grounded = parsed.events.filter((candidate) =>
        calendarCandidateIsGrounded(candidate, bucket),
      );
      if (grounded.length !== parsed.events.length) {
        this.logger.debug(
          `dropped ${parsed.events.length - grounded.length} ungrounded calendar candidate(s) for ${captureDay}`,
        );
      }
      if (grounded.length > 0) {
        parsed = { events: grounded };
      } else {
        const fallback = deterministicCalendarCandidates(captureDay, bucket);
        parsed = { events: fallback };
        usedDeterministicFallback = fallback.length > 0;
        canReplaceCalendarView = fallback.length > 0;
      }
    }

    if (bucket.source === 'calendar_screen' && canReplaceCalendarView) {
      await this.replaceVisibleCalendarDays(captureDay, bucket, parsed.events);
    }

    const evidenceIds = bucket.frames.map((f) => f.id);
    const now = new Date().toISOString();
    let count = 0;
    let droppedInvalidDate = 0;

    for (let i = 0; i < parsed.events.length && i < this.maxEventsPerResponse; i++) {
      const candidate = parsed.events[i];
      const title = (candidate?.title ?? '').trim();
      if (!title) continue;

      // Two-step date resolution: prefer a parseable ISO; otherwise try
      // to interpret a time-only string against the capture day; if
      // that fails too, anchor on the capture day at noon. This used to
      // hard-drop without a date, which on local vision-light models
      // meant most events disappeared even when the title was correct.
      const startsAt =
        parseEventTimestamp(candidate?.starts_at) ??
        coerceTimeOnCaptureDay(candidate?.starts_at, captureDay) ??
        defaultStartOnDay(captureDay);

      const eventDay = localDayKey(new Date(startsAt));
      if (!isValidEventDay(eventDay)) {
        droppedInvalidDate += 1;
        continue;
      }

      const endsAt =
        parseEventTimestamp(candidate?.ends_at) ??
        coerceTimeOnCaptureDay(candidate?.ends_at, eventDay);
      const kind = normaliseKind(candidate?.kind);
      const hourBucket = localHourBucket(startsAt);
      const id = deterministicEventId(bucket.source, eventDay, hourBucket, title);

      // Re-use created_at on overwrite so we don't lose the "first seen"
      // timestamp when a later capture pass refreshes the row.
      const existing = await this.storage.getDayEvent(id).catch(() => null);

      const contentHash = sha1(`${eventDay}|${hourBucket}|${title}|${endsAt ?? ''}`);
      if (existing && existing.content_hash === contentHash && existing.context_md) {
        continue;
      }

      const event: DayEvent = {
        id,
        day: eventDay,
        starts_at: startsAt,
        ends_at: endsAt,
        kind,
        source: bucket.source,
        title: title.slice(0, 200),
        source_app: bucket.app,
        context_md: (candidate?.context ?? '').trim().slice(0, 1200) || null,
        attendees: Array.isArray(candidate?.attendees)
          ? candidate.attendees.filter((s): s is string => typeof s === 'string').slice(0, 20)
          : [],
        links: [],
        meeting_id: null,
        evidence_frame_ids: evidenceIds.slice(-10),
        content_hash: contentHash,
        status: 'ready',
        failure_reason: null,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };

      try {
        await this.storage.upsertDayEvent(event);
        count += 1;
      } catch (err) {
        this.logger.debug(`upsertDayEvent failed`, { err: String(err) });
      }
    }

    if (parsed.events.length > 0) {
      this.logger.info(
        `extracted ${count}/${parsed.events.length} events from ${bucket.source} ` +
          `${captureDay} (${bucket.frames.length} frames${useVision ? `, vision×${visionImages.length}` : ''})` +
          (usedDeterministicFallback ? ', deterministic fallback' : '') +
          (droppedInvalidDate > 0 ? ` — dropped ${droppedInvalidDate} invalid-date` : ''),
      );
    }
    return count;
  }

  private async replaceVisibleCalendarDays(
    captureDay: string,
    bucket: SourceBucket,
    candidates: ExtractionCandidate[],
  ): Promise<void> {
    const days = visibleCalendarDays(captureDay, bucket, candidates);
    for (const day of days) {
      try {
        await this.storage.deleteDayEventsBySourceForDay(day, 'calendar_screen');
      } catch (err) {
        this.logger.debug(`failed to replace calendar events for ${day}`, {
          err: String(err),
        });
      }
    }
  }

  /**
   * Load up to `visionAttachments` of the bucket's most recent frames as
   * raw image buffers so the model adapter can see the calendar grid.
   * Falls back gracefully when assets are missing (vacuumed, on a
   * different vacuum tier, …) — vision is a bonus, not a hard
   * requirement.
   */
  private async loadVisionImages(bucket: SourceBucket): Promise<Buffer[]> {
    if (this.visionAttachments <= 0) return [];
    // Most-recent frames first — they're the freshest snapshot of the
    // user's actual calendar state.
    const candidates = bucket.frames
      .filter((f) => f.asset_path)
      .slice(-this.visionAttachments * 2)
      .reverse();
    const out: Buffer[] = [];
    for (const f of candidates) {
      if (out.length >= this.visionAttachments) break;
      const assetPath = f.asset_path;
      if (!assetPath) continue;
      try {
        const buf = await this.readAsset(assetPath);
        if (buf) out.push(buf);
      } catch (err) {
        this.logger.debug(`could not load vision frame ${assetPath}`, {
          err: String(err),
        });
      }
    }
    return out;
  }

  /**
   * Resolve a relative asset path against `dataDir` first, then via
   * storage.readAsset() as a fallback (covers adapters that store
   * assets elsewhere, e.g. an alternative storage root).
   */
  private async readAsset(assetPath: string): Promise<Buffer | null> {
    if (path.isAbsolute(assetPath)) {
      try {
        return await fs.readFile(assetPath);
      } catch {
        return null;
      }
    }
    if (this.dataDir) {
      try {
        return await fs.readFile(path.join(this.dataDir, assetPath));
      } catch {
        /* fall through */
      }
    }
    try {
      return await this.storage.readAsset(assetPath);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Phase 3: context enrichment.
  // -------------------------------------------------------------------------

  private async enrichContexts(): Promise<number> {
    // Walk the last N days and pick non-meeting events whose context
    // line is missing or too short to be useful. Meeting events are
    // skipped — they already have the Meeting summary downstream.
    const cutoffFrom = new Date(
      Date.now() - this.lookbackDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    let events: DayEvent[] = [];
    try {
      events = await this.storage.listDayEvents({
        from: cutoffFrom,
        order: 'recent',
        limit: 500,
      });
    } catch {
      return 0;
    }

    const candidates = events
      .filter((ev) => ev.kind !== 'meeting')
      .filter((ev) => !ev.context_md || ev.context_md.length < 40)
      .slice(0, this.maxContextEventsPerTick);

    let enriched = 0;
    for (const event of candidates) {
      try {
        const ok = await this.enrichOne(event);
        if (ok) enriched += 1;
      } catch (err) {
        this.logger.debug(`enrichOne failed for ${event.id}`, { err: String(err) });
      }
    }
    return enriched;
  }

  private async enrichOne(event: DayEvent): Promise<boolean> {
    const start = Date.parse(event.starts_at);
    if (Number.isNaN(start)) return false;
    const from = new Date(start - this.contextWindowMs).toISOString();
    const to = new Date(start + this.contextWindowMs).toISOString();

    let frames: Frame[] = [];
    try {
      frames = await this.storage.searchFrames({ from, to, limit: 80 });
    } catch {
      return false;
    }

    // Only feed in frames that look unrelated to the calendar/inbox
    // surfaces the event was already extracted from — otherwise we'd
    // be re-reading the same OCR that produced the event.
    const contextFrames = frames
      .filter((f) => !SOURCE_MATCHERS.some((m) => m.match(f)))
      .filter((f) => (f.text ?? '').trim().length >= 40);

    if (contextFrames.length === 0) return false;

    // Pick a small, diverse set: one per app, in chronological order.
    const byApp = new Map<string, Frame>();
    for (const f of contextFrames) {
      const key = f.app ?? 'unknown';
      if (!byApp.has(key)) byApp.set(key, f);
    }
    const picks = Array.from(byApp.values())
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .slice(0, 6);

    const prompt = buildContextPrompt(event, picks);
    let raw: string;
    try {
      raw = await this.model.complete(prompt, {
        systemPrompt: CONTEXT_SYSTEM_PROMPT,
        temperature: 0.2,
        maxTokens: 240,
      });
    } catch {
      return false;
    }

    const cleaned = (raw ?? '').trim().slice(0, 800);
    if (!cleaned) return false;
    if (/^no related context found$/i.test(cleaned)) return false;

    const now = new Date().toISOString();
    const merged = mergeContext(event.context_md, cleaned);
    const next: DayEvent = {
      ...event,
      context_md: merged,
      evidence_frame_ids: Array.from(
        new Set([...event.evidence_frame_ids, ...picks.map((p) => p.id)]),
      ).slice(-12),
      // Bump hash so future ticks see "yes, already enriched".
      content_hash: sha1(`${event.content_hash}|enriched|${cleaned.length}`),
      updated_at: now,
    };
    try {
      await this.storage.upsertDayEvent(next);
      return true;
    } catch (err) {
      this.logger.debug(`enrich upsert failed for ${event.id}`, { err: String(err) });
      return false;
    }
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
    days.push(localDayKey(d));
  }
  return days;
}

function localDayKey(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// The MeetingBuilder defaults split a meeting if there's >5min of
// capture gap. We treat anything within 30 min of the previous segment
// — same entity_path, same title — as the same conceptual meeting.
const MEETING_MERGE_GAP_MS = 30 * 60_000;

interface MeetingCluster {
  primary: Meeting;
  all: Meeting[];
  startedAt: string;
  endedAt: string;
  day: string;
}

function clusterMeetings(meetings: Meeting[]): MeetingCluster[] {
  const sorted = meetings
    .slice()
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  const buckets = new Map<string, MeetingCluster>();
  for (const m of sorted) {
    const key = `${m.day}|${m.entity_path}|${normaliseMeetingTitle(m)}`;
    const existing = buckets.get(key);
    if (existing && Date.parse(m.started_at) - Date.parse(existing.endedAt) <= MEETING_MERGE_GAP_MS) {
      existing.all.push(m);
      existing.endedAt = maxIso(existing.endedAt, m.ended_at);
      // Promote the richer one as primary so summary/title/etc. survive.
      if (meetingRichnessRank(m) > meetingRichnessRank(existing.primary)) {
        existing.primary = m;
      }
      continue;
    }
    buckets.set(key, {
      primary: m,
      all: [m],
      startedAt: m.started_at,
      endedAt: m.ended_at,
      day: m.day,
    });
  }
  return Array.from(buckets.values());
}

function normaliseMeetingTitle(m: Meeting): string {
  const t = (m.title ?? m.summary_json?.title ?? '').toLowerCase();
  return t.replace(/[^a-z0-9]+/g, ' ').trim();
}

function meetingRichnessRank(m: Meeting): number {
  let score = 0;
  if (m.summary_status === 'ready') score += 100;
  else if (m.summary_status === 'running') score += 50;
  else if (m.summary_status === 'pending') score += 10;
  score += Math.min(40, Math.floor(m.duration_ms / 60_000));
  score += Math.min(20, m.transcript_chars / 200);
  score += Math.min(10, m.attendees.length * 2);
  return score;
}

function maxIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function clusterContentHash(cluster: MeetingCluster): string {
  const parts = cluster.all.flatMap((m) => [
    m.id,
    m.title ?? '',
    m.summary_json?.title ?? '',
    m.summary_json?.tldr ?? '',
    m.started_at,
    m.ended_at,
    m.duration_ms,
    m.summary_status,
    m.content_hash,
  ]);
  return sha1(parts.join('|')).slice(0, 16);
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
  return sha1(parts).slice(0, 16);
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

function deterministicEventId(
  source: DayEventSource,
  eventDay: string,
  hourBucket: string,
  title: string,
): string {
  const tag = sha1(
    [source, eventDay, hourBucket, normaliseTitleForKey(title)].join('|'),
  ).slice(0, 12);
  return `evt_${source.split('_')[0]}_${eventDay.replace(/-/g, '')}_${tag}`;
}

function sourcePriority(source: DayEventSource): number {
  switch (source) {
    case 'calendar_screen':
      return 0;
    case 'meeting_capture':
      return 1;
    case 'email_screen':
      return 2;
    case 'slack_screen':
      return 3;
    case 'task_screen':
      return 4;
    default:
      return 9;
  }
}

function normaliseTitleForKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '');
}

function buildExtractionPrompt(
  captureDay: string,
  bucket: SourceBucket,
  maxChars: number,
  vision: boolean,
): string {
  const sourceHint = (() => {
    switch (bucket.source) {
      case 'calendar_screen':
        return [
          `These captures come from the user's calendar app (${bucket.app}).`,
          vision
            ? 'Use the attached screenshots as the primary signal — look at the layout, identify the view (day / week / multi-day / month / agenda / year), find the dates being displayed, and read every event off the surface.'
            : 'The OCR text scrambles the layout, so reconstruct events conservatively. Any dates you can recover from the text (month headers, day labels, "Today" markers, inline date dividers) anchor the events.',
          'Date each event using whatever the screen tells you about the period it covers, including past and future days; if the layout is implicit, fall back to the user-local capture day.',
        ].join(' ');
      case 'email_screen':
        return 'These screenshots are from the user’s email app. Surface meaningful threads — messages the user is actually reading or writing — as kind="communication" events. Skip generic inbox lists.';
      case 'slack_screen':
        return 'These screenshots are from a chat app (Slack / Discord). Surface notable conversations or threads as kind="communication" events. Skip channel-list chrome.';
      case 'task_screen':
        return 'These screenshots are from a task tracker (Linear / Jira / GitHub / Notion). Surface tickets the user appears to be working on as kind="task" events.';
      default:
        return '';
    }
  })();

  const header = [
    `Day the screenshots were captured on (user's local timezone): ${captureDay}`,
    `Source app: ${bucket.app}`,
    `Surface: ${bucket.source}`,
    '',
    sourceHint,
    '',
    vision
      ? 'OCR text from those screenshots is also included below for cross-reference. Trust the image first.'
      : 'Captured frames (oldest first):',
  ].join('\n');

  const blocks: string[] = [];
  let used = header.length;
  for (const frame of bucket.frames) {
    const text = (frame.text ?? '').trim();
    if (!text) continue;
    const block = `\n[FRAME ${frame.id} @ ${frame.timestamp}] title="${frame.window_title ?? ''}" url="${frame.url ?? ''}"\n${text.slice(0, 2200)}\n`;
    if (used + block.length > maxChars) break;
    blocks.push(block);
    used += block.length;
  }

  return `${header}${blocks.join('')}\n\nExtract every meaningful event you can see. Remember: STRICT JSON only.`;
}

function buildContextPrompt(event: DayEvent, frames: Frame[]): string {
  const blocks: string[] = [];
  for (const frame of frames) {
    const text = (frame.text ?? '').trim();
    if (!text) continue;
    blocks.push(
      `\n[${frame.app ?? 'unknown'} @ ${frame.timestamp}] "${frame.window_title ?? ''}"\n${text.slice(0, 900)}\n`,
    );
  }
  return [
    `Event: ${event.title}`,
    `Scheduled at: ${event.starts_at}${event.ends_at ? ` – ${event.ends_at}` : ''}`,
    `Source: ${event.source_app ?? event.source}`,
    '',
    'Screen captures from around that time (other apps the user was on):',
    blocks.join(''),
    '',
    'Write a 1-3 sentence English context based STRICTLY on what those captures show. If nothing in the captures is related to this event, output exactly: no related context found',
  ].join('\n');
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
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as ExtractionPayload | ExtractionCandidate[];
      if (Array.isArray(parsed)) return { events: parsed };
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

/**
 * The model often emits a time-only string ("10:30", "2 PM") when the
 * date is implicit from the screenshot context. Glue it onto the given
 * day so the event still lands somewhere useful instead of being
 * dropped. Returns null when even the time portion is unparseable.
 */
function coerceTimeOnCaptureDay(
  raw: string | null | undefined,
  day: string,
): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const m = s.match(/^(\d{1,2})[:.]?(\d{2})?\s*(am|pm)?$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const synth = new Date(`${day}T${pad2(hour)}:${pad2(minute)}:00`);
  return Number.isNaN(synth.getTime()) ? null : synth.toISOString();
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function deterministicCalendarCandidates(
  captureDay: string,
  bucket: SourceBucket,
): ExtractionCandidate[] {
  const out: ExtractionCandidate[] = [];
  const seen = new Set<string>();
  const frames = bucket.frames
    .slice()
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  for (const frame of frames) {
    if (out.length >= 25) break;
    const text = (frame.text ?? '').trim();
    if (!text) continue;
    // App-name calendar matches can occasionally carry stale AX/OCR text
    // from another foreground app. Require the text itself to look like
    // a calendar grid before applying this fallback.
    if (!looksLikeCalendarText(text)) continue;

    for (const candidate of structuredCalendarCandidatesFromText(text, frame)) {
      const startsAt = parseEventTimestamp(candidate.starts_at);
      if (!startsAt) continue;
      const eventDay = localDayKey(new Date(startsAt));
      const key = `${eventDay}|${localHourBucket(startsAt)}|${normaliseTitleForKey(candidate.title ?? '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
      if (out.length >= 25) break;
    }
  }
  if (out.length > 0) return out;

  for (const frame of frames) {
    if (out.length >= 25) break;
    const text = (frame.text ?? '').trim();
    if (!text || !looksLikeCalendarText(text)) continue;

    const lines = text
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    let currentHour: { hour: number; minute: number } | null = null;
    let minuteOffset = 0;
    let inAllDay = false;

    for (const line of lines) {
      if (/^all[-\s]?day$/i.test(line)) {
        inAllDay = true;
        currentHour = null;
        minuteOffset = 0;
        continue;
      }

      const time = parseCalendarTimeLabel(line);
      if (time) {
        currentHour = time;
        minuteOffset = 0;
        inAllDay = false;
        continue;
      }

      const title = cleanCalendarFallbackTitle(line);
      if (!title) continue;

      const startsAt = inAllDay
        ? defaultStartOnDay(captureDay)
        : currentHour
          ? coerceTimeOnCaptureDay(
              `${pad2(currentHour.hour)}:${pad2(Math.min(55, currentHour.minute + minuteOffset))}`,
              captureDay,
            )
          : null;
      if (!startsAt) continue;

      const eventDay = localDayKey(new Date(startsAt));
      const key = `${eventDay}|${localHourBucket(startsAt)}|${normaliseTitleForKey(title)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const startMs = Date.parse(startsAt);
      const endsAt = Number.isNaN(startMs)
        ? null
        : new Date(startMs + (inAllDay ? 24 * 60 : 30) * 60_000).toISOString();
      out.push({
        title,
        kind: 'calendar',
        starts_at: startsAt,
        ends_at: endsAt,
        attendees: [],
        context: `Visible in ${frame.app || 'calendar'} screenshot OCR.`,
      });
      if (!inAllDay) minuteOffset += 15;
      if (out.length >= 25) break;
    }
  }

  return out;
}

function visibleCalendarDays(
  captureDay: string,
  bucket: SourceBucket,
  candidates: ExtractionCandidate[],
): Set<string> {
  const days = new Set<string>();

  for (const candidate of candidates) {
    const startsAt =
      parseEventTimestamp(candidate.starts_at) ??
      coerceTimeOnCaptureDay(candidate.starts_at, captureDay);
    if (!startsAt) continue;
    const day = localDayKey(new Date(startsAt));
    if (isValidEventDay(day)) days.add(day);
  }

  let sawCalendarText = false;
  for (const frame of bucket.frames) {
    const text = (frame.text ?? '').trim();
    if (!looksLikeCalendarText(text)) continue;
    sawCalendarText = true;
    for (const day of calendarVisibleDaysFromText(text)) {
      days.add(day);
    }
  }

  if (days.size === 0 && sawCalendarText && isValidEventDay(captureDay)) {
    days.add(captureDay);
  }

  return days;
}

function calendarVisibleDaysFromText(text: string): Set<string> {
  const days = new Set<string>();
  const fullDateRe = new RegExp(FULL_ENGLISH_DATE_RE.source, 'gi');
  let dateMatch: RegExpExecArray | null;
  while ((dateMatch = fullDateRe.exec(text))) {
    const day = parseEnglishDateDay(dateMatch[0]);
    if (day) days.add(day);
  }

  const monthYear = parseCalendarMonthYear(text);
  if (!monthYear) return days;

  for (const day of calendarWeekdayLabelDays(text, monthYear.year, monthYear.monthIndex)) {
    days.add(day);
  }

  return days;
}

function parseCalendarMonthYear(
  text: string,
): { monthIndex: number; year: number } | null {
  const m = MONTH_YEAR_RE.exec(text);
  if (!m?.groups) return null;
  const monthIndex = monthIndexFromName(m.groups.month);
  const year = Number(m.groups.year);
  if (monthIndex === null || !Number.isInteger(year) || year < 1000 || year > 9999) {
    return null;
  }
  return { monthIndex, year };
}

type WeekdayLabel = {
  index: number;
  weekday: number;
  dayNumber: number | null;
};

function calendarWeekdayLabelDays(
  text: string,
  year: number,
  monthIndex: number,
): Set<string> {
  const days = new Set<string>();
  const labels = collectWeekdayLabels(text);
  const headerLabels = calendarHeaderWeekdayLabels(labels);
  const numbered = headerLabels.filter(
    (label): label is WeekdayLabel & { dayNumber: number } =>
      label.dayNumber !== null,
  );

  for (const label of numbered) {
    const day = localDayFromCalendarParts(year, monthIndex, label.dayNumber, true);
    if (day) days.add(day);
  }

  for (const label of headerLabels) {
    if (label.dayNumber !== null || numbered.length === 0) continue;
    const nearest = numbered
      .slice()
      .sort((a, b) => Math.abs(a.index - label.index) - Math.abs(b.index - label.index))[0];
    if (!nearest) continue;
    let offset = label.weekday - nearest.weekday;
    if (label.index > nearest.index && offset < 0) offset += 7;
    if (label.index < nearest.index && offset > 0) offset -= 7;
    const day = localDayFromCalendarParts(
      year,
      monthIndex,
      nearest.dayNumber + offset,
      false,
    );
    if (day) days.add(day);
  }

  return days;
}

function collectWeekdayLabels(text: string): WeekdayLabel[] {
  const labels: WeekdayLabel[] = [];
  const weekdayRe = new RegExp(WEEKDAY_LABEL_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = weekdayRe.exec(text))) {
    const groups = m.groups ?? {};
    const weekday = weekdayIndexFromName(groups.weekday ?? '');
    if (weekday === null) continue;
    const dayNumber = groups.day ? Number(groups.day) : null;
    labels.push({
      index: m.index,
      weekday,
      dayNumber:
        dayNumber !== null && Number.isInteger(dayNumber) && dayNumber >= 1 && dayNumber <= 31
          ? dayNumber
          : null,
    });
    if (labels.length >= 40) break;
  }
  return labels;
}

function calendarHeaderWeekdayLabels(labels: WeekdayLabel[]): WeekdayLabel[] {
  if (labels.length < 3) {
    return labels.filter((label) => label.dayNumber !== null).slice(0, 7);
  }

  for (let i = 0; i <= labels.length - 3; i++) {
    if (labels[i + 2].index - labels[i].index > 160) continue;
    const cluster: WeekdayLabel[] = [labels[i], labels[i + 1], labels[i + 2]];
    for (let j = i + 3; j < labels.length && cluster.length < 7; j++) {
      const previous = cluster[cluster.length - 1];
      if (labels[j].index - previous.index > 80) break;
      cluster.push(labels[j]);
    }
    return cluster;
  }

  return labels.filter((label) => label.dayNumber !== null).slice(0, 7);
}

function localDayFromCalendarParts(
  year: number,
  monthIndex: number,
  dayNumber: number,
  requireSameMonth: boolean,
): string | null {
  const d = new Date(year, monthIndex, dayNumber, 12, 0, 0);
  if (Number.isNaN(d.getTime())) return null;
  if (requireSameMonth && d.getMonth() !== monthIndex) return null;
  const day = localDayKey(d);
  return isValidEventDay(day) ? day : null;
}

function structuredCalendarCandidatesFromText(
  text: string,
  frame: Frame,
): ExtractionCandidate[] {
  const out: ExtractionCandidate[] = [];
  const timed =
    /(?<title>[A-Za-z0-9][^.\n]{2,140}?)\.\s*Starts on (?<startDate>[A-Za-z]+ \d{1,2}, \d{4}) at (?<startTime>\d{1,2}(?::\d{2})?\s*(?:AM|PM)) and ends (?:on (?<endDate>[A-Za-z]+ \d{1,2}, \d{4}) at |at )(?<endTime>\d{1,2}(?::\d{2})?\s*(?:AM|PM))/gi;
  let m: RegExpExecArray | null;
  while ((m = timed.exec(text)) && out.length < 25) {
    const groups = m.groups ?? {};
    const title = cleanCalendarFallbackTitle(groups.title ?? '');
    if (!title) continue;
    const startsAt = parseEnglishDateTime(groups.startDate, groups.startTime);
    const endsAt = parseEnglishDateTime(groups.endDate || groups.startDate, groups.endTime);
    if (!startsAt) continue;
    out.push({
      title,
      kind: 'calendar',
      starts_at: startsAt,
      ends_at: endsAt,
      attendees: [],
      context: `Visible in ${frame.app || 'calendar'} accessibility text.`,
    });
  }

  const allDay =
    /(?<title>[A-Za-z0-9][^.\n]{2,140}?)\.\s*(?<date>[A-Za-z]+ \d{1,2}, \d{4}),\s*All-Day/gi;
  while ((m = allDay.exec(text)) && out.length < 25) {
    const groups = m.groups ?? {};
    const title = cleanCalendarFallbackTitle(groups.title ?? '');
    if (!title) continue;
    const startsAt = parseEnglishDateTime(groups.date, '12:00 AM');
    if (!startsAt) continue;
    const startMs = Date.parse(startsAt);
    out.push({
      title,
      kind: 'calendar',
      starts_at: startsAt,
      ends_at: Number.isNaN(startMs)
        ? null
        : new Date(startMs + 24 * 60 * 60_000).toISOString(),
      attendees: [],
      context: `Visible in ${frame.app || 'calendar'} accessibility text.`,
    });
  }

  return out;
}

function parseEnglishDateTime(
  date: string | undefined,
  time: string | undefined,
): string | null {
  if (!date || !time) return null;
  const parsed = Date.parse(`${date} ${time}`);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function parseEnglishDateDay(date: string | undefined): string | null {
  if (!date) return null;
  const parsed = Date.parse(`${date} 12:00 PM`);
  if (Number.isNaN(parsed)) return null;
  const day = localDayKey(new Date(parsed));
  return isValidEventDay(day) ? day : null;
}

function monthIndexFromName(raw: string): number | null {
  switch (raw.trim().toLowerCase().slice(0, 3)) {
    case 'jan':
      return 0;
    case 'feb':
      return 1;
    case 'mar':
      return 2;
    case 'apr':
      return 3;
    case 'may':
      return 4;
    case 'jun':
      return 5;
    case 'jul':
      return 6;
    case 'aug':
      return 7;
    case 'sep':
      return 8;
    case 'oct':
      return 9;
    case 'nov':
      return 10;
    case 'dec':
      return 11;
    default:
      return null;
  }
}

function weekdayIndexFromName(raw: string): number | null {
  switch (raw.trim().toLowerCase().slice(0, 3)) {
    case 'sun':
      return 0;
    case 'mon':
      return 1;
    case 'tue':
      return 2;
    case 'wed':
      return 3;
    case 'thu':
      return 4;
    case 'fri':
      return 5;
    case 'sat':
      return 6;
    default:
      return null;
  }
}

function calendarCandidateIsGrounded(
  candidate: ExtractionCandidate,
  bucket: SourceBucket,
): boolean {
  const title = (candidate.title ?? '').trim();
  if (!title) return false;
  const titleNorm = normaliseForGrounding(title);
  if (titleNorm.length < 3) return false;

  const evidence = normaliseForGrounding(
    bucket.frames
      .filter((frame) => looksLikeCalendarText(frame.text ?? null))
      .map((frame) => frame.text ?? '')
      .join('\n'),
  );
  if (!evidence) return false;
  if (evidence.includes(titleNorm)) return true;

  const tokens = titleNorm
    .split(' ')
    .filter((token) => token.length >= 3 && !GROUNDING_STOPWORDS.has(token));
  if (tokens.length < 2) return false;
  const hits = tokens.filter((token) => evidence.includes(token)).length;
  return hits >= Math.max(2, Math.ceil(tokens.length * 0.65));
}

const GROUNDING_STOPWORDS = new Set([
  'and',
  'the',
  'with',
  'for',
  'from',
  'meeting',
  'sync',
  'call',
]);

function normaliseForGrounding(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCalendarTimeLabel(line: string): { hour: number; minute: number } | null {
  const m = line.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]!.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function cleanCalendarFallbackTitle(line: string): string | null {
  const s = line
    .replace(/^[•*·\-\u2022]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length < 3 || s.length > 120) return null;
  if (/^(calendar|file|edit|view|window|help|today|week|month|day|inbox)$/i.test(s)) return null;
  if (/^(sun|mon|tue|wed|thu|fri|sat)(?:day)?$/i.test(s)) return null;
  if (/^(meeting|join|notes?|add|search|settings)$/i.test(s)) return null;
  if (/^(?:\/\s*)?(?:AM|PM)$/i.test(s)) return null;
  if (/^\d{1,2}(?::\d{2})?\s*(?:AM|PM)$/i.test(s)) return null;
  if (/^https?:\/\//i.test(s) || /\b(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com)\b/i.test(s)) return null;
  if (/^[+<>()[\]{}|/\\]+$/.test(s)) return null;
  return s;
}

function defaultStartOnDay(day: string): string {
  return coerceTimeOnCaptureDay('12:00', day) ?? `${day}T12:00:00.000Z`;
}

function localHourBucket(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '00';
  return pad2(d.getHours());
}

function parseEventTimestamp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const parsed = Date.parse(s);
  if (Number.isNaN(parsed)) return null;
  const d = new Date(parsed);
  const year = d.getFullYear();
  // Accept any ordinary calendar date, regardless of whether it is in
  // the past, today, or the future. This only rejects impossible /
  // wildly malformed model output.
  if (year < 1000 || year > 9999) return null;
  return d.toISOString();
}

function isValidEventDay(day: string): boolean {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = Number(m[1]);
  if (year < 1000 || year > 9999) return false;
  const d = new Date(`${day}T12:00:00`);
  return !Number.isNaN(d.getTime()) && localDayKey(d) === day;
}

function mergeContext(existing: string | null, addition: string): string {
  const a = (existing ?? '').trim();
  const b = addition.trim();
  if (!a) return b;
  if (a.toLowerCase().includes(b.toLowerCase())) return a;
  return `${a}\n\n${b}`.slice(0, 1500);
}

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}
