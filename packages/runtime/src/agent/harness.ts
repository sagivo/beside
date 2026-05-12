import type { IIndexStrategy, IModelAdapter, IStorage, Logger } from '@cofounderos/interfaces';
import { resolveDateAnchor } from './date.js';
import { preferenceScore } from './noise.js';
import { buildAnswerPrompt, buildDirectAnswerPrompt, buildDirectSystemPrompt, buildSystemPrompt } from './prompts.js';
import { routeRequest } from './router.js';
import { getDayActivitySummary, getCalendarCandidates, getOpenLoopCandidates, searchFramesTool, searchIndexPagesTool, searchPersonFramesTool, getFrameContextTool, listEntitiesTool, getEntitySummaryTool, type ToolDeps } from './tools.js';
import type { ChatIntent, ChatStreamEvent, ChatStreamHandler, ChatTurnInput, CompactFrame, CollectedToolResults, DateAnchor } from './types.js';

export interface HarnessOptions { maxAnswerTokens?: number; temperature?: number; }
export interface HarnessHandle { cancel(): void; }
interface RunDeps { storage: IStorage; strategy?: IIndexStrategy; model: IModelAdapter; logger: Logger; }

export function runChatTurn(deps: RunDeps, input: ChatTurnInput, onEvent: ChatStreamHandler, options: HarnessOptions = {}): { done: Promise<void>; handle: HarnessHandle } {
  const ctx = new TurnContext(deps, input, onEvent);
  const done = ctx.run(options).catch((err) => {
    if (ctx.isCancelled()) return;
    deps.logger.error('chat harness failed', { err: String(err), turnId: input.turnId });
    onEvent({ kind: 'error', turnId: input.turnId, message: err instanceof Error ? err.message : String(err) });
  });
  return { done, handle: { cancel: () => ctx.cancel() } };
}

class TurnContext {
  private cancelled = false;
  constructor(private readonly deps: RunDeps, private readonly input: ChatTurnInput, private readonly emit: (event: ChatStreamEvent) => void) {}
  cancel() { this.cancelled = true; }
  isCancelled() { return this.cancelled; }

  async run(options: HarnessOptions): Promise<void> {
    const { storage, model, logger } = this.deps, turnId = this.input.turnId;

    this.emitPhase('classify');
    const route = await routeRequest(model, this.input.message, this.input.history);
    if (this.cancelled) return;

    if (route.kind === 'direct') {
      this.emitReasoning(`Routing: direct answer. Reason: ${route.reason}.`);
      return await this.composeDirect(options);
    }

    const anchor = resolveDateAnchor(this.input.message), intent = route.intent;
    this.emit({ kind: 'intent', turnId, intent, anchor });
    this.emitReasoning(`Routing: tools (intent ${intent}). Reason: ${route.reason}. Anchoring on ${anchor.label} (${anchor.day}).`);

    this.emitPhase('plan');
    const plan = planForIntent(intent, this.input.message);
    this.emitReasoning(`Plan: ${plan.summary}`);

    this.emitPhase('execute');
    const tools: ToolDeps = { storage, strategy: this.deps.strategy };
    const results: CollectedToolResults = { searches: [], frame_contexts: [], session_details: [], entity_summaries: [], entity_lookups: [], index_searches: [], notes: [] };

    try { await executePlan({ plan, tools, model, anchor, results, ctx: this, logger }); }
    catch (err) { if (this.cancelled) return; logger.warn('tool execution failed', { err: String(err) }); results.notes.push(`Tool execution failed: ${err}`); }

    if (this.cancelled) return;
    this.emitPhase('compose');

    if (!(await model.isAvailable().catch(() => false))) {
      this.emit({ kind: 'content', turnId, delta: composeOfflineFallback(intent, anchor, results) });
      return this.emit({ kind: 'done', turnId });
    }

    if (!hasCapturedEvidence(results)) {
      this.emitReasoning('No captured-data evidence found; refusing to compose a free-form answer.');
      this.emit({ kind: 'content', turnId, delta: composeNoEvidenceAnswer(intent, anchor) });
      return this.emit({ kind: 'done', turnId });
    }

    await this.streamAnswer(buildAnswerPrompt({ intent, anchor, message: this.input.message, history: this.input.history, results }), buildSystemPrompt(), options);
  }

