import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@beside/interfaces';
import { createOpencode, type OpencodeClient, type Part } from '@opencode-ai/sdk';
import type { OrchestratorHandles } from '../orchestrator.js';
import type { ChatStreamEvent, ChatStreamHandler, ChatTurnInput } from './types.js';


// Full Beside MCP tool surface (prefixed `beside_`). The agent is
// responsible for picking which to call — we do not curate a subset.
// `beside_trigger_reindex` is intentionally excluded: it is a mutating
// admin action that should not be invoked from a chat turn.
const BESIDE_AGENT_TOOLS = [
  'beside_search_memory',
  'beside_remember_memory',
  'beside_memory_status',
  'beside_get_memory_tree',
  'beside_get_memory_evidence',
  'beside_search_frames',
  'beside_get_frame_context',
  'beside_get_journal',
  'beside_get_page',
  'beside_get_index',
  'beside_list_entities',
  'beside_get_entity',
  'beside_get_entity_frames',
  'beside_list_entity_neighbours',
  'beside_get_entity_timeline',
  'beside_get_entity_summary',
  'beside_query_raw_events',
  'beside_list_sessions',
  'beside_get_activity_session',
  'beside_get_session',
  'beside_get_daily_summary',
  'beside_get_calendar_events',
  'beside_get_open_loops',
  'beside_get_slack_activity',
  'beside_list_meetings',
  'beside_get_meeting',
  'beside_summarize_meeting',
  'beside_get_reindex_status',
] as const;

const AGENT_NAME = 'beside-memory';
const AGENT_STEPS = 16;

interface OpenCodeRuntime {
  client: OpencodeClient;
  close(): void;
}

interface SessionMessageSnapshot {
  info: {
    id: string;
    role: 'user' | 'assistant';
    time?: { created?: number };
  };
  parts: Part[];
}

export class OpenCodeHarness {
  private runtime: Promise<OpenCodeRuntime> | null = null;
  private readonly sessions = new Map<string, string>();

  constructor(private readonly logger: Logger) {}

  close(): void {
    if (!this.runtime) return;
    void this.runtime.then((runtime) => runtime.close()).catch(() => {});
    this.runtime = null;
    this.sessions.clear();
  }

