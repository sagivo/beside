import type { Frame } from '@beside/interfaces';
import type { CalendarSurface } from '@beside/core';

export interface CalendarExtractionCandidate {
  title?: string;
  kind?: string;
  starts_at?: string | null;
  ends_at?: string | null;
  attendees?: unknown;
  context?: string;
}

export interface CalendarExtractionPayload {
  events: CalendarExtractionCandidate[];
}

export interface CalendarParseFrame {
  id: string;
  window_title: string | null;
  text: string | null;
}

export interface CalendarParseInput {
  captureDay: string;
  surface: CalendarSurface | null | undefined;
  app: string;
  frames: CalendarParseFrame[];
  maxChars: number;
  vision: boolean;
}

export function buildCalendarExtractionPrompt(input: CalendarParseInput): string {
  const surfaceLabel = input.surface?.label ?? input.app;
  const header = [
    `Day: ${input.captureDay}`,
    `Calendar: ${surfaceLabel}`,
    input.surface?.sourceKey ? `Source key: ${input.surface.sourceKey}` : '',
    '',
    `These captures come from the user's calendar surface (${surfaceLabel}). ${input.vision ? 'Use attached screenshots.' : 'OCR/accessibility text is primary.'}`,
    `TARGET DAY: ${input.captureDay}. Output ONLY events whose date is ${input.captureDay}. Skip events from other days/columns.`,
    '',
  ].filter(Boolean).join('\n');

  let used = header.length;
  const blocks: string[] = [];
  for (const frame of input.frames) {
    const block = `\n[FRAME ${frame.id}] "${frame.window_title ?? ''}"\n${(frame.text ?? '').trim().slice(0, 2200)}\n`;
    if (used + block.length > input.maxChars) break;
    blocks.push(block);
    used += block.length;
  }
  return `${header}${blocks.join('')}\n\nExtract every meaningful calendar event.`;
}

export function safeParseCalendarExtraction(raw: string): CalendarExtractionPayload | null {
  const trimmed = raw.trim();
  const cands = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim(),
    trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1),
  ].filter(Boolean) as string[];
  for (const c of cands) {
    try {
      const parsed = JSON.parse(c);
      if (Array.isArray(parsed)) return { events: parsed };
      if (parsed && Array.isArray(parsed.events)) return parsed;
    } catch {}
  }
  return null;
}

export function calendarParseFrames(frames: Frame[]): CalendarParseFrame[] {
  return frames.map((frame) => ({
    id: frame.id,
    window_title: frame.window_title,
    text: frame.text,
  }));
}
