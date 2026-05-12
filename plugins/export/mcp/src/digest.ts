import type {
  Frame,
  ActivitySession,
  IStorage,
  EntityRecord,
} from '@cofounderos/interfaces';
import {
  classifyFrame,
  dedupeCalendarEvents,
  extractCalendarEventsFromFrame,
  extractChatFromFrame,
  extractReviewItemFromFrame,
  isSelfFrame,
  urlHost,
  type ExtractedCalendarEvent,
  type ExtractedChatSnippet,
  type ExtractedReviewItem,
} from './parsers.js';

// ---------------------------------------------------------------------------
// Daily summary
// ---------------------------------------------------------------------------

export interface DailySummaryOptions {
  /**
   * Whether to include CofounderOS-dashboard frames in aggregations and
   * extracted artifacts. Defaults to false — the dashboard's own UI
   * tends to dominate any text-based aggregation.
   */
  include_self?: boolean;
  /** Cap on the open-loops list. Default 10. */
  open_loops_limit?: number;
}

export interface DailySummary {
  day: string;
  generated_at: string;
  totals: {
    frames: number;
    sessions: number;
    focused_min: number;
    active_min: number;
    started_at: string | null;
    ended_at: string | null;
  };
  top_apps: Array<{ app: string; focused_min: number; frames: number }>;
  top_entities: Array<{
    path: string;
    kind: string;
    title: string;
    focused_min: number;
    frames: number;
  }>;
  top_url_hosts: Array<{ host: string; frames: number }>;
  sessions: Array<{
    id: string;
    started_at: string;
    ended_at: string;
    active_min: number;
    primary_entity: string | null;
    primary_app: string | null;
    frames: number;
    headline: string | null;
  }>;
  calendar_events: ExtractedCalendarEvent[];
  open_loops: OpenLoop[];
  slack_threads: SlackThreadDigest[];
  review_queue: ReviewItemDigest[];
  notes: string[];
}

export async function buildDailySummary(
  storage: IStorage,
  day: string,
  options: DailySummaryOptions = {},
): Promise<DailySummary> {
  const allFrames = await storage.getJournal(day);
  const frames = options.include_self
    ? allFrames
    : allFrames.filter((f) => !isSelfFrame(f));

  let sessions: ActivitySession[] = [];
  try {
    sessions = await storage.listSessions({
      day,
      order: 'chronological',
      limit: 500,
    });
  } catch {
    sessions = [];
  }

  const totals = computeTotals(frames, sessions);
  const top_apps = topApps(frames, 8);
  const top_entities = await topEntities(storage, frames, 10);
  const top_url_hosts = topUrlHosts(frames, 10);
  const calendar_events = collectCalendarEvents(frames);
  const slackSnippets = collectChatSnippets(frames);
  const reviewItems = collectReviewItems(frames);

  const slack_threads = digestSlackThreads(slackSnippets, 8);
  const review_queue = digestReviewItems(reviewItems);
  const open_loops = buildOpenLoops(slackSnippets, reviewItems, options.open_loops_limit ?? 10);

  const sessionDigests = sessions.map((session) => ({
    id: session.id,
    started_at: session.started_at,
    ended_at: session.ended_at,
    active_min: Math.round(session.active_ms / 60_000),
    primary_entity: session.primary_entity_path,
    primary_app: session.primary_app,
    frames: session.frame_count,
    headline: sessionHeadline(
      session,
      frames.filter((f) => f.activity_session_id === session.id),
    ),
  }));

  const notes: string[] = [];
  if (frames.length === 0) {
    notes.push('No frames captured on this day.');
  } else if (sessions.length === 0) {
    notes.push(
      'Activity sessions not yet built for this day — try trigger_reindex if you want session-grouped output.',
    );
  }
  if (!options.include_self && frames.length < allFrames.length) {
    const dropped = allFrames.length - frames.length;
    notes.push(
      `Filtered out ${dropped} CofounderOS dashboard frame(s). Pass include_self=true to include them.`,
    );
  }

  return {
    day,
    generated_at: new Date().toISOString(),
    totals,
    top_apps,
    top_entities,
    top_url_hosts,
    sessions: sessionDigests,
    calendar_events,
    open_loops,
    slack_threads,
    review_queue,
    notes,
  };
}

