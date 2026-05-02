import path from 'node:path';
import type {
  EntityRecord,
  Frame,
  IIndexStrategy,
  IModelAdapter,
  IndexPage,
  IndexState,
  IndexUpdate,
  IStorage,
  Logger,
  RawEvent,
  ReorganisationSummary,
} from '@cofounderos/interfaces';
import { isoTimestamp } from '@cofounderos/core';
import { slugify } from './bucketer.js';
import { PageStore } from './page-store.js';

const STRATEGY_NAME = 'karpathy';

const SYSTEM_PROMPT = `You write one-paragraph descriptions for entries in a personal knowledge wiki.
You receive STRUCTURED EVIDENCE about one entity (a project, repo, meeting, channel, doc, person, app, or webpage)
and (when applicable) the existing prose paragraph. You return ONLY the new prose — 1-3 sentences, plain markdown,
no headers, no list bullets, no metadata.

Hard rules:
- Ground every claim in the evidence. If the evidence says "Cursor was used to edit README.md", say so.
- Never invent facts. Never describe features the evidence does not mention.
- If the evidence is thin, write a short factual sentence and stop.
- Preserve correct facts from the existing prose if you have them.
- Plain prose only. No "Summary:" prefix. No headers. No bullet lists.`;

const REORG_SYSTEM_PROMPT = `You maintain the structure of a personal knowledge wiki.
Identify structural improvements (merges, splits, archives, summary pages, reclassifications).
Be conservative — only suggest changes when the benefit is clear.
Respond with JSON only, conforming exactly to the schema in the user message.`;

interface StrategyConfig {
  index_path?: string;
  batch_size?: number;
  archive_after_days?: number;
  summary_threshold_pages?: number;
  /**
   * Minimum total focused minutes an `apps/<x>` entity needs before
   * it earns a wiki page of its own. After P1 entity lifting, what's
   * left on `apps/*` is mostly transient tool use that nobody wants
   * a paragraph about. Default 5 minutes.
   */
  app_page_min_minutes?: number;
  /**
   * Minimum frame count an `apps/<x>` entity needs before it earns a
   * page. Acts as a floor independent of duration (a single multi-hour
   * idle window shouldn't earn a page). Default 20.
   */
  app_page_min_frames?: number;
}

/**
 * `apps/<slug>` entities that are NEVER worth a wiki page, regardless
 * of focused-time accumulation. These are macOS / system / framework
 * processes that hold focus by accident — turning them into prose
 * paragraphs is pure noise. The list is conservative: anything not
 * here is still subject to the duration / frame thresholds.
 */
const NOISE_APP_SLUGS: ReadonlySet<string> = new Set([
  'loginwindow',
  'captive-network-assistant',
  'system-settings',
  'activity-monitor',
  'electron',
  'cloudflare-warp',
  'spotlight',
  'window-server',
  'dock',
  'control-center',
  'notification-center',
  'screencaptureui',
  'cofounderos', // the host app itself
]);

function isNoiseAppEntity(entityPath: string): boolean {
  if (!entityPath.startsWith('apps/')) return false;
  return NOISE_APP_SLUGS.has(entityPath.slice('apps/'.length));
}

export class KarpathyStrategy implements IIndexStrategy {
  readonly name = STRATEGY_NAME;
  readonly description =
    'Self-reorganising hierarchical markdown wiki (Karpathy LLM-wiki pattern).';

  private readonly logger: Logger;
  private readonly batchSize: number;
  private readonly archiveAfterDays: number;
  private readonly summaryThresholdPages: number;
  private readonly appPageMinMs: number;
  private readonly appPageMinFrames: number;
  private store!: PageStore;
  /**
   * Captured on the first `getUnindexedEvents` call. We use it inside
   * `indexBatch` to fetch entities + frames since the IIndexStrategy
   * contract doesn't pass `IStorage` into that method directly.
   */
  private storage: IStorage | null = null;

  constructor(private readonly config: StrategyConfig, logger: Logger) {
    this.logger = logger.child(`index-${STRATEGY_NAME}`);
    this.batchSize = config.batch_size ?? 50;
    this.archiveAfterDays = config.archive_after_days ?? 30;
    this.summaryThresholdPages = config.summary_threshold_pages ?? 5;
    this.appPageMinMs = (config.app_page_min_minutes ?? 5) * 60_000;
    this.appPageMinFrames = config.app_page_min_frames ?? 20;
  }

