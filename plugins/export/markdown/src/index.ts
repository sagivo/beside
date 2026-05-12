import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  IExport,
  IStorage,
  ExportStatus,
  ExportServices,
  IndexPage,
  IndexState,
  IIndexStrategy,
  IModelAdapter,
  Frame,
  ActivitySession,
  ReorganisationSummary,
  PluginFactory,
  Logger,
} from '@beside/interfaces';
import { renderJournalMarkdown } from '@beside/interfaces';
import { ensureDir, expandPath } from '@beside/core';

interface MarkdownExportConfig {
  path?: string;
  enabled?: boolean;
  narrative_timeout_ms?: number;
  narrative_text_enabled?: boolean;
}

export interface MarkdownExportServices {
  storage: IStorage;
  strategy?: IIndexStrategy;
  model?: IModelAdapter;
  /**
   * Absolute path to the data dir (where the `raw/` screenshot tree lives).
   * Used to compute relative `![](…)` paths in the journal so the markdown
   * tree is portable when copied to e.g. an Obsidian vault.
   */
  dataDir: string;
}

class MarkdownExport implements IExport {
  readonly name = 'markdown';

  private readonly logger: Logger;
  private readonly outDir: string;
  private readonly narrativeTimeoutMs: number;
  private readonly narrativeTextEnabled: boolean;
  private running = false;
  private lastSync: string | null = null;
  private pendingUpdates = 0;
  private errorCount = 0;
  private services: MarkdownExportServices | null = null;
  private journalsRendered = new Set<string>();
  private rootIndexCache: string | null = null;

  constructor(
    outDir: string,
    logger: Logger,
    narrativeTimeoutMs: number = DEFAULT_NARRATIVE_TIMEOUT_MS,
    narrativeTextEnabled = false,
  ) {
    this.outDir = outDir;
    this.narrativeTimeoutMs = narrativeTimeoutMs;
    this.narrativeTextEnabled = narrativeTextEnabled;
    this.logger = logger.child('export-markdown');
  }

  /**
   * Called by the orchestrator after instantiation to inject storage so
   * the export can render the daily journal alongside strategy pages.
   * Optional — pre-frames installs that don't bind services still get
   * wiki-page mirroring as before.
   */
  bindServices(services: ExportServices | MarkdownExportServices): void {
    const bound: MarkdownExportServices = {
      storage: services.storage,
      dataDir: services.dataDir,
    };
    if ('strategy' in services) bound.strategy = services.strategy;
    if ('model' in services) bound.model = services.model;
    this.services = bound;
  }

