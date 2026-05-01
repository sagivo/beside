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
} from '@cofounderos/interfaces';
import { renderJournalMarkdown } from '@cofounderos/interfaces';

export interface McpServices {
  storage: IStorage;
  strategy: IIndexStrategy;
  model?: IModelAdapter;
  embeddingModelName?: string;
  triggerReindex?: (full?: boolean) => Promise<void>;
}

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

export function createMcpServer(services: McpServices, logger: Logger): McpServer {
  const log = logger.child('mcp-server');
  const server = new McpServer({
    name: 'cofounderos',
    version: '0.2.0',
  });

  server.registerTool(
    'search_memory',
    {
      description:
        'Blended search: returns the best matching frames (specific moments) and wiki pages (synthesised summaries). Use this as the default entrypoint.',
      inputSchema: {
        query: z.string().describe('Natural-language search query.'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results per category, default 5.'),
      },
    },
    async ({ query, limit }) => {
      const cap = limit ?? 5;
      const queryLower = query.toLowerCase();

      // 1. Frame-level retrieval — the "specific moment" answers.
      // Keyword FTS remains the precision path; semantic search adds
      // conceptual recall for queries whose wording differs from what
      // was on screen.
      let frames: Frame[] = [];
      let semanticFrames: Array<{ frame: Frame; score: number }> = [];
      try {
        frames = await services.storage.searchFrames({ text: query, limit: cap });
      } catch (err) {
        log.debug('searchFrames unavailable', { err: String(err) });
      }
      semanticFrames = await semanticFrameSearch(services, query, cap);
      const blendedFrames = blendFrameMatches(frames, semanticFrames, cap);

      // 2. Wiki page retrieval — the "synthesised summary" answers.
      const pages = await listAllStrategyPages(services.strategy);
      const ranked = pages
        .map((p) => ({ page: p, score: scorePage(p.content, queryLower) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, cap);

      const result = {
        query,
        frame_matches: blendedFrames.map((m) => ({
          ...framePreview(m.frame),
          retrieval: m.retrieval,
          semantic_score: m.semanticScore,
        })),
        page_matches: ranked.map((r) => ({
          path: r.page.path,
          excerpt: extractExcerpt(r.page.content, queryLower),
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
        app: z.string().optional().describe('Restrict to a single app name.'),
        semantic: z.boolean().optional().describe('Also include semantic embedding matches. Default true.'),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, from, to, app, semantic, limit }) => {
      const frames = await services.storage.searchFrames({
        text: query,
        from,
        to,
        apps: app ? [app] : undefined,
        limit: limit ?? 25,
      });
      const semanticFrames = semantic === false
        ? []
        : await semanticFrameSearch(services, query, limit ?? 25, {
          from,
          to,
          apps: app ? [app] : undefined,
        });
      const blended = blendFrameMatches(frames, semanticFrames, limit ?? 25);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                query,
                count: blended.length,
                frames: blended.map((m) => ({
                  ...framePreview(m.frame),
                  retrieval: m.retrieval,
                  semantic_score: m.semanticScore,
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
                anchor: framePreview(ctx.anchor),
                before: ctx.before.map(framePreview),
                after: ctx.after.map(framePreview),
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

function framePreview(frame: Frame): Record<string, unknown> {
  return {
    id: frame.id,
    timestamp: frame.timestamp,
    app: frame.app,
    window_title: frame.window_title,
    url: frame.url,
    entity_path: frame.entity_path,
    entity_kind: frame.entity_kind,
    asset_path: frame.asset_path,
    text_excerpt: frame.text ? truncate(frame.text, 240) : null,
    text_source: frame.text_source,
    duration_ms: frame.duration_ms,
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function scorePage(content: string, queryLower: string): number {
  if (!content) return 0;
  const lower = content.toLowerCase();
  // Crude relevance: count of substring occurrences. Good enough for an
  // MVP local agent.
  let score = 0;
  let from = 0;
  while (true) {
    const idx = lower.indexOf(queryLower, from);
    if (idx === -1) break;
    score += 1;
    from = idx + queryLower.length;
  }
  // Token overlap fallback for multi-word queries.
  if (score === 0) {
    const tokens = queryLower.split(/\s+/).filter((t) => t.length > 3);
    for (const t of tokens) {
      if (lower.includes(t)) score += 1;
    }
  }
  return score;
}

function extractExcerpt(content: string, queryLower: string): string {
  const lower = content.toLowerCase();
  const idx = lower.indexOf(queryLower);
  if (idx === -1) return content.slice(0, 200);
  const start = Math.max(0, idx - 80);
  const end = Math.min(content.length, idx + queryLower.length + 120);
  return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
}

async function semanticFrameSearch(
  services: McpServices,
  query: string,
  limit: number,
  filters: { from?: string; to?: string; apps?: string[] } = {},
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
): Array<{
  frame: Frame;
  retrieval: 'keyword' | 'semantic' | 'keyword+semantic';
  semanticScore?: number;
}> {
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
