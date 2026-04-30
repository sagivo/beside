import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type {
  IStorage,
  IIndexStrategy,
  Logger,
  RawEventType,
} from '@cofounderos/interfaces';

export interface McpServices {
  storage: IStorage;
  strategy: IIndexStrategy;
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
        'Free-text search across the indexed wiki + raw event content. Returns matching wiki pages.',
      inputSchema: {
        query: z.string().describe('Natural-language search query.'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results, default 5.'),
      },
    },
    async ({ query, limit }) => {
      const cap = limit ?? 5;
      // 1. Search raw events for context.
      const events = await services.storage.readEvents({
        text: query,
        limit: cap * 4,
      });
      // 2. Pull associated pages (via bucketer-derived path is heavy — instead we
      //    snapshot the strategy's page list and rank by content match).
      const pages = await listAllStrategyPages(services.strategy);
      const queryLower = query.toLowerCase();
      const ranked = pages
        .map((p) => ({ page: p, score: scorePage(p.content, queryLower) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, cap);

      const result = {
        query,
        page_matches: ranked.map((r) => ({
          path: r.page.path,
          excerpt: extractExcerpt(r.page.content, queryLower),
          last_updated: r.page.lastUpdated,
          source_event_count: r.page.sourceEventIds.length,
        })),
        raw_event_matches: events.slice(0, cap).map((e) => ({
          id: e.id,
          timestamp: e.timestamp,
          app: e.app,
          window_title: e.window_title,
          url: e.url,
          content_excerpt: e.content ? e.content.slice(0, 200) : null,
        })),
      };
      log.debug(`search_memory "${query}" → ${ranked.length} pages, ${events.length} events`);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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
    'get_session',
    {
      description: 'Reconstruct a contiguous session as the ordered list of raw events plus screenshot asset paths.',
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

// ---------------------------------------------------------------------------
// HTTP transport plumbing
// ---------------------------------------------------------------------------

export interface RunningHttpServer {
  url: string;
  close(): Promise<void>;
}

export async function startHttpServer(
  server: McpServer,
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

      let transport: StreamableHTTPServerTransport;
      if (sessionId && sessions.has(sessionId)) {
        transport = sessions.get(sessionId)!;
      } else {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
            log.debug(`session opened ${id}`);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
            log.debug(`session closed ${transport.sessionId}`);
          }
        };
        await server.connect(transport);
      }

      // Drain the request body — handleRequest expects a parsed JSON body.
      const body = await readBody(req);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log.error('mcp http handler failed', { err: String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal' }));
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