  async start(): Promise<void> {
    await ensureDir(this.outDir);
    this.running = true;
    this.logger.info(`markdown export ready at ${this.outDir}`);
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async onPageUpdate(page: IndexPage): Promise<void> {
    if (!this.running) return;
    this.pendingUpdates += 1;
    try {
      const target = path.join(this.outDir, page.path);
      await ensureDir(path.dirname(target));
      // We strip our internal metadata block — the export tree is for
      // humans / external agents, not for our own round-trip.
      await this.writeTextIfChanged(
        target,
        this.prepareMarkdownForExport(page.content, target),
      );
      await this.refreshRootIndex();
      this.lastSync = new Date().toISOString();
    } catch (err) {
      this.errorCount += 1;
      this.logger.error('export write failed', { err: String(err), page: page.path });
    } finally {
      this.pendingUpdates = Math.max(0, this.pendingUpdates - 1);
    }
  }

  /**
   * Render `journal/<day>.md` from the frames table. Idempotent — safe
   * to call as often as you like; we coalesce by debouncing on the day
   * key when called from `onPageUpdate`.
   */
  async renderJournal(day: string, options: { enrich?: boolean } = {}): Promise<void> {
    if (!this.services) return;
    const frames = await this.services.storage.getJournal(day);
    const target = path.join(this.outDir, 'journal', `${day}.md`);
    await ensureDir(path.dirname(target));
    // Compute a relative prefix so screenshot links work when this tree
    // is copied to an Obsidian vault: from <export>/journal/<day>.md back
    // to <data_dir>/raw/... The data dir hosts `raw/` directly.
    const relToData = path.relative(
      path.dirname(target),
      this.services.dataDir,
    );
    const prefix = relToData ? `${relToData.replace(/\\/g, '/')}/` : '';
    // Sessions overlapping this day enrich the journal with proper
    // headers and AFK gap markers. We tolerate the storage method being
    // unavailable (e.g. for adapters that don't materialise sessions yet)
    // — without it the renderer falls back to the legacy app-grouped
    // output cleanly.
    let sessions: Awaited<ReturnType<typeof this.services.storage.listSessions>> = [];
    try {
      sessions = await this.services.storage.listSessions({
        day,
        order: 'chronological',
        limit: 500,
      });
    } catch {
      sessions = [];
    }
    // Meetings overlapping this day. Same tolerance as sessions — the
    // renderer falls back gracefully when the adapter doesn't
    // materialise meetings.
    let meetings: Awaited<ReturnType<typeof this.services.storage.listMeetings>> = [];
    try {
      meetings = await this.services.storage.listMeetings({
        day,
        order: 'chronological',
        limit: 100,
      });
    } catch {
      meetings = [];
    }
    let md = renderJournalMarkdown(day, frames, {
      assetUrlPrefix: prefix,
      sessions,
      meetings,
    });
    if (options.enrich) {
      md = await this.maybeAddModelJournalNarrative(day, frames, sessions, md);
    }
    await this.writeTextIfChanged(target, md);
    this.journalsRendered.add(day);
  }

  private async maybeRenderJournal(day: string, options: { enrich?: boolean } = {}): Promise<void> {
    if (!this.services) return;
    try {
      await this.renderJournal(day, options);
    } catch (err) {
      this.errorCount += 1;
      this.logger.warn('journal render failed', {
        err: String(err),
        day,
      });
    }
  }

  async onPageDelete(pagePath: string): Promise<void> {
    if (!this.running) return;
    try {
      await fs.unlink(path.join(this.outDir, pagePath));
      await this.refreshRootIndex();
    } catch {
      // ignore
    }
  }

  async onReorganisation(summary: ReorganisationSummary): Promise<void> {
    if (!this.running) return;
    const log = path.join(this.outDir, '_log.md');
    const stamp = new Date().toISOString();
    const lines = [`\n## ${stamp}`, ''];
    if (summary.archived.length) lines.push(`- archived: ${summary.archived.join(', ')}`);
    if (summary.newSummaryPages.length) {
      lines.push(`- summaries: ${summary.newSummaryPages.join(', ')}`);
    }
    if (summary.notes) lines.push(`- notes: ${summary.notes}`);
    try {
      await fs.appendFile(log, lines.join('\n') + '\n', 'utf8');
    } catch (err) {
      this.errorCount += 1;
      this.logger.error('export log append failed', { err: String(err) });
    }
  }

  async fullSync(_state: IndexState, strategy: IIndexStrategy): Promise<void> {
    if (!this.running) await this.start();
    await ensureDir(this.outDir);

    await this.clearMarkdownFiles(this.outDir);
    this.rootIndexCache = null;
    await this.copyTree(_state.rootPath, this.outDir);
    await this.refreshRootIndex(strategy);

    // Re-render every day's journal we have data for. The narrative
    // step inside `maybeRenderJournal` is an LLM call (gemma4:e4b in
    // the default config), and Ollama serves up to OLLAMA_NUM_PARALLEL
    // (default 4) concurrent requests on the same model. Running the
    // days serially used 1 of those slots and idled 3 — so a 9-day
    // back-fill took ~3 min where it could be ~45 s.
    //
    // We bound concurrency to JOURNAL_NARRATIVE_CONCURRENCY (matches
    // the indexer's default render concurrency) so we never overwhelm
    // the model and never starve the user-facing chat path. Errors
    // inside `maybeRenderJournal` are already swallowed there, so a
    // single bad day can't unwind the whole `fullSync`.
    if (this.services) {
      const days = await this.services.storage.listDays();
      const concurrency = JOURNAL_NARRATIVE_CONCURRENCY;
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(concurrency, days.length) },
        async () => {
          while (true) {
            const i = cursor++;
            if (i >= days.length) return;
            try {
              await this.maybeRenderJournal(days[i] as string, { enrich: true });
            } catch (err) {
              this.logger.warn('journal render failed during fullSync', {
                day: days[i],
                err: String(err),
              });
            }
          }
        },
      );
      await Promise.all(workers);
    }

