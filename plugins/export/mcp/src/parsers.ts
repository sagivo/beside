import type { Frame } from '@beside/interfaces';

// ---------------------------------------------------------------------------
// Shared classification: what's a calendar / chat / code-review frame?
// ---------------------------------------------------------------------------

const CALENDAR_HOSTS = new Set([
  'calendar.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'cal.com',
  'fantastical.app',
  'app.fantastical.app',
  'meet.google.com',
  'teams.microsoft.com',
]);

const CALENDAR_APPS = new Set([
  'calendar',
  'google calendar',
  'fantastical',
  'fantastical 3',
  'fantastical 2',
  'busycal',
  'outlook',
  'microsoft outlook',
]);

const CHAT_HOSTS = new Set([
  'app.slack.com',
  'slack.com',
  'discord.com',
  'app.discord.com',
  'web.telegram.org',
  'teams.microsoft.com',
]);

const CHAT_APPS = new Set([
  'slack',
  'discord',
  'telegram',
  'imessage',
  'messages',
  'whatsapp',
  'microsoft teams',
  'teams',
]);

const CODE_REVIEW_HOSTS = new Set([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
]);

/**
 * Apps + entity paths that represent the Beside dashboard itself.
 * Frames captured *of* Beside rarely add signal to a user's
 * memory query — instead they pollute results because the sidebar
 * shows page titles like "Conversion tracking health" that match
 * almost any prompt. Helpers in this module use these to filter out
 * "self" frames by default.
 */
export const BESIDE_SELF_APP_NAMES = new Set([
  'beside',
  'beside-desktop',
  'beside-dev',
  'electron',
]);

export const BESIDE_SELF_ENTITY_PATHS = new Set([
  'apps/beside',
  'apps/electron',
]);

export function isSelfFrame(frame: Frame): boolean {
  if (frame.entity_path && BESIDE_SELF_ENTITY_PATHS.has(frame.entity_path)) {
    return true;
  }
  const app = (frame.app ?? '').trim().toLowerCase();
  if (app && BESIDE_SELF_APP_NAMES.has(app)) return true;
  const bundle = (frame.app_bundle_id ?? '').toLowerCase();
  if (bundle.includes('beside')) return true;
  return false;
}

export function urlHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function classifyFrame(frame: Frame): 'calendar' | 'chat' | 'code-review' | null {
  const host = urlHost(frame.url);
  const app = (frame.app ?? '').toLowerCase();
  const title = (frame.window_title ?? '').toLowerCase();
  if (host && CALENDAR_HOSTS.has(host)) return 'calendar';
  if (CALENDAR_APPS.has(app)) return 'calendar';
  if (/\bgoogle calendar\b|\bfantastical\b|\bcalendar\b — /i.test(title)) return 'calendar';
  if (host && CHAT_HOSTS.has(host)) return 'chat';
  if (CHAT_APPS.has(app)) return 'chat';
  if (host && CODE_REVIEW_HOSTS.has(host)) return 'code-review';
  return null;
}

// ---------------------------------------------------------------------------
// Calendar event extraction
// ---------------------------------------------------------------------------

