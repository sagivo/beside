import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@beside/interfaces';
import { createOpencode, type OpencodeClient, type Part } from '@opencode-ai/sdk';
import type { OrchestratorHandles } from '../orchestrator.js';
import type { ChatStreamEvent, ChatStreamHandler, ChatTurnInput } from './types.js';

// Full Beside MCP tool surface (prefixed `beside_`). The agent is
// responsible for picking which to call. `beside_trigger_reindex` is
// intentionally excluded: it is a mutating admin action that should not
// be invoked from a chat turn.
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

interface EmitOptions {
  emitContent?: boolean;
  /**
   * Part ids that the live SSE subscriber has already streamed to the
   * renderer. The post-prompt batch emit skips these so the renderer
   * does not see duplicate reasoning / tool / content events.
   */
  streamed?: StreamedPartTracker;
}

/**
 * Tracks which OpenCode message parts have already been emitted live by
 * the SSE subscription, so the post-prompt batch reconciliation pass
 * does not double-emit them. Tool calls and tool results are tracked
 * separately because they fire as the tool state transitions.
 */
interface StreamedPartTracker {
  reasoningPartIds: Set<string>;
  textPartIds: Set<string>;
  toolCallIds: Set<string>;
  toolResultCallIds: Set<string>;
}

interface StreamSubscription {
  stop: () => void;
  readonly streamed: StreamedPartTracker;
  /**
   * True once the SSE subscriber emitted text that survived the
   * non-answer filter, meaning the live stream already delivered a real
   * answer to the renderer.
   */
  readonly emittedRealText: boolean;
  /**
   * Called before a retry prompt: clears `emittedRealText` and the
   * accumulated text-part state so the next prompt can stream fresh
   * content without colliding with the discarded draft.
   */
  resetEmittedText: () => void;
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

    let streamSubscription: StreamSubscription | null = null;

