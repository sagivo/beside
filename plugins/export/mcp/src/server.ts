import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  IStorage,
  IIndexStrategy,
  IModelAdapter,
  Logger,
  RawEventType,
  Frame,
  EntityKind,
  FrameTextSource,
  MeetingPlatform,
  MemoryChunk,
  MemoryChunkKind,
  MemoryChunkSemanticMatch,
} from '@beside/interfaces';
import { renderJournalMarkdown } from '@beside/interfaces';
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
  embeddingSearchWeight?: number;
  triggerReindex?: (full?: boolean) => Promise<void>;
  summarizeMeeting?: (
    meetingId: string,
    opts?: { force?: boolean },
  ) => Promise<{ status: 'ok' | 'failed' | 'not_found' | 'deferred'; message?: string }>;
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

type MemoryChunkMatch = {
  chunk: MemoryChunk;
  retrieval: 'keyword' | 'semantic' | 'keyword+semantic';
  semanticScore?: number;
};

type DateWindow = {
  source: 'explicit' | 'query' | 'default';
  label: string;
  day?: string;
  from?: string;
  to?: string;
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

const MEETING_PLATFORMS: readonly MeetingPlatform[] = [
  'zoom',
  'meet',
  'teams',
  'webex',
  'whereby',
  'around',
  'other',
];

export function createMcpServer(
  services: McpServices,
  logger: Logger,
  options: McpServerOptions = {},
): McpServer {
  const log = logger.child('mcp-server');
  const textExcerptChars = normaliseTextExcerptChars(options.textExcerptChars);
  let lastReindex: {
    status: 'idle' | 'running' | 'succeeded' | 'failed';
    full: boolean | null;
    requested_at: string | null;
    completed_at: string | null;
    error: string | null;
  } = {
    status: 'idle',
    full: null,
    requested_at: null,
    completed_at: null,
    error: null,
  };
  const server = new McpServer({
    name: 'beside',
    version: '0.2.0',
  });

  server.registerTool(
    'search_memory',
    {
      description:
        'Blended search: returns the best matching frames (specific moments), memory chunks, and wiki pages (synthesised summaries). Use this as the default entrypoint. Natural date phrases such as "today", "yesterday", "last week", and "May 7" constrain frame/chunk retrieval. Beside dashboard frames are filtered out by default — pass `exclude_self: false` to include them.',
      inputSchema: {
        query: z.string().describe('Natural-language search query.'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results per category, default 5.'),
        exclude_self: z
          .boolean()
          .optional()
          .describe('Drop frames captured from the Beside dashboard itself. Default true.'),
      },
    },
    async ({ query, limit, exclude_self }) => {
      const cap = limit ?? 5;
      const dropSelf = exclude_self !== false;
      const surfaceQuery = preferredSurface(query);
      const dateWindow = inferQueryDateWindow(query);
      const dateFilters = dateWindowToStorageFilter(dateWindow);
      const retrievalQuery = retrievalQueryForDateAwareSearch(query, dateWindow);
      const rankingQuery = retrievalQuery ?? query;
      // Over-fetch when filtering self frames so we still return `cap`
      // useful results once dashboard/stale-surface noise has been stripped.
      const fetchCap = cap * (surfaceQuery ? 8 : dropSelf ? 2 : 1);

      // 1. Frame-level retrieval — the "specific moment" answers.
      // Keyword FTS remains the precision path; semantic search adds
      // conceptual recall for queries whose wording differs from what
      // was on screen.
      let frames: Frame[] = [];
      let semanticFrames: Array<{ frame: Frame; score: number }> = [];
      try {
        frames = await services.storage.searchFrames({
          text: retrievalQuery,
          ...dateFilters,
          limit: fetchCap,
        });
      } catch (err) {
        log.debug('searchFrames unavailable', { err: String(err) });
      }
      semanticFrames = retrievalQuery
        ? await semanticFrameSearch(services, retrievalQuery, fetchCap, dateFilters)
        : [];
      if (!retrievalQuery && dateWindow) {
        frames = frames.filter((f) => !isLowValueGenericDateFrame(f));
      }
      if (dropSelf) {
        frames = frames.filter((f) => !isSelfFrame(f) && !isVisuallySelfFrame(f));
        semanticFrames = semanticFrames.filter((s) => !isSelfFrame(s.frame) && !isVisuallySelfFrame(s.frame));
      }
      const blendedFrames = blendFrameMatches(frames, semanticFrames, cap, {
        semanticWeight: services.embeddingSearchWeight,
        query: rankingQuery,
      });

      // 2. Memory chunk retrieval — durable summaries, meeting TL;DRs,
      // day events, and curated manual facts/procedures.
      let chunks: MemoryChunk[] = [];
      let semanticChunks: MemoryChunkSemanticMatch[] = [];
      try {
        chunks = await services.storage.searchMemoryChunks({
          text: retrievalQuery,
          ...dateFilters,
          limit: fetchCap * 2,
        });
      } catch (err) {
        log.debug('searchMemoryChunks unavailable', { err: String(err) });
      }
      semanticChunks = retrievalQuery
        ? await semanticMemoryChunkSearch(services, retrievalQuery, fetchCap * 2, dateFilters)
        : [];
      const blendedChunks = blendMemoryChunkMatches(chunks, semanticChunks, cap, {
        semanticWeight: services.embeddingSearchWeight,
        query: rankingQuery,
      });

      // 3. Legacy wiki page retrieval remains in the response for
      // clients that still consume page_matches directly. Most callers
      // should prefer memory_chunk_matches because chunks include pages
      // plus non-page summaries and manual memories.
      const pages = await listAllStrategyPages(services.strategy);
      const ranked = retrievalQuery && !dateWindow
        ? pages
          .map((p) => ({ page: p, score: scorePage(p.path, p.content, retrievalQuery) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, cap)
        : [];

      const result = {
        query,
        retrieval_query: retrievalQuery ?? null,
        date_filter: dateWindowPreview(dateWindow),
        frame_matches: blendedFrames.map((m) => ({
          ...framePreview(m.frame, textExcerptChars, rankingQuery),
          retrieval: m.retrieval,
          semantic_score: m.semanticScore,
        })),
        memory_chunk_matches: blendedChunks.map((m) => memoryChunkPreview(m, rankingQuery)),
        page_matches: ranked.map((r) => ({
          path: r.page.path,
          score: r.score,
          excerpt: extractExcerpt(r.page.content, retrievalQuery ?? query),
          last_updated: r.page.lastUpdated,
          source_event_count: r.page.sourceEventIds.length,
        })),
      };
      log.debug(
        `search_memory "${query}" → ${blendedFrames.length} frames, ${blendedChunks.length} chunks, ${ranked.length} pages`,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    'remember_memory',
    {
      description:
        'Store a durable manual memory chunk as a fact or procedure. Use for stable preferences, project facts, operating procedures, and other long-lived knowledge that should rank alongside generated summaries.',
      inputSchema: {
        body: z.string().min(1).describe('Memory text to store.'),
        title: z.string().optional().describe('Short title. Defaults to the first sentence/body line.'),
        kind: z
          .enum(['fact', 'procedure'])
          .optional()
          .describe('Manual memory kind. Default fact.'),
        entity_path: z.string().optional().describe('Optional entity path, e.g. projects/beside.'),
        entity_kind: z
          .enum(ENTITY_KINDS as [EntityKind, ...EntityKind[]])
          .optional()
          .describe('Optional entity kind for the entity_path.'),
        day: z.string().optional().describe('Optional YYYY-MM-DD memory date.'),
        source_refs: z
          .array(z.string())
          .optional()
          .describe('Optional source references such as frame:<id>, meeting:<id>, or user:<note>.'),
      },
    },
    async ({ body, title, kind, entity_path, entity_kind, day, source_refs }) => {
      const chunk = buildManualMemoryChunk({
        body,
        title,
        kind: (kind ?? 'fact') as Extract<MemoryChunkKind, 'fact' | 'procedure'>,
        entityPath: entity_path ?? null,
        entityKind: entity_kind ?? null,
        day: day ?? null,
        sourceRefs: source_refs ?? ['manual:mcp'],
      });
      await services.storage.upsertMemoryChunks([chunk]);

      let embedded = false;
      if (services.model && typeof services.model.embed === 'function') {
        try {
          const [vector] = await services.model.embed([memoryChunkEmbeddingContent(chunk)]);
          if (vector) {
            await services.storage.upsertMemoryChunkEmbeddings([{
              chunkId: chunk.id,
              model: services.embeddingModelName ?? services.model.getModelInfo().name,
              contentHash: chunk.contentHash,
              vector,
            }]);
            embedded = true;
          }
        } catch (err) {
          log.debug('manual memory embedding failed; worker will retry later', { err: String(err) });
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            embedded,
            chunk: memoryChunkRecord(chunk),
          }, null, 2),
        }],
      };
    },
  );

  server.registerTool(
    'memory_status',
    {
      description:
        'Return memory indexing health: generated/manual chunk counts, embedding coverage, stale chunks, and frame embedding coverage.',
      inputSchema: {
        model: z.string().optional().describe('Embedding model key. Defaults to active embedding model.'),
      },
    },
    async ({ model }) => {
      if (typeof services.storage.getMemoryIndexStats !== 'function') {
        return {
          content: [{ type: 'text', text: 'Storage plugin does not expose memory index stats.' }],
          isError: true,
        };
      }
      const modelName = model ?? services.embeddingModelName;
      const stats = await services.storage.getMemoryIndexStats(modelName);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            model: modelName ?? null,
            semantic_search_enabled: Boolean(services.model && typeof services.model.embed === 'function'),
            embedding_search_weight: normaliseSemanticWeight(services.embeddingSearchWeight),
            last_reindex: lastReindex,
            ...stats,
          }, null, 2),
        }],
      };
    },
  );

  server.registerTool(
    'search_frames',
    {
      description:
        'Search captured screen frames directly via FTS5 against OCR text + window title + URL. Returns specific moments with screenshot paths. Use when you need a precise "when did I see X" answer. Explicit `day`/`from`/`to` win; otherwise natural date phrases in `query` such as "yesterday", "last week", and "May 7" are inferred.',
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
          .describe('Drop frames captured from the Beside dashboard itself. Default true.'),
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
      const surfaceQuery = preferredSurface(query);
      const explicitDateWindow = explicitDateWindowFromInput({ day, from, to });
      const dateWindow = explicitDateWindow ?? inferQueryDateWindow(query);
      const dateFilters = dateWindowToStorageFilter(dateWindow);
      const retrievalQuery = retrievalQueryForDateAwareSearch(query, dateWindow);
      const rankingQuery = retrievalQuery ?? query;
      // Over-fetch when filtering self frames so the post-filter list
      // still has enough rows to satisfy the requested page.
      const fetchLimit = candidateLimit * (surfaceQuery ? 8 : dropSelf ? 2 : 1);
      const filters = {
        ...dateFilters,
        apps: app ? [app] : undefined,
        entityPath: entity_path,
        entityKind: entity_kind,
        activitySessionId: activity_session_id,
        urlDomain: url_domain,
        textSource: text_source,
      };
      let frames = await services.storage.searchFrames({
        text: retrievalQuery,
        ...filters,
        limit: fetchLimit,
      });
      let semanticFrames = semantic === false
        ? []
        : retrievalQuery
          ? await semanticFrameSearch(services, retrievalQuery, fetchLimit, filters)
          : [];
      if (dropSelf) {
        frames = frames.filter((f) => !isSelfFrame(f) && !isVisuallySelfFrame(f));
        semanticFrames = semanticFrames.filter((s) => !isSelfFrame(s.frame) && !isVisuallySelfFrame(s.frame));
      }
      const blended = blendFrameMatches(frames, semanticFrames, candidateLimit, {
        semanticWeight: services.embeddingSearchWeight,
        query: rankingQuery,
      })
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
        {
          retrievalQuery,
          dateWindow,
          previewQuery: rankingQuery,
        },
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
      let meetings: Awaited<ReturnType<typeof services.storage.listMeetings>> = [];
      try {
        meetings = await services.storage.listMeetings({
          day,
          order: 'chronological',
          limit: 100,
        });
      } catch {
        meetings = [];
      }
      const md = renderJournalMarkdown(day, frames, { sessions, meetings });
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
        path: z.string().describe('Stable entity path, e.g. "projects/beside".'),
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
        path: z.string().describe('Stable entity path, e.g. "projects/beside".'),
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
          .describe('Anchor entity path, e.g. "projects/beside" or "contacts/milan-lazic".'),
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
        path: z.string().describe('Entity path, e.g. "projects/beside".'),
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
        'One-shot digest for a single day (YYYY-MM-DD): totals, top apps, top entities, top URL hosts, sessions with headlines, calendar events parsed from screenshots, Slack thread observations, code-review queue, and open loops. Frames captured of the Beside dashboard itself are filtered out by default — pass `include_self: true` to include them.',
      inputSchema: {
        day: z.string().describe('Day in YYYY-MM-DD format.'),
        include_self: z
          .boolean()
          .optional()
          .describe('Include Beside dashboard frames in aggregations. Default false.'),
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
          .describe('Include Beside dashboard frames. Default false.'),
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
        '"What\'s still on my plate?" — surfaces unanswered Slack messages (questions, mentions) and open / draft GitHub PRs and issues observed in the requested window. Defaults to today. Accepts natural date phrases in `query` such as "open items from yesterday" when `day`/`since`/`until` are omitted. Heuristic: combine with `search_frames` to inspect the source moment for any item.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Optional natural-language request. Date phrases are inferred if explicit date fields are omitted.'),
        day: z
          .string()
          .optional()
          .describe('Single YYYY-MM-DD in the local capture day. Mutually exclusive with `since`/`until`. Defaults to today.'),
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
          .describe('Include Beside dashboard frames. Default false.'),
      },
    },
    async ({ query, day, since, until, kinds, limit, include_self }) => {
      const cap = limit ?? 15;
      const explicitDateWindow = explicitDateWindowFromInput({ day, from: since, to: until });
      const dateWindow = explicitDateWindow ?? (query ? inferQueryDateWindow(query) : null) ?? defaultTodayDateWindow();
      const days = resolveDayRange({
        day: dateWindow.day,
        since: dateWindow.from,
        until: dateWindow.to,
      });
      const effectiveSince = dateWindow.from;
      const effectiveUntil = dateWindow.to;
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
          if (effectiveSince && loop.last_seen < effectiveSince) continue;
          if (effectiveUntil && loop.last_seen > effectiveUntil) continue;
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
                  since: effectiveSince ?? null,
                  until: effectiveUntil ?? null,
                  date_filter: dateWindowPreview(dateWindow),
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
        path: z.string().describe('Stable entity path, e.g. "projects/beside".'),
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
        'Structured digest of Slack / chat frames observed on a day: per-channel observation count, the last representative message OCR\'d, mentions, and whether the visible message looks unanswered. Heuristic — pair with `get_frame_context` to verify any single conversation. Frames from the Beside dashboard are excluded by default.',
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
          .describe('Include Beside dashboard frames. Default false.'),
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
    'list_meetings',
    {
      description:
        'List Zoom / Google Meet / Microsoft Teams / Webex (etc.) meetings detected from screenshots, fused with their audio transcripts. Each row reports time range, platform, attendees seen, link/file mentions, and whether a summary is ready. Use this as the entrypoint for "what meetings did I have today / this week" queries.',
      inputSchema: {
        day: z.string().optional().describe('Restrict to a single YYYY-MM-DD.'),
        from: z.string().optional().describe('Meetings starting on or after this ISO timestamp.'),
        to: z.string().optional().describe('Meetings starting on or before this ISO timestamp.'),
        platform: z
          .enum(MEETING_PLATFORMS as [MeetingPlatform, ...MeetingPlatform[]])
          .optional()
          .describe('Filter to one platform (zoom/meet/teams/webex/whereby/around/other).'),
        limit: z.number().int().positive().optional().describe('Max meetings to return. Default 50.'),
        order: z
          .enum(['recent', 'chronological'])
          .optional()
          .describe('"recent" (default) returns newest first.'),
      },
    },
    async ({ day, from, to, platform, limit, order }) => {
      try {
        const meetings = await services.storage.listMeetings({
          day,
          from,
          to,
          platform,
          limit: limit ?? 50,
          order,
        });
        const rows = meetings.map((m) => ({
          id: m.id,
          entity_path: m.entity_path,
          platform: m.platform,
          started_at: m.started_at,
          ended_at: m.ended_at,
          day: m.day,
          duration_min: Math.round(m.duration_ms / 60_000),
          screenshot_count: m.screenshot_count,
          audio_chunk_count: m.audio_chunk_count,
          transcript_chars: m.transcript_chars,
          attendees: m.attendees,
          links: m.links,
          summary_status: m.summary_status,
          has_summary: m.summary_status === 'ready',
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Meetings not yet available (${String(err)}). Try trigger_reindex first.` },
          ],
        };
      }
    },
  );

  server.registerTool(
    'get_meeting',
    {
      description:
        'Fetch a single meeting by id with its structured summary, fused transcript turns (each tied to a screenshot via visual_frame_id), and metadata. Pair with `list_meetings` to drill in. Pass `include` to control payload size; the default is summary+turns.',
      inputSchema: {
        id: z.string().describe('Meeting id (starts with "mtg_").'),
        include_turns: z
          .boolean()
          .optional()
          .describe('Include transcript turns. Default true.'),
        include_screens: z
          .boolean()
          .optional()
          .describe('Include the meeting\'s screenshot frames as a thin manifest. Default false.'),
      },
    },
    async ({ id, include_turns, include_screens }) => {
      const meeting = await services.storage.getMeeting(id);
      if (!meeting) {
        return {
          content: [{ type: 'text', text: `Meeting ${id} not found.` }],
        };
      }
      const wantTurns = include_turns !== false;
      const wantScreens = include_screens === true;
      const turns = wantTurns ? await services.storage.getMeetingTurns(id) : [];
      const screens = wantScreens
        ? (await services.storage.getMeetingFrames(id)).filter(
            (f) => f.entity_kind === 'meeting' && f.asset_path,
          )
        : [];
      const payload: Record<string, unknown> = {
        meeting: {
          id: meeting.id,
          entity_path: meeting.entity_path,
          platform: meeting.platform,
          started_at: meeting.started_at,
          ended_at: meeting.ended_at,
          day: meeting.day,
          duration_min: Math.round(meeting.duration_ms / 60_000),
          screenshot_count: meeting.screenshot_count,
          audio_chunk_count: meeting.audio_chunk_count,
          transcript_chars: meeting.transcript_chars,
          attendees: meeting.attendees,
          links: meeting.links,
          summary_status: meeting.summary_status,
          summary: meeting.summary_json,
          summary_failure_reason: meeting.failure_reason,
          updated_at: meeting.updated_at,
        },
      };
      if (wantTurns) {
        payload.turns = turns.map((t) => ({
          id: t.id,
          t_start: t.t_start,
          t_end: t.t_end,
          speaker: t.speaker,
          text: t.text,
          visual_frame_id: t.visual_frame_id,
          source: t.source,
        }));
      }
      if (wantScreens) {
        payload.screens = screens.map((f) => ({
          id: f.id,
          timestamp: f.timestamp,
          window_title: f.window_title,
          asset_path: f.asset_path,
          url: f.url,
        }));
      }
      const responses = [
        { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
      ];
      if (meeting.summary_md) {
        responses.push({ type: 'text' as const, text: meeting.summary_md });
      }
      return { content: responses };
    },
  );

  server.registerTool(
    'summarize_meeting',
    {
      description:
        'Run (or re-run) the meeting summarizer for a single meeting. Useful right after dropping a .vtt transcript into the audio inbox, or to refresh the summary with a different model. Pass `force: true` to bypass the cached-summary fast path.',
      inputSchema: {
        id: z.string().describe('Meeting id.'),
        force: z.boolean().optional().describe('Force re-summarisation even when a summary already exists.'),
      },
    },
    async ({ id, force }) => {
      if (!services.summarizeMeeting) {
        return {
          content: [
            { type: 'text', text: 'summarize_meeting unavailable in this process — start the agent to enable.' },
          ],
          isError: true,
        };
      }
      const result = await services.summarizeMeeting(id, { force });
      return {
        content: [
          { type: 'text', text: JSON.stringify(result, null, 2) },
        ],
        isError: result.status === 'failed' || result.status === 'not_found',
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
      const requestedAt = new Date().toISOString();
      const requestedFull = full ?? false;
      lastReindex = {
        status: 'running',
        full: requestedFull,
        requested_at: requestedAt,
        completed_at: null,
        error: null,
      };
      void services.triggerReindex(requestedFull)
        .then(() => {
          lastReindex = {
            ...lastReindex,
            status: 'succeeded',
            completed_at: new Date().toISOString(),
            error: null,
          };
        })
        .catch((err) => {
          const message = String(err);
          lastReindex = {
            ...lastReindex,
            status: 'failed',
            completed_at: new Date().toISOString(),
            error: message,
          };
          log.warn('background reindex failed', { err: message, full: requestedFull });
        });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              queued: true,
              full: requestedFull,
              status: lastReindex,
              message: 'Check memory_status.last_reindex for completion or failure.',
            }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_reindex_status',
    {
      description:
        'Return the most recent MCP-triggered reindex status for this client session, including load-guard failures.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(lastReindex, null, 2) }],
    }),
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
  const fromDay = input.since ? dayKeyFromTimestampBound(input.since) ?? today : today;
  const toDay = input.until ? dayKeyFromTimestampBound(input.until) ?? today : today;
  if (toDay < fromDay) return [today];
  const out: string[] = [];
  const fromMs = localDateFromDayKey(fromDay)?.getTime() ?? NaN;
  const toMs = localDateFromDayKey(toDay)?.getTime() ?? NaN;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return [today];
  const days = Math.min(MAX_DAY_RANGE, Math.floor((toMs - fromMs) / 86_400_000) + 1);
  for (let i = 0; i < days; i++) {
    const ms = fromMs + i * 86_400_000;
    out.push(todayKey(new Date(ms)));
  }
  return out;
}

function todayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function defaultTodayDateWindow(now = new Date()): DateWindow {
  return {
    source: 'default',
    label: 'today',
    day: todayKey(now),
  };
}

function explicitDateWindowFromInput(input: {
  day?: string;
  from?: string;
  to?: string;
}): DateWindow | null {
  const day = input.day?.trim();
  const from = input.from?.trim();
  const to = input.to?.trim();
  if (!day && !from && !to) return null;
  if (day) {
    return {
      source: 'explicit',
      label: day,
      day,
    };
  }
  return {
    source: 'explicit',
    label: describeDateBounds(from, to),
    from: from ? normaliseTimestampBound(from, 'from') : undefined,
    to: to ? normaliseTimestampBound(to, 'to') : undefined,
  };
}

function inferQueryDateWindow(query: string, now = new Date()): DateWindow | null {
  const lower = query.toLowerCase();
  const today = startOfLocalDay(now);

  const isoDay = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (isoDay && localDateFromDayKey(isoDay)) {
    return {
      source: 'query',
      label: isoDay,
      day: isoDay,
    };
  }

  const monthNameDay = parseMonthNameDay(lower, now);
  if (monthNameDay) {
    return singleDayQueryWindow(monthNameDay.date, monthNameDay.label);
  }

  const numericDay = parseNumericDay(lower, now);
  if (numericDay) {
    return singleDayQueryWindow(numericDay.date, numericDay.label);
  }

  if (/\byesterday\b/.test(lower)) {
    return singleDayQueryWindow(addLocalDays(today, -1), 'yesterday');
  }
  if (/\btoday\b/.test(lower)) {
    return singleDayQueryWindow(today, 'today');
  }
  if (/\btomorrow\b/.test(lower)) {
    return singleDayQueryWindow(addLocalDays(today, 1), 'tomorrow');
  }

  const lastNDays = lower.match(/\b(?:past|last)\s+(\d{1,2})\s+days?\b/);
  if (lastNDays) {
    const n = clampRangeDays(Number(lastNDays[1]));
    return rangeQueryWindow(
      startOfLocalDay(addLocalDays(today, -(n - 1))),
      endOfLocalDay(today),
      `last ${n} days`,
    );
  }

  const lastNWeeks = lower.match(/\b(?:past|last)\s+(\d{1,2})\s+weeks?\b/);
  if (lastNWeeks) {
    const n = Math.max(1, Math.min(8, Number(lastNWeeks[1])));
    return rangeQueryWindow(
      startOfLocalDay(addLocalDays(today, -(n * 7 - 1))),
      endOfLocalDay(today),
      `last ${n} weeks`,
    );
  }

  if (/\blast\s+week\b/.test(lower)) {
    const thisWeek = startOfLocalWeek(today);
    return rangeQueryWindow(
      addLocalDays(thisWeek, -7),
      endOfLocalDay(addLocalDays(thisWeek, -1)),
      'last week',
    );
  }
  if (/\b(?:this\s+week|week\s+to\s+date)\b/.test(lower)) {
    return rangeQueryWindow(startOfLocalWeek(today), endOfLocalDay(today), 'this week');
  }
  if (/\bpast\s+month\b/.test(lower)) {
    return rangeQueryWindow(startOfLocalDay(addLocalDays(today, -29)), endOfLocalDay(today), 'past month');
  }
  if (/\blast\s+(?:calendar\s+)?month\b/.test(lower)) {
    return previousCalendarMonthWindow(today);
  }
  if (/\bthis\s+month\b/.test(lower)) {
    return rangeQueryWindow(new Date(today.getFullYear(), today.getMonth(), 1), endOfLocalDay(today), 'this month');
  }

  return null;
}

function retrievalQueryForDateAwareSearch(query: string, dateWindow: DateWindow | null): string | undefined {
  if (!dateWindow) return query.trim() || undefined;
  const stripped = stripTemporalPhrases(query);
  const terms = meaningfulQueryTerms(stripped);
  if (terms.length === 0) return undefined;
  return terms.join(' ');
}

function dateWindowToStorageFilter(dateWindow: DateWindow | null): { day?: string; from?: string; to?: string } {
  if (!dateWindow) return {};
  return {
    day: dateWindow.day,
    from: dateWindow.from,
    to: dateWindow.to,
  };
}

function dateWindowPreview(dateWindow: DateWindow | null): Record<string, unknown> | null {
  if (!dateWindow) return null;
  return {
    source: dateWindow.source,
    label: dateWindow.label,
    day: dateWindow.day ?? null,
    from: dateWindow.from ?? null,
    to: dateWindow.to ?? null,
  };
}

function singleDayQueryWindow(date: Date, label: string): DateWindow {
  return {
    source: 'query',
    label,
    day: todayKey(date),
  };
}

function rangeQueryWindow(from: Date, to: Date, label: string): DateWindow {
  return {
    source: 'query',
    label,
    from: from.toISOString(),
    to: to.toISOString(),
  };
}

function previousCalendarMonthWindow(today: Date): DateWindow {
  const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const end = endOfLocalDay(new Date(today.getFullYear(), today.getMonth(), 0));
  return rangeQueryWindow(start, end, 'last calendar month');
}

function stripTemporalPhrases(query: string): string {
  const monthPattern = MONTH_NAME_PATTERN;
  return query
    .replace(/\b(?:today|yesterday|tomorrow)\b/gi, ' ')
    .replace(/\b(?:this\s+week|week\s+to\s+date|last\s+week|this\s+month|last\s+calendar\s+month|last\s+month|past\s+month)\b/gi, ' ')
    .replace(/\b(?:past|last)\s+\d{1,2}\s+(?:days?|weeks?)\b/gi, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(new RegExp(`\\b(?:on|from|since|until|before|after|during|in)?\\s*${monthPattern}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'gi'), ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const MONTH_NAME_PATTERN = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function parseMonthNameDay(query: string, now: Date): { date: Date; label: string } | null {
  const match = query.match(new RegExp(`\\b(${MONTH_NAME_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i'));
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  const day = Number(match[2]);
  const explicitYear = match[3] ? Number(match[3]) : null;
  const year = explicitYear ?? inferYearForMonthDay(now, month, day);
  const date = validLocalDate(year, month, day);
  if (!date) return null;
  return {
    date,
    label: `${match[1]} ${day}${explicitYear ? ` ${explicitYear}` : ''}`,
  };
}

function parseNumericDay(query: string, now: Date): { date: Date; label: string } | null {
  const match = query.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (!match) return null;
  const month = Number(match[1]) - 1;
  const day = Number(match[2]);
  if (month < 0 || month > 11) return null;
  const explicitYear = match[3] ? normaliseNumericYear(Number(match[3])) : null;
  const year = explicitYear ?? inferYearForMonthDay(now, month, day);
  const date = validLocalDate(year, month, day);
  if (!date) return null;
  return {
    date,
    label: `${match[1]}/${match[2]}${match[3] ? `/${match[3]}` : ''}`,
  };
}

function inferYearForMonthDay(now: Date, month: number, day: number): number {
  const thisYear = now.getFullYear();
  const candidate = validLocalDate(thisYear, month, day);
  if (!candidate) return thisYear;
  const tomorrow = addLocalDays(startOfLocalDay(now), 1);
  return candidate.getTime() > tomorrow.getTime() ? thisYear - 1 : thisYear;
}

function normaliseNumericYear(year: number): number {
  return year < 100 ? 2000 + year : year;
}

function validLocalDate(year: number, month: number, day: number): Date | null {
  const date = new Date(year, month, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return null;
  }
  return startOfLocalDay(date);
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function startOfLocalWeek(date: Date): Date {
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return startOfLocalDay(addLocalDays(date, mondayOffset));
}

function localDateFromDayKey(day: string): Date | null {
  const match = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return validLocalDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function dayKeyFromTimestampBound(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return todayKey(date);
}

function normaliseTimestampBound(value: string, side: 'from' | 'to'): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const day = localDateFromDayKey(value);
    if (day) return (side === 'from' ? startOfLocalDay(day) : endOfLocalDay(day)).toISOString();
  }
  return value;
}

function describeDateBounds(from?: string, to?: string): string {
  if (from && to) return `${from}..${to}`;
  if (from) return `since ${from}`;
  if (to) return `until ${to}`;
  return 'date range';
}

function clampRangeDays(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(MAX_DAY_RANGE, Math.floor(value)));
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
  const visibleApp = inferVisibleApp(frame);
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
    evidence_quality: {
      has_screenshot: Boolean(frame.asset_path),
      has_text: Boolean(frame.text && frame.text.trim()),
      visible_app: visibleApp,
      app_matches_visible_text: visibleApp ? appMatchesVisibleGuess(frame.app, visibleApp) : null,
    },
  };
}

function memoryChunkPreview(match: MemoryChunkMatch, query: string): Record<string, unknown> {
  return {
    ...memoryChunkRecord(match.chunk),
    retrieval: match.retrieval,
    semantic_score: match.semanticScore,
    excerpt: extractRelevantTextExcerpt(match.chunk.body, query, 1200),
  };
}

function memoryChunkRecord(chunk: MemoryChunk): Record<string, unknown> {
  return {
    id: chunk.id,
    kind: chunk.kind,
    source_id: chunk.sourceId,
    title: chunk.title,
    entity_path: chunk.entityPath,
    entity_kind: chunk.entityKind,
    day: chunk.day,
    timestamp: chunk.timestamp,
    source_refs: chunk.sourceRefs,
    content_hash: chunk.contentHash,
    created_at: chunk.createdAt,
    updated_at: chunk.updatedAt,
  };
}

function buildManualMemoryChunk(input: {
  body: string;
  title?: string;
  kind: Extract<MemoryChunkKind, 'fact' | 'procedure'>;
  entityPath: string | null;
  entityKind: EntityKind | null;
  day: string | null;
  sourceRefs: string[];
}): MemoryChunk {
  const now = new Date().toISOString();
  const body = input.body.trim();
  const title = (input.title?.trim() || inferMemoryTitle(body)).slice(0, 240);
  const sourceRefs = [...new Set((input.sourceRefs.length ? input.sourceRefs : ['manual:mcp']).filter(Boolean))];
  const identity = [
    input.kind,
    title,
    body,
    input.entityPath ?? '',
    input.day ?? '',
  ].join('\n');
  const chunk: MemoryChunk = {
    id: `mem_${input.kind}_${hashText(identity).slice(0, 20)}`,
    kind: input.kind,
    sourceId: `manual:${hashText(identity).slice(0, 16)}`,
    title,
    body,
    entityPath: input.entityPath,
    entityKind: input.entityKind,
    day: input.day,
    timestamp: input.day ? `${input.day}T00:00:00.000Z` : now,
    sourceRefs,
    contentHash: '',
    createdAt: now,
    updatedAt: now,
  };
  chunk.contentHash = hashText(memoryChunkEmbeddingContent(chunk));
  return chunk;
}

function inferMemoryTitle(body: string): string {
  const firstLine = body.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return 'Memory';
  const sentence = firstLine.match(/^(.{1,160}?[.!?])(?:\s|$)/)?.[1];
  return (sentence ?? firstLine).replace(/^#+\s*/, '').trim() || 'Memory';
}

function memoryChunkEmbeddingContent(chunk: Pick<
  MemoryChunk,
  'kind' | 'title' | 'entityPath' | 'day' | 'timestamp' | 'body'
>): string {
  const parts = [
    `Kind: ${chunk.kind}`,
    chunk.title ? `Title: ${chunk.title}` : null,
    chunk.entityPath ? `Entity: ${chunk.entityPath}` : null,
    chunk.day ? `Day: ${chunk.day}` : null,
    chunk.timestamp ? `Timestamp: ${chunk.timestamp}` : null,
    chunk.body ? `Body: ${truncateForEmbedding(chunk.body, 2400)}` : null,
  ].filter((p): p is string => Boolean(p));
  return parts.join('\n').trim();
}

function truncateForEmbedding(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars).trimEnd();
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
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
  options: {
    retrievalQuery?: string;
    dateWindow?: DateWindow | null;
    previewQuery?: string;
  } = {},
): Record<string, unknown> {
  const responseBudget = Math.max(1000, maxResponseChars - 512);
  const previewQuery = options.previewQuery ?? options.retrievalQuery ?? query;
  const result = {
    query,
    retrieval_query: options.retrievalQuery ?? null,
    date_filter: dateWindowPreview(options.dateWindow ?? null),
    count: matches.length,
    returned_count: 0,
    omitted_count: 0,
    max_response_chars: maxResponseChars,
    truncated: false,
    frames: [] as Record<string, unknown>[],
  };

  for (const match of matches) {
    const preview = largestFittingFrameSearchPreview(match, previewQuery, result, responseBudget);
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

const QUERY_STOP_WORDS = new Set([
  'what', 'where', 'when', 'who', 'why', 'how',
  'did', 'do', 'does', 'done', 'about', 'with', 'that', 'this',
  'the', 'and', 'for', 'from', 'into', 'onto', 'were', 'was',
  'are', 'is', 'am', 'any', 'some', 'look', 'looked', 'recent',
  'recently', 'available', 'items', 'item', 'make', 'sure',
  'today', 'yesterday', 'tomorrow', 'week', 'weeks', 'month',
  'months', 'day', 'days', 'past', 'last', 'since', 'until',
  'before', 'after', 'during',
]);

function meaningfulQueryTerms(query: string): string[] {
  return queryTerms(query)
    .filter((term) => term.length > 2)
    .filter((term) => !QUERY_STOP_WORDS.has(term));
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

async function semanticMemoryChunkSearch(
  services: McpServices,
  query: string,
  limit: number,
  filters: {
    kind?: MemoryChunkKind;
    entityPath?: string;
    day?: string;
    from?: string;
    to?: string;
  } = {},
): Promise<MemoryChunkSemanticMatch[]> {
  if (!services.model || typeof services.model.embed !== 'function') return [];
  try {
    const [vector] = await services.model.embed([query]);
    if (!vector) return [];
    return await services.storage.searchMemoryChunkEmbeddings(vector, {
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
  options: { semanticWeight?: number; query?: string } = {},
): FrameMatch[] {
  const semanticWeight = normaliseSemanticWeight(options.semanticWeight);
  const keywordWeight = 1 - semanticWeight;
  const surface = preferredSurface(options.query);
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

  const ranked = [...byId.values()]
    .map((m) => {
      const support = frameQuerySupport(m.frame, options.query);
      const quality = frameEvidenceQuality(m.frame);
      const surfaceMatch = surface ? frameMatchesSurface(m.frame, surface) : true;
      const surfaceScore = surface ? (surfaceMatch ? 0.18 : -0.32) : 0;
      const keywordScore = m.keywordRank
        ? (1 / (m.keywordRank + 1)) * (0.25 + 0.95 * support)
        : 0;
      const semanticScore = m.semanticRank
        ? clamp01(m.semanticScore ?? 0) * (1 / Math.sqrt(m.semanticRank + 1)) * (0.45 + 0.65 * support)
        : 0;
      const bonus = m.keywordRank && m.semanticRank ? 0.16 : 0;
      const recency = 0.08 * recencyScore(m.frame.timestamp);
      const retrieval: 'keyword' | 'semantic' | 'keyword+semantic' = m.keywordRank && m.semanticRank
        ? 'keyword+semantic'
        : m.keywordRank
          ? 'keyword'
          : 'semantic';
      return {
        frame: m.frame,
        retrieval,
        semanticScore: m.semanticScore,
        support,
        surfaceMatch,
        rankScore: keywordWeight * keywordScore + semanticWeight * semanticScore + bonus + recency + quality + surfaceScore,
      };
    })
    .filter((m) => (
      hasFrameEvidence(m.frame) &&
      (!surface || m.surfaceMatch) &&
      (
        m.support > 0.05 ||
        m.retrieval !== 'semantic' ||
        Boolean(m.frame.text && m.frame.text.trim() && (m.semanticScore ?? 0) >= 0.88)
      )
    ))
    .sort((a, b) => {
      if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
      return b.frame.timestamp.localeCompare(a.frame.timestamp);
    });
  return diverseSelect(ranked, limit, (a, b) => frameSimilarity(a.frame, b.frame))
    .map(({ frame, retrieval, semanticScore }) => ({
      frame,
      retrieval,
      semanticScore,
    }));
}

function blendMemoryChunkMatches(
  keywordChunks: MemoryChunk[],
  semanticChunks: MemoryChunkSemanticMatch[],
  limit: number,
  options: { semanticWeight?: number; query?: string } = {},
): MemoryChunkMatch[] {
  const semanticWeight = normaliseSemanticWeight(options.semanticWeight);
  const keywordWeight = 1 - semanticWeight;
  const byId = new Map<string, {
    chunk: MemoryChunk;
    keywordRank?: number;
    semanticRank?: number;
    semanticScore?: number;
  }>();
  keywordChunks.forEach((chunk, idx) => {
    byId.set(chunk.id, { chunk, keywordRank: idx + 1 });
  });
  semanticChunks.forEach((hit, idx) => {
    const existing = byId.get(hit.chunk.id);
    if (existing) {
      existing.semanticRank = idx + 1;
      existing.semanticScore = hit.score;
    } else {
      byId.set(hit.chunk.id, {
        chunk: hit.chunk,
        semanticRank: idx + 1,
        semanticScore: hit.score,
      });
    }
  });

  const ranked = [...byId.values()]
    .map((m) => {
      const support = memoryChunkQuerySupport(m.chunk, options.query);
      const keywordScore = m.keywordRank
        ? (1 / (m.keywordRank + 1)) * (0.35 + 0.9 * support)
        : 0;
      const semanticScore = m.semanticRank
        ? clamp01(m.semanticScore ?? 0) * (1 / Math.sqrt(m.semanticRank + 1)) * (0.45 + 0.65 * support)
        : 0;
      const bonus = m.keywordRank && m.semanticRank ? 0.18 : 0;
      const recency = 0.06 * recencyScore(m.chunk.timestamp ?? m.chunk.updatedAt);
      const provenance = m.chunk.sourceRefs.length > 1 ? 0.04 : 0;
      const retrieval: MemoryChunkMatch['retrieval'] = m.keywordRank && m.semanticRank
        ? 'keyword+semantic'
        : m.keywordRank
          ? 'keyword'
          : 'semantic';
      return {
        chunk: m.chunk,
        retrieval,
        semanticScore: m.semanticScore,
        support,
        rankScore: keywordWeight * keywordScore + semanticWeight * semanticScore + bonus + recency + provenance + 0.12 * support,
      };
    })
    .filter((m) => (
      m.support >= 0.34 ||
      m.retrieval !== 'semantic' ||
      (m.semanticScore ?? 0) >= 0.9
    ))
    .sort((a, b) => {
      if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
      return (b.chunk.timestamp ?? b.chunk.updatedAt).localeCompare(a.chunk.timestamp ?? a.chunk.updatedAt);
    });
  return diverseSelect(ranked, limit, (a, b) => memoryChunkSimilarity(a.chunk, b.chunk))
    .map(({ chunk, retrieval, semanticScore }) => ({
      chunk,
      retrieval,
      semanticScore,
    }));
}

function normaliseSemanticWeight(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 0.35;
  return Math.max(0, Math.min(0.85, value!));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function frameQuerySupport(frame: Frame, query: string | undefined): number {
  if (!query) return 1;
  const terms = meaningfulQueryTerms(query);
  if (terms.length === 0) return 1;
  const visible = [
    frame.text ?? '',
    frame.window_title ?? '',
    frame.url ?? '',
  ].join('\n').toLowerCase();
  const metadata = [
    frame.app,
    frame.entity_path ?? '',
    frame.entity_kind ?? '',
  ].join('\n').toLowerCase();

  let visibleHits = 0;
  let metadataHits = 0;
  for (const term of terms) {
    if (containsQueryTerm(visible, term)) visibleHits += 1;
    else if (containsQueryTerm(metadata, term)) metadataHits += 1;
  }
  const exact = query.trim().length > 2 && visible.includes(query.trim().toLowerCase()) ? 0.2 : 0;
  return clamp01((visibleHits + metadataHits * 0.3) / terms.length + exact);
}

function memoryChunkQuerySupport(chunk: MemoryChunk, query: string | undefined): number {
  if (!query) return 1;
  const terms = meaningfulQueryTerms(query);
  if (terms.length === 0) return 1;
  const body = [
    chunk.title,
    chunk.body,
    chunk.entityPath ?? '',
    chunk.kind,
    ...chunk.sourceRefs,
  ].join('\n').toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (containsQueryTerm(body, term)) hits += 1;
  }
  const exact = query.trim().length > 2 && body.includes(query.trim().toLowerCase()) ? 0.2 : 0;
  return clamp01(hits / terms.length + exact);
}

function frameEvidenceQuality(frame: Frame): number {
  let score = 0;
  if (frame.asset_path) score += 0.1;
  else score -= frame.text_source === 'audio' ? 0.04 : 0.18;

  if (frame.text && frame.text.trim()) score += 0.08;
  else score -= 0.12;

  const visibleApp = inferVisibleApp(frame);
  if (visibleApp) {
    score += appMatchesVisibleGuess(frame.app, visibleApp) ? 0.06 : -0.34;
  }
  return score;
}

function hasFrameEvidence(frame: Frame): boolean {
  return Boolean(frame.asset_path || (frame.text && frame.text.trim()));
}

function isLowValueGenericDateFrame(frame: Frame): boolean {
  const app = (frame.app ?? '').toLowerCase();
  const title = (frame.window_title ?? '').toLowerCase();
  if (app.includes('loginwindow') || title === 'loginwindow') return true;
  if (app === 'finder' && !frame.text?.trim()) return true;
  if (!frame.text?.trim() && !inferVisibleApp(frame)) return true;
  if (!inferVisibleApp(frame) && isLowInformationFrameText(frame.text)) return true;
  return false;
}

function isLowInformationFrameText(text: string | null | undefined): boolean {
  if (!text) return true;
  const terms = (text.toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}/g) ?? []).slice(0, 300);
  if (terms.length < 20) return false;
  const unique = new Set(terms);
  return unique.size <= 3 || unique.size / terms.length < 0.08;
}

function preferredSurface(query: string | undefined): 'slack' | 'terminal' | 'mail' | null {
  if (!query) return null;
  const terms = new Set(meaningfulQueryTerms(query));
  if (terms.has('slack') || terms.has('dms') || terms.has('dm')) return 'slack';
  if (terms.has('mail') || terms.has('email') || terms.has('inbox')) return 'mail';
  if (
    terms.has('npm') ||
    terms.has('pnpm') ||
    terms.has('build') ||
    terms.has('error') ||
    terms.has('errors')
  ) return 'terminal';
  return null;
}

function frameMatchesSurface(frame: Frame, surface: 'slack' | 'terminal' | 'mail'): boolean {
  const visible = inferVisibleApp(frame);
  if (visible) {
    if (surface === 'terminal') return visible === 'warp';
    return visible === surface;
  }
  const app = frame.app.toLowerCase();
  const entity = (frame.entity_path ?? '').toLowerCase();
  switch (surface) {
    case 'slack':
      return app.includes('slack') || entity.startsWith('channels/');
    case 'mail':
      return app.includes('mail') || entity.includes('mail');
    case 'terminal':
      return app.includes('warp') || app.includes('terminal') || entity === 'projects/npm' || entity === 'projects/pnpm';
  }
  return false;
}

function inferVisibleApp(frame: Frame): string | null {
  const title = frame.window_title ?? '';
  const visibleFromText = inferVisibleAppFromText(frame.text ?? '');
  if (visibleFromText) return visibleFromText;
  if (/(^|\s-\s).*\bslack\b$|\((?:channel|dm)\)\s+-\s+.*\bslack\b$/i.test(title)) return 'slack';
  if (/^all inboxes\b|\binbox\b.*\bmessages?\b|\bmail\b/i.test(title)) return 'mail';
  if (/\bpnpm\b|\bnpm\b|\bwarp\b|\bterminal\b/i.test(title)) return 'warp';
  if (/\bgoogle meet\b|\bzoom meeting\b|\bteams meeting\b|\bmeet\.google\.com\b/i.test(title)) return 'browser';
  const haystack = [
    title.toLowerCase(),
    frame.text ?? '',
  ].join('\n').toLowerCase();
  if (!haystack.trim()) return null;
  if (
    /\bcodex\s+file\s+edit\b|\bnew chat\b.*\bplugins\b|\bautomations\b.*\bprojects\b/.test(haystack)
  ) return 'codex';
  if (
    /\ball inboxes\b|\bmailbox\b|\bunsubscribe\b|\breply-to\b|\binbox\s*-\s*gmail\b/.test(haystack)
  ) return 'mail';
  if (
    /\bslack\s+file\s+edit\b|\bdirect messages\b|\bhuddles\b|\bfind a dm\b|\bnew message\b.*\bhome\b.*\bdms\b/.test(haystack)
  ) return 'slack';
  if (
    /\bcommand input\b|\bwarp\b|\bpnpm\b|\bnpm run\b|\bterminal\b/.test(haystack)
  ) return 'warp';
  if (
    /\bgoogle meet\b|\bmeet\.google\.com\b|\bnew meeting\b|\bjoin\b/.test(haystack)
  ) return 'browser';
  if (
    /\bfinder\b|\bquick look\b|\brecents\b|\bapplications\b/.test(haystack)
  ) return 'finder';
  return null;
}

function inferVisibleAppFromText(text: string): string | null {
  const haystack = text.toLowerCase();
  if (!haystack.trim()) return null;
  if (
    /\bbeside\b|\bindexed journal\b|\bshow moments\b|\bcopy summary\b|\bask ai\b/.test(haystack)
  ) return 'beside';
  if (
    /\bcodex\s+file\s+edit\b|\bnew chat\b.*\bplugins\b|\bautomations\b.*\bprojects\b/.test(haystack)
  ) return 'codex';
  if (
    /\ball inboxes\b|\bmailbox\b|\bunsubscribe\b|\breply-to\b|\binbox\s*-\s*(gmail|postman)\b|\bwelcome to\b.*\bairbnb\b/.test(haystack)
  ) return 'mail';
  if (
    /\bfinder\b|\bquick look\b|\brecents\b|\bapplications\b/.test(haystack.slice(0, 400))
  ) return 'finder';
  if (
    /\bslack\s+file\s+edit\b|\bdirect messages\b|\bhuddles\b|\bfind a dm\b|\bnew message\b.*\bhome\b.*\bdms\b/.test(haystack)
  ) return 'slack';
  if (
    /\bcommand input\b|\bwarp\b|\bpnpm\b|\bnpm run\b|\bterminal\b/.test(haystack)
  ) return 'warp';
  if (
    /\bgoogle meet\b|\bmeet\.google\.com\b|\bnew meeting\b|\bjoin\b/.test(haystack)
  ) return 'browser';
  return null;
}

function containsQueryTerm(haystack: string, term: string): boolean {
  if (!term) return false;
  const escaped = escapeRegExp(term.toLowerCase());
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(haystack);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appMatchesVisibleGuess(app: string, visibleApp: string): boolean {
  const normalised = app.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  switch (visibleApp) {
    case 'beside':
      return /\b(beside|electron)\b/.test(normalised);
    case 'browser':
      return /\b(chrome|firefox|safari|arc)\b/.test(normalised);
    case 'mail':
      return /\b(mail|outlook|gmail)\b/.test(normalised);
    case 'finder':
      return /\bfinder\b/.test(normalised);
    default:
      return normalised.includes(visibleApp);
  }
}

function isVisuallySelfFrame(frame: Frame): boolean {
  return inferVisibleApp(frame) === 'beside';
}

function recencyScore(timestamp: string | null | undefined): number {
  if (!timestamp) return 0;
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return 0;
  const ageDays = Math.max(0, (Date.now() - ms) / 86_400_000);
  return Math.exp(-ageDays / 45);
}

function diverseSelect<T extends { rankScore: number }>(
  ranked: T[],
  limit: number,
  similarity: (a: T, b: T) => number,
): T[] {
  const selected: T[] = [];
  const pool = [...ranked];
  while (selected.length < limit && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i]!;
      const maxSimilarity = selected.reduce(
        (max, item) => Math.max(max, similarity(candidate, item)),
        0,
      );
      const score = candidate.rankScore - 0.18 * maxSimilarity;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    selected.push(pool.splice(bestIndex, 1)[0]!);
  }
  return selected;
}

function frameSimilarity(a: Frame, b: Frame): number {
  let score = 0;
  if (a.id === b.id) return 1;
  if (a.entity_path && a.entity_path === b.entity_path) score += 0.42;
  if (a.app && a.app === b.app) score += 0.18;
  if (a.day && a.day === b.day) score += 0.12;
  if (a.window_title && b.window_title) {
    score += 0.18 * tokenOverlap(a.window_title, b.window_title);
  }
  const timeGap = Math.abs(Date.parse(a.timestamp) - Date.parse(b.timestamp));
  if (Number.isFinite(timeGap) && timeGap < 10 * 60_000) score += 0.22;
  return clamp01(score);
}

function memoryChunkSimilarity(a: MemoryChunk, b: MemoryChunk): number {
  let score = 0;
  if (a.id === b.id) return 1;
  if (a.kind === b.kind) score += 0.18;
  if (a.entityPath && a.entityPath === b.entityPath) score += 0.42;
  if (a.day && a.day === b.day) score += 0.14;
  score += 0.2 * tokenOverlap(a.title, b.title);
  return clamp01(score);
}

function tokenOverlap(a: string, b: string): number {
  const left = new Set(queryTerms(a).filter((term) => term.length > 2));
  const right = new Set(queryTerms(b).filter((term) => term.length > 2));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const term of left) {
    if (right.has(term)) shared += 1;
  }
  return shared / Math.max(left.size, right.size);
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