  private async composeDirect(options: HarnessOptions): Promise<void> {
    this.emitPhase('compose');
    const { model, logger } = this.deps, turnId = this.input.turnId;
    if (!(await model.isAvailable().catch(() => false))) {
      this.emit({ kind: 'content', turnId, delta: '_The local model isn\'t available right now. Set up the local model in **Connect AI** and try again._' });
      return this.emit({ kind: 'done', turnId });
    }
    try { await this.streamAnswer(buildDirectAnswerPrompt({ message: this.input.message, history: this.input.history }), buildDirectSystemPrompt(), options); }
    catch (err) {
      if (this.cancelled) return; logger.error('direct-answer failed', { err: String(err) });
      this.emit({ kind: 'content', turnId, delta: 'I had trouble reaching the local model. Make sure Ollama is installed.' });
      this.emit({ kind: 'done', turnId });
    }
  }

  private async streamAnswer(prompt: string, systemPrompt: string, options: HarnessOptions): Promise<void> {
    const { model, logger } = this.deps, turnId = this.input.turnId;
    const maxTokens = options.maxAnswerTokens ?? 900, temperature = options.temperature ?? 0.2;
    let emittedAny = false;
    const handleChunk = (chunk: string) => { if (this.cancelled || !chunk) return; emittedAny = true; this.emit({ kind: 'content', turnId, delta: chunk }); };

    try {
      if (model.completeStream) await model.completeStream(prompt, { systemPrompt, maxTokens, temperature }, handleChunk);
      else handleChunk(await model.complete(prompt, { systemPrompt, maxTokens, temperature }));
    } catch (err) {
      if (this.cancelled) return; logger.error('model call failed', { err: String(err) });
      if (!emittedAny) this.emit({ kind: 'content', turnId, delta: 'I had trouble generating a response from the local model. Make sure Ollama is installed.' });
    }
    if (!this.cancelled) this.emit({ kind: 'done', turnId });
  }

  emitPhase(phase: 'classify' | 'plan' | 'execute' | 'compose') { if (!this.cancelled) this.emit({ kind: 'phase', turnId: this.input.turnId, phase }); }
  emitReasoning(text: string) { if (!this.cancelled && text) this.emit({ kind: 'reasoning', turnId: this.input.turnId, text }); }
  emitToolCall(tool: string, args: Record<string, unknown>) {
    const callId = `${this.input.turnId}:${tool}:${Math.random().toString(36).slice(2, 8)}`;
    this.emit({ kind: 'tool-call', turnId: this.input.turnId, tool, args, callId }); return callId;
  }
  emitToolResult(callId: string, tool: string, summary: string) { this.emit({ kind: 'tool-result', turnId: this.input.turnId, callId, tool, summary }); }
}

interface ExecutionPlan { intent: ChatIntent; steps: PlanStep[]; summary: string; }
type PlanStep = { kind: 'day_activity_summary' } | { kind: 'calendar_check' } | { kind: 'open_loops' } | { kind: 'search_frames'; query: string; limit?: number; anchorDay?: boolean } | { kind: 'search_index_pages'; query: string; limit?: number } | { kind: 'people_fanout_search'; query: string; limit?: number } | { kind: 'synthesize_people_context'; query: string } | { kind: 'frame_context_for_top'; before?: number; after?: number; max?: number; garbledOnly?: boolean; } | { kind: 'rank_preference_signals' } | { kind: 'entity_lookup'; query: string; entityKind?: 'project' | 'contact' | 'channel' | 'repo' } | { kind: 'entity_summary_for_top'; max?: number } | { kind: 'entity_timeline_for_top'; granularity?: 'hour' | 'day'; limit?: number } | { kind: 'entity_summary_for_clean_contact'; query: string; max?: number };