    try {
      const runtime = await this.getRuntime(handles);
      const directory = await ensureOpenCodeDirectory(handles.loaded.dataDir, input.conversationId);
      const sessionId = await this.getSessionId(runtime.client, directory, input);
      const model = getOllamaModel(handles);
      const tools = BESIDE_AGENT_TOOLS;

      // Track which messages already existed so we can collect only the
      // assistant parts produced by this turn afterwards. The prompt
      // response only returns the final step's parts; tool calls and
      // intermediate reasoning live in earlier assistant messages.
      const beforeMessageIds = await listSessionMessageIds(runtime.client, directory, sessionId);

      // Subscribe to the SSE event stream so reasoning, tool calls, and
      // text tokens reach the renderer as they happen instead of in a
      // single batch after the prompt resolves.
      streamSubscription = await startStreamSubscription(
        runtime.client,
        sessionId,
        input.turnId,
        onEvent,
        this.logger,
      );

      const response = await runtime.client.session.prompt({
        path: { id: sessionId },
        query: { directory },
        body: {
          agent: AGENT_NAME,
          model,
          system: buildTurnSystemPrompt(tools),
          tools: besideTurnTools(tools),
          parts: [{ type: 'text', text: renderUserPrompt(input) }],
        },
      });

      const error = response.data?.info.error;
      if (error) throw new Error(formatOpenCodeError(error));

      emit({ kind: 'phase', phase: 'compose' });
      const parts = await collectNewAssistantParts(
        runtime.client,
        directory,
        sessionId,
        beforeMessageIds,
        response.data?.parts ?? [],
      );
      const evidence = collectToolEvidence(parts, input.message);
      let emittedText = emitParts(parts, input.turnId, onEvent, {
        emitContent: !evidence,
        streamed: streamSubscription.streamed,
      });

      if (streamSubscription.emittedRealText) emittedText = true;
      let gatheredEvidence = evidence;
      for (let attempt = 0; !emittedText && attempt < 2; attempt += 1) {
        // The first prompt either produced no text or only generic
        // filler. Wipe any streamed draft so the user sees a clean
        // continuation answer.
        onEvent({ kind: 'content-reset', turnId: input.turnId });
        streamSubscription.resetEmittedText();
        const continuationTools = continuationToolsFor(input.message, gatheredEvidence);
        const retryBeforeMessageIds = await listSessionMessageIds(runtime.client, directory, sessionId);
        const retry = await runtime.client.session.prompt({
          path: { id: sessionId },
          query: { directory },
          body: {
            agent: AGENT_NAME,
            model,
            system: buildContinuationSystemPrompt(continuationTools),
            tools: besideTurnTools(continuationTools),
            parts: [{
              type: 'text',
              text: buildContinuationUserPrompt(
                input.message,
                gatheredEvidence,
                continuationTools.length > 0,
              ),
            }],
          },
        });
        const retryError = retry.data?.info.error;
        if (retryError) throw new Error(formatOpenCodeError(retryError));
        const retryParts = await collectNewAssistantParts(
          runtime.client,
          directory,
          sessionId,
          retryBeforeMessageIds,
          retry.data?.parts ?? [],
        );
        gatheredEvidence = [gatheredEvidence, collectToolEvidence(retryParts, input.message)]
          .filter(Boolean)
          .join('\n\n');
        emittedText = emitParts(retryParts, input.turnId, onEvent, {
          streamed: streamSubscription.streamed,
        });
        if (streamSubscription.emittedRealText) emittedText = true;
      }
      if (!emittedText) {
        onEvent({
          kind: 'content',
          turnId: input.turnId,
          delta: fallbackAnswer(),
        });
      }

      this.logger.info('opencode turn done', {
        turnId: input.turnId,
        emittedText,
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
    } finally {
      streamSubscription?.stop();
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
    if (existing) {
      this.logger.info('reusing opencode session', { conversationId: input.conversationId, sessionId: existing });
      return existing;
    }

    const title = input.message.trim().replace(/\s+/g, ' ').slice(0, 80) || 'Beside memory chat';
    const created = await client.session.create({
      query: { directory },
      body: { title },
    });
    if (!created.data?.id) throw new Error('OpenCode did not return a session id.');
    this.logger.info('created opencode session', { conversationId: input.conversationId, sessionId: created.data.id });
    this.sessions.set(input.conversationId, created.data.id);
    return created.data.id;
  }
}

function buildOpenCodeConfig(handles: OrchestratorHandles, mcpUrl: string): Record<string, unknown> {
  const ollama = handles.config.index.model.ollama;
  const model = ollama.model?.trim() || 'gemma4:e4b';
  const baseURL = toOpenAiBaseUrl(ollama.host || 'http://127.0.0.1:11434');
  // The harness cannot push `num_ctx` per request through this path.
  // OpenCode serialises this config to JSON, so the
  // @ai-sdk/openai-compatible provider can only see JSON-safe options
  // such as baseURL, apiKey, and headers. Context length for harness
  // calls is set on the Ollama service via `OLLAMA_CONTEXT_LENGTH`; we
  // warn at startup if the loaded context is smaller than `ollama.num_ctx`.

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
    '1. Decide which Beside MCP tools to call based on the user question. You are responsible for tool selection. Do not wait for routing.',
    '2. Resolve relative dates ("today", "yesterday", "last week") against the local date the user-turn context gives you, then pass dates as YYYY-MM-DD.',
    '3. Answer the most recent User question. Resolve references like "this user", "that meeting", or "the one above" against the prior messages in this conversation. If a previous Beside response named or hinted at an entity, follow up about that same entity.',
    '4. Prefer the smallest number of tool calls that answer the question. If one tool returns enough evidence, stop and answer.',
    '5. When a tool returns a candidate list and the question asks for details, follow up with the matching detail tool before answering.',
    '6. Use compact=true on tools that support it unless the user explicitly asks for raw detail.',
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
    '- Do not greet the user or ask what they want. Answer the current question directly.',
  ].join('\n');
}

function buildTurnSystemPrompt(tools: readonly string[]): string {
  const day = formatLocalDay();
  return [
    'You are Beside, a private helper AI agent. You are not a coding assistant.',
    `Current local date/time: ${new Date().toString()}.`,
    `Current local day: ${day}.`,
    `Available tools this turn: ${tools.join(', ')}.`,
    'Use only exact tool names from Available tools this turn.',
    'Resolve relative dates such as today, yesterday, this week, or last week against that local date/time before calling tools.',
    'When a Beside tool asks for a day, pass dates as YYYY-MM-DD.',
    'For questions about the user, their captures, work, meetings, messages, or tasks, call at least one Beside MCP tool before answering.',
    'Pick tools yourself. Do not wait for the app to route you.',
    'Answer the most recent User question. Resolve references like "this user", "that meeting", "the one above" against the prior messages in this conversation. They are the user\'s real history with you, not test probes.',
    'Use the fewest MCP calls needed. If one tool returns enough evidence for the current question, stop tool use and answer.',
    'Use compact=true on tools that support it unless the user asks for raw detail.',
    'If a meeting question only asks which meetings happened, listing meetings is enough. If it asks what was discussed, fetch the chosen meeting details after listing.',
    'For person-specific recall, answer only if the returned evidence explicitly names that person or clearly matches the ask.',
    'After any tool returns, answer the user directly from the tool result. Never reply with a generic greeting or "how can I help?".',
    'Copy dates, times, titles, ids, and names exactly from the tool result. Do not replace them with examples or approximations.',
    'If the tool result does not explicitly support the requested person, topic, ask, or date, say: "I don\'t see that in your captures."',
  ].join('\n');
}

function buildContinuationSystemPrompt(tools: readonly string[]): string {
  return [
    'You are Beside, a private helper AI agent. Continue the current answer.',
    `Available tools this turn: ${tools.length ? tools.join(', ') : '(none)'}.`,
    'Use exact tool names only. Answer only from prior or newly returned tool evidence.',
    'If the prior result is only a candidate list and the question asks for details, call the relevant detail tool before answering.',
    'Do not ask what the user wants to recall. If the available evidence is relevant, answer it; otherwise say you do not see it in captures.',
  ].join('\n');
}

function buildContinuationUserPrompt(
  originalQuestion: string,
  evidence: string,
  canCallTools: boolean,
): string {
  return [
    'Finish the answer for the original user question using the exact tool evidence below.',
    `Original question:\n${originalQuestion}`,
    evidence ? `Tool evidence already returned:\n${evidence}` : 'No usable tool evidence was returned yet.',
    'If the evidence is enough, answer directly from it. Copy dates, times, titles, ids, names, and counts exactly from the evidence.',
    'For Slack activity evidence, answer with bullets based on the returned thread_lines. Each bullet should preserve the timestamp and concrete message text. Do not replace messages with vague labels. Do not invent themes, channels, users, or dates.',
    'For search frame evidence, answer from the Frame matches bullets. Use the app, window title, timestamp, entity, and excerpt shown there; do not switch to a different app/date/topic.',
    canCallTools
      ? 'If the evidence is only a candidate list and details are needed, call the available Beside MCP detail tool. For a meeting discussion, call beside_get_meeting for the best matching summarized meeting id before answering.'
      : 'Do not call more tools in this compose step.',
    'If the evidence does not support the answer, say: "I don\'t see that in your captures."',
    'Do not greet the user, ask what to recall, or mention that you are continuing.',
  ].join('\n\n');
}

function renderUserPrompt(input: ChatTurnInput): string {
  const history = input.history
    .slice(-8)
    .map((item) => `${item.role === 'user' ? 'User' : 'Beside'}: ${truncate(item.content, 900)}`)
    .join('\n\n');
  return [
    history ? `Recent chat history:\n${history}` : null,
    `Current local day: ${formatLocalDay()}`,
    `User question:\n${input.message}`,
    'Use the available Beside MCP tools as needed, then answer directly from the returned evidence.',
  ].filter(Boolean).join('\n\n');
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

async function listSessionMessageIds(
  client: OpencodeClient,
  directory: string,
  sessionId: string,
): Promise<Set<string>> {
  const messages = await listSessionMessages(client, directory, sessionId);
  return new Set(messages.map((message) => message.info.id));
}

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
      .filter((message) => message.info.role === 'assistant' && !beforeMessageIds.has(message.info.id))
      .sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0))
      .flatMap((message) => message.parts);
    return parts.length ? parts : fallbackParts;
  } catch {
    return fallbackParts;
  }
}