  async runTurn(
    handles: OrchestratorHandles,
    input: ChatTurnInput,
    onEvent: ChatStreamHandler,
  ): Promise<void> {
    const emit = (event: Record<string, unknown>) => {
      onEvent({ ...event, turnId: input.turnId } as ChatStreamEvent);
    };

    const startedAt = Date.now();
    emit({ kind: 'phase', phase: 'execute' });

    try {
      const runtime = await this.getRuntime(handles);
      const directory = await ensureOpenCodeDirectory(handles.loaded.dataDir, input.conversationId);
      const sessionId = await this.getSessionId(runtime.client, directory, input);
      const model = getOllamaModel(handles);
      // Track which assistant messages already existed so we can collect
      // only the parts produced by this turn afterwards. The prompt
      // response only returns the final step's parts; tool calls and
      // intermediate reasoning live in earlier assistant messages within
      // the same turn.
      const beforeMessageIds = await listAssistantMessageIds(runtime.client, directory, sessionId);

      const response = await runtime.client.session.prompt({
        path: { id: sessionId },
        query: { directory },
        body: {
          agent: AGENT_NAME,
          model,
          system: buildTurnContext(),
          parts: [{ type: 'text', text: renderUserPrompt(input) }],
        },
      });

      const error = response.data?.info.error;
      if (error) throw new Error(formatOpenCodeError(error));

      const parts = await collectNewAssistantParts(
        runtime.client,
        directory,
        sessionId,
        beforeMessageIds,
        response.data?.parts ?? [],
      );
      const summary = emitParts(parts, input.turnId, onEvent);
      this.logger.info('opencode turn done', {
        turnId: input.turnId,
        tools: summary.toolCalls,
        textChars: summary.textChars,
        durationMs: Date.now() - startedAt,
      });
      onEvent({ kind: 'done', turnId: input.turnId });
    } catch (err) {
      this.logger.error('opencode chat turn failed', { err: String(err) });
      onEvent({
        kind: 'error',
        turnId: input.turnId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async getRuntime(handles: OrchestratorHandles): Promise<OpenCodeRuntime> {
    if (!this.runtime) {
      this.runtime = this.startRuntime(handles).catch((err) => {
        this.runtime = null;
        throw err;
      });
    }
    return await this.runtime;
  }

  private async startRuntime(handles: OrchestratorHandles): Promise<OpenCodeRuntime> {
    prepareOpenCodeEnvironment();
    const port = await pickFreePort();
    const mcpUrl = getMcpUrl(handles);
    const model = getOllamaModel(handles);
    const numCtx = getOllamaNumCtx(handles);
    await warnIfOllamaContextSmallerThan(
      this.logger,
      handles.config.index.model.ollama.host || 'http://127.0.0.1:11434',
      model.modelID,
      numCtx,
    );
    const config = buildOpenCodeConfig(handles, mcpUrl);
    this.logger.info('starting opencode harness', {
      port,
      mcpUrl,
      model: `${model.providerID}/${model.modelID}`,
      numCtx,
      steps: AGENT_STEPS,
      tools: BESIDE_AGENT_TOOLS.length,
    });
    const runtime = await createOpencode({
      hostname: '127.0.0.1',
      port,
      timeout: 15_000,
      config,
    });
    return {
      client: runtime.client,
      close: () => runtime.server.close(),
    };
  }

  private async getSessionId(
    client: OpencodeClient,
    directory: string,
    input: ChatTurnInput,
  ): Promise<string> {
    const existing = this.sessions.get(input.conversationId);
    if (existing) return existing;

    const title = input.message.trim().replace(/\s+/g, ' ').slice(0, 80) || 'Beside memory chat';
    const created = await client.session.create({
      query: { directory },
      body: { title },
    });
    if (!created.data?.id) throw new Error('OpenCode did not return a session id.');
    this.sessions.set(input.conversationId, created.data.id);
    return created.data.id;
  }
}

function buildOpenCodeConfig(handles: OrchestratorHandles, mcpUrl: string): Record<string, unknown> {
  const ollama = handles.config.index.model.ollama;
  const model = ollama.model?.trim() || 'gemma4:e4b';
  const baseURL = toOpenAiBaseUrl(ollama.host || 'http://127.0.0.1:11434');
  // Note: the harness can't push `num_ctx` per request through this
  // path. OpenCode spawns its own process and serialises this config
  // to JSON, so the @ai-sdk/openai-compatible provider can only see
  // JSON-safe options (baseURL, apiKey, headers) — there is no
  // `extraBody` field, and a custom `fetch` function wouldn't survive
  // the serialisation either. Context length for harness calls is set
  // on the Ollama service via `OLLAMA_CONTEXT_LENGTH`. We warn at
  // startup if the loaded context is smaller than `ollama.num_ctx`.

  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    snapshot: false,
    share: 'disabled',
    enabled_providers: ['ollama'],
    model: `ollama/${model}`,
    small_model: `ollama/${model}`,
    provider: {
      ollama: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ollama (local)',
        options: {
          baseURL,
          apiKey: 'ollama',
          timeout: 300_000,
        },
        models: {
          [model]: { name: model },
        },
      },
    },
    mcp: {
      beside: {
        type: 'remote',
        url: mcpUrl,
        enabled: true,
        oauth: false,
        timeout: 15_000,
      },
    },
    agent: {
      [AGENT_NAME]: {
        mode: 'primary',
        model: `ollama/${model}`,
        temperature: 0.1,
        steps: AGENT_STEPS,
        permission: besideToolPermission(),
        tools: besideTools(),
        prompt: buildAgentPrompt(),
      },
    },
  };
}

// Stable agent prompt. Volatile per-turn context (date/time) is passed
// separately via `system` on each `session.prompt` call.
function buildAgentPrompt(): string {
  return [
    'You are Beside, a private local memory assistant. You help the user recall and reason about their own captured device activity (frames, OCR text, calendar UIs, chats, focus sessions, meetings). You are NOT a coding assistant.',
    '',
    'How to work:',
    '1. Decide which Beside MCP tools to call based on the user question. You are responsible for tool selection — do not wait for routing.',
    '2. Resolve relative dates ("today", "yesterday", "last week") against the local date the user-turn context gives you, then pass dates as YYYY-MM-DD.',
    '3. Prefer the smallest number of tool calls that answer the question. If one tool returns enough evidence, stop and answer.',
    '4. When a tool returns a candidate list (e.g. list_meetings, list_entities) and the question asks for details, follow up with the matching detail tool (get_meeting, get_entity) before answering.',
    '5. Use compact=true on tools that support it unless the user explicitly asks for raw detail.',
    '',
    'Tool surface (all prefixed `beside_`):',
    '- search_memory: blended default — frames, memory chunks, memory tree, pages. Good first stop for open-ended questions.',
    '- search_frames / get_frame_context: specific captured moments and context around them.',
    '- get_journal / get_page / get_index: written summaries and indexed wiki pages.',
    '- list_entities / get_entity / get_entity_frames / get_entity_summary / get_entity_timeline / list_entity_neighbours: people, projects, channels, repos.',
    '- list_sessions / get_activity_session / get_session / query_raw_events: time-range activity.',
    '- get_daily_summary / get_calendar_events / get_open_loops: day overview, schedule, pending follow-ups.',
    '- list_meetings / get_meeting / summarize_meeting: meeting recall.',
    '- get_slack_activity: chat threads on a day.',
    '- remember_memory: store a durable fact/procedure when the user explicitly asks you to remember something.',
    '- get_memory_tree / get_memory_evidence / memory_status: durable memory layer above chunks.',
    '',
    'Answering:',
    '- Answer only from tool results. Copy dates, times, titles, ids, and names exactly from tool output. Do not invent or substitute.',
    '- If tools return nothing relevant, say: "I don\'t see that in your captures." Do not fall back to generic productivity advice.',
    '- Do not greet the user or ask what they want — answer the current question directly.',
  ].join('\n');
}

function buildTurnContext(): string {
  const now = new Date();
  return [
    `Current local time: ${now.toString()}`,
    `Current local day: ${formatLocalDay(now)}`,
  ].join('\n');
}

function renderUserPrompt(input: ChatTurnInput): string {
  const history = input.history
    .slice(-8)
    .map((item) => `${item.role === 'user' ? 'User' : 'Beside'}: ${truncate(item.content, 900)}`)
    .join('\n\n');
  return [
    history ? `Recent chat history:\n${history}` : null,
    `User question:\n${input.message}`,
  ].filter(Boolean).join('\n\n');
}

interface EmitSummary {
  toolCalls: string[];
  textChars: number;
}

function emitParts(parts: Part[], turnId: string, onEvent: ChatStreamHandler): EmitSummary {
  const toolCalls: string[] = [];
  let text = '';
  for (const part of parts) {
    if (part.type === 'reasoning' && part.text.trim()) {
      onEvent({ kind: 'reasoning', turnId, text: truncate(part.text.trim(), 1600) });
      continue;
    }
    if (part.type === 'tool') {
      if (!isBesideAgentTool(part.tool)) continue;
      const callId = `${turnId}:opencode:${part.callID}`;
      const args = 'input' in part.state ? part.state.input : {};
      onEvent({ kind: 'tool-call', turnId, tool: part.tool, args, callId });
      toolCalls.push(part.tool);
      if (part.state.status === 'completed') {
        onEvent({
          kind: 'tool-result',
          turnId,
          callId,
          tool: part.tool,
          summary: summariseToolOutput(part.state.title || part.state.output),
        });
      } else if (part.state.status === 'error') {
        onEvent({
          kind: 'tool-result',
          turnId,
          callId,
          tool: part.tool,
          summary: truncate(part.state.error, 500),
        });
      }
      continue;
    }
    if (part.type === 'text' && part.text) {
      text += part.text;
    }
  }
  if (text.trim()) onEvent({ kind: 'content', turnId, delta: text });
  return { toolCalls, textChars: text.length };
}

function summariseToolOutput(output: string): string {
  const collapsed = output.replace(/\s+/g, ' ').trim();
  return truncate(collapsed || 'done', 700);
}

function besideToolPermission(): Record<string, 'allow' | 'deny'> {
  return Object.fromEntries([
    ['*', 'deny'],
    ...BESIDE_AGENT_TOOLS.map((tool) => [tool, 'allow'] as const),
  ]);
}

function besideTools(): Record<string, boolean> {
  return Object.fromEntries([
    ['*', false],
    ...BESIDE_AGENT_TOOLS.map((tool) => [tool, true] as const),
  ]);
}

function isBesideAgentTool(tool: string): boolean {
  return (BESIDE_AGENT_TOOLS as readonly string[]).includes(tool);
}

function getOllamaNumCtx(handles: OrchestratorHandles): number {
  const raw = (handles.config.index.model.ollama as { num_ctx?: number }).num_ctx;
  return typeof raw === 'number' && raw > 0 ? Math.floor(raw) : 0;
}

// Probe Ollama's currently-loaded context length for `model` and warn
// if it is smaller than the configured `num_ctx`. Harness calls flow
// through OpenCode → @ai-sdk/openai-compatible, which has no field for
// passing Ollama's `options.num_ctx` per request; the only mechanism
// is `OLLAMA_CONTEXT_LENGTH` on the Ollama service.
// See: https://docs.ollama.com/faq#how-can-i-specify-the-context-window-size
async function warnIfOllamaContextSmallerThan(
  logger: Logger,
  ollamaHost: string,
  model: string,
  configuredNumCtx: number,
): Promise<void> {
  if (configuredNumCtx <= 0) return;
  try {
    const host = ollamaHost.replace(/\/+$/, '');
    const res = await fetch(`${host}/api/ps`, { method: 'GET' });
    if (!res.ok) return;
    const data = (await res.json()) as { models?: Array<{ name?: string; model?: string; context_length?: number }> };
    const entry = (data.models ?? []).find((m) => m.name === model || m.model === model);
    if (!entry?.context_length) return;
    if (entry.context_length < configuredNumCtx) {
      logger.warn('Ollama is running with a smaller context window than configured; the harness can only use what Ollama loads', {
        model,
        loadedContextLength: entry.context_length,
        configuredNumCtx,
        fix: `set OLLAMA_CONTEXT_LENGTH=${configuredNumCtx} on the Ollama service and restart it (Ollama will clamp to the model's max)`,
        doc: 'https://docs.ollama.com/faq#how-can-i-specify-the-context-window-size',
      });
    }
  } catch {
    // best-effort diagnostic; don't fail startup if Ollama is unreachable
  }
}

async function listSessionMessages(
  client: OpencodeClient,
  directory: string,
  sessionId: string,
): Promise<SessionMessageSnapshot[]> {
  const response = await client.session.messages({
    path: { id: sessionId },
    query: { directory },
  });
  return Array.isArray(response.data) ? (response.data as SessionMessageSnapshot[]) : [];
}

async function listAssistantMessageIds(
  client: OpencodeClient,
  directory: string,
  sessionId: string,
): Promise<Set<string>> {
  const messages = await listSessionMessages(client, directory, sessionId);
  return new Set(messages.map((m) => m.info.id));
}

// The `session.prompt` response only returns the last assistant
// message's parts. When the agent ran multiple steps (e.g. reasoning →
// tool call → answer), each step is a separate assistant message and
// only the final one is in the response. We diff against the
// pre-prompt assistant message ids to collect the full set of new
// parts in chronological order.
async function collectNewAssistantParts(
  client: OpencodeClient,
  directory: string,
  sessionId: string,
  beforeMessageIds: Set<string>,
  fallbackParts: Part[],
): Promise<Part[]> {
  try {
    const messages = await listSessionMessages(client, directory, sessionId);
    const parts = messages
      .filter((m) => m.info.role === 'assistant' && !beforeMessageIds.has(m.info.id))
      .sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0))
      .flatMap((m) => m.parts);
    return parts.length ? parts : fallbackParts;
  } catch {
    return fallbackParts;
  }
}

