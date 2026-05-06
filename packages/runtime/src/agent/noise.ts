import type { CompactFrame } from './types.js';

/**
 * Noise-filter primitives for the chat harness, distilled from §4 of
 * the AI Harness build guide.
 *
 * These are pure functions over already-compact projections; they don't
 * touch IStorage. The pipeline order is the order documented in §4.1:
 *
 *   1. session filter         (lives in tools.ts — operates on raw sessions)
 *   2. calendar dedup         (`dedupeCalendarFrames`)
 *   3. OCR cleanup            (`stripSidebarNoise` + `isGarbled`)
 *   4. open-loop dedup        (`dedupeOpenLoopFrames`)
 *   5. frame dedup            (`dedupeSearchFrames`)
 *
 * The "ref" used for open-loop dedup is the `(app, window_title)` pair,
 * which is the closest stable identifier we have in the compact frame
 * shape — the MCP-side `open_loops.ref` (channel/DM name) is not
 * available from the in-process search path.
 */

// Known sidebar / chrome strings that show up in OCR text on most
// frames in their respective apps. Matching on these is matching UI
// chrome, not user-relevant content. Strip them before showing the
// excerpt to the model and ignore them when scoring "is this frame a
// real signal" decisions.
//
// Add more as you discover them. Lowercase only — comparison is
// case-insensitive.
export const SIDEBAR_NOISE: readonly string[] = [
  'startup domain name ideas',
  'conversion tracking health',
  'cpc in campaign stats',
  // Slack chrome
  'jump to...',
  'unreads',
  'threads',
  'drafts & sent',
  'mentions & reactions',
  'saved items',
  'all dms',
  'channel browser',
  'apps',
  'huddles',
  // Cursor / IDE chrome
  'open editors',
  'no folder opened',
  'problems',
  'output',
  'debug console',
  'terminal',
];

// `cofounderos` used to live in SIDEBAR_NOISE because the app's own
// window chrome shows up in many captures, but it's also a brand name
// the user types into real content (e.g. `cofounderos.ai` in a domain
// shortlist). The substring-strip implementation below would mangle
// those legit mentions ("cofounderos.ai" → ".ai"). We let the
// per-frame `isSelfFrame()` filter at the MCP layer handle UI captures
// and keep the substring filter focused on chrome strings nobody types
// on purpose.

/**
 * Heuristic OCR-garble detector. Returns true when the text is short
 * enough or symbol-heavy enough that quoting it would be
 * embarrassing — call `get_frame_context` to recover real surrounding
 * text instead.
 */
export function isGarbled(text: string | null | undefined): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length < 5) return true;

  // High ratio of non-alphanumeric characters → OCR confusion.
  const nonAlpha = countNonAlpha(trimmed);
  if (nonAlpha / trimmed.length > 0.4) return true;

  // Email/notification artefacts ("+20 e@" style strings).
  if (/\+\s?\d+\s+e@/.test(trimmed)) return true;
  // Run-on number/letter blobs with no spaces.
  if (/^[A-Za-z0-9]{20,}$/.test(trimmed)) return true;

  // Very short fragment that's mostly numbers — typical badge/counter OCR.
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 3 && words.some((w) => /^\d+$/.test(w))) return true;

  return false;
}

function countNonAlpha(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const isDigit = c >= 48 && c <= 57;
    const isUpper = c >= 65 && c <= 90;
    const isLower = c >= 97 && c <= 122;
    const isSpace = c === 32 || c === 9 || c === 10 || c === 13;
    if (!isDigit && !isUpper && !isLower && !isSpace) n += 1;
  }
  return n;
}

/**
 * Remove known sidebar/chrome labels from an OCR excerpt. Conservative:
 * we only kill exact substring matches so we never accidentally rewrite
 * real user content that happens to share a keyword.
 */
