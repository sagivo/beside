import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type {
  EntityKind,
  EntityRecord,
  Frame,
  IIndexStrategy,
  IModelAdapter,
  IndexPage,
  IndexState,
  IndexUpdate,
  IStorage,
  Logger,
  Meeting,
  RawEvent,
  ReorganisationSummary,
} from '@beside/interfaces';
import { isoTimestamp } from '@beside/core';
import { slugify } from './bucketer.js';
import { PageStore } from './page-store.js';
import { dayPagePath, renderDayPage } from './day-page.js';

const STRATEGY_NAME = 'karpathy';

/**
 * How many entity-page renders run concurrently against the model
 * during `indexBatch`. `model.complete()` is the wall — gemma4:e4b
 * takes 5–10s per call on Apple Silicon — and Ollama serves up to
 * `OLLAMA_NUM_PARALLEL` (default 4 on systems with ≥6 GB free RAM)
 * concurrent requests for the same model. Sequential renders left
 * 3 of those slots idle. 4 matches the ollama default; raise via
 * `system.indexer_render_concurrency` for hosts that can spare more
 * VRAM/parallel slots.
 */
const DEFAULT_RENDER_CONCURRENCY = 4;

/**
 * Pick an effective render concurrency based on current system load.
 * Apple Silicon's UMA design means our renders share GPU bandwidth
 * with whatever else the user is running (browser/Slack/IDE), so a
 * fixed 4-wide fan-out can saturate the system on a busy machine.
 *
 *   loadavg-per-core < 0.5  → use the configured maximum
 *   loadavg-per-core 0.5–0.85 → halve it (rounded up, min 1)
 *   loadavg-per-core ≥ 0.85 → drop to 1 (single-flight)
 *
 * `os.loadavg()` is a 1-minute moving average so this is naturally
 * smoothed; we don't oscillate batch-to-batch on transient spikes.
 * On platforms where loadavg returns 0 (Windows) we keep the max.
 */
function effectiveRenderConcurrency(maxLanes: number): number {
  const cpuCount = Math.max(1, os.cpus().length);
  const [oneMin] = os.loadavg();
  if (!Number.isFinite(oneMin) || oneMin <= 0) return maxLanes;
  const normalised = oneMin / cpuCount;
  if (normalised < 0.5) return maxLanes;
  if (normalised < 0.85) return Math.max(1, Math.ceil(maxLanes / 2));
  return 1;
}

/**
 * Bounded concurrent-map without a runtime dep on p-limit. Preserves
 * input order in the output. Errors propagate (Promise.all-style); the
 * caller's renderEntityPage catches model errors and falls back to
 * deterministic prose, so an in-flight LLM hiccup doesn't unwind the
 * whole batch.
 */
async function pmap<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  const workers = Array.from({ length: lanes }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

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
   * How many entity-page renders the strategy fans out per batch.
   * Caps Ollama's parallel slot usage on a shared model. Default 4
   * matches OLLAMA_NUM_PARALLEL's default on systems with >=6GB free.
   */
  render_concurrency?: number;
  /**
   * Whether the day-page narrative can be rendered with text-only models.
   * Vision models always get a narrative; text-only models only get one
   * when this is true. Default true — continuous journaling is the
   * primary value of day pages so we'd rather have a text narrative
   * than none.
   */
  day_page_narrative_text_enabled?: boolean;
  /**
   * Per-day-page narrative call timeout. Vision is slow on big models
   * (~30-60s); the cap is generous but bounded so a single hung call
   * doesn't stall the whole incremental batch.
   */
  day_page_narrative_timeout_ms?: number;
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
  'beside', // the host app itself
  'audio', // synthetic audio_transcript fallback entity
]);

function isNoiseAppEntity(entityPath: string): boolean {
  if (!entityPath.startsWith('apps/')) return false;
  return NOISE_APP_SLUGS.has(entityPath.slice('apps/'.length));
}

function pageHasMeaningfulChanges(existing: IndexPage, next: IndexPage): boolean {
  if (
    normaliseVolatileIndexContent(existing.content) !==
    normaliseVolatileIndexContent(next.content)
  ) {
    return true;
  }
  if (!stringArraysEqual(existing.sourceEventIds, next.sourceEventIds)) return true;
  if (!stringArraysEqual(existing.backlinks, next.backlinks)) return true;
  return false;
}

function normaliseVolatileIndexContent(content: string): string {
  return content.replace(/^last_indexed: .+$/m, 'last_indexed: <volatile>');
}

function stringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Days touched by this incremental batch — the dirty-set for day pages.
 * We derive the day from each event's local timestamp slice (YYYY-MM-DD).
 * Cheap and tolerant of clock skew: any frame that landed counts toward
 * its calendar day exactly once.
 */
