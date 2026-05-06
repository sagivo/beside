import type { IIndexStrategy, IModelAdapter, IStorage, Logger } from '@cofounderos/interfaces';
import { resolveDateAnchor } from './date.js';
import { preferenceScore } from './noise.js';
import {
  buildAnswerPrompt,
  buildDirectAnswerPrompt,
  buildDirectSystemPrompt,
  buildSystemPrompt,
} from './prompts.js';
import { routeRequest } from './router.js';
import {
  getActivitySessionTool,
  getCalendarCandidates,
  getDailyBriefing,
  getEntitySummaryTool,
  getFrameContextTool,
  getOpenLoopCandidates,
  listEntitiesTool,
  searchIndexPagesTool,
  searchFramesTool,
  searchPersonFramesTool,
  type ToolDeps,
} from './tools.js';
import type {
  ChatIntent,
  ChatStreamEvent,
  ChatStreamHandler,
  ChatTurnInput,
  CompactFrame,
  CollectedToolResults,
  DateAnchor,
} from './types.js';

export interface HarnessOptions {
  /**
   * Maximum tokens the final answer can produce. Local models are slow
   * — keep this tight by default. Caller can raise for verbose intents.
   */
  maxAnswerTokens?: number;
  temperature?: number;
}

export interface HarnessHandle {
  cancel(): void;
}

interface RunDeps {
  storage: IStorage;
  strategy?: IIndexStrategy;
  model: IModelAdapter;
  logger: Logger;
}

/**
 * Run one chat turn end-to-end. The handler is invoked synchronously
 * for every event; throw inside the handler if you want to cancel
 * (we'll surface as `error`). Returns once the `done` (or `error`)
 * event has been emitted.
 *
 * The harness is structured as four phases:
 *
 *   1. classify  — figure out the intent + date anchor
 *   2. plan      — pick a tool sequence based on intent
 *   3. execute   — run the tools, emitting tool-call/tool-result events
 *   4. compose   — stream the final answer
 *
 * Cancellation: the returned `HarnessHandle.cancel()` flips a flag
 * that's checked between phases and between tool calls. The streaming
 * model call is also told to stop appending tokens once cancelled.
 */
export function runChatTurn(
  deps: RunDeps,
  input: ChatTurnInput,
  onEvent: ChatStreamHandler,
  options: HarnessOptions = {},
): { done: Promise<void>; handle: HarnessHandle } {
  const ctx = new TurnContext(deps, input, onEvent);
  const handle: HarnessHandle = {
    cancel: () => ctx.cancel(),
  };
  const done = ctx.run(options).catch((err) => {
    if (ctx.isCancelled()) return;
    deps.logger.error('chat harness failed', { err: String(err), turnId: input.turnId });
    onEvent({
      kind: 'error',
      turnId: input.turnId,
      message: err instanceof Error ? err.message : String(err),
    });
  });
  return { done, handle };
}

class TurnContext {
  private cancelled = false;
  private modelInfo: ReturnType<IModelAdapter['getModelInfo']> | null = null;

  constructor(
    private readonly deps: RunDeps,
    private readonly input: ChatTurnInput,
    private readonly emit: (event: ChatStreamEvent) => void,
  ) {}

