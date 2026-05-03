import { Buffer } from 'node:buffer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  AgentTraceStep,
  ChatMessage,
  ChatTurnInput,
  ChatTurnResult,
  CompletionOptions,
  IModelAdapter,
  Insight,
  InsightEvidence,
  InsightEvidenceSnippet,
  Logger,
} from '@cofounderos/interfaces';

export type AgentProgressHandler = (step: AgentTraceStep) => void;

export interface McpChatRunOptions {
  /** Streamed callback receiving thoughts and tool start/end steps. */
  onStep?: AgentProgressHandler;
}

/**
 * McpChatAgent — drives the local model adapter as an MCP-using agent.
 *
 * The agent connects to the local MCP server, lists every tool that
 * server advertises, and lets the model pick which one to call. We do
 * not bake any routing rules or auto-follow-up heuristics into the
 * harness: every MCP endpoint is exposed verbatim and the model is
 * trusted to choose.
 *
 * One non-MCP pseudo-tool is added on top: `view_image`. It loads a
 * captured asset (e.g. a screenshot) from local storage by its
 * relative path so the model can request pixels for any image it
 * comes across in tool results. When the active model supports
 * vision, the bytes are fed into the next reasoning step; otherwise
 * the agent reports the load and lets the model reason from text.
 */

export interface McpChatAgentDeps {
  logger: Logger;
  /** Active local model adapter (Ollama, OpenAI, offline fallback). */
  model: IModelAdapter;
  /**
   * Resolve the local MCP HTTP base URL to connect to. Throws if the
   * MCP export is disabled or unreachable.
   */
  resolveEndpoint: () => Promise<string>;
  /** Ensure the local MCP export is started before the client connects. */
  ensureServer: () => Promise<void>;
  /**
   * Read an on-disk asset by its relative storage path. Required for
   * the `view_image` pseudo-tool to be exposed to the model.
   */
  fetchAsset?: (assetPath: string) => Promise<Buffer>;
  maxIterations?: number;
  /** How many images to attach per vision-enabled decision step. */
  maxImagesPerStep?: number;
}

interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  source: 'mcp' | 'agent';
}

interface AgentStep {
  /** Stable id matching the `tool` AgentTraceStep emitted to the UI. */
  id?: string;
  thought?: string;
  tool?: string;
  args?: Record<string, unknown>;
  source?: 'mcp' | 'agent';
  observationText?: string;
  observationJson?: unknown;
  isError?: boolean;
  /** Buffer images attached by `view_image` to feed into the next call. */
  pendingImages?: Buffer[];
  /** Image metadata so we can surface evidence even for `view_image`. */
  viewedImage?: {
    assetPath: string;
    bytes: number;
  };
}

interface DecisionResult {
  thought?: string;
  tool?: string;
  args?: Record<string, unknown>;
  answer?: string;
}

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_IMAGES_PER_STEP = 2;
const VIEW_IMAGE_TOOL = 'view_image';

export class McpChatAgent {
  private client: Client | null = null;
  private connected = false;
  private toolsCache: ToolDescriptor[] | null = null;
  private readonly logger: Logger;
  private readonly maxIterations: number;
  private readonly maxImagesPerStep: number;

  constructor(private readonly deps: McpChatAgentDeps) {
    this.logger = deps.logger.child('mcp-agent');
    this.maxIterations = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.maxImagesPerStep = deps.maxImagesPerStep ?? DEFAULT_MAX_IMAGES_PER_STEP;
  }

