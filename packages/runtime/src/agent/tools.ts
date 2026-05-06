import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ActivitySession,
  EntityKind,
  EntityRecord,
  Frame,
  IIndexStrategy,
  IStorage,
} from '@cofounderos/interfaces';
import type {
  CalendarCheckResult,
  CompactFrame,
  CompactSession,
  DailyBriefingResult,
  DateAnchor,
  EntityListResult,
  EntitySummaryResult,
  FrameContextResult,
  IndexSearchResultBlock,
  OpenLoopsResult,
  SearchResultBlock,
  SessionDetailResult,
} from './types.js';
import {
  dedupeCalendarFrames,
  dedupeOpenLoopFrames,
  dedupeSearchFrames,
  isGarbled,
  stripSidebarNoise,
} from './noise.js';

/**
 * In-process "tool" surface for the chat harness.
 *
 * These wrap `IStorage` (and a handful of derived aggregations) into
 * the deterministic primitives the routing tree expects. They are NOT
 * the MCP tool handlers — those live in the MCP plugin — but they
 * follow the same contract so the harness rules port over cleanly.
 *
 * Each function:
 *   1. Calls one or two storage primitives.
 *   2. Trims / normalises the result so it fits a small LLM context.
 *   3. Applies the noise filters from §3.4 of the harness rules.
 *
 * Functions that aggregate (e.g. `getDailyBriefing`) intentionally
 * stay lightweight — they do not reproduce the MCP plugin's full
 * digest. We pass the trimmed results to the model and let it do the
 * narrative assembly. The model is the brain; these tools are eyes.
 */

const FRAME_EXCERPT_CHARS = 280;
const SESSION_ACTIVE_MIN_FLOOR = 1;
const NOISE_APPS = new Set(['audio', 'loginwindow']);
const NOISE_ENTITY_PATHS = new Set(['apps/audio', 'apps/loginwindow']);

const CALENDAR_APP_HINTS = [
  'calendar',
  'fantastical',
  'busycal',
  'outlook',
  'cal.com',
];
const CALENDAR_URL_HINTS = [
  'calendar.google.com',
  'outlook.live.com',
  'outlook.office',
  'cal.com',
  'fantastical.app',
];
const CALENDAR_TITLE_HINTS = [
  'calendar',
  'meeting',
  'schedule',
  'event',
];

const CHAT_APP_HINTS = [
  'slack',
  'discord',
  'telegram',
  'imessage',
  'messages',
  'teams',
  'whatsapp',
];
const CHAT_URL_HINTS = [
  'app.slack.com',
  'slack.com',
  'discord.com',
  'web.telegram.org',
  'teams.microsoft.com',
];
const REVIEW_URL_HINTS = ['github.com', 'gitlab.com', 'bitbucket.org'];

// ---------------------------------------------------------------------
// Compact projections
// ---------------------------------------------------------------------

export function compactFrame(frame: Frame, excerptChars = FRAME_EXCERPT_CHARS): CompactFrame {
  // Strip known sidebar/UI-chrome strings before truncating so the
  // remaining excerpt is real content. `isGarbled` runs against the
  // CLEANED text — the noise strip alone often turns "chrome only"
  // frames into empty / garbled excerpts, which is what we want.
  const cleaned = stripSidebarNoise(frame.text);
  const excerpt = collapseText(cleaned, excerptChars);
  return {
    id: frame.id,
    timestamp: frame.timestamp,
    app: frame.app,
    window_title: frame.window_title,
    url: frame.url,
    excerpt,
    entity_path: frame.entity_path,
    asset_path: frame.asset_path,
    garbled: isGarbled(excerpt),
  };
}

export function compactSession(session: ActivitySession): CompactSession {
  return {
    id: session.id,
    started_at: session.started_at,
    ended_at: session.ended_at,
    active_min: Math.round(session.active_ms / 60000),
    primary_entity: session.primary_entity_path,
    primary_app: session.primary_app,
    frames: session.frame_count,
  };
}

// ---------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------

export interface ToolDeps {
  storage: IStorage;
  strategy?: IIndexStrategy;
}