async function startStreamSubscription(
  client: OpencodeClient,
  sessionId: string,
  turnId: string,
  onEvent: ChatStreamHandler,
  logger: Logger,
): Promise<StreamSubscription> {
  const streamed: StreamedPartTracker = {
    reasoningPartIds: new Set(),
    textPartIds: new Set(),
    toolCallIds: new Set(),
    toolResultCallIds: new Set(),
  };
  // OpenCode SSE `message.part.updated` events carry cumulative text, so
  // compute deltas against what has already been streamed.
  const textAccumulated = new Map<string, string>();
  let emittedRealText = false;
  let stopped = false;
  const abort = new AbortController();
  let subscription: { stream: AsyncGenerator<unknown, unknown, unknown> } | null = null;

  try {
    subscription = await (client as unknown as {
      event: {
        subscribe: (options?: { signal?: AbortSignal }) =>
          Promise<{ stream: AsyncGenerator<unknown, unknown, unknown> }>;
      };
    }).event.subscribe({ signal: abort.signal });
  } catch (err) {
    logger.warn('opencode SSE subscribe failed; falling back to batch emit', { err: String(err) });
    return {
      stop: () => {},
      streamed,
      get emittedRealText() { return false; },
      resetEmittedText: () => {},
    };
  }

  const stopFn = () => {
    if (stopped) return;
    stopped = true;
    try { abort.abort(); } catch {}
  };

  void (async () => {
    try {
      for await (const raw of subscription.stream) {
        if (stopped) break;
        const event = raw as { type?: string; properties?: Record<string, unknown> };
        if (event?.type !== 'message.part.updated') continue;
        const part = (event.properties?.part ?? {}) as
          | {
              id?: string;
              sessionID?: string;
              type?: string;
              text?: string;
              tool?: string;
              callID?: string;
              state?: {
                status?: string;
                input?: Record<string, unknown>;
                output?: string;
                title?: string;
                error?: string;
              };
            }
          | undefined;
        if (!part || part.sessionID !== sessionId || !part.id) continue;

        if (part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
          streamed.reasoningPartIds.add(part.id);
          onEvent({ kind: 'reasoning', turnId, text: truncate(part.text.trim(), 1600), partId: part.id });
          continue;
        }

        if (part.type === 'tool' && part.tool && part.callID && isBesideAgentTool(part.tool)) {
          const callId = `${turnId}:opencode:${part.callID}`;
          const status = part.state?.status;
          if (!streamed.toolCallIds.has(callId)) {
            streamed.toolCallIds.add(callId);
            onEvent({
              kind: 'tool-call',
              turnId,
              tool: part.tool,
              args: (part.state?.input ?? {}) as Record<string, unknown>,
              callId,
            });
          }
          if (status === 'completed' && !streamed.toolResultCallIds.has(callId)) {
            streamed.toolResultCallIds.add(callId);
            onEvent({
              kind: 'tool-result',
              turnId,
              callId,
              tool: part.tool,
              summary: summariseToolOutput(part.state?.title || part.state?.output || ''),
            });
          } else if (status === 'error' && !streamed.toolResultCallIds.has(callId)) {
            streamed.toolResultCallIds.add(callId);
            onEvent({
              kind: 'tool-result',
              turnId,
              callId,
              tool: part.tool,
              summary: truncate(part.state?.error || 'tool failed', 500),
            });
          }
          continue;
        }

        if (part.type === 'text' && typeof part.text === 'string') {
          const next = part.text;
          const prev = textAccumulated.get(part.id) ?? '';
          if (next.length <= prev.length) continue;
          const delta = next.slice(prev.length);
          textAccumulated.set(part.id, next);
          if (!delta.trim() && !prev) continue;
          streamed.textPartIds.add(part.id);
          emittedRealText = true;
          onEvent({ kind: 'content', turnId, delta });
        }
      }
    } catch (err) {
      if (!stopped) logger.warn('opencode SSE reader ended', { err: String(err) });
    }
  })();

  return {
    stop: () => stopFn(),
    streamed,
    get emittedRealText() { return emittedRealText; },
    resetEmittedText: () => {
      emittedRealText = false;
      textAccumulated.clear();
      streamed.textPartIds.clear();
    },
  };
}