function computeTotals(
  frames: Frame[],
  sessions: ActivitySession[],
): DailySummary['totals'] {
  const focusedMs = frames.reduce((acc, f) => acc + (f.duration_ms ?? 0), 0);
  const activeMs = sessions.reduce((acc, s) => acc + s.active_ms, 0);
  const started = frames.length > 0 ? frames[0]!.timestamp : null;
  const ended = frames.length > 0 ? frames[frames.length - 1]!.timestamp : null;
  return {
    frames: frames.length,
    sessions: sessions.length,
    focused_min: Math.round(focusedMs / 60_000),
    active_min: Math.round(activeMs / 60_000),
    started_at: started,
    ended_at: ended,
  };
}

function topApps(
  frames: Frame[],
  limit: number,
): Array<{ app: string; focused_min: number; frames: number }> {
  const byApp = new Map<string, { ms: number; frames: number }>();
  for (const f of frames) {
    const app = f.app || '(unknown)';
    const slot = byApp.get(app) ?? { ms: 0, frames: 0 };
    slot.ms += f.duration_ms ?? 0;
    slot.frames += 1;
    byApp.set(app, slot);
  }
  return [...byApp.entries()]
    .sort((a, b) => b[1].ms - a[1].ms || b[1].frames - a[1].frames)
    .slice(0, limit)
    .map(([app, v]) => ({
      app,
      focused_min: Math.round(v.ms / 60_000),
      frames: v.frames,
    }));
}

async function topEntities(
  storage: IStorage,
  frames: Frame[],
  limit: number,
): Promise<DailySummary['top_entities']> {
  const byPath = new Map<string, { ms: number; frames: number; kind: string | null }>();
  for (const f of frames) {
    if (!f.entity_path) continue;
    const slot = byPath.get(f.entity_path) ?? { ms: 0, frames: 0, kind: f.entity_kind };
    slot.ms += f.duration_ms ?? 0;
    slot.frames += 1;
    if (!slot.kind && f.entity_kind) slot.kind = f.entity_kind;
    byPath.set(f.entity_path, slot);
  }
  const entries = [...byPath.entries()]
    .sort((a, b) => b[1].ms - a[1].ms || b[1].frames - a[1].frames)
    .slice(0, limit);
  // Attach a human-readable title where the entity record knows one.
  // Failure to look up an entity is not fatal — fall back to the path.
  const records = await Promise.all(
    entries.map(async ([path]) => {
      try {
        return await storage.getEntity(path);
      } catch {
        return null;
      }
    }),
  );
  return entries.map(([path, v], i) => {
    const rec: EntityRecord | null = records[i] ?? null;
    return {
      path,
      kind: v.kind ?? rec?.kind ?? 'app',
      title: rec?.title ?? path,
      focused_min: Math.round(v.ms / 60_000),
      frames: v.frames,
    };
  });
}

function topUrlHosts(
  frames: Frame[],
  limit: number,
): Array<{ host: string; frames: number }> {
  const byHost = new Map<string, number>();
  for (const f of frames) {
    const host = urlHost(f.url);
    if (!host) continue;
    byHost.set(host, (byHost.get(host) ?? 0) + 1);
  }
  return [...byHost.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([host, frames]) => ({ host, frames }));
}

function collectCalendarEvents(frames: Frame[]): ExtractedCalendarEvent[] {
  const candidates: ExtractedCalendarEvent[] = [];
  for (const f of frames) {
    if (classifyFrame(f) !== 'calendar') continue;
    candidates.push(...extractCalendarEventsFromFrame(f));
  }
  return dedupeCalendarEvents(candidates);
}

function collectChatSnippets(frames: Frame[]): ExtractedChatSnippet[] {
  const out: ExtractedChatSnippet[] = [];
  for (const f of frames) {
    if (classifyFrame(f) !== 'chat') continue;
    const snippet = extractChatFromFrame(f);
    if (snippet) out.push(snippet);
  }
  return out;
}