  /**
   * Should we render a wiki page for this entity? After session-aware
   * lifting (see SessionBuilder.maybeLiftSupportingAppFrames) the
   * `apps/*` rows are mostly transient: brief Electron flickers,
   * loginwindow takeovers during sleep/wake, captive-network captives.
   * Filter them out here so the wiki stays focused on actual knowledge
   * (projects, repos, meetings, channels, contacts, docs, real apps).
   *
   * The rules are deliberately simple — anything in the system noise
   * deny-list is rejected outright; everything else needs both
   * meaningful focused time AND a non-trivial frame count.
   */
  private shouldRenderEntityPage(entity: EntityRecord): boolean {
    if (entity.kind !== 'app') return true;
    if (isNoiseAppEntity(entity.path)) return false;
    if (entity.totalFocusedMs < this.appPageMinMs) return false;
    if (entity.frameCount < this.appPageMinFrames) return false;
    return true;
  }

  async init(rootPath: string): Promise<void> {
    this.store = new PageStore(rootPath, STRATEGY_NAME);
    await this.store.init();
  }

  async getUnindexedEvents(storage: IStorage): Promise<RawEvent[]> {
    this.storage = storage;
    return await storage.readEvents({
      unindexed_for_strategy: STRATEGY_NAME,
      limit: this.batchSize,
    });
  }

  async indexBatch(
    events: RawEvent[],
    currentIndex: IndexState,
    model: IModelAdapter,
  ): Promise<IndexUpdate> {
    const empty = (): IndexUpdate => ({
      pagesToCreate: [],
      pagesToUpdate: [],
      pagesToDelete: [],
      newRootIndex: '',
      reorganisationNotes: '',
    });

    if (!this.storage) {
      this.logger.warn(
        'storage handle not set — call getUnindexedEvents first; skipping batch',
      );
      return empty();
    }

    if (events.length === 0) {
      return {
        ...(await this.renderRootIndexUpdate(currentIndex)),
        pagesToCreate: [],
        pagesToUpdate: [],
        pagesToDelete: [],
        reorganisationNotes: '',
      };
    }

    // Determine which entities saw new activity. Two paths:
    //   1. If we have a checkpoint (lastIncrementalRun), use the entities
    //      table directly: any entity whose `last_seen >= checkpoint`.
    //   2. As a sanity backstop, also pull entities reachable from the
    //      events in this batch — covers brand-new entities created after
    //      the last run.
    const since = currentIndex.lastIncrementalRun ?? '0000';
    const recent = await this.storage.listEntities({
      sinceLastSeen: since,
      limit: 200,
    });
    const dirtyByPath = new Map<string, EntityRecord>(
      recent.map((e) => [e.path, e]),
    );

    if (dirtyByPath.size === 0) {
      this.logger.debug(
        'no entities updated since last run — frame builder may not have caught up yet',
      );
      return empty();
    }

    const pagesToCreate: IndexPage[] = [];
    const pagesToUpdate: IndexPage[] = [];
    const pagesToDelete: string[] = [];
    let skippedNoise = 0;

    for (const entity of dirtyByPath.values()) {
      const frames = await this.storage.getEntityFrames(entity.path, 500);
      if (frames.length === 0) continue;

      const pagePath = `${entity.path}.md`;
      const existing = await this.store.readPage(pagePath);

      // Apply the entity-page filter. If a previously-indexed entity
      // has now slipped below the threshold (e.g. its real frames got
      // lifted out by SessionBuilder), tear down the stale page so
      // the wiki doesn't carry permanent dead pages around.
      if (!this.shouldRenderEntityPage(entity)) {
        skippedNoise += 1;
        if (existing) pagesToDelete.push(pagePath);
        continue;
      }

      const page = await this.renderEntityPage(entity, frames, existing, model);
      if (existing) pagesToUpdate.push(page);
      else pagesToCreate.push(page);
    }

    const newPagesByPath = new Map<string, IndexPage>();
    [...pagesToCreate, ...pagesToUpdate].forEach((p) => newPagesByPath.set(p.path, p));
    const allPages = await this.collectAllPagesAfterUpdate(
      newPagesByPath,
      new Set(pagesToDelete),
    );
    const newRootIndex = renderRootIndex(allPages, {
      lastIncrementalRun: isoTimestamp(),
      lastReorganisationRun: currentIndex.lastReorganisationRun,
      eventsCovered: currentIndex.eventsCovered + events.length,
    });

    const noiseSuffix = skippedNoise > 0 ? ` (skipped ${skippedNoise} below-threshold app entit${skippedNoise === 1 ? 'y' : 'ies'})` : '';
    this.logger.info(
      `karpathy: ${pagesToCreate.length} new + ${pagesToUpdate.length} updated + ${pagesToDelete.length} deleted pages` +
        ` from ${dirtyByPath.size} active entities${noiseSuffix}`,
    );

    return {
      pagesToCreate,
      pagesToUpdate,
      pagesToDelete,
      newRootIndex,
      reorganisationNotes: '',
    };
  }

