import { createHash } from 'node:crypto';
import type {
  CaptureHookContext,
  CaptureHookDefinition,
  CaptureHookInput,
  CaptureHookScreenInput,
  IHookPlugin,
  PluginFactory,
} from '@beside/interfaces';

const HOOK_ID = 'followups';
const COLLECTION = 'followups';

const SYSTEM_PROMPT = `You read a single capture of a communication surface (chat, email, transcript) and return STRICT JSON:
{
  "followups": [
    {
      "title": string,
      "body": string,
      "urgency": "high" | "medium" | "low",
      "category": "reply" | "send" | "decide" | "schedule" | "task"
    }
  ]
}
Rules:
- Only output items that require an action from the user.
- Output JSON only, no prose.
- At most 8 items.`;

const DEFINITION: CaptureHookDefinition = {
  id: HOOK_ID,
  title: 'Follow-ups',
  description:
    'Extracts open follow-ups from Slack, Microsoft Teams, Gmail, Outlook, Apple Mail screenshots and meeting transcripts.',
  match: {
    inputKinds: ['screen', 'audio'],
    apps: [
      'slack',
      'discord',
      'microsoft teams',
      'teams',
      'mail',
      'outlook',
      'spark',
      'superhuman',
      'mimestream',
    ],
    urlHosts: [
      'app.slack.com',
      'slack.com',
      'teams.microsoft.com',
      'mail.google.com',
      'outlook.live.com',
      'outlook.office.com',
      'outlook.office365.com',
    ],
  },
  needsVision: true,
  throttleMs: 90_000,
  outputCollection: COLLECTION,
  systemPrompt: SYSTEM_PROMPT,
  widget: {
    id: HOOK_ID,
    title: 'Follow-ups',
    builtin: 'followups',
    defaultCollection: COLLECTION,
    placement: 'dashboard-main',
    description: 'Open replies, decisions, and scheduling items from your inbox and chats.',
  },
};

class FollowupsHookPlugin implements IHookPlugin {
  readonly name = HOOK_ID;

  definitions(): CaptureHookDefinition[] {
    return [DEFINITION];
  }

  async handle(input: CaptureHookInput, ctx: CaptureHookContext): Promise<void> {
    const extracted = extractFollowupsFromText(input);
    if (extracted.length > 0) {
      await storeFollowups(input, ctx, extracted);
      return;
    }
    if (ctx.config.catchup === true) {
      ctx.skip?.('catch-up found no obvious action items in captured text');
      return;
    }

    const ready = await ctx.model.isAvailable().catch(() => false);
    if (!ready) {
      ctx.skip?.('model unavailable');
      return;
    }

    const prompt = buildPrompt(input);
    const supportsVision = ctx.model.getModelInfo().supportsVision;
    const useVision =
      input.kind === 'screen' && supportsVision && !!input.imageBytes;
    let raw = '';
    try {
      if (useVision) {
        raw = await ctx.model.completeWithVision(
          prompt,
          [(input as CaptureHookScreenInput).imageBytes!],
          {
            systemPrompt: SYSTEM_PROMPT,
            temperature: 0.15,
            maxTokens: 1100,
            responseFormat: 'json',
          },
        );
      } else {
        raw = await ctx.model.complete(prompt, {
          systemPrompt: SYSTEM_PROMPT,
          temperature: 0.15,
          maxTokens: 1100,
          responseFormat: 'json',
        });
      }
    } catch (err) {
      ctx.logger.warn('followups hook llm failed', { err: String(err) });
      throw err instanceof Error ? err : new Error(String(err));
    }

    ctx.logger.info('followups hook llm responded', {
      useVision,
      supportsVision,
      kind: input.kind,
      bytes: raw.length,
    });

    const parsed = safeParseObject(raw);
    if (!parsed) {
      const sample = raw.trim().slice(0, 120).replace(/\s+/g, ' ');
      ctx.skip?.(`LLM response was not parseable JSON (got: ${sample || 'empty'}…)`);
      return;
    }
    const followups = Array.isArray((parsed as any).followups)
      ? (parsed as any).followups
      : [];
    if (followups.length === 0) {
      ctx.skip?.(
        useVision
          ? 'LLM returned 0 follow-ups (nothing actionable detected)'
          : input.kind === 'audio'
            ? 'LLM returned 0 follow-ups (from transcript)'
            : 'LLM returned 0 follow-ups (vision unavailable; only OCR text was sent)',
      );
      return;
    }

    await storeFollowups(input, ctx, followups);
  }
}