  async chat(
    input: ChatTurnInput,
    seed?: Insight | null,
    options: McpChatRunOptions = {},
  ): Promise<ChatTurnResult> {
    if (!Array.isArray(input.messages) || input.messages.length === 0) {
      throw new Error('At least one message is required');
    }
    const lastUser = [...input.messages].reverse().find((message) => message.role === 'user');
    if (!lastUser || !lastUser.content.trim()) {
      throw new Error('Conversation must include a non-empty user message');
    }

    await this.ensureConnected();
    const tools = await this.listAllTools();
    const messages = withSeedMessage(input.messages, seed);
    const onStep = options.onStep;

    const transcript: AgentStep[] = [];
    const trace: AgentTraceStep[] = [];
    let stepCounter = 0;
    const nextId = (prefix: string) => `${prefix}_${++stepCounter}`;
    const emit = (step: AgentTraceStep) => {
      const existingIdx = trace.findIndex((entry) => entry.id === step.id);
      if (existingIdx === -1) {
        trace.push(step);
      } else {
        trace[existingIdx] = step;
      }
      if (onStep) {
        try {
          onStep(step);
        } catch (err) {
          this.logger.debug('agent onStep handler threw', { err: String(err) });
        }
      }
    };

    let final: string | null = null;

    for (let i = 0; i < this.maxIterations; i++) {
      const decision = await this.decide(messages, transcript, tools, false);
      if (decision.answer && decision.answer.trim()) {
        if (decision.thought) transcript.push({ thought: decision.thought });
        final = decision.answer.trim();
        break;
      }
      if (!decision.tool) break;

      const toolSource: 'mcp' | 'agent' =
        decision.tool === VIEW_IMAGE_TOOL ? 'agent' : 'mcp';
      const stepId = nextId('tool');
      const args = decision.args ?? {};
      emit({
        id: stepId,
        kind: 'tool',
        tool: decision.tool,
        args,
        source: toolSource,
        status: 'running',
      });

      const step: AgentStep = {
        id: stepId,
        thought: decision.thought,
        tool: decision.tool,
        args,
        source: toolSource,
      };
      if (decision.tool === VIEW_IMAGE_TOOL) {
        await this.runViewImage(step, args);
      } else {
        await this.runMcpTool(step, decision.tool, args);
      }
      transcript.push(step);
      emit({
        id: stepId,
        kind: 'tool',
        tool: decision.tool,
        args,
        source: toolSource,
        status: step.isError ? 'error' : 'done',
        summary: summariseObservation(step),
        observation: trimObservation(step.observationText),
      });
    }

    if (!final) {
      const wrap = await this.decide(messages, transcript, tools, true);
      final = (wrap.answer && wrap.answer.trim())
        || 'I could not finalize an answer from the local evidence I gathered.';
    }

    const evidence = synthesizeEvidence(transcript);
    const message: ChatMessage = {
      role: 'assistant',
      content: final,
      createdAt: new Date().toISOString(),
      trace,
    };
    return { message, evidence };
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => undefined);
      this.client = null;
    }
    this.connected = false;
    this.toolsCache = null;
  }

  // -------------------------------------------------------------------------
  // Connection + tool discovery
  // -------------------------------------------------------------------------

  private async ensureConnected(): Promise<void> {
    if (this.connected && this.client) return;
    await this.deps.ensureServer();
    const endpoint = await this.deps.resolveEndpoint();
    const transport = new StreamableHTTPClientTransport(new URL(endpoint));
    const client = new Client(
      { name: 'cofounderos-insights-agent', version: '0.1.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    this.client = client;
    this.connected = true;
    this.toolsCache = null;
    this.logger.debug(`connected to MCP server at ${endpoint}`);
  }

  private async listAllTools(): Promise<ToolDescriptor[]> {
    if (this.toolsCache) return this.toolsCache;
    const result = await this.client!.listTools();
    const mcpTools: ToolDescriptor[] = result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema as Record<string, unknown>,
      source: 'mcp',
    }));
    const tools = [...mcpTools];
    if (this.deps.fetchAsset) {
      tools.push({
        name: VIEW_IMAGE_TOOL,
        description:
          'Open a captured image from local storage by its relative asset path (e.g. "raw/2026-05-02/screenshots/21-43-10-126_Electron.webp"). Use when a previous tool result references an image you want to inspect more closely. The image is loaded from disk and, if the model supports vision, attached to the next reasoning step.',
        inputSchema: {
          type: 'object',
          properties: {
            asset_path: {
              type: 'string',
              description: 'Relative asset path returned by an MCP tool result.',
            },
          },
          required: ['asset_path'],
        },
        source: 'agent',
      });
    }
    this.toolsCache = tools;
    return tools;
  }

  // -------------------------------------------------------------------------
  // Tool execution
  // -------------------------------------------------------------------------

  private async runMcpTool(
    step: AgentStep,
    name: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    try {
      const result = await this.client!.callTool({ name, arguments: args });
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      const text = content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .filter(Boolean)
        .join('\n');
      step.observationText = text || '(no content)';
      step.isError = result.isError === true;
      try {
        step.observationJson = text ? JSON.parse(text) : undefined;
      } catch {
        step.observationJson = undefined;
      }
    } catch (err) {
      step.isError = true;
      step.observationText = `tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async runViewImage(step: AgentStep, args: Record<string, unknown>): Promise<void> {
    if (!this.deps.fetchAsset) {
      step.isError = true;
      step.observationText = 'view_image is not available in this environment.';
      return;
    }
    const assetPath = typeof args.asset_path === 'string' ? args.asset_path.trim() : '';
    if (!assetPath) {
      step.isError = true;
      step.observationText = 'view_image requires an "asset_path" string argument.';
      return;
    }
    try {
      const buffer = await this.deps.fetchAsset(assetPath);
      step.viewedImage = { assetPath, bytes: buffer.byteLength };
      step.observationJson = {
        view_image: {
          asset_path: assetPath,
          bytes: buffer.byteLength,
        },
      };
      const supportsVision =
        this.deps.model.getModelInfo().supportsVision === true
        && typeof this.deps.model.completeWithVision === 'function';
      if (supportsVision) {
        step.pendingImages = [buffer];
        step.observationText =
          `Loaded image at ${assetPath} (${buffer.byteLength} bytes); attached for your next step.`;
      } else {
        step.observationText =
          `Loaded image at ${assetPath} (${buffer.byteLength} bytes); the active model has no vision support, so reason from the text evidence already gathered.`;
      }
    } catch (err) {
      step.isError = true;
      step.observationText = `view_image failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // -------------------------------------------------------------------------
  // Model decision step
  // -------------------------------------------------------------------------

  private async decide(
    messages: ChatMessage[],
    transcript: AgentStep[],
    tools: ToolDescriptor[],
    forceAnswer: boolean,
  ): Promise<DecisionResult> {
    const systemPrompt = buildSystemPrompt(tools, forceAnswer);
    const prompt = buildDecisionPrompt(messages, transcript, forceAnswer);
    const options: CompletionOptions = {
      systemPrompt,
      responseFormat: 'json',
      temperature: 0.2,
      maxTokens: 900,
    };
    const pendingImages = collectPendingImages(transcript, this.maxImagesPerStep);
    let raw: string;
    if (pendingImages.length > 0 && typeof this.deps.model.completeWithVision === 'function') {
      raw = await this.deps.model.completeWithVision(prompt, pendingImages, options);
    } else {
      raw = await this.deps.model.complete(prompt, options);
    }
    return parseDecision(raw, forceAnswer);
  }
}

// ---------------------------------------------------------------------------
// Prompt + parse helpers
// ---------------------------------------------------------------------------

function withSeedMessage(messages: ChatMessage[], seed: Insight | null | undefined): ChatMessage[] {
  if (!seed) return messages;
  const seedNote: ChatMessage = {
    role: 'system',
    content: [
      `Insight context — the user opened this chat to discuss "${seed.title}".`,
      `Severity: ${seed.severity}. Period: ${seed.period.label} (${seed.period.start} → ${seed.period.end}).`,
      `Summary: ${seed.summary}`,
      `Recommendation: ${seed.recommendation}`,
    ].join('\n'),
  };
  return [seedNote, ...messages];
}

function buildSystemPrompt(tools: ToolDescriptor[], forceAnswer: boolean): string {
  const toolsBlock = tools
    .map((tool) => {
      const desc = tool.description ? ` — ${tool.description}` : '';
      const schema = JSON.stringify(tool.inputSchema);
      return `- ${tool.name}${desc}\n  schema: ${schema}`;
    })
    .join('\n');

  const protocol = forceAnswer
    ? 'Reply with EXACTLY ONE JSON object: {"thought":"...","answer":"<final markdown answer>"}.'
    : [
        'Reply with EXACTLY ONE JSON object in one of these shapes:',
        '  {"thought":"...","tool":"<tool name>","arguments":{...}}',
        '  {"thought":"...","answer":"<final markdown answer>"}',
      ].join('\n');

  return [
    "You are the CofounderOS Insights agent, a private assistant for the user's local",
    'activity captures (screenshots with OCR text, audio transcripts, browsing context,',
    'sessions, wiki pages, and raw events) exposed through MCP tools.',
    'You decide which tools to call. Use them as you see fit to answer the user.',
    '',
    'Available tools:',
    toolsBlock,
    '',
    protocol,
    'No prose outside the JSON. No markdown fences around the JSON.',
  ].join('\n');
}

function buildDecisionPrompt(
  messages: ChatMessage[],
  transcript: AgentStep[],
  forceAnswer: boolean,
): string {
  const lines: string[] = [];
  lines.push('Conversation so far (full history, oldest first):');
  for (const message of messages) {
    const role =
      message.role === 'assistant' ? 'Assistant'
      : message.role === 'user' ? 'User'
      : 'System';
    lines.push(`${role}: ${message.content}`.trim());
  }
  lines.push('');

  if (transcript.length === 0) {
    lines.push('No tool calls yet in this turn.');
  } else {
    lines.push('Tool calls in this turn (oldest first):');
    transcript.forEach((step, idx) => {
      if (step.tool) {
        const args = JSON.stringify(step.args ?? {});
        lines.push(`${idx + 1}. ${step.tool}(${args})`);
        const obs = step.observationText ?? '';
        lines.push(`   result${step.isError ? ' (error)' : ''}: ${obs}`);
      } else if (step.thought) {
        lines.push(`${idx + 1}. thought: ${step.thought}`);
      }
    });
  }
  lines.push('');
  lines.push(forceAnswer ? 'Provide the final answer now.' : 'What is your next step?');
  return lines.join('\n');
}

function parseDecision(raw: string, forceAnswer: boolean): DecisionResult {
  const trimmed = raw.trim();
  if (!trimmed) return forceAnswer ? { answer: '' } : {};
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/i);
  const candidate = fence ? fence[1]!.trim() : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    if (looksLikeInternalReasoning(trimmed)) {
      return forceAnswer ? { answer: '' } : {};
    }
    return { answer: trimmed };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return looksLikeInternalReasoning(trimmed) ? {} : { answer: trimmed };
  }
  const obj = parsed as Record<string, unknown>;
  const thought = typeof obj.thought === 'string' ? obj.thought : undefined;
  const answer = typeof obj.answer === 'string' ? obj.answer : undefined;
  const tool = typeof obj.tool === 'string' && obj.tool ? obj.tool : undefined;
  let args: Record<string, unknown> | undefined;
  if (obj.arguments && typeof obj.arguments === 'object' && !Array.isArray(obj.arguments)) {
    args = obj.arguments as Record<string, unknown>;
  } else if (obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)) {
    args = obj.args as Record<string, unknown>;
  }
  if (forceAnswer) {
    return { thought, answer: answer ?? '' };
  }
  return { thought, tool, args, answer };
}