  cancel(): void {
    this.cancelled = true;
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  async run(options: HarnessOptions): Promise<void> {
    const { storage, model, logger } = this.deps;
    const turnId = this.input.turnId;

    this.modelInfo = safeModelInfo(model);

    // ─── Phase 1: route ─────────────────────────────────────────────────
    // Decide whether this turn needs the captured-memory tools at all.
    // Greetings, code questions, conversational follow-ups, and general
    // knowledge bypass the whole harness and stream a direct answer.
    this.emitPhase('classify');
    const route = await routeRequest(model, this.input.message, this.input.history);
    if (this.cancelled) return;

    if (route.kind === 'direct') {
      this.emitReasoning(`Routing: direct answer (no tools). Reason: ${route.reason}.`);
      await this.composeDirect(options);
      return;
    }

    const anchor = resolveDateAnchor(this.input.message);
    const intent = route.intent;
    this.emit({ kind: 'intent', turnId, intent, anchor });
    this.emitReasoning(
      `Routing: tools (intent ${intent}). Reason: ${route.reason}. Anchoring on ${anchor.label} (${anchor.day}).`,
    );

    // ─── Phase 2: plan ─────────────────────────────────────────────────
    this.emitPhase('plan');
    const plan = planForIntent(intent, this.input.message);
    this.emitReasoning(`Plan: ${plan.summary}`);

    // ─── Phase 3: execute ──────────────────────────────────────────────
    this.emitPhase('execute');
    const tools: ToolDeps = { storage, strategy: this.deps.strategy };
    const results: CollectedToolResults = {
      searches: [],
      frame_contexts: [],
      session_details: [],
      entity_summaries: [],
      entity_lookups: [],
      index_searches: [],
      notes: [],
    };

    try {
      await executePlan({ plan, tools, model, anchor, results, ctx: this, logger });
    } catch (err) {
      if (this.cancelled) return;
      logger.warn('chat harness tool execution failed', { err: String(err), turnId });
      results.notes.push(
        `Tool execution failed partway through: ${err instanceof Error ? err.message : String(err)}.`,
      );
    }

    if (this.cancelled) return;

    // ─── Phase 4: compose (with tool context) ──────────────────────────
    this.emitPhase('compose');
    const modelAvailable = await model.isAvailable().catch(() => false);
    if (!modelAvailable) {
      this.emit({
        kind: 'content',
        turnId,
        delta: composeOfflineFallback(intent, anchor, results),
      });
      this.emit({ kind: 'done', turnId });
      return;
    }

    // Deterministic short-circuit: if we ran the tools and found zero
    // captured-data evidence, never let the model compose a free-form
    // answer — small local models will hallucinate plausible-but-fake
    // messages (names, channels, quotes, timestamps) to fill the
    // OUTPUT FORMAT example. Reply with a hard-coded "no evidence"
    // line instead.
    if (!hasCapturedEvidence(results)) {
      this.emitReasoning('No captured-data evidence found; refusing to compose a free-form answer.');
      this.emit({
        kind: 'content',
        turnId,
        delta: composeNoEvidenceAnswer(intent, anchor),
      });
      this.emit({ kind: 'done', turnId });
      return;
    }

    const prompt = buildAnswerPrompt({
      intent,
      anchor,
      message: this.input.message,
      history: this.input.history,
      results,
    });
    await this.streamAnswer(prompt, buildSystemPrompt(), options);
  }

  /**
   * Direct-answer compose: skip tools entirely, just stream a response
   * conditioned on the message + recent history. Used when the router
   * decided this turn is general chat / knowledge / follow-up.
   */
  private async composeDirect(options: HarnessOptions): Promise<void> {
    const { model, logger } = this.deps;
    const turnId = this.input.turnId;

    this.emitPhase('compose');

    const modelAvailable = await model.isAvailable().catch(() => false);
    if (!modelAvailable) {
      this.emit({
        kind: 'content',
        turnId,
        delta:
          '_The local model isn\'t available right now, so I can\'t answer this directly. Set up the local model in **Connect AI** and try again._',
      });
      this.emit({ kind: 'done', turnId });
      return;
    }

    const prompt = buildDirectAnswerPrompt({
      message: this.input.message,
      history: this.input.history,
    });

    try {
      await this.streamAnswer(prompt, buildDirectSystemPrompt(), options);
    } catch (err) {
      if (this.cancelled) return;
      logger.error('direct-answer model call failed', { err: String(err), turnId });
      this.emit({
        kind: 'content',
        turnId,
        delta:
          'I had trouble reaching the local model for a direct answer. Make sure Ollama is installed and the configured model is pulled, then try again.',
      });
      this.emit({ kind: 'done', turnId });
    }
  }

  private async streamAnswer(
    prompt: string,
    systemPrompt: string,
    options: HarnessOptions,
  ): Promise<void> {
    const { model, logger } = this.deps;
    const turnId = this.input.turnId;
    // Tools-mode answers follow a strict per-intent template; keep
    // temperature low so a small local model actually obeys it. Direct
    // mode is more conversational and tolerates slightly higher temp,
    // but the same default works fine for both.
    const maxTokens = options.maxAnswerTokens ?? 900;
    const temperature = options.temperature ?? 0.2;

    let emittedAny = false;
    const handleChunk = (chunk: string): void => {
      if (this.cancelled || !chunk) return;
      emittedAny = true;
      this.emit({ kind: 'content', turnId, delta: chunk });
    };

    try {
      if (model.completeStream) {
        await model.completeStream(prompt, { systemPrompt, maxTokens, temperature }, handleChunk);
      } else {
        const text = await model.complete(prompt, { systemPrompt, maxTokens, temperature });
        handleChunk(text);
      }
    } catch (err) {
      if (this.cancelled) return;
      logger.error('chat harness model call failed', { err: String(err), turnId });
      if (!emittedAny) {
        this.emit({
          kind: 'content',
          turnId,
          delta:
            'I had trouble generating a response from the local model. Make sure Ollama is installed and the configured model is pulled, then try again.',
        });
      }
    }

    if (!this.cancelled) this.emit({ kind: 'done', turnId });
  }

  emitPhase(phase: 'classify' | 'plan' | 'execute' | 'compose'): void {
    if (this.cancelled) return;
    this.emit({ kind: 'phase', turnId: this.input.turnId, phase });
  }

  emitReasoning(text: string): void {
    if (this.cancelled || !text) return;
    this.emit({ kind: 'reasoning', turnId: this.input.turnId, text });
  }

  emitToolCall(tool: string, args: Record<string, unknown>): string {
    const callId = `${this.input.turnId}:${tool}:${Math.random().toString(36).slice(2, 8)}`;
    this.emit({ kind: 'tool-call', turnId: this.input.turnId, tool, args, callId });
    return callId;
  }

  emitToolResult(callId: string, tool: string, summary: string): void {
    this.emit({ kind: 'tool-result', turnId: this.input.turnId, callId, tool, summary });
  }
}

// ---------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------

interface ExecutionPlan {
  intent: ChatIntent;
  steps: PlanStep[];
  summary: string;
}

type PlanStep =
  | { kind: 'daily_briefing' }
  | { kind: 'calendar_check' }
  | { kind: 'open_loops' }
  | { kind: 'search_frames'; query: string; limit?: number; anchorDay?: boolean }
  | { kind: 'search_index_pages'; query: string; limit?: number }
  | { kind: 'people_fanout_search'; query: string; limit?: number }
  | { kind: 'synthesize_people_context'; query: string }
  | {
      kind: 'frame_context_for_top';
      before?: number;
      after?: number;
      max?: number;
      /**
       * When set, only verify frames whose excerpt was flagged
       * `garbled` by the noise filter. Saves Tier-2 budget on days
       * where the OCR is already clean.
       */
      garbledOnly?: boolean;
    }
  | { kind: 'rank_preference_signals' }
  | { kind: 'entity_lookup'; query: string; entityKind?: 'project' | 'contact' | 'channel' | 'repo' }
  | { kind: 'entity_summary_for_top'; max?: number }
  | { kind: 'entity_timeline_for_top'; granularity?: 'hour' | 'day'; limit?: number }
  | { kind: 'entity_summary_for_clean_contact'; query: string; max?: number };

function planForIntent(intent: ChatIntent, message: string): ExecutionPlan {
  const focused = extractFocusedQuery(message);

  switch (intent) {
    case 'daily_briefing':
      return {
        intent,
        summary: 'Pull the daily briefing; verify any garbled open loops.',
        steps: [
          { kind: 'daily_briefing' },
          { kind: 'frame_context_for_top', max: 2, before: 3, after: 1, garbledOnly: true },
        ],
      };
    case 'calendar_check':
      return {
        intent,
        summary: 'Look up calendar candidates for the day; verify garbled titles.',
        steps: [
          { kind: 'calendar_check' },
          { kind: 'frame_context_for_top', max: 2, before: 1, after: 1, garbledOnly: true },
        ],
      };
    case 'open_loops':
      return {
        intent,
        summary: 'Pull open-loop candidates; verify any garbled descriptions.',
        steps: [
          { kind: 'open_loops' },
          { kind: 'frame_context_for_top', max: 3, before: 3, after: 1, garbledOnly: true },
        ],
      };
    case 'recall_event':
      return {
        intent,
        summary: focused
          ? `Search frames for "${focused}", then read context around the best hit.`
          : 'Search frames for the user\'s keywords.',
        steps: [
          { kind: 'search_frames', query: focused || message, limit: 12 },
          { kind: 'frame_context_for_top', max: 1, before: 3, after: 3 },
        ],
      };
    case 'recall_preference':
      return {
        intent,
        summary: focused
          ? `Search frames for "${focused}" plus preference signals; rank by preference score; read context around the top picks.`
          : 'Search for preference signals; rank; read context.',
        steps: [
          {
            kind: 'search_frames',
            query: `${focused || message} liked favorite best top pick`,
            limit: 16,
          },
          { kind: 'rank_preference_signals' },
          { kind: 'frame_context_for_top', max: 3, before: 3, after: 3 },
        ],
      };
    case 'project_status':
      return {
        intent,
        summary: focused
          ? `Look up the entity "${focused}", pull its summary, and check index pages.`
          : 'Look up project entities mentioned in the question.',
        steps: [
          { kind: 'entity_lookup', query: focused || message, entityKind: 'project' },
          { kind: 'entity_summary_for_top', max: 1 },
          { kind: 'search_index_pages', query: focused || message, limit: 5 },
        ],
      };
    case 'people_context':
      return {
        intent,
        summary: focused
          ? `Resolve a clean contact for "${focused}"; if missing, fall through to memory and frame search.`
          : 'Resolve the named person, then fall through to memory and frame search if needed.',
        steps: [
          { kind: 'entity_lookup', query: focused || message, entityKind: 'contact' },
          { kind: 'entity_summary_for_clean_contact', query: focused || message, max: 1 },
          { kind: 'people_fanout_search', query: focused || message, limit: 10 },
          { kind: 'synthesize_people_context', query: focused || message },
        ],
      };
    case 'time_audit':
      // If the user named a specific entity ("how much time on Cursor"),
      // also drill in via entity_lookup → entity_timeline at hour
      // granularity. Otherwise the daily briefing alone covers the
      // top-apps / top-entities question.
      if (focused) {
        return {
          intent,
          summary: `Daily totals plus an hourly timeline for "${focused}".`,
          steps: [
            { kind: 'daily_briefing' },
            { kind: 'entity_lookup', query: focused },
            { kind: 'entity_timeline_for_top', granularity: 'hour', limit: 24 },
          ],
        };
      }
      return {
        intent,
        summary: 'Pull the daily briefing for time totals (top apps + entities).',
        steps: [{ kind: 'daily_briefing' }],
      };
    case 'topic_deep_dive':
      return {
        intent,
        summary: focused
          ? `Search the knowledge base and frames for "${focused}", then pull entity context.`
          : 'Broad search across captured frames.',
        steps: [
          { kind: 'search_index_pages', query: focused || message, limit: 6 },
          { kind: 'search_frames', query: focused || message, limit: 20, anchorDay: false },
          { kind: 'entity_lookup', query: focused || message },
          { kind: 'entity_summary_for_top', max: 1 },
        ],
      };
    case 'general':
    default:
      return {
        intent,
        summary: focused
          ? `Generic plan: search frames for "${focused}".`
          : 'Generic plan: pull today\'s briefing as background context.',
        steps: focused
          ? [
              { kind: 'search_index_pages', query: focused, limit: 4 },
              { kind: 'search_frames', query: focused, limit: 10, anchorDay: false },
            ]
          : [{ kind: 'daily_briefing' }],
      };
  }
}

// ---------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------

interface ExecArgs {
  plan: ExecutionPlan;
  tools: ToolDeps;
  model: IModelAdapter;
  anchor: DateAnchor;
  results: CollectedToolResults;
  ctx: TurnContext;
  logger: Logger;
}

async function executePlan(args: ExecArgs): Promise<void> {
  for (const step of args.plan.steps) {
    if (args.ctx.isCancelled()) return;
    await runStep(step, args);
  }
}

async function runStep(step: PlanStep, args: ExecArgs): Promise<void> {
  const { tools, anchor, results, ctx } = args;
  switch (step.kind) {
    case 'daily_briefing': {
      const callId = ctx.emitToolCall('get_daily_summary', { day: anchor.day });
      const out = await getDailyBriefing(tools, anchor);
      results.daily_briefing = out;
      ctx.emitToolResult(
        callId,
        'get_daily_summary',
        `${out.totals.sessions} sessions, ${out.calendar_candidates.length} calendar hints, ${out.open_loop_candidates.length} open-loop hints`,
      );
      return;
    }
    case 'calendar_check': {
      const callId = ctx.emitToolCall('get_calendar_events', { day: anchor.day });
      const out = await getCalendarCandidates(tools, anchor);
      results.calendar_check = out;
      ctx.emitToolResult(
        callId,
        'get_calendar_events',
        `${out.candidates.length} calendar hints`,
      );
      return;
    }
    case 'open_loops': {
      const callId = ctx.emitToolCall('get_open_loops', { day: anchor.day });
      const out = await getOpenLoopCandidates(tools, anchor);
      results.open_loops = out;
      ctx.emitToolResult(
        callId,
        'get_open_loops',
        `${out.candidates.length} open-loop hints`,
      );
      return;
    }
    case 'search_frames': {
      const day = step.anchorDay === false ? undefined : anchor.day;
      const callId = ctx.emitToolCall('search_frames', {
        query: step.query,
        ...(day ? { day } : {}),
        limit: step.limit,
      });
      const out = await searchFramesTool(tools, {
        query: step.query,
        day,
        limit: step.limit,
      });
      results.searches.push(out);
      ctx.emitToolResult(callId, 'search_frames', `${out.matches.length} matches`);
      return;
    }
    case 'search_index_pages': {
      const callId = ctx.emitToolCall('search_index_pages', {
        query: step.query,
        limit: step.limit,
      });
      const out = await searchIndexPagesTool(tools, {
        query: step.query,
        limit: step.limit,
      });
      results.index_searches.push(out);
      ctx.emitToolResult(callId, 'search_index_pages', `${out.matches.length} page matches`);
      return;
    }
    case 'people_fanout_search': {
      const query = expandPersonSearchQuery(step.query, results);
      if (query !== step.query) {
        results.notes.push(`Expanded person search from "${step.query}" to "${query}" based on contact candidates.`);
      }
      const indexCallId = ctx.emitToolCall('search_index_pages', {
        query,
        limit: step.limit,
      });
      const framesCallId = ctx.emitToolCall('search_person_frames', {
        query,
        limit: step.limit,
      });
      const [indexOut, framesOut] = await Promise.all([
        searchIndexPagesTool(tools, { query, limit: step.limit }),
        searchPersonFramesTool(tools, { query, limit: step.limit }),
      ]);
      results.index_searches.push(indexOut);
      results.searches.push(framesOut);
      ctx.emitToolResult(indexCallId, 'search_index_pages', `${indexOut.matches.length} page matches`);
      ctx.emitToolResult(framesCallId, 'search_person_frames', `${framesOut.matches.length} cleaned matches`);
      return;
    }
    case 'synthesize_people_context': {
      const callId = ctx.emitToolCall('synthesize_people_context', {
        query: step.query,
        sources: {
          indexPages: results.index_searches.reduce((sum, search) => sum + search.matches.length, 0),
          frames: results.searches.reduce((sum, search) => sum + search.matches.length, 0),
        },
      });
      const out = await synthesizePeopleContext(args, step.query);
      results.people_synthesis = out;
      ctx.emitToolResult(
        callId,
        'synthesize_people_context',
        `${out.usedVision ? 'vision + text' : 'text'} synthesis from ${out.imageCount} screenshot(s)`,
      );
      return;
    }
    case 'frame_context_for_top': {
      const ids = collectTopFrameIds(results, step.max ?? 1, {
        garbledOnly: step.garbledOnly === true,
      });
      if (ids.length === 0 && step.garbledOnly) {
        results.notes.push('Skipped frame-context verification: no garbled excerpts to verify.');
        return;
      }
      for (const frameId of ids) {
        if (ctx.isCancelled()) return;
        const callId = ctx.emitToolCall('get_frame_context', {
          frameId,
          before: step.before,
          after: step.after,
        });
        const out = await getFrameContextTool(tools, {
          frameId,
          before: step.before,
          after: step.after,
        });
        if (out) {
          results.frame_contexts.push(out);
          ctx.emitToolResult(
            callId,
            'get_frame_context',
            `Context window: ${out.before.length} before, ${out.after.length} after`,
          );
        } else {
          ctx.emitToolResult(callId, 'get_frame_context', 'no context available');
        }
      }
      return;
    }
    case 'entity_lookup': {
      const callId = ctx.emitToolCall('list_entities', {
        query: step.query,
        kind: step.entityKind,
      });
      const out = await listEntitiesTool(tools, {
        query: step.query,
        kind: step.entityKind,
        limit: 8,
      });
      results.entity_lookups.push(out);
      ctx.emitToolResult(callId, 'list_entities', `${out.entities.length} matches`);
      return;
    }
    case 'entity_summary_for_top': {
      const lookup = results.entity_lookups[results.entity_lookups.length - 1];
      const targets = (lookup?.entities ?? []).slice(0, step.max ?? 1);
      for (const target of targets) {
        if (ctx.isCancelled()) return;
        const callId = ctx.emitToolCall('get_entity_summary', { path: target.path });
        const out = await getEntitySummaryTool(tools, {
          path: target.path,
          sinceIso: shiftIso(args.anchor.fromIso, -7 * 24 * 60),
          untilIso: args.anchor.toIso,
        });
        if (out) {
          results.entity_summaries.push(out);
          ctx.emitToolResult(
            callId,
            'get_entity_summary',
            `${out.frameCount} frames · ${out.neighbours.length} neighbours · ${out.timeline.length} timeline buckets`,
          );
        } else {
          ctx.emitToolResult(callId, 'get_entity_summary', 'entity not found');
        }
      }
      return;
    }
    case 'rank_preference_signals': {
      // Re-rank the most recent search block by preference score so
      // `frame_context_for_top` reads context around the strongest
      // preference signals first instead of just the freshest match.
      const latest = results.searches[results.searches.length - 1];
      if (!latest || latest.matches.length === 0) return;
      const scored = latest.matches
        .map((frame) => ({ frame, score: preferenceScore(frame) }))
        .sort((a, b) => b.score - a.score || b.frame.timestamp.localeCompare(a.frame.timestamp));
      const topScore = scored[0]?.score ?? 0;
      latest.matches = scored.map((s) => s.frame);
      results.notes.push(
        `Ranked ${scored.length} preference candidates; top preference score = ${topScore}.`,
      );
      return;
    }
    case 'entity_timeline_for_top': {
      const lookup = results.entity_lookups[results.entity_lookups.length - 1];
      const target = lookup?.entities[0];
      if (!target) {
        results.notes.push('Skipped entity_timeline: no entity matched the time-audit subject.');
        return;
      }
      const callId = ctx.emitToolCall('get_entity_timeline', {
        path: target.path,
        granularity: step.granularity ?? 'hour',
        limit: step.limit ?? 24,
      });
      const out = await getEntitySummaryTool(tools, {
        path: target.path,
        sinceIso: args.anchor.fromIso,
        untilIso: args.anchor.toIso,
      });
      if (out) {
        results.entity_summaries.push(out);
        ctx.emitToolResult(
          callId,
          'get_entity_timeline',
          `${out.timeline.length} timeline buckets for ${out.title}`,
        );
      } else {
        ctx.emitToolResult(callId, 'get_entity_timeline', 'entity not found');
      }
      return;
    }
    case 'entity_summary_for_clean_contact': {
      const lookup = results.entity_lookups[results.entity_lookups.length - 1];
      const targets = (lookup?.entities ?? [])
        .filter((entity) => isCleanContactMatch(step.query, entity))
        .slice(0, step.max ?? 1);
      if (targets.length === 0) {
        results.notes.push(
          `No clean 1:1 contact entity matched "${step.query}"; falling through to broad memory and frame search.`,
        );
        return;
      }
      for (const target of targets) {
        if (ctx.isCancelled()) return;
        const callId = ctx.emitToolCall('get_entity_summary', { path: target.path });
        const out = await getEntitySummaryTool(tools, {
          path: target.path,
          sinceIso: shiftIso(args.anchor.fromIso, -7 * 24 * 60),
          untilIso: args.anchor.toIso,
        });
        if (out) {
          results.entity_summaries.push(out);
          ctx.emitToolResult(
            callId,
            'get_entity_summary',
            `${out.frameCount} frames · ${out.neighbours.length} neighbours · ${out.timeline.length} timeline buckets`,
          );
        } else {
          ctx.emitToolResult(callId, 'get_entity_summary', 'entity not found');
        }
      }
      return;
    }
  }
}

function collectTopFrameIds(
  results: CollectedToolResults,
  max: number,
  opts: { garbledOnly?: boolean } = {},
): string[] {
  const ids: string[] = [];
  const push = (frame: { id: string; garbled?: boolean } | undefined): void => {
    if (!frame) return;
    if (opts.garbledOnly && !frame.garbled) return;
    if (ids.includes(frame.id) || ids.length >= max) return;
    ids.push(frame.id);
  };
  // Order matters: drain the most-actionable candidate pools first.
  // - Open loops: most likely to be garbled OCR ("+20 e@" style).
  // - Calendar: occasionally truncated titles.
  // - Search hits: only as a tiebreaker.
  for (const f of results.open_loops?.candidates ?? []) push(f);
  for (const f of results.daily_briefing?.open_loop_candidates ?? []) push(f);
  for (const f of results.calendar_check?.candidates ?? []) push(f);
  for (const f of results.daily_briefing?.calendar_candidates ?? []) push(f);
  for (const search of results.searches) {
    for (const m of search.matches) push(m);
  }
  return ids.slice(0, max);
}

async function synthesizePeopleContext(args: ExecArgs, query: string) {
  const { model, tools, results } = args;
  const available = await model.isAvailable().catch(() => false);
  if (!available) {
    return {
      query,
      brief: 'No LLM synthesis was available. Do not answer from raw OCR; say the local model is unavailable for memory synthesis.',
      usedVision: false,
      imageCount: 0,
    };
  }

  const frames = collectPeopleFrames(results).slice(0, 8);
  const modelInfo = safeModelInfo(model);
  const images = modelInfo?.supportsVision
    ? await readFrameImages(tools.storage, frames.slice(0, 5))
    : [];
  const prompt = buildPeopleSynthesisPrompt(query, results, frames, images.length);

  try {
    const brief =
      images.length > 0
        ? await model.completeWithVision(prompt, images, {
            maxTokens: 700,
            temperature: 0.1,
          })
        : await model.complete(prompt, {
            maxTokens: 700,
            temperature: 0.1,
          });

    return {
      query,
      brief: cleanSynthesisBrief(brief),
      usedVision: images.length > 0,
      imageCount: images.length,
    };
  } catch (err) {
    return {
      query,
      brief: `Memory synthesis failed: ${err instanceof Error ? err.message : String(err)}. Do not answer from raw OCR; say the synthesis step failed.`,
      usedVision: images.length > 0,
      imageCount: images.length,
    };
  }
}

function collectPeopleFrames(results: CollectedToolResults): CompactFrame[] {
  const out: CompactFrame[] = [];
  const seen = new Set<string>();
  for (const search of results.searches) {
    for (const frame of search.matches) {
      if (seen.has(frame.id)) continue;
      seen.add(frame.id);
      out.push(frame);
    }
  }
  return out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

async function readFrameImages(storage: IStorage, frames: CompactFrame[]): Promise<Buffer[]> {
  const images: Buffer[] = [];
  for (const frame of frames) {
    if (!frame.asset_path) continue;
    try {
      images.push(await storage.readAsset(frame.asset_path));
    } catch {
      /* best effort: text/index synthesis still works */
    }
  }
  return images;
}

function buildPeopleSynthesisPrompt(
  query: string,
  results: CollectedToolResults,
  frames: CompactFrame[],
  imageCount: number,
): string {
  const indexEvidence = results.index_searches
    .flatMap((search) =>
      search.matches.slice(0, 6).map((match) =>
        `- ${match.title} (${match.path}, updated ${match.lastUpdated}): ${truncateForSynthesis(match.excerpt, 700)}`,
      ),
    )
    .join('\n') || '- none';

  const entityEvidence = [
    ...results.entity_lookups.flatMap((lookup) =>
      lookup.entities
        // For people synthesis, only contact entities are signal.
        // Project / channel / repo matches that happen to share a
        // substring with the person's name are pure noise here.
        .filter((entity) => entity.kind === 'contact')
        .slice(0, 6)
        .map((entity) =>
          `- Candidate entity: ${entity.title} (${entity.kind}, ${entity.path}, metadata lastSeen ${entity.lastSeen})`,
        ),
    ),
    ...results.entity_summaries.map((summary) =>
      `- Clean contact summary: ${summary.title}; neighbours: ${summary.neighbours
        .slice(0, 5)
        .map((n) => `${n.title} (${n.kind})`)
        .join(', ') || 'none'}; recent frames: ${summary.recentFrames
        .slice(0, 3)
        .map((f) => `${formatLocalDateTimeForSynthesis(f.timestamp)} ${f.app} ${f.window_title}`)
        .join('; ') || 'none'}`,
    ),
  ].join('\n') || '- none';

  const frameEvidence = frames
    .map((frame, i) =>
      [
        `Frame ${i + 1}${i < imageCount ? ' (screenshot attached in same order)' : ''}:`,
        `- time: ${formatLocalDateTimeForSynthesis(frame.timestamp)}`,
        `- app/window/url: ${frame.app} / ${frame.window_title} / ${frame.url ?? 'n/a'}`,
        `- entity: ${frame.entity_path ?? 'n/a'}`,
        `- OCR/accessibility hint (noisy, do not quote verbatim): ${truncateForSynthesis(frame.excerpt ?? '', 900) || 'none'}`,
      ].join('\n'),
    )
    .join('\n\n') || 'No message-like frame candidates.';

  return [
    `You are the evidence-synthesis step for CofounderOS. The user asked: "${query}".`,
    '',
    'Your job is to inspect the retrieved knowledge-base summaries and the attached screenshots, then produce a concise factual brief for a final answering model.',
    '',
    'Critical rules:',
    '- Prefer what is visible in screenshots and durable index/page summaries over OCR text.',
    '- Treat OCR/accessibility text as a noisy hint only. Do not quote garbled OCR.',
    '- Discard captures of CofounderOS itself, Cursor/agent chats, or the user complaining about this harness. Those are not updates about the person.',
    '- Discard roster/member-list/sidebar/profile hits where the person name appears as UI chrome.',
    '- Do not use contact/entity metadata lastSeen as the person\'s status.',
    '- If evidence is insufficient, say that clearly in the brief.',
    '- Distinguish what the named person said from what the user or other people said.',
    '',
    'Return Markdown with exactly these sections:',
    '**Synthesis:** 1-2 sentences with the useful answer, or "No useful update found."',
    '**Recent messages:** bullets with channel/app, approximate time, speaker, and paraphrased substance.',
    '**Commitments / todos:** bullets, or "None I can confirm."',
    '**Open loops:** bullets, or "None I can confirm."',
    '**Rejected noise:** one short sentence naming the main discarded source types.',
    '',
    'Knowledge-base candidates:',
    indexEvidence,
    '',
    'Entity/contact candidates:',
    entityEvidence,
    '',
    'Frame/screenshot candidates:',
    frameEvidence,
  ].join('\n');
}

function cleanSynthesisBrief(raw: string): string {
  const cleaned = raw.replace(/\s+$/g, '').trim();
  return cleaned || 'No useful update found.';
}

/**
 * Format an ISO timestamp as a local-clock string for the synthesis
 * model. We never want raw ISO strings inside any prompt — small
 * models will copy them verbatim into their reply.
 */
function formatLocalDateTimeForSynthesis(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} ${time}`;
}

function truncateForSynthesis(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 3)}...`;
}

function isCleanContactMatch(
  query: string,
  entity: { title: string; path: string; kind: string },
): boolean {
  if (entity.kind !== 'contact') return false;
  const title = normalisePersonText(entity.title);
  const pathTail = normalisePersonText(entity.path.split('/').pop() ?? entity.path);
  const wanted = normalisePersonText(query);
  if (!wanted) return false;

  // Group DMs / roster-like entities often contain separators or several
  // names. Treat those as weak hints and let the broad search path carry.
  if (hasGroupContactSeparator(entity.title)) return false;

  return (
    title === wanted ||
    pathTail === wanted ||
    title.startsWith(`${wanted} `) ||
    pathTail.startsWith(`${wanted} `)
  );
}

function expandPersonSearchQuery(query: string, results: CollectedToolResults): string {
  const lookup = results.entity_lookups[results.entity_lookups.length - 1];
  const wanted = normalisePersonText(query);
  if (!lookup || !wanted) return query;

  for (const entity of lookup.entities) {
    const cleanTitle = extractPersonNameFromCandidate(query, entity.title);
    if (cleanTitle) return cleanTitle;
    const cleanPath = extractPersonNameFromCandidate(query, entity.path.split('/').pop() ?? '');
    if (cleanPath) return cleanPath;
  }
  return query;
}

function extractPersonNameFromCandidate(query: string, value: string): string {
  const wanted = normalisePersonText(query);
  if (!wanted) return '';
  const words = value
    .replace(/[-_]+/g, ' ')
    .replace(/[,+&].*$/g, '')
    .replace(/\/.*$/g, '')
    .replace(/\band\b.*$/i, '')
    .split(/\s+/)
    .filter(Boolean);
  const idx = words.findIndex((word) => normalisePersonText(word) === wanted);
  if (idx === -1) return '';
  return words.slice(idx, idx + 2).join(' ');
}

function hasGroupContactSeparator(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    value.includes(',') ||
    value.includes('+') ||
    value.includes('&') ||
    value.includes('/') ||
    lower.includes(' and ') ||
    lower.includes(' with ')
  );
}