function planForIntent(intent: ChatIntent, message: string): ExecutionPlan {
  const focused = extractFocusedQuery(message);
  switch (intent) {
    case 'day_overview': return { intent, summary: 'Pull day overview', steps: [{ kind: 'day_activity_summary' }, { kind: 'frame_context_for_top', max: 2, before: 3, after: 1, garbledOnly: true }] };
    case 'calendar_check': return { intent, summary: 'Check calendar', steps: [{ kind: 'calendar_check' }, { kind: 'frame_context_for_top', max: 2, before: 1, after: 1, garbledOnly: true }] };
    case 'open_loops': return { intent, summary: 'Check open loops', steps: [{ kind: 'open_loops' }, { kind: 'frame_context_for_top', max: 3, before: 3, after: 1, garbledOnly: true }] };
    case 'recall_event': return { intent, summary: 'Search frames', steps: [{ kind: 'search_frames', query: focused || message, limit: 12 }, { kind: 'frame_context_for_top', max: 1, before: 3, after: 3 }] };
    case 'recall_preference': return { intent, summary: 'Search preferences', steps: [{ kind: 'search_frames', query: `${focused || message} liked favorite best top pick`, limit: 16 }, { kind: 'rank_preference_signals' }, { kind: 'frame_context_for_top', max: 3, before: 3, after: 3 }] };
    case 'project_status': return { intent, summary: 'Check project status', steps: [{ kind: 'entity_lookup', query: focused || message, entityKind: 'project' }, { kind: 'entity_summary_for_top', max: 1 }, { kind: 'search_index_pages', query: focused || message, limit: 5 }] };
    case 'people_context': return { intent, summary: 'Resolve person', steps: [{ kind: 'entity_lookup', query: focused || message, entityKind: 'contact' }, { kind: 'entity_summary_for_clean_contact', query: focused || message, max: 1 }, { kind: 'people_fanout_search', query: focused || message, limit: 10 }, { kind: 'synthesize_people_context', query: focused || message }] };
    case 'time_audit': return focused ? { intent, summary: 'Time audit for entity', steps: [{ kind: 'day_activity_summary' }, { kind: 'entity_lookup', query: focused }, { kind: 'entity_timeline_for_top', granularity: 'hour', limit: 24 }] } : { intent, summary: 'Daily time audit', steps: [{ kind: 'day_activity_summary' }] };
    case 'topic_deep_dive': return { intent, summary: 'Deep dive topic', steps: [{ kind: 'search_index_pages', query: focused || message, limit: 6 }, { kind: 'search_frames', query: focused || message, limit: 20, anchorDay: false }, { kind: 'entity_lookup', query: focused || message }, { kind: 'entity_summary_for_top', max: 1 }] };
    default: return { intent, summary: 'Generic search', steps: focused ? [{ kind: 'search_index_pages', query: focused, limit: 4 }, { kind: 'search_frames', query: focused, limit: 10, anchorDay: false }] : [{ kind: 'day_activity_summary' }] };
  }
}

interface ExecArgs { plan: ExecutionPlan; tools: ToolDeps; model: IModelAdapter; anchor: DateAnchor; results: CollectedToolResults; ctx: TurnContext; logger: Logger; }

async function executePlan(args: ExecArgs): Promise<void> {
  for (const step of args.plan.steps) { if (args.ctx.isCancelled()) return; await runStep(step, args); }
}

