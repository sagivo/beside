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

    let streamSubscription: StreamSubscription | null = null;

    try {
      const runtime = await this.getRuntime(handles);
      const directory = await ensureOpenCodeDirectory(handles.loaded.dataDir, input.conversationId);
      const sessionId = await this.getSessionId(runtime.client, directory, input);
      const model = getOllamaModel(handles);
      // Track which assistant messages already existed so we can collect
      // only the parts produced by this turn afterwards. `promptAsync`
      // returns 204 with no body, so we rely on the SSE stream for events
      // AND on a final message-list diff as a safety net for anything
      // the live stream might have missed (e.g. dropped events).
      const beforeMessageIds = await listAssistantMessageIds(runtime.client, directory, sessionId);

      // Subscribe to the OpenCode SSE event stream BEFORE sending the
      // prompt so reasoning, tool calls, and text tokens reach the
      // renderer as they happen. The subscription resolves a promise on
      // `session.idle` (success) or `session.error` (failure) so we can
      // wait for completion without blocking on the prompt's HTTP call.
      //
      // Why `promptAsync` instead of `prompt`: the blocking `prompt`
      // endpoint kept the SSE stream from delivering events in real time
      // (the user saw "thinking…" for the whole turn, then everything at
      // once). `promptAsync` returns 204 immediately and lets the SSE
      // stream drive the UI live.
      streamSubscription = await startStreamSubscription(
        runtime.client,
        sessionId,
        input.turnId,
        onEvent,
        this.logger,
      );

      if (!streamSubscription.usingLiveStream) {
        // SSE failed to open — fall back to the blocking prompt so the
        // user still gets *an* answer, even if not streamed.
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
        const summary = emitParts(parts, input.turnId, onEvent, streamSubscription.streamed);
        this.logger.info('opencode turn done (batch fallback)', {
          turnId: input.turnId,
          tools: summary.toolCalls,
          textChars: summary.textChars,
          durationMs: Date.now() - startedAt,
        });
        onEvent({ kind: 'done', turnId: input.turnId });
        return;
      }

      // Fire-and-forget — server returns 204 as soon as the prompt is
      // accepted. All token/tool/reasoning updates flow back over SSE.
      await runtime.client.session.promptAsync({
        path: { id: sessionId },
        query: { directory },
        body: {
          agent: AGENT_NAME,
          model,
          system: buildTurnContext(),
          parts: [{ type: 'text', text: renderUserPrompt(input) }],
        },
      });

      // Belt-and-suspenders: even with SSE we poll the session messages
      // periodically and emit any new parts via the same dedup tracker.
      // Some local-model providers (Ollama via @ai-sdk/openai-compatible)
      // hand OpenCode the full step output at once instead of streaming
      // tokens, which means SSE may go quiet for tens of seconds even
      // while the model is making real progress. Polling surfaces parts
      // the instant they're persisted to the session.
      const poller = startMessagePoller({
        client: runtime.client,
        directory,
        sessionId,
        turnId: input.turnId,
        beforeMessageIds,
        onEvent,
        streamed: streamSubscription.streamed,
        logger: this.logger,
        intervalMs: 600,
      });

      // Wait for the SSE stream to report `session.idle` for our
      // sessionID, or a `session.error`. A long ceiling guards against
      // SSE silently stalling (e.g. server crash mid-turn).
      let completion: Completion;
      try {
        completion = await streamSubscription.waitForCompletion(10 * 60_000);
      } finally {
        poller.stop();
      }
      if (completion.kind === 'error') throw new Error(completion.message);
      if (completion.kind === 'timeout') {
        throw new Error('Timed out waiting for the local model to finish. The SSE stream went quiet.');
      }

      // Reconcile from message history — emits anything SSE missed.
      // Pre-streamed parts are deduplicated by `streamSubscription.streamed`.
      const parts = await collectNewAssistantParts(
        runtime.client,
        directory,
        sessionId,
        beforeMessageIds,
        [],
      );
      const summary = emitParts(parts, input.turnId, onEvent, streamSubscription.streamed);
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

/**
 * Tracks which OpenCode parts the live SSE subscriber has already
 * forwarded to the renderer so the post-prompt batch reconciliation
 * doesn't double-emit them. Tool-calls and tool-results are tracked
 * separately because they fire on different state transitions.
 */
interface StreamedPartTracker {
  reasoningPartIds: Set<string>;
  /**
   * Per text-part cumulative text already emitted to the renderer. The
   * renderer appends `content` deltas, so we must only emit `(current -
   * already_emitted)` for each part. Both the SSE handler and the
   * polling/batch reconciler use this same map — if they didn't, the
   * poll would re-emit the entire text every tick and the renderer
   * would show the same response duplicated over and over.
   */
  textEmittedByPart: Map<string, string>;
  toolCallIds: Set<string>;
  toolResultCallIds: Set<string>;
}

type Completion =
  | { kind: 'idle' }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' };

interface StreamSubscription {
  stop: () => void;
  readonly streamed: StreamedPartTracker;
  /**
   * False when the SSE subscription failed to open. In that case the
   * caller should fall back to the blocking `session.prompt` path.
   */
  readonly usingLiveStream: boolean;
  /**
   * Resolves with `idle` when `session.idle` arrives for the watched
   * sessionID, `error` on `session.error`, or `timeout` after `ms`.
   */
  waitForCompletion(ms: number): Promise<Completion>;
}

function emitParts(
  parts: Part[],
  turnId: string,
  onEvent: ChatStreamHandler,
  streamed?: StreamedPartTracker,
): EmitSummary {
  const toolCalls: string[] = [];
  let totalTextChars = 0;
  for (const part of parts) {
    if (part.type === 'reasoning' && part.text.trim()) {
      // Reasoning supports in-place replacement on the renderer via
      // `partId`, so emit the full current text and let the renderer
      // dedup. We still track which partIds were seen so SSE and batch
      // paths don't race a redundant emit.
      const next = part.text.trim();
      const prev = streamed?.textEmittedByPart.get(part.id) ?? '';
      if (next === prev) continue;
      streamed?.reasoningPartIds.add(part.id);
      streamed?.textEmittedByPart.set(part.id, next);
      onEvent({ kind: 'reasoning', turnId, text: truncate(next, 1600), partId: part.id });
      continue;
    }
    if (part.type === 'tool') {
      const callId = `${turnId}:opencode:${part.callID}`;
      if (!streamed?.toolCallIds.has(callId)) {
        const args = 'input' in part.state ? part.state.input : {};
        onEvent({ kind: 'tool-call', turnId, tool: part.tool, args, callId });
        streamed?.toolCallIds.add(callId);
      }
      toolCalls.push(part.tool);
      if (part.state.status === 'completed' && !streamed?.toolResultCallIds.has(callId)) {
        onEvent({
          kind: 'tool-result',
          turnId,
          callId,
          tool: part.tool,
          summary: summariseToolOutput(part.state.title || part.state.output),
          output: truncate(part.state.output ?? '', 4000),
          durationMs: durationFrom(part.state.time),
        });
        streamed?.toolResultCallIds.add(callId);
      } else if (part.state.status === 'error' && !streamed?.toolResultCallIds.has(callId)) {
        onEvent({
          kind: 'tool-result',
          turnId,
          callId,
          tool: part.tool,
          summary: truncate(part.state.error, 500),
          output: truncate(part.state.error ?? '', 4000),
          durationMs: durationFrom(part.state.time),
          isError: true,
        });
        streamed?.toolResultCallIds.add(callId);
      }
      continue;
    }
    if (part.type === 'text' && typeof part.text === 'string') {
      const next = part.text;
      const prev = streamed?.textEmittedByPart.get(part.id) ?? '';
      if (next.length <= prev.length) {
        totalTextChars += next.length;
        continue;
      }
      const delta = next.slice(prev.length);
      streamed?.textEmittedByPart.set(part.id, next);
      if (delta) onEvent({ kind: 'content', turnId, delta });
      totalTextChars += next.length;
    }
  }
  return { toolCalls, textChars: totalTextChars };
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
    textEmittedByPart: new Map(),
    toolCallIds: new Set(),
    toolResultCallIds: new Set(),
  };
  // `message.part.updated` events carry the *cumulative* part text, so
  // both this SSE handler and the batch reconciler compute deltas
  // against `streamed.textEmittedByPart`. Sharing one map is what keeps
  // them from double-emitting the same content.
  let stopped = false;
  const abort = new AbortController();
  let subscription: { stream: AsyncGenerator<unknown, unknown, unknown> } | null = null;

  let resolveCompletion: ((c: Completion) => void) | null = null;
  const completionPromise: Promise<Completion> = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  // `session.idle` can fire spuriously right after the SSE connects
  // (it can carry the *last* known session state). Only honor idle once
  // the new prompt has begun emitting parts — otherwise we'd cut the
  // turn off before the model even starts.
  let sawActivity = false;
  const settle = (c: Completion) => {
    if (resolveCompletion) {
      const r = resolveCompletion;
      resolveCompletion = null;
      r(c);
    }
  };

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
      usingLiveStream: false,
      waitForCompletion: async () => ({ kind: 'timeout' as const }),
    };
  }

  logger.info('opencode SSE subscription opened', { sessionId, turnId });
  let eventCount = 0;

  void (async () => {
    try {
      for await (const raw of subscription.stream) {
        if (stopped) break;
        const event = raw as { type?: string; properties?: Record<string, unknown> };
        eventCount += 1;
        if (eventCount <= 20 || eventCount % 50 === 0) {
          // Log the first 20 events plus every 50th to expose live SSE
          // traffic on stderr without flooding for long sessions.
          logger.info('opencode SSE event', {
            turnId,
            n: eventCount,
            type: event?.type,
            partType: (event?.properties as { part?: { type?: string } } | undefined)?.part?.type,
          });
        }
        // Completion signals: resolve the promise the caller is awaiting.
        if (event?.type === 'session.idle') {
          const idle = event.properties as { sessionID?: string } | undefined;
          if (idle?.sessionID === sessionId) {
            if (!sawActivity) {
              logger.info('opencode SSE ignoring pre-activity session.idle', { turnId, sessionId });
              continue;
            }
            logger.info('opencode SSE session.idle received', { turnId, sessionId });
            settle({ kind: 'idle' });
          }
          continue;
        }
        // Newer opencode SDKs emit `session.status` with `{ type: 'idle' |
        // 'busy' | 'retry' }` instead of (or in addition to) the legacy
        // `session.idle` event. Treat a status flip to 'idle' as turn
        // completion so the renderer can clear `pending` and re-enable
        // the input — without this, a follow-up question is impossible
        // even though the answer has already streamed in full.
        if (event?.type === 'session.status') {
          const status = event.properties as
            | { sessionID?: string; status?: { type?: string } }
            | undefined;
          if (status?.sessionID === sessionId) {
            const inner = status.status?.type;
            if (inner === 'busy') {
              sawActivity = true;
              continue;
            }
            if (inner === 'idle') {
              if (!sawActivity) {
                logger.info('opencode SSE ignoring pre-activity session.status idle', { turnId, sessionId });
                continue;
              }
              logger.info('opencode SSE session.status idle received', { turnId, sessionId });
              settle({ kind: 'idle' });
            }
          }
          continue;
        }
        // Some opencode versions don't reliably fire `session.idle`
        // when the local model finishes — but they always emit a final
        // `message.updated` carrying `info.time.completed`. Use that as
        // a backup completion signal so the renderer's `pending` flag
        // (which gates the input + send button) can clear.
        if (event?.type === 'message.updated') {
          const props = event.properties as
            | { info?: { sessionID?: string; role?: string; time?: { completed?: number } } }
            | undefined;
          const info = props?.info;
          if (
            info?.sessionID === sessionId &&
            info.role === 'assistant' &&
            typeof info.time?.completed === 'number'
          ) {
            sawActivity = true;
            logger.info('opencode SSE assistant message completed', { turnId, sessionId });
            settle({ kind: 'idle' });
          }
          continue;
        }
        if (event?.type === 'session.error') {
          const errProps = event.properties as { sessionID?: string; error?: unknown } | undefined;
          if (!errProps?.sessionID || errProps.sessionID === sessionId) {
            const message = formatOpenCodeError(errProps?.error);
            logger.warn('opencode SSE session.error received', { turnId, sessionId, message });
            settle({ kind: 'error', message });
          }
          continue;
        }
        if (event?.type !== 'message.part.updated') continue;
        const part = (event.properties?.part ?? {}) as {
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
            time?: { start?: number; end?: number };
          };
        };
        if (!part || part.sessionID !== sessionId || !part.id) continue;
        sawActivity = true;

        if (part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
          const next = part.text.trim();
          const prev = streamed.textEmittedByPart.get(part.id) ?? '';
          if (next === prev) continue;
          streamed.reasoningPartIds.add(part.id);
          streamed.textEmittedByPart.set(part.id, next);
          onEvent({ kind: 'reasoning', turnId, text: truncate(next, 1600), partId: part.id });
          continue;
        }

        if (part.type === 'tool' && part.tool && part.callID) {
          const callId = `${turnId}:opencode:${part.callID}`;
          const status = part.state?.status;
          if (!streamed.toolCallIds.has(callId)) {
            streamed.toolCallIds.add(callId);
            if (!isBesideAgentTool(part.tool)) {
              logger.warn('opencode emitted a non-Beside tool — surfacing it anyway', {
                turnId,
                tool: part.tool,
                callId,
              });
            }
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
              output: truncate(part.state?.output ?? '', 4000),
              durationMs: durationFrom(part.state?.time),
            });
          } else if (status === 'error' && !streamed.toolResultCallIds.has(callId)) {
            streamed.toolResultCallIds.add(callId);
            onEvent({
              kind: 'tool-result',
              turnId,
              callId,
              tool: part.tool,
              summary: truncate(part.state?.error || 'tool failed', 500),
              output: truncate(part.state?.error ?? 'tool failed', 4000),
              durationMs: durationFrom(part.state?.time),
              isError: true,
            });
          }
          continue;
        }

        if (part.type === 'text' && typeof part.text === 'string') {
          const next = part.text;
          const prev = streamed.textEmittedByPart.get(part.id) ?? '';
          if (next.length <= prev.length) continue;
          const delta = next.slice(prev.length);
          streamed.textEmittedByPart.set(part.id, next);
          if (!delta.trim() && !prev) continue;
          onEvent({ kind: 'content', turnId, delta });
        }
      }
    } catch (err) {
      if (!stopped) logger.warn('opencode SSE reader ended', { err: String(err) });
    } finally {
      // Whether the stream ended cleanly, errored, or was aborted — wake
      // any caller still waiting on `waitForCompletion`. They'll fall
      // through to the post-prompt reconciliation either way.
      settle({ kind: 'idle' });
    }
  })();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      try { abort.abort(); } catch {}
      settle({ kind: 'timeout' });
    },
    streamed,
    usingLiveStream: true,
    waitForCompletion: (ms: number) =>
      new Promise<Completion>((resolve) => {
        const timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
        void completionPromise.then((c) => {
          clearTimeout(timer);
          resolve(c);
        });
      }),
  };
}