/**
 * Daily briefing: one call covers most "what's on my plate today" /
 * "what did I work on" questions. Aggregates sessions for the day and
 * pulls a couple of small frame samples for calendar / chat / review
 * surfaces so the model has concrete examples to ground its answer.
 */
export async function getDailyBriefing(
  deps: ToolDeps,
  anchor: DateAnchor,
): Promise<DailyBriefingResult> {
  const { storage } = deps;

  const rawSessions = await storage.listSessions({
    day: anchor.day,
    limit: 60,
    order: 'chronological',
  });
  const sessions = filterMeaningfulSessions(rawSessions);

  // Top apps + entities by accumulated active time across kept sessions.
  const appBuckets = new Map<string, { minutes: number; frames: number }>();
  const entityBuckets = new Map<string, { minutes: number; frames: number }>();
  let totalActiveMs = 0;
  let totalFrames = 0;
  for (const s of sessions) {
    totalActiveMs += s.active_ms;
    totalFrames += s.frame_count;
    if (s.primary_app && !NOISE_APPS.has(s.primary_app.toLowerCase())) {
      const slot = appBuckets.get(s.primary_app) ?? { minutes: 0, frames: 0 };
      slot.minutes += Math.round(s.active_ms / 60000);
      slot.frames += s.frame_count;
      appBuckets.set(s.primary_app, slot);
    }
    if (s.primary_entity_path && !NOISE_ENTITY_PATHS.has(s.primary_entity_path)) {
      const slot = entityBuckets.get(s.primary_entity_path) ?? { minutes: 0, frames: 0 };
      slot.minutes += Math.round(s.active_ms / 60000);
      slot.frames += s.frame_count;
      entityBuckets.set(s.primary_entity_path, slot);
    }
  }

  // Calendar / open-loop candidates: scan the day's frames for the
  // smallest set we can reasonably show. Capped tight to keep the
  // model's context lean.
  const dayFrames = await safeSearchFrames(storage, {
    from: anchor.fromIso,
    to: anchor.toIso,
    limit: 200,
  });
  // Pick a few extra candidates so dedup has slack to work with — the
  // raw scorer happily includes 3-4 captures of the same calendar UI
  // taken seconds apart.
  const calendar = dedupeCalendarFrames(
    pickCalendarCandidates(dayFrames, 12).map((f) => compactFrame(f, 480)),
  ).slice(0, 6);
  const openLoops = dedupeOpenLoopFrames(
    pickOpenLoopCandidates(dayFrames, 12).map((f) => compactFrame(f, 480)),
  ).slice(0, 6);

  return {
    day: anchor.day,
    totals: {
      active_min: Math.round(totalActiveMs / 60000),
      sessions: sessions.length,
      frames: totalFrames,
    },
    top_apps: rankBuckets(appBuckets).slice(0, 5).map(([app, v]) => ({ app, ...v })),
    top_entities: rankBuckets(entityBuckets)
      .slice(0, 5)
      .map(([path, v]) => ({ path, ...v })),
    sessions: sessions.slice(0, 12).map(compactSession),
    // Wider excerpt for actionable candidates — the model needs to
    // extract concrete event titles / message text from these, so the
    // default 280 chars often truncates the line before the useful bit.
    // Already deduped above.
    calendar_candidates: calendar,
    open_loop_candidates: openLoops,
  };
}

export async function getCalendarCandidates(
  deps: ToolDeps,
  anchor: DateAnchor,
): Promise<CalendarCheckResult> {
  const frames = await safeSearchFrames(deps.storage, {
    from: anchor.fromIso,
    to: anchor.toIso,
    limit: 200,
  });
  return {
    day: anchor.day,
    candidates: dedupeCalendarFrames(
      pickCalendarCandidates(frames, 20).map((f) => compactFrame(f, 480)),
    ).slice(0, 10),
  };
}

export async function getOpenLoopCandidates(
  deps: ToolDeps,
  anchor: DateAnchor,
): Promise<OpenLoopsResult> {
  const frames = await safeSearchFrames(deps.storage, {
    from: anchor.fromIso,
    to: anchor.toIso,
    limit: 250,
  });
  return {
    day: anchor.day,
    candidates: dedupeOpenLoopFrames(
      pickOpenLoopCandidates(frames, 20).map((f) => compactFrame(f, 480)),
    ).slice(0, 10),
  };
}

