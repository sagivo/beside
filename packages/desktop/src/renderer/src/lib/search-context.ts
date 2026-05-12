import type { Frame } from '@/global';

const MAX_CONTEXT_CHARS = 220;
const SNIPPET_RADIUS = 90;

export function buildFrameSearchContext(query: string, frame: Frame): string | null {
  const terms = searchTerms(query);
  const text = normalise(frame.text);
  const title = normalise(frame.window_title);
  const url = normalise(frame.url);

  const textSnippet = snippetAroundTerms(text, terms);
  if (textSnippet) return `Captured text: ${textSnippet}`;

  const titleSnippet = snippetAroundTerms(title, terms);
  if (titleSnippet) return `Window title: ${titleSnippet}`;

  const urlSnippet = snippetAroundTerms(url, terms);
  if (urlSnippet) return `URL: ${urlSnippet}`;

  if (text) return `Captured text: ${truncateContext(text)}`;
  if (title) return `Window title: ${truncateContext(title)}`;
  if (url) return `URL: ${truncateContext(url)}`;
  if (frame.app) return `Captured in ${frame.app}.`;

  return null;
}

function searchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function normalise(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function snippetAroundTerms(text: string, terms: string[]): string | null {
  if (!text || terms.length === 0) return null;

  const lower = text.toLowerCase();
  let bestIndex = -1;
  let bestTerm = '';
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index === -1) continue;
    if (bestIndex === -1 || index < bestIndex) {
      bestIndex = index;
      bestTerm = term;
    }
  }
  if (bestIndex === -1) return null;

  const start = Math.max(0, bestIndex - SNIPPET_RADIUS);
  const end = Math.min(text.length, bestIndex + bestTerm.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function truncateContext(text: string): string {
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  return `${text.slice(0, MAX_CONTEXT_CHARS - 3).trimEnd()}...`;
}