  private async renderRootIndexUpdate(
    currentIndex: IndexState,
  ): Promise<Pick<IndexUpdate, 'newRootIndex'>> {
    const onDisk = await this.store.listPages();
    return {
      newRootIndex: renderRootIndex(onDisk, {
        lastIncrementalRun: currentIndex.lastIncrementalRun,
        lastReorganisationRun: currentIndex.lastReorganisationRun,
        eventsCovered: currentIndex.eventsCovered,
      }),
    };
  }

  async reorganise(currentIndex: IndexState, model: IModelAdapter): Promise<IndexUpdate> {
    const pages = await this.store.listPages();
    if (pages.length === 0) {
      return {
        pagesToCreate: [],
        pagesToUpdate: [],
        pagesToDelete: [],
        newRootIndex: await this.store.readRootIndex(),
        reorganisationNotes: 'No pages yet.',
      };
    }

    const summary: ReorganisationSummary = {
      merged: [],
      split: [],
      archived: [],
      newSummaryPages: [],
      reclassified: [],
      notes: '',
    };

    // 1. Deterministic archive pass — anything untouched for archive_after_days.
    const cutoff = Date.now() - this.archiveAfterDays * 24 * 60 * 60 * 1000;
    const pagesToCreate: IndexPage[] = [];
    const pagesToDelete: string[] = [];
    for (const p of pages) {
      if (p.path.startsWith('archive/')) continue;
      const ts = Date.parse(p.lastUpdated);
      if (Number.isFinite(ts) && ts < cutoff) {
        const archived: IndexPage = {
          ...p,
          path: `archive/${path.basename(p.path)}`,
          lastUpdated: p.lastUpdated,
        };
        pagesToCreate.push(archived);
        pagesToDelete.push(p.path);
        summary.archived.push(p.path);
      }
    }

    // 1b. Stale `apps/*` page sweep. Pages whose backing entity has
    //     dropped below the threshold (e.g. lifting moved its frames
    //     into a project; or it was always noise like apps/electron)
    //     are deleted outright — no point archiving content nobody
    //     wanted in the first place. Requires a storage handle, which
    //     we may not have here in offline / test contexts; skip
    //     silently in that case.
    if (this.storage) {
      let stalePagesDropped = 0;
      for (const p of pages) {
        if (!p.path.startsWith('apps/')) continue;
        if (pagesToDelete.includes(p.path)) continue; // already archived above
        const entityPath = p.path.replace(/\.md$/, '');
        const entity = await this.storage.getEntity(entityPath);
        if (!entity || !this.shouldRenderEntityPage(entity)) {
          pagesToDelete.push(p.path);
          stalePagesDropped += 1;
        }
      }
      if (stalePagesDropped > 0) {
        this.logger.info(
          `karpathy reorg: dropped ${stalePagesDropped} stale apps/* page(s) below threshold`,
        );
      }
    }

    // 2. Deterministic summary-of-summaries — for any category with > N pages.
    const byCategory = groupByCategory(
      pages.filter((p) => !pagesToDelete.includes(p.path)),
    );
    for (const [cat, catPages] of byCategory) {
      if (catPages.length <= this.summaryThresholdPages) continue;
      const summaryPath = `${cat}/_summary.md`;
      const summaryPage = renderCategorySummary(cat, catPages);
      pagesToCreate.push(summaryPage);
      summary.newSummaryPages.push(summaryPath);
    }

    // 3. LLM-driven structural suggestions (best effort — silently no-op if
    //    the model returns malformed JSON or is the offline fallback).
    try {
      const suggestion = await askModelForReorg(model, pages);
      if (suggestion?.notes) summary.notes = suggestion.notes;
    } catch (err) {
      this.logger.debug('reorg LLM suggestion failed', { err: String(err) });
    }

    const allPages = await this.collectAllPagesAfterUpdate(
      new Map(pagesToCreate.map((p) => [p.path, p])),
      new Set(pagesToDelete),
    );
    const newRootIndex = renderRootIndex(allPages, {
      lastIncrementalRun: currentIndex.lastIncrementalRun,
      lastReorganisationRun: isoTimestamp(),
      eventsCovered: currentIndex.eventsCovered,
    });

    const notes = renderReorgNotes(summary);

    return {
      pagesToCreate,
      pagesToUpdate: [],
      pagesToDelete,
      newRootIndex,
      reorganisationNotes: notes,
    };
  }

