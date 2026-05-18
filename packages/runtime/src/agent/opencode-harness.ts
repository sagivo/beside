import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@beside/interfaces';
import { createOpencode, type OpencodeClient, type Part } from '@opencode-ai/sdk';
import type { OrchestratorHandles } from '../orchestrator.js';
import type { ChatStreamEvent, ChatStreamHandler, ChatTurnInput } from './types.js';

interface OpenCodeRuntime {
  client: OpencodeClient;
  close(): void;
}

interface SessionMessageSnapshot {
  info: {
    id: string;
    role: 'user' | 'assistant';
    time?: {
      created?: number;
    };
  };
  parts: Part[];
}

interface EmitOptions {
  emitContent?: boolean;
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

    emit({ kind: 'phase', phase: 'execute' });

    try {
      const runtime = await this.getRuntime(handles);
      const directory = await ensureOpenCodeDirectory(handles.loaded.dataDir, input.conversationId);
      const sessionId = await this.getSessionId(runtime.client, directory, input);
      const model = getOllamaModel(handles);
      const beforeMessageIds = await listSessionMessageIds(runtime.client, directory, sessionId);
      const tools = BESIDE_AGENT_TOOLS;

      const response = await runtime.client.session.prompt({
        path: { id: sessionId },
        query: { directory },
        body: {
          agent: 'beside-memory',
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
      let emittedText = emitParts(parts, input.turnId, onEvent, { emitContent: !evidence });
      let gatheredEvidence = evidence;
      for (let attempt = 0; !emittedText && attempt < 2; attempt += 1) {
        const continuationTools = continuationToolsFor(input.message, gatheredEvidence);
        const retryBeforeMessageIds = await listSessionMessageIds(runtime.client, directory, sessionId);
        const retry = await runtime.client.session.prompt({
          path: { id: sessionId },
          query: { directory },
          body: {
            agent: 'beside-memory',
            model,
            system: buildContinuationSystemPrompt(continuationTools),
            tools: besideTurnTools(continuationTools),
            parts: [{
              type: 'text',
              text: buildContinuationUserPrompt(input.message, gatheredEvidence, continuationTools.length > 0),
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
        gatheredEvidence = [gatheredEvidence, collectToolEvidence(retryParts, input.message)].filter(Boolean).join('\n\n');
        emittedText = emitParts(retryParts, input.turnId, onEvent);
      }
      if (!emittedText) {
        onEvent({
          kind: 'content',
          turnId: input.turnId,
          delta: fallbackAnswer(),
        });
      }
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
    const config = buildOpenCodeConfig(handles, mcpUrl);
    this.logger.info('starting opencode harness', { port, mcpUrl, model: `${model.providerID}/${model.modelID}` });
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
  const prompt = [
    'You are Beside, a private local memory assistant. You are not a coding assistant.',
    `Use exact tool names only: ${BESIDE_AGENT_TOOLS.join(', ')}.`,
    'Answer personal-memory questions by choosing and calling the needed Beside tools yourself.',
    'Use the user question, the tool names, and the tool descriptions to choose the MCP calls. Typical routes: day summary questions use daily summary; follow-up/task questions use open loops; meeting questions use meeting tools; Slack/chat questions use Slack activity or memory search; person/topic/date recall uses memory or frame search.',
    'Treat each turn as a single isolated user question. Do not substitute examples, previous probe questions, or another date/topic.',
    'Use the fewest MCP calls needed. Once a tool returns non-empty evidence for the current question, stop calling unrelated tools and answer from that evidence.',
    'For meeting discussion details, locate the meeting id with beside_list_meetings, then call beside_get_meeting before answering from the discussion content. If there is no exact title match, use the closest summarized meeting and say it is the closest captured meeting.',
    'After a tool returns JSON, answer only from that JSON. Prefer the returned totals, top_apps, top_entities, sessions, open_loops, meeting summary, and transcript fields.',
    'Copy dates, times, titles, ids, and names exactly from the tool result. Do not replace them with examples or approximations.',
    'Do not add generic productivity advice, outside guesses, or topics that are not present in the tool result.',
    'Never invent evidence. If tools return nothing relevant, say: "I don\'t see that in your captures."',
  ].join('\n');

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
          [model]: {
            name: model,
          },
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
      'beside-memory': {
        mode: 'primary',
        model: `ollama/${model}`,
        temperature: 0,
        steps: 4,
        permission: besideToolPermission(),
        prompt,
      },
    },
  };
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
    'This turn is only about the current User question. Do not answer or tool-call for a different imagined question.',
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

function buildContinuationUserPrompt(originalQuestion: string, evidence: string, canCallTools: boolean): string {
  return [
    'Finish the answer for the original user question using the exact tool evidence below.',
    `Original question:\n${originalQuestion}`,
    evidence ? `Tool evidence already returned:\n${evidence}` : 'No usable tool evidence was returned yet.',
    'If the evidence is enough, answer directly from it. Copy dates, times, titles, ids, names, and counts exactly from the evidence.',
    'For Slack activity evidence, answer with bullets based on the returned thread_lines. Each bullet should preserve the timestamp and concrete message text. Do not replace messages with vague labels such as "new thread". Do not invent themes, channels, users, or dates that are not visible in thread_lines or representative_message.',
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
  return Array.isArray(response.data) ? response.data as SessionMessageSnapshot[] : [];
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

function emitParts(
  parts: Part[],
  turnId: string,
  onEvent: ChatStreamHandler,
  options: EmitOptions = {},
): boolean {
  const emitContent = options.emitContent !== false;
  let text = '';
  for (const part of parts) {
    if (part.type === 'reasoning' && part.text.trim()) {
      onEvent({ kind: 'reasoning', turnId, text: truncate(part.text.trim(), 1600) });
      continue;
    }
    if (part.type === 'tool') {
      if (!isBesideAgentTool(part.tool)) continue;
      const callId = `${turnId}:opencode:${part.callID}`;
      const input = 'input' in part.state ? part.state.input : {};
      onEvent({ kind: 'tool-call', turnId, tool: part.tool, args: input, callId });
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
  if (!emitContent || !text.trim() || isGenericNonAnswer(text)) return false;
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
  if (tool === 'beside_get_slack_activity' && parsed) return formatSlackEvidence(parsed, output);
  if (tool === 'beside_list_meetings' && parsed) return formatMeetingListEvidence(parsed, output);
  if (tool === 'beside_get_meeting' && parsed) return formatMeetingEvidence(parsed, output);
  if (tool === 'beside_get_daily_summary' && parsed) return formatDailyEvidence(parsed, output);
  if ((tool === 'beside_search_memory' || tool === 'beside_search_frames') && parsed) return formatSearchEvidence(parsed, output);
  return `Result:\n${truncate(output, 8_000)}`;
}

function formatSlackEvidence(parsed: Record<string, unknown>, raw: string): string {
  const lines = stringArray(parsed.thread_lines);
  const notes = stringArray(parsed.notes);
  return [
    `Result: Slack activity for day=${stringValue(parsed.day) ?? 'unknown'}, channel=${stringValue(parsed.channel) ?? 'any'}, query=${stringValue(parsed.query) ?? 'none'}, count=${numberValue(parsed.count) ?? lines.length}.`,
    lines.length ? `Slack thread lines to summarize exactly:\n${lines.map((line) => `- ${line}`).join('\n')}` : 'Slack thread lines to summarize exactly: none.',
    notes.length ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : null,
  ].filter(Boolean).join('\n');
}

function formatMeetingListEvidence(parsed: Record<string, unknown>, raw: string): string {
  const meetings = arrayValue(parsed.items).slice(0, 12).map((item) => {
    const rec = recordValue(item);
    const title = stringValue(rec.title) ?? stringValue(rec.entity_path) ?? 'untitled';
    const summary = stringValue(rec.tldr) ? `: ${stringValue(rec.tldr)}` : '';
    return `${stringValue(rec.time) ?? `${stringValue(rec.started_at) ?? ''}-${stringValue(rec.ended_at) ?? ''}`.replace(/^-|-$/g, '')} ${title} (${stringValue(rec.platform) ?? 'unknown'}, ${numberValue(rec.duration_min) ?? '?'} min, id=${stringValue(rec.id) ?? 'unknown'})${summary}`;
  });
  return [
    `Result: ${meetings.length} meeting(s).`,
    meetings.length ? `Meetings:\n${meetings.map((line) => `- ${line}`).join('\n')}` : 'Meetings: none.',
  ].join('\n');
}

function formatMeetingEvidence(parsed: Record<string, unknown>, raw: string): string {
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

function formatDailyEvidence(parsed: Record<string, unknown>, raw: string): string {
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

function formatSearchEvidence(parsed: Record<string, unknown>, raw: string): string {
  const frameMatches = (arrayValue(parsed.frame_matches).length ? arrayValue(parsed.frame_matches) : arrayValue(parsed.frames)).slice(0, 8).map((item) => {
    const rec = recordValue(item);
    return `${stringValue(rec.timestamp) ?? stringValue(rec.day) ?? 'unknown'} ${stringValue(rec.app) ?? 'unknown'} / ${stringValue(rec.window_title) ?? 'unknown'}: ${compactEvidenceLine(stringValue(rec.text_excerpt), 360)} (${stringValue(rec.id) ?? 'no frame id'})`;
  });
  const chunkMatches = arrayValue(parsed.memory_chunk_matches).slice(0, 5).map((item) => {
    const rec = recordValue(item);
    return `${stringValue(rec.title) ?? stringValue(rec.kind) ?? 'memory'}: ${compactEvidenceLine(stringValue(rec.excerpt) ?? stringValue(rec.body), 360)}`;
  });
  const pageMatches = arrayValue(parsed.page_matches).slice(0, 3).map((item) => {
    const rec = recordValue(item);
    return `${stringValue(rec.path) ?? 'page'}: ${compactEvidenceLine(stringValue(rec.excerpt), 300)}`;
  });
  return [
    `Result: Memory search query="${stringValue(parsed.query) ?? ''}", retrieval="${stringValue(parsed.retrieval_query) ?? ''}".`,
    frameMatches.length ? `Frame matches:\n${frameMatches.map((line) => `- ${line}`).join('\n')}` : 'Frame matches: none.',
    chunkMatches.length ? `Memory matches:\n${chunkMatches.map((line) => `- ${line}`).join('\n')}` : null,
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
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

const BESIDE_AGENT_TOOLS = [
  'beside_get_daily_summary',
  'beside_search_memory',
  'beside_search_frames',
  'beside_get_frame_context',
  'beside_get_open_loops',
  'beside_get_slack_activity',
  'beside_list_meetings',
  'beside_get_meeting',
] as const;

function besideToolPermission(): Record<string, 'allow' | 'deny'> {
  return Object.fromEntries([
    ['*', 'deny'],
    ...BESIDE_AGENT_TOOLS.map((tool) => [tool, 'allow'] as const),
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
    && /"id"\s*:\s*"mtg[-_]/.test(evidence)
  ) {
    return ['beside_get_meeting'];
  }
  return [];
}