    this.lastSync = new Date().toISOString();
    this.logger.info('markdown export full sync complete');
  }

  getStatus(): ExportStatus {
    return {
      name: this.name,
      running: this.running,
      lastSync: this.lastSync,
      pendingUpdates: this.pendingUpdates,
      errorCount: this.errorCount,
    };
  }

  private async copyTree(srcRoot: string, dstRoot: string): Promise<void> {
    const walk = async (relDir: string): Promise<void> => {
      const srcDir = path.join(srcRoot, relDir);
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(srcDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const rel = path.join(relDir, e.name);
        if (e.isDirectory()) {
          await ensureDir(path.join(dstRoot, rel));
          await walk(rel);
        } else if (e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_state')) {
          const text = await fs.readFile(path.join(srcRoot, rel), 'utf8');
          await fs.writeFile(
            path.join(dstRoot, rel),
            this.prepareMarkdownForExport(text, path.join(dstRoot, rel)),
            'utf8',
          );
        }
      }
    };
    await walk('.');
  }

  private async clearMarkdownFiles(root: string): Promise<void> {
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== '_log.md') {
          await fs.unlink(abs);
        }
      }
    };
    await walk(root);
  }

  private async refreshRootIndex(strategy = this.services?.strategy): Promise<void> {
    if (!strategy) return;
    try {
      const target = path.join(this.outDir, 'index.md');
      const rootIndex = await strategy.readRootIndex();
      const rendered = this.prepareMarkdownForExport(rootIndex, target);
      if (rendered === this.rootIndexCache) return;
      await fs.writeFile(target, rendered, 'utf8');
      this.rootIndexCache = rendered;
    } catch (err) {
      this.errorCount += 1;
      this.logger.warn('root index export failed', { err: String(err) });
    }
  }

  private async writeTextIfChanged(target: string, text: string): Promise<boolean> {
    try {
      if ((await fs.readFile(target, 'utf8')) === text) return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await fs.writeFile(target, text, 'utf8');
    return true;
  }

  private prepareMarkdownForExport(text: string, target: string): string {
    return rewriteRawAssetLinks(stripMetaBlock(text), target, this.services?.dataDir);
  }

  private async maybeAddModelJournalNarrative(
    day: string,
    frames: Frame[],
    sessions: ActivitySession[],
    markdown: string,
  ): Promise<string> {
    const model = this.services?.model;
    if (!model || sessions.length === 0) return markdown;
    if (model.getModelInfo().name === 'offline:fallback') return markdown;
    try {
      if (!(await model.isAvailable().catch(() => false))) return markdown;
      const modelInfo = model.getModelInfo();
      if (!modelInfo.supportsVision && !this.narrativeTextEnabled) return markdown;
      const baseline = extractBaselineNarrative(markdown);
      const { prompt, images } = await this.buildJournalNarrativePrompt(
        day,
        frames,
        sessions,
        modelInfo.supportsVision,
        baseline,
      );
      this.logger.info('generating model journal narrative', {
        day,
        images: images.length,
        model: modelInfo.name,
      });
      const rawPromise = modelInfo.supportsVision && images.length > 0
        ? model.completeWithVision(prompt, images, {
            systemPrompt: JOURNAL_NARRATIVE_SYSTEM_PROMPT,
            temperature: 0.15,
            maxTokens: 1200,
          })
        : model.complete(prompt, {
            systemPrompt: JOURNAL_NARRATIVE_SYSTEM_PROMPT,
            temperature: 0.15,
            maxTokens: 1200,
          });
      const raw = await withTimeout(
        rawPromise,
        this.narrativeTimeoutMs,
        `journal narrative timed out after ${this.narrativeTimeoutMs}ms`,
      );
      const narrative = cleanModelMarkdown(raw);
      if (!narrative) return markdown;
      if (!isUsefulModelNarrative(narrative)) {
        this.logger.warn('discarding low-signal model journal narrative', { day });
        return markdown;
      }
      return insertBeforeTimeline(markdown, `## Detailed day story\n${narrative}\n`);
    } catch (err) {
      this.logger.warn('model journal narrative failed', { err: String(err), day });
      return markdown;
    }
  }

  private async buildJournalNarrativePrompt(
    day: string,
    frames: Frame[],
    sessions: ActivitySession[],
    includeImages: boolean,
    baseline: string,
  ): Promise<{ prompt: string; images: Buffer[] }> {
    const framesBySession = groupFramesBySession(frames);
    const lines: string[] = [];
    const images: Buffer[] = [];
    lines.push(`DAY: ${day}`);
    lines.push('');
    lines.push('Write a story-like journal entry of what the user appears to have done.');
    lines.push('Important: infer actions across timeframes, but mark uncertainty when evidence is weak.');
    lines.push('Improve on the baseline only when the evidence supports it. Keep concrete artifacts, communications, files, URLs, and outcomes.');
    lines.push('Lead with what happened and why it mattered, not app usage or percentages.');
    lines.push('');
    lines.push('BASELINE DETERMINISTIC REPORT:');
    lines.push(baseline || '(none)');
    lines.push('');
    lines.push('SESSIONS:');
    let imageNo = 1;
    for (const session of sessions.slice().sort((a, b) => a.started_at.localeCompare(b.started_at))) {
      const sessionFrames = framesBySession.get(session.id) ?? [];
      if (sessionFrames.length === 0) continue;
      const keyframes = includeImages ? pickRepresentativeFrames(sessionFrames, 1) : [];
      const imageLabels: string[] = [];
      for (const frame of keyframes) {
        if (!frame.asset_path || images.length >= 5) continue;
        const abs = path.join(this.services!.dataDir, frame.asset_path);
        try {
          images.push(await fs.readFile(abs));
          imageLabels.push(`image_${imageNo}: ${frame.timestamp.slice(11, 19)} ${frame.app} "${truncate(frame.window_title || '', 80)}"`);
          imageNo += 1;
        } catch {
          // Asset may have been vacuumed; metadata still carries useful context.
        }
      }
      lines.push(renderSessionDossier(session, sessionFrames, imageLabels));
      lines.push('');
    }
    lines.push('Return markdown only with these sections:');
    lines.push('- `### Day story` with 2-4 short paragraphs in second person ("you ...")');
    lines.push('- `### Chronological notes` with 3-7 bullets that explain what happened in order');
    lines.push('- `### Evidence and uncertainty` explaining which claims are strong, weak, or inferred');
    return { prompt: lines.join('\n'), images };
  }
}

