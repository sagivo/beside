import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type {
  IStorage,
  IIndexStrategy,
  IModelAdapter,
  Logger,
  RawEventType,
  Frame,
  EntityKind,
  FrameTextSource,
} from '@cofounderos/interfaces';
import { renderJournalMarkdown } from '@cofounderos/interfaces';
import { isSelfFrame } from './parsers.js';
import {
  buildDailySummary,
  buildEntitySummary,
  type OpenLoop,
} from './digest.js';

export interface McpServices {
  storage: IStorage;
  strategy: IIndexStrategy;
  model?: IModelAdapter;
  embeddingModelName?: string;
  triggerReindex?: (full?: boolean) => Promise<void>;
}

export interface McpServerOptions {
  textExcerptChars?: number;
}

type FrameMatch = {
  frame: Frame;
  retrieval: 'keyword' | 'semantic' | 'keyword+semantic';
  semanticScore?: number;
  context?: {
    before: Frame[];
    after: Frame[];
  };
};

const DEFAULT_FRAME_TEXT_EXCERPT_CHARS = 5000;
const DEFAULT_SEARCH_FRAMES_RESPONSE_CHARS = 60000;
const MAX_SEARCH_FRAMES_RESPONSE_CHARS = 90000;
const MIN_SEARCH_FRAME_TEXT_EXCERPT_CHARS = 600;

const RAW_EVENT_TYPES: readonly RawEventType[] = [
  'screenshot',
  'audio_transcript',
  'window_focus',
  'window_blur',
  'url_change',
  'click',
  'keystroke_summary',
  'idle_start',
  'idle_end',
  'app_launch',
  'app_quit',
  'clipboard_summary',
];

const ENTITY_KINDS: readonly EntityKind[] = [
  'project',
  'repo',
  'meeting',
  'contact',
  'channel',
  'doc',
  'webpage',
  'app',
];

const FRAME_TEXT_SOURCES: readonly FrameTextSource[] = [
  'ocr',
  'accessibility',
  'ocr_accessibility',
  'audio',
  'none',
];

