import type { DateAnchor } from './types.js';

/**
 * Resolve a date anchor for a chat turn. Looks for explicit phrases in
 * the user's message ("today", "yesterday", "last Monday") and falls
 * back to today in the runtime's local timezone. The runtime process
 * runs alongside the user — its system clock is the truth.
 *
 * Storage queries take ISO-UTC bounds, so we also compute the
 * UTC instants that bracket the chosen local-date day.
 */
export function resolveDateAnchor(message: string, now: Date = new Date()): DateAnchor {
  const lower = message.toLowerCase();
  if (/\byesterday\b/.test(lower)) return anchorFor(addDays(now, -1), 'yesterday');
  if (/\btoday\b|\bthis morning\b|\btonight\b/.test(lower)) return anchorFor(now, 'today');
  if (/\btomorrow\b/.test(lower)) return anchorFor(addDays(now, 1), 'tomorrow');

  // "last <weekday>" — pick the most recent past instance of that weekday.
  const weekdayMatch = lower.match(
    /\blast\s+(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday)?\b/,
  );
  if (weekdayMatch) {
    const target = parseWeekday(weekdayMatch[1]!);
    if (target >= 0) {
      const today = now.getDay();
      const delta = ((today - target + 7) % 7) || 7;
      return anchorFor(addDays(now, -delta), formatLabel(addDays(now, -delta)));
    }
  }

  // ISO date in the message ("2026-05-05").
  const isoMatch = message.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) {
    const [y, m, d] = isoMatch[1]!.split('-').map(Number);
    if (y && m && d) {
      const date = new Date(y, m - 1, d);
      return anchorFor(date, formatLabel(date));
    }
  }

  return anchorFor(now, 'today');
}

function anchorFor(date: Date, label: string): DateAnchor {
  const day = formatLocalYmd(date);
  // Local-day bounds, converted to ISO UTC so storage filters work.
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return {
    day,
    label,
    fromIso: start.toISOString(),
    toIso: end.toISOString(),
  };
}

function formatLocalYmd(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function addDays(date: Date, delta: number): Date {
  const next = new Date(date);
  next.setDate(date.getDate() + delta);
  return next;
}

function parseWeekday(token: string): number {
  const map: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    tues: 2,
    wed: 3,
    thu: 4,
    thur: 4,
    thurs: 4,
    fri: 5,
    sat: 6,
  };
  return map[token] ?? -1;
}
