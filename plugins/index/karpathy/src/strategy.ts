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

const SYSTEM_PROMPT = `You write concise summaries for entries in a personal knowledge wiki.
You receive STRUCTURED EVIDENCE about one entity (a project, repo, meeting, channel, doc, person, app, or webpage)
and (when applicable) the existing prose paragraph. You return ONLY the new prose — 2-4 sentences, plain markdown,
no headers, no list bullets, no metadata.

Hard rules:
- Ground every claim in the evidence. Describe what happened, the entity's role in the work, and any concrete outcome visible in the evidence.
- Never invent facts. Never describe features the evidence does not mention.
- If the evidence is thin, write a short factual sentence and stop.
- Preserve correct facts from the existing prose if you have them.
- Plain prose only. No "Summary:" prefix. No headers. No bullet lists.`;

const REORG_SYSTEM_PROMPT = `You maintain the structure of a personal knowledge wiki.
Identify structural improvements (merges, splits, archives, summary pages, reclassifications).
Be conservative — only suggest changes when the benefit is clear.
Respond with JSON only, conforming exactly to the schema in the user message.`;

const CATEGORY_SUMMARY_SYSTEM_PROMPT = `You maintain category summary pages in a personal knowledge wiki.
Write the Overview section for a category summary page.

Rules:
- Ground every claim in the supplied page facts.
- Do not invent details, names, projects, relationships, or dates.
- Prefer synthesis over copying page excerpts.
- Return only 2-4 sentences of plain markdown prose.
- Do not include headings, bullets, YAML frontmatter, HTML comments, or page metadata.
- Do not say "this category page" or "the supplied pages"; write directly about the category.`;

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

    // 2. Category summaries — for any category with > N pages. These are
    //    LLM-synthesised when a real model is available, with deterministic
    //    fallbacks for offline runs. Generated summary pages are excluded from
    //    their own inputs so summaries never recursively quote themselves.
    const byCategory = groupByCategory(
      pages.filter(
        (p) => !pagesToDelete.includes(p.path) && !isSummaryPagePath(p.path),
      ),
    );
    for (const [cat, catPages] of byCategory) {
      if (catPages.length <= this.summaryThresholdPages) continue;
      const summaryPath = `${cat}/_summary.md`;
      const summaryPage = await renderCategorySummary(cat, catPages, model);
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
    const eventsCovered = Math.max(
      prev.eventsCovered,
      sumEventCoverage(pages),
      extractEventsCovered(update.newRootIndex) ?? 0,
    );
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
  apps: string[];
  entityPaths: string[];
  windowTitles: string[];
  urls: string[];
  textSnippets: string[];
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
      addUnique(last.apps, f.app);
      addUnique(last.entityPaths, f.entity_path);
      addUnique(last.windowTitles, f.window_title);
      addUnique(last.urls, f.url);
      addUnique(last.textSnippets, readableEvidenceText(f));
    } else {
      const snippet = readableEvidenceText(f);
      windows.push({
        startedAt: f.timestamp,
        endedAt: f.timestamp,
        durationMs: f.duration_ms ?? 0,
        frameCount: 1,
        apps: f.app ? [f.app] : [],
        entityPaths: f.entity_path ? [f.entity_path] : [],
        windowTitles: f.window_title ? [f.window_title] : [],
        urls: f.url ? [f.url] : [],
        textSnippets: snippet ? [snippet] : [],
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

  // 4. Readable text snippets — pick a few non-empty, deduped excerpts.
  const seenSnippets = new Set<string>();
  const textSnippets: string[] = [];
  for (let i = sorted.length - 1; i >= 0 && textSnippets.length < MAX_TEXT_SNIPPETS; i--) {
    const f = sorted[i];
    if (
      !f ||
      !f.text ||
      !isHighConfidenceTextSource(f.text_source)
    ) continue;
    const snippet = readableEvidenceText(f);
    if (!snippet) continue;
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
  if (evidence.windows.length) {
    lines.push('RECENT ACTIVITY WINDOWS:');
    for (const w of evidence.windows.slice(0, 6)) {
      const start = w.startedAt.slice(0, 16).replace('T', ' ');
      const duration = Math.max(1, Math.round(w.durationMs / 60_000));
      const titles = w.windowTitles.slice(0, 3).map((t) => `"${truncate(t, 70)}"`).join(', ');
      const apps = w.apps.slice(0, 3).join(', ');
      const snippets = w.textSnippets.slice(0, 2).join(' | ');
      lines.push(
        `  - ${start}, ${duration}m, ${w.frameCount} frames` +
          `${apps ? `, apps: ${apps}` : ''}` +
          `${titles ? `, windows: ${titles}` : ''}` +
          `${snippets ? `, text: ${truncate(snippets, 180)}` : ''}`,
      );
    }
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
    const oldProse = extractFirstSection(existing.content, ['Summary', 'What it is']);
    if (oldProse) {
      lines.push('EXISTING PROSE (update only if evidence contradicts or extends it):');
      lines.push(oldProse);
    }
  }
  lines.push('');
  lines.push(
    'Write 2-4 sentences of plain prose summarising the useful context for this entity, grounded ONLY in the evidence above.',
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
  const apps = evidence.apps.length ? `using ${evidence.apps.slice(0, 3).join(', ')}` : '';
  const recent = evidence.windows[0];
  const recentTitles = recent?.windowTitles.slice(0, 2).map((t) => `"${truncate(t, 70)}"`).join(', ');
  const sample = [
    evidence.files.length ? `Files seen: ${evidence.files.slice(0, 5).join(', ')}.` : null,
    evidence.urls.length
      ? `URLs visited: ${evidence.urls
          .slice(0, 3)
          .map((u) => u.url)
          .join(', ')}.`
      : null,
    recentTitles ? `Recent windows included ${recentTitles}.` : null,
  ].filter(Boolean).join(' ');
  const headline =
    minutes > 0
      ? `${entity.title} was active ${span} for about ${minutes} focused minute${minutes === 1 ? '' : 's'} across ${entity.frameCount} frames${apps ? `, ${apps}` : ''}.`
      : `${entity.title} was observed ${span} across ${entity.frameCount} frame${entity.frameCount === 1 ? '' : 's'}${apps ? `, ${apps}` : ''}.`;
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

  // 2. Title + useful context sections.
  lines.push(`# ${entity.title}`);
  lines.push('');
  lines.push('## At a glance');
  lines.push(`- Type: ${entity.kind}`);
  lines.push(
    `- Observed: ${shortDate(entity.firstSeen)} -> ${shortDate(entity.lastSeen)} ` +
      `(${Math.round(entity.totalFocusedMs / 60_000)} focused min, ${entity.frameCount} frames)`,
  );
  if (evidence.apps.length) lines.push(`- Apps: ${evidence.apps.slice(0, 6).join(', ')}`);
  if (evidence.files.length) lines.push(`- Files: ${evidence.files.slice(0, 6).map((f) => `\`${f}\``).join(', ')}`);
  if (evidence.urls.length) lines.push(`- URLs: ${evidence.urls.slice(0, 3).map((u) => `<${u.url}>`).join(', ')}`);
  lines.push('');

  lines.push('## Summary');
  lines.push(prose);
  lines.push('');

  // 3. Recent work — deterministic windows with representative evidence.
  lines.push('## Recent work');
  if (evidence.windows.length === 0) {
    lines.push('_(no activity recorded)_');
  } else {
    for (const w of evidence.windows) {
      const start = w.startedAt.slice(0, 16).replace('T', ' ');
      const minutes = Math.round(w.durationMs / 60_000);
      const ago = minutes > 0 ? `${minutes}m, ` : '';
      const titles = w.windowTitles.slice(0, 3).map((t) => `"${truncate(t, 70)}"`).join(', ');
      const apps = w.apps.slice(0, 3).join(', ');
      const entities = w.entityPaths
        .filter((p) => p !== entity.path)
        .slice(0, 3)
        .map((p) => `[[${p}]]`)
        .join(', ');
      lines.push(
        `- **${start}** (${ago}${w.frameCount} frames)` +
          `${apps ? ` via ${apps}` : ''}` +
          ` — ${titles || '(no title)'}` +
          `${entities ? `; also ${entities}` : ''}`,
      );
      for (const snippet of w.textSnippets.slice(0, 2)) {
        lines.push(`  > ${truncate(snippet, 180)}`);
      }
    }
  }
  lines.push('');

  // 4. Files & URLs.
  if (evidence.files.length || evidence.urls.length) {
    lines.push('## Linked evidence');
    if (evidence.files.length) {
      lines.push('**Files:**');
      for (const f of evidence.files) lines.push(`- \`${f}\``);
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

  // 5. Readable excerpts.
  if (evidence.textSnippets.length) {
    lines.push('## Readable excerpts');
    for (const snippet of evidence.textSnippets.slice(0, 6)) {
      lines.push(`> ${truncate(snippet, 260)}`);
    }
    lines.push('');
  }

  // 6. Context gaps — tell readers when the page is thin.
  const gaps = contextGaps(entity, evidence);
  if (gaps.length) {
    lines.push('## Context gaps');
    for (const gap of gaps) lines.push(`- ${gap}`);
    lines.push('');
  }

  // 7. Top screenshots.
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
    if (!looksLikeRealFile(f)) return null;
    return f;
  }
  return null;
}

const INDEX_FILE_EXTENSIONS = new Set([
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
  if (!ext || !INDEX_FILE_EXTENSIONS.has(ext)) return false;
  if (/^[a-z]+\.com$/i.test(name)) return false;
  if (/^[a-z]+\.io$/i.test(name)) return false;
  return true;
}

function addUnique<T>(target: T[], value: T | null | undefined): void {
  if (!value) return;
  if (!target.includes(value)) target.push(value);
}

function readableEvidenceText(frame: Frame): string | null {
  if (!isHighConfidenceTextSource(frame.text_source)) return null;
  if (!frame.text) return null;
  const cleaned = frame.text.replace(/\s+/g, ' ').trim();
  if (cleaned.length < 35) return null;
  const chars = cleaned.replace(/\s/g, '');
  if (!chars) return null;
  const readable = chars.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (readable / chars.length < 0.55) return null;
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const usefulWords = cleaned.match(/[\p{L}\p{N}][\p{L}\p{N}'._/-]{2,}/gu) ?? [];
  if (usefulWords.length < 5) return null;
  const shortTokens = tokens.filter((token) => token.replace(/[^\p{L}\p{N}]/gu, '').length <= 2);
  if (tokens.length > 0 && shortTokens.length / tokens.length > 0.45) return null;
  return truncate(cleaned, 240);
}

function isHighConfidenceTextSource(source: Frame['text_source']): boolean {
  return source === 'accessibility' || source === 'audio';
}

function contextGaps(entity: EntityRecord, evidence: Evidence): string[] {
  const gaps: string[] = [];
  if (entity.frameCount <= 3) {
    gaps.push('Very little evidence was captured; treat this page as a pointer, not a complete history.');
  }
  if (evidence.textSnippets.length === 0) {
    gaps.push('No reliable readable text was extracted, so screenshots and window titles carry most of the context.');
  }
  if (entity.kind === 'contact' || entity.kind === 'channel') {
    gaps.push('Conversation substance may be incomplete unless Slack text was visible in the captured frames.');
  }
  return gaps;
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
  const lines = content.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return null;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break;
    out.push(line);
  }
  const section = out.join('\n').trim();
  return section || null;
}

function extractFirstSection(content: string, headings: string[]): string | null {
  for (const heading of headings) {
    const section = extractSection(content, heading);
    if (section) return section;
  }
  return null;
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

function extractEventsCovered(rootIndex: string): number | null {
  const match = rootIndex.match(/Events covered:\s*(\d+)/);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
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
  const nonArchived = pages.filter((p) => !p.path.startsWith('archive/'));
  const byCat = groupByCategory(nonArchived.filter((p) => !isSummaryPagePath(p.path)));
  const summaryByCategory = new Map<string, IndexPage>();
  for (const p of nonArchived) {
    if (!isSummaryPagePath(p.path)) continue;
    const cat = p.path.split('/')[0];
    if (cat) summaryByCategory.set(cat, p);
  }
  const lines: string[] = [];
  lines.push('# CofounderOS — index');
  lines.push('');
  lines.push(`Last incremental run: ${meta.lastIncrementalRun ?? 'never'}`);
  lines.push(`Last reorganisation: ${meta.lastReorganisationRun ?? 'never'}`);
  lines.push(
    `Events covered: ${meta.eventsCovered} | Pages: ${pages.length}` +
      ` | Summaries: ${summaryByCategory.size}`,
  );
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
    const summaryPage = summaryByCategory.get(cat);
    if (summaryPage) {
      lines.push(`Summary: [[${summaryPage.path.replace(/\.md$/, '')}]]`);
    }
    for (const p of catPages.slice(0, 20)) {
      const slug = p.path.replace(/\.md$/, '');
      const title = extractTitle(p.content) ?? slug;
      const summary = extractPageSummary(p.content, 180);
      const detail = summary && summary.toLowerCase() !== title.toLowerCase()
        ? `${title} — ${summary}`
        : title;
      const stats = extractEntityStats(p.content);
      lines.push(
        `- [[${slug}]] — ${detail}` +
          `${stats ? `  _(${stats})_` : ''}` +
          `  _(updated ${shortDate(p.lastUpdated)})_`,
      );
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

async function renderCategorySummary(
  category: string,
  pages: IndexPage[],
  model: IModelAdapter,
): Promise<IndexPage> {
  const modelName = model.getModelInfo().name;
  const isOfflineModel = modelName === 'offline:fallback';
  const overview = isOfflineModel
    ? renderDeterministicCategoryOverview(category, pages)
    : await renderModelCategoryOverview(category, pages, model);

  const lines: string[] = [];
  lines.push(`# ${capitalise(category)} — summary`);
  lines.push(`*Auto-generated from ${pages.length} pages.*`);
  lines.push('');
  lines.push(renderCategorySummaryContent(pages, overview));
  return {
    path: `${category}/_summary.md`,
    content: lines.join('\n'),
    sourceEventIds: pages.flatMap((p) => p.sourceEventIds).slice(-200),
    backlinks: pages.map((p) => p.path),
    lastUpdated: isoTimestamp(),
  };
}

async function renderModelCategoryOverview(
  category: string,
  pages: IndexPage[],
  model: IModelAdapter,
): Promise<string> {
  const prompt = buildCategoryOverviewPrompt(category, pages);
  try {
    const raw = await model.complete(prompt, {
      systemPrompt: CATEGORY_SUMMARY_SYSTEM_PROMPT,
      temperature: 0.2,
      maxTokens: 220,
    });
    const cleaned = cleanGeneratedOverview(raw, category);
    return cleaned || renderDeterministicCategoryOverview(category, pages);
  } catch {
    return renderDeterministicCategoryOverview(category, pages);
  }
}

function buildCategoryOverviewPrompt(category: string, pages: IndexPage[]): string {
  const sorted = pages
    .slice()
    .sort((a, b) => Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated))
    .slice(0, 30);

  const lines: string[] = [];
  lines.push(`CATEGORY: ${category}`);
  lines.push(`PAGE COUNT: ${pages.length}`);
  lines.push('');
  lines.push('PAGES:');
  for (const p of sorted) {
    const slug = p.path.replace(/\.md$/, '');
    const title = extractTitle(p.content) ?? slug;
    const summary = extractPageSummary(p.content, 260);
    const stats = extractEntityStats(p.content);
    lines.push(`- [[${slug}]]`);
    lines.push(`  title: ${title}`);
    lines.push(`  updated: ${shortDate(p.lastUpdated)}`);
    if (stats) lines.push(`  stats: ${stats}`);
    if (summary) lines.push(`  summary: ${summary}`);
  }
  lines.push('');
  lines.push('Write only the overview prose now.');
  return lines.join('\n');
}

function renderCategorySummaryContent(
  pages: IndexPage[],
  overview: string,
): string {
  const recent = pages
    .slice()
    .sort((a, b) => Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated));
  const notable = recent.slice(0, 12);
  const lines: string[] = [];
  lines.push('## Overview');
  lines.push(overview);
  lines.push('');
  lines.push('## Notable pages');
  for (const p of notable) {
    lines.push(renderSummaryPageBullet(p));
  }
  lines.push('');
  lines.push('## Recent changes');
  for (const p of recent.slice(0, 6)) {
    const slug = p.path.replace(/\.md$/, '');
    const title = extractTitle(p.content) ?? slug;
    lines.push(`- [[${slug}]] — ${title} _(updated ${shortDate(p.lastUpdated)})_`);
  }
  return lines.join('\n');
}

function renderDeterministicCategoryOverview(
  category: string,
  pages: IndexPage[],
): string {
  return `${capitalise(category)} contains ${pages.length} indexed page${pages.length === 1 ? '' : 's'}. ` +
    'The deterministic sections below list the most recently updated pages with their generated summaries.';
}

function renderSummaryPageBullet(page: IndexPage): string {
  const slug = page.path.replace(/\.md$/, '');
  const title = extractTitle(page.content) ?? slug;
  const summary = extractPageSummary(page.content, 180);
  const stats = extractEntityStats(page.content);
  return `- [[${slug}]] — ${summary ? `${title}: ${summary}` : title}` +
    `${stats ? ` _(${stats})_` : ''}`;
}

function cleanGeneratedOverview(text: string, category: string): string {
  const cleaned = text
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .split('\n')
    .filter((line) => !line.startsWith('<!-- cofounderos:meta'))
    .filter((line) => !/^---\s*$/.test(line.trim()))
    .filter((line) => !/^#{1,6}\s+/.test(line))
    .filter((line) => !/^\s*[-*]\s+/.test(line))
    .join('\n')
    .replace(/\s+/g, ' ')
    .replace(/^This category page summarizes\s+/i, `The ${category} category summarizes `)
    .replace(/^This category page contains\s+/i, `The ${category} category contains `)
    .replace(/^This category page provides\s+/i, `The ${category} category provides `)
    .replace(/\bthis category page\b/gi, `the ${category} category`)
    .trim();
  const prose = trimToProse(cleaned);
  return prose ? prose.charAt(0).toUpperCase() + prose.slice(1) : prose;
}

function extractTitle(content: string): string | null {
  const m = content.match(/^#\s+(.+)$/m);
  return m && m[1] ? m[1].trim() : null;
}

function extractPageSummary(content: string, maxChars: number): string | null {
  const summary = extractFirstSection(content, ['Summary', 'What it is']);
  const source = summary || stripMarkdownBoilerplate(content);
  const stripped = source
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .filter((l) => !l.startsWith('!['))
    .filter((l) => !l.startsWith('**Files:**'))
    .filter((l) => !l.startsWith('**URLs:**'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  return truncate(stripped, maxChars);
}

function stripMarkdownBoilerplate(content: string): string {
  return content
    .replace(/<!-- cofounderos:meta[\s\S]*?-->\s*/g, '')
    .replace(/^---\n[\s\S]*?\n---\s*/m, '')
    .trim();
}

function extractEntityStats(content: string): string | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---/m);
  if (!fm || !fm[1]) return null;
  const get = (key: string): string | null => {
    const m = fm[1]!.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m && m[1] ? m[1].replace(/^"|"$/g, '').trim() : null;
  };
  const kind = get('kind');
  const minutes = get('total_focused_minutes');
  const frames = get('frame_count');
  const parts = [
    kind,
    minutes ? `${minutes}m` : null,
    frames ? `${frames} frames` : null,
  ].filter(Boolean);
  return parts.length ? parts.join('; ') : null;
}

function isSummaryPagePath(pagePath: string): boolean {
  return path.basename(pagePath) === '_summary.md';
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