function looksLikeInternalReasoning(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    'the user wants',
    'the user asked',
    'i need to',
    'i should use',
    'conversation history shows',
    'the provided text mentions',
    'local model',
    'using this information to make decisions',
    'search_memory',
  ].some((needle) => normalized.includes(needle));
}

function collectPendingImages(transcript: AgentStep[], cap: number): Buffer[] {
  const images: Buffer[] = [];
  for (let i = transcript.length - 1; i >= 0 && images.length < cap; i--) {
    const step = transcript[i]!;
    if (!step.pendingImages || step.pendingImages.length === 0) continue;
    images.push(...step.pendingImages);
    step.pendingImages = undefined;
    if (images.length >= cap) break;
  }
  return images.slice(0, cap);
}

// ---------------------------------------------------------------------------
// Trace + evidence helpers
// ---------------------------------------------------------------------------

function trimObservation(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed || undefined;
}

function summariseObservation(step: AgentStep): string {
  if (step.isError) return 'error';
  if (step.viewedImage) {
    return `viewed image (${step.viewedImage.bytes} bytes)`;
  }
  const json = step.observationJson as Record<string, unknown> | undefined;
  if (!json) {
    const len = (step.observationText ?? '').length;
    return len > 0 ? `${len} chars` : 'no content';
  }
  const counts: string[] = [];
  const arrayLen = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  const frames = arrayLen(json.frame_matches) + arrayLen(json.frames);
  if (frames > 0) counts.push(`${frames} frames`);
  if (arrayLen(json.page_matches) > 0) counts.push(`${arrayLen(json.page_matches)} pages`);
  if (arrayLen(json.sessions) > 0) counts.push(`${arrayLen(json.sessions)} sessions`);
  if (arrayLen(json.entities) > 0) counts.push(`${arrayLen(json.entities)} entities`);
  if (arrayLen(json.neighbours) > 0) counts.push(`${arrayLen(json.neighbours)} neighbours`);
  return counts.length > 0 ? counts.join(', ') : 'ok';
}

