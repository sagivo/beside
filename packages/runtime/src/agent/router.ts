import type { IModelAdapter } from '@cofounderos/interfaces';
import { classifyByRules } from './intent.js';
import type { ChatIntent, ChatTurnHistoryItem } from './types.js';

/**
 * Triage decision for a chat turn.
 *
 *   - `tools`  → run the full classify → plan → execute → compose pipeline.
 *               The captured-memory tools will be invoked.
 *
 *   - `direct` → skip the tool surface entirely. Stream a regular chat
 *               answer using only the user's message + recent history.
 *               Use this for greetings, general knowledge, code
 *               questions, follow-ups that just refer back to the
 *               previous turn, off-topic chat, etc.
 *
 * Why this gate exists:
 *   The harness tools (`get_daily_summary`, `search_frames`, …) are
 *   only useful for personal-productivity questions about the user's
 *   captured device activity. Forcing every turn through them produces
 *   weird answers ("I couldn't find anything about Paris in your
 *   captures") and wastes latency on the storage queries.
 */
export type RouteDecision =
  | { kind: 'tools'; intent: ChatIntent; reason: string }
  | { kind: 'direct'; reason: string };

const INTENT_VALUES: ChatIntent[] = [
  'daily_briefing',
  'calendar_check',
  'open_loops',
  'recall_preference',
  'recall_event',
  'project_status',
  'people_context',
  'time_audit',
  'topic_deep_dive',
  'general',
];
const INTENT_SET = new Set<string>(INTENT_VALUES);

/**
 * Decide how to route a chat turn.
 *
 * LLM-first: when a local model is available we always ask it. The
 * model returns route + intent in a single JSON call to avoid a second
 * roundtrip when it picks `tools`. We only fall back to deterministic
 * regex rules when the model is unavailable, or when its output can't
 * be parsed at all.
 */
export async function routeRequest(
  model: IModelAdapter,
  message: string,
  history: ChatTurnHistoryItem[],
): Promise<RouteDecision> {
  const trimmed = message.trim();
  if (!trimmed) return { kind: 'direct', reason: 'empty message' };

  const forcedTools = decideByHighConfidenceToolSignal(trimmed);
  if (forcedTools) return forcedTools;

  const available = await model.isAvailable().catch(() => false);
  if (!available) return decideByRules(trimmed, 'no local model available');

  try {
    const decision = await llmRouteGate(model, trimmed, history);
    if (decision) return decision;
  } catch {
    /* fall through to rules */
  }
  return decideByRules(trimmed, 'model gate returned an unparseable response');
}

// ---------------------------------------------------------------------
// LLM gate
// ---------------------------------------------------------------------

/**
 * One JSON-formatted completion that returns BOTH the route bit and
 * (when the route is `tools`) the harness intent. Doing it in one call
 * saves a second model roundtrip on the common path.
 *
 * Output shape:
 *   { "route": "tools" | "direct",
 *     "intent": "<one of the labels>",   // only required when route=tools
 *     "reason": "<short string>" }       // optional; passed back as the routing reason
 */