export async function searchFramesTool(
  deps: ToolDeps,
  args: { query: string; day?: string; from?: string; to?: string; limit?: number },
): Promise<SearchResultBlock> {
  const limit = clamp(args.limit ?? 12, 1, 30);
  const query = args.query.trim();
  if (!query) return { query, matches: [] };
  // Pull a slightly bigger working set so the dedup pass has room to
  // collapse near-duplicate captures (same Slack thread, same diff).
  const frames = await safeSearchFrames(deps.storage, {
    text: query,
    day: args.day,
    from: args.from,
    to: args.to,
    limit: Math.min(limit * 2, 60),
  });
  const compact = frames.map((f) => compactFrame(f, 200));
  return {
    query,
    matches: dedupeSearchFrames(compact).slice(0, limit),
  };
}

export async function searchPersonFramesTool(
  deps: ToolDeps,
  args: { query: string; limit?: number },
): Promise<SearchResultBlock> {
  const limit = clamp(args.limit ?? 10, 1, 30);
  const query = args.query.trim();
  if (!query) return { query, matches: [] };

  const byId = new Map<string, Frame>();
  for (const variant of personSearchVariants(query)) {
    const frames = await safeSearchFrames(deps.storage, {
      text: variant,
      limit: limit * 8,
    });
    for (const frame of frames) byId.set(frame.id, frame);
  }

  const cleaned = dedupePersonFrames(
    [...byId.values()]
      .map((frame) => ({ frame, score: scorePersonFrame(frame, query) }))
      .filter((match) => match.score >= 5)
      .sort((a, b) => b.score - a.score || b.frame.timestamp.localeCompare(a.frame.timestamp))
      .map((match) => match.frame),
    query,
  )
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);

  return {
    query,
    matches: cleaned.map((f) => compactPersonFrame(f, query)),
  };
}

