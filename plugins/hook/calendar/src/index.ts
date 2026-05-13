import { createHash } from 'node:crypto';
import type {
  CaptureHookContext,
  CaptureHookDefinition,
  CaptureHookInput,
  CaptureHookScreenInput,
  IHookPlugin,
  PluginFactory,
} from '@beside/interfaces';

const HOOK_ID = 'calendar';
const COLLECTION = 'events';

const SYSTEM_PROMPT = `You read a single calendar screenshot (and any OCR text) and return STRICT JSON:
{
  "events": [
    {
      "title": string,
      "starts_at": string | null,
      "ends_at": string | null,
      "attendees": string[],
      "location": string | null,
      "context": string
    }
  ]
}
Rules:
- Only output meaningful events visible on screen.
- "title" MUST be the EXACT event title as it appears in the calendar, verbatim. Do NOT paraphrase, summarize, translate, shorten, expand, or invent a new title. Copy it character-for-character (including punctuation, casing, emoji). If you cannot read the title reliably, omit the event entirely.
- "starts_at"/"ends_at" should be ISO timestamps when possible, otherwise a human-readable date+time.
- Limit to 25 events.
- Output JSON only, no prose.`;

const DEFINITION: CaptureHookDefinition = {
  id: HOOK_ID,
  title: 'Calendar',
  description:
    'Detects calendar surfaces (Apple Calendar, Google Calendar, Outlook, iCloud, Notion Calendar) and extracts visible events.',
  match: {
    inputKinds: ['screen'],
    apps: ['calendar', 'fantastical', 'notion calendar', 'cron', 'amie', 'busycal', 'outlook'],
    appBundleIds: ['com.apple.ical', 'com.flexibits.fantastical', 'com.busymac.busycal', 'co.amie'],
    urlHosts: [
      'calendar.google.com',
      'outlook.live.com',
      'outlook.office.com',
      'outlook.office365.com',
      'icloud.com',
      'calendar.proton.me',
      'calendar.yahoo.com',
      'app.cal.com',
      'cal.com',
      'cron.com',
      'amie.so',
    ],
  },
  needsVision: true,
  throttleMs: 120_000,
  outputCollection: COLLECTION,
  systemPrompt: SYSTEM_PROMPT,
  widget: {
    id: HOOK_ID,
    title: 'Calendar',
    builtin: 'calendar',
    defaultCollection: COLLECTION,
    placement: 'dashboard-main',
    description: 'Recent calendar events extracted from screen captures.',
  },
};

class CalendarHookPlugin implements IHookPlugin {
  readonly name = HOOK_ID;

  definitions(): CaptureHookDefinition[] {
    return [DEFINITION];
  }

  async handle(input: CaptureHookInput, ctx: CaptureHookContext): Promise<void> {
    if (input.kind !== 'screen') {
      ctx.skip?.(`unsupported input kind: ${input.kind}`);
      return;
    }
    const screen = input as CaptureHookScreenInput;

    const extracted = extractEventsFromText(screen.ocrText);
    if (extracted.length > 0) {
      await storeEvents(screen, ctx, extracted);
      return;
    }
    if (ctx.config.catchup === true) {
      ctx.skip?.('catch-up found no parseable calendar events in captured text');
      return;
    }

    const ready = await ctx.model.isAvailable().catch(() => false);
    if (!ready) {
      ctx.skip?.('model unavailable');
      return;
    }

    const prompt = buildPrompt(screen);
    const supportsVision = ctx.model.getModelInfo().supportsVision;
    const useVision = supportsVision && !!screen.imageBytes;
    let raw = '';
    try {
      if (useVision) {
        raw = await ctx.model.completeWithVision(prompt, [screen.imageBytes!], {
          systemPrompt: SYSTEM_PROMPT,
          temperature: 0.2,
          maxTokens: 1400,
          responseFormat: 'json',
        });
      } else {
        raw = await ctx.model.complete(prompt, {
          systemPrompt: SYSTEM_PROMPT,
          temperature: 0.2,
          maxTokens: 1400,
          responseFormat: 'json',
        });
      }
    } catch (err) {
      ctx.logger.warn('calendar hook llm failed', { err: String(err) });
      throw err instanceof Error ? err : new Error(String(err));
    }

    ctx.logger.info('calendar hook llm responded', {
      useVision,
      supportsVision,
      hadImage: !!screen.imageBytes,
      bytes: raw.length,
    });

    const parsed = safeParseObject(raw);
    if (!parsed) {
      const sample = raw.trim().slice(0, 120).replace(/\s+/g, ' ');
      ctx.skip?.(`LLM response was not parseable JSON (got: ${sample || 'empty'}…)`);
      return;
    }
    const events = Array.isArray((parsed as any).events) ? (parsed as any).events : [];
    if (events.length === 0) {
      ctx.skip?.(
        useVision
          ? 'LLM returned 0 events (no usable items detected in screenshot)'
          : 'LLM returned 0 events (vision unavailable; only OCR text was sent)',
      );
      return;
    }

    await storeEvents(screen, ctx, events);
  }
}