function emitParts(
  parts: Part[],
  turnId: string,
  onEvent: ChatStreamHandler,
  options: EmitOptions = {},
): boolean {
  const emitContent = options.emitContent !== false;
  const streamed = options.streamed;
  let text = '';
  let textStreamed = false;
  for (const part of parts) {
    if (part.type === 'reasoning' && part.text.trim()) {
      if (streamed?.reasoningPartIds.has(part.id)) continue;
      onEvent({ kind: 'reasoning', turnId, text: truncate(part.text.trim(), 1600), partId: part.id });
      streamed?.reasoningPartIds.add(part.id);
      continue;
    }
    if (part.type === 'tool') {
      if (!isBesideAgentTool(part.tool)) continue;
      const callId = `${turnId}:opencode:${part.callID}`;
      if (!streamed?.toolCallIds.has(callId)) {
        const input = 'input' in part.state ? part.state.input : {};
        onEvent({ kind: 'tool-call', turnId, tool: part.tool, args: input, callId });
        streamed?.toolCallIds.add(callId);
      }
      if (part.state.status === 'completed' && !streamed?.toolResultCallIds.has(callId)) {
        onEvent({
          kind: 'tool-result',
          turnId,
          callId,
          tool: part.tool,
          summary: summariseToolOutput(part.state.title || part.state.output),
        });
        streamed?.toolResultCallIds.add(callId);
      } else if (part.state.status === 'error' && !streamed?.toolResultCallIds.has(callId)) {
        onEvent({
          kind: 'tool-result',
          turnId,
          callId,
          tool: part.tool,
          summary: truncate(part.state.error, 500),
        });
        streamed?.toolResultCallIds.add(callId);
      }
      continue;
    }
    if (part.type === 'text' && part.text) {
      text += part.text;
      if (streamed?.textPartIds.has(part.id)) textStreamed = true;
    }
  }
  if (!emitContent || !text.trim() || isGenericNonAnswer(text)) return false;
  if (textStreamed) return true;
  onEvent({ kind: 'content', turnId, delta: text });
  return true;
}