function getOllamaModel(handles: OrchestratorHandles): { providerID: string; modelID: string } {
  return { providerID: 'ollama', modelID: handles.config.index.model.ollama.model?.trim() || 'gemma4:e4b' };
}

function getMcpUrl(handles: OrchestratorHandles): string {
  const mcp = handles.config.export.plugins.find((plugin) => plugin.name === 'mcp');
  if (mcp?.enabled === false) throw new Error('Beside MCP export is disabled. Enable the MCP server in Settings.');
  const host = typeof mcp?.host === 'string' && mcp.host.trim() ? mcp.host.trim() : '127.0.0.1';
  const port = typeof mcp?.port === 'number' ? mcp.port : 3456;
  return `http://${host}:${port}`;
}

function toOpenAiBaseUrl(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, '') || 'http://127.0.0.1:11434';
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

async function ensureOpenCodeDirectory(dataDir: string, conversationId: string): Promise<string> {
  const directory = path.join(dataDir, 'opencode-harness', safePathSegment(conversationId));
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return safe || 'conversation';
}

async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('Could not allocate an OpenCode server port.'));
      });
    });
  });
}

function prepareOpenCodeEnvironment(): void {
  const dirs = [
    path.join(packageRoot(), 'node_modules/.bin'),
    path.join(process.cwd(), 'node_modules/.bin'),
  ];
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const existing = process.env.PATH ?? '';
  process.env.PATH = [...dirs, existing].filter(Boolean).join(delimiter);
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

function formatOpenCodeError(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) {
    const e = error as { name?: string; data?: { message?: string } };
    return [e.name, e.data?.message].filter(Boolean).join(': ');
  }
  return String(error);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function formatLocalDay(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
