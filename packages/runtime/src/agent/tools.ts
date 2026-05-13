import fs from 'node:fs/promises';
import path from 'node:path';
import type { ActivitySession, EntityKind, EntityRecord, Frame, IIndexStrategy, IStorage } from '@beside/interfaces';
import type { CalendarCheckResult, CompactFrame, CompactSession, DayActivitySummaryResult, DateAnchor, EntityListResult, EntitySummaryResult, FrameContextResult, IndexSearchResultBlock, OpenLoopsResult, SearchResultBlock, SessionDetailResult } from './types.js';
import { dedupeCalendarFrames, dedupeOpenLoopFrames, dedupeSearchFrames, isGarbled, stripSidebarNoise } from './noise.js';

const NOISE_APPS = new Set(['audio', 'loginwindow']);
const NOISE_ENTITY_PATHS = new Set(['apps/audio', 'apps/loginwindow']);

export function compactFrame(frame: Frame, excerptChars = 280): CompactFrame {
  const excerpt = collapseText(stripSidebarNoise(frame.text), excerptChars);
  return { id: frame.id, timestamp: frame.timestamp, app: frame.app, window_title: frame.window_title, url: frame.url, excerpt, entity_path: frame.entity_path, asset_path: frame.asset_path, garbled: isGarbled(excerpt) };
}

export function compactSession(session: ActivitySession): CompactSession {
  return { id: session.id, started_at: session.started_at, ended_at: session.ended_at, active_min: Math.round(session.active_ms / 60000), primary_entity: session.primary_entity_path, primary_app: session.primary_app, frames: session.frame_count };
}

export interface ToolDeps { storage: IStorage; strategy?: IIndexStrategy; }

export async function getDayActivitySummary(deps: ToolDeps, anchor: DateAnchor): Promise<DayActivitySummaryResult> {
  const sessions = filterMeaningfulSessions(await deps.storage.listSessions({ day: anchor.day, limit: 60, order: 'chronological' }));
  const appBuckets = new Map<string, { minutes: number; frames: number }>(), entityBuckets = new Map<string, { minutes: number; frames: number }>();
  let totalActiveMs = 0, totalFrames = 0;

  for (const s of sessions) {
    totalActiveMs += s.active_ms; totalFrames += s.frame_count;
    if (s.primary_app && !NOISE_APPS.has(s.primary_app.toLowerCase())) { const b = appBuckets.get(s.primary_app) ?? { minutes: 0, frames: 0 }; b.minutes += Math.round(s.active_ms / 60000); b.frames += s.frame_count; appBuckets.set(s.primary_app, b); }
    if (s.primary_entity_path && !NOISE_ENTITY_PATHS.has(s.primary_entity_path)) { const b = entityBuckets.get(s.primary_entity_path) ?? { minutes: 0, frames: 0 }; b.minutes += Math.round(s.active_ms / 60000); b.frames += s.frame_count; entityBuckets.set(s.primary_entity_path, b); }
  }

  const dayFrames = await safeSearchFrames(deps.storage, { from: anchor.fromIso, to: anchor.toIso, limit: 200 });
  return { day: anchor.day, totals: { active_min: Math.round(totalActiveMs / 60000), sessions: sessions.length, frames: totalFrames }, top_apps: rankBuckets(appBuckets).slice(0, 5).map(([app, v]) => ({ app, ...v })), top_entities: rankBuckets(entityBuckets).slice(0, 5).map(([path, v]) => ({ path, ...v })), sessions: sessions.slice(0, 12).map(compactSession), calendar_candidates: dedupeCalendarFrames(pickCalendarCandidates(dayFrames, 12).map((f) => compactFrame(f, 480))).slice(0, 6), open_loop_candidates: dedupeOpenLoopFrames(pickOpenLoopCandidates(dayFrames, 12).map((f) => compactFrame(f, 480))).slice(0, 6) };
}

export async function getCalendarCandidates(deps: ToolDeps, anchor: DateAnchor): Promise<CalendarCheckResult> {
  return { day: anchor.day, candidates: dedupeCalendarFrames(pickCalendarCandidates(await safeSearchFrames(deps.storage, { from: anchor.fromIso, to: anchor.toIso, limit: 200 }), 20).map((f) => compactFrame(f, 480))).slice(0, 10) };
}