export function createMcpServer(
  services: McpServices,
  logger: Logger,
  options: McpServerOptions = {},
): McpServer {
  const log = logger.child('mcp-server');
  const textExcerptChars = normaliseTextExcerptChars(options.textExcerptChars);
  const server = new McpServer({
    name: 'cofounderos',
    version: '0.2.0',
  });

  server.registerTool(
    'search_memory',
    {
      description:
        'Blended search: returns the best matching frames (specific moments) and wiki pages (synthesised summaries). Use this as the default entrypoint. CofounderOS dashboard frames are filtered out by default — pass `exclude_self: false` to include them.',
      inputSchema: {
        query: z.string().describe('Natural-language search query.'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results per category, default 5.'),
        exclude_self: z
          .boolean()
          .optional()
          .describe('Drop frames captured from the CofounderOS dashboard itself. Default true.'),
      },
    },
    async ({ query, limit, exclude_self }) => {
      const cap = limit ?? 5;
      const dropSelf = exclude_self !== false;
      // Over-fetch when filtering self frames so we still return `cap`
      // useful results once the dashboard noise has been stripped.
      const fetchCap = dropSelf ? cap * 2 : cap;

      // 1. Frame-level retrieval — the "specific moment" answers.
      // Keyword FTS remains the precision path; semantic search adds
      // conceptual recall for queries whose wording differs from what
      // was on screen.
      let frames: Frame[] = [];
      let semanticFrames: Array<{ frame: Frame; score: number }> = [];
      try {
        frames = await services.storage.searchFrames({ text: query, limit: fetchCap });
      } catch (err) {
        log.debug('searchFrames unavailable', { err: String(err) });
      }
      semanticFrames = await semanticFrameSearch(services, query, fetchCap);
      if (dropSelf) {
        frames = frames.filter((f) => !isSelfFrame(f));
        semanticFrames = semanticFrames.filter((s) => !isSelfFrame(s.frame));
      }
      const blendedFrames = blendFrameMatches(frames, semanticFrames, cap);

      // 2. Wiki page retrieval — the "synthesised summary" answers.
      const pages = await listAllStrategyPages(services.strategy);
      const ranked = pages
        .map((p) => ({ page: p, score: scorePage(p.path, p.content, query) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, cap);

      const result = {
        query,
        frame_matches: blendedFrames.map((m) => ({
          ...framePreview(m.frame, textExcerptChars, query),
          retrieval: m.retrieval,
          semantic_score: m.semanticScore,
        })),
        page_matches: ranked.map((r) => ({
          path: r.page.path,
          score: r.score,
          excerpt: extractExcerpt(r.page.content, query),
          last_updated: r.page.lastUpdated,
          source_event_count: r.page.sourceEventIds.length,
        })),
      };
      log.debug(
        `search_memory "${query}" → ${blendedFrames.length} frames, ${ranked.length} pages`,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    'search_frames',
    {
      description:
        'Search captured screen frames directly via FTS5 against OCR text + window title + URL. Returns specific moments with screenshot paths. Use when you need a precise "when did I see X" answer.',
      inputSchema: {
        query: z.string().describe('Free-text query.'),
        from: z.string().optional().describe('ISO timestamp lower bound.'),
        to: z.string().optional().describe('ISO timestamp upper bound.'),
        day: z.string().optional().describe('Restrict to one YYYY-MM-DD day.'),
        app: z.string().optional().describe('Restrict to a single app name.'),
        entity_path: z.string().optional().describe('Restrict to frames resolved to this entity path.'),
        entity_kind: z
          .enum(ENTITY_KINDS as [EntityKind, ...EntityKind[]])
          .optional()
          .describe('Restrict to an entity kind such as project, repo, doc, webpage, or app.'),
        activity_session_id: z
          .string()
          .optional()
          .describe('Restrict to frames in a specific activity session id.'),
        url_domain: z.string().optional().describe('Restrict to URLs containing this domain/host.'),
        text_source: z
          .enum(FRAME_TEXT_SOURCES as [FrameTextSource, ...FrameTextSource[]])
          .optional()
          .describe('Restrict by frame text source.'),
        semantic: z.boolean().optional().describe('Also include semantic embedding matches. Default true.'),
        limit: z.number().int().min(1).max(50).optional(),
        offset: z.number().int().min(0).max(500).optional().describe('Skip this many blended results.'),
        include_context: z
          .boolean()
          .optional()
          .describe('Include nearby frames around each returned hit. Default false.'),
        context_before: z.number().int().min(0).max(10).optional().describe('Context frames before each hit.'),
        context_after: z.number().int().min(0).max(10).optional().describe('Context frames after each hit.'),
        max_response_chars: z
          .number()
          .int()
          .min(2000)
          .max(MAX_SEARCH_FRAMES_RESPONSE_CHARS)
          .optional()
          .describe(
            `Approximate maximum JSON response characters, default ${DEFAULT_SEARCH_FRAMES_RESPONSE_CHARS}. Results are packed by relevance.`,
          ),
        exclude_self: z
          .boolean()
          .optional()
          .describe('Drop frames captured from the CofounderOS dashboard itself. Default true.'),
      },
    },
    async ({
      query,
      from,
      to,
      day,
      app,
      entity_path,
      entity_kind,
      activity_session_id,
      url_domain,
      text_source,
      semantic,
      limit,
      offset,
      include_context,
      context_before,
      context_after,
      max_response_chars,
      exclude_self,
    }) => {
      const requestedLimit = limit ?? 25;
      const requestedOffset = offset ?? 0;
      const dropSelf = exclude_self !== false;
      const candidateLimit = requestedLimit + requestedOffset;
      // Over-fetch when filtering self frames so the post-filter list
      // still has enough rows to satisfy the requested page.
      const fetchLimit = dropSelf ? candidateLimit * 2 : candidateLimit;
      const filters = {
        from,
        to,
        day,
        apps: app ? [app] : undefined,
        entityPath: entity_path,
        entityKind: entity_kind,
        activitySessionId: activity_session_id,
        urlDomain: url_domain,
        textSource: text_source,
      };
      let frames = await services.storage.searchFrames({
        text: query,
        ...filters,
        limit: fetchLimit,
      });
      let semanticFrames = semantic === false
        ? []
        : await semanticFrameSearch(services, query, fetchLimit, filters);
      if (dropSelf) {
        frames = frames.filter((f) => !isSelfFrame(f));
        semanticFrames = semanticFrames.filter((s) => !isSelfFrame(s.frame));
      }
      const blended = blendFrameMatches(frames, semanticFrames, candidateLimit)
        .slice(requestedOffset, requestedOffset + requestedLimit);
      if (include_context) {
        await attachFrameContexts(
          services,
          blended,
          context_before ?? 2,
          context_after ?? 2,
        );
      }
      const result = buildSearchFramesResult(
        query,
        blended,
        normaliseSearchResponseChars(max_response_chars),
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_frame_context',
    {
      description:
        'Return the chronological neighbourhood around a specific frame — a "scrub the timeline" view. Use after `search_frames` to reconstruct what was happening just before / after a moment.',
      inputSchema: {
        frame_id: z.string().describe('Frame id from a previous search result.'),
        before: z.number().int().min(0).max(50).optional().describe('Frames before, default 5.'),
        after: z.number().int().min(0).max(50).optional().describe('Frames after, default 5.'),
      },
    },
    async ({ frame_id, before, after }) => {
      const ctx = await services.storage.getFrameContext(
        frame_id,
        before ?? 5,
        after ?? 5,
      );
      if (!ctx) {
        return {
          content: [{ type: 'text', text: `No frame found with id "${frame_id}".` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                anchor: framePreview(ctx.anchor, textExcerptChars),
                before: ctx.before.map((frame) => framePreview(frame, textExcerptChars)),
                after: ctx.after.map((frame) => framePreview(frame, textExcerptChars)),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_journal',
    {
      description:
        'All frames captured on a given day, oldest first, rendered as a chronological markdown timeline. Use to answer "what did I work on on date X".',
      inputSchema: {
        day: z.string().describe('Day in YYYY-MM-DD format.'),
      },
    },
    async ({ day }) => {
      const frames = await services.storage.getJournal(day);
      let sessions: Awaited<ReturnType<typeof services.storage.listSessions>> = [];
      try {
        sessions = await services.storage.listSessions({
          day,
          order: 'chronological',
          limit: 500,
        });
      } catch {
        sessions = [];
      }
      const md = renderJournalMarkdown(day, frames, { sessions });
      return {
        content: [{ type: 'text', text: md }],
      };
    },
  );

  server.registerTool(
    'get_page',
    {
      description: 'Read a specific wiki page by its relative path (e.g. "projects/auth-feature").',
      inputSchema: {
        path: z.string().describe('Relative page path, with or without .md extension.'),
      },
    },
    async ({ path }) => {
      const normalised = path.endsWith('.md') ? path : `${path}.md`;
      const page = await services.strategy.readPage(normalised);
      if (!page) {
        return {
          content: [{ type: 'text', text: `No page found at "${normalised}".` }],
          isError: true,
        };
      }
      return {
        content: [
          { type: 'text', text: `# ${normalised}\n\n${page.content}` },
        ],
      };
    },
  );

  server.registerTool(
    'get_index',
    {
      description: 'Return the contents of the root index.md — the wiki entry point.',
      inputSchema: {},
    },
    async () => {
      const text = await services.strategy.readRootIndex();
      return {
        content: [{ type: 'text', text: text || '_(index empty — no events indexed yet)_' }],
      };
    },
  );

  server.registerTool(
    'list_entities',
    {
      description:
        'List remembered entities (projects, repos, docs, webpages, apps, etc.) by recent activity. When `query` is set, uses FTS5 BM25 ranking; otherwise sorts by last activity. Use before drilling into an entity-specific history.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            'Optional free-text query against entity title and path. FTS-ranked when set.',
          ),
        kind: z
          .enum(ENTITY_KINDS as [EntityKind, ...EntityKind[]])
          .optional()
          .describe('Restrict to one entity kind.'),
        since_last_seen: z.string().optional().describe('Only entities last seen on or after this ISO timestamp.'),
        include_noise: z
          .boolean()
          .optional()
          .describe(
            'Include system-noise app entities (apps/electron, apps/loginwindow, etc.). Defaults to false; only set when debugging.',
          ),
        limit: z.number().int().min(1).max(500).optional().describe('Max entities to return. Default 100.'),
      },
    },
    async ({ query, kind, since_last_seen, include_noise, limit }) => {
      const cap = limit ?? 100;
      let entities;
      if (query && query.trim().length > 0) {
        // FTS5-ranked path (skips noise apps unless include_noise is set).
        entities = await services.storage.searchEntities({
          text: query,
          kind,
          limit: cap,
          includeNoise: include_noise,
        });
        // Optional recency cutoff is applied client-side here so we
        // don't have to push it into the FTS query.
        if (since_last_seen) {
          entities = entities.filter((e) => e.lastSeen >= since_last_seen);
        }
      } else {
        entities = await services.storage.listEntities({
          kind,
          sinceLastSeen: since_last_seen,
          limit: cap,
        });
      }
      const result = entities.map((entity) => ({
        path: entity.path,
        kind: entity.kind,
        title: entity.title,
        first_seen: entity.firstSeen,
        last_seen: entity.lastSeen,
        focused_min: Math.round(entity.totalFocusedMs / 60_000),
        frame_count: entity.frameCount,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    'get_entity',
    {
      description:
        'Read one remembered entity by stable path. Optionally include its earliest frames as evidence.',
      inputSchema: {
        path: z.string().describe('Stable entity path, e.g. "projects/cofounderos".'),
        include_frames: z.boolean().optional().describe('Include frames belonging to this entity. Default false.'),
        frame_limit: z.number().int().min(1).max(200).optional().describe('Max frames when include_frames is true.'),
      },
    },
    async ({ path, include_frames, frame_limit }) => {
      const entity = await services.storage.getEntity(path);
      if (!entity) {
        return {
          content: [{ type: 'text', text: `Entity "${path}" not found.` }],
          isError: true,
        };
      }
      const frames = include_frames
        ? await services.storage.getEntityFrames(path, frame_limit ?? 50)
        : [];
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                path: entity.path,
                kind: entity.kind,
                title: entity.title,
                first_seen: entity.firstSeen,
                last_seen: entity.lastSeen,
                focused_min: Math.round(entity.totalFocusedMs / 60_000),
                frame_count: entity.frameCount,
                frames: frames.map((frame) => framePreview(frame, textExcerptChars)),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_entity_frames',
    {
      description:
        'Return frames for a remembered entity, oldest first. Use after list_entities/get_entity to inspect the evidence for a project, repo, doc, webpage, or app.',
      inputSchema: {
        path: z.string().describe('Stable entity path, e.g. "projects/cofounderos".'),
        limit: z.number().int().min(1).max(500).optional().describe('Max frames to return. Default 100.'),
      },
    },
    async ({ path, limit }) => {
      const frames = await services.storage.getEntityFrames(path, limit ?? 100);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                path,
                count: frames.length,
                frames: frames.map((frame) => framePreview(frame, textExcerptChars)),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'list_entity_neighbours',
    {
      description:
        'List entities that recurrently appear in the same activity sessions as the given entity — the working knowledge graph. Use to answer "who do I work with on X?", "what projects involve channel Y?", "what apps are part of my work on Z?". Ranks by shared session count, then combined attention time, then recency.',
      inputSchema: {
        path: z
          .string()
          .describe('Anchor entity path, e.g. "projects/cofounderos" or "contacts/milan-lazic".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Max neighbours to return. Default 25.'),
      },
    },
    async ({ path, limit }) => {
      const neighbours = await services.storage.listEntityCoOccurrences(path, limit ?? 25);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                anchor: path,
                count: neighbours.length,
                neighbours: neighbours.map((n) => ({
                  path: n.path,
                  kind: n.kind,
                  title: n.title,
                  shared_sessions: n.sharedSessions,
                  shared_focused_min: Math.round(n.sharedFocusedMs / 60_000),
                  last_shared_at: n.lastSharedAt,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_entity_timeline',
    {
      description:
        'Return per-day or per-hour attention buckets for an entity — frame count, focused minutes, and distinct activity sessions per bucket. Powers "when have I worked on X this week?" and chart-driving UIs. Buckets are returned newest first.',
      inputSchema: {
        path: z.string().describe('Entity path, e.g. "projects/cofounderos".'),
        granularity: z
          .enum(['day', 'hour'])
          .optional()
          .describe('Bucket size. Default "day".'),
        from: z.string().optional().describe('Inclusive lower bound (ISO timestamp).'),
        to: z.string().optional().describe('Inclusive upper bound (ISO timestamp).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Max buckets returned. Default 30.'),
      },
    },
    async ({ path, granularity, from, to, limit }) => {
      const buckets = await services.storage.getEntityTimeline(path, {
        granularity,
        from,
        to,
        limit,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                path,
                granularity: granularity ?? 'day',
                count: buckets.length,
                buckets: buckets.map((b) => ({
                  bucket: b.bucket,
                  frames: b.frames,
                  focused_min: Math.round(b.focusedMs / 60_000),
                  sessions: b.sessions,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'query_raw_events',
    {
      description: 'Query raw captured events directly (bypasses the index).',
      inputSchema: {
        from: z.string().optional().describe('ISO timestamp lower bound.'),
        to: z.string().optional().describe('ISO timestamp upper bound.'),
        app: z.string().optional().describe('Filter to a single app name.'),
        type: z.enum(RAW_EVENT_TYPES as [RawEventType, ...RawEventType[]]).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ from, to, app, type, limit }) => {
      const events = await services.storage.readEvents({
        from,
        to,
        apps: app ? [app] : undefined,
        types: type ? [type] : undefined,
        limit: limit ?? 50,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(events, null, 2) }],
      };
    },
  );

  server.registerTool(
    'list_sessions',
    {
      description:
        'List recent activity sessions — continuous focus runs separated by idle gaps. Each session reports its time range, primary entity, primary app, frame count, and active duration. Best entrypoint for "what was I working on this morning / this week" queries.',
      inputSchema: {
        day: z
          .string()
          .optional()
          .describe('Restrict to a single YYYY-MM-DD. Omit for cross-day results.'),
        from: z
          .string()
          .optional()
          .describe('Sessions starting on or after this ISO timestamp.'),
        to: z
          .string()
          .optional()
          .describe('Sessions starting on or before this ISO timestamp.'),
        limit: z.number().int().positive().optional().describe('Max sessions to return. Default 50.'),
        order: z
          .enum(['recent', 'chronological'])
          .optional()
          .describe('"recent" (default) returns newest first; "chronological" oldest first.'),
      },
    },
    async ({ day, from, to, limit, order }) => {
      try {
        const sessions = await services.storage.listSessions({
          day,
          from,
          to,
          limit: limit ?? 50,
          order,
        });
        const summaries = sessions.map((s) => ({
          id: s.id,
          started_at: s.started_at,
          ended_at: s.ended_at,
          day: s.day,
          duration_min: Math.round(s.duration_ms / 60_000),
          active_min: Math.round(s.active_ms / 60_000),
          frames: s.frame_count,
          primary_entity: s.primary_entity_path,
          primary_entity_kind: s.primary_entity_kind,
          primary_app: s.primary_app,
          entities: s.entities,
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify(summaries, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `Activity sessions not yet available (${String(err)}). Try trigger_reindex first.`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'get_activity_session',
    {
      description:
        'Fetch a single activity session by id, including every frame it contains as a markdown timeline. Pair with `list_sessions` to drill into a specific focus block.',
      inputSchema: {
        id: z.string().describe('Activity session id (starts with "act_").'),
      },
    },
    async ({ id }) => {
      const session = await services.storage.getSession(id);
      if (!session) {
        return {
          content: [{ type: 'text', text: `Session ${id} not found.` }],
        };
      }
      const frames = await services.storage.getSessionFrames(id);
      const md = renderJournalMarkdown(session.day, frames, {
        sessions: [session],
      });
      return {
        content: [
          { type: 'text', text: JSON.stringify(session, null, 2) },
          { type: 'text', text: md },
        ],
      };
    },
  );

  server.registerTool(
    'get_session',
    {
      description: 'Reconstruct a contiguous time range as the ordered list of raw events plus screenshot asset paths. For *activity sessions* (what the user was focused on, with primary entity etc.) use `list_sessions` / `get_activity_session` instead. This tool is kept for time-range queries against raw events.',
      inputSchema: {
        from: z.string().describe('ISO timestamp start.'),
        to: z.string().describe('ISO timestamp end.'),
      },
    },
    async ({ from, to }) => {
      const events = await services.storage.readEvents({ from, to, limit: 1000 });
      const screenshotPaths = events
        .filter((e) => e.type === 'screenshot' && e.asset_path)
        .map((e) => e.asset_path as string);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ events, screenshotPaths }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_daily_summary',
    {
      description:
        'One-shot digest for a single day (YYYY-MM-DD): totals, top apps, top entities, top URL hosts, sessions with headlines, calendar events parsed from screenshots, Slack thread observations, code-review queue, and open loops. Frames captured of the CofounderOS dashboard itself are filtered out by default — pass `include_self: true` to include them.',
      inputSchema: {
        day: z.string().describe('Day in YYYY-MM-DD format.'),
        include_self: z
          .boolean()
          .optional()
          .describe('Include CofounderOS dashboard frames in aggregations. Default false.'),
        open_loops_limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Cap on the open-loops list. Default 10.'),
      },
    },
    async ({ day, include_self, open_loops_limit }) => {
      const summary = await buildDailySummary(services.storage, day, {
        include_self,
        open_loops_limit,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      };
    },
  );

  server.registerTool(
    'get_calendar_events',
    {
      description:
        'Extract structured calendar events (title + time label + source frame) from frames captured on a calendar UI for a given day. Heuristic — useful as a fast-path before reading raw OCR. Pair with `get_frame_context` to verify any individual extraction.',
      inputSchema: {
        day: z.string().describe('Day in YYYY-MM-DD format.'),
        include_self: z
          .boolean()
          .optional()
          .describe('Include CofounderOS dashboard frames. Default false.'),
      },
    },
    async ({ day, include_self }) => {
      const summary = await buildDailySummary(services.storage, day, {
        include_self,
        open_loops_limit: 0,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                day,
                count: summary.calendar_events.length,
                events: summary.calendar_events,
                notes: summary.notes,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_open_loops',
    {
      description:
        '"What\'s still on my plate?" — surfaces unanswered Slack messages (questions, mentions) and open / draft GitHub PRs and issues observed in the requested window. Defaults to today. Heuristic: combine with `search_frames` to inspect the source moment for any item.',
      inputSchema: {
        day: z
          .string()
          .optional()
          .describe('Single YYYY-MM-DD. Mutually exclusive with `since`/`until`. Defaults to today (UTC).'),
        since: z.string().optional().describe('ISO timestamp lower bound.'),
        until: z.string().optional().describe('ISO timestamp upper bound.'),
        kinds: z
          .array(z.enum(['unanswered_chat', 'open_pull_request', 'open_issue']))
          .optional()
          .describe('Restrict to a subset of loop kinds.'),
        limit: z.number().int().min(1).max(50).optional().describe('Max loops returned. Default 15.'),
        include_self: z
          .boolean()
          .optional()
          .describe('Include CofounderOS dashboard frames. Default false.'),
      },
    },
    async ({ day, since, until, kinds, limit, include_self }) => {
      const cap = limit ?? 15;
      const days = resolveDayRange({ day, since, until });
      const kindsSet = kinds ? new Set(kinds) : null;
      // Each day's digest is independent, so build them sequentially
      // and concatenate. Over-fetch per day so we can rank+dedupe
      // again across all days below.
      const acc: OpenLoop[] = [];
      for (const d of days) {
        const summary = await buildDailySummary(services.storage, d, {
          include_self,
          open_loops_limit: cap * 2,
        });
        for (const loop of summary.open_loops) {
          if (kindsSet && !kindsSet.has(loop.kind)) continue;
          if (since && loop.last_seen < since) continue;
          if (until && loop.last_seen > until) continue;
          acc.push(loop);
        }
      }
      // Final dedupe across days on (kind, ref, head-of-description) —
      // keep the most recent observation for each loop.
      const byRef = new Map<string, OpenLoop>();
      for (const loop of acc) {
        const key = `${loop.kind}|${loop.ref}|${loop.description.slice(0, 50)}`;
        const prev = byRef.get(key);
        if (!prev || loop.last_seen > prev.last_seen) byRef.set(key, loop);
      }
      const ranked = [...byRef.values()]
        .sort((a, b) => b.last_seen.localeCompare(a.last_seen))
        .slice(0, cap);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                window: {
                  days,
                  since: since ?? null,
                  until: until ?? null,
                },
                count: ranked.length,
                open_loops: ranked,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_entity_summary',
    {
      description:
        'Fresh, focused rollup for one remembered entity (project / repo / channel / contact / app) in an optional time window. Returns totals, top window titles, top URL hosts, recent sessions with headlines, calendar events tied to the entity, and any open loops detected in its frames.',
      inputSchema: {
        path: z.string().describe('Stable entity path, e.g. "projects/cofounderos".'),
        since: z.string().optional().describe('Inclusive lower bound (ISO timestamp).'),
        until: z.string().optional().describe('Inclusive upper bound (ISO timestamp).'),
        detail_limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Cap on each per-section list (top titles, sessions, events). Default 8.'),
      },
    },
    async ({ path, since, until, detail_limit }) => {
      const summary = await buildEntitySummary(services.storage, path, {
        since,
        until,
        detail_limit,
      });
      if (!summary) {
        return {
          content: [{ type: 'text', text: `Entity "${path}" not found.` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      };
    },
  );

  server.registerTool(
    'get_slack_activity',
    {
      description:
        'Structured digest of Slack / chat frames observed on a day: per-channel observation count, the last representative message OCR\'d, mentions, and whether the visible message looks unanswered. Heuristic — pair with `get_frame_context` to verify any single conversation. Frames from the CofounderOS dashboard are excluded by default.',
      inputSchema: {
        day: z.string().describe('Day in YYYY-MM-DD format.'),
        channel: z
          .string()
          .optional()
          .describe('Restrict to one Slack channel name (with or without leading "#").'),
        limit: z.number().int().min(1).max(50).optional().describe('Max threads returned. Default 12.'),
        include_self: z
          .boolean()
          .optional()
          .describe('Include CofounderOS dashboard frames. Default false.'),
      },
    },
    async ({ day, channel, limit, include_self }) => {
      const summary = await buildDailySummary(services.storage, day, {
        include_self,
        open_loops_limit: 0,
      });
      const cap = limit ?? 12;
      const targetChannel = channel
        ? `#${channel.replace(/^#/, '').toLowerCase()}`
        : null;
      const filtered = targetChannel
        ? summary.slack_threads.filter(
            (t) => (t.channel ?? '').toLowerCase() === targetChannel,
          )
        : summary.slack_threads;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                day,
                channel: targetChannel,
                count: filtered.length,
                threads: filtered.slice(0, cap),
                notes: summary.notes,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'trigger_reindex',
    {
      description: 'Trigger an indexing pass. Optionally a full re-index from raw data.',
      inputSchema: {
        full: z.boolean().optional().describe('If true, wipe the index and rebuild from all raw events.'),
      },
    },
    async ({ full }) => {
      if (!services.triggerReindex) {
        return {
          content: [
            { type: 'text', text: 'reindex unavailable in this process — start the agent to enable.' },
          ],
          isError: true,
        };
      }
      await services.triggerReindex(full ?? false);
      return {
        content: [
          { type: 'text', text: `reindex queued (full=${full ?? false}).` },
        ],
      };
    },
  );

  return server;
}

/**
 * Resolve a flexible {day, since, until} input to a list of YYYY-MM-DD
 * day keys. Used by tools that aggregate per-day digests across a
 * window. We deliberately cap the range at 14 days so a stray
 * unbounded query can't fan out to year-long aggregations.
 */
const MAX_DAY_RANGE = 14;

function resolveDayRange(input: {
  day?: string;
  since?: string;
  until?: string;
}): string[] {
  if (input.day) return [input.day];
  const today = todayKey();
  const fromDay = input.since ? input.since.slice(0, 10) : today;
  const toDay = input.until ? input.until.slice(0, 10) : today;
  if (toDay < fromDay) return [today];
  const out: string[] = [];
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return [today];
  const days = Math.min(MAX_DAY_RANGE, Math.floor((toMs - fromMs) / 86_400_000) + 1);
  for (let i = 0; i < days; i++) {
    const ms = fromMs + i * 86_400_000;
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function attachFrameContexts(
  services: McpServices,
  matches: FrameMatch[],
  before: number,
  after: number,
): Promise<void> {
  await Promise.all(matches.map(async (match) => {
    const ctx = await services.storage.getFrameContext(match.frame.id, before, after);
    if (!ctx) return;
    match.context = {
      before: ctx.before,
      after: ctx.after,
    };
  }));
}

async function listAllStrategyPages(strategy: IIndexStrategy) {
  // The IIndexStrategy interface intentionally doesn't expose a list method
  // in the published surface — but the Karpathy implementation does. We
  // call it via the well-known `getState().rootPath` and walk the tree
  // in-process here to keep the MCP server fully decoupled from any one
  // strategy. For now, we rely on the strategy's `readPage` plus walking
  // the on-disk tree.
  const state = await strategy.getState();
  const out: Array<{ path: string; content: string; lastUpdated: string; sourceEventIds: string[] }> = [];
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const root = state.rootPath;
  const walk = async (relDir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = path.join(relDir, e.name);
      if (e.isDirectory()) {
        await walk(rel);
      } else if (
        e.isFile() &&
        e.name.endsWith('.md') &&
        e.name !== 'index.md' &&
        e.name !== 'log.md'
      ) {
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
    }
  };
  await walk('.');
  return out;
}

function framePreview(frame: Frame, textExcerptChars: number, query?: string): Record<string, unknown> {
  return {
    id: frame.id,
    timestamp: frame.timestamp,
    day: frame.day,
    app: frame.app,
    window_title: frame.window_title,
    url: frame.url,
    entity_path: frame.entity_path,
    entity_kind: frame.entity_kind,
    activity_session_id: frame.activity_session_id,
    asset_path: frame.asset_path,
    text_excerpt: frame.text
      ? query
        ? extractRelevantTextExcerpt(frame.text, query, textExcerptChars)
        : truncate(frame.text, textExcerptChars)
      : null,
    text_chars: frame.text ? frame.text.length : 0,
    text_source: frame.text_source,
    duration_ms: frame.duration_ms,
  };
}

function normaliseTextExcerptChars(value: number | undefined): number {
  if (!Number.isFinite(value) || value == null) {
    return DEFAULT_FRAME_TEXT_EXCERPT_CHARS;
  }
  return Math.max(0, Math.floor(value));
}

function normaliseSearchResponseChars(value: number | undefined): number {
  if (!Number.isFinite(value) || value == null) {
    return DEFAULT_SEARCH_FRAMES_RESPONSE_CHARS;
  }
  return Math.min(MAX_SEARCH_FRAMES_RESPONSE_CHARS, Math.max(2000, Math.floor(value)));
}


function truncate(s: string, n: number): string {
  if (n <= 0) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function buildSearchFramesResult(
  query: string,
  matches: FrameMatch[],
  maxResponseChars: number,
): Record<string, unknown> {
  const responseBudget = Math.max(1000, maxResponseChars - 512);
  const result = {
    query,
    count: matches.length,
    returned_count: 0,
    omitted_count: 0,
    max_response_chars: maxResponseChars,
    truncated: false,
    frames: [] as Record<string, unknown>[],
  };

  for (const match of matches) {
    const preview = largestFittingFrameSearchPreview(match, query, result, responseBudget);
    if (preview) {
      result.frames.push(preview);
      result.returned_count = result.frames.length;
      continue;
    }

    result.omitted_count += 1;
    result.truncated = true;
  }

  result.returned_count = result.frames.length;
  result.omitted_count = matches.length - result.frames.length;
  result.truncated = result.omitted_count > 0;
  return result;
}

function largestFittingFrameSearchPreview(
  match: FrameMatch,
  query: string,
  result: { frames: Record<string, unknown>[] },
  maxResponseChars: number,
): Record<string, unknown> | null {
  const maxTextChars = Math.max(match.frame.text?.length ?? 0, MIN_SEARCH_FRAME_TEXT_EXCERPT_CHARS);
  let lo = 0;
  let hi = maxTextChars;
  let best: Record<string, unknown> | null = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const preview = frameSearchPreview(match, mid, query);
    if (fitsSearchResponse(result, preview, maxResponseChars)) {
      best = preview;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return best;
}

function frameSearchPreview(
  match: FrameMatch,
  textExcerptChars: number,
  query: string,
): Record<string, unknown> {
  const preview: Record<string, unknown> = {
    ...framePreview(match.frame, textExcerptChars, query),
    retrieval: match.retrieval,
    semantic_score: match.semanticScore,
  };
  if (match.context) {
    const contextExcerptChars = Math.min(textExcerptChars, 1000);
    preview.context = {
      before: match.context.before.map((frame) => framePreview(frame, contextExcerptChars, query)),
      after: match.context.after.map((frame) => framePreview(frame, contextExcerptChars, query)),
    };
  }
  return preview;
}

function fitsSearchResponse(
  result: { frames: Record<string, unknown>[] },
  frame: Record<string, unknown>,
  maxResponseChars: number,
): boolean {
  return JSON.stringify(
    {
      ...result,
      returned_count: result.frames.length + 1,
      frames: [...result.frames, frame],
    },
    null,
    2,
  ).length <= maxResponseChars;
}

function extractRelevantTextExcerpt(text: string, query: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;

  const lower = text.toLowerCase();
  const exactQuery = query.trim().toLowerCase();
  let bestIndex = exactQuery ? lower.indexOf(exactQuery) : -1;

  if (bestIndex === -1) {
    bestIndex = bestQueryWindowStart(lower, queryTerms(query), maxChars);
  }

  if (bestIndex === -1) return truncate(text, maxChars);

  const halfWindow = Math.floor(maxChars / 2);
  const start = Math.max(0, Math.min(text.length - maxChars, bestIndex - halfWindow));
  const end = Math.min(text.length, start + maxChars);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function queryTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .match(/[a-z0-9_-]+/g);
  return [...new Set((terms ?? []).filter((term) => term.length > 1))];
}

function bestQueryWindowStart(lowerText: string, terms: string[], maxChars: number): number {
  let bestStart = -1;
  let bestScore = 0;

  for (const term of terms) {
    let from = 0;
    let occurrences = 0;
    while (occurrences < 200) {
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

function scorePage(path: string, content: string, query: string): number {
  if (!content) return 0;
  const queryLower = query.trim().toLowerCase();
  const lower = content.toLowerCase();
  const pathLower = path.toLowerCase();
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

function extractExcerpt(content: string, query: string): string {
  return extractRelevantTextExcerpt(content, query, 800);
}

async function semanticFrameSearch(
  services: McpServices,
  query: string,
  limit: number,
  filters: {
    from?: string;
    to?: string;
    day?: string;
    apps?: string[];
    entityPath?: string;
    entityKind?: EntityKind;
    activitySessionId?: string;
    urlDomain?: string;
    textSource?: FrameTextSource;
  } = {},
): Promise<Array<{ frame: Frame; score: number }>> {
  if (!services.model || typeof services.model.embed !== 'function') return [];
  try {
    const [vector] = await services.model.embed([query]);
    if (!vector) return [];
    return await services.storage.searchFrameEmbeddings(vector, {
      ...filters,
      model: services.embeddingModelName,
      limit,
    });
  } catch {
    return [];
  }
}

function blendFrameMatches(
  ftsFrames: Frame[],
  semanticFrames: Array<{ frame: Frame; score: number }>,
  limit: number,
): FrameMatch[] {
  const byId = new Map<string, {
    frame: Frame;
    keywordRank?: number;
    semanticRank?: number;
    semanticScore?: number;
  }>();
  ftsFrames.forEach((frame, idx) => {
    byId.set(frame.id, { frame, keywordRank: idx + 1 });
  });
  semanticFrames.forEach((hit, idx) => {
    const existing = byId.get(hit.frame.id);
    if (existing) {
      existing.semanticRank = idx + 1;
      existing.semanticScore = hit.score;
    } else {
      byId.set(hit.frame.id, {
        frame: hit.frame,
        semanticRank: idx + 1,
        semanticScore: hit.score,
      });
    }
  });

  return [...byId.values()]
    .map((m) => {
      const keywordScore = m.keywordRank ? 1 / (m.keywordRank + 1) : 0;
      const semanticScore = m.semanticRank
        ? (m.semanticScore ?? 0) * (1 / (m.semanticRank + 1))
        : 0;
      const bonus = m.keywordRank && m.semanticRank ? 0.25 : 0;
      const retrieval: 'keyword' | 'semantic' | 'keyword+semantic' = m.keywordRank && m.semanticRank
        ? 'keyword+semantic'
        : m.keywordRank
          ? 'keyword'
          : 'semantic';
      return {
        frame: m.frame,
        retrieval,
        semanticScore: m.semanticScore,
        rankScore: keywordScore + semanticScore + bonus,
      };
    })
    .sort((a, b) => {
      if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
      return b.frame.timestamp.localeCompare(a.frame.timestamp);
    })
    .slice(0, limit)
    .map(({ frame, retrieval, semanticScore }) => ({
      frame,
      retrieval,
      semanticScore,
    }));
}

// ---------------------------------------------------------------------------
// HTTP transport plumbing
// ---------------------------------------------------------------------------

export interface RunningHttpServer {
  url: string;
  close(): Promise<void>;
}

export async function startHttpServer(
  createServer: () => McpServer,
  host: string,
  port: number,
  logger: Logger,
): Promise<RunningHttpServer> {
  const log = logger.child('mcp-http');
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
      return;
    }

    try {
      const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined;
      // Drain the request body — handleRequest expects a parsed JSON body
      // and we also need it to detect MCP `initialize` calls.
      const body = await readBody(req);

      let transport: StreamableHTTPServerTransport;
      if (sessionId && sessions.has(sessionId)) {
        transport = sessions.get(sessionId)!;
      } else if (!sessionId && req.method === 'POST' && isInitializeRequest(body)) {
        // The MCP SDK enforces one Protocol/Server instance per transport,
        // so every new HTTP session gets its own freshly-created McpServer.
        // The factory closes over the shared services, so all servers see
        // the same storage / strategy / reindex hook.
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, newTransport);
            log.debug(`session opened ${id}`);
          },
        });
        newTransport.onclose = () => {
          if (newTransport.sessionId) {
            sessions.delete(newTransport.sessionId);
            log.debug(`session closed ${newTransport.sessionId}`);
          }
        };
        const server = createServer();
        await server.connect(newTransport);
        transport = newTransport;
      } else {
        // No session id and not an `initialize` request → reject rather
        // than silently spawning a stray transport (which is what produced
        // the "Already connected to a transport" error cascade).
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: missing or unknown mcp-session-id',
            },
            id: null,
          }),
        );
        return;
      }

      await transport.handleRequest(req, res, body);
    } catch (err) {
      const e = err as Error;
      log.error('mcp http handler failed', {
        err: e?.message ?? String(err),
        stack: e?.stack,
      });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'internal',
            message: e?.message ?? String(err),
            stack: e?.stack?.split('\n').slice(0, 8),
          }),
        );
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const url = `http://${host}:${port}`;
  log.info(`MCP server listening on ${url}`);

  return {
    url,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      for (const t of sessions.values()) {
        try {
          await t.close();
        } catch {
          // ignore
        }
      }
      sessions.clear();
    },
  };
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function startStdioServer(
  server: McpServer,
  logger: Logger,
): Promise<{ close(): Promise<void> }> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.child('mcp-stdio').info('MCP server attached to stdio');
  return {
    close: async () => {
      await transport.close();
    },
  };
}
