import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  ActivitySession,
  DayEvent,
  Frame,
  IModelAdapter,
  IndexPage,
  IStorage,
  Logger,
  Meeting,
} from '@beside/interfaces';
import { renderJournalMarkdown } from '@beside/interfaces';
import { isoTimestamp } from '@beside/core';

/**
 * Per-day index pages — the "Journal" of the wiki. Each `days/<YYYY-MM-DD>.md`
 * is rendered by the karpathy strategy alongside entity pages so it inherits
 * the regular incremental update pipeline: evidence-hash skip, parallel
 * fan-out, automatic mirroring through `onPageUpdate`, search + embeddings,
 * archival, etc.
 *
 * Layout:
 *   1. Deterministic baseline produced by `renderJournalMarkdown` from
 *      `@beside/interfaces`. Same renderer the legacy `journal/<day>.md`
 *      used, so existing tooling that scrapes journals keeps working.
 *   2. Optional LLM "Detailed day story" narrative inserted before the
 *      `## Timeline` section. Mirrors the prompt/system shape that the
 *      markdown plugin used to run during `fullSync`, but here it runs
 *      every incremental tick — gated by the evidence-hash short-circuit.
 *
 * The narrative call uses vision when the model supports it (up to 5 thumb
 * frames). For text-only models we render the narrative only when
 * `narrativeTextEnabled` is true (default `true` in karpathy, since the
 * whole point of moving day pages here is continuous journaling — even a
 * text-only narrative is more useful than no narrative).
 */

export interface RenderDayPageDeps {
  storage: IStorage;
  model: IModelAdapter;
  dataDir: string;
  logger: Logger;
  narrativeTextEnabled: boolean;
  narrativeTimeoutMs: number;
}

export interface RenderDayPageResult {
  page: IndexPage;
  reused: boolean;
}

const DAY_PAGE_DIR = 'days';

export function dayPagePath(day: string): string {
  return `${DAY_PAGE_DIR}/${day}.md`;
}

export async function renderDayPage(
  day: string,
  existing: IndexPage | null,
  deps: RenderDayPageDeps,
): Promise<RenderDayPageResult | null> {
  const frames = await deps.storage.getJournal(day).catch(() => [] as Frame[]);
  if (!frames.length) return null;

  const [sessions, meetings, dayEvents] = await Promise.all([
    deps.storage
      .listSessions({ day, order: 'chronological', limit: 500 })
      .catch(() => [] as ActivitySession[]),
    deps.storage
      .listMeetings({ day, order: 'chronological', limit: 100 })
      .catch(() => [] as Meeting[]),
    deps.storage
      .listDayEvents({ day, order: 'chronological', limit: 500 })
      .catch(() => [] as DayEvent[]),
  ]);

  const baseline = renderJournalMarkdown(day, frames, { sessions, meetings });
  const evidenceHash = computeDayEvidenceHash(day, frames, sessions, meetings, dayEvents);

  if (existing && existing.evidenceHash === evidenceHash) {
    return {
      page: {
        ...existing,
        // Keep existing content; evidence didn't change. Only refresh the
        // sourceEventIds (cheap, always current) so the index manifest
        // stays consistent.
        sourceEventIds: frames.map((f) => f.id).slice(-500),
        lastUpdated: existing.lastUpdated,
      },
      reused: true,
    };
  }

  let content = baseline;
  const narrative = await maybeRenderNarrative(day, frames, sessions, baseline, deps).catch(
    (err) => {
      deps.logger.warn('day-page narrative failed', { day, err: String(err) });
      return null;
    },
  );
  if (narrative) {
    content = insertBeforeTimeline(baseline, `## Detailed day story\n${narrative}\n`);
  }

  return {
    page: {
      path: dayPagePath(day),
      content,
      sourceEventIds: frames.map((f) => f.id).slice(-500),
      backlinks: existing?.backlinks ?? [],
      lastUpdated: isoTimestamp(),
      evidenceHash,
    },
    reused: false,
  };
}