/**
 * Bounded concurrency for the per-day journal-narrative LLM calls in
 * `fullSync`. These are *vision* calls (gemma4:e4b with 3-5 attached
 * screenshots), which dominate Ollama's KV cache and slow per-request
 * throughput dramatically when several share the model's parallel slots.
 *
 * Empirically, going wider than 2 made each call ~4x slower wall-clock
 * and every call tripped the per-narrative timeout — net loss. 2 is
 * the sweet spot: ~2x speedup over sequential without starving any
 * single call of its KV-cache budget. Note: the indexer's text-only
 * entity-page renders use the full 4 lanes elsewhere; this constant
 * is narrative-specific.
 */
const JOURNAL_NARRATIVE_CONCURRENCY = 2;
/**
 * Default timeout for a single journal-narrative call. The previous
 * 30 s was tuned for the sequential path where each call took 18-30 s
 * end-to-end. Once we run two in parallel, throughput-per-call halves
 * and 30 s starts hitting the wire on legitimately-completing calls.
 * 120 s is generous: the slowest calls we see top out around 60 s.
 */
const DEFAULT_NARRATIVE_TIMEOUT_MS = 120_000;

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

function stripMetaBlock(text: string): string {
  const start = text.indexOf('<!-- beside:meta');
  if (start === -1) return text;
  const end = text.indexOf('-->', start);
  if (end === -1) return text;
  return (text.slice(0, start) + text.slice(end + '-->'.length)).trim() + '\n';
}