async function runStep(step: PlanStep, args: ExecArgs): Promise<void> {
  const { tools, anchor, results, ctx } = args;
  switch (step.kind) {
    case 'day_activity_summary': {
      const callId = ctx.emitToolCall('get_day_activity_summary', { day: anchor.day });
      results.day_overview = await getDayActivitySummary(tools, anchor);
      ctx.emitToolResult(callId, 'get_day_activity_summary', `${results.day_overview.totals.sessions} sessions, ${results.day_overview.calendar_candidates.length} cal hints, ${results.day_overview.open_loop_candidates.length} loops`);
      return;
    }
    case 'calendar_check': {
      const callId = ctx.emitToolCall('get_calendar_events', { day: anchor.day });
      results.calendar_check = await getCalendarCandidates(tools, anchor);
      ctx.emitToolResult(callId, 'get_calendar_events', `${results.calendar_check.candidates.length} hints`);
      return;
    }
    case 'open_loops': {
      const callId = ctx.emitToolCall('get_open_loops', { day: anchor.day });
      results.open_loops = await getOpenLoopCandidates(tools, anchor);
      ctx.emitToolResult(callId, 'get_open_loops', `${results.open_loops.candidates.length} hints`);
      return;
    }
    case 'search_frames': {
      const day = step.anchorDay === false ? undefined : anchor.day;
      const callId = ctx.emitToolCall('search_frames', { query: step.query, limit: step.limit, ...(day && { day }) });
      const out = await searchFramesTool(tools, { query: step.query, day, limit: step.limit });
      results.searches.push(out);
      ctx.emitToolResult(callId, 'search_frames', `${out.matches.length} matches`);
      return;
    }
    case 'search_index_pages': {
      const callId = ctx.emitToolCall('search_index_pages', { query: step.query, limit: step.limit });
      const out = await searchIndexPagesTool(tools, { query: step.query, limit: step.limit });
      results.index_searches.push(out);
      ctx.emitToolResult(callId, 'search_index_pages', `${out.matches.length} matches`);
      return;
    }
    case 'people_fanout_search': {
      const query = expandPersonSearchQuery(step.query, results);
      if (query !== step.query) results.notes.push(`Expanded person search: "${query}"`);
      const iCallId = ctx.emitToolCall('search_index_pages', { query, limit: step.limit });
      const fCallId = ctx.emitToolCall('search_person_frames', { query, limit: step.limit });
      const [iOut, fOut] = await Promise.all([searchIndexPagesTool(tools, { query, limit: step.limit }), searchPersonFramesTool(tools, { query, limit: step.limit })]);
      results.index_searches.push(iOut); results.searches.push(fOut);
      ctx.emitToolResult(iCallId, 'search_index_pages', `${iOut.matches.length} matches`);
      ctx.emitToolResult(fCallId, 'search_person_frames', `${fOut.matches.length} matches`);
      return;
    }
    case 'synthesize_people_context': {
      const callId = ctx.emitToolCall('synthesize_people_context', { query: step.query });
      const out = await synthesizePeopleContext(args, step.query);
      results.people_synthesis = out;
      ctx.emitToolResult(callId, 'synthesize_people_context', `${out.usedVision ? 'vision + text' : 'text'} synthesis from ${out.imageCount} imgs`);
      return;
    }
    case 'frame_context_for_top': {
      const ids = collectTopFrameIds(results, step.max ?? 1, { garbledOnly: step.garbledOnly === true });
      if (!ids.length && step.garbledOnly) return;
      for (const frameId of ids) {
        if (ctx.isCancelled()) return;
        const callId = ctx.emitToolCall('get_frame_context', { frameId, before: step.before, after: step.after });
        const out = await getFrameContextTool(tools, { frameId, before: step.before, after: step.after });
        if (out) { results.frame_contexts.push(out); ctx.emitToolResult(callId, 'get_frame_context', `Context: ${out.before.length} before, ${out.after.length} after`); }
        else ctx.emitToolResult(callId, 'get_frame_context', 'no context');
      }
      return;
    }
    case 'entity_lookup': {
      const callId = ctx.emitToolCall('list_entities', { query: step.query, kind: step.entityKind });
      const out = await listEntitiesTool(tools, { query: step.query, kind: step.entityKind, limit: 8 });
      results.entity_lookups.push(out);
      ctx.emitToolResult(callId, 'list_entities', `${out.entities.length} matches`);
      return;
    }
    case 'entity_summary_for_top': {
      const lookup = results.entity_lookups[results.entity_lookups.length - 1];
      for (const target of (lookup?.entities ?? []).slice(0, step.max ?? 1)) {
        if (ctx.isCancelled()) return;
        const callId = ctx.emitToolCall('get_entity_summary', { path: target.path });
        const out = await getEntitySummaryTool(tools, { path: target.path, sinceIso: shiftIso(args.anchor.fromIso, -7 * 24 * 60), untilIso: args.anchor.toIso });
        if (out) { results.entity_summaries.push(out); ctx.emitToolResult(callId, 'get_entity_summary', `${out.frameCount} frames`); }
        else ctx.emitToolResult(callId, 'get_entity_summary', 'not found');
      }
      return;
    }
    case 'rank_preference_signals': {
      const latest = results.searches[results.searches.length - 1];
      if (!latest || !latest.matches.length) return;
      latest.matches = latest.matches.map(f => ({ f, s: preferenceScore(f) })).sort((a, b) => b.s - a.s || b.f.timestamp.localeCompare(a.f.timestamp)).map(o => o.f);
      return;
    }
    case 'entity_timeline_for_top': {
      const target = results.entity_lookups[results.entity_lookups.length - 1]?.entities[0];
      if (!target) return;
      const callId = ctx.emitToolCall('get_entity_timeline', { path: target.path });
      const out = await getEntitySummaryTool(tools, { path: target.path, sinceIso: args.anchor.fromIso, untilIso: args.anchor.toIso });
      if (out) { results.entity_summaries.push(out); ctx.emitToolResult(callId, 'get_entity_timeline', `${out.timeline.length} buckets`); }
      else ctx.emitToolResult(callId, 'get_entity_timeline', 'not found');
      return;
    }
    case 'entity_summary_for_clean_contact': {
      const targets = (results.entity_lookups[results.entity_lookups.length - 1]?.entities ?? []).filter(e => isCleanContactMatch(step.query, e)).slice(0, step.max ?? 1);
      if (!targets.length) return;
      for (const target of targets) {
        if (ctx.isCancelled()) return;
        const callId = ctx.emitToolCall('get_entity_summary', { path: target.path });
        const out = await getEntitySummaryTool(tools, { path: target.path, sinceIso: shiftIso(args.anchor.fromIso, -7 * 24 * 60), untilIso: args.anchor.toIso });
        if (out) { results.entity_summaries.push(out); ctx.emitToolResult(callId, 'get_entity_summary', `${out.frameCount} frames`); }
        else ctx.emitToolResult(callId, 'get_entity_summary', 'not found');
      }
      return;
    }
  }
}