async function llmRouteGate(
  model: IModelAdapter,
  message: string,
  history: ChatTurnHistoryItem[],
): Promise<RouteDecision | null> {
  const recent = history
    .slice(-4)
    .map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${truncate(h.content, 200)}`)
    .join('\n');

  const prompt = [
    'You are the router for a personal-productivity assistant called CofounderOS, which captures the user\'s device activity (screenshots, OCR text, calendar UIs, chats, focus sessions) on disk.',
    '',
    'Hard constraint: CofounderOS has NO internet access, NO web search, and NO real-time data. It cannot answer questions about current events, news, prices, sports, or anything happening in the outside world. The only thing it knows specifically about is the user\'s own captured activity.',
    '',
    'Given the user\'s message, decide whether the answer requires looking up that captured data ("tools") or whether it can be answered as normal conversation ("direct").',
    '',
    'Use route="tools" when the question is about the user\'s own activity:',
    '- Their day, schedule, meetings, calendar, or agenda',
    '- Their projects, channels, contacts, focus sessions, or time usage',
    '- Things they saw, read, wrote, opened, or talked about',
    '- Open loops, follow-ups, pending items, unanswered messages',
    '- "What\'s the latest with X", "any updates on X", "anything new on Y", "what\'s happening with Z", "where am I with X" — these are ALWAYS about the user\'s own context around that topic, not world news. Route to tools (intent: topic_deep_dive, or project_status / people_context if X is clearly a project or person).',
    '- A bare topic, company, person, or project name with no other framing — assume the user wants their own context on it. Route to tools (topic_deep_dive).',
    '',
    'Use route="direct" for anything else:',
    '- Greetings, thanks, small talk',
    '- Definitional / explanatory questions where the user clearly wants encyclopedic info ("what is a hash map", "explain TCP", "how does diffusion work")',
    '- Code, math, translations, writing help',
    '- Conversational follow-ups that refine the previous answer ("shorter", "in bullets", "rewrite")',
    '',
    'Disambiguation rule when uncertain: if the message names a specific topic / company / person / project but does NOT ask for a definition or explanation of it, prefer route="tools". The user is almost always asking about their own activity on that thing, because that\'s what this assistant is for.',
    '',
    'When route="tools", also pick exactly one of these intents (verbatim). Use the cues:',
    '  - daily_briefing: "what\'s on my plate", "what do i have today", briefing-style prompts.',
    '  - calendar_check: meetings, schedule, agenda, "am I free", "when is X".',
    '  - open_loops: "open loops", "pending", "follow ups", "to-dos", "what\'s waiting on me".',
    '  - recall_preference: "favorite", "best pick", "what did I like", "top pick", shortlist questions.',
    '  - recall_event: "when did I…", "did I see/read/open…", "where did I see X".',
    '  - project_status: "how is <project> going", "status of <project>", "progress on <project>".',
    '  - people_context: "what\'s the latest with <person>", "what did <person> say", anything about a specific person.',
    '  - time_audit: "how much time on X", "time spent", "what apps did I use", "when was I most active".',
    '  - topic_deep_dive: broad "tell me everything about X", or topic/company prompts that don\'t fit a more specific intent.',
    '  - general: catch-all when the user is asking something captured-data-shaped but no specific intent fits.',
    '',
    recent ? `Recent conversation (oldest first):\n${recent}\n` : '',
    `User message:\n${message}`,
    '',
    'Reply with a JSON object. Examples:',
    '  {"route":"direct","reason":"greeting or general definitional question"}',
    '  {"route":"tools","intent":"daily_briefing","reason":"asks about today"}',
    '  {"route":"tools","intent":"recall_event","reason":"wants to find a past frame"}',
    '  {"route":"tools","intent":"recall_preference","reason":"asks about a favorite or top pick"}',
    '  {"route":"tools","intent":"project_status","reason":"\\"how is <project> going\\""}',
    '  {"route":"tools","intent":"topic_deep_dive","reason":"\\"what\'s the latest with X\\" — wants their own context on X"}',
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await model.complete(prompt, {
    maxTokens: 80,
    temperature: 0,
    responseFormat: 'json',
    systemPrompt:
      'You output ONLY a JSON object with fields "route", optional "intent", optional "reason". No prose, no Markdown, no code fences.',
  });

  return parseRouteJson(raw);
}

function parseRouteJson(raw: string): RouteDecision | null {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0] : raw;
  let parsed: { route?: unknown; intent?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(candidate) as typeof parsed;
  } catch {
    return parseRouteByScan(raw);
  }
  const route = typeof parsed.route === 'string' ? parsed.route.trim().toLowerCase() : '';
  const reason =
    typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : 'model gate decided';

  if (route === 'direct') return { kind: 'direct', reason: `model: ${reason}` };
  if (route === 'tools') {
    const intentRaw = typeof parsed.intent === 'string' ? parsed.intent.trim() : '';
    const intent = INTENT_SET.has(intentRaw) ? (intentRaw as ChatIntent) : 'general';
    return { kind: 'tools', intent, reason: `model: ${reason}` };
  }
  return null;
}

/**
 * Last-resort string scan for when the model emits prose around its
 * JSON. We accept any clear "route" + "intent" word combination that
 * appears in the output.
 */
function parseRouteByScan(raw: string): RouteDecision | null {
  const lower = raw.toLowerCase();
  const directHit = /\bdirect\b/.test(lower);
  const toolsHit = /\btools\b/.test(lower);
  if (directHit && !toolsHit) return { kind: 'direct', reason: 'model gate (string scan)' };
  if (toolsHit && !directHit) {
    const intent =
      INTENT_VALUES.find((i) => lower.includes(i)) ?? ('general' as ChatIntent);
    return { kind: 'tools', intent, reason: 'model gate (string scan)' };
  }
  return null;
}

// ---------------------------------------------------------------------
// Rule fallback (used only when no model is available)
// ---------------------------------------------------------------------

const TOOL_SIGNAL_PATTERNS: RegExp[] = [
  /\b(my|our)\b.*\b(day|week|schedule|calendar|meeting|standup|emails?|inbox|todos?|tasks?|projects?|notes?|messages?|chats?|threads?|loops?|follow.?ups?)\b/i,
  /\bwhat (did|have) i (work|been working|been doing|done|seen|read|written)\b/i,
  /\bwhen (did|have) i\b/i,
  /\bdid i (see|read|write|open|visit|talk|message|meet)\b/i,
  /\bwho (do|did) i (work|talk|meet) (with|to)\b/i,
  /\bhow much time\b/i,
  /\b(today|yesterday|tomorrow|last (week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this morning|tonight|earlier today)\b/i,
  /\b(meetings?|calendar|schedule|agenda)\b/i,
  /\b(open loops?|open items?|pending|unanswered|waiting on|follow.?up|to.?do)\b/i,
  /\b(status|progress) (of|on)\b/i,
  /\bsummari[sz]e (my|the day|today|yesterday|this week|that meeting)\b/i,
  /\bwhat'?s on my plate\b/i,
  // "What's the latest with / on / about X", "anything new on X", "any
  // updates on X", "what's happening with X" — in this app these are
  // always about the user's own captured context on X, not world news,
  // because the assistant has no internet access.
  /\bwhat'?s (the )?(latest|new|happening) (with|on|about|in)\b/i,
  /\b(any|anything) (new|recent|updates?|news) (on|about|with|for)\b/i,
  /\bwhere am i (on|with|at)\b/i,
  /\bwhere (are|did) we (leave|land) (on|with)\b/i,
];

const HIGH_CONFIDENCE_TOOL_SIGNAL_PATTERNS: RegExp[] = [
  /\b(my|our)\b.*\b(day|week|schedule|calendar|meeting|standup|emails?|inbox|todos?|tasks?|projects?|notes?|messages?|chats?|threads?|loops?|follow.?ups?)\b/i,
  /\bwhat (did|have) i (work|been working|been doing|done|seen|read|written)\b/i,
  /\bwhen (did|have) i\b/i,
  /\bdid i (see|read|write|open|visit|talk|message|meet)\b/i,
  /\bwho (do|did) i (work|talk|meet) (with|to)\b/i,
  /\bhow much time\b/i,
  /\b(meetings?|calendar|schedule|agenda)\b/i,
  /\b(open loops?|open items?|pending|unanswered|waiting on|follow.?up|to.?do)\b/i,
  /\b(status|progress) (of|on)\b/i,
  // "How is <project> going?" / "How's it going with <project>?" — these
  // are project-status questions about the user's own work, not small
  // talk. The bare "how is X going" form is the one most likely to be
  // mis-routed to direct, since the LLM router can read it as a generic
  // "how are you" prompt.
  /\bhow'?s? (is |it )?(the )?\w+ going\b/i,
  /\bsummari[sz]e (my|the day|today|yesterday|this week|that meeting)\b/i,
  /\bwhat'?s on my plate\b/i,
  /\bwhat'?s (the )?(latest|new|happening) (with|on|about|in)\b/i,
  /\b(any|anything) (new|recent|updates?|news) (on|about|with|for)\b/i,
  /\bwhere am i (on|with|at)\b/i,
  /\bwhere (are|did) we (leave|land) (on|with)\b/i,
  // Preference recall — favorite / top pick / best pick.
  /\b(my )?(favou?rite|top pick|best (option|pick))\b/i,
  /\bwhat did i (like|prefer|pick|choose)\b/i,
];

const DIRECT_SIGNAL_PATTERNS: RegExp[] = [
  /^(hi|hello|hey|yo|sup|good (morning|afternoon|evening)|thanks|thank you|thx|ty|ok|okay|cool|nice|great|got it|sure)[\s!.?]*$/i,
  /\b(who are you|what are you|what can you do|what do you do|how do you work|are you (an? )?(ai|llm|model|bot))\b/i,
  /\b(what is|what are|what does|how do(es)?|why is|why does|when is|where is|tell me about|explain|define|describe)\b\s+(?!my|i\b|our\b|the (user|we))/i,
  /\b(write|generate|fix|debug|refactor|review|optimi[sz]e)\s+(code|function|script|class|component|test)\b/i,
  /\b(typescript|javascript|python|rust|go|java|c\+\+|c#|swift|kotlin|sql|html|css|react|node)\b/i,
  /\b(elaborate|expand|simpler|simplify|shorter|longer|more concise|in bullet points|step by step|like i'?m (5|five))\b/i,
  /\b(rewrite|rephrase|translate)\b/i,
  /^[\s\d+\-*/().,=]+$/,
];

/**
 * Deterministic fallback used only when the LLM router can't be
 * consulted. We bias toward `tools` whenever the message looks
 * personal-productivity, and toward `direct` otherwise. Includes a
 * small "short follow-up" heuristic to avoid spinning up tools on a
 * one-line clarification.
 */
function decideByRules(message: string, why: string): RouteDecision {
  if (TOOL_SIGNAL_PATTERNS.some((p) => p.test(message))) {
    const intent = classifyByRules(message) ?? 'general';
    return { kind: 'tools', intent, reason: `rule fallback (${why}): tool signal matched` };
  }
  if (DIRECT_SIGNAL_PATTERNS.some((p) => p.test(message))) {
    return { kind: 'direct', reason: `rule fallback (${why}): direct signal matched` };
  }
  // Conservative default: if the message has first-person language,
  // try tools (the user might be asking about their data with phrasing
  // we didn't anticipate). Otherwise direct.
  if (/\b(i|me|my|mine)\b/i.test(message)) {
    const intent = classifyByRules(message) ?? 'general';
    return { kind: 'tools', intent, reason: `rule fallback (${why}): first-person language` };
  }
  return { kind: 'direct', reason: `rule fallback (${why}): no productivity signals` };
}

function decideByHighConfidenceToolSignal(message: string): RouteDecision | null {
  if (!HIGH_CONFIDENCE_TOOL_SIGNAL_PATTERNS.some((p) => p.test(message))) return null;
  const intent = classifyByRules(message) ?? 'general';
  return {
    kind: 'tools',
    intent,
    reason: 'rule: captured-memory lookup phrase matched',
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
