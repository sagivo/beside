import type { IModelAdapter } from '@beside/interfaces';
import type { ChatIntent } from './types.js';

const INTENT_VALUES: ChatIntent[] = [
  'day_overview',
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

const SIGNAL_PATTERNS: Array<{ intent: ChatIntent; patterns: RegExp[] }> = [
  {
    intent: 'day_overview',
    patterns: [
      /\bon my plate\b/i,
      /\bdaily summary\b/i,
      /\bwhat do i have (today|going on|to do)\b/i,
      /\bwhat'?s? (my )?(day|today|tomorrow|yesterday) (look like|going|like)\b/i,
      /\bwhat (did|have) i (work|been working)\b/i,
    ],
  },
  {
    intent: 'calendar_check',
    patterns: [
      /\bmeetings?\b/i,
      /\bschedule\b/i,
      /\bcalendar\b/i,
      /\bam i (free|busy)\b/i,
      /\bwhen is (my|the)\b/i,
    ],
  },
  {
    intent: 'open_loops',
    patterns: [
      /\b(open loops?|open items?)\b/i,
      /\b(pending|outstanding|unresolved|unanswered)\b/i,
      /\bfollow.?up\b/i,
      /\bwaiting on\b/i,
      /\bto.?do\b/i,
    ],
  },
  {
    intent: 'recall_preference',
    patterns: [
      /\bwhat did i (like|prefer|pick|choose)\b/i,
      /\bfavorite\b/i,
      /\bbest (option|pick)\b/i,
      /\btop pick\b/i,
    ],
  },
  {
    intent: 'recall_event',
    patterns: [
      /\bwhen did i\b/i,
      /\bdid i (see|read|open|visit)\b/i,
      /\bwhere was that\b/i,
      /\bwho said\b/i,
      /\blast time i\b/i,
    ],
  },
  {
    intent: 'project_status',
    patterns: [
      /\bstatus (of|on)\b/i,
      /\bprogress (of|on)\b/i,
      /\bwhat'?s? happening (with|on)\b/i,
      /\bhow is (the )?\w+ going\b/i,
    ],
  },
  {
    intent: 'people_context',
    patterns: [
      /\bwhat'?s (the )?(latest|new|happening) (with|on|about|in)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s*[?.!]*$/,
      /\b(any|anything) (new|recent|updates?|news) (on|about|with|for)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s*[?.!]*$/,
      /\bwho do i work with\b/i,
      /\bwho is\b/i,
      /\blast time i (talked|messaged|met) (to|with)\b/i,
    ],
  },
  {
    intent: 'time_audit',
    patterns: [
      /\bhow much time\b/i,
      /\bwhen was i (most )?active\b/i,
      /\bwhat apps did i use\b/i,
      /\btime spent\b/i,
    ],
  },
  {
    intent: 'topic_deep_dive',
    patterns: [
      /\btell me everything\b/i,
      /\ball references to\b/i,
      /\bdeep dive\b/i,
      // "What's the latest with X", "anything new on Y", "what's
      // happening with Z" — the user wants their own captured context
      // on a topic, not encyclopedic info.
      /\bwhat'?s (the )?(latest|new|happening) (with|on|about|in)\b/i,
      /\b(any|anything) (new|recent|updates?|news) (on|about|with|for)\b/i,
      /\bwhere am i (on|with|at)\b/i,
      /\bwhere (are|did) we (leave|land) (on|with)\b/i,
    ],
  },
];

/**
 * Cheap, deterministic intent guess from regex signals. Never returns
 * `general` — falls back to "let the LLM decide" by returning null when
 * no patterns match.
 */
export function classifyByRules(message: string): ChatIntent | null {
  for (const { intent, patterns } of SIGNAL_PATTERNS) {
    if (patterns.some((p) => p.test(message))) return intent;
  }
  return null;
}

/**
 * LLM-backed classifier. Uses JSON response format so we can parse a
 * single field reliably even with small models. Falls back to the rule
 * classifier (or `general`) on any error.
 */
export async function classifyIntent(
  model: IModelAdapter,
  message: string,
): Promise<ChatIntent> {
  // Always try the rule classifier first — when it matches we save a
  // model round-trip entirely.
  const ruleHit = classifyByRules(message);
  if (ruleHit) return ruleHit;

  const available = await model.isAvailable().catch(() => false);
  if (!available) return 'general';

  const prompt = buildIntentPrompt(message);
  try {
    const raw = await model.complete(prompt, {
      maxTokens: 32,
      temperature: 0,
      responseFormat: 'json',
      systemPrompt:
        'You classify the user\'s message into exactly one of the listed intents. Reply ONLY with a JSON object of shape {"intent": "<one of the labels>"}. Do not include any other text.',
    });
    const parsed = parseIntentJson(raw);
    if (parsed) return parsed;
  } catch {
    /* fall through to the rule fallback */
  }
  return ruleHit ?? 'general';
}

function buildIntentPrompt(message: string): string {
  return [
    'Possible intents (pick exactly one, copy the label verbatim):',
    INTENT_VALUES.map((i) => `- ${i}`).join('\n'),
    '',
    'User message:',
    message,
    '',
    'Reply with a JSON object: {"intent":"<label>"}',
  ].join('\n');
}

function parseIntentJson(raw: string): ChatIntent | null {
  if (!raw) return null;
  // The model sometimes wraps JSON in markdown fences or trailing text.
  const match = raw.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0] : raw;
  try {
    const parsed = JSON.parse(candidate) as { intent?: unknown };
    const intent = typeof parsed.intent === 'string' ? parsed.intent.trim() : '';
    if (INTENT_SET.has(intent)) return intent as ChatIntent;
  } catch {
    /* ignore */
  }
  // Last resort: scan the raw text for any of our labels.
  const lower = raw.toLowerCase();
  for (const intent of INTENT_VALUES) {
    if (lower.includes(intent)) return intent;
  }
  return null;
}