async function storeEvents(
  screen: CaptureHookScreenInput,
  ctx: CaptureHookContext,
  events: unknown[],
): Promise<void> {
  const contentHash = createHash('sha1').update(JSON.stringify(events)).digest('hex');
  const recordId = stableId(screen, contentHash);

  await ctx.storage.put({
    collection: COLLECTION,
    id: recordId,
    data: {
      events,
      source: { app: screen.app, url: screen.url, title: screen.windowTitle },
      captured_at: screen.event.timestamp,
    },
    evidenceEventIds: [screen.event.id, ...(screen.frameId ? [screen.frameId] : [])],
    contentHash,
  });
}

function buildPrompt(screen: CaptureHookScreenInput): string {
  const lines: string[] = [
    `App: ${screen.app}`,
    screen.windowTitle ? `Window: ${screen.windowTitle}` : '',
    screen.url ? `URL: ${screen.url}` : '',
  ].filter(Boolean);
  if (screen.ocrText) lines.push(`OCR/Accessibility text:\n${truncate(screen.ocrText, 4000)}`);
  lines.push('Return JSON only.');
  return lines.join('\n');
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

function stableId(screen: CaptureHookScreenInput, contentHash: string): string {
  const surface = `${screen.app}|${screen.windowTitle}|${screen.url ?? ''}|${contentHash.slice(0, 10)}`;
  return `cal_${createHash('sha1').update(surface).digest('hex').slice(0, 16)}`;
}

interface ExtractedCalendarEvent {
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  attendees: string[];
  location: string | null;
  context: string;
}

function extractEventsFromText(text: string): ExtractedCalendarEvent[] {
  if (!text.trim()) return [];
  const events: ExtractedCalendarEvent[] = [];
  const seen = new Set<string>();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const timed = line.match(/^(.+?)\. Starts on (.+?) at (.+?) and ends at ([^.]+)(?:\..*)?$/i);
    if (timed) {
      pushEvent(events, seen, {
        title: cleanupTitle(timed[1]),
        starts_at: `${timed[2]} ${timed[3]}`,
        ends_at: `${timed[2]} ${timed[4]}`,
        attendees: [],
        location: extractLocation(timed[1]),
        context: line,
      });
      continue;
    }

    const allDay = line.match(/^(.+?)\. (.+?), All-Day$/i);
    if (allDay) {
      pushEvent(events, seen, {
        title: cleanupTitle(allDay[1]),
        starts_at: `${allDay[2]} all day`,
        ends_at: null,
        attendees: [],
        location: extractLocation(allDay[1]),
        context: line,
      });
    }
  }

  return events.slice(0, 25);
}

function pushEvent(
  events: ExtractedCalendarEvent[],
  seen: Set<string>,
  event: ExtractedCalendarEvent,
): void {
  if (!event.title || isCalendarChrome(event.title)) return;
  const key = `${event.title}|${event.starts_at}|${event.ends_at}`;
  if (seen.has(key)) return;
  seen.add(key);
  events.push(event);
}

function cleanupTitle(value: string): string {
  return value
    .replace(/\s+at\s+[^.]+$/i, '')
    .replace(/\s*,\s*Attendees.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLocation(value: string): string | null {
  const match = value.match(/\bat\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function isCalendarChrome(title: string): boolean {
  const normalized = title.toLowerCase();
  return [
    'calendar',
    'today',
    'day',
    'week',
    'month',
    'year',
    'all day',
  ].includes(normalized);
}

const factory: PluginFactory<IHookPlugin> = () => new CalendarHookPlugin();
export default factory;
export { CalendarHookPlugin };