function collectTopFrameIds(results: CollectedToolResults, max: number, opts: { garbledOnly?: boolean } = {}): string[] {
  const ids = new Set<string>();
  const add = (arr?: any[]) => arr?.forEach(f => (!opts.garbledOnly || f.garbled) && ids.size < max && ids.add(f.id));
  add(results.open_loops?.candidates); add(results.day_overview?.open_loop_candidates); add(results.calendar_check?.candidates); add(results.day_overview?.calendar_candidates);
  results.searches.forEach(s => add(s.matches));
  return Array.from(ids);
}

async function synthesizePeopleContext(args: ExecArgs, query: string) {
  const { model, tools, results } = args;
  if (!(await model.isAvailable().catch(() => false))) return { query, brief: 'No LLM synthesis available.', usedVision: false, imageCount: 0 };

  const frames = collectPeopleFrames(results).slice(0, 8);
  const images = (model.getModelInfo?.()?.supportsVision) ? await readFrameImages(tools.storage, frames.slice(0, 5)) : [];
  
  const prompt = [
    `You are the evidence-synthesis step for CofounderOS. The user asked: "${query}".`,
    'Produce a concise factual brief.',
    '**Synthesis:** 1-2 sentences with the useful answer, or "No useful update found."',
    '**Recent messages:** bullets.',
    '**Commitments / todos:** bullets.',
    '**Open loops:** bullets.',
    '**Rejected noise:** one short sentence.',
    '\nKnowledge-base candidates:\n' + (results.index_searches.flatMap(s => s.matches.slice(0,6).map(m => `- ${m.title}: ${truncateForSynthesis(m.excerpt, 700)}`)).join('\n') || '- none'),
    '\nEntity/contact candidates:\n' + (results.entity_lookups.flatMap(l => l.entities.filter(e => e.kind === 'contact').slice(0,6).map(e => `- ${e.title}`)).join('\n') || '- none'),
    '\nFrame/screenshot candidates:\n' + (frames.map((f, i) => `Frame ${i + 1}:\n- time: ${f.timestamp}\n- app/window: ${f.app} / ${f.window_title}\n- OCR: ${truncateForSynthesis(f.excerpt ?? '', 900) || 'none'}`).join('\n\n') || 'None.')
  ].join('\n');

  try {
    const brief = images.length > 0 ? await model.completeWithVision(prompt, images, { maxTokens: 700, temperature: 0.1 }) : await model.complete(prompt, { maxTokens: 700, temperature: 0.1 });
    return { query, brief: brief.trim() || 'No useful update found.', usedVision: images.length > 0, imageCount: images.length };
  } catch (err) { return { query, brief: `Synthesis failed: ${err}`, usedVision: images.length > 0, imageCount: images.length }; }
}