  async applyUpdate(update: IndexUpdate): Promise<IndexState> {
    for (const p of update.pagesToCreate) await this.store.writePage(p);
    for (const p of update.pagesToUpdate) await this.store.writePage(p);
    for (const p of update.pagesToDelete) await this.store.deletePage(p);

    if (update.newRootIndex) await this.store.writeRootIndex(update.newRootIndex);
    if (update.reorganisationNotes) await this.store.appendLog(update.reorganisationNotes);

    const pages = await this.store.listPages();
    const prev = await this.store.readState();
    const eventsCovered = sumEventCoverage(pages);
    const next: IndexState = {
      strategy: STRATEGY_NAME,
      rootPath: this.store.rootPath(),
      pageCount: pages.length,
      eventsCovered,
      lastIncrementalRun: prev.lastIncrementalRun,
      lastReorganisationRun: prev.lastReorganisationRun,
    };
    // Heuristic: any update writes counts as an incremental run; reorg
    // notes mark a reorganisation.
    next.lastIncrementalRun = isoTimestamp();
    if (update.reorganisationNotes) {
      next.lastReorganisationRun = isoTimestamp();
    }
    await this.store.writeState(next);
    return next;
  }

  async getState(): Promise<IndexState> {
    return await this.store.readState();
  }

  async readPage(pagePath: string): Promise<IndexPage | null> {
    return await this.store.readPage(pagePath);
  }

  async readRootIndex(): Promise<string> {
    return await this.store.readRootIndex();
  }