function rewriteRawAssetLinks(text: string, target: string, dataDir?: string): string {
  if (!dataDir) return text;
  const relToData = path.relative(path.dirname(target), dataDir).replace(/\\/g, '/');
  const prefix = relToData ? `${relToData}/` : '';
  return text.replace(/(!\[[^\]]*\]\()raw\//g, `$1${prefix}raw/`);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function groupFramesBySession(frames: Frame[]): Map<string, Frame[]> {
  const map = new Map<string, Frame[]>();
  for (const frame of frames) {
    const key = frame.activity_session_id ?? '__loose__';
    const existing = map.get(key);
    if (existing) existing.push(frame);
    else map.set(key, [frame]);
  }
  return map;
}

function pickRepresentativeFrames(frames: Frame[], limit: number): Frame[] {
  const withAssets = frames.filter((frame) => frame.asset_path);
  if (withAssets.length <= limit) return withAssets;
  const picked: Frame[] = [withAssets[0]!];
  const last = withAssets[withAssets.length - 1]!;
  if (limit > 1 && last !== picked[0]) picked.push(last);
  for (const frame of withAssets) {
    if (picked.length >= limit) break;
    if (!picked.includes(frame)) picked.push(frame);
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
  lines.push(`SESSION ${session.id} (${start}-${end}, active ${Math.round(session.active_ms / 60_000)} min, ${frames.length} frames)`);
  lines.push(`primary_entity: ${session.primary_entity_path ?? '(none)'}`);
  lines.push(`primary_app: ${session.primary_app ?? '(none)'}`);
  const entities = topCounts(frames, (frame) => frame.entity_path, 5);
  const apps = topCounts(frames, (frame) => frame.app, 5);
  const titles = representativeValues(frames, (frame) => frame.window_title, 8);
  const files = extractFiles(frames, 8);
  const urls = representativeValues(frames, (frame) => frame.url, 5);
  const communication = topCounts(
    frames,
    (frame) => {
      if (frame.entity_path?.startsWith('contacts/') || frame.entity_path?.startsWith('channels/')) {
        return frame.entity_path;
      }
      if (frame.app === 'Mail') return 'apps/mail';
      return null;
    },
    5,
  );
  const readableText = representativeValues(
    frames,
    (frame) =>
      frame.text_source === 'accessibility' || frame.text_source === 'audio'
        ? frame.text
        : null,
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

function topCounts(
  frames: Frame[],
  picker: (frame: Frame) => string | null | undefined,
  limit: number,
): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const frame of frames) {
    const value = picker(frame);
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function formatCount(item: { value: string; count: number }): string {
  return `${item.value} (${item.count})`;
}

function representativeValues(
  frames: Frame[],
  picker: (frame: Frame) => string | null | undefined,
  limit: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const frame of frames) {
    const value = picker(frame)?.replace(/\s+/g, ' ').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function extractFiles(frames: Frame[], limit: number): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const frame of frames) {
    const match = frame.window_title?.match(/(?:^|[\s●○•])([A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})\b/);
    const file = match?.[1];
    if (!file || !looksLikeRealFile(file) || seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    if (files.length >= limit) break;
  }
  return files;
}

const EXPORT_FILE_EXTENSIONS = new Set([
  'md',
  'mdx',
  'txt',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'css',
  'html',
  'htm',
  'rs',
  'go',
  'py',
  'rb',
  'java',
  'swift',
  'kt',
  'sql',
  'sh',
  'zsh',
  'env',
  'webp',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'csv',
]);

function looksLikeRealFile(name: string): boolean {
  if (/^\d+\.\d+/.test(name)) return false;
  const ext = name.split('.').pop()?.toLowerCase();
  if (!ext || !EXPORT_FILE_EXTENSIONS.has(ext)) return false;
  if (/^[a-z]+\.com$/i.test(name)) return false;
  if (/^[a-z]+\.io$/i.test(name)) return false;
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
  const vaguePhrases = [
    'manage their work',
    'project management',
    'various applications',
    'exact nature of the user',
    'without additional context',
  ];
  if (vaguePhrases.some((phrase) => lower.includes(phrase))) return false;
  const concreteMarkers = [
    '[[',
    '`',
    '.md',
    '.ts',
    '.json',
    'slack',
    'mail',
    'cursor',
    'http',
    'youtube',
    'calendar',
    'pnpm',
  ];
  const concreteCount = concreteMarkers.reduce(
    (count, marker) => count + (lower.includes(marker) ? 1 : 0),
    0,
  );
  return concreteCount >= 3;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

const factory: PluginFactory<IExport> = async (ctx) => {
  const cfg = (ctx.config as MarkdownExportConfig) ?? {};
  const outDir = expandPath(cfg.path ?? path.join(ctx.dataDir, 'export', 'markdown'));
  return new MarkdownExport(
    outDir,
    ctx.logger,
    cfg.narrative_timeout_ms,
    cfg.narrative_text_enabled,
  );
};

export default factory;
export { MarkdownExport };