function collectToolEvidence(parts: Part[], question: string): string {
  const entries: string[] = [];
  const selectedParts = selectEvidenceParts(parts, question);
  for (const part of selectedParts) {
    const input = 'input' in part.state ? part.state.input : {};
    const output = 'output' in part.state
      ? part.state.output
      : 'title' in part.state
        ? part.state.title
        : '';
    entries.push([
      `Tool: ${part.tool}`,
      `Arguments: ${JSON.stringify(input)}`,
      formatToolEvidenceOutput(part.tool, output || ''),
    ].join('\n'));
  }
  return entries.join('\n\n');
}

function selectEvidenceParts(parts: Part[], question: string): Array<Extract<Part, { type: 'tool' }>> {
  const completed: Array<Extract<Part, { type: 'tool' }>> = [];
  for (const part of parts) {
    if (part.type !== 'tool' || part.state.status !== 'completed') continue;
    if (!isBesideAgentTool(part.tool)) continue;
    completed.push(part);
  }
  const first = completed[0];
  if (!first) return [];
  const selected = [first];
  if (first.tool === 'beside_list_meetings' && meetingDetailRequested(question)) {
    const detail = completed.find((part) => part.tool === 'beside_get_meeting');
    if (detail) selected.push(detail);
  }
  return selected;
}

function formatToolEvidenceOutput(tool: string, output: string): string {
  const parsed = parseJsonObject(output);
  if (tool === 'beside_get_slack_activity' && parsed) return formatSlackEvidence(parsed);
  if (tool === 'beside_list_meetings' && parsed) return formatMeetingListEvidence(parsed);
  if (tool === 'beside_get_meeting' && parsed) return formatMeetingEvidence(parsed);
  if (tool === 'beside_get_daily_summary' && parsed) return formatDailyEvidence(parsed);
  if ((tool === 'beside_search_memory' || tool === 'beside_search_frames') && parsed) {
    return formatSearchEvidence(parsed);
  }
  return `Result:\n${truncate(output, 8_000)}`;
}

function formatSlackEvidence(parsed: Record<string, unknown>): string {
  const lines = stringArray(parsed.thread_lines);
  const notes = stringArray(parsed.notes);
  return [
    `Result: Slack activity for day=${stringValue(parsed.day) ?? 'unknown'}, channel=${stringValue(parsed.channel) ?? 'any'}, query=${stringValue(parsed.query) ?? 'none'}, count=${numberValue(parsed.count) ?? lines.length}.`,
    lines.length ? `Slack thread lines to summarize exactly:\n${lines.map((line) => `- ${line}`).join('\n')}` : 'Slack thread lines to summarize exactly: none.',
    notes.length ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : null,
  ].filter(Boolean).join('\n');
}