function computeDayEvidenceHash(
  day: string,
  frames: Frame[],
  sessions: ActivitySession[],
  meetings: Meeting[],
  dayEvents: DayEvent[],
): string {
  const hash = createHash('sha256');
  hash.update(day);
  hash.update('|frames:');
  for (const f of frames) {
    hash.update(f.id);
    hash.update(':');
    hash.update(f.timestamp);
    hash.update(':');
    hash.update(String(f.duration_ms ?? 0));
    hash.update(':');
    hash.update(f.text_source ?? '');
    hash.update(':');
    if (f.text) hash.update(f.text.slice(0, 200));
    hash.update('|');
  }
  hash.update('|sessions:');
  for (const s of sessions) {
    hash.update(`${s.id}:${s.started_at}:${s.ended_at}:${s.active_ms}:${s.frame_count}|`);
  }
  hash.update('|meetings:');
  for (const m of meetings) {
    hash.update(
      `${m.id}:${m.started_at}:${m.ended_at}:${m.summary_status}:${m.summary_md ? m.summary_md.length : 0}|`,
    );
  }
  hash.update('|day_events:');
  for (const e of dayEvents) {
    hash.update(`${e.id}:${e.updated_at ?? ''}|`);
  }
  return hash.digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// LLM narrative — vendored from the (now removed) markdown export plugin
// path. Keeps day-pages substantively as rich as the old `journal/<day>.md`
// files, just produced continuously via the index pipeline.
// ---------------------------------------------------------------------------

const JOURNAL_NARRATIVE_SYSTEM_PROMPT = `You write personal activity reports from captured desktop sessions.

Rules:
- Ground every claim in the supplied session metadata, titles, URLs, entities, files, and optional images.
- Prefer concrete actions and outcomes over app names.
- Write like a useful personal journal: "you worked through X, then checked Y, then followed up with Z".
- Connect adjacent sessions when the evidence suggests a handoff or follow-up.
- Do not invent relationships such as boss/manager/client unless explicitly present in the evidence.
- Do not mention internal session ids.
- Do not use vague phrases like "manage their work", "project management", or "various applications" unless the evidence says that exactly.
- Every Chronological notes bullet must include at least one concrete artifact, communication target, URL/domain, file, or window title.
- Use uncertainty language ("likely", "appears", "possibly") when evidence is weak.
- Keep it concise: short paragraphs plus scannable bullets.`;

async function maybeRenderNarrative(
  day: string,
  frames: Frame[],
  sessions: ActivitySession[],
  baseline: string,
  deps: RenderDayPageDeps,
): Promise<string | null> {
  if (!sessions.length) return null;
  if (!(await deps.model.isAvailable().catch(() => false))) return null;
  const info = deps.model.getModelInfo();
  if (info.name === 'offline:fallback') return null;
  if (!info.supportsVision && !deps.narrativeTextEnabled) return null;

  const baselineSection = extractBaselineNarrative(baseline);
  const { prompt, images } = await buildNarrativePrompt(
    day,
    frames,
    sessions,
    info.supportsVision,
    baselineSection,
    deps.dataDir,
  );

  const raw = await withTimeout(
    info.supportsVision && images.length > 0
      ? deps.model.completeWithVision(prompt, images, {
          systemPrompt: JOURNAL_NARRATIVE_SYSTEM_PROMPT,
          temperature: 0.15,
          maxTokens: 1200,
        })
      : deps.model.complete(prompt, {
          systemPrompt: JOURNAL_NARRATIVE_SYSTEM_PROMPT,
          temperature: 0.15,
          maxTokens: 1200,
        }),
    deps.narrativeTimeoutMs,
    `journal narrative timed out after ${deps.narrativeTimeoutMs}ms`,
  );
  const cleaned = cleanModelMarkdown(raw);
  if (!cleaned || !isUsefulModelNarrative(cleaned)) return null;
  return cleaned;
}

async function buildNarrativePrompt(
  day: string,
  frames: Frame[],
  sessions: ActivitySession[],
  includeImages: boolean,
  baseline: string,
  dataDir: string,
): Promise<{ prompt: string; images: Buffer[] }> {
  const framesBySession = groupFramesBySession(frames);
  const lines: string[] = [];
  const images: Buffer[] = [];
  lines.push(`DAY: ${day}`, '');
  lines.push('Write a story-like journal entry of what the user appears to have done.');
  lines.push('Important: infer actions across timeframes, but mark uncertainty when evidence is weak.');
  lines.push('Improve on the baseline only when the evidence supports it. Keep concrete artifacts, communications, files, URLs, and outcomes.');
  lines.push('Lead with what happened and why it mattered, not app usage or percentages.');
  lines.push('', 'BASELINE DETERMINISTIC REPORT:', baseline || '(none)', '', 'SESSIONS:');

  let imageNo = 1;
  for (const session of [...sessions].sort((a, b) => a.started_at.localeCompare(b.started_at))) {
    const sessionFrames = framesBySession.get(session.id) ?? [];
    if (sessionFrames.length === 0) continue;
    const keyframes = includeImages ? pickRepresentativeFrames(sessionFrames, 1) : [];
    const imageLabels: string[] = [];
    for (const frame of keyframes) {
      if (!frame.asset_path || images.length >= 5) continue;
      try {
        const abs = path.join(dataDir, frame.asset_path);
        images.push(await fs.readFile(abs));
        imageLabels.push(
          `image_${imageNo}: ${frame.timestamp.slice(11, 19)} ${frame.app} "${truncate(frame.window_title || '', 80)}"`,
        );
        imageNo += 1;
      } catch {
        // asset may have been vacuumed
      }
    }
    lines.push(renderSessionDossier(session, sessionFrames, imageLabels), '');
  }

  lines.push('Return markdown only with these sections:');
  lines.push('- `### Day story` with 2-4 short paragraphs in second person ("you ...")');
  lines.push('- `### Chronological notes` with 3-7 bullets that explain what happened in order');
  lines.push('- `### Evidence and uncertainty` explaining which claims are strong, weak, or inferred');
  return { prompt: lines.join('\n'), images };
}

function groupFramesBySession(frames: Frame[]): Map<string, Frame[]> {
  const map = new Map<string, Frame[]>();
  for (const f of frames) {
    const key = f.activity_session_id ?? '__loose__';
    const arr = map.get(key);
    if (arr) arr.push(f);
    else map.set(key, [f]);
  }
  return map;
}

function pickRepresentativeFrames(frames: Frame[], limit: number): Frame[] {
  const withAssets = frames.filter((f) => f.asset_path);
  if (withAssets.length <= limit) return withAssets;
  const picked: Frame[] = [withAssets[0]!];
  const last = withAssets[withAssets.length - 1]!;
  if (limit > 1 && last !== picked[0]) picked.push(last);
  for (const f of withAssets) {
    if (picked.length >= limit) break;
    if (!picked.includes(f)) picked.push(f);
  }
  return picked.slice(0, limit);
}

function renderSessionDossier(
  session: ActivitySession,
  frames: Frame[],
  imageLabels: string[],
): string {
  const lines: string[] = [];
  const start = session.started_at.slice(11, 16);
  const end = session.ended_at.slice(11, 16);
  lines.push(
    `SESSION ${session.id} (${start}-${end}, active ${Math.round(session.active_ms / 60_000)} min, ${frames.length} frames)`,
  );
  lines.push(`primary_entity: ${session.primary_entity_path ?? '(none)'}`);
  lines.push(`primary_app: ${session.primary_app ?? '(none)'}`);
  const entities = topCounts(frames, (f) => f.entity_path, 5);
  const apps = topCounts(frames, (f) => f.app, 5);
  const titles = representativeValues(frames, (f) => f.window_title, 8);
  const files = extractFiles(frames, 8);
  const urls = representativeValues(frames, (f) => f.url, 5);
  const communication = topCounts(
    frames,
    (f) => {
      if (f.entity_path?.startsWith('contacts/') || f.entity_path?.startsWith('channels/')) {
        return f.entity_path;
      }
      if (f.app === 'Mail') return 'apps/mail';
      return null;
    },
    5,
  );
  const readableText = representativeValues(
    frames,
    (f) => (f.text_source === 'accessibility' || f.text_source === 'audio' ? f.text : null),
    5,
  );
  if (entities.length) lines.push(`entities: ${entities.map(formatCount).join(', ')}`);
  if (apps.length) lines.push(`apps: ${apps.map(formatCount).join(', ')}`);
  if (titles.length) lines.push(`window_titles: ${titles.map((x) => `"${truncate(x, 120)}"`).join(' | ')}`);
  if (files.length) lines.push(`files: ${files.join(', ')}`);
  if (urls.length) lines.push(`urls: ${urls.map((x) => truncate(x, 120)).join(' | ')}`);
  if (communication.length) lines.push(`communication_targets: ${communication.map(formatCount).join(', ')}`);
  if (readableText.length) lines.push(`high_confidence_text: ${readableText.map((x) => `"${truncate(x, 220)}"`).join(' | ')}`);
  if (imageLabels.length) lines.push(`attached_images: ${imageLabels.join(' | ')}`);
  return lines.join('\n');
}

function topCounts<T>(
  items: T[],
  pick: (x: T) => string | null | undefined,
  limit: number,
): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const it of items) {
    const v = pick(it);
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function formatCount(item: { value: string; count: number }): string {
  return `${item.value} (${item.count})`;
}

function representativeValues<T>(
  items: T[],
  pick: (x: T) => string | null | undefined,
  limit: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const v = pick(it)?.replace(/\s+/g, ' ').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

const FILE_EXTENSIONS = new Set([
  'md', 'mdx', 'txt', 'json', 'jsonl', 'yaml', 'yml', 'toml',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'css', 'html', 'htm',
  'rs', 'go', 'py', 'rb', 'java', 'swift', 'kt', 'sql',
  'sh', 'zsh', 'env',
  'webp', 'png', 'jpg', 'jpeg', 'gif', 'pdf',
  'doc', 'docx', 'xls', 'xlsx', 'csv',
]);

function extractFiles(frames: Frame[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of frames) {
    const match = f.window_title?.match(/(?:^|[\s●○•])([A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})\b/);
    const file = match?.[1];
    if (!file || !looksLikeRealFile(file) || seen.has(file)) continue;
    seen.add(file);
    out.push(file);
    if (out.length >= limit) break;
  }
  return out;
}

function looksLikeRealFile(name: string): boolean {
  if (/^\d+\.\d+/.test(name)) return false;
  const ext = name.split('.').pop()?.toLowerCase();
  if (!ext || !FILE_EXTENSIONS.has(ext)) return false;
  if (/^[a-z]+\.(?:com|io)$/i.test(name)) return false;
  return true;
}

function insertBeforeTimeline(markdown: string, section: string): string {
  const marker = '\n## Timeline\n';
  const idx = markdown.indexOf(marker);
  if (idx === -1) return `${markdown.trim()}\n\n${section.trim()}\n`;
  return `${markdown.slice(0, idx).trimEnd()}\n\n${section.trim()}\n${markdown.slice(idx)}`;
}

function extractBaselineNarrative(markdown: string): string {
  const start = markdown.indexOf('\n## What happened\n');
  const end = markdown.indexOf('\n## Timeline\n');
  if (start === -1 || end === -1 || end <= start) return '';
  return markdown.slice(start, end).trim();
}

function cleanModelMarkdown(text: string): string {
  return text
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

function isUsefulModelNarrative(markdown: string): boolean {
  const lower = markdown.toLowerCase();
  if (!lower.includes('### day story')) return false;
  if (!lower.includes('### chronological notes')) return false;
  if (/\bact_[a-z0-9_]+\b/i.test(markdown)) return false;
  const vague = ['manage their work', 'project management', 'various applications', 'exact nature of the user', 'without additional context'];
  if (vague.some((p) => lower.includes(p))) return false;
  const concrete = ['[[', '`', '.md', '.ts', '.json', 'slack', 'mail', 'cursor', 'http', 'youtube', 'calendar', 'pnpm'];
  return concrete.reduce((n, m) => n + (lower.includes(m) ? 1 : 0), 0) >= 3;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let to: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        to = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (to) clearTimeout(to);
  }
}