async function storeFollowups(
  input: CaptureHookInput,
  ctx: CaptureHookContext,
  followups: unknown[],
): Promise<void> {
  const contentHash = createHash('sha1').update(JSON.stringify(followups)).digest('hex');
  const recordId = stableId(input, contentHash);
  const source =
    input.kind === 'screen'
      ? { app: input.app, url: input.url, title: input.windowTitle }
      : { app: input.app, transcript_chars: input.transcript.length };

  await ctx.storage.put({
    collection: COLLECTION,
    id: recordId,
    data: { followups, source, captured_at: input.event.timestamp },
    evidenceEventIds: [input.event.id, ...(input.frameId ? [input.frameId] : [])],
    contentHash,
  });
}

function buildPrompt(input: CaptureHookInput): string {
  if (input.kind === 'screen') {
    const lines = [
      `App: ${input.app}`,
      input.windowTitle ? `Window: ${input.windowTitle}` : '',
      input.url ? `URL: ${input.url}` : '',
      input.ocrText
        ? `OCR/Accessibility text:\n${truncate(input.ocrText, 3500)}`
        : 'OCR text empty.',
      'Return JSON only.',
    ].filter(Boolean);
    return lines.join('\n');
  }
  return [
    `App: ${input.app}`,
    input.startedAt ? `Started: ${input.startedAt}` : '',
    input.durationMs ? `Duration ms: ${input.durationMs}` : '',
    input.transcript ? `Transcript:\n${truncate(input.transcript, 3500)}` : 'Transcript empty.',
    'Return JSON only.',
  ]
    .filter(Boolean)
    .join('\n');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3).trimEnd()}...`;
}

function safeParseObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(first, last + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stableId(input: CaptureHookInput, contentHash: string): string {
  if (input.kind === 'screen') {
    const surface = `${input.app}|${input.windowTitle}|${input.url ?? ''}|${contentHash.slice(0, 10)}`;
    return `flw_${createHash('sha1').update(surface).digest('hex').slice(0, 16)}`;
  }
  return `flw_${createHash('sha1')
    .update(`${input.app}|${input.event.id}|${contentHash.slice(0, 10)}`)
    .digest('hex')
    .slice(0, 16)}`;
}

type ExtractedFollowup = {
  title: string;
  body: string;
  urgency: 'high' | 'medium' | 'low';
  category: 'reply' | 'send' | 'decide' | 'schedule' | 'task';
};

const ACTION_PATTERN =
  /\b(action required|requires? action|payment problem|please (?:send|review|confirm|approve|reply|respond|fix|check|schedule)|can you|could you|would you|need (?:you|to)|needs your|follow up|let me know|deadline|due|approve|approval required|review required)\b/i;

const UI_LINE_PATTERN =
  /^(reply|message|also send|show more|view message|thread|inbox|sent|drafts|search|today|yesterday|home|activity|files|later|more)$/i;

function extractFollowupsFromText(input: CaptureHookInput): ExtractedFollowup[] {
  const text = input.kind === 'screen' ? input.ocrText : input.transcript;
  if (!text.trim()) return [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => normalizeLine(line))
    .filter((line) => line && !UI_LINE_PATTERN.test(line));
  const out: ExtractedFollowup[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!ACTION_PATTERN.test(line)) continue;

    const context = [lines[i - 1], line, lines[i + 1], lines[i + 2]]
      .filter((part): part is string => !!part && !UI_LINE_PATTERN.test(part))
      .join(' ');
    const title = titleForFollowup(line, lines[i - 1]);
    if (!title) continue;
    const key = `${title}|${context}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      body: truncate(context || line, 260),
      urgency: urgencyFor(line),
      category: categoryFor(line),
    });
    if (out.length >= 8) break;
  }

  return out;
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[•›~]+/g, '').trim();
}

function titleForFollowup(line: string, previous: string | undefined): string {
  const source =
    /^(action required|requires? action)$/i.test(line.trim()) && previous
      ? `${line}: ${previous}`
      : line;
  return truncate(source.replace(/^[→\-\s]+/, '').trim(), 90);
}

function urgencyFor(line: string): ExtractedFollowup['urgency'] {
  return /\b(action required|payment problem|deadline|due|approval required)\b/i.test(line)
    ? 'high'
    : /\b(please|need|review|required|approve)\b/i.test(line)
      ? 'medium'
      : 'low';
}

function categoryFor(line: string): ExtractedFollowup['category'] {
  if (/\b(schedule|book|calendar)\b/i.test(line)) return 'schedule';
  if (/\b(reply|respond|let me know)\b/i.test(line)) return 'reply';
  if (/\b(approve|approval|decide)\b/i.test(line)) return 'decide';
  if (/\b(send)\b/i.test(line)) return 'send';
  return 'task';
}

const factory: PluginFactory<IHookPlugin> = () => new FollowupsHookPlugin();
export default factory;
export { FollowupsHookPlugin };