function collectDirtyDays(events: RawEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (!e.timestamp || e.timestamp.length < 10) continue;
    out.add(e.timestamp.slice(0, 10));
  }
  return out;
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
  private readonly renderConcurrency: number;
  private readonly dataDir: string;
  private readonly dayPageNarrativeTextEnabled: boolean;
  private readonly dayPageNarrativeTimeoutMs: number;
  private store!: PageStore;
  /**
   * Captured on the first `getUnindexedEvents` call. We use it inside
   * `indexBatch` to fetch entities + frames since the IIndexStrategy
   * contract doesn't pass `IStorage` into that method directly.
   */
  private storage: IStorage | null = null;
  /**
   * Per-batch cache of `storage.getEntity()` lookups. Reset at the top of
   * every `indexBatch` so we don't grow unbounded across a full reindex.
   * `null` entries cache misses too — many entity paths queried by
   * `listEntitiesTouchedByEvents` are transient apps that never get a row.
   */
  private entityLookupCache = new Map<string, EntityRecord | null>();

  constructor(
    private readonly config: StrategyConfig,
    logger: Logger,
    opts: { dataDir?: string } = {},
  ) {
    this.logger = logger.child(`index-${STRATEGY_NAME}`);
    this.batchSize = config.batch_size ?? 50;
    this.archiveAfterDays = config.archive_after_days ?? 30;
    this.summaryThresholdPages = config.summary_threshold_pages ?? 5;
    this.appPageMinMs = (config.app_page_min_minutes ?? 5) * 60_000;
    this.appPageMinFrames = config.app_page_min_frames ?? 20;
    this.renderConcurrency = Math.max(
      1,
      config.render_concurrency ?? DEFAULT_RENDER_CONCURRENCY,
    );
    this.dataDir = opts.dataDir ?? os.homedir();
    this.dayPageNarrativeTextEnabled = config.day_page_narrative_text_enabled ?? true;
    this.dayPageNarrativeTimeoutMs = config.day_page_narrative_timeout_ms ?? 120_000;
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
  private async shouldRenderEntityPage(entity: EntityRecord): Promise<boolean> {
    if (entity.kind === 'meeting') return await this.shouldRenderMeetingEntity(entity);
    if (entity.kind !== 'app') return true;
    if (isNoiseAppEntity(entity.path)) return false;
    if (entity.totalFocusedMs < this.appPageMinMs) return false;
    if (entity.frameCount < this.appPageMinFrames) return false;
    return true;
  }

  private async shouldRenderMeetingEntity(entity: EntityRecord): Promise<boolean> {
    const meetings = await this.listMeetingsForEntity(entity);
    if (meetings.length > 0) return meetings.some(isSubstantiveMeeting);
    return entity.totalFocusedMs >= 5 * 60_000 && entity.frameCount >= 6;
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

    // Reset per-batch entity cache so the dedupe in
    // listEntitiesTouchedByEvents kicks in for this batch but doesn't
    // grow unbounded across a long-running reindex.
    this.entityLookupCache.clear();

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
    for (const entity of await this.listEntitiesTouchedByEvents(events)) {
      dirtyByPath.set(entity.path, entity);
    }

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
    let skippedHashUnchanged = 0;
    let modelCallsAvoided = 0;

    type PreparedTask =
      | {
          kind: 'render';
          entity: EntityRecord;
          frames: Frame[];
          existing: IndexPage | null;
          pagePath: string;
        }
      | { kind: 'skip-noise'; pagePath: string; existed: boolean }
      | { kind: 'skip-empty'; pagePath: string };

    // Phase A: cheap, sequential prep pass — DB reads + filters. We
    // intentionally keep this serial (better-sqlite3 is synchronous;
    // running the queries concurrently doesn't help) and only fan out
    // the LLM-bound `renderEntityPage` calls below.
    //
    // Filter ordering matters: `shouldRenderEntityPage` is a pure
    // entity-property check (kind, focused-time, frame-count) with NO
    // DB I/O. Run it FIRST so we can short-circuit ~25-30% of the
    // dirty set (the noise/below-threshold app entities) without
    // paying for the 500-row `getEntityFrames` lookup or the page-read.
    // For entities that don't have an existing page either, we don't
    // even need `readPage` — they have nothing to delete.
    const prepared: PreparedTask[] = [];
    for (const entity of dirtyByPath.values()) {
      const pagePath = `${entity.path}.md`;
      if (!(await this.shouldRenderEntityPage(entity))) {
        // Cheap path. Only read the page to know if we need to issue
        // a delete; for noise app entities the page rarely exists.
        const existing = await this.store.readPage(pagePath);
        prepared.push({ kind: 'skip-noise', pagePath, existed: !!existing });
        continue;
      }
      // 500 was the historical default but `buildEvidence` only
      // surfaces MAX_KEYFRAMES (3) + MAX_WINDOWS (12) + MAX_TEXT_SNIPPETS (8)
      // worth of frames into the prompt. 250 covers any plausible recent
      // window with comfortable headroom and halves DB read time on
      // hot entities — a measurable win when the dirty set is large.
      const frames = await this.storage.getEntityFrames(entity.path, 250);
      if (frames.length === 0) {
        prepared.push({ kind: 'skip-empty', pagePath });
        continue;
      }
      const existing = await this.store.readPage(pagePath);
      prepared.push({ kind: 'render', entity, frames, existing, pagePath });
    }

    skippedNoise = prepared.reduce(
      (n, t) => n + (t.kind === 'skip-noise' ? 1 : 0),
      0,
    );
    for (const task of prepared) {
      if (task.kind === 'skip-noise' && task.existed) {
        pagesToDelete.push(task.pagePath);
      }
    }

    // Phase B: render dirty entities in parallel against the model.
    // `pmap` caps concurrency to `DEFAULT_RENDER_CONCURRENCY` so we
    // never overwhelm Ollama's `num_parallel` slots; pages flow through
    // independently. Each renderEntityPage internally hashes evidence
    // first and returns the existing page unchanged when the hash
    // matches — that's where we eliminate the bulk of redundant LLM
    // calls on incremental + full reindex.
    const renderTasks = prepared.filter(
      (t): t is Extract<PreparedTask, { kind: 'render' }> => t.kind === 'render',
    );
    // Adapt the lane count to current system load. Keeps the indexer
    // a polite citizen on an already-busy machine — running a build,
    // a Zoom call, or a heavy IDE session won't get crushed by a 4-way
    // fan-out into ollama. When the box is idle we use the configured
    // max for fastest reindex.
    const concurrency = effectiveRenderConcurrency(this.renderConcurrency);
    if (concurrency < this.renderConcurrency && renderTasks.length > 0) {
      this.logger.debug(
        `render concurrency throttled to ${concurrency} (system load high)`,
      );
    }
    const rendered = await pmap(renderTasks, concurrency, async (task) => {
      try {
        const result = await this.renderEntityPage(
          task.entity,
          task.frames,
          task.existing,
          model,
        );
        return { ...task, page: result.page, reused: result.reused };
      } catch (err) {
        this.logger.warn('renderEntityPage failed; skipping entity', {
          path: task.entity.path,
          err: String(err),
        });
        return { ...task, page: null, reused: false };
      }
    });

    for (const out of rendered) {
      if (!out.page) continue;
      if (out.reused) modelCallsAvoided += 1;
      if (out.existing) {
        if (pageHasMeaningfulChanges(out.existing, out.page)) {
          pagesToUpdate.push(out.page);
        } else if (out.reused) {
          // Evidence hash matched and no rendered diff — skip writes
          // entirely to avoid re-touching the file (and the manifest)
          // for a no-op update.
          skippedHashUnchanged += 1;
        }
      } else {
        pagesToCreate.push(out.page);
      }
    }

    // Phase C: render day pages for any day touched by this batch. Day
    // pages live alongside entity pages so they flow through the same
    // `onPageUpdate` → markdown export mirror, search/embeddings, and
    // archive lanes — no parallel pipeline needed. Re-rendered every
    // tick but gated by an evidence hash so identical days short-circuit
    // without an LLM call.
    const dirtyDays = collectDirtyDays(events);
    const dayRenders = await pmap(
      [...dirtyDays],
      Math.min(2, concurrency),
      async (day) => {
        try {
          const existing = await this.store.readPage(dayPagePath(day));
          return {
            day,
            existing,
            result: await renderDayPage(day, existing, {
              storage: this.storage!,
              model,
              dataDir: this.dataDir,
              logger: this.logger,
              narrativeTextEnabled: this.dayPageNarrativeTextEnabled,
              narrativeTimeoutMs: this.dayPageNarrativeTimeoutMs,
            }),
          };
        } catch (err) {
          this.logger.warn('renderDayPage failed; skipping day', { day, err: String(err) });
          return { day, existing: null, result: null };
        }
      },
    );
    let dayPagesCreated = 0;
    let dayPagesUpdated = 0;
    let dayPagesUnchanged = 0;
    for (const r of dayRenders) {
      if (!r.result) continue;
      if (r.result.reused && r.existing) {
        dayPagesUnchanged += 1;
        continue;
      }
      if (r.existing) {
        if (pageHasMeaningfulChanges(r.existing, r.result.page)) {
          pagesToUpdate.push(r.result.page);
          dayPagesUpdated += 1;
        } else {
          dayPagesUnchanged += 1;
        }
      } else {
        pagesToCreate.push(r.result.page);
        dayPagesCreated += 1;
      }
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
    const cacheSuffix = modelCallsAvoided > 0
      ? ` [cache: ${modelCallsAvoided} hash-skip${modelCallsAvoided === 1 ? '' : 's'}` +
        `${skippedHashUnchanged > 0 ? `, ${skippedHashUnchanged} no-write` : ''}]`
      : '';
    const daySuffix = dirtyDays.size > 0
      ? ` [days: ${dayPagesCreated} new + ${dayPagesUpdated} updated + ${dayPagesUnchanged} unchanged]`
      : '';
    this.logger.info(
      `karpathy: ${pagesToCreate.length} new + ${pagesToUpdate.length} updated + ${pagesToDelete.length} deleted pages` +
        ` from ${dirtyByPath.size} active entities${noiseSuffix}${cacheSuffix}${daySuffix}`,
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
        if (!entity || !(await this.shouldRenderEntityPage(entity))) {
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
    await this.store.applyPageChanges(
      [...update.pagesToCreate, ...update.pagesToUpdate],
      update.pagesToDelete,
    );

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
  ): Promise<{ page: IndexPage; reused: boolean }> {
    const meetingDigests = await this.listMeetingDigestsForEntity(entity);
    const pageEntity = entityForPage(entity, meetingDigests);
    const related = await this.listRelatedEntitiesForEntity(entity);
    const evidence = buildEvidence(pageEntity, frames, meetingDigests, related);

    // Evidence-hash skip-cache. The dirty-set computation is coarse —
    // any entity whose `last_seen` advanced lands in `dirtyByPath`,
    // even if the new frames don't materially change what we'd
    // summarise. By hashing the canonicalised evidence we can detect
    // "nothing actually new here" and reuse the previous page without
    // a model call. This is the primary lever that keeps incremental
    // reindexes cheap once the initial pass has rendered everything.
    const evidenceHash = computeEvidenceHash(pageEntity, evidence);
    if (existing && existing.evidenceHash === evidenceHash) {
      const existingProse =
        extractFirstSection(existing.content, ['Summary', 'What it is']) ??
        renderDeterministicProse(pageEntity, evidence);
      const content = renderEntityMarkdown(pageEntity, evidence, existingProse);
      return {
        page: {
          ...existing,
          content,
          sourceEventIds: evidence.sourceEventIds.slice(-500),
          lastUpdated: content === existing.content ? existing.lastUpdated : isoTimestamp(),
        },
        reused: true,
      };
    }

    const isOfflineModel = model.getModelInfo().name === 'offline:fallback';

    let prose: string;
    if (isOfflineModel) {
      prose = renderDeterministicProse(pageEntity, evidence);
    } else {
      const prompt = buildEvidencePrompt(existing, pageEntity, evidence);
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
        if (!prose) prose = renderDeterministicProse(pageEntity, evidence);
      } catch (err) {
        this.logger.warn('model.complete failed, falling back to deterministic prose', {
          err: String(err),
        });
        prose = renderDeterministicProse(pageEntity, evidence);
      }
    }

    const content = renderEntityMarkdown(pageEntity, evidence, prose);

    return {
      page: {
        path: `${entity.path}.md`,
        content,
        sourceEventIds: evidence.sourceEventIds.slice(-500),
        backlinks: existing?.backlinks ?? [],
        lastUpdated: isoTimestamp(),
        evidenceHash,
      },
      reused: false,
    };
  }

  private async listMeetingsForEntity(entity: EntityRecord): Promise<Meeting[]> {
    if (entity.kind !== 'meeting' || !this.storage) return [];
    try {
      const meetings = await this.storage.listMeetings({
        day: entity.firstSeen.slice(0, 10),
        limit: 500,
        order: 'chronological',
      });
      return meetings
        .filter((meeting) => meeting.entity_path === entity.path)
        .sort((a, b) => a.started_at.localeCompare(b.started_at))
        .slice(-8);
    } catch (err) {
      this.logger.debug('meeting summaries unavailable for entity page', {
        entity: entity.path,
        err: String(err),
      });
      return [];
    }
  }

  private async listMeetingDigestsForEntity(entity: EntityRecord): Promise<MeetingDigest[]> {
    const meetings = await this.listMeetingsForEntity(entity);
    const substantive = meetings.filter(isSubstantiveMeeting);
    const source = substantive.length > 0 ? substantive : meetings;
    return source.slice(-6).map(meetingToDigest);
  }

  private async listRelatedEntitiesForEntity(entity: EntityRecord): Promise<RelatedEntityDigest[]> {
    if (!this.storage) return [];
    try {
      const rows = await this.storage.listEntityCoOccurrences(entity.path, 16);
      return rows
        .filter((row) => row.path !== entity.path)
        .filter((row) => !isNoiseAppEntity(row.path))
        .filter((row) => row.kind !== 'app' || row.sharedFocusedMs >= 60_000)
        .slice(0, 8)
        .map((row) => ({
          path: row.path,
          kind: row.kind,
          title: row.title,
          sharedSessions: row.sharedSessions,
          sharedFocusedMs: row.sharedFocusedMs,
          lastSharedAt: row.lastSharedAt,
        }));
    } catch (err) {
      this.logger.debug('entity related-context lookup failed', {
        entity: entity.path,
        err: String(err),
      });
      return [];
    }
  }

  private async listEntitiesTouchedByEvents(events: RawEvent[]): Promise<EntityRecord[]> {
    if (!this.storage || events.length === 0) return [];
    // Date.parse is faster than the spread+Math.min pattern, which builds a
    // throwaway array and applies Math.min via apply(); for batches of a few
    // thousand timestamps this matters during heavy reindex.
    let minTs = Number.POSITIVE_INFINITY;
    let maxTs = Number.NEGATIVE_INFINITY;
    let any = false;
    for (const event of events) {
      const t = Date.parse(event.timestamp);
      if (!Number.isFinite(t)) continue;
      if (t < minTs) minTs = t;
      if (t > maxTs) maxTs = t;
      any = true;
    }
    if (!any) return [];

    const from = new Date(minTs - 1_000).toISOString();
    const to = new Date(maxTs + 1_000).toISOString();
    const frames = await this.storage.searchFrames({
      from,
      to,
      limit: Math.max(500, events.length * 20),
    });
    const paths = new Set(
      frames
        .map((frame) => frame.entity_path)
        .filter((path): path is string => Boolean(path)),
    );
    // De-duplicate getEntity() calls within a single batch. The same entity
    // path is frequently touched by many events (Slack thread, recurring
    // meeting URL, IDE project) and re-fetching its row from SQLite for
    // every occurrence multiplies index batches' DB cost. The lookup is
    // already O(1) on the SQLite side but the round-trip is non-trivial.
    const out: EntityRecord[] = [];
    for (const path of paths) {
      const cached = this.entityLookupCache.get(path);
      if (cached !== undefined) {
        if (cached) out.push(cached);
        continue;
      }
      const entity = await this.storage.getEntity(path);
      this.entityLookupCache.set(path, entity ?? null);
      if (entity) out.push(entity);
    }
    return out;
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
  meetings: MeetingDigest[];
  related: RelatedEntityDigest[];
  files: string[];
  urls: Array<{ url: string; title: string | null; lastSeen: string }>;
  textSnippets: string[];
  apps: string[];
  sourceEventIds: string[];
  sourceFrameIds: string[];
  keyframes: Array<{ frameId: string; assetPath: string; timestamp: string; phash: string | null }>;
}

interface MeetingDigest {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string;
  durationMin: number;
  summaryStatus: string;
  tldr: string | null;
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
  attendees: string[];
  links: string[];
}

interface RelatedEntityDigest {
  path: string;
  kind: EntityKind;
  title: string;
  sharedSessions: number;
  sharedFocusedMs: number;
  lastSharedAt: string;
}

const SESSION_GAP_MS = 60_000;
const MAX_WINDOWS = 12;
const MAX_TEXT_SNIPPETS = 8;
const MAX_KEYFRAMES = 3;

function buildEvidence(
  _entity: EntityRecord,
  frames: Frame[],
  meetings: MeetingDigest[] = [],
  related: RelatedEntityDigest[] = [],
): Evidence {
  const sorted = frames.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const sourceFrameIds = [...new Set(sorted.map((frame) => frame.id))];
  const sourceEventIds = [...new Set(sorted.flatMap((frame) => frame.source_event_ids ?? []))];

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
  //
  // The naive implementation re-scanned every keyframe for every candidate
  // on every iteration (O(MAX_KEYFRAMES² · N)) and also did a linear
  // `keyframes.some()` containment check per candidate. We instead keep an
  // incremental `bestDist[i]` array (each candidate's min distance to *any*
  // already-selected keyframe) plus a Set for the seen asset_paths. Adding
  // a keyframe costs O(N) work; selecting the next one costs O(N) — total
  // O(MAX_KEYFRAMES · N). For high-evidence entities with hundreds of
  // candidate frames this turns the inner block from ~hundreds of thousands
  // of hammingDistance calls into ~thousands.
  const candidates = sorted.filter(
    (f): f is Frame & { asset_path: string } =>
      Boolean(f.asset_path) && Boolean(f.perceptual_hash),
  );
  const keyframes: Array<{ frameId: string; assetPath: string; timestamp: string; phash: string | null }> = [];
  if (candidates.length > 0) {
    const phashes = candidates.map((c) => c.perceptual_hash);
    const seenPaths = new Set<string>();
    const bestDist: number[] = new Array(candidates.length).fill(
      Number.POSITIVE_INFINITY,
    );

    const selectKeyframe = (idx: number): void => {
      const c = candidates[idx]!;
      if (seenPaths.has(c.asset_path)) return;
      keyframes.push({
        frameId: c.id,
        assetPath: c.asset_path,
        timestamp: c.timestamp,
        phash: c.perceptual_hash,
      });
      seenPaths.add(c.asset_path);
      const newPhash = phashes[idx]!;
      for (let i = 0; i < candidates.length; i++) {
        if (seenPaths.has(candidates[i]!.asset_path)) continue;
        const d = hammingDistance(newPhash, phashes[i]!);
        if (d < bestDist[i]!) bestDist[i] = d;
      }
    };

    // Seed with the first candidate (preserves prior behaviour).
    selectKeyframe(0);
    while (keyframes.length < MAX_KEYFRAMES) {
      let bestIdx = -1;
      let bestMin = -1;
      for (let i = 0; i < candidates.length; i++) {
        if (seenPaths.has(candidates[i]!.asset_path)) continue;
        if (bestDist[i]! > bestMin) {
          bestMin = bestDist[i]!;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break;
      selectKeyframe(bestIdx);
    }
  } else {
    // Fall back to *any* frame with an asset_path even if no phash.
    for (const f of sorted) {
      if (!f.asset_path) continue;
      keyframes.push({
        frameId: f.id,
        assetPath: f.asset_path,
        timestamp: f.timestamp,
        phash: f.perceptual_hash,
      });
      if (keyframes.length >= MAX_KEYFRAMES) break;
    }
  }

  return {
    windows: windows.slice(-MAX_WINDOWS).reverse(),
    meetings,
    related,
    files: [...files].slice(0, 20),
    urls: [...urlMap.entries()]
      .map(([url, info]) => ({ url, title: info.title, lastSeen: info.lastSeen }))
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
      .slice(0, 10),
    textSnippets,
    apps,
    sourceEventIds,
    sourceFrameIds,
    keyframes,
  };
}

function meetingToDigest(meeting: Meeting): MeetingDigest {
  const summary = meeting.summary_json;
  const rawTitle = summary?.title ?? meeting.title ?? fallbackTitleFromEntityPath(meeting.entity_path);
  return {
    id: meeting.id,
    title: cleanMeetingTitle(rawTitle),
    startedAt: meeting.started_at,
    endedAt: meeting.ended_at,
    durationMin: Math.max(1, Math.round(meeting.duration_ms / 60_000)),
    summaryStatus: meeting.summary_status,
    tldr: summary?.tldr || firstMarkdownParagraph(meeting.summary_md),
    decisions: (summary?.decisions ?? []).map((d) => d.text).filter(Boolean).slice(0, 8),
    actionItems: (summary?.action_items ?? [])
      .map((item) => {
        const owner = item.owner ? `${item.owner}: ` : '';
        const due = item.due ? ` (due ${item.due})` : '';
        return `${owner}${item.task}${due}`.trim();
      })
      .filter(Boolean)
      .slice(0, 8),
    openQuestions: (summary?.open_questions ?? []).map((q) => q.text).filter(Boolean).slice(0, 8),
    attendees: uniqueStrings([...(meeting.attendees ?? []), ...(summary?.attendees_seen ?? [])]).slice(0, 12),
    links: uniqueStrings([...(meeting.links ?? []), ...(summary?.links_shared ?? [])]).slice(0, 12),
  };
}

function isSubstantiveMeeting(meeting: Meeting): boolean {
  if (meeting.summary_status === 'ready') return true;
  if (meeting.duration_ms >= 5 * 60_000) return true;
  if (meeting.duration_ms >= 60_000 && meeting.screenshot_count >= 3) return true;
  if (meeting.transcript_chars >= 500) return true;
  if (meeting.audio_chunk_count >= 2) return true;
  return false;
}

function entityForPage(entity: EntityRecord, meetings: MeetingDigest[]): EntityRecord {
  if (entity.kind !== 'meeting' || meetings.length === 0) return entity;
  const best = meetings
    .slice()
    .sort((a, b) => b.durationMin - a.durationMin)[0];
  if (!best?.title) return entity;
  return { ...entity, title: best.title };
}

function fallbackTitleFromEntityPath(entityPath: string): string {
  const last = entityPath.split('/').pop() ?? entityPath;
  return last
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function cleanMeetingTitle(title: string): string {
  const cleaned = title.replace(/\s+/g, ' ').trim();
  const parts = cleaned
    .split(/\s+-\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !isMeetingTitleNoiseSegment(part));
  const out = parts.length > 0 ? parts.join(' - ') : cleaned;
  return truncate(out, 90);
}

function isMeetingTitleNoiseSegment(segment: string): boolean {
  return /^(camera and microphone recording|microphone recording|audio playing|screen share|high memory usage\b.*|\d+(?:\.\d+)?\s*(?:kb|mb|gb)|google chrome|chrome|you \(your chrome\)|profile)$/i.test(segment);
}

function firstMarkdownParagraph(markdown: string | null): string | null {
  if (!markdown) return null;
  const paragraph = markdown
    .split(/\n{2,}/)
    .map((block) => block.replace(/^#+\s+/gm, '').trim())
    .find((block) => block && !block.startsWith('- '));
  return paragraph ? truncate(paragraph.replace(/\s+/g, ' '), 280) : null;
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const cleaned = value.trim();
    if (!cleaned || out.includes(cleaned)) continue;
    out.push(cleaned);
  }
  return out;
}

/**
 * Hash the entity-scoped evidence buffer so we can short-circuit a
 * page render when nothing material has changed since the last pass.
 *
 * The hash needs to be:
 *  - **stable** — JSON.stringify on the freshly-built evidence struct,
 *    which is deterministic in field order because we always build it
 *    via the same `buildEvidence` output (ordered slices).
 *  - **scoped to evidence-only** — we deliberately exclude metadata
 *    that changes on every run (entity.lastSeen, entity.frameCount)
 *    when those don't actually change the prose: focused-minute
 *    rounding stays in the prompt context, but the per-second clock
 *    drift would otherwise force a re-render every batch.
 *  - **cheap** — sha1 over a few KB of JSON is sub-millisecond.
 *
 * If the hash matches `existing.evidenceHash`, we reuse the page and
 * skip the LLM call. Older pages without a hash always re-render
 * exactly once, which back-fills the field for next time.
 */
function computeEvidenceHash(entity: EntityRecord, evidence: Evidence): string {
  const stable = {
    kind: entity.kind,
    path: entity.path,
    title: entity.title,
    // Round to whole minutes so a stale clock doesn't bust the cache.
    totalFocusedMin: Math.round(entity.totalFocusedMs / 60_000),
    frameCount: entity.frameCount,
    apps: evidence.apps,
    files: evidence.files,
    urls: evidence.urls.map((u) => ({ url: u.url, title: u.title ?? null })),
    related: evidence.related.map((r) => ({
      title: r.title,
      kind: r.kind,
      sharedSessions: r.sharedSessions,
      sharedFocusedMin: Math.round(r.sharedFocusedMs / 60_000),
    })),
    meetings: evidence.meetings.map((m) => ({
      startedAt: m.startedAt,
      durationMin: m.durationMin,
      title: m.title,
      tldr: m.tldr ?? null,
      decisions: m.decisions,
      actionItems: m.actionItems,
      summaryStatus: m.summaryStatus,
    })),
    windows: evidence.windows.map((w) => ({
      startedAt: w.startedAt,
      durationMin: Math.max(1, Math.round(w.durationMs / 60_000)),
      frameCount: w.frameCount,
      apps: w.apps,
      windowTitles: w.windowTitles,
      textSnippets: w.textSnippets,
    })),
    textSnippets: evidence.textSnippets,
    keyframes: evidence.keyframes.map((k) => ({
      assetPath: k.assetPath,
      // phash is the perceptual fingerprint; if it changes, the visual
      // content of the screenshot did too (cache miss).
      phash: k.phash ?? null,
    })),
  };
  return createHash('sha1').update(JSON.stringify(stable)).digest('hex');
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
  if (evidence.meetings.length) {
    lines.push('MEETING SUMMARIES:');
    for (const meeting of evidence.meetings.slice(0, 3)) {
      const start = meeting.startedAt.slice(0, 16).replace('T', ' ');
      lines.push(
        `  - ${start}, ${meeting.durationMin}m, ${meeting.summaryStatus}: ${meeting.title}`,
      );
      if (meeting.tldr) lines.push(`    TLDR: ${truncate(meeting.tldr, 220)}`);
      if (meeting.decisions.length) {
        lines.push(`    Decisions: ${meeting.decisions.slice(0, 3).map((d) => truncate(d, 90)).join(' | ')}`);
      }
      if (meeting.actionItems.length) {
        lines.push(`    Actions: ${meeting.actionItems.slice(0, 3).map((a) => truncate(a, 90)).join(' | ')}`);
      }
    }
  }
  if (evidence.files.length) {
    lines.push(`FILES SEEN: ${evidence.files.slice(0, 10).join(', ')}`);
  }
  if (evidence.related.length) {
    lines.push('RELATED CONTEXT:');
    for (const rel of evidence.related.slice(0, 6)) {
      lines.push(
        `  - ${rel.title} (${rel.kind}, ${rel.sharedSessions} shared session${rel.sharedSessions === 1 ? '' : 's'}, ${Math.round(rel.sharedFocusedMs / 60_000)}m)`,
      );
    }
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
    evidence.meetings.length && evidence.meetings[0]?.tldr
      ? `Meeting summary: ${truncate(evidence.meetings[0].tldr, 180)}.`
      : null,
    evidence.files.length ? `Files seen: ${evidence.files.slice(0, 5).join(', ')}.` : null,
    evidence.urls.length
      ? `URLs visited: ${evidence.urls
          .slice(0, 3)
          .map((u) => u.url)
          .join(', ')}.`
      : null,
    recentTitles ? `Recent windows included ${recentTitles}.` : null,
    evidence.related.length
      ? `Related context: ${evidence.related.slice(0, 4).map((rel) => rel.title).join(', ')}.`
      : null,
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
  if (evidence.related.length) {
    lines.push(`- Related: ${evidence.related.slice(0, 4).map((rel) => `[[${rel.path}]]`).join(', ')}`);
  }
  lines.push('');

  lines.push('## Summary');
  lines.push(prose);
  lines.push('');

  if (evidence.meetings.length) {
    lines.push('## Meeting summary');
    for (const meeting of evidence.meetings) {
      const start = meeting.startedAt.slice(0, 16).replace('T', ' ');
      lines.push(`- **${start}** (${meeting.durationMin}m, ${meeting.summaryStatus}) — ${meeting.title}`);
      if (meeting.tldr) lines.push(`  - ${truncate(meeting.tldr, 220)}`);
      for (const decision of meeting.decisions.slice(0, 3)) {
        lines.push(`  - Decision: ${truncate(decision, 180)}`);
      }
      for (const action of meeting.actionItems.slice(0, 3)) {
        lines.push(`  - Action: ${truncate(action, 180)}`);
      }
      for (const question of meeting.openQuestions.slice(0, 2)) {
        lines.push(`  - Open: ${truncate(question, 180)}`);
      }
    }
    lines.push('');
  }

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
  if (evidence.related.length) {
    lines.push('## Related context');
    for (const rel of evidence.related) {
      const minutes = Math.round(rel.sharedFocusedMs / 60_000);
      lines.push(
        `- [[${rel.path}]] (${rel.kind}, ${rel.sharedSessions} shared session${rel.sharedSessions === 1 ? '' : 's'}${minutes > 0 ? `, ${minutes}m overlap` : ''})`,
      );
    }
    lines.push('');
  }

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

  // 7. Provenance.
  if (evidence.sourceFrameIds.length || evidence.sourceEventIds.length || evidence.meetings.length) {
    lines.push('## Provenance');
    if (evidence.sourceFrameIds.length) {
      const shown = evidence.sourceFrameIds.slice(-12);
      lines.push(
        `- Source frames: ${shown.map((id) => `\`${id}\``).join(', ')}` +
          (evidence.sourceFrameIds.length > shown.length ? ` (+${evidence.sourceFrameIds.length - shown.length} more)` : ''),
      );
    }
    if (evidence.sourceEventIds.length) {
      const shown = evidence.sourceEventIds.slice(-12);
      lines.push(
        `- Source events: ${shown.map((id) => `\`${id}\``).join(', ')}` +
          (evidence.sourceEventIds.length > shown.length ? ` (+${evidence.sourceEventIds.length - shown.length} more)` : ''),
      );
    }
    if (evidence.meetings.length) {
      lines.push(`- Meetings: ${evidence.meetings.map((m) => `\`${m.id}\``).join(', ')}`);
    }
    lines.push('');
  }

  // 8. Top screenshots.
  if (evidence.keyframes.length) {
    lines.push('## Top screenshots');
    for (const k of evidence.keyframes) {
      const time = k.timestamp.slice(11, 19);
      lines.push(`![${entity.title} @ ${time} (${k.frameId})](${k.assetPath})`);
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
  return source === 'accessibility' || source === 'ocr_accessibility' || source === 'audio';
}

function contextGaps(entity: EntityRecord, evidence: Evidence): string[] {
  const gaps: string[] = [];
  if (entity.frameCount <= 3) {
    gaps.push('Very little evidence was captured; treat this page as a pointer, not a complete history.');
  }
  const hasMeetingSummary = evidence.meetings.some((meeting) => Boolean(meeting.tldr));
  if (evidence.textSnippets.length === 0 && !hasMeetingSummary) {
    gaps.push('No reliable readable text was extracted, so screenshots and window titles carry most of the context.');
  }
  if ((entity.kind === 'contact' || entity.kind === 'channel') && !hasMeetingSummary) {
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
  lines.push('# Beside — index');
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
    .filter((line) => !line.startsWith('<!-- beside:meta'))
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
    .replace(/<!-- beside:meta[\s\S]*?-->\s*/g, '')
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