const TIME_RANGE_RE =
  /\b(?<start>\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[–\-—to]+\s*(?<end>\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i;
const SINGLE_TIME_RE = /\b(?<start>\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i;

const CALENDAR_NOISE_LINES = new Set([
  'today',
  'tomorrow',
  'yesterday',
  'now',
  'noon',
  'midnight',
  'morning',
  'afternoon',
  'evening',
  'all day',
  'busy',
  'free',
  'tentative',
  'event',
  'events',
  'no events',
  'no event',
  'no events scheduled',
  'add title',
  'create',
  'search',
  'settings',
  'create event',
  'more',
  'options',
  'day',
  'week',
  'month',
  'year',
  'agenda',
]);

export interface ExtractedCalendarEvent {
  /** Approximate raw time label as it appeared on screen, e.g. "9:00 AM – 10:00 AM". */
  time_label: string | null;
  /** Title text we believe belongs to the event. */
  title: string;
  /** ISO timestamp of the *frame* the event was extracted from (not the event time). */
  observed_at: string;
  /** Frame the candidate was extracted from. */
  source_frame_id: string;
  /** App or URL host the frame came from. */
  source: string;
}

/**
 * Find candidate calendar events in a single frame's OCR/accessibility
 * text. We deliberately stay heuristic: real calendar UIs use spatial
 * layout that survives flatly-extracted text only when an event has a
 * time label adjacent to a title-like line. A pair like
 *
 *   9:00 – 10:00 AM
 *   Standup with Maya
 *
 * (or the reverse order) is the strongest signal we can extract
 * cheaply. Bare time strings without a title fall through.
 */
export function extractCalendarEventsFromFrame(frame: Frame): ExtractedCalendarEvent[] {
  if (!frame.text) return [];
  const lines = frame.text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const out: ExtractedCalendarEvent[] = [];
  const seenTitles = new Set<string>();
  const source = frame.app || urlHost(frame.url) || 'calendar';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const rangeMatch = line.match(TIME_RANGE_RE);
    const singleMatch = !rangeMatch ? line.match(SINGLE_TIME_RE) : null;
    const timeMatch = rangeMatch ?? singleMatch;
    if (!timeMatch) continue;

    const timeLabel = timeMatch[0].trim();
    // Strip the time portion; what's left on the line might be the title.
    const remainder = sanitiseCalendarTitle(line.replace(timeMatch[0], ''));
    let title = remainder;

    if (!isLikelyCalendarTitle(title)) {
      // Look at neighbouring lines for the title.
      const before = i > 0 ? sanitiseCalendarTitle(lines[i - 1]!) : '';
      const after = i + 1 < lines.length ? sanitiseCalendarTitle(lines[i + 1]!) : '';
      title = pickBestNeighbour(title, before, after);
    }

    title = title.replace(/\s+/g, ' ').trim();
    if (!isLikelyCalendarTitle(title)) continue;
    const titleKey = title.toLowerCase();
    if (seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);

    out.push({
      time_label: timeLabel,
      title,
      observed_at: frame.timestamp,
      source_frame_id: frame.id,
      source,
    });
  }

  return out;
}

/**
 * Strip leading OCR cruft that real calendar UIs never start with —
 * bullet glyphs, copyright symbols, lone digits glued to brackets,
 * trailing dashes / pipes, etc. Designed to be aggressive on prefixes
 * because Google Calendar's "10:00 — 11:00 AM" layout often OCRs as
 * `© 11:30AM ~ 12:45PM` when icons sit in the gutter.
 */
function sanitiseCalendarTitle(raw: string): string {
  let s = raw;
  // Drop leading symbol/bullet runs (©, ®, •, *, -, :, |, ·, ~, ", ', ™, °, etc.)
  s = s.replace(/^[\s©®™°•*\-:|·~"'`^_+=<>!?@#$%&(){}[\]/\\,;.]+/, '');
  // Drop a leading lone digit-or-letter followed by a bracket/symbol
  // (e.g. "1[Zoom Interview..." → "Zoom Interview...").
  s = s.replace(/^([0-9oOlI]\s*[\[\]|·:,.\-_])\s*/, '');
  // Drop a leading single digit + whitespace when the rest looks like
  // a bare URL or a single short token, so OCR artefacts like
  // "0 meet.google.com" don't surface as event titles.
  s = s.replace(/^[0-9oOlI]\s+(?=https?:\/\/|[a-z0-9.-]+\.[a-z]{2,}\b)/i, '');
  // Trim trailing OCR cruft: ellipses, brackets, dashes, dangling
  // punctuation. Keeps the title on the descriptive substring.
  s = s.replace(/[\s.…\-_|·:,;\]\)]+$/, '');
  return s.trim();
}

function pickBestNeighbour(
  current: string,
  before: string,
  after: string,
): string {
  const candidates = [current, after, before];
  for (const c of candidates) {
    if (isLikelyCalendarTitle(c)) return c;
  }
  return current || after || before;
}

function isLikelyCalendarTitle(line: string | null | undefined): boolean {
  if (!line) return false;
  const trimmed = line.trim();
  if (trimmed.length < 4) return false;
  if (trimmed.length > 120) return false;
  if (CALENDAR_NOISE_LINES.has(trimmed.toLowerCase())) return false;
  if (TIME_RANGE_RE.test(trimmed)) return false;
  if (SINGLE_TIME_RE.test(trimmed) && trimmed.length < 14) return false;
  if (/^\d{1,2}(:\d{2})?\s*(am|pm)?$/i.test(trimmed)) return false;
  if (/^[\d\W_]+$/.test(trimmed)) return false;
  if (/^(mon|tue|wed|thu|fri|sat|sun)\b/i.test(trimmed) && trimmed.length < 18) return false;
  // Reject anything that's overwhelmingly symbols / punctuation —
  // real meeting titles have alphabetic words.
  const alpha = (trimmed.match(/[a-z]/gi) ?? []).length;
  if (alpha < 3) return false;
  if (alpha / trimmed.length < 0.4) return false;
  // Reject bare URLs (no descriptive text alongside).
  if (/^https?:\/\//i.test(trimmed)) return false;
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(trimmed)) return false;
  return true;
}

/**
 * Fold per-frame candidates into one canonical list per (time_label, title)
 * pair, keeping the earliest observation as the witness frame. Works
 * across many frames in the same day so a recurring meeting that
 * appears in 30 calendar screenshots only emerges once.
 */
export function dedupeCalendarEvents(
  events: ExtractedCalendarEvent[],
): ExtractedCalendarEvent[] {
  const byKey = new Map<string, ExtractedCalendarEvent>();
  for (const event of events) {
    const key = `${event.time_label ?? ''}|${event.title.toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev || event.observed_at < prev.observed_at) {
      byKey.set(key, event);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const at = parseTimeLabelMinutes(a.time_label);
    const bt = parseTimeLabelMinutes(b.time_label);
    if (at !== null && bt !== null && at !== bt) return at - bt;
    return a.observed_at.localeCompare(b.observed_at);
  });
}

function parseTimeLabelMinutes(label: string | null): number | null {
  if (!label) return null;
  const m = label.match(SINGLE_TIME_RE);
  if (!m) return null;
  const raw = m.groups?.start ?? m[0];
  const ampm = raw.match(/(am|pm)$/i)?.[1]?.toLowerCase();
  const hm = raw.replace(/\s*(am|pm)$/i, '');
  const [hStr, mStr = '0'] = hm.split(':');
  let h = parseInt(hStr ?? '0', 10);
  const min = parseInt(mStr, 10);
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return h * 60 + min;
}

// ---------------------------------------------------------------------------
// Chat / Slack extraction
// ---------------------------------------------------------------------------

export interface ExtractedChatSnippet {
  channel: string | null;
  thread_marker: string | null;
  /** Truncated representative text we suspect is the latest unread message. */
  message: string;
  /** Lower-cased mentions parsed from the text — `@me`, `@maya`, etc. */
  mentions: string[];
  /** True if the visible text ends with an unanswered question. */
  looks_unanswered: boolean;
  observed_at: string;
  source_frame_id: string;
  source_app: string;
}

const SLACK_CHANNEL_RE = /(^|\s)#([a-z0-9][a-z0-9_\-]{1,79})\b/i;
const SLACK_DM_RE = /\b(dms?|direct messages?)\b/i;
const SLACK_THREAD_RE = /\b(\d+)\s+repl(?:y|ies)\b/i;
const MENTION_RE = /@([a-z0-9][a-z0-9_\-.]{1,39})\b/gi;
const QUESTION_PATTERNS = [
  /\?$/,
  /\b(any thoughts|ptal|please take a look|can you|could you|would you|wdyt|let me know|let us know|any update|any updates|gentle ping|bumping)\b/i,
];

export function extractChatFromFrame(frame: Frame): ExtractedChatSnippet | null {
  if (!frame.text) return null;
  const text = frame.text;
  const channelMatch = text.match(SLACK_CHANNEL_RE);
  const titleChannelMatch = (frame.window_title ?? '').match(SLACK_CHANNEL_RE);
  const channel = channelMatch?.[2]
    ? `#${channelMatch[2]}`
    : titleChannelMatch?.[2]
      ? `#${titleChannelMatch[2]}`
      : SLACK_DM_RE.test(text)
        ? 'DM'
        : null;
  const threadMatch = text.match(SLACK_THREAD_RE);
  const thread = threadMatch ? `${threadMatch[1]} replies` : null;

  // Pull the last 600 chars as a representative slice — chat UIs render
  // newer messages at the bottom, so the tail of OCR text is most
  // likely to contain the message the user was actually reading.
  const tail = text.slice(-600).trim();
  const tailLines = tail
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter((line) => Boolean(line) && !isChatUiNoiseLine(line));
  const message = cleanChatMessage(tailLines.slice(-3).join(' ') || tail).slice(0, 240);
  if (!isUsefulChatMessage(message)) return null;
  const mentionSet = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    if (m[1]) mentionSet.add(`@${m[1].toLowerCase()}`);
  }
  const looks_unanswered = QUESTION_PATTERNS.some((re) => re.test(message));

  return {
    channel,
    thread_marker: thread,
    message,
    mentions: [...mentionSet].slice(0, 8),
    looks_unanswered,
    observed_at: frame.timestamp,
    source_frame_id: frame.id,
    source_app: frame.app || 'chat',
  };
}

function cleanChatMessage(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\bshift\s*\+\s*return\s+to\s+add\s+a\s+new\s+line\b/ig, '')
    .replace(/\bmessage\s+(?:#[a-z0-9_-]+|[a-z][\w.-]*)\s*\+\s*aa\b/ig, '')
    .replace(/\+\s*aa\b/ig, '')
    .trim();
}

function isUsefulChatMessage(message: string): boolean {
  const lower = message.toLowerCase().trim();
  if (lower.length < 8) return false;
  if (/^(new|threads?|dms?|huddles?|drafts?\s*&\s*sent|directories|apps?|files|later|more)$/i.test(lower)) return false;
  if (/^message\s+(?:#[a-z0-9_-]+|[a-z][\w.-]*)\b/i.test(lower)) return false;
  if (/\bshift\s*\+\s*return\b/i.test(lower)) return false;
  if (/^s?\s*new\s*x?$/i.test(lower)) return false;
  const alpha = (message.match(/[a-z]/gi) ?? []).length;
  return alpha >= 5 && alpha / message.length >= 0.25;
}

function isChatUiNoiseLine(line: string): boolean {
  const lower = line.toLowerCase().trim();
  if (!lower) return true;
  if (isUsefulChatMessage(line)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// GitHub / GitLab PR / issue extraction
// ---------------------------------------------------------------------------

export interface ExtractedReviewItem {
  kind: 'pull_request' | 'issue';
  /** "owner/repo#1234" — unique enough to dedupe across frames. */
  ref: string;
  url: string;
  title: string | null;
  /** "open" / "merged" / "closed" / "draft" / null when undetectable. */
  status: 'open' | 'draft' | 'merged' | 'closed' | null;
  observed_at: string;
  source_frame_id: string;
  source_app: string;
}

const GITHUB_PR_RE = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(pull|issues)\/(\d+)/i;

export function extractReviewItemFromFrame(frame: Frame): ExtractedReviewItem | null {
  const url = frame.url ?? '';
  const titleUrl = (frame.window_title ?? '').match(GITHUB_PR_RE);
  const m = url.match(GITHUB_PR_RE) ?? titleUrl;
  if (!m) return null;
  const [, owner, repo, kind, num] = m;
  const ref = `${owner}/${repo}#${num}`;
  const status = inferReviewStatus(frame.text, frame.window_title);
  const title = inferReviewTitle(frame.window_title, frame.text);
  return {
    kind: kind === 'pull' ? 'pull_request' : 'issue',
    ref,
    url: m[0],
    title,
    status,
    observed_at: frame.timestamp,
    source_frame_id: frame.id,
    source_app: frame.app || 'github',
  };
}

function inferReviewStatus(
  text: string | null,
  title: string | null,
): ExtractedReviewItem['status'] {
  const haystack = `${title ?? ''}\n${text ?? ''}`.toLowerCase();
  if (/\bdraft\b/.test(haystack)) return 'draft';
  if (/\bmerged\b/.test(haystack)) return 'merged';
  if (/\bclosed\b/.test(haystack) && !/\bunclosed\b/.test(haystack)) return 'closed';
  if (/\bopen\b/.test(haystack)) return 'open';
  return null;
}

function inferReviewTitle(
  windowTitle: string | null,
  text: string | null,
): string | null {
  if (windowTitle) {
    const cleaned = windowTitle
      .replace(/^pull request:?/i, '')
      .replace(/\s*[-–·•]\s*github(?:\.com)?$/i, '')
      .replace(/\s*[-–·•]\s*[^-–·•]+\/[^-–·•]+$/, '')
      .trim();
    if (cleaned.length > 4) return cleaned;
  }
  if (text) {
    const firstLine = text.split(/\r?\n/g).map((l) => l.trim()).find((l) => l.length > 6);
    if (firstLine) return firstLine.slice(0, 160);
  }
  return null;
}