function normalisePersonText(value: string): string {
  return value
    .toLowerCase()
    .replace(/contacts\//g, '')
    .replace(/[-_]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shiftIso(iso: string, deltaMin: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + deltaMin * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'or', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'on', 'in', 'at', 'to', 'for', 'of', 'with', 'about', 'from', 'by', 'into',
  'i', "i'm", 'me', 'my', 'mine', 'we', 'our', 'us',
  'you', 'your', 'they', 'them', 'their', 'this', 'that', 'these', 'those',
  'do', 'did', 'does', 'doing', 'have', 'has', 'had', 'having',
  'today', 'yesterday', 'tomorrow', 'now', 'last', 'next',
  'latest', 'new', 'recent', 'updates', 'update', 'news', 'happening',
  'status', 'progress',
  'what', "what's", 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'tell', 'show', 'find', 'list', 'give', 'get', 'know', 'think',
  'please', 'thanks', 'thank',
  'all', 'any', 'some', 'every',
]);

function extractFocusedQuery(message: string): string {
  const subject = extractTrailingSubject(message);
  if (subject) return subject;
  return extractKeywords(message).slice(0, 3).join(' ');
}

function extractTrailingSubject(message: string): string {
  // Patterns that put the SUBJECT at the end of the sentence.
  const trailing = message.match(
    /\b(?:what'?s\s+(?:the\s+)?(?:latest|new|happening)\s+(?:with|on|about|in)|(?:any|anything)\s+(?:new|recent|updates?|news)\s+(?:on|about|with|for)|where\s+am\s+i\s+(?:on|with|at)|where\s+(?:are|did)\s+we\s+(?:leave|land)\s+(?:on|with)|status\s+(?:of|on)|progress\s+(?:of|on))\s+(.+?)\s*[?.!]*$/i,
  );
  if (trailing?.[1]) return cleanSubject(trailing[1]);

  // Patterns that put the SUBJECT in the MIDDLE — most commonly
  // "how is X going?" / "how's X going?". Without this, the keyword
  // extractor keeps "going" alongside the entity name and the entity
  // lookup misses.
  const middle = message.match(
    /\bhow'?s?\s+(?:is\s+|it\s+(?:going\s+)?)?(.+?)\s+going\b\s*[?.!]*/i,
  );
  if (middle?.[1]) return cleanSubject(middle[1]);

  // Same shape but with "doing" or "tracking".
  const middle2 = message.match(/\bhow'?s?\s+(.+?)\s+(?:doing|tracking|coming along)\b/i);
  if (middle2?.[1]) return cleanSubject(middle2[1]);

  return '';
}

function cleanSubject(raw: string): string {
  const cleaned = raw
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || STOP_WORDS.has(cleaned.toLowerCase())) return '';
  return cleaned;
}

function extractKeywords(message: string): string[] {
  const tokens = message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const t of tokens) {
    if (STOP_WORDS.has(t) || t.length < 3) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    kept.push(t);
  }
  return kept;
}

function safeModelInfo(model: IModelAdapter): ReturnType<IModelAdapter['getModelInfo']> | null {
  try {
    return model.getModelInfo();
  } catch {
    return null;
  }
}

/**
 * Did the tool phase produce ANY substantive captured-data evidence?
 * If not, the answer prompt would be all "no matches"/"none retrieved"
 * lines, and small local models tend to ignore that and invent a
 * plausible answer matching the OUTPUT FORMAT example. We use this
 * predicate to short-circuit to a deterministic "I don't see that"
 * reply instead.
 *
 * Notes (planner notes) alone do NOT count — they describe *what we
 * tried*, not *what we found*. Empty searches/lookups don't count
 * either.
 */
function hasCapturedEvidence(results: CollectedToolResults): boolean {
  if (results.daily_briefing) {
    const d = results.daily_briefing;
    if (
      d.totals.frames > 0 ||
      d.totals.sessions > 0 ||
      d.calendar_candidates.length > 0 ||
      d.open_loop_candidates.length > 0 ||
      d.top_apps.length > 0 ||
      d.top_entities.length > 0
    ) {
      return true;
    }
  }
  if ((results.calendar_check?.candidates.length ?? 0) > 0) return true;
  if ((results.open_loops?.candidates.length ?? 0) > 0) return true;
  if (results.searches.some((s) => s.matches.length > 0)) return true;
  if (results.index_searches.some((s) => s.matches.length > 0)) return true;
  if (results.frame_contexts.length > 0) return true;
  if (results.session_details.length > 0) return true;
  if (results.entity_summaries.length > 0) return true;
  if (results.entity_lookups.some((l) => l.entities.length > 0)) return true;
  if (results.people_synthesis) {
    // The synthesis step itself runs even with no frames, but its
    // brief flags that case. Treat unambiguously-empty briefs as
    // "no evidence".
    const brief = results.people_synthesis.brief.toLowerCase();
    if (brief.includes('no useful update') || brief.includes('synthesis failed') || brief.includes('not available')) {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Hard-coded, never-hallucinating reply used when the tool phase
 * found zero captured-data evidence. Phrasing is intent-aware so the
 * user understands what was attempted and how to follow up, but it
 * never invents content.
 */
function composeNoEvidenceAnswer(intent: ChatIntent, anchor: DateAnchor): string {
  const day = anchor.label;
  switch (intent) {
    case 'recall_event':
    case 'recall_preference':
      return `I don't see that in your captures.\n\n_I searched your captured frames${anchor.label === 'today' ? ' for today' : ` around ${day}`} and didn't find anything matching that. If it happened on a different day, tell me when and I'll look there._`;
    case 'calendar_check':
      return `I don't see any calendar frames captured for ${day}.\n\n_Open your calendar app so a frame gets captured, then ask again._`;
    case 'open_loops':
      return `Nothing pending I can confirm from your captures${anchor.label === 'today' ? ' for today' : ` for ${day}`}.`;
    case 'daily_briefing':
      return `I don't have any captured activity for ${day} yet.\n\n_Once some frames are captured I can give you a real briefing._`;
    case 'project_status':
    case 'topic_deep_dive':
      return `I don't see anything about that in your captures.\n\n_Try rephrasing with a more specific keyword, or ask about a different time window._`;
    case 'people_context':
      return `I don't see any captured messages, threads, or screens involving that person.\n\n_If they're in your Slack/email/etc., the captures haven't picked them up yet._`;
    case 'time_audit':
      return `I don't have any captured activity for ${day} to total up.`;
    case 'general':
    default:
      return `I don't see that in your captures.`;
  }
}

function composeOfflineFallback(
  intent: ChatIntent,
  anchor: DateAnchor,
  results: CollectedToolResults,
): string {
  const lines: string[] = [];
  lines.push(
    `_The local model isn't available, so here's a deterministic readout of what I gathered for ${anchor.label} (${anchor.day})._`,
  );
  if (results.daily_briefing) {
    const d = results.daily_briefing;
    lines.push(
      `**Totals:** ${d.totals.active_min} active min across ${d.totals.sessions} sessions.`,
    );
    if (d.top_entities.length > 0) {
      lines.push(`**Top focus:** ${d.top_entities.map((e) => e.path).slice(0, 3).join(', ')}.`);
    }
    if (d.calendar_candidates.length > 0) {
      lines.push(`**Calendar hints:** ${d.calendar_candidates.length}.`);
    }
    if (d.open_loop_candidates.length > 0) {
      lines.push(`**Open-loop hints:** ${d.open_loop_candidates.length}.`);
    }
  }
  for (const search of results.searches) {
    lines.push(`**Search "${search.query}":** ${search.matches.length} matches.`);
  }
  for (const search of results.index_searches) {
    lines.push(`**Knowledge-base search "${search.query}":** ${search.matches.length} page matches.`);
  }
  if (lines.length === 1) {
    lines.push('_No structured data was gathered for this question._');
  }
  lines.push(
    '_Bootstrap a local model in **Connect AI** to get a written answer based on this data._',
  );
  return lines.join('\n\n');
}