export async function getOpenLoopCandidates(deps: ToolDeps, anchor: DateAnchor): Promise<OpenLoopsResult> {
  return { day: anchor.day, candidates: dedupeOpenLoopFrames(pickOpenLoopCandidates(await safeSearchFrames(deps.storage, { from: anchor.fromIso, to: anchor.toIso, limit: 250 }), 20).map((f) => compactFrame(f, 480))).slice(0, 10) };
}

export async function searchFramesTool(deps: ToolDeps, args: { query: string; day?: string; from?: string; to?: string; limit?: number }): Promise<SearchResultBlock> {
  const limit = Math.max(1, Math.min(args.limit ?? 12, 30)), query = args.query.trim();
  if (!query) return { query, matches: [] };
  const frames = await safeSearchFrames(deps.storage, { text: query, day: args.day, from: args.from, to: args.to, limit: Math.min(limit * 2, 60) });
  return { query, matches: dedupeSearchFrames(frames.map((f) => compactFrame(f, 200))).slice(0, limit) };
}

export async function searchPersonFramesTool(deps: ToolDeps, args: { query: string; limit?: number }): Promise<SearchResultBlock> {
  const limit = Math.max(1, Math.min(args.limit ?? 10, 30)), query = args.query.trim();
  if (!query) return { query, matches: [] };

  const byId = new Map<string, Frame>();
  for (const variant of personSearchVariants(query)) {
    for (const frame of await safeSearchFrames(deps.storage, { text: variant, limit: limit * 8 })) byId.set(frame.id, frame);
  }

  const cleaned = dedupePersonFrames([...byId.values()].map((frame) => ({ frame, score: scorePersonFrame(frame, query) })).filter((m) => m.score >= 5).sort((a, b) => b.score - a.score || b.frame.timestamp.localeCompare(a.frame.timestamp)).map((m) => m.frame), query).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
  return { query, matches: cleaned.map((f) => ({ ...compactFrame(f, 520), excerpt: f.text ? collapseText(relevantTextWindow(f.text, query, 1200), 900) : null })) };
}