  async reset(): Promise<void> {
    await this.store.reset();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Render a single entity's wiki page from its frames + history. Page
   * structure:
   *
   *   1. YAML frontmatter (deterministic — clean, parseable by any tool).
   *   2. `# Title`
   *   3. `## What it is` — LLM prose, grounded in evidence; falls back
   *      to a deterministic summary when the model is unavailable.
   *   4. `## Recent activity` — deterministic, last 12 sessions.
   *   5. `## Files & URLs` — deterministic, deduplicated.
   *   6. `## Top screenshots` — up to 3 keyframes by perceptual hash.
   */
  private async renderEntityPage(
    entity: EntityRecord,
    frames: Frame[],
    existing: IndexPage | null,
    model: IModelAdapter,
  ): Promise<IndexPage> {
    const evidence = buildEvidence(entity, frames);
    const isOfflineModel = model.getModelInfo().name === 'offline:fallback';

    let prose: string;
    if (isOfflineModel) {
      prose = renderDeterministicProse(entity, evidence);
    } else {
      const prompt = buildEvidencePrompt(existing, entity, evidence);
      try {
        const raw = await model.complete(prompt, {
          systemPrompt: SYSTEM_PROMPT,
          temperature: 0.2,
          maxTokens: 350,
        });
        prose = raw.trim();
        // Defensive: if the model went off-script and re-rendered the
        // whole page, keep just the first paragraph.
        prose = trimToProse(prose);
        if (!prose) prose = renderDeterministicProse(entity, evidence);
      } catch (err) {
        this.logger.warn('model.complete failed, falling back to deterministic prose', {
          err: String(err),
        });
        prose = renderDeterministicProse(entity, evidence);
      }
    }

    const content = renderEntityMarkdown(entity, evidence, prose);

    return {
      path: `${entity.path}.md`,
      content,
      // We no longer store the full per-event provenance in the page
      // metadata block — the SQLite `frames`/`entities` tables are the
      // source of truth. Keep an empty list to satisfy the IndexPage
      // contract; reorg passes don't actually depend on it for entities
      // built from frames.
      sourceEventIds: existing?.sourceEventIds ?? [],
      backlinks: existing?.backlinks ?? [],
      lastUpdated: isoTimestamp(),
    };
  }

  private async collectAllPagesAfterUpdate(
    upsertedByPath: Map<string, IndexPage>,
    deletedPaths: Set<string> = new Set(),
  ): Promise<IndexPage[]> {
    const onDisk = await this.store.listPages();
    const merged = new Map<string, IndexPage>();
    for (const p of onDisk) {
      if (deletedPaths.has(p.path)) continue;
      merged.set(p.path, p);
    }
    for (const [k, v] of upsertedByPath) merged.set(k, v);
    return [...merged.values()];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Evidence — what we actually feed the LLM (and what we render
// deterministically into the page sections).
// ---------------------------------------------------------------------------

interface ActivityWindow {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  frameCount: number;
  windowTitles: string[];
  urls: string[];
}

interface Evidence {
  windows: ActivityWindow[];
  files: string[];
  urls: Array<{ url: string; title: string | null; lastSeen: string }>;
  textSnippets: string[];
  apps: string[];
  keyframes: Array<{ assetPath: string; timestamp: string; phash: string | null }>;
}

const SESSION_GAP_MS = 60_000;
const MAX_WINDOWS = 12;
const MAX_TEXT_SNIPPETS = 8;
const MAX_KEYFRAMES = 3;

function buildEvidence(_entity: EntityRecord, frames: Frame[]): Evidence {
  const sorted = frames.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // 1. Activity windows — group adjacent frames within `SESSION_GAP_MS`.
  const windows: ActivityWindow[] = [];
  for (const f of sorted) {
    const last = windows[windows.length - 1];
    const ts = Date.parse(f.timestamp);
    const lastEnd = last ? Date.parse(last.endedAt) : -Infinity;
    if (last && ts - lastEnd <= SESSION_GAP_MS) {
      last.endedAt = f.timestamp;
      last.frameCount += 1;
      last.durationMs += f.duration_ms ?? 0;
      if (f.window_title && !last.windowTitles.includes(f.window_title)) {
        last.windowTitles.push(f.window_title);
      }
      if (f.url && !last.urls.includes(f.url)) last.urls.push(f.url);
    } else {
      windows.push({
        startedAt: f.timestamp,
        endedAt: f.timestamp,
        durationMs: f.duration_ms ?? 0,
        frameCount: 1,
        windowTitles: f.window_title ? [f.window_title] : [],
        urls: f.url ? [f.url] : [],
      });
    }
  }

  // 2. Distinct files (heuristic from window titles).
  const files = new Set<string>();
  for (const f of sorted) {
    const file = extractFilename(f.window_title || '');
    if (file) files.add(file);
  }

  // 3. URLs.
  const urlMap = new Map<string, { title: string | null; lastSeen: string }>();
  for (const f of sorted) {
    if (!f.url) continue;
    const prev = urlMap.get(f.url);
    if (prev) {
      prev.lastSeen = f.timestamp;
      if (!prev.title && f.window_title) prev.title = f.window_title;
    } else {
      urlMap.set(f.url, { title: f.window_title || null, lastSeen: f.timestamp });
    }
  }

  // 4. OCR text snippets — pick a few non-empty, deduped excerpts.
  const seenSnippets = new Set<string>();
  const textSnippets: string[] = [];
  for (let i = sorted.length - 1; i >= 0 && textSnippets.length < MAX_TEXT_SNIPPETS; i--) {
    const f = sorted[i];
    if (!f || !f.text || f.text_source !== 'ocr') continue;
    const snippet = f.text.replace(/\s+/g, ' ').trim().slice(0, 220);
    if (snippet.length < 30) continue;
    const key = snippet.slice(0, 80);
    if (seenSnippets.has(key)) continue;
    seenSnippets.add(key);
    textSnippets.push(snippet);
  }

  // 5. Apps used.
  const apps = [...new Set(sorted.map((f) => f.app).filter(Boolean))];

  // 6. Keyframes — visually distinct screenshots (greedy max-min Hamming).
  const candidates = sorted.filter(
    (f): f is Frame & { asset_path: string } =>
      Boolean(f.asset_path) && Boolean(f.perceptual_hash),
  );
  const keyframes: Array<{ assetPath: string; timestamp: string; phash: string | null }> = [];
  if (candidates.length > 0) {
    keyframes.push({
      assetPath: candidates[0]!.asset_path,
      timestamp: candidates[0]!.timestamp,
      phash: candidates[0]!.perceptual_hash,
    });
    while (keyframes.length < MAX_KEYFRAMES && keyframes.length < candidates.length) {
      let bestIdx = -1;
      let bestMin = -1;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!;
        if (keyframes.some((k) => k.assetPath === c.asset_path)) continue;
        const minDist = keyframes.reduce(
          (acc, k) => Math.min(acc, hammingDistance(k.phash, c.perceptual_hash)),
          Number.POSITIVE_INFINITY,
        );
        if (minDist > bestMin) {
          bestMin = minDist;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break;
      const c = candidates[bestIdx]!;
      keyframes.push({
        assetPath: c.asset_path,
        timestamp: c.timestamp,
        phash: c.perceptual_hash,
      });
    }
  } else {
    // Fall back to *any* frame with an asset_path even if no phash.
    for (const f of sorted) {
      if (!f.asset_path) continue;
      keyframes.push({
        assetPath: f.asset_path,
        timestamp: f.timestamp,
        phash: f.perceptual_hash,
      });
      if (keyframes.length >= MAX_KEYFRAMES) break;
    }
  }

  return {
    windows: windows.slice(-MAX_WINDOWS).reverse(),
    files: [...files].slice(0, 20),
    urls: [...urlMap.entries()]
      .map(([url, info]) => ({ url, title: info.title, lastSeen: info.lastSeen }))
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
      .slice(0, 10),
    textSnippets,
    apps,
    keyframes,
  };
}

function buildEvidencePrompt(
  existing: IndexPage | null,
  entity: EntityRecord,
  evidence: Evidence,
): string {
  const lines: string[] = [];
  lines.push(`ENTITY KIND: ${entity.kind}`);
  lines.push(`ENTITY PATH: ${entity.path}`);
  lines.push(`ENTITY TITLE: ${entity.title}`);
  lines.push(
    `FIRST SEEN: ${entity.firstSeen.slice(0, 16).replace('T', ' ')} ` +
      `· LAST SEEN: ${entity.lastSeen.slice(0, 16).replace('T', ' ')}`,
  );
  lines.push(
    `TOTAL FOCUSED MIN: ${Math.round(entity.totalFocusedMs / 60_000)}` +
      ` · FRAMES: ${entity.frameCount}`,
  );
  if (evidence.apps.length) {
    lines.push(`APPS USED: ${evidence.apps.join(', ')}`);
  }
  if (evidence.files.length) {
    lines.push(`FILES SEEN: ${evidence.files.slice(0, 10).join(', ')}`);
  }
  if (evidence.urls.length) {
    lines.push('URLS VISITED:');
    for (const u of evidence.urls.slice(0, 6)) {
      lines.push(`  - ${u.url}${u.title ? ` (${truncate(u.title, 60)})` : ''}`);
    }
  }
  if (evidence.textSnippets.length) {
    lines.push('OCR EXCERPTS FROM SCREENSHOTS:');
    for (const t of evidence.textSnippets.slice(0, 4)) {
      lines.push(`  > ${t}`);
    }
  }
  if (existing?.content) {
    const oldProse = extractSection(existing.content, 'What it is');
    if (oldProse) {
      lines.push('EXISTING PROSE (update only if evidence contradicts or extends it):');
      lines.push(oldProse);
    }
  }
  lines.push('');
  lines.push(
    'Write 1-3 sentences of plain prose summarising this entity, grounded ONLY in the evidence above.',
  );
  return lines.join('\n');
}

function renderDeterministicProse(
  entity: EntityRecord,
  evidence: Evidence,
): string {
  const minutes = Math.round(entity.totalFocusedMs / 60_000);
  const firstDay = entity.firstSeen.slice(0, 10);
  const lastDay = entity.lastSeen.slice(0, 10);
  const span = firstDay === lastDay ? `on ${firstDay}` : `${firstDay} – ${lastDay}`;
  const apps = evidence.apps.length
    ? `via ${evidence.apps.slice(0, 3).join(', ')}`
    : '';
  const sample = evidence.files.length
    ? `Files seen: ${evidence.files.slice(0, 5).join(', ')}.`
    : evidence.urls.length
      ? `URLs visited: ${evidence.urls
          .slice(0, 3)
          .map((u) => u.url)
          .join(', ')}.`
      : '';
  const headline =
    minutes > 0
      ? `Active ${span} (${minutes} min, ${entity.frameCount} frames) ${apps}.`
      : `Observed ${span} (${entity.frameCount} frames) ${apps}.`;
  return [headline.trim(), sample].filter(Boolean).join(' ').trim();
}

function trimToProse(text: string): string {
  // The model occasionally returns headers / bullet lists despite the
  // system prompt. Strip them and keep the first 3 sentences.
  const cleaned = text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => !/^\s*[-*]\s/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g);
  if (!sentences) return cleaned;
  return sentences.slice(0, 3).join(' ').trim();
}

function renderEntityMarkdown(
  entity: EntityRecord,
  evidence: Evidence,
  prose: string,
): string {
  const lines: string[] = [];

  // 1. YAML frontmatter — every field is stable, deterministic, and
  // round-trippable. No more 50-line JSON blob in HTML comments.
  lines.push('---');
  lines.push(`entity: ${entity.path}`);
  lines.push(`kind: ${entity.kind}`);
  lines.push(`title: ${yamlString(entity.title)}`);
  lines.push(`first_seen: ${entity.firstSeen}`);
  lines.push(`last_seen: ${entity.lastSeen}`);
  lines.push(`total_focused_minutes: ${Math.round(entity.totalFocusedMs / 60_000)}`);
  lines.push(`frame_count: ${entity.frameCount}`);
  lines.push(`last_indexed: ${isoTimestamp()}`);
  lines.push('---');
  lines.push('');

  // 2. Title + prose section.
  lines.push(`# ${entity.title}`);
  lines.push('');
  lines.push('## What it is');
  lines.push(prose);
  lines.push('');

  // 3. Recent activity — deterministic windows.
  lines.push('## Recent activity');
  if (evidence.windows.length === 0) {
    lines.push('_(no activity recorded)_');
  } else {
    for (const w of evidence.windows) {
      const start = w.startedAt.slice(0, 16).replace('T', ' ');
      const minutes = Math.round(w.durationMs / 60_000);
      const ago = minutes > 0 ? `${minutes}m, ` : '';
      const titles = w.windowTitles.slice(0, 3).map((t) => `"${truncate(t, 70)}"`).join(', ');
      lines.push(`- **${start}** (${ago}${w.frameCount} frames) — ${titles || '(no title)'}`);
    }
  }
  lines.push('');

  // 4. Files & URLs.
  if (evidence.files.length || evidence.urls.length) {
    lines.push('## Files & URLs');
    if (evidence.files.length) {
      lines.push(`**Files:** ${evidence.files.map((f) => `\`${f}\``).join(', ')}`);
    }
    if (evidence.urls.length) {
      lines.push('**URLs:**');
      for (const u of evidence.urls) {
        const t = u.title ? ` — ${truncate(u.title, 60)}` : '';
        lines.push(`- <${u.url}>${t}`);
      }
    }
    lines.push('');
  }

  // 5. Top screenshots.
  if (evidence.keyframes.length) {
    lines.push('## Top screenshots');
    for (const k of evidence.keyframes) {
      const time = k.timestamp.slice(11, 19);
      lines.push(`![${entity.title} @ ${time}](${k.assetPath})`);
    }
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

function yamlString(s: string): string {
  // Quote when the string contains characters that confuse a naive YAML
  // parser; double-quotes need escaping inside.
  if (/[:\-#&*!{}[\]|>?,'"%@`\\]|^\s|\s$/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

function extractFilename(title: string): string | null {
  // Common editor / finder patterns:
  //   "README.md — projectname"   → README.md
  //   "● file.ts (workspace)"     → file.ts
  //   "Quick Look"                → null (no real file)
  const match = title.match(/(?:^|[\s●○•])([A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})\b/);
  if (match && match[1]) {
    const f = match[1];
    // Filter out common false positives.
    if (/^\d+\.\d+/.test(f)) return null; // version numbers
    return f;
  }
  return null;
}

function hammingDistance(a: string | null, b: string | null): number {
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) dist += 1;
  }
  return dist;
}

function extractSection(content: string, heading: string): string | null {
  const re = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|\\Z)`, 'm');
  const m = content.match(re);
  return m && m[1] ? m[1].trim() : null;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/**
 * Lower bound on how many raw events we've folded into the index.
 * Entity-driven pages no longer carry per-event provenance in their
 * frontmatter, so this number drifts lower than reality after a switch
 * to the new strategy — but remains useful as a "we have done work".
 */
function sumEventCoverage(pages: IndexPage[]): number {
  return pages.reduce((acc, p) => acc + p.sourceEventIds.length, 0);
}

function groupByCategory(pages: IndexPage[]): Map<string, IndexPage[]> {
  const map = new Map<string, IndexPage[]>();
  for (const p of pages) {
    const cat = p.path.split('/')[0] ?? 'uncategorised';
    const existing = map.get(cat);
    if (existing) existing.push(p);
    else map.set(cat, [p]);
  }
  return map;
}

interface RootMeta {
  lastIncrementalRun: string | null;
  lastReorganisationRun: string | null;
  eventsCovered: number;
}

function renderRootIndex(pages: IndexPage[], meta: RootMeta): string {
  const byCat = groupByCategory(pages.filter((p) => !p.path.startsWith('archive/')));
  const lines: string[] = [];
  lines.push('# CofounderOS — index');
  lines.push('');
  lines.push(`Last incremental run: ${meta.lastIncrementalRun ?? 'never'}`);
  lines.push(`Last reorganisation: ${meta.lastReorganisationRun ?? 'never'}`);
  lines.push(`Events covered: ${meta.eventsCovered} | Pages: ${pages.length}`);
  lines.push('');

  const categoryOrder = [
    'projects',
    'repos',
    'meetings',
    'contacts',
    'channels',
    'docs',
    'web',
    'apps',
  ];
  const sortedCategories = [
    ...categoryOrder.filter((c) => byCat.has(c)),
    ...[...byCat.keys()].filter((c) => !categoryOrder.includes(c)),
  ];

  for (const cat of sortedCategories) {
    const catPages = (byCat.get(cat) ?? []).sort(
      (a, b) => Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated),
    );
    if (catPages.length === 0) continue;
    lines.push(`## ${capitalise(cat)} (${catPages.length})`);
    for (const p of catPages.slice(0, 20)) {
      const slug = p.path.replace(/\.md$/, '');
      const title = extractTitle(p.content) ?? slug;
      lines.push(`- [[${slug}]] — ${title}  _(updated ${shortDate(p.lastUpdated)})_`);
    }
    if (catPages.length > 20) {
      lines.push(`- _… and ${catPages.length - 20} more_`);
    }
    lines.push('');
  }

  const archived = pages.filter((p) => p.path.startsWith('archive/'));
  if (archived.length > 0) {
    lines.push(`## Archive (${archived.length})`);
    lines.push('See [[archive/]] for stale pages.');
    lines.push('');
  }
  return lines.join('\n');
}

function renderCategorySummary(category: string, pages: IndexPage[]): IndexPage {
  const lines: string[] = [];
  lines.push(`# ${capitalise(category)} — summary`);
  lines.push(`*Auto-generated from ${pages.length} pages.*`);
  lines.push('');
  for (const p of pages.sort((a, b) => Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated))) {
    const title = extractTitle(p.content) ?? p.path;
    const excerpt = extractExcerpt(p.content);
    lines.push(`### [[${p.path.replace(/\.md$/, '')}]] — ${title}`);
    if (excerpt) lines.push(excerpt);
    lines.push('');
  }
  return {
    path: `${category}/_summary.md`,
    content: lines.join('\n'),
    sourceEventIds: pages.flatMap((p) => p.sourceEventIds).slice(-200),
    backlinks: pages.map((p) => p.path),
    lastUpdated: isoTimestamp(),
  };
}