function formatMeetingListEvidence(parsed: Record<string, unknown>): string {
  const meetings = arrayValue(parsed.items).slice(0, 12).map((item) => {
    const rec = recordValue(item);
    const title = stringValue(rec.title) ?? stringValue(rec.entity_path) ?? 'untitled';
    const summary = stringValue(rec.tldr) ? `: ${stringValue(rec.tldr)}` : '';
    const time = stringValue(rec.time)
      ?? `${stringValue(rec.started_at) ?? ''}-${stringValue(rec.ended_at) ?? ''}`.replace(/^-|-$/g, '');
    return `${time} ${title} (${stringValue(rec.platform) ?? 'unknown'}, ${numberValue(rec.duration_min) ?? '?'} min, id=${stringValue(rec.id) ?? 'unknown'})${summary}`;
  });
  return [
    `Result: ${meetings.length} meeting(s).`,
    meetings.length ? `Meetings:\n${meetings.map((line) => `- ${line}`).join('\n')}` : 'Meetings: none.',
  ].join('\n');
}

function formatMeetingEvidence(parsed: Record<string, unknown>): string {
  const meeting = recordValue(parsed.meeting);
  const summary = recordValue(parsed.summary);
  return [
    'Result: Meeting details.',
    `Meeting: ${stringValue(summary.title) ?? stringValue(meeting.entity_path) ?? 'untitled'} (${stringValue(meeting.day) ?? 'unknown'} ${stringValue(meeting.time) ?? ''}, ${numberValue(meeting.duration_min) ?? '?'} min, id=${stringValue(meeting.id) ?? 'unknown'}).`,
    stringValue(summary.tldr) ? `TLDR: ${stringValue(summary.tldr)}` : null,
    formatStringList('Agenda', summary.agenda),
    formatStringList('Decisions', summary.decisions),
    formatStringList('Action items', summary.action_items),
    formatStringList('Open questions', summary.open_questions),
    formatStringList('Key moments', summary.key_moments),
  ].filter(Boolean).join('\n');
}

function formatDailyEvidence(parsed: Record<string, unknown>): string {
  const totals = recordValue(parsed.totals);
  return [
    `Result: Daily summary for ${stringValue(parsed.day) ?? 'unknown'}.`,
    `Totals: ${numberValue(totals.frames) ?? 0} frames, ${numberValue(totals.sessions) ?? 0} sessions, ${numberValue(totals.focused_min) ?? 0} focused min, ${numberValue(totals.active_min) ?? 0} active min.`,
    formatStringList('Top apps', parsed.top_apps),
    formatStringList('Top entities', parsed.top_entities),
    formatStringList('Sessions', parsed.sessions),
    formatStringList('Open loops', parsed.open_loops),
    formatStringList('Notes', parsed.notes),
  ].filter(Boolean).join('\n');
}

function formatSearchEvidence(parsed: Record<string, unknown>): string {
  const frameMatches = (arrayValue(parsed.frame_matches).length ? arrayValue(parsed.frame_matches) : arrayValue(parsed.frames))
    .slice(0, 8)
    .map((item) => {
      const rec = recordValue(item);
      return `${stringValue(rec.timestamp) ?? stringValue(rec.day) ?? 'unknown'} ${stringValue(rec.app) ?? 'unknown'} / ${stringValue(rec.window_title) ?? 'unknown'}: ${compactEvidenceLine(stringValue(rec.text_excerpt), 360)} (${stringValue(rec.id) ?? 'no frame id'})`;
    });
  const chunkMatches = arrayValue(parsed.memory_chunk_matches).slice(0, 5).map((item) => {
    const rec = recordValue(item);
    return `${stringValue(rec.title) ?? stringValue(rec.kind) ?? 'memory'}: ${compactEvidenceLine(stringValue(rec.excerpt) ?? stringValue(rec.body), 360)}`;
  });
  const nodeMatches = arrayValue(parsed.memory_node_matches).slice(0, 5).map((item) => {
    const rec = recordValue(item);
    return `${stringValue(rec.title) ?? stringValue(rec.scope_id) ?? 'node'}: ${compactEvidenceLine(stringValue(rec.excerpt), 360)}`;
  });
  const leafMatches = arrayValue(parsed.memory_leaf_matches).slice(0, 5).map((item) => {
    const rec = recordValue(item);
    return `${stringValue(rec.title) ?? stringValue(rec.kind) ?? 'leaf'}: ${compactEvidenceLine(stringValue(rec.excerpt), 360)}`;
  });
  const pageMatches = arrayValue(parsed.page_matches).slice(0, 3).map((item) => {
    const rec = recordValue(item);
    return `${stringValue(rec.path) ?? 'page'}: ${compactEvidenceLine(stringValue(rec.excerpt), 300)}`;
  });
  return [
    `Result: Memory search query="${stringValue(parsed.query) ?? ''}", retrieval="${stringValue(parsed.retrieval_query) ?? ''}".`,
    frameMatches.length ? `Frame matches:\n${frameMatches.map((line) => `- ${line}`).join('\n')}` : 'Frame matches: none.',
    chunkMatches.length ? `Memory chunk matches:\n${chunkMatches.map((line) => `- ${line}`).join('\n')}` : null,
    nodeMatches.length ? `Memory node matches:\n${nodeMatches.map((line) => `- ${line}`).join('\n')}` : null,
    leafMatches.length ? `Memory leaf matches:\n${leafMatches.map((line) => `- ${line}`).join('\n')}` : null,
    pageMatches.length ? `Page matches:\n${pageMatches.map((line) => `- ${line}`).join('\n')}` : null,
  ].filter(Boolean).join('\n');
}