export function stripSidebarNoise(text: string | null | undefined): string {
  if (!text) return '';
  let out = text;
  for (const label of SIDEBAR_NOISE) {
    if (!label) continue;
    // Anchor to non-word characters (or string ends) so labels never
    // get stripped from inside user-typed content. e.g. "apps" must
    // not eat the 'apps' inside 'cofounderos.app(s)'. Multi-word
    // labels like "open editors" still match because the boundary is
    // checked against word-char/non-word-char runs, not whitespace.
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(label)}(?=$|[^\\p{L}\\p{N}])`, 'giu');
    out = out.replace(re, '$1 ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Calendar dedup. Group by (clock-time-ish key, title-ish key) and
 * keep the most recent observation. We approximate the "time_label"
 * + "title" pair from compact frame fields:
 *
 *   - clock key  = first HH:MM(am/pm)? hit in excerpt or window title
 *   - title key  = window title with the clock key stripped
 *
 * Frames with no clock signal are always kept (we have no way to
 * collapse them safely).
 */
export function dedupeCalendarFrames(frames: CompactFrame[]): CompactFrame[] {
  const seen = new Map<string, CompactFrame>();
  const passthrough: CompactFrame[] = [];

  for (const frame of frames) {
    const clock = extractClockHint(frame);
    if (!clock) {
      passthrough.push(frame);
      continue;
    }
    const titleKey = (frame.window_title ?? '').toLowerCase().replace(clock, '').replace(/\s+/g, ' ').trim();
    const key = `${clock}::${titleKey}`;
    const existing = seen.get(key);
    if (!existing || frame.timestamp > existing.timestamp) seen.set(key, frame);
  }

  return [...seen.values(), ...passthrough].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function extractClockHint(frame: CompactFrame): string {
  const text = `${frame.window_title ?? ''} ${frame.excerpt ?? ''}`.toLowerCase();
  const match = text.match(/\b(\d{1,2}:\d{2}\s?(?:am|pm)?)\b/);
  return match ? match[1]!.trim() : '';
}

/**
 * Open-loop dedup. Groups by (app, window_title) — that pair is the
 * stable "ref" for in-process candidates (a Slack channel, a GitHub PR
 * page, etc.). Within each group we keep the most recent frame.
 */
export function dedupeOpenLoopFrames(frames: CompactFrame[]): CompactFrame[] {
  const byRef = new Map<string, CompactFrame>();
  for (const frame of frames) {
    const ref = openLoopRef(frame);
    const existing = byRef.get(ref);
    if (!existing || frame.timestamp > existing.timestamp) byRef.set(ref, frame);
  }
  return [...byRef.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function openLoopRef(frame: CompactFrame): string {
  const app = (frame.app ?? '').toLowerCase();
  const window = (frame.window_title ?? '').toLowerCase();
  const url = frame.url ? hostFromUrl(frame.url).toLowerCase() : '';
  return `${app}::${window}::${url}`;
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Generic frame dedup for search results (§4 step 5). Group by
 * (app, window_title) and within each group merge frames whose excerpt
 * is >85% similar AND captured within 120 seconds of each other —
 * those are the user scrolling through the same Slack thread or
 * watching the same diff render twice.
 *
 * Within a merged cluster we keep the frame with the longest excerpt
 * (more signal for the model to ground on).
 */
export function dedupeSearchFrames(frames: CompactFrame[]): CompactFrame[] {
  const groups = new Map<string, CompactFrame[]>();
  for (const frame of frames) {
    const key = `${frame.app ?? ''}::${frame.window_title ?? ''}`;
    const list = groups.get(key);
    if (list) list.push(frame);
    else groups.set(key, [frame]);
  }

  const out: CompactFrame[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const kept: CompactFrame[] = [];
    for (const frame of list) {
      const prev = kept[kept.length - 1];
      if (
        prev &&
        gapSeconds(prev.timestamp, frame.timestamp) < 120 &&
        excerptSimilarity(prev.excerpt, frame.excerpt) > 0.85
      ) {
        // Merge: keep the longer-excerpt frame.
        if ((frame.excerpt?.length ?? 0) > (prev.excerpt?.length ?? 0)) {
          kept[kept.length - 1] = frame;
        }
        continue;
      }
      kept.push(frame);
    }
    out.push(...kept);
  }
  // Preserve original ordering by timestamp descending — search results
  // are usually presented newest first.
  out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return out;
}

function gapSeconds(aIso: string, bIso: string): number {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(b - a) / 1000;
}

/**
 * Cheap n-gram-ish similarity ratio in [0..1]. Tokenises both strings
 * to lowercase word sets, returns Jaccard index. Good enough for the
 * "is this the same Slack thread captured twice" test.
 */
export function excerptSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function tokenSet(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  const out = new Set<string>();
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length >= 3) out.add(tok);
  }
  return out;
}

// ---------------------------------------------------------------------
// Preference signals (§5.5)
// ---------------------------------------------------------------------

const PREFERENCE_WORDS = [
  'top',
  'best',
  'like',
  'liked',
  'love',
  'loved',
  'favorite',
  'favourite',
  'pick',
  'picked',
  'prefer',
  'preferred',
  'choose',
  'chose',
  'winner',
];

const PURCHASE_DOMAINS = [
  'cloudflare',
  'godaddy',
  'namecheap',
  'register.com',
  'squarespace',
  'porkbun',
  'gandi',
  'amazon.',
  'stripe',
  'shopify',
  'apple.com/shop',
  'checkout',
  'cart',
];

/**
 * Score a frame for "did the user express a preference here". Used
 * by `handle_recall_preference`. Higher score = more likely to be a
 * real signal of preference rather than passing reference.
 */
export function preferenceScore(frame: CompactFrame): number {
  let score = 0;
  const text = `${frame.excerpt ?? ''} ${frame.window_title ?? ''} ${frame.url ?? ''}`.toLowerCase();
  for (const word of PREFERENCE_WORDS) {
    if (text.includes(word)) {
      score += 3;
      break; // any single preference word is worth one bump, not many
    }
  }
  if (PURCHASE_DOMAINS.some((d) => text.includes(d))) score += 2;
  // "Top N" lists are extra strong evidence.
  if (/\btop\s+\d+\b/.test(text)) score += 2;
  // Short bullet excerpts that contain digits + a hostname-like token
  // are likely shortlists.
  if (/\b\d+\.\s+\S+/.test(text)) score += 1;
  return score;
}