function collectReviewItems(frames: Frame[]): ExtractedReviewItem[] {
  const out: ExtractedReviewItem[] = [];
  for (const f of frames) {
    if (classifyFrame(f) !== 'code-review') continue;
    const item = extractReviewItemFromFrame(f);
    if (item) out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Slack thread digest
// ---------------------------------------------------------------------------

export interface SlackThreadDigest {
  channel: string | null;
  source_app: string;
  observation_count: number;
  last_seen: string;
  representative_message: string;
  mentions: string[];
  looks_unanswered: boolean;
  example_frame_id: string;
}

function digestSlackThreads(
  snippets: ExtractedChatSnippet[],
  limit: number,
): SlackThreadDigest[] {
  // Group by channel + first-N message chars so a channel that
  // receives 30 frames worth of slightly different OCR still folds
  // into one entry.
  const byKey = new Map<
    string,
    {
      snippet: ExtractedChatSnippet;
      count: number;
      last: string;
      mentions: Set<string>;
      anyUnanswered: boolean;
    }
  >();
  for (const s of snippets) {
    const key = `${s.source_app}|${s.channel ?? ''}|${s.message.slice(0, 80).toLowerCase()}`;
    const slot = byKey.get(key);
    if (slot) {
      slot.count += 1;
      if (s.observed_at > slot.last) slot.last = s.observed_at;
      for (const m of s.mentions) slot.mentions.add(m);
      if (s.looks_unanswered) slot.anyUnanswered = true;
    } else {
      byKey.set(key, {
        snippet: s,
        count: 1,
        last: s.observed_at,
        mentions: new Set(s.mentions),
        anyUnanswered: s.looks_unanswered,
      });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.last.localeCompare(a.last) || b.count - a.count)
    .slice(0, limit)
    .map((v) => ({
      channel: v.snippet.channel,
      source_app: v.snippet.source_app,
      observation_count: v.count,
      last_seen: v.last,
      representative_message: v.snippet.message,
      mentions: [...v.mentions],
      looks_unanswered: v.anyUnanswered,
      example_frame_id: v.snippet.source_frame_id,
    }));
}

// ---------------------------------------------------------------------------
// Code-review digest
// ---------------------------------------------------------------------------

export interface ReviewItemDigest {
  ref: string;
  url: string;
  kind: ExtractedReviewItem['kind'];
  status: ExtractedReviewItem['status'];
  title: string | null;
  observation_count: number;
  first_seen: string;
  last_seen: string;
  example_frame_id: string;
}

function digestReviewItems(items: ExtractedReviewItem[]): ReviewItemDigest[] {
  const byRef = new Map<
    string,
    {
      item: ExtractedReviewItem;
      count: number;
      first: string;
      last: string;
      // Status seen most recently wins — "merged" trumps "open" if we
      // saw it merge later in the day.
      latestStatus: ExtractedReviewItem['status'];
      latestStatusAt: string;
    }
  >();
  for (const item of items) {
    const slot = byRef.get(item.ref);
    if (slot) {
      slot.count += 1;
      if (item.observed_at < slot.first) slot.first = item.observed_at;
      if (item.observed_at > slot.last) slot.last = item.observed_at;
      if (item.status && item.observed_at >= slot.latestStatusAt) {
        slot.latestStatus = item.status;
        slot.latestStatusAt = item.observed_at;
      }
      // Prefer non-null titles.
      if (!slot.item.title && item.title) slot.item = item;
    } else {
      byRef.set(item.ref, {
        item,
        count: 1,
        first: item.observed_at,
        last: item.observed_at,
        latestStatus: item.status,
        latestStatusAt: item.observed_at,
      });
    }
  }
  return [...byRef.values()]
    .sort((a, b) => b.last.localeCompare(a.last))
    .map((v) => ({
      ref: v.item.ref,
      url: v.item.url,
      kind: v.item.kind,
      status: v.latestStatus,
      title: v.item.title,
      observation_count: v.count,
      first_seen: v.first,
      last_seen: v.last,
      example_frame_id: v.item.source_frame_id,
    }));
}

// ---------------------------------------------------------------------------
// Open loops
// ---------------------------------------------------------------------------

export type OpenLoopKind = 'unanswered_chat' | 'open_pull_request' | 'open_issue';

export interface OpenLoop {
  kind: OpenLoopKind;
  /** Stable-ish identifier for the loop (channel name, PR ref, …). */
  ref: string;
  /** One-line description for an LLM or human consumer. */
  description: string;
  last_seen: string;
  example_frame_id: string;
  /** Where it came from (app or url). */
  source: string;
}

function buildOpenLoops(
  snippets: ExtractedChatSnippet[],
  reviewItems: ExtractedReviewItem[],
  limit: number,
): OpenLoop[] {
  const out: OpenLoop[] = [];

  // Slack: anything that looks unanswered or directly mentions someone.
  const slackBuckets = new Map<string, OpenLoop>();
  for (const s of snippets) {
    if (!isActionableChatLoop(s)) continue;
    const refKey = `${s.source_app}|${s.channel ?? 'DM'}|${s.message.slice(0, 60).toLowerCase()}`;
    const prev = slackBuckets.get(refKey);
    if (!prev || s.observed_at > prev.last_seen) {
      slackBuckets.set(refKey, {
        kind: 'unanswered_chat',
        ref: s.channel ?? 'DM',
        description: s.message,
        last_seen: s.observed_at,
        example_frame_id: s.source_frame_id,
        source: s.source_app,
      });
    }
  }
  out.push(...slackBuckets.values());

  // Code review: open / draft PRs and open issues seen but not merged
  // or closed at any point during the day.
  const byRef = new Map<string, ExtractedReviewItem>();
  const lastStatus = new Map<string, ExtractedReviewItem['status']>();
  for (const item of reviewItems) {
    const prev = byRef.get(item.ref);
    if (!prev || item.observed_at > prev.observed_at) byRef.set(item.ref, item);
    if (item.status) {
      // record the *latest* status we saw.
      const cur = lastStatus.get(item.ref);
      if (!cur || item.observed_at >= cur) lastStatus.set(item.ref, item.status);
    }
  }
  for (const [ref, item] of byRef.entries()) {
    const status = lastStatus.get(ref) ?? item.status;
    if (status === 'merged' || status === 'closed') continue;
    out.push({
      kind: item.kind === 'pull_request' ? 'open_pull_request' : 'open_issue',
      ref,
      description: `${item.kind === 'pull_request' ? 'PR' : 'Issue'} ${ref}${
        item.title ? `: ${item.title}` : ''
      }${status ? ` (${status})` : ''}`,
      last_seen: item.observed_at,
      example_frame_id: item.source_frame_id,
      source: item.source_app,
    });
  }

  return out
    .sort((a, b) => b.last_seen.localeCompare(a.last_seen))
    .slice(0, limit);
}

function isActionableChatLoop(snippet: ExtractedChatSnippet): boolean {
  const message = snippet.message.trim();
  if (!message) return false;
  if (isChatLoopNoise(message)) return false;
  if (snippet.looks_unanswered) return true;
  if (snippet.mentions.length === 0) return false;
  return /\b(ptal|please|can you|could you|would you|wdyt|review|take a look|thoughts|blocked|need|any update|any updates|let me know)\b/i.test(message);
}

function isChatLoopNoise(message: string): boolean {
  const lower = message.toLowerCase().trim();
  if (lower.length < 8) return true;
  if (/^message\s+(?:#[a-z0-9_-]+|[a-z][\w.-]*)\b/i.test(lower)) return true;
  if (/\bshift\s*\+\s*return\b/i.test(lower)) return true;
  if (/^s?\s*new\s*x?$/i.test(lower)) return true;
  if (/^as of today at \d{1,2}:\d{2}\s*(am|pm)\s+open in jira sync thread$/i.test(lower)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Session headlines (cheap NLP-free hint of what the session was about)
// ---------------------------------------------------------------------------

function sessionHeadline(
  session: ActivitySession,
  frames: Frame[],
): string | null {
  const titles = frames
    .map((f) => f.window_title)
    .filter((t): t is string => Boolean(t && t.trim()));
  if (titles.length === 0) return null;
  // Pick the most common title slug, then truncate.
  const counts = new Map<string, number>();
  for (const t of titles) {
    const key = t.replace(/\s+/g, ' ').trim().slice(0, 80);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ordered[0]?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Entity summary
// ---------------------------------------------------------------------------

export interface EntitySummary {
  path: string;
  kind: string;
  title: string;
  generated_at: string;
  window: { from: string | null; to: string | null };
  totals: {
    frames: number;
    focused_min: number;
    sessions: number;
    first_seen: string | null;
    last_seen: string | null;
  };
  top_window_titles: Array<{ title: string; frames: number }>;
  top_url_hosts: Array<{ host: string; frames: number }>;
  recent_sessions: Array<{
    id: string;
    started_at: string;
    ended_at: string;
    active_min: number;
    primary_app: string | null;
    headline: string | null;
  }>;
  calendar_events: ExtractedCalendarEvent[];
  open_loops: OpenLoop[];
  notes: string[];
}

export interface EntitySummaryOptions {
  since?: string;
  until?: string;
  /** Cap on per-section result lists. Default 8. */
  detail_limit?: number;
}

export async function buildEntitySummary(
  storage: IStorage,
  entityPath: string,
  options: EntitySummaryOptions = {},
): Promise<EntitySummary | null> {
  const entity = await storage.getEntity(entityPath);
  if (!entity) return null;
  const detailLimit = options.detail_limit ?? 8;

  // Pull a generous window of frames; the storage layer doesn't expose
  // a "frames in window for entity" query directly, so we widen and
  // filter in-process. This keeps the MCP layer fully decoupled from
  // storage internals.
  const allFrames = await storage.getEntityFrames(entityPath, 1000);
  const since = options.since ?? null;
  const until = options.until ?? null;
  const frames = allFrames.filter((f) => {
    if (since && f.timestamp < since) return false;
    if (until && f.timestamp > until) return false;
    return true;
  });

  const focusedMs = frames.reduce((acc, f) => acc + (f.duration_ms ?? 0), 0);
  const sessionIds = new Set<string>();
  for (const f of frames) {
    if (f.activity_session_id) sessionIds.add(f.activity_session_id);
  }
  const sessions = await collectSessions(storage, sessionIds);
  const sortedSessions = sessions
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, detailLimit);

  const top_window_titles = topField(
    frames,
    (f) => (f.window_title ?? '').trim(),
    detailLimit,
  ).map(([title, frames]) => ({ title, frames }));
  const top_url_hosts = topUrlHosts(frames, detailLimit);

  const calendar_events = dedupeCalendarEvents(
    frames
      .filter((f) => classifyFrame(f) === 'calendar')
      .flatMap((f) => extractCalendarEventsFromFrame(f)),
  ).slice(0, detailLimit);

  const slackSnippets = frames
    .filter((f) => classifyFrame(f) === 'chat')
    .map((f) => extractChatFromFrame(f))
    .filter((s): s is ExtractedChatSnippet => Boolean(s));
  const reviewItems = frames
    .filter((f) => classifyFrame(f) === 'code-review')
    .map((f) => extractReviewItemFromFrame(f))
    .filter((i): i is ExtractedReviewItem => Boolean(i));
  const open_loops = buildOpenLoops(slackSnippets, reviewItems, detailLimit);

  const notes: string[] = [];
  if (frames.length === 0) {
    notes.push(
      since || until
        ? 'No frames for this entity in the requested window.'
        : 'No frames for this entity.',
    );
  } else if (allFrames.length === 1000) {
    notes.push(
      'Result truncated at 1000 source frames; pass `since` to narrow the window.',
    );
  }

  return {
    path: entity.path,
    kind: entity.kind,
    title: entity.title,
    generated_at: new Date().toISOString(),
    window: { from: since, to: until },
    totals: {
      frames: frames.length,
      focused_min: Math.round(focusedMs / 60_000),
      sessions: sessionIds.size,
      first_seen: frames[0]?.timestamp ?? null,
      last_seen: frames[frames.length - 1]?.timestamp ?? null,
    },
    top_window_titles,
    top_url_hosts,
    recent_sessions: sortedSessions.map((session) => ({
      id: session.id,
      started_at: session.started_at,
      ended_at: session.ended_at,
      active_min: Math.round(session.active_ms / 60_000),
      primary_app: session.primary_app,
      headline: sessionHeadline(
        session,
        frames.filter((f) => f.activity_session_id === session.id),
      ),
    })),
    calendar_events,
    open_loops,
    notes,
  };
}

async function collectSessions(
  storage: IStorage,
  ids: Set<string>,
): Promise<ActivitySession[]> {
  // No bulk-fetch in IStorage, but session ids in a per-entity window
  // are typically dozens at most. Fetch in parallel and filter null.
  const out = await Promise.all(
    [...ids].map(async (id) => {
      try {
        return await storage.getSession(id);
      } catch {
        return null;
      }
    }),
  );
  return out.filter((s): s is ActivitySession => Boolean(s));
}

function topField(
  frames: Frame[],
  getValue: (f: Frame) => string,
  limit: number,
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const f of frames) {
    const v = getValue(f);
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}