function extractTitle(content: string): string | null {
  const m = content.match(/^#\s+(.+)$/m);
  return m && m[1] ? m[1].trim() : null;
}

function extractExcerpt(content: string): string | null {
  const stripped = content
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join(' ')
    .trim();
  if (!stripped) return null;
  return truncate(stripped, 240);
}

function shortDate(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderReorgNotes(summary: ReorganisationSummary): string {
  const parts: string[] = [];
  if (summary.archived.length) {
    parts.push(`Archived ${summary.archived.length} stale page(s): ${summary.archived.join(', ')}`);
  }
  if (summary.newSummaryPages.length) {
    parts.push(`Created summary pages: ${summary.newSummaryPages.join(', ')}`);
  }
  if (summary.merged.length) {
    parts.push(`Merged: ${summary.merged.map((m) => `${m.from.join(' + ')} → ${m.into}`).join('; ')}`);
  }
  if (summary.split.length) {
    parts.push(`Split: ${summary.split.map((s) => `${s.from} → ${s.into.join(', ')}`).join('; ')}`);
  }
  if (summary.reclassified.length) {
    parts.push(`Reclassified: ${summary.reclassified.map((r) => `${r.page} → ${r.newCategory}`).join('; ')}`);
  }
  if (summary.notes) parts.push(summary.notes);
  return parts.join('\n\n');
}

interface ReorgSuggestion {
  pages_to_merge?: Array<[string, string, string]>;
  pages_to_split?: Array<[string, string, string]>;
  pages_to_archive?: string[];
  new_summary_pages?: Array<[string, string]>;
  reclassifications?: Array<[string, string]>;
  notes?: string;
}

async function askModelForReorg(
  model: IModelAdapter,
  pages: IndexPage[],
): Promise<ReorgSuggestion | null> {
  const list = pages
    .map((p) => {
      const wc = p.content.split(/\s+/).length;
      return `- ${p.path} (${wc}w, last ${p.lastUpdated.slice(0, 10)})`;
    })
    .join('\n');

  const prompt = `CURRENT PAGE LIST:
${list}

Return JSON exactly matching this shape:
{
  "pages_to_merge": [["page_a", "page_b", "merged_title"], ...],
  "pages_to_split": [["page", "subtopic_1", "subtopic_2"], ...],
  "pages_to_archive": ["page", ...],
  "new_summary_pages": [["category", "title"], ...],
  "reclassifications": [["page", "new_category"], ...],
  "notes": "human-readable explanation"
}
Be conservative.`;

  const raw = await model.complete(prompt, {
    systemPrompt: REORG_SYSTEM_PROMPT,
    responseFormat: 'json',
    temperature: 0.1,
    maxTokens: 1024,
  });
  try {
    return JSON.parse(raw) as ReorgSuggestion;
  } catch {
    return null;
  }
}

export { slugify };