export async function searchIndexPagesTool(deps: ToolDeps, args: { query: string; limit?: number }): Promise<IndexSearchResultBlock> {
  const query = args.query.trim(), limit = Math.max(1, Math.min(args.limit ?? 5, 12));
  if (!query || !deps.strategy) return { query, matches: [] };

  return { query, matches: (await safeListIndexPages(deps.strategy)).map((page) => ({ page, score: scorePage(page.path, page.content, query) })).filter((m) => m.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(({ page, score }) => ({ path: page.path, title: page.content.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(page.path, '.md'), excerpt: extractRelevantTextExcerpt(page.content, query, 700), lastUpdated: page.lastUpdated, sourceEventCount: page.sourceEventIds.length, score })) };
}

export async function getFrameContextTool(deps: ToolDeps, args: { frameId: string; before?: number; after?: number }): Promise<FrameContextResult | null> {
  const ctx = await deps.storage.getFrameContext(args.frameId, Math.max(0, Math.min(args.before ?? 3, 8)), Math.max(0, Math.min(args.after ?? 3, 8)));
  if (!ctx) return null;
  return { frameId: args.frameId, before: ctx.before.map((f) => compactFrame(f, 200)), anchor: compactFrame(ctx.anchor, 320), after: ctx.after.map((f) => compactFrame(f, 200)) };
}

export async function getActivitySessionTool(deps: ToolDeps, args: { id: string }): Promise<SessionDetailResult | null> {
  const session = await deps.storage.getSession(args.id);
  if (!session) return null;
  return { session: compactSession(session), frames: (await deps.storage.getSessionFrames(args.id)).slice(0, 30).map((f) => compactFrame(f, 200)) };
}

export async function listEntitiesTool(deps: ToolDeps, args: { query?: string; kind?: EntityKind; limit?: number }): Promise<EntityListResult> {
  const limit = Math.max(1, Math.min(args.limit ?? 10, 25));
  const entities = args.query?.trim() ? await safeSearchEntities(deps.storage, { text: args.query.trim(), kind: args.kind, limit }) : await safeListEntities(deps.storage, { kind: args.kind, limit });
  return { query: args.query ?? '', entities: entities.map((e) => ({ path: e.path, title: e.title, kind: e.kind, lastSeen: e.lastSeen, frames: e.frameCount })) };
}

export async function getEntitySummaryTool(deps: ToolDeps, args: { path: string; sinceIso?: string; untilIso?: string }): Promise<EntitySummaryResult | null> {
  const entity = await deps.storage.getEntity(args.path);
  if (!entity) return null;
  return { path: entity.path, title: entity.title, kind: entity.kind, totalFocusedMin: Math.round(entity.totalFocusedMs / 60000), frameCount: entity.frameCount, recentFrames: (await safeGetEntityFrames(deps.storage, args.path, 10)).map((f) => compactFrame(f, 200)), neighbours: (await safeListEntityNeighbours(deps.storage, args.path, 8)).map((n) => ({ path: n.path, title: n.title, kind: n.kind, sharedSessions: n.sharedSessions })), timeline: (await safeGetEntityTimeline(deps.storage, args.path, { granularity: 'day', from: args.sinceIso, to: args.untilIso, limit: 14 })).map((b) => ({ bucket: b.bucket, minutes: Math.round(b.focusedMs / 60000), frames: b.frames })) };
}

function filterMeaningfulSessions(sessions: ActivitySession[]): ActivitySession[] {
  const kept: ActivitySession[] = [];
  for (const session of sessions) {
    if ((session.active_ms / 60000) === 0 && session.frame_count <= 2) continue;
    if (NOISE_APPS.has((session.primary_app ?? '').toLowerCase()) || (session.primary_entity_path && NOISE_ENTITY_PATHS.has(session.primary_entity_path))) continue;
    if ((session.active_ms / 60000) < 1) continue;
    const last = kept[kept.length - 1];
    if (last?.primary_entity_path && last.primary_entity_path === session.primary_entity_path && Math.max(0, (Date.parse(session.started_at) - Date.parse(last.ended_at)) / 60000) < 5) {
      last.ended_at = session.ended_at; last.active_ms += session.active_ms; last.duration_ms += session.duration_ms; last.frame_count += session.frame_count; continue;
    }
    kept.push({ ...session });
  }
  return kept;
}

function pickCalendarCandidates(frames: Frame[], limit: number): Frame[] {
  return frames.map((frame) => ({ score: scoreCalendarFrame(frame), frame })).filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.frame);
}

function pickOpenLoopCandidates(frames: Frame[], limit: number): Frame[] {
  return frames.map((frame) => ({ score: scoreOpenLoopFrame(frame), frame })).filter((s) => s.score > 0).sort((a, b) => b.score === a.score ? b.frame.timestamp.localeCompare(a.frame.timestamp) : b.score - a.score).slice(0, limit).map((s) => s.frame);
}

function scoreCalendarFrame(frame: Frame): number {
  const app = (frame.app ?? '').toLowerCase(), url = (frame.url ?? '').toLowerCase(), title = (frame.window_title ?? '').toLowerCase(), text = (frame.text ?? '').toLowerCase();
  const appHit = ['calendar', 'fantastical', 'busycal', 'outlook', 'cal.com'].some((h) => app.includes(h)), urlHit = ['calendar.google.com', 'outlook.live.com', 'outlook.office', 'cal.com', 'fantastical.app'].some((h) => url.includes(h)), titleHit = ['calendar', 'meeting', 'schedule', 'event'].some((h) => title.includes(h));
  if (!appHit && !urlHit && !titleHit) return 0;
  return (appHit ? 4 : 0) + (urlHit ? 4 : 0) + (titleHit ? 2 : 0) + (/\b\d{1,2}:\d{2}\s?(am|pm)?\b/.test(text) ? 1 : 0);
}