interface MessagePollerOptions {
  client: OpencodeClient;
  directory: string;
  sessionId: string;
  turnId: string;
  beforeMessageIds: Set<string>;
  onEvent: ChatStreamHandler;
  streamed: StreamedPartTracker;
  logger: Logger;
  intervalMs: number;
}

/**
 * Polls `session.messages` on a loop while the turn is in flight and
 * emits any newly-discovered parts via the shared dedup tracker. This
 * is a safety net for the case where OpenCode's SSE stream goes quiet
 * for long stretches — common with local Ollama models, which often
 * generate a full step in one shot rather than streaming tokens. With
 * the poller, the user sees reasoning/tool activity within a second of
 * each step landing in storage, instead of waiting for the entire turn.
 */
function startMessagePoller(options: MessagePollerOptions): { stop: () => void } {
  let stopped = false;
  let inFlight = false;
  let consecutiveFailures = 0;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const parts = await collectNewAssistantParts(
        options.client,
        options.directory,
        options.sessionId,
        options.beforeMessageIds,
        [],
      );
      if (parts.length) {
        emitParts(parts, options.turnId, options.onEvent, options.streamed);
      }
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      if (consecutiveFailures <= 2) {
        options.logger.warn('opencode message poller tick failed', { err: String(err) });
      }
    } finally {
      inFlight = false;
    }
  };

  const handle = setInterval(() => {
    if (stopped) return;
    void tick();
  }, options.intervalMs);

  // Fire one immediately so the user doesn't wait a whole interval for
  // the first poll.
  void tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}

function summariseToolOutput(output: string): string {
  const collapsed = output.replace(/\s+/g, ' ').trim();
  return truncate(collapsed || 'done', 700);
}

function durationFrom(time: { start?: number; end?: number } | undefined): number | undefined {
  if (!time || typeof time.start !== 'number' || typeof time.end !== 'number') return undefined;
  const ms = time.end - time.start;
  return ms >= 0 ? ms : undefined;
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