function collectPeopleFrames(results: CollectedToolResults): CompactFrame[] {
  const ids = new Set(), out: CompactFrame[] = [];
  for (const s of results.searches) for (const f of s.matches) if (!ids.has(f.id)) { ids.add(f.id); out.push(f); }
  return out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

async function readFrameImages(storage: IStorage, frames: CompactFrame[]): Promise<Buffer[]> {
  const imgs: Buffer[] = [];
  for (const f of frames) if (f.asset_path) try { imgs.push(await storage.readAsset(f.asset_path)); } catch {}
  return imgs;
}

function truncateForSynthesis(text: string, max: number): string { const c = text.replace(/\s+/g, ' ').trim(); return c.length <= max ? c : `${c.slice(0, max - 3)}...`; }

function isCleanContactMatch(query: string, entity: any): boolean {
  if (entity.kind !== 'contact') return false;
  const title = normalisePersonText(entity.title), tail = normalisePersonText(entity.path.split('/').pop() ?? entity.path), wanted = normalisePersonText(query);
  if (!wanted || /[,+&\/]| and | with /.test(entity.title.toLowerCase())) return false;
  return title === wanted || tail === wanted || title.startsWith(`${wanted} `) || tail.startsWith(`${wanted} `);
}

function expandPersonSearchQuery(query: string, results: CollectedToolResults): string {
  const lookup = results.entity_lookups[results.entity_lookups.length - 1], wanted = normalisePersonText(query);
  if (!lookup || !wanted) return query;
  for (const e of lookup.entities) {
    const t = extractPersonNameFromCandidate(query, e.title) || extractPersonNameFromCandidate(query, e.path.split('/').pop() ?? '');
    if (t) return t;
  }
  return query;
}

function extractPersonNameFromCandidate(query: string, value: string): string {
  const wanted = normalisePersonText(query);
  if (!wanted) return '';
  const words = value.replace(/[-_]+/g, ' ').replace(/[,+&].*$/g, '').replace(/\/.*$/g, '').replace(/\band\b.*$/i, '').split(/\s+/).filter(Boolean);
  const idx = words.findIndex(w => normalisePersonText(w) === wanted);
  return idx === -1 ? '' : words.slice(idx, idx + 2).join(' ');
}

function normalisePersonText(value: string): string { return value.toLowerCase().replace(/contacts\//g, '').replace(/[-_]+/g, ' ').replace(/[^\\p{L}\\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim(); }
function shiftIso(iso: string, deltaMin: number): string { return new Date(Date.parse(iso) + deltaMin * 60000).toISOString(); }

const STOP_WORDS = new Set(['a', 'an', 'and', 'or', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'on', 'in', 'at', 'to', 'for', 'of', 'with', 'about', 'from', 'by', 'into', 'i', "i'm", 'me', 'my', 'mine', 'we', 'our', 'us', 'you', 'your', 'they', 'them', 'their', 'this', 'that', 'these', 'those', 'do', 'did', 'does', 'doing', 'have', 'has', 'had', 'having', 'today', 'yesterday', 'tomorrow', 'now', 'last', 'next', 'latest', 'new', 'recent', 'updates', 'update', 'news', 'happening', 'status', 'progress', 'what', "what's", 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'tell', 'show', 'find', 'list', 'give', 'get', 'know', 'think', 'please', 'thanks', 'thank', 'all', 'any', 'some', 'every']);

function extractFocusedQuery(message: string): string {
  const subject = message.match(/\b(?:what'?s\s+(?:the\s+)?(?:latest|new|happening)\s+(?:with|on|about|in)|(?:any|anything)\s+(?:new|recent|updates?|news)\s+(?:on|about|with|for)|where\s+am\s+i\s+(?:on|with|at)|where\s+(?:are|did)\s+we\s+(?:leave|land)\s+(?:on|with)|status\s+(?:of|on)|progress\s+(?:of|on))\s+(.+?)\s*[?.!]*$/i)?.[1] || message.match(/\bhow'?s?\s+(?:is\s+|it\s+(?:going\s+)?)?(.+?)\s+going\b\s*[?.!]*/i)?.[1] || message.match(/\bhow'?s?\s+(.+?)\s+(?:doing|tracking|coming along)\b/i)?.[1];
  if (subject) { const c = subject.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim(); if (c && !STOP_WORDS.has(c.toLowerCase())) return c; }
  return message.toLowerCase().replace(/[^\\p{L}\\p{N}\s'-]+/gu, ' ').split(/\s+/).filter(t => !STOP_WORDS.has(t) && t.length >= 3).slice(0, 3).join(' ');
}

function hasCapturedEvidence(results: CollectedToolResults): boolean {
  if (results.day_overview && (results.day_overview.totals.frames > 0 || results.day_overview.totals.sessions > 0 || results.day_overview.calendar_candidates.length > 0 || results.day_overview.open_loop_candidates.length > 0 || results.day_overview.top_apps.length > 0 || results.day_overview.top_entities.length > 0)) return true;
  if ((results.calendar_check?.candidates.length ?? 0) > 0 || (results.open_loops?.candidates.length ?? 0) > 0 || results.searches.some(s => s.matches.length > 0) || results.index_searches.some(s => s.matches.length > 0) || results.frame_contexts.length > 0 || results.session_details.length > 0 || results.entity_summaries.length > 0 || results.entity_lookups.some(l => l.entities.length > 0)) return true;
  if (results.people_synthesis && !['no useful update', 'synthesis failed', 'not available'].some(t => results.people_synthesis!.brief.toLowerCase().includes(t))) return true;
  return false;
}

function composeNoEvidenceAnswer(intent: ChatIntent, anchor: DateAnchor): string {
  const msg = anchor.label === 'today' ? 'for today' : `around ${anchor.day}`;
  switch (intent) {
    case 'recall_event': case 'recall_preference': return `I don't see that in your captures.\n\n_I searched your captured frames ${msg} and didn't find anything matching that._`;
    case 'calendar_check': return `I don't see any calendar frames captured for ${anchor.day}.\n\n_Open your calendar app so a frame gets captured, then ask again._`;
    case 'open_loops': return `Nothing pending I can confirm from your captures ${msg}.`;
    case 'day_overview': return `I don't have any captured activity for ${anchor.day} yet.`;
    case 'project_status': case 'topic_deep_dive': return `I don't see anything about that in your captures.`;
    case 'people_context': return `I don't see any captured messages involving that person.`;
    case 'time_audit': return `I don't have any captured activity for ${anchor.day} to total up.`;
    default: return `I don't see that in your captures.`;
  }
}

function composeOfflineFallback(intent: ChatIntent, anchor: DateAnchor, results: CollectedToolResults): string {
  const lines: string[] = [`_The local model isn't available, so here's a deterministic readout of what I gathered for ${anchor.label} (${anchor.day})._`];
  if (results.day_overview) lines.push(`**Totals:** ${results.day_overview.totals.active_min} active min across ${results.day_overview.totals.sessions} sessions.`);
  for (const s of results.searches) lines.push(`**Search "${s.query}":** ${s.matches.length} matches.`);
  for (const s of results.index_searches) lines.push(`**Knowledge-base search "${s.query}":** ${s.matches.length} page matches.`);
  if (lines.length === 1) lines.push('_No structured data was gathered for this question._');
  lines.push('_Bootstrap a local model in **Connect AI** to get a written answer based on this data._');
  return lines.join('\n\n');
}