export async function searchIndexPagesTool(
  deps: ToolDeps,
  args: { query: string; limit?: number },
): Promise<IndexSearchResultBlock> {
  const query = args.query.trim();
  const limit = clamp(args.limit ?? 5, 1, 12);
  if (!query || !deps.strategy) return { query, matches: [] };

  const pages = await safeListIndexPages(deps.strategy);
  const ranked = pages
    .map((page) => ({ page, score: scorePage(page.path, page.content, query) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    query,
    matches: ranked.map(({ page, score }) => ({
      path: page.path,
      title: extractMarkdownTitle(page.content) ?? path.basename(page.path, '.md'),
      excerpt: extractRelevantTextExcerpt(page.content, query, 700),
      lastUpdated: page.lastUpdated,
      sourceEventCount: page.sourceEventIds.length,
      score,
    })),
  };
}

export async function getFrameContextTool(
  deps: ToolDeps,
  args: { frameId: string; before?: number; after?: number },
): Promise<FrameContextResult | null> {
  const before = clamp(args.before ?? 3, 0, 8);
  const after = clamp(args.after ?? 3, 0, 8);
  const ctx = await deps.storage.getFrameContext(args.frameId, before, after);
  if (!ctx) return null;
  return {
    frameId: args.frameId,
    before: ctx.before.map((f) => compactFrame(f, 200)),
    anchor: compactFrame(ctx.anchor, 320),
    after: ctx.after.map((f) => compactFrame(f, 200)),
  };
}

export async function getActivitySessionTool(
  deps: ToolDeps,
  args: { id: string },
): Promise<SessionDetailResult | null> {
  const session = await deps.storage.getSession(args.id);
  if (!session) return null;
  const frames = await deps.storage.getSessionFrames(args.id);
  return {
    session: compactSession(session),
    frames: frames.slice(0, 30).map((f) => compactFrame(f, 200)),
  };
}

export async function listEntitiesTool(
  deps: ToolDeps,
  args: { query?: string; kind?: EntityKind; limit?: number },
): Promise<EntityListResult> {
  const limit = clamp(args.limit ?? 10, 1, 25);
  let entities: EntityRecord[];
  if (args.query && args.query.trim()) {
    entities = await safeSearchEntities(deps.storage, {
      text: args.query.trim(),
      kind: args.kind,
      limit,
    });
  } else {
    entities = await safeListEntities(deps.storage, { kind: args.kind, limit });
  }
  return {
    query: args.query ?? '',
    entities: entities.map((e) => ({
      path: e.path,
      title: e.title,
      kind: e.kind,
      lastSeen: e.lastSeen,
      frames: e.frameCount,
    })),
  };
}

export async function getEntitySummaryTool(
  deps: ToolDeps,
  args: { path: string; sinceIso?: string; untilIso?: string },
): Promise<EntitySummaryResult | null> {
  const entity = await deps.storage.getEntity(args.path);
  if (!entity) return null;
  const recentFrames = await safeGetEntityFrames(deps.storage, args.path, 10);
  const neighbours = await safeListEntityNeighbours(deps.storage, args.path, 8);
  const timeline = await safeGetEntityTimeline(deps.storage, args.path, {
    granularity: 'day',
    from: args.sinceIso,
    to: args.untilIso,
    limit: 14,
  });
  return {
    path: entity.path,
    title: entity.title,
    kind: entity.kind,
    totalFocusedMin: Math.round(entity.totalFocusedMs / 60000),
    frameCount: entity.frameCount,
    recentFrames: recentFrames.map((f) => compactFrame(f, 200)),
    neighbours: neighbours.map((n) => ({
      path: n.path,
      title: n.title,
      kind: n.kind,
      sharedSessions: n.sharedSessions,
    })),
    timeline: timeline.map((b) => ({
      bucket: b.bucket,
      minutes: Math.round(b.focusedMs / 60000),
      frames: b.frames,
    })),
  };
}

// ---------------------------------------------------------------------
// Filters & helpers
// ---------------------------------------------------------------------

/**
 * Apply the noise filters from §3.4 of the harness rules:
 *   - Drop active_min == 0 sessions with <= 2 frames (idle pings).
 *   - Drop background audio + lock-screen sessions.
 *   - Merge consecutive same-entity sessions separated by < 5 minutes.
 */
function filterMeaningfulSessions(sessions: ActivitySession[]): ActivitySession[] {
  const kept: ActivitySession[] = [];
  for (const session of sessions) {
    const activeMin = session.active_ms / 60000;
    if (activeMin === 0 && session.frame_count <= 2) continue;
    const app = (session.primary_app ?? '').toLowerCase();
    if (NOISE_APPS.has(app)) continue;
    if (session.primary_entity_path && NOISE_ENTITY_PATHS.has(session.primary_entity_path)) {
      continue;
    }
    if (activeMin < SESSION_ACTIVE_MIN_FLOOR) continue;

    const last = kept[kept.length - 1];
    if (
      last &&
      last.primary_entity_path &&
      last.primary_entity_path === session.primary_entity_path &&
      gapMinutes(last.ended_at, session.started_at) < 5
    ) {
      // Merge: extend the previous session forward.
      last.ended_at = session.ended_at;
      last.active_ms += session.active_ms;
      last.duration_ms += session.duration_ms;
      last.frame_count += session.frame_count;
      continue;
    }
    kept.push({ ...session });
  }
  return kept;
}

function pickCalendarCandidates(frames: Frame[], limit: number): Frame[] {
  const scored: Array<{ score: number; frame: Frame }> = [];
  for (const frame of frames) {
    const score = scoreCalendarFrame(frame);
    if (score > 0) scored.push({ score, frame });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.frame);
}

function pickOpenLoopCandidates(frames: Frame[], limit: number): Frame[] {
  const scored: Array<{ score: number; frame: Frame }> = [];
  for (const frame of frames) {
    const score = scoreOpenLoopFrame(frame);
    if (score > 0) scored.push({ score, frame });
  }
  // Prefer the most recent within ties — open loops feel stale fast.
  scored.sort((a, b) =>
    b.score === a.score ? b.frame.timestamp.localeCompare(a.frame.timestamp) : b.score - a.score,
  );
  return scored.slice(0, limit).map((s) => s.frame);
}

function scoreCalendarFrame(frame: Frame): number {
  const app = (frame.app ?? '').toLowerCase();
  const url = (frame.url ?? '').toLowerCase();
  const title = (frame.window_title ?? '').toLowerCase();
  const text = (frame.text ?? '').toLowerCase();
  const appHit = CALENDAR_APP_HINTS.some((h) => app.includes(h));
  const urlHit = CALENDAR_URL_HINTS.some((h) => url.includes(h));
  const titleHit = CALENDAR_TITLE_HINTS.some((h) => title.includes(h));
  // Require a strong calendar signal — a plain timestamp inside an
  // unrelated frame (a Slack message at "9:01 AM", a chat with an ETA,
  // even a code comment with `12:30`) would otherwise leak into the
  // calendar bucket and confuse the daily-briefing answer.
  if (!appHit && !urlHit && !titleHit) return 0;
  let score = 0;
  if (appHit) score += 4;
  if (urlHit) score += 4;
  if (titleHit) score += 2;
  if (/\b\d{1,2}:\d{2}\s?(am|pm)?\b/.test(text)) score += 1;
  return score;
}

function scoreOpenLoopFrame(frame: Frame): number {
  const app = (frame.app ?? '').toLowerCase();
  const url = (frame.url ?? '').toLowerCase();
  const text = (frame.text ?? '').toLowerCase();

  // The frame must contain a real "something is waiting on you" signal.
  // Just being on a chat app or GitHub is not enough — most of those
  // captures are casual conversation the user has already replied to,
  // and surfacing them as open loops produces hallucination-shaped
  // bullets in the daily briefing ("Tanya is waiting on you" when the
  // user's reply is right there in the OCR).
  //
  // We look for explicit unanswered/action language. `\breply\b` alone
  // would falsely match "3 replies" (Slack thread chrome) or the user's
  // own past replies, so we require it to be paired with a need word.
  const PENDING_SIGNAL =
    /(\bunread\b|\bmention(s|ed)?\b|@you\b|\breply needed\b|\bplease (reply|respond|review)\b|\brespond\b|\bwaiting on (you|your)\b|\bneeds (your )?(review|response|reply|answer)\b|\bfollow.?up\b|\breview requested\b|\brequested changes\b|\bopen pull request\b|\bopen pr\b|\bopen issue\b|\bawaiting (review|response)\b|\bneeds attention\b)/;
  if (!PENDING_SIGNAL.test(text)) return 0;

  // Exclude frames where the user clearly responded last in the
  // captured snippet — those are resolved threads, not open loops.
  if (looksLikeUserRepliedLast(frame.text ?? '')) return 0;

  let score = 0;
  if (CHAT_APP_HINTS.some((h) => app.includes(h))) score += 2;
  if (CHAT_URL_HINTS.some((h) => url.includes(h))) score += 2;
  if (REVIEW_URL_HINTS.some((h) => url.includes(h))) score += 2;
  // Bump for explicit pending phrasing on top of the surface signal.
  score += 3;
  if (/^[\d,]+\s*$/.test(text)) score = 0;
  return score;
}

/**
 * Heuristic: did the captured user (sagiv-like first-person speaker)
 * reply after the most recent counterparty message in this frame? If
 * so, we treat the conversation as closed for open-loop purposes.
 *
 * We can't know the actual user handle from a Frame, so we rely on a
 * stable proxy: the substring `sagiv` (the project owner's handle in
 * captured Slack/iMessage frames) plus generic first-person reply
 * phrasing. False negatives (we keep a frame that's actually closed)
 * are tolerable; false positives (we drop a frame that IS unanswered)
 * are not — so this stays conservative.
 */
function looksLikeUserRepliedLast(rawText: string): boolean {
  if (!rawText) return false;
  const lower = rawText.toLowerCase();
  // Find the last speaker line ("Name H:MM AM/PM" or "Name 11:10 AM")
  // and check if it's the user.
  const lines = lower.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    // Speaker headers in Slack-shaped OCR look like "name 11:10 am" or
    // "name 11:10". If the speaker token matches the user, the
    // conversation ends with the user.
    const m = line.match(/^([a-z][a-z0-9._-]{1,30})\s+\d{1,2}:\d{2}\s?(am|pm)?$/);
    if (m) {
      const speaker = m[1]!;
      return speaker === 'sagiv' || speaker === 'me' || speaker === 'you';
    }
  }
  return false;
}

function dedupePersonFrames(frames: Frame[], query: string): Frame[] {
  const byKey = new Map<string, Frame>();
  for (const frame of frames) {
    const key = personFrameDedupeKey(frame, query);
    const existing = byKey.get(key);
    if (!existing || frame.timestamp > existing.timestamp) byKey.set(key, frame);
  }
  return [...byKey.values()];
}

function compactPersonFrame(frame: Frame, query: string): CompactFrame {
  return {
    ...compactFrame(frame, 520),
    excerpt: frame.text ? collapseText(relevantTextWindow(frame.text, query, 1200), 900) : null,
  };
}

function personSearchVariants(query: string): string[] {
  const cleaned = query.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  const variants = new Set<string>([query, cleaned]);
  if (parts[0]) variants.add(parts[0]);
  if (parts.length >= 2) {
    variants.add(`${parts[0]} ${parts[1]}`);
    variants.add(`${parts[0]}.${parts[1]}`);
  }
  return [...variants].filter(Boolean);
}

function scorePersonFrame(frame: Frame, query: string): number {
  if (isRosterOrMemberFrame(frame)) return -20;
  const text = (frame.text ?? '').toLowerCase();
  const title = (frame.window_title ?? '').toLowerCase();
  const app = (frame.app ?? '').toLowerCase();
  const url = (frame.url ?? '').toLowerCase();
  const entity = (frame.entity_path ?? '').toLowerCase();
  const searchText = `${text} ${title} ${url} ${entity}`;
  const terms = queryTerms(query).filter((term) => term.length > 2);
  const termHits = terms.filter((term) => searchText.includes(term)).length;
  if (termHits === 0) return -10;
  const communication = isCommunicationSurface(frame);
  const messageLike = looksLikeMessageText(text);
  const attributedToPerson = hasPersonAttribution(text, query);
  if (!communication) return -10;
  if (isNoisyPersonSurface(frame) && !attributedToPerson) return -12;
  if (!messageLike && !attributedToPerson) return -8;

  let score = termHits * 2;
  if (communication) score += 6;
  if (/\b(slack|discord|teams|messages|imessage|whatsapp|mail)\b/.test(app)) score += 2;
  if (/\bapp\.slack\.com|slack\.com|teams\.microsoft\.com|discord\.com|web\.whatsapp\.com\b/.test(url)) score += 4;
  if (entity.startsWith('channels/') || entity.startsWith('contacts/')) score += 3;
  if (messageLike) score += 4;
  if (attributedToPerson) score += 5;
  if (/\b(i will|i'll|doing today|today|eow|end of week|todo|blocked|not blocking|follow up|clean(ing)? up)\b/.test(text)) {
    score += 2;
  }
  if (isGenericWebChrome(frame)) score -= 8;
  if (isNoisyPersonSurface(frame)) {
    score -= 4;
  }
  return score;
}

function personFrameDedupeKey(frame: Frame, query: string): string {
  const surface = frame.url ? hostFromUrl(frame.url) : frame.window_title || frame.app || 'unknown';
  const text = collapseText(frame.text, 2000) ?? '';
  const relevant = relevantTextWindow(text, query, 700)
    .toLowerCase()
    .replace(/\b\d{1,2}:\d{2}\s?(am|pm)?\b/g, '')
    .replace(/\b(today|yesterday|\d+\s*(m|h|d)\s*ago)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${surface.toLowerCase()}::${hashString(relevant.slice(0, 500))}`;
}

function relevantTextWindow(text: string, query: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lower = text.toLowerCase();
  const terms = queryTerms(query);
  const idx = terms
    .map((term) => lower.indexOf(term))
    .filter((n) => n >= 0)
    .sort((a, b) => a - b)[0];
  if (idx == null) return text.slice(0, maxChars);
  const start = Math.max(0, Math.min(text.length - maxChars, idx - Math.floor(maxChars / 2)));
  return text.slice(start, start + maxChars);
}

function isRosterOrMemberFrame(frame: Frame): boolean {
  const title = (frame.window_title ?? '').toLowerCase();
  const text = (frame.text ?? '').toLowerCase();
  if (/\b(members?|member list|people in this channel|channel details|profile|about)\b/.test(title)) {
    return true;
  }
  if (/\b(add people|view all members|channel members|people in this conversation|member profile|user profile)\b/.test(text)) {
    return !/\b(today|yesterday|\d+\s*(m|h|d)\s*ago|am|pm)\b/.test(text);
  }
  return false;
}

function isCommunicationSurface(frame: Frame): boolean {
  const app = (frame.app ?? '').toLowerCase();
  const url = (frame.url ?? '').toLowerCase();
  const title = (frame.window_title ?? '').toLowerCase();
  return (
    /\b(slack|discord|teams|messages|imessage|whatsapp|mail)\b/.test(app) ||
    /\bapp\.slack\.com|slack\.com|teams\.microsoft\.com|discord\.com|web\.whatsapp\.com\b/.test(url) ||
    /\((channel|private channel|dm|direct message)\)/i.test(frame.window_title ?? '') ||
    title.includes('thread')
  );
}

function looksLikeMessageText(text: string): boolean {
  return (
    /\b(today|yesterday|\d+\s*(m|h|d)\s*ago)\b/.test(text) ||
    /\b\d{1,2}:\d{2}\s?(am|pm)\b/.test(text) ||
    /\breplied to|thread|message|sent|posted\b/.test(text)
  );
}

function hasPersonAttribution(text: string, query: string): boolean {
  const terms = queryTerms(query).filter((term) => term.length > 2);
  if (terms.length === 0) return false;
  const first = terms[0] ?? '';
  const last = terms[1] ?? '';
  const escapedFirst = escapeRegex(first);
  const escapedLast = last ? escapeRegex(last) : '';
  const patterns = [
    new RegExp(`\\b${escapedFirst}${escapedLast ? `[._\\s-]+${escapedLast}` : ''}\\b.{0,80}\\b(today|yesterday|\\d+\\s*(m|h|d)\\s*ago|am|pm)\\b`, 'i'),
    new RegExp(`\\b(today|yesterday|\\d+\\s*(m|h|d)\\s*ago|am|pm)\\b.{0,80}\\b${escapedFirst}\\b`, 'i'),
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function isGenericWebChrome(frame: Frame): boolean {
  const app = (frame.app ?? '').toLowerCase();
  const url = (frame.url ?? '').toLowerCase();
  if (isCommunicationSurface(frame)) return false;
  return (
    app.includes('firefox') ||
    app.includes('chrome') ||
    app.includes('safari') ||
    /^https?:\/\//.test(url)
  );
}

function isNoisyPersonSurface(frame: Frame): boolean {
  const title = (frame.window_title ?? '').toLowerCase();
  const text = (frame.text ?? '').toLowerCase();
  return (
    /\b(registrations?|domains?|facebook|grok|cloud|birthday|search results?|sign in|log in|home)\b/.test(title) ||
    /\b(registrations?|domains?|facebook|grok|cloud x|birthday|search facebook)\b/.test(text)
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function rankBuckets(map: Map<string, { minutes: number; frames: number }>): Array<[string, { minutes: number; frames: number }]> {
  return [...map.entries()].sort((a, b) => b[1].minutes - a[1].minutes || b[1].frames - a[1].frames);
}

function gapMinutes(endIso: string, startIso: string): number {
  const a = Date.parse(endIso);
  const b = Date.parse(startIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (b - a) / 60000);
}

function collapseText(text: string | null, max: number): string | null {
  if (!text) return null;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ---------------------------------------------------------------------
// IStorage shims — gracefully degrade when an adapter throws
// `not_implemented` for entities / sessions.
// ---------------------------------------------------------------------

async function safeSearchFrames(storage: IStorage, query: Parameters<IStorage['searchFrames']>[0]): Promise<Frame[]> {
  try {
    return await storage.searchFrames(query);
  } catch {
    return [];
  }
}

async function safeListEntities(storage: IStorage, query: Parameters<IStorage['listEntities']>[0]): Promise<EntityRecord[]> {
  try {
    return await storage.listEntities(query);
  } catch {
    return [];
  }
}

async function safeSearchEntities(storage: IStorage, query: Parameters<IStorage['searchEntities']>[0]): Promise<EntityRecord[]> {
  try {
    return await storage.searchEntities(query);
  } catch {
    return [];
  }
}

async function safeGetEntityFrames(storage: IStorage, path: string, limit: number): Promise<Frame[]> {
  try {
    return await storage.getEntityFrames(path, limit);
  } catch {
    return [];
  }
}

async function safeListEntityNeighbours(
  storage: IStorage,
  path: string,
  limit: number,
): Promise<Awaited<ReturnType<IStorage['listEntityCoOccurrences']>>> {
  try {
    return await storage.listEntityCoOccurrences(path, limit);
  } catch {
    return [];
  }
}

async function safeGetEntityTimeline(
  storage: IStorage,
  path: string,
  query: Parameters<IStorage['getEntityTimeline']>[1],
): Promise<Awaited<ReturnType<IStorage['getEntityTimeline']>>> {
  try {
    return await storage.getEntityTimeline(path, query);
  } catch {
    return [];
  }
}

async function safeListIndexPages(
  strategy: IIndexStrategy,
): Promise<Array<{ path: string; content: string; lastUpdated: string; sourceEventIds: string[] }>> {
  try {
    const state = await strategy.getState();
    const root = state.rootPath;
    const out: Array<{ path: string; content: string; lastUpdated: string; sourceEventIds: string[] }> = [];

    const walk = async (relDir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const rel = path.join(relDir, entry.name).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          await walk(rel);
          continue;
        }
        if (
          !entry.isFile() ||
          !entry.name.endsWith('.md') ||
          entry.name === 'index.md' ||
          entry.name === 'log.md'
        ) {
          continue;
        }
        const page = await strategy.readPage(rel);
        if (page) {
          out.push({
            path: rel,
            content: page.content,
            lastUpdated: page.lastUpdated,
            sourceEventIds: page.sourceEventIds,
          });
        }
      }
    };

    await walk('.');
    return out;
  } catch {
    return [];
  }
}

function scorePage(pagePath: string, content: string, query: string): number {
  if (!content) return 0;
  const queryLower = query.trim().toLowerCase();
  const lower = content.toLowerCase();
  const pathLower = pagePath.toLowerCase();
  let score = 0;

  if (queryLower) {
    score += countOccurrences(pathLower, queryLower) * 10;
    score += countOccurrences(lower, queryLower) * 6;
  }

  const terms = queryTerms(query).filter((term) => term.length > 2);
  for (const term of terms) {
    score += countOccurrences(pathLower, term) * 4;
    score += countOccurrences(lower, term);
  }
  return score;
}

function extractMarkdownTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || null;
}

function extractRelevantTextExcerpt(text: string, query: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lower = text.toLowerCase();
  const exact = query.trim().toLowerCase();
  let bestIndex = exact ? lower.indexOf(exact) : -1;
  if (bestIndex === -1) bestIndex = bestQueryWindowStart(lower, queryTerms(query), maxChars);
  if (bestIndex === -1) return truncateText(text, maxChars);

  const halfWindow = Math.floor(maxChars / 2);
  const start = Math.max(0, Math.min(text.length - maxChars, bestIndex - halfWindow));
  const end = Math.min(text.length, start + maxChars);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

function bestQueryWindowStart(lowerText: string, terms: string[], maxChars: number): number {
  let bestStart = -1;
  let bestScore = 0;
  for (const term of terms) {
    let from = 0;
    let occurrences = 0;
    while (occurrences < 100) {
      const idx = lowerText.indexOf(term, from);
      if (idx === -1) break;
      occurrences += 1;
      const start = Math.max(0, Math.min(lowerText.length - maxChars, idx - Math.floor(maxChars / 2)));
      const window = lowerText.slice(start, start + maxChars);
      const score = terms.reduce((sum, candidate) => sum + (window.includes(candidate) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        bestStart = idx;
      }
      from = idx + term.length;
    }
  }
  return bestStart;
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9_-]+/g) ?? [])];
}

function countOccurrences(lowerText: string, lowerNeedle: string): number {
  if (!lowerNeedle) return 0;
  let count = 0;
  let from = 0;
  while (count < 100) {
    const idx = lowerText.indexOf(lowerNeedle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + lowerNeedle.length;
  }
  return count;
}

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}