function scoreOpenLoopFrame(frame: Frame): number {
  const app = (frame.app ?? '').toLowerCase(), url = (frame.url ?? '').toLowerCase(), text = (frame.text ?? '').toLowerCase();
  if (!/(\bunread\b|\bmention(s|ed)?\b|@you\b|\breply needed\b|\bplease (reply|respond|review)\b|\brespond\b|\bwaiting on (you|your)\b|\bneeds (your )?(review|response|reply|answer)\b|\bfollow.?up\b|\breview requested\b|\brequested changes\b|\bopen pull request\b|\bopen pr\b|\bopen issue\b|\bawaiting (review|response)\b|\bneeds attention\b)/.test(text)) return 0;
  if (looksLikeUserRepliedLast(frame.text ?? '')) return 0;
  if (/^[\d,]\s*$/.test(text)) return 0;
  return (['slack', 'discord', 'telegram', 'imessage', 'messages', 'teams', 'whatsapp'].some((h) => app.includes(h)) ? 2 : 0) + (['app.slack.com', 'slack.com', 'discord.com', 'web.telegram.org', 'teams.microsoft.com'].some((h) => url.includes(h)) ? 2 : 0) + (['github.com', 'gitlab.com', 'bitbucket.org'].some((h) => url.includes(h)) ? 2 : 0) + 3;
}

function looksLikeUserRepliedLast(rawText: string): boolean {
  for (const line of rawText.toLowerCase().split(/\n+/).map((l) => l.trim()).filter(Boolean).reverse()) {
    const m = line.match(/^([a-z][a-z0-9._-]{1,30})\s+\d{1,2}:\d{2}\s?(am|pm)?$/);
    if (m && ['alex', 'me', 'you'].includes(m[1]!)) return true;
  }
  return false;
}

function dedupePersonFrames(frames: Frame[], query: string): Frame[] {
  const byKey = new Map<string, Frame>();
  for (const frame of frames) {
    const key = `${(frame.url ? (new URL(frame.url).host).toLowerCase() : (frame.window_title || frame.app || 'unknown').toLowerCase())}::${Array.from(collapseText(frame.text, 2000) ?? '').reduce((h, c) => Math.imul(31, h) + c.charCodeAt(0) | 0, 5381).toString(36)}`;
    if (!byKey.has(key) || frame.timestamp > byKey.get(key)!.timestamp) byKey.set(key, frame);
  }
  return [...byKey.values()];
}

function personSearchVariants(query: string): string[] {
  const cleaned = query.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim(), parts = cleaned.split(/\s+/).filter(Boolean);
  return [...new Set([query, cleaned, parts[0], parts.length >= 2 ? `${parts[0]} ${parts[1]}` : null, parts.length >= 2 ? `${parts[0]}.${parts[1]}` : null].filter(Boolean) as string[])];
}