function synthesizeEvidence(transcript: AgentStep[]): InsightEvidence {
  const frameIds = new Set<string>();
  const sessionIds = new Set<string>();
  const apps = new Set<string>();
  const entities = new Set<string>();
  const snippets: InsightEvidenceSnippet[] = [];
  let toolCalls = 0;
  let toolErrors = 0;
  let viewedScreenshots = 0;

  const tryAddSnippet = (snippet: InsightEvidenceSnippet) => {
    if (snippets.length >= 8) return;
    snippets.push(snippet);
  };

  for (const step of transcript) {
    if (step.tool) {
      toolCalls += 1;
      if (step.isError) toolErrors += 1;
    }
    if (step.viewedImage) {
      viewedScreenshots += 1;
      tryAddSnippet({
        label: 'Image',
        text: `Opened image ${step.viewedImage.assetPath}`,
      });
    }
    const json = step.observationJson as Record<string, unknown> | undefined;
    if (!json || typeof json !== 'object') continue;

    const collectFrame = (frame: Record<string, unknown>) => {
      const id = typeof frame.id === 'string' ? frame.id : undefined;
      if (id) frameIds.add(id);
      if (typeof frame.app === 'string') apps.add(frame.app);
      if (typeof frame.entity_path === 'string') entities.add(frame.entity_path);
      const sessionId =
        typeof frame.activity_session_id === 'string' ? frame.activity_session_id : undefined;
      if (sessionId) sessionIds.add(sessionId);
      const text = [frame.window_title, frame.url, frame.text_excerpt]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join(' | ')
        .slice(0, 360);
      if (text) {
        tryAddSnippet({
          label: typeof frame.app === 'string' && frame.app ? frame.app : 'Frame',
          frameId: id,
          sessionId,
          text,
        });
      }
    };

    const frameLike: Array<Record<string, unknown>> = [];
    if (Array.isArray(json.frames)) {
      for (const f of json.frames) {
        if (f && typeof f === 'object') frameLike.push(f as Record<string, unknown>);
      }
    }
    if (Array.isArray(json.frame_matches)) {
      for (const f of json.frame_matches) {
        if (f && typeof f === 'object') frameLike.push(f as Record<string, unknown>);
      }
    }
    if (json.anchor && typeof json.anchor === 'object') {
      frameLike.push(json.anchor as Record<string, unknown>);
    }
    if (Array.isArray((json as { before?: unknown[] }).before)) {
      for (const f of (json as { before: unknown[] }).before) {
        if (f && typeof f === 'object') frameLike.push(f as Record<string, unknown>);
      }
    }
    if (Array.isArray((json as { after?: unknown[] }).after)) {
      for (const f of (json as { after: unknown[] }).after) {
        if (f && typeof f === 'object') frameLike.push(f as Record<string, unknown>);
      }
    }
    for (const frame of frameLike) collectFrame(frame);

    if (Array.isArray(json.sessions)) {
      for (const sessionRaw of json.sessions) {
        if (!sessionRaw || typeof sessionRaw !== 'object') continue;
        const session = sessionRaw as Record<string, unknown>;
        if (typeof session.id === 'string') sessionIds.add(session.id);
        if (typeof session.primary_app === 'string') apps.add(session.primary_app);
        if (typeof session.primary_entity === 'string') entities.add(session.primary_entity);
      }
    }
    if (Array.isArray(json.page_matches)) {
      for (const pageRaw of json.page_matches) {
        if (!pageRaw || typeof pageRaw !== 'object') continue;
        const page = pageRaw as Record<string, unknown>;
        const path = typeof page.path === 'string' ? page.path : undefined;
        if (!path) continue;
        const excerpt = typeof page.excerpt === 'string' ? page.excerpt.slice(0, 320) : '';
        tryAddSnippet({ label: path, text: excerpt || '(wiki page)' });
      }
    }
  }

  const evidence: InsightEvidence = {
    metrics: {
      toolCalls,
      toolErrors,
      uniqueFrames: frameIds.size,
      uniqueSessions: sessionIds.size,
      viewedScreenshots,
    },
  };
  if (frameIds.size > 0) evidence.frameIds = Array.from(frameIds).slice(0, 16);
  if (sessionIds.size > 0) evidence.sessionIds = Array.from(sessionIds).slice(0, 16);
  if (apps.size > 0) evidence.apps = Array.from(apps).slice(0, 12);
  if (entities.size > 0) evidence.entities = Array.from(entities).slice(0, 12);
  if (snippets.length > 0) evidence.snippets = snippets.slice(0, 8);
  return evidence;
}