function formatStringList(label: string, value: unknown): string | null {
  const items = stringArray(value).slice(0, 8);
  if (!items.length) return null;
  return `${label}:\n${items.map((item) => `- ${item}`).join('\n')}`;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (Array.isArray(value)) return { items: value };
    return recordValue(value);
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return arrayValue(value)
    .map((item) => typeof item === 'string' ? item : JSON.stringify(item))
    .filter((item): item is string => Boolean(item));
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compactEvidenceLine(value: string | null | undefined, max: number): string {
  return truncate((value ?? '').replace(/\s+/g, ' ').trim() || 'no excerpt', max);
}

function meetingDetailRequested(message: string): boolean {
  return /\b(discussed|discussion|talk(?:ed)? about|summary|summari[sz]e|main point|details?)\b/i.test(message);
}

function isGenericNonAnswer(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return [
    'how can i help',
    'what would you like',
    'what do you want',
    'please tell me what',
    'i need a question',
    'i need more context',
    'could you please share',
    'the more context you can provide',
    'i cannot continue because no prior tool results',
    'no prior tool results or evidence',
    'the user has not provided a question',
    'as your local memory assistant',
    'maximum steps',
    'step limit',
    'i am beside, your private local memory assistant',
    'i\'m beside, your private local memory assistant',
  ].some((phrase) => normalized.includes(phrase));
}

function fallbackAnswer(): string {
  return 'I don\'t see that in your captures.';
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

function besideTurnTools(tools: readonly string[]): Record<string, boolean> {
  const allowed = new Set(tools);
  return Object.fromEntries([
    ['*', false],
    ...BESIDE_AGENT_TOOLS.map((tool) => [tool, allowed.has(tool)] as const),
  ]);
}

function isBesideAgentTool(tool: string): boolean {
  return (BESIDE_AGENT_TOOLS as readonly string[]).includes(tool);
}

function continuationToolsFor(message: string, evidence: string): readonly string[] {
  if (
    /\b(meeting|meetings|staff|standup|sync|call|discussed|discussion)\b/i.test(message)
    && /\b(discussed|discussion|talk(?:ed)? about|summary|summari[sz]e|main point|details?)\b/i.test(message)
    && evidence.includes('Tool: beside_list_meetings')
    && !evidence.includes('Tool: beside_get_meeting')
    && /(?:"id"\s*:\s*"|id=)mtg[-_]/.test(evidence)
  ) {
    return ['beside_get_meeting'];
  }
  return [];
}

function getOllamaNumCtx(handles: OrchestratorHandles): number {
  const raw = (handles.config.index.model.ollama as { num_ctx?: number }).num_ctx;
  return typeof raw === 'number' && raw > 0 ? Math.floor(raw) : 0;
}

// Probe Ollama's currently loaded context length for `model` and warn if
// it is smaller than the configured `num_ctx`. Harness calls flow
// through OpenCode -> @ai-sdk/openai-compatible, which has no field for
// passing Ollama's `options.num_ctx` per request; the only mechanism is
// `OLLAMA_CONTEXT_LENGTH` on the Ollama service.
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
    // best-effort diagnostic; do not fail startup if Ollama is unreachable
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