function scorePersonFrame(frame: Frame, query: string): number {
  if (/\b(members?|member list|people in this channel|channel details|profile|about)\b/.test((frame.window_title ?? '').toLowerCase()) || (/\b(add people|view all members|channel members|people in this conversation|member profile|user profile)\b/.test((frame.text ?? '').toLowerCase()) && !/\b(today|yesterday|\d+\s*(m|h|d)\s*ago|am|pm)\b/.test((frame.text ?? '').toLowerCase()))) return -20;
  const t = `${(frame.text ?? '').toLowerCase()} ${(frame.window_title ?? '').toLowerCase()} ${(frame.url ?? '').toLowerCase()} ${(frame.entity_path ?? '').toLowerCase()}`;
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_-]+/g) ?? [])].filter((term) => term.length > 2);
  const termHits = terms.filter((term) => t.includes(term)).length;
  if (termHits === 0) return -10;
  const comms = /\b(slack|discord|teams|messages|imessage|whatsapp|mail)\b/.test((frame.app ?? '').toLowerCase()) || /\bapp\.slack\.com|slack\.com|teams\.microsoft\.com|discord\.com|web\.whatsapp\.com\b/.test((frame.url ?? '').toLowerCase()) || /\((channel|private channel|dm|direct message)\)/i.test(frame.window_title ?? '') || (frame.window_title ?? '').toLowerCase().includes('thread');
  const msgLike = /\b(today|yesterday|\d+\s*(m|h|d)\s*ago)\b/.test((frame.text ?? '').toLowerCase()) || /\b\d{1,2}:\d{2}\s?(am|pm)\b/.test((frame.text ?? '').toLowerCase()) || /\breplied to|thread|message|sent|posted\b/.test((frame.text ?? '').toLowerCase());
  const attr = terms.length > 0 && [new RegExp(`\\b${terms[0].replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}${terms[1] ? `[._\\s-]+${terms[1].replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}` : ''}\\b.{0,80}\\b(today|yesterday|\\d+\\s*(m|h|d)\\s*ago|am|pm)\\b`, 'i'), new RegExp(`\\b(today|yesterday|\\d+\\s*(m|h|d)\\s*ago|am|pm)\\b.{0,80}\\b${terms[0].replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i')].some((pattern) => pattern.test((frame.text ?? '').toLowerCase()));
  if (!comms) return -10;
  if ((/\b(registrations?|domains?|facebook|grok|cloud|birthday|search results?|sign in|log in|home)\b/.test((frame.window_title ?? '').toLowerCase()) || /\b(registrations?|domains?|facebook|grok|cloud x|birthday|search facebook)\b/.test((frame.text ?? '').toLowerCase())) && !attr) return -12;
  if (!msgLike && !attr) return -8;
  return termHits * 2 + (comms ? 6 : 0) + (/\b(slack|discord|teams|messages|imessage|whatsapp|mail)\b/.test((frame.app ?? '').toLowerCase()) ? 2 : 0) + (/\bapp\.slack\.com|slack\.com|teams\.microsoft\.com|discord\.com|web\.whatsapp\.com\b/.test((frame.url ?? '').toLowerCase()) ? 4 : 0) + ((frame.entity_path ?? '').toLowerCase().startsWith('channels/') || (frame.entity_path ?? '').toLowerCase().startsWith('contacts/') ? 3 : 0) + (msgLike ? 4 : 0) + (attr ? 5 : 0) + (/\b(i will|i'll|doing today|today|eow|end of week|todo|blocked|not blocking|follow up|clean(ing)? up)\b/.test((frame.text ?? '').toLowerCase()) ? 2 : 0) - ((!(comms) && ((frame.app ?? '').toLowerCase().includes('firefox') || (frame.app ?? '').toLowerCase().includes('chrome') || (frame.app ?? '').toLowerCase().includes('safari') || /^https?:\/\//.test((frame.url ?? '').toLowerCase()))) ? 8 : 0) - ((/\b(registrations?|domains?|facebook|grok|cloud|birthday|search results?|sign in|log in|home)\b/.test((frame.window_title ?? '').toLowerCase()) || /\b(registrations?|domains?|facebook|grok|cloud x|birthday|search facebook)\b/.test((frame.text ?? '').toLowerCase())) ? 4 : 0);
}

function relevantTextWindow(text: string, query: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lower = text.toLowerCase(), terms = [...new Set(query.toLowerCase().match(/[a-z0-9_-]+/g) ?? [])];
  const idx = terms.map((term) => lower.indexOf(term)).filter((n) => n >= 0).sort((a, b) => a - b)[0];
  if (idx == null) return text.slice(0, maxChars);
  const start = Math.max(0, Math.min(text.length - maxChars, idx - Math.floor(maxChars / 2)));
  return text.slice(start, start + maxChars);
}

function rankBuckets(map: Map<string, { minutes: number; frames: number }>): Array<[string, { minutes: number; frames: number }]> { return [...map.entries()].sort((a, b) => b[1].minutes - a[1].minutes || b[1].frames - a[1].frames); }
function collapseText(text: string | null, max: number): string | null { if (!text) return null; const collapsed = text.replace(/\s+/g, ' ').trim(); return !collapsed ? null : collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed; }

async function safeSearchFrames(storage: IStorage, query: Parameters<IStorage['searchFrames']>[0]): Promise<Frame[]> { try { return await storage.searchFrames(query); } catch { return []; } }
async function safeListEntities(storage: IStorage, query: Parameters<IStorage['listEntities']>[0]): Promise<EntityRecord[]> { try { return await storage.listEntities(query); } catch { return []; } }
async function safeSearchEntities(storage: IStorage, query: Parameters<IStorage['searchEntities']>[0]): Promise<EntityRecord[]> { try { return await storage.searchEntities(query); } catch { return []; } }
async function safeGetEntityFrames(storage: IStorage, path: string, limit: number): Promise<Frame[]> { try { return await storage.getEntityFrames(path, limit); } catch { return []; } }
async function safeListEntityNeighbours(storage: IStorage, path: string, limit: number): Promise<Awaited<ReturnType<IStorage['listEntityCoOccurrences']>>> { try { return await storage.listEntityCoOccurrences(path, limit); } catch { return []; } }
async function safeGetEntityTimeline(storage: IStorage, path: string, query: Parameters<IStorage['getEntityTimeline']>[1]): Promise<Awaited<ReturnType<IStorage['getEntityTimeline']>>> { try { return await storage.getEntityTimeline(path, query); } catch { return []; } }
async function safeListIndexPages(strategy: IIndexStrategy): Promise<Array<{ path: string; content: string; lastUpdated: string; sourceEventIds: string[] }>> {
  try {
    const root = (await strategy.getState()).rootPath, out: Array<{ path: string; content: string; lastUpdated: string; sourceEventIds: string[] }> = [];
    const walk = async (relDir: string): Promise<void> => {
      try {
        for (const entry of await fs.readdir(path.join(root, relDir), { withFileTypes: true })) {
          const rel = path.join(relDir, entry.name).replace(/\\/g, '/');
          if (entry.isDirectory()) { await walk(rel); continue; }
          if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'index.md' || entry.name === 'log.md') continue;
          const page = await strategy.readPage(rel); if (page) out.push({ path: rel, content: page.content, lastUpdated: page.lastUpdated, sourceEventIds: page.sourceEventIds });
        }
      } catch {}
    };
    await walk('.'); return out;
  } catch { return []; }
}

function scorePage(pagePath: string, content: string, query: string): number {
  if (!content) return 0;
  const ql = query.trim().toLowerCase(), lower = content.toLowerCase(), pl = pagePath.toLowerCase();
  let score = ql ? countOccurrences(pl, ql) * 10 + countOccurrences(lower, ql) * 6 : 0;
  for (const term of [...new Set(query.toLowerCase().match(/[a-z0-9_-]+/g) ?? [])].filter((term) => term.length > 2)) score += countOccurrences(pl, term) * 4 + countOccurrences(lower, term);
  return score;
}

function extractRelevantTextExcerpt(text: string, query: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lower = text.toLowerCase(), exact = query.trim().toLowerCase();
  let bestIndex = exact ? lower.indexOf(exact) : -1;
  if (bestIndex === -1) {
    let bestScore = 0;
    for (const term of [...new Set(query.toLowerCase().match(/[a-z0-9_-]+/g) ?? [])]) {
      let from = 0;
      for (let i = 0; i < 100; i++) {
        const idx = lower.indexOf(term, from); if (idx === -1) break;
        const w = lower.slice(Math.max(0, Math.min(lower.length - maxChars, idx - Math.floor(maxChars / 2))), Math.max(0, Math.min(lower.length - maxChars, idx - Math.floor(maxChars / 2))) + maxChars);
        const score = [...new Set(query.toLowerCase().match(/[a-z0-9_-]+/g) ?? [])].reduce((sum, candidate) => sum + (w.includes(candidate) ? 1 : 0), 0);
        if (score > bestScore) { bestScore = score; bestIndex = idx; }
        from = idx + term.length;
      }
    }
  }
  if (bestIndex === -1) return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
  const start = Math.max(0, Math.min(text.length - maxChars, bestIndex - Math.floor(maxChars / 2))), end = Math.min(text.length, start + maxChars);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

function countOccurrences(lowerText: string, lowerNeedle: string): number {
  if (!lowerNeedle) return 0;
  let count = 0, from = 0;
  for (let i = 0; i < 100; i++) { const idx = lowerText.indexOf(lowerNeedle, from); if (idx === -1) break; count += 1; from = idx + lowerNeedle.length; }
  return count;
}
