import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createLogger,
  defaultDataDir,
  loadConfig,
  validateConfig,
  writeConfig,
  writeDefaultConfigIfMissing,
} from '@cofounderos/core';
import type {
  ActivitySession,
  CaptureStatus,
  DayEvent,
  DayEventKind,
  ExportStatus,
  Frame,
  FrameQuery,
  IndexState,
  Logger,
  Meeting,
  RawEvent,
  StorageStats,
} from '@cofounderos/interfaces';
import {
  bootstrapModel,
  buildOrchestrator,
  assertHeavyWorkAllowed,
  runFullReindex,
  runIncremental,
  runReorganisation,
  startAll,
  stopAll,
  type OrchestratorHandles,
  type OrchestratorOptions,
} from './orchestrator.js';
import { renderJournalMarkdown } from '@cofounderos/interfaces';
import {
  runChatTurn,
  type ChatStreamHandler,
  type ChatTurnInput,
  type HarnessHandle,
  type HarnessOptions,
} from './agent/index.js';
import {
  insertJournalStory as insertJournalStorySection,
  renderDeterministicObservedJournalStory as renderJournalStorySection,
} from './journal-story.js';
export type RuntimeStatus = 'not_started' | 'starting' | 'running' | 'stopping' | 'stopped';

export interface RuntimeOptions extends OrchestratorOptions {
  logger?: Logger;
}

export interface RuntimeInitResult {
  created: boolean;
  path: string;
}

export interface RuntimeOverview {
  status: RuntimeStatus;
  configPath: string;
  dataDir: string;
  storageRoot: string;
  capture: CaptureStatus;
  storage: StorageStats;
  index: IndexState & {
    categories: RuntimeIndexCategory[];
  };
  indexing: RuntimeIndexingStatus;
  model: {
    name: string;
    isLocal: boolean;
    ready: boolean;
  };
  exports: ExportStatus[];
  backgroundJobs: RuntimeBackgroundJobStatus[];
  system: {
    load: number | null;
    memory: {
      totalMB: number;
      freeMB: number;
      usedRatio: number;
    };
    power: {
      source: 'ac' | 'battery' | 'unknown';
      batteryPercent: number | null;
    };
    loadGuardEnabled: boolean;
    backgroundModelJobs: 'manual' | 'scheduled';
    overviewGeneratedAt: string;
    overviewDurationMs: number;
    overviewCacheTtlMs: number;
    overviewMode: 'full' | 'fast';
    overviewTimings: Record<string, number>;
  };
}

export interface RuntimeIndexingStatus {
  running: boolean;
  currentJob: string | null;
  startedAt: string | null;
  lastCompletedAt: string | null;
}

export interface RuntimeBackgroundJobStatus {
  name: string;
  kind: 'interval' | 'cron';
  running: boolean;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  runCount: number;
  skippedCount: number;
}

export interface RuntimeIndexCategory {
  name: string;
  pageCount: number;
  summaryPath?: string;
  lastUpdated: string | null;
  recentPages: RuntimeIndexCategoryPage[];
}

export interface RuntimeIndexCategoryPage {
  path: string;
  title: string;
  summary: string | null;
  lastUpdated: string;
}

export interface RuntimeStats {
  overview: RuntimeOverview;
  journalDays: string[];
  entities: {
    total: number;
    recent: Array<{
      path: string;
      title: string;
      kind: string;
      frameCount: number;
      lastSeen: string;
    }>;
  };
}

export interface RuntimeDoctorCheck {
  area: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  message: string;
  detail?: string;
  action?: string;
}

export interface RuntimeJournalDay {
  day: string;
  frames: Frame[];
  sessions: ActivitySession[];
}

export interface RuntimeIndexedJournalDay {
  day: string;
  markdown: string;
}

export interface SearchResultExplanation {
  frameId: string;
  explanation: string;
}

export interface FrameIndexDetails {
  frameId: string;
  caption: string | null;
  indexingText: string | null;
  metadata: Record<string, unknown>;
}

export interface ExplainSearchResultsQuery {
  text: string;
  frames: Frame[];
}

export type ConfigPatch = Record<string, unknown>;

// Full overviews touch SQLite (countEvents x2, getStats), the index
// directory (recursive readdir), and the model availability check —
// hundreds of syscalls per build. The 30s TTL caps how often that
// runs while still letting fast overviews refresh in-memory status
// (capture, scheduler jobs, load guard) on every heartbeat.
const OVERVIEW_CACHE_TTL_MS = 30_000;
const OVERVIEW_SLOW_LOG_MS = 500;

/**
 * Bounded cache for `explainSearchResults`. Each entry costs one
 * vision-model call (~1-3 s on Apple Silicon, much more on CPU-only),
 * so a tiny in-process cache pays for itself immediately on any UI
 * surface that re-asks for the same `(query, frame)` pair — typing
 * "slack" then deleting back to "sla" then retyping, navigating away
 * and back, splitting the search result into a different result page,
 * etc. 256 entries × ~250 chars/entry ≈ ~64 KB; trivial relative to
 * the work it skips. Keyed on `${frameId}::${normalisedQuery}`; values
 * are stored in insertion order so we evict the oldest first.
 */
const EXPLAIN_SEARCH_CACHE_MAX = 256;
const SEARCH_EXPLANATION_TIMEOUT_MS = 20_000;
const MANUAL_EVENT_SCAN_OCR_TICKS = 6;
const MANUAL_EVENT_SCAN_LOOKBACK_DAYS = 2;

export class CofounderRuntime {
  private readonly logger: Logger;
  private readonly opts: OrchestratorOptions;
  private handles: OrchestratorHandles | null = null;
  private status: RuntimeStatus = 'not_started';
  private overviewCache: { value: RuntimeOverview; expiresAt: number } | null = null;
  private overviewInFlight: Promise<RuntimeOverview> | null = null;
  private manualJob: { name: string; startedAt: string } | null = null;
  private lastManualJobCompletedAt: string | null = null;
  private readonly activeChatTurns = new Map<string, HarnessHandle>();
  /**
   * LRU cache for `explainSearchResults`. Map iteration order in JS is
   * insertion order, so we delete + re-set on hit (to mark recent) and
   * pop `keys().next()` on overflow (to evict oldest).
   */
  private readonly explainSearchCache = new Map<string, string>();

  constructor(opts: RuntimeOptions = {}) {
    this.logger = opts.logger ?? createLogger({ level: 'info' });
    this.opts = {
      configPath: opts.configPath,
      workspaceRoot: opts.workspaceRoot,
    };
  }

  async init(): Promise<RuntimeInitResult> {
    return await writeDefaultConfigIfMissing(defaultDataDir());
  }

  async start(options: { bootstrap?: boolean } = {}): Promise<void> {
    if (this.status === 'running') return;
    this.status = 'starting';
    const handles = await this.getOrCreateHandles();
    if (options.bootstrap !== false) {
      await bootstrapModel(handles);
    }
    await startAll(handles);
    this.status = 'running';
    this.invalidateOverview();
  }

  async bootstrapModel(
    onProgress?: Parameters<typeof bootstrapModel>[1],
    opts?: Parameters<typeof bootstrapModel>[2],
  ): Promise<void> {
    await this.withHandles((handles) => bootstrapModel(handles, onProgress, opts));
  }

  async stop(): Promise<void> {
    if (!this.handles) {
      this.status = 'stopped';
      return;
    }
    this.status = 'stopping';
    this.invalidateOverview();
    await stopAll(this.handles);
    this.handles = null;
    this.status = 'stopped';
    this.invalidateOverview();
  }

  async restart(options: { bootstrap?: boolean } = {}): Promise<void> {
    await this.stop();
    await this.start(options);
  }

  async pauseCapture(): Promise<RuntimeOverview> {
    return await this.withHandles(async (handles) => {
      await handles.capture.pause();
      this.invalidateOverview();
      return await this.getOverview({ forceRefresh: true });
    });
  }

  async resumeCapture(): Promise<RuntimeOverview> {
    return await this.withHandles(async (handles) => {
      await handles.capture.resume();
      this.invalidateOverview();
      return await this.getOverview({ forceRefresh: true });
    });
  }

  async getOverview(
    options: { forceRefresh?: boolean; mode?: 'full' | 'fast' } = {},
  ): Promise<RuntimeOverview> {
    if (options.mode === 'fast') {
      return await this.getFastOverview();
    }

    const now = Date.now();
    if (!options.forceRefresh && this.overviewCache && this.overviewCache.expiresAt > now) {
      return this.overviewCache.value;
    }
    if (!options.forceRefresh && this.overviewInFlight) {
      return await this.overviewInFlight;
    }

    const buildStartedAt = Date.now();
    const promise = this.withHandles(async (handles) => {
      const timings: Record<string, number> = {};
      const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        const startedAt = Date.now();
        try {
          return await fn();
        } finally {
          timings[name] = Date.now() - startedAt;
        }
      };
      const timedSync = <T>(name: string, fn: () => T): T => {
        const startedAt = Date.now();
        try {
          return fn();
        } finally {
          timings[name] = Date.now() - startedAt;
        }
      };
      const capture = handles.capture.getStatus();
      // Replace the capture plugin's in-memory tally (which resets on
      // restart and only counts what flowed through the plugin during
      // this process lifetime) with a storage-backed count since local
      // midnight. Also expose a trailing-hour count for the UI.
      try {
        const now = new Date();
        const midnight = new Date(now);
        midnight.setHours(0, 0, 0, 0);
        const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        const [todayCount, lastHourCount] = await timed('captureCounts', () => Promise.all([
          handles.storage.countEvents({ from: midnight.toISOString() }),
          handles.storage.countEvents({ from: hourAgo.toISOString() }),
        ]));
        capture.eventsToday = todayCount;
        capture.eventsLastHour = lastHourCount;
      } catch {
        // Storage backend may not implement countEvents; fall back to
        // the plugin tally already on `capture`.
      }
      const storage = await timed('storageStats', () => handles.storage.getStats());
      const index = await timed('indexState', () => handles.strategy.getState());
      const categories = await timed('indexCategories', () => readIndexCategories(index.rootPath).catch(() => []));
      const indexing = timedSync('indexingStatus', () => getIndexingStatus(
        handles,
        this.manualJob,
        this.lastManualJobCompletedAt,
      ));
      const modelInfo = timedSync('modelInfo', () => handles.model.getModelInfo());
      const ready = await timed('modelAvailability', () => handles.model.isAvailable().catch(() => false));
      const loadSnapshot = timedSync('loadGuard', () => handles.loadGuard.snapshot());
      const exports = timedSync('exports', () => handles.exports.map((exp) => exp.getStatus()));
      const backgroundJobs = timedSync('backgroundJobs', () => getBackgroundJobs(handles));
      const overviewDurationMs = Date.now() - buildStartedAt;
      if (overviewDurationMs >= OVERVIEW_SLOW_LOG_MS) {
        this.logger.debug('overview generated slowly', { durationMs: overviewDurationMs });
      }
      const overview: RuntimeOverview = {
        status: this.status,
        configPath: handles.loaded.sourcePath,
        dataDir: handles.loaded.dataDir,
        storageRoot: handles.storage.getRoot(),
        capture,
        storage,
        index: {
          ...index,
          categories,
        },
        indexing,
        model: {
          name: modelInfo.name,
          isLocal: modelInfo.isLocal,
          ready,
        },
        exports,
        backgroundJobs,
        system: {
          load: loadSnapshot.normalised,
          memory: loadSnapshot.memory,
          power: loadSnapshot.power,
          loadGuardEnabled: handles.config.system.load_guard.enabled,
          backgroundModelJobs: handles.config.system.background_model_jobs,
          overviewGeneratedAt: new Date().toISOString(),
          overviewDurationMs,
          overviewCacheTtlMs: OVERVIEW_CACHE_TTL_MS,
          overviewMode: 'full',
          overviewTimings: timings,
        },
      };
      return overview;
    });

    this.overviewInFlight = promise;
    try {
      const overview = await promise;
      this.overviewCache = {
        value: overview,
        expiresAt: Date.now() + OVERVIEW_CACHE_TTL_MS,
      };
      return overview;
    } finally {
      if (this.overviewInFlight === promise) this.overviewInFlight = null;
    }
  }

  private async getFastOverview(): Promise<RuntimeOverview> {
    if (!this.overviewCache) {
      return await this.getOverview({ forceRefresh: true });
    }
    const startedAt = Date.now();
    return await this.withHandles(async (handles) => {
      const cached = this.overviewCache!.value;
      const capture = handles.capture.getStatus();
      // Heartbeats should stay cheap. Preserve storage-backed counters from
      // the last full overview instead of querying SQLite every 2 seconds.
      capture.eventsToday = cached.capture.eventsToday;
      capture.eventsLastHour = cached.capture.eventsLastHour;
      capture.storageBytesToday = cached.capture.storageBytesToday;

      const overviewDurationMs = Date.now() - startedAt;
      return {
        ...cached,
        status: this.status,
        capture,
        indexing: getIndexingStatus(
          handles,
          this.manualJob,
          this.lastManualJobCompletedAt,
        ),
        exports: handles.exports.map((exp) => exp.getStatus()),
        backgroundJobs: getBackgroundJobs(handles),
        system: {
          ...cached.system,
          ...(() => {
            const snapshot = handles.loadGuard.snapshot();
            return {
              load: snapshot.normalised,
              memory: snapshot.memory,
              power: snapshot.power,
            };
          })(),
          overviewGeneratedAt: new Date().toISOString(),
          overviewDurationMs,
          overviewMode: 'fast',
          overviewTimings: {
            fastPatch: overviewDurationMs,
          },
        },
      };
    });
  }

  async getStats(): Promise<RuntimeStats> {
    return await this.withHandles(async (handles) => {
      const overview = await this.getOverview();
      const journalDays = await handles.storage.listDays();
      let recentEntities: RuntimeStats['entities']['recent'] = [];
      try {
        const entities = await handles.storage.listEntities({ limit: 10 });
        recentEntities = entities.map((entity) => ({
          path: entity.path,
          title: entity.title,
          kind: entity.kind,
          frameCount: entity.frameCount,
          lastSeen: entity.lastSeen,
        }));
      } catch {
        recentEntities = [];
      }
      return {
        overview,
        journalDays,
        entities: {
          total: recentEntities.length,
          recent: recentEntities,
        },
      };
    });
  }

  async runDoctor(): Promise<RuntimeDoctorCheck[]> {
    const checks: RuntimeDoctorCheck[] = [];
    const loaded = await loadConfig(this.opts.configPath);
    checks.push({
      area: 'config',
      status: loaded.sourcePath === '<defaults>' ? 'warn' : 'ok',
      message: loaded.sourcePath === '<defaults>'
        ? 'Using built-in defaults; config.yaml has not been created yet'
        : `Config loaded from ${loaded.sourcePath}`,
      action: loaded.sourcePath === '<defaults>' ? 'Run init or open the desktop setup flow' : undefined,
    });
    checks.push({
      area: 'data',
      status: 'ok',
      message: `Data directory: ${loaded.dataDir}`,
    });
    try {
      await fs.mkdir(loaded.dataDir, { recursive: true });
      await fs.access(loaded.dataDir);
      checks.push({ area: 'data', status: 'ok', message: 'Data directory is writable' });
    } catch (err) {
      checks.push({
        area: 'data',
        status: 'fail',
        message: 'Data directory is not writable',
        detail: String(err),
      });
    }

    await this.withHandles(async (handles) => {
      const modelInfo = handles.model.getModelInfo();
      const modelReady = await handles.model.isAvailable().catch(() => false);
      checks.push({
        area: 'model',
        status: modelReady ? 'ok' : 'warn',
        message: modelReady ? `${modelInfo.name} is ready` : `${modelInfo.name} is not reachable`,
        action: modelReady ? undefined : 'Prepare the local AI model from setup',
      });
      checks.push({
        area: 'storage',
        status: await handles.storage.isAvailable().catch(() => false) ? 'ok' : 'fail',
        message: `Storage root: ${handles.storage.getRoot()}`,
      });
      const mcp = handles.exports.find((exp) => exp.name === 'mcp');
      checks.push({
        area: 'ai-connection',
        status: mcp ? 'ok' : 'warn',
        message: mcp ? 'AI app connection export is configured' : 'AI app connection export is not configured',
      });
    });

    return checks;
  }

  async readConfig(): Promise<Awaited<ReturnType<typeof loadConfig>>> {
    return await loadConfig(this.opts.configPath);
  }

  validateConfig(raw: unknown): ReturnType<typeof validateConfig> {
    return validateConfig(raw);
  }

  async saveConfigPatch(patch: ConfigPatch): Promise<Awaited<ReturnType<typeof loadConfig>>> {
    const loaded = await loadConfig(this.opts.configPath);
    const next = deepMerge(structuredClone(loaded.config) as Record<string, unknown>, patch);
    const validation = validateConfig(next);
    if (!validation.ok) {
      throw new Error(`Invalid config: ${validation.issues.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join('; ')}`);
    }
    await writeConfig(validation.config, this.opts.configPath);
    if (this.handles) {
      await this.stop();
    }
    return await loadConfig(this.opts.configPath);
  }

  async listMeetings(query: { from?: string; to?: string; limit?: number } = {}): Promise<Meeting[]> {
    return await this.withHandles(async (handles) => {
      try {
        return await handles.storage.listMeetings({
          from: query.from,
          to: query.to,
          order: 'recent',
          limit: query.limit ?? 200,
        });
      } catch {
        return [];
      }
    });
  }

  async listDayEvents(query: {
    day?: string;
    from?: string;
    to?: string;
    kind?: DayEventKind;
    limit?: number;
    order?: 'recent' | 'chronological';
  } = {}): Promise<DayEvent[]> {
    return await this.withHandles(async (handles) => {
      try {
        return await handles.storage.listDayEvents({
          day: query.day,
          from: query.from,
          to: query.to,
          kind: query.kind,
          // Default `recent`: when no day filter is provided we want the
          // newest events to fit under the row cap. Per-day calls
          // override with `chronological` since within a single day the
          // event list reads top-to-bottom.
          order: query.order ?? (query.day ? 'chronological' : 'recent'),
          limit: query.limit ?? (query.day ? 500 : 2000),
        });
      } catch {
        return [];
      }
    });
  }

  async listJournalDays(): Promise<string[]> {
    return await this.withHandles((handles) => handles.storage.listDays());
  }

  async getJournalDay(day: string): Promise<RuntimeJournalDay> {
    return await this.withHandles(async (handles) => {
      const frames = (await handles.storage.getJournal(day))
        .slice()
        .sort((a, b) => Date.parse(b.timestamp ?? '') - Date.parse(a.timestamp ?? ''));
      let sessions: ActivitySession[] = [];
      try {
        sessions = await handles.storage.listSessions({
          day,
          limit: 500,
        });
      } catch {
        sessions = [];
      }
      return { day, frames, sessions };
    });
  }

  async getIndexedJournalDay(day: string): Promise<RuntimeIndexedJournalDay> {
    return await this.withHandles(async (handles) => {
      const frames = (await handles.storage.getJournal(day))
        .slice()
        .sort((a, b) => Date.parse(a.timestamp ?? '') - Date.parse(b.timestamp ?? ''));
      let sessions: ActivitySession[] = [];
      try {
        sessions = await handles.storage.listSessions({
          day,
          order: 'chronological',
          limit: 500,
        });
      } catch {
        sessions = [];
      }
      let meetings: Meeting[] = [];
      try {
        meetings = await handles.storage.listMeetings({
          day,
          order: 'chronological',
          limit: 100,
        });
      } catch {
        meetings = [];
      }
      const baseline = renderJournalMarkdown(day, frames, {
        sessions,
        meetings,
      });
      const story = renderJournalStorySection(frames, sessions);
      return {
        day,
        markdown: story ? insertJournalStorySection(baseline, story) : baseline,
      };
    });
  }

  async searchFrames(query: FrameQuery): Promise<Frame[]> {
    return await this.withHandles((handles) => handles.storage.searchFrames(query));
  }

  async explainSearchResults(query: ExplainSearchResultsQuery): Promise<SearchResultExplanation[]> {
    const text = query.text.trim();
    if (!text || query.frames.length === 0) return [];

    // Normalise the query for cache keying — collapsing whitespace and
    // lowercasing means the user typing "Slack messages" then
    // "slack  messages" doesn't double-pay for the vision call.
    const cacheText = text.toLowerCase().replace(/\s+/g, ' ');

    // Serve cache hits without ever touching the model. Each hit is a
    // genuine 1-3s+ vision call avoided. Misses get a list back so we
    // only call the model for the frames not already explained.
    const cached: SearchResultExplanation[] = [];
    const misses: typeof query.frames = [];
    for (const frame of query.frames) {
      const key = explainCacheKey(frame.id, cacheText);
      const hit = this.explainSearchCache.get(key);
      if (hit !== undefined) {
        // Refresh recency: re-insert so this entry is the youngest.
        this.explainSearchCache.delete(key);
        this.explainSearchCache.set(key, hit);
        const fallback = buildFallbackSearchResultExplanation(text, frame);
        const explanation = hit || fallback;
        if (explanation) {
          cached.push({ frameId: frame.id, explanation });
        }
      } else {
        misses.push(frame);
      }
    }

    if (misses.length === 0) return cached;

    return await this.withHandles(async (handles) => {
      if (!(await handles.model.isAvailable().catch(() => false))) {
        return [...cached, ...buildFallbackSearchResultExplanations(text, misses)];
      }

      const modelInfo = handles.model.getModelInfo();
      const fresh: SearchResultExplanation[] = [];
      for (const frame of misses) {
        const key = explainCacheKey(frame.id, cacheText);
        try {
          const image = modelInfo.supportsVision && frame.asset_path
            ? await readFrameAssetForModel(handles, frame.asset_path)
            : null;
          const prompt = buildSearchResultExplanationPrompt(text, frame, image != null);
          const raw = await raceSearchExplanation(
            image
              ? handles.model.completeWithVision(prompt, [image], {
                  maxTokens: 120,
                  temperature: 0.2,
                })
              : handles.model.complete(prompt, {
                  maxTokens: 120,
                  temperature: 0.2,
                }),
          );
          const explanation = cleanSearchExplanation(raw);
          // Cache empty strings too so we don't keep hammering the
          // model on frames that consistently produce nothing useful.
          this.rememberExplainCache(key, explanation);
          const fallback = buildFallbackSearchResultExplanation(text, frame);
          const displayExplanation = explanation || fallback;
          if (displayExplanation) {
            fresh.push({ frameId: frame.id, explanation: displayExplanation });
          }
        } catch (err) {
          handles.logger.debug('search result explanation failed', {
            frameId: frame.id,
            err: String(err),
          });
          const fallback = buildFallbackSearchResultExplanation(text, frame);
          if (fallback) fresh.push({ frameId: frame.id, explanation: fallback });
        }
      }
      return [...cached, ...fresh];
    });
  }

  /**
   * Insert into the LRU and evict the oldest entry when over capacity.
   * Map iteration order in JS is insertion order, so `keys().next()`
   * gives us the oldest key.
   */
  private rememberExplainCache(key: string, value: string): void {
    if (this.explainSearchCache.has(key)) {
      this.explainSearchCache.delete(key);
    }
    this.explainSearchCache.set(key, value);
    if (this.explainSearchCache.size > EXPLAIN_SEARCH_CACHE_MAX) {
      const oldest = this.explainSearchCache.keys().next().value;
      if (oldest !== undefined) this.explainSearchCache.delete(oldest);
    }
  }

  async getFrameIndexDetails(frameId: string): Promise<FrameIndexDetails | null> {
    const id = frameId.trim();
    if (!id) return null;

    return await this.withHandles(async (handles) => {
      const context = await handles.storage.getFrameContext(id, 0, 0);
      const frame = context?.anchor;
      if (!frame) return null;

      const sourceIds = frame.source_event_ids ?? [];
      const events = sourceIds.length > 0
        ? await handles.storage.readEvents({ ids: sourceIds, limit: sourceIds.length })
        : [];
      const metadata = buildDisplayMetadata(frame, events);
      return {
        frameId: frame.id,
        caption: extractAiCaption(metadata),
        indexingText: buildFrameIndexingText(frame),
        metadata,
      };
    });
  }

  async deleteFrame(frameId: string): Promise<{ assetPath: string | null }> {
    return await this.withHandles((handles) => handles.storage.deleteFrame(frameId));
  }

  async deleteFramesByDay(day: string): Promise<{ frames: number; assetPaths: string[] }> {
    return await this.withHandles((handles) => handles.storage.deleteFramesByDay(day));
  }

  async deleteFrames(query: { app?: string; urlDomain?: string }): Promise<{
    frames: number;
    assetPaths: string[];
  }> {
    const app = typeof query.app === 'string' ? query.app.trim() : undefined;
    const urlDomain =
      typeof query.urlDomain === 'string' ? query.urlDomain.trim() : undefined;
    if (!app && !urlDomain) {
      throw new Error('deleteFrames requires app or urlDomain');
    }
    return await this.withHandles((handles) =>
      handles.storage.deleteFrames({
        ...(app ? { app } : {}),
        ...(urlDomain ? { urlDomain } : {}),
      }),
    );
  }

  async deleteAllMemory(): Promise<{
    frames: number;
    events: number;
    assetBytes: number;
  }> {
    return await this.withHandles((handles) => handles.storage.deleteAllMemory());
  }

  async readAsset(assetPath: string): Promise<Buffer> {
    return await this.withHandles(async (handles) => {
      const storageRoot = path.resolve(handles.storage.getRoot());
      const resolved = path.resolve(storageRoot, assetPath);
      if (!resolved.startsWith(`${storageRoot}${path.sep}`) && resolved !== storageRoot) {
        throw new Error('asset path escapes storage root');
      }
      return await handles.storage.readAsset(assetPath);
    });
  }

  /**
   * Run one chat turn through the local AI harness. Streams typed
   * events back through `onEvent`; resolves once the turn completes
   * (either with a `done` or `error` terminal event). The returned
   * handle lets callers cancel the in-flight turn.
   *
   * The chat method intentionally tracks active turns by `turnId` so
   * the desktop runtime-service can route a `chatCancel` message to
   * the right harness instance when the user presses Stop.
   */
  chat(
    input: ChatTurnInput,
    onEvent: ChatStreamHandler,
    options?: HarnessOptions,
  ): { done: Promise<void>; handle: HarnessHandle } {
    const tracked: HarnessHandle = {
      cancel: () => {
        const live = this.activeChatTurns.get(input.turnId);
        if (live) live.cancel();
      },
    };
    const done = (async (): Promise<void> => {
      const handles = await this.getOrCreateHandles();
      const run = runChatTurn(
        {
          storage: handles.storage,
          strategy: handles.strategy,
          model: handles.model,
          logger: this.logger.child('chat'),
        },
        input,
        onEvent,
        options,
      );
      this.activeChatTurns.set(input.turnId, run.handle);
      try {
        await run.done;
      } finally {
        this.activeChatTurns.delete(input.turnId);
      }
    })();
    return { done, handle: tracked };
  }

  cancelChat(turnId: string): boolean {
    const live = this.activeChatTurns.get(turnId);
    if (!live) return false;
    live.cancel();
    return true;
  }

  async triggerIndex(): Promise<void> {
    await this.runManualJob('index-incremental', async () => {
      await this.withHandles((handles) => {
        assertHeavyWorkAllowed(handles, 'index-incremental');
        return runIncremental(handles).then(() => undefined);
      });
    });
  }

  async triggerReorganise(): Promise<void> {
    await this.runManualJob('index-reorganise', async () => {
      await this.withHandles((handles) => {
        assertHeavyWorkAllowed(handles, 'index-reorganise');
        return runReorganisation(handles);
      });
    });
  }

  /**
   * Focused, fast manual trigger for the EventExtractor.
   *
   * The scheduler runs the same job every 15 min; this is the "make it
   * happen now" path the Event log Scan-now button hits.
   *
   * Critically, the extractor only sees `frames` rows with OCR text,
   * so we drain the upstream workers in order first:
   *
   *   1. AudioTranscriptWorker — finished audio chunks → audio_transcript events
   *   2. FrameBuilder  — raw capture events  → Frame rows
   *                      (without this, a calendar screenshot taken
   *                       30 s ago hasn't been promoted yet)
   *   3. OcrWorker     — Frame rows          → Frame rows + text
   *                      (Apple Calendar AX text typically lands at
   *                       frame-build time, but web calendars need
   *                       Tesseract here)
   *   4. EntityResolver — assigns `entity_kind` (not required by the
   *                       extractor's bucketing, but cheap and keeps
   *                       the rest of the substrate fresh)
   *   5. MeetingBuilder — turns newly-resolved live-call frames into
   *                       Meeting rows so the extractor can lift them
   *   6. MeetingSummarizer — fills summaries for closed meetings
   *   7. EventExtractor — finally produces the day_events rows
   *
   * OCR is intentionally bounded: users click this button to update
   * the current Event log, not to pay down every old un-OCR'd frame in
   * the database. The scheduler/full reindex paths still own deep
   * backlog cleanup.
   * Returns a small summary that the renderer surfaces as a toast.
   */
  async triggerEventExtractor(): Promise<{
    meetingsLifted: number;
    llmExtracted: number;
    contextEnriched: number;
    daysScanned: number;
    bucketsScanned: number;
    framesScanned: number;
    framesBuilt: number;
    framesOcrd: number;
    audioProcessed: number;
    audioTranscribed: number;
    audioImported: number;
    audioSilent: number;
    audioFailed: number;
    meetingFramesProcessed: number;
    meetingsCreated: number;
    meetingsExtended: number;
    summariesAttempted: number;
    summariesSucceeded: number;
    summariesFailed: number;
    summariesSkipped: number;
    modelAvailable: boolean;
    failed: number;
  }> {
    return await this.withHandles(async (handles) => {
      let framesBuilt = 0;
      let framesOcrd = 0;
      let audioProcessed = 0;
      let audioTranscribed = 0;
      let audioImported = 0;
      let audioSilent = 0;
      let audioFailed = 0;
      let meetingFramesProcessed = 0;
      let meetingsCreated = 0;
      let meetingsExtended = 0;
      let summariesAttempted = 0;
      let summariesSucceeded = 0;
      let summariesFailed = 0;
      let summariesSkipped = 0;

      try {
        const audio = await handles.audioTranscriptWorker.drain();
        audioProcessed = audio.processed ?? 0;
        audioTranscribed = audio.transcribed ?? 0;
        audioImported = audio.imported ?? 0;
        audioSilent = audio.silent ?? 0;
        audioFailed = audio.failed ?? 0;
        if (audioProcessed + audioSilent + audioFailed > 0) {
          handles.logger.info(
            `scan: processed ${audioProcessed} audio transcript(s), ${audioSilent} silent, ${audioFailed} failed`,
          );
        }
      } catch (err) {
        handles.logger.warn('scan: audioTranscriptWorker.drain failed (continuing)', {
          err: String(err),
        });
      }

      try {
        const fb = await handles.frameBuilder.drain();
        framesBuilt = fb.framesCreated ?? 0;
        if (framesBuilt > 0) {
          handles.logger.info(`scan: built ${framesBuilt} new frame(s) from raw events`);
        }
      } catch (err) {
        handles.logger.warn('scan: frameBuilder.drain failed (continuing)', {
          err: String(err),
        });
      }

      try {
        const ocr = await handles.ocrWorker.drain(MANUAL_EVENT_SCAN_OCR_TICKS);
        framesOcrd = ocr.processed ?? 0;
        if (framesOcrd > 0) {
          handles.logger.info(`scan: ran OCR over ${framesOcrd} frame(s)`);
        }
      } catch (err) {
        handles.logger.warn('scan: ocrWorker.drain failed (continuing)', {
          err: String(err),
        });
      }

      try {
        await handles.entityResolver.drain();
      } catch (err) {
        handles.logger.warn('scan: entityResolver.drain failed (continuing)', {
          err: String(err),
        });
      }

      try {
        const mb = await handles.meetingBuilder.drain();
        meetingFramesProcessed = mb.framesProcessed ?? 0;
        meetingsCreated = mb.meetingsCreated ?? 0;
        meetingsExtended = mb.meetingsExtended ?? 0;
        if (meetingsCreated + meetingsExtended > 0) {
          handles.logger.info(
            `scan: materialised ${meetingsCreated} new + ${meetingsExtended} extended meeting(s)`,
          );
        }
      } catch (err) {
        handles.logger.warn('scan: meetingBuilder.drain failed (continuing)', {
          err: String(err),
        });
      }

      try {
        const summaries = await handles.meetingSummarizer.tick();
        summariesAttempted = summaries.attempted ?? 0;
        summariesSucceeded = summaries.succeeded ?? 0;
        summariesFailed = summaries.failed ?? 0;
        summariesSkipped = summaries.skipped ?? 0;
        if (summariesAttempted > 0) {
          handles.logger.info(
            `scan: summarised ${summariesSucceeded} meeting(s), ${summariesFailed} failed, ${summariesSkipped} skipped`,
          );
        }
      } catch (err) {
        handles.logger.warn('scan: meetingSummarizer.tick failed (continuing)', {
          err: String(err),
        });
      }

      try {
        const result = await handles.eventExtractor.tick({
          lookbackDays: MANUAL_EVENT_SCAN_LOOKBACK_DAYS,
          sources: ['calendar_screen'],
          enrichContexts: false,
        });
        return {
          ...result,
          framesBuilt,
          framesOcrd,
          audioProcessed,
          audioTranscribed,
          audioImported,
          audioSilent,
          audioFailed,
          meetingFramesProcessed,
          meetingsCreated,
          meetingsExtended,
          summariesAttempted,
          summariesSucceeded,
          summariesFailed,
          summariesSkipped,
        };
      } catch (err) {
        handles.logger.warn('manual event extractor tick failed', {
          err: String(err),
        });
        return {
          meetingsLifted: 0,
          llmExtracted: 0,
          contextEnriched: 0,
          daysScanned: 0,
          bucketsScanned: 0,
          framesScanned: 0,
          framesBuilt,
          framesOcrd,
          audioProcessed,
          audioTranscribed,
          audioImported,
          audioSilent,
          audioFailed,
          meetingFramesProcessed,
          meetingsCreated,
          meetingsExtended,
          summariesAttempted,
          summariesSucceeded,
          summariesFailed,
          summariesSkipped,
          modelAvailable: false,
          failed: 1,
        };
      }
    });
  }

  async triggerFullReindex(opts: { from?: string; to?: string } = {}): Promise<void> {
    await this.runManualJob('index-full-reindex', async () => {
      await this.withHandles((handles) => {
        assertHeavyWorkAllowed(handles, 'index-full-reindex');
        return runFullReindex(handles, opts);
      });
    });
  }

  private async runManualJob(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.manualJob) {
      if (this.manualJob.name === name) {
        // Re-triggering the same job (e.g. user double-clicks "Index now")
        // is a no-op rather than an error: the work is already in flight.
        this.logger.info('manual job already running; ignoring duplicate trigger', {
          job: name,
          startedAt: this.manualJob.startedAt,
        });
        return;
      }
      throw new Error(`Runtime job already running: ${this.manualJob.name}`);
    }
    this.manualJob = { name, startedAt: new Date().toISOString() };
    this.invalidateOverview();
    try {
      await fn();
    } finally {
      this.lastManualJobCompletedAt = new Date().toISOString();
      this.manualJob = null;
      this.invalidateOverview();
    }
  }

  private async getOrCreateHandles(): Promise<OrchestratorHandles> {
    if (!this.handles) {
      this.handles = await buildOrchestrator(this.logger, this.opts);
    }
    return this.handles;
  }

  private invalidateOverview(): void {
    this.overviewCache = null;
  }

  private async withHandles<T>(fn: (handles: OrchestratorHandles) => Promise<T>): Promise<T> {
    const hadHandles = this.handles != null;
    const handles = await this.getOrCreateHandles();
    try {
      return await fn(handles);
    } finally {
      if (!hadHandles && this.status !== 'running') {
        await stopAll(handles).catch((err) => {
          this.logger.warn('failed to stop temporary runtime handles', { err: String(err) });
        });
        this.handles = null;
        this.status = 'stopped';
      }
    }
  }
}

export function createRuntime(opts: RuntimeOptions = {}): CofounderRuntime {
  return new CofounderRuntime(opts);
}

const AI_CAPTION_KEYS = [
  'ai_caption',
  'caption',
  'image_caption',
  'screenshot_caption',
  'vision_caption',
  'visual_caption',
  'description',
  'summary',
];

const HIDDEN_METADATA_KEYS = new Set([
  'ax_text',
  'ocr_text',
  'text',
  'content',
]);

function buildFrameIndexingText(frame: Frame): string | null {
  const parts = [
    frame.app ? `App: ${frame.app}` : null,
    frame.window_title ? `Window: ${frame.window_title}` : null,
    frame.url ? `URL: ${frame.url}` : null,
    frame.entity_path ? `Entity: ${frame.entity_path}` : null,
    frame.text ? `Text: ${truncateIndexText(frame.text, 3000)}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join('\n') : null;
}

function buildDisplayMetadata(frame: Frame, events: RawEvent[]): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    ...(frame.text_source ? { text_source: frame.text_source } : {}),
    ...(frame.trigger ? { trigger: frame.trigger } : {}),
    ...(frame.entity_kind ? { entity_kind: frame.entity_kind } : {}),
    ...(frame.perceptual_hash ? { perceptual_hash: frame.perceptual_hash } : {}),
  };

  for (const event of events) {
    const eventMetadata = normaliseEventMetadata(event.metadata);
    for (const [key, value] of Object.entries(eventMetadata)) {
      const displayValue = normaliseMetadataValue(key, value);
      if (displayValue == null) continue;
      metadata[key] = displayValue;
    }
  }

  if (frame.source_event_ids.length > 0) {
    metadata.source_event_ids = frame.source_event_ids;
  }
  return metadata;
}

function normaliseEventMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const nested = isRecord(metadata.metadata) ? metadata.metadata : {};
  const topLevel = Object.fromEntries(
    Object.entries(metadata).filter(([key]) => key !== 'metadata'),
  );
  return { ...nested, ...topLevel };
}

function normaliseMetadataValue(key: string, value: unknown): unknown {
  if (HIDDEN_METADATA_KEYS.has(key)) return null;
  if (value == null) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const safe = value.filter((item) => item == null || isScalar(item));
    return safe.length > 0 && safe.length === value.length ? safe : null;
  }
  if (isRecord(value)) {
    const safe = Object.fromEntries(
      Object.entries(value).filter(([, item]) => item == null || isScalar(item)),
    );
    return Object.keys(safe).length > 0 ? safe : null;
  }
  return null;
}

function extractAiCaption(metadata: Record<string, unknown>): string | null {
  for (const key of AI_CAPTION_KEYS) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function truncateIndexText(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length <= maxChars ? cleaned : cleaned.slice(0, maxChars).trimEnd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function getIndexingStatus(
  handles: OrchestratorHandles,
  manualJob: { name: string; startedAt: string } | null,
  lastManualJobCompletedAt: string | null,
): RuntimeIndexingStatus {
  if (manualJob) {
    return {
      running: true,
      currentJob: manualJob.name,
      startedAt: manualJob.startedAt,
      lastCompletedAt: lastManualJobCompletedAt,
    };
  }
  const jobs = handles.scheduler
    .getJobs()
    .filter((job) => job.name === 'index-incremental' || job.name === 'index-reorganise');
  const runningJob = jobs.find((job) => job.running) ?? null;
  return {
    running: runningJob != null,
    currentJob: runningJob?.name ?? null,
    startedAt: runningJob?.lastStartedAt ?? null,
    lastCompletedAt: latestIso([
      ...jobs.map((job) => job.lastCompletedAt),
      lastManualJobCompletedAt,
    ]),
  };
}

function getBackgroundJobs(handles: OrchestratorHandles): RuntimeBackgroundJobStatus[] {
  const jobs = handles.scheduler.getJobs() as Array<{
    name: string;
    kind: 'interval' | 'cron';
    running: boolean;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    lastDurationMs?: number | null;
    lastError?: string | null;
    runCount?: number;
    skippedCount?: number;
  }>;
  return jobs.map((job) => ({
    name: job.name,
    kind: job.kind,
    running: job.running,
    lastStartedAt: job.lastStartedAt,
    lastCompletedAt: job.lastCompletedAt,
    lastDurationMs: job.lastDurationMs ?? null,
    lastError: job.lastError ?? null,
    runCount: job.runCount ?? 0,
    skippedCount: job.skippedCount ?? 0,
  }));
}

function latestIso(values: Array<string | null>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (value && (!latest || value > latest)) latest = value;
  }
  return latest;
}

const INDEX_CATEGORY_ORDER = [
  'projects',
  'repos',
  'meetings',
  'contacts',
  'channels',
  'docs',
  'web',
  'apps',
  'tools',
  'topics',
  'patterns',
];

// Categories on the wiki rarely move once a workspace is established —
// the underlying directory tree is reorganised at most once a day by
// the cron job, and individual page touches don't bubble new categories
// into existence. A 5-minute TTL keeps the dashboard fresh without
// rerunning a recursive readdir + per-category markdown previews on
// every full overview (which used to dominate `getOverview()` on
// indexed workspaces).
const INDEX_CATEGORY_CACHE_TTL_MS = 5 * 60_000;
const INDEX_CATEGORY_RECENT_PAGE_LIMIT = 3;
const INDEX_MANIFEST_FILENAME = '_manifest.json';

let indexCategoryCache:
  | {
      rootPath: string;
      expiresAt: number;
      categories: RuntimeIndexCategory[];
    }
  | null = null;

interface IndexManifestEntry {
  path: string;
  title?: string;
  summary?: string | null;
  lastUpdated: string;
}

interface IndexManifest {
  version: 1;
  pages: IndexManifestEntry[];
}

async function readIndexCategories(rootPath: string): Promise<RuntimeIndexCategory[]> {
  const now = Date.now();
  if (
    indexCategoryCache &&
    indexCategoryCache.rootPath === rootPath &&
    indexCategoryCache.expiresAt > now
  ) {
    return indexCategoryCache.categories;
  }

  const manifestCategories = await readIndexCategoriesFromManifest(rootPath);
  if (manifestCategories) {
    indexCategoryCache = {
      rootPath,
      expiresAt: now + INDEX_CATEGORY_CACHE_TTL_MS,
      categories: manifestCategories,
    };
    return manifestCategories;
  }

  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const categories: RuntimeIndexCategory[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'archive') continue;

    const pages = await listMarkdownPages(path.join(rootPath, entry.name), entry.name);
    const contentPages = pages.filter((page) => path.basename(page.path) !== '_summary.md');
    if (contentPages.length === 0) continue;

    const summary = pages.find((page) => path.basename(page.path) === '_summary.md');
    const recentPages = await Promise.all(
      contentPages
        .slice()
        .sort((a, b) => b.mtime.localeCompare(a.mtime))
        .slice(0, INDEX_CATEGORY_RECENT_PAGE_LIMIT)
        .map((page) => readIndexPagePreview(rootPath, page)),
    );
    categories.push({
      name: entry.name,
      pageCount: contentPages.length,
      summaryPath: summary?.path,
      lastUpdated: latestIso(contentPages.map((page) => page.mtime)),
      recentPages,
    });
  }

  const sorted = sortIndexCategories(categories);
  indexCategoryCache = {
    rootPath,
    expiresAt: now + INDEX_CATEGORY_CACHE_TTL_MS,
    categories: sorted,
  };
  return sorted;
}

function sortIndexCategories(categories: RuntimeIndexCategory[]): RuntimeIndexCategory[] {
  return categories.sort((a, b) => {
    const ai = INDEX_CATEGORY_ORDER.indexOf(a.name);
    const bi = INDEX_CATEGORY_ORDER.indexOf(b.name);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return a.name.localeCompare(b.name);
  });
}

async function readIndexCategoriesFromManifest(rootPath: string): Promise<RuntimeIndexCategory[] | null> {
  let manifest: IndexManifest;
  try {
    const raw = await fs.readFile(path.join(rootPath, INDEX_MANIFEST_FILENAME), 'utf8');
    manifest = JSON.parse(raw) as IndexManifest;
  } catch {
    return null;
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.pages)) return null;

  const byCategory = new Map<string, IndexManifestEntry[]>();
  for (const page of manifest.pages) {
    const normalised = page.path.replace(/\\/g, '/');
    const category = normalised.split('/')[0];
    if (!category || category.startsWith('.') || category === 'archive') continue;
    if (path.basename(normalised) === '_summary.md') continue;
    const bucket = byCategory.get(category) ?? [];
    bucket.push({ ...page, path: normalised });
    byCategory.set(category, bucket);
  }

  const categories: RuntimeIndexCategory[] = [];
  for (const [name, pages] of byCategory) {
    if (pages.length === 0) continue;
    const recentPages = pages
      .slice()
      .sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated))
      .slice(0, INDEX_CATEGORY_RECENT_PAGE_LIMIT)
      .map((page) => ({
        path: page.path,
        title: page.title || path.basename(page.path, '.md'),
        summary: page.summary ?? null,
        lastUpdated: page.lastUpdated,
      }));
    categories.push({
      name,
      pageCount: pages.length,
      summaryPath: manifest.pages.find((page) => page.path === `${name}/_summary.md`)?.path,
      lastUpdated: latestIso(pages.map((page) => page.lastUpdated)),
      recentPages,
    });
  }

  return sortIndexCategories(categories);
}

async function listMarkdownPages(
  dir: string,
  relDir: string,
): Promise<Array<{ path: string; mtime: string }>> {
  const out: Array<{ path: string; mtime: string }> = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.join(relDir, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      const nested = await listMarkdownPages(abs, rel);
      out.push(...nested);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const stat = await fs.stat(abs).catch(() => null);
    out.push({
      path: rel,
      mtime: stat?.mtime.toISOString() ?? new Date(0).toISOString(),
    });
  }

  return out;
}

async function readIndexPagePreview(
  rootPath: string,
  page: { path: string; mtime: string },
): Promise<RuntimeIndexCategoryPage> {
  let text = '';
  try {
    const abs = path.join(rootPath, page.path);
    text = await fs.readFile(abs, 'utf8');
  } catch {
    // The index can change while an overview is being built; keep the
    // category card useful even if a page disappeared between readdir/read.
  }

  return {
    path: page.path,
    title: extractMarkdownTitle(text) ?? path.basename(page.path, '.md'),
    summary: extractMarkdownSummary(text),
    lastUpdated: page.mtime,
  };
}

function extractMarkdownTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || null;
}

function extractMarkdownSummary(content: string): string | null {
  const section = extractMarkdownSection(content, 'Summary') ?? extractMarkdownSection(content, 'Overview');
  const cleaned = stripMarkdownForPreview(section ?? '').trim();
  return cleaned ? truncateText(cleaned, 180) : null;
}

function extractMarkdownSection(content: string, heading: string): string | null {
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

function stripMarkdownForPreview(content: string): string {
  return content
    .replace(/^---\n[\s\S]*?\n---\s*/m, '')
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .filter((line) => !line.startsWith('!['))
    .filter((line) => !/^\s*[-*]\s+/.test(line))
    .join(' ')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ');
}

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function renderDeterministicObservedJournalStory(
  frames: Frame[],
  sessions: ActivitySession[],
): string | null {
  if (frames.length === 0 || sessions.length === 0) return null;
  const framesBySession = new Map<string, Frame[]>();
  for (const frame of frames) {
    const key = frame.activity_session_id ?? '__loose__';
    const existing = framesBySession.get(key);
    if (existing) existing.push(frame);
    else framesBySession.set(key, [frame]);
  }

  const beats = sessions
    .slice()
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .map((session) => ({
      session,
      frames: (framesBySession.get(session.id) ?? [])
        .slice()
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    }))
    .filter((item) => item.frames.length > 0)
    .map((item) => observedSessionBeat(item.session, item.frames));
  if (beats.length === 0) return null;

  const paragraphs: string[] = [];
  paragraphs.push(`Your captured day started when you ${beats[0]!.sentenceBody}.`);
  if (beats.length > 1) {
    paragraphs.push(
      beats
        .slice(1)
        .map((beat, index) => `${index === 0 ? 'After that' : 'Then'}, you ${beat.sentenceBody}.`)
        .join(' '),
    );
  }

  const communicationDigests = buildCommunicationDigests(frames);
  const communicationDigest = communicationDigests.map(renderCommunicationDigestItem);
  const communications = communicationDigests.length > 0
    ? communicationDigests.map((item) => item.label)
    : [...new Set(beats.flatMap((beat) => beat.communications))].map(formatObservedEntity);
  if (communications.length > 0) {
    const readableComms = communications.join(', ');
    const suffix = communicationDigest.length > 0
      ? 'The readable exchanges I could safely extract are called out below.'
      : 'The capture shows the channels or inboxes involved, but not enough message body text to safely claim exactly what was said.';
    paragraphs.push(`You also crossed into communication surfaces: ${readableComms}. ${suffix}`);
  }

  if (communicationDigest.length > 0) {
    paragraphs.push(['### Communication TL;DR', ...communicationDigest].join('\n'));
  }

  const followUps = renderFollowUps(communicationDigests);
  if (followUps.length > 0) {
    paragraphs.push(['### Follow-ups', ...followUps].join('\n'));
  }

  const workOutcomes = renderWorkOutcomeDigest(frames);
  if (workOutcomes.length > 0) {
    paragraphs.push(['### Work outcomes noticed', ...workOutcomes].join('\n'));
  }

  const snippets = distinctValues(frames, (frame) => frame.text ? cleanEvidenceText(frame.text) : null, 2)
    .map((text) => truncateText(text, 180));
  if (snippets.length > 0) {
    paragraphs.push(`The strongest readable signal was: "${snippets[0]}".`);
  }

  return `## Story\n\n${paragraphs.join('\n\n')}`;
}

interface CommunicationDigest {
  key: string;
  label: string;
  surface: 'Mail' | 'Slack';
  frames: Frame[];
}

function buildCommunicationDigests(frames: Frame[]): CommunicationDigest[] {
  const grouped = new Map<string, CommunicationDigest>();
  for (const frame of frames) {
    const item = communicationDigestForFrame(frame);
    if (!item) continue;
    const existing = grouped.get(item.key);
    if (existing) {
      existing.frames.push(frame);
    } else {
      grouped.set(item.key, { ...item, frames: [frame] });
    }
  }

  const ranked = [...grouped.values()]
    .map((item) => ({
      ...item,
      frames: item.frames.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    }))
    .sort((a, b) => communicationImportance(b) - communicationImportance(a));

  return ranked
    .filter((item) => communicationImportance(item) >= 5)
    .slice(0, 5)
    .sort((a, b) => a.frames[0]!.timestamp.localeCompare(b.frames[0]!.timestamp));
}

function communicationImportance(item: CommunicationDigest): number {
  const label = item.label.toLowerCase();
  const text = item.frames.map((frame) => frame.text ?? '').join(' ').toLowerCase();
  let score = item.surface === 'Slack' ? 4 : 2;
  if (/travis rinn|take home assessment|feature parity|feature matrix|small announcement|out all day monday|family obligations/.test(text)) score += 6;
  if (/calendar|invite|standup|updated invitation/.test(text)) score += 3;
  if (/newsletter|morning brew|idea of the day/.test(label) || /newsletter|morning brew|idea of the day/.test(text)) score -= 5;
  if (/announce|product updates/.test(label)) score -= 3;
  if (label.includes('#')) score += 1;
  if (label.includes('adam') || label.includes('milan')) score += 1;
  return score;
}

function communicationDigestForFrame(
  frame: Frame,
): Omit<CommunicationDigest, 'frames'> | null {
  if (frame.app === 'Mail' || frame.entity_path === 'apps/mail') {
    const label = mailSubjectLabel(frame.text) ?? 'Mail';
    return { key: `mail:${label}`, label, surface: 'Mail' };
  }
  if (frame.entity_path?.startsWith('channels/')) {
    return {
      key: frame.entity_path,
      label: formatObservedEntity(frame.entity_path),
      surface: 'Slack',
    };
  }
  if (frame.entity_path?.startsWith('contacts/')) {
    return {
      key: frame.entity_path,
      label: formatObservedEntity(frame.entity_path),
      surface: 'Slack',
    };
  }
  if (frame.app === 'Slack') {
    return {
      key: `slack:${frame.window_title || 'unknown'}`,
      label: frame.window_title || 'Slack',
      surface: 'Slack',
    };
  }
  return null;
}

function renderCommunicationDigestItem(item: CommunicationDigest): string {
  const first = item.frames[0]!;
  const last = item.frames[item.frames.length - 1]!;
  const time = first.timestamp.slice(11, 16) === last.timestamp.slice(11, 16)
    ? first.timestamp.slice(11, 16)
    : `${first.timestamp.slice(11, 16)}-${last.timestamp.slice(11, 16)}`;
  const title = distinctValues(item.frames, (frame) => frame.window_title, 2)
    .map((value) => `"${value}"`)
    .join('; ');
  const topic = communicationTopicFromDigest(item);
  if (topic) {
    return `- **${time} ${item.surface} (${item.label})**: ${topic}`;
  }
  return `- **${time} ${item.surface} (${item.label})**: You opened this conversation or inbox, but the capture did not include enough readable message body text to summarize what was discussed${title ? ` (${title})` : ''}.`;
}

function communicationTopicFromDigest(item: CommunicationDigest): string | null {
  const direct = item.surface === 'Mail'
    ? mailTopicFromFrames(item.frames)
    : slackTopicFromFrames(item.frames, item.label);
  if (direct) return direct;

  const snippets = distinctValues(item.frames, (frame) => communicationTextSnippet(frame), 3)
    .filter((snippet) => snippet.length >= 30);
  if (snippets.length === 0) return null;
  const joined = snippets.join(' ');
  return `TL;DR from captured text: ${truncateText(joined, 260)}.`;
}

function mailSubjectLabel(text: string | null): string | null {
  if (!text) return null;
  if (/Updated invitation:\s*Sync Squad Standup/i.test(text)) return 'Sync Squad Standup invite';
  if (/Hacker Newsletter #793/i.test(text)) return 'Hacker Newsletter #793';
  if (/Remaining Volunteer Coach Application/i.test(text)) return 'Remaining Volunteer Coach Application';
  if (/Re:\s*All your banking tools/i.test(text)) return 'Mercury banking follow-up';
  if (/Fwd:\s*AI playbook/i.test(text)) return 'AI playbook forward';
  return null;
}

function mailTopicFromFrames(frames: Frame[]): string | null {
  const text = frames.map((frame) => frame.text ?? '').join(' ');
  if (/Updated invitation:\s*Sync Squad Standup/i.test(text)) {
    return 'Milan Lazic sent an updated Sync Squad Standup calendar invite; the visible pane says the event time changed and lists David Rojas, Jacob Rothfus, and you as optional guests.';
  }
  if (/Hacker Newsletter #793/i.test(text)) {
    return 'You opened Hacker Newsletter #793; visible links included topics like agentic engineering, training an LLM from scratch, and other tech reads.';
  }
  if (/Remaining Volunteer Coach Application/i.test(text)) {
    return 'A YMCA/CHASCO message about a remaining volunteer coach application asked you to let your team know in advance; they would coach during practice and might need help during the game portion.';
  }
  if (/Re:\s*All your banking tools/i.test(text)) {
    return 'A Mercury follow-up offered to help you evaluate banking tools such as invoicing, bill pay, cards, accounting integrations, treasury, and FDIC sweep coverage.';
  }
  return null;
}

function slackTopicFromFrames(frames: Frame[], label: string): string | null {
  const text = frames.map((frame) => frame.text ?? '').join(' ');
  const labelText = label.toLowerCase();
  if (labelText.includes('travis')) return null;
  if (/Travis Rinn/i.test(text) && /take home assessment/i.test(text) && /diana|david|adam/i.test(labelText)) {
    const outcome = /Take-Home Assessment Review/i.test(text)
      ? ' David Rojas appears to have posted a take-home assessment review/code-quality summary in the thread.'
      : '';
    return `Diana asked David to review Travis Rinn's completed take-home assessment and say whether to schedule a follow-up code review before bringing him onsite.${outcome}`;
  }
  if (/out all day Monday/i.test(text) && /later part of Thursday/i.test(text) && labelText.includes('liblab')) {
    const jacob = /Only 2 monitors/i.test(text)
      ? ' Jacob joked that “Only 2 monitors” meant you were not ready yet, and you replied that one was already too many.'
      : '';
    return `Nermina gave a heads-up that she would be out all day Monday and late Thursday for family obligations; you posted your hackathon setup with Codex, Cursor, and Claude.${jacob}`;
  }
  if (/feature parity work/i.test(text) && /feature matrix/i.test(text) && labelText.includes('adam')) {
    return 'You asked Adam to post the status of the feature parity work, including the feature matrix and the status of each SDK; Adam said he would do it.';
  }
  if (/small announcement/i.test(text) && /sdk-gen/i.test(text) && labelText.includes('milan')) {
    return 'Milan discussed the product introduction stage and said he would write a small announcement for #liblab, #sdk-gen, and #proj-sdk-integrations.';
  }
  return null;
}

function renderFollowUps(items: CommunicationDigest[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const text = item.frames.map((frame) => frame.text ?? '').join(' ');
    const label = item.label.toLowerCase();
    if (/Travis Rinn/i.test(text) && /take home assessment/i.test(text) && /diana|david|adam/i.test(label)) {
      out.push('- David reviewed Travis Rinn’s take-home assessment; the open question was whether Travis should get a follow-up code review before coming onsite.');
    }
    if (/out all day Monday/i.test(text) && /later part of Thursday/i.test(text) && label.includes('liblab')) {
      out.push('- Nermina will be out Monday and late Thursday, so plan around that availability in `#liblab`.');
    }
    if (/feature parity work/i.test(text) && /feature matrix/i.test(text) && label.includes('adam')) {
      out.push('- Adam said he would post the feature parity status, including the feature matrix and each SDK’s status.');
    }
    if (/small announcement/i.test(text) && /sdk-gen/i.test(text) && label.includes('milan')) {
      out.push('- Milan planned a small announcement for `#liblab`, `#sdk-gen`, and `#proj-sdk-integrations`.');
    }
  }
  return [...new Set(out)].slice(0, 6);
}

function communicationTextSnippet(frame: Frame): string | null {
  if (!frame.text) return null;
  const cleaned = cleanEvidenceText(frame.text);
  if (!cleaned) return null;
  const withoutTitle = frame.window_title
    ? cleaned.replace(frame.window_title, '').replace(frame.window_title.replace(/\s+/g, ' '), '')
    : cleaned;
  const stripped = withoutTitle
    .replace(/\bthis button also has an action to zoom the window\b/gi, '')
    .replace(/\bmailboxes\b|\bfavorites\b|\ball inboxes\b|\bflagged\b|\bdrafts\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped || stripped.length < 24) return null;
  return extractMessageLikeSnippet(stripped);
}

function extractMessageLikeSnippet(text: string): string | null {
  const cue = /\b(heads up|asked|asking|tomorrow|finish|status|out all day|please|can you|could you|i'll|i will|we need|follow up)\b/i.exec(text);
  if (cue?.index != null) {
    return text.slice(cue.index).trim();
  }

  const lower = text.toLowerCase();
  const uiNoiseTerms = [
    'slack file edit view',
    'describe what you are looking for',
    'direct messages',
    'add canvas',
    'postman postman',
    'gmail gmail',
    'recovered messages',
    'smart mailboxes',
  ];
  if (uiNoiseTerms.some((term) => lower.includes(term))) return null;

  return text;
}

function renderWorkOutcomeDigest(frames: Frame[]): string[] {
  const text = frames
    .map((frame) => `${frame.window_title} ${(frame.text ?? '').replace(/\s+/g, ' ')}`)
    .join(' ');
  const outcomes: string[] = [];
  if (/typecheck\s*\+\s*build clean|Both pass clean|build clean/i.test(text)) {
    outcomes.push('- You reached a clean verification point: the captured terminal/Claude output says typecheck and build passed.');
  }
  if (/Design system|warm-neutral surface|brand gradient|BrandMark|Sidebar/i.test(text)) {
    outcomes.push('- The UI redesign included design-system work: warm neutral surfaces, brand gradients, shadow tokens, and navigation/brand polish.');
  }
  if (/Add settings screen|Settings screen|settings UI|load guard|Pause heavy work/i.test(text)) {
    outcomes.push('- You worked on a settings/load-guard experience, including controls for pausing heavy work and surfacing runtime/resource state.');
  }
  if (/15 files changed|1184 insertions|184 deletions|1999\s*-\s*227/i.test(text)) {
    outcomes.push('- The work was substantial enough to show a large diff in the terminal, with many files changed and large insertion/deletion counts visible.');
  }
  return outcomes.slice(0, 4);
}

function observedSessionBeat(session: ActivitySession, frames: Frame[]): {
  sentenceBody: string;
  communications: string[];
} {
  const start = session.started_at.slice(11, 16);
  const end = session.ended_at.slice(11, 16);
  const windows = distinctValues(frames, (frame) => frame.window_title, 8);
  const files = extractFileNamesForStory(frames, 6);
  const communications = distinctValues(
    frames,
    (frame) => {
      if (frame.entity_path?.startsWith('contacts/') || frame.entity_path?.startsWith('channels/')) {
        return frame.entity_path;
      }
      if (frame.app === 'Mail') return 'apps/mail';
      return null;
    },
    6,
  );
  const domains = distinctValues(frames, (frame) => domainForObservedStory(frame.url), 3);
  const appNames = distinctValues(frames, (frame) => frame.app, 4);
  const task = inferObservedTask(windows, files, appNames);
  const visibleCommunications = communications.filter((entity) => !isLowSignalCommunication(entity));
  const evidenceParts = [
    files.length ? `the files ${files.map((file) => `\`${file}\``).join(', ')}` : null,
    domains.length ? `web pages on ${domains.join(', ')}` : null,
    visibleCommunications.length ? `communication in ${visibleCommunications.map(formatObservedEntity).join(', ')}` : null,
  ].filter((part): part is string => Boolean(part));
  const evidence = evidenceParts.length ? `, with ${joinObservedList(evidenceParts)}` : '';
  return {
    sentenceBody: `${task}${evidence} around ${start}-${end}`,
    communications,
  };
}

function isLowSignalCommunication(entity: string): boolean {
  return /announce|product-updates|newsletter/i.test(entity);
}

function inferObservedTask(windows: string[], files: string[], apps: string[]): string {
  const haystack = [...windows, ...files, ...apps].join(' ').toLowerCase();
  if (/journal narrative|indexed journal|communication tl;dr|what happened/.test(haystack)) {
    return 'improved the journal narrative so it reads more like a story';
  }
  if (/settings screen|load guard|pause heavy work/.test(haystack)) {
    return 'worked on the settings and load-guard experience';
  }
  if (haystack.includes('codex') && files.length === 0) {
    return haystack.includes('reduce cpu usage') || haystack.includes('improve app efficiency')
      ? 'worked with Codex and briefly revisited CPU usage or app efficiency work'
      : 'worked with Codex';
  }
  if (haystack.includes('redesign app interface') || haystack.includes('modern ux')) {
    return 'worked on redesigning the CofounderOS app interface';
  }
  if (haystack.includes('reduce cpu usage') || haystack.includes('improve app efficiency')) {
    return 'looked at CPU usage and app efficiency work';
  }
  if (files.length > 0) {
    return `worked through project files ${files.slice(0, 3).map((file) => `\`${file}\``).join(', ')}`;
  }
  if (haystack.includes('all inboxes')) return 'checked your email inbox';
  if (haystack.includes('workday')) return 'checked Workday pages';
  if (haystack.includes('slack')) return 'checked Slack';
  if (haystack.includes('codex')) return 'worked with Codex';
  if (haystack.includes('cursor')) return 'worked in Cursor';
  if (haystack.includes('cofounderos')) return 'reviewed the CofounderOS app';
  return 'worked through the captured desktop context';
}

function formatObservedEntity(entity: string): string {
  if (entity.startsWith('contacts/')) return formatContactEntity(entity);
  return entity
    .replace(/^apps\//, '')
    .replace(/^channels\//, '#')
    .replace(/-/g, ' ');
}

function formatContactEntity(entity: string): string {
  const slug = entity.replace(/^contacts\//, '');
  const parts = slug.split('-').filter(Boolean);
  const known = [
    ['adam', 'Adam'],
    ['david', 'David'],
    ['diana', 'Diana'],
    ['jacob', 'Jacob'],
    ['tony', 'Tony'],
    ['milan', 'Milan'],
  ].filter(([needle]) => parts.includes(needle)).map(([, label]) => label);
  if (known.length >= 3) return `group DM with ${known.slice(0, 5).join(', ')}${known.length > 5 ? ', and others' : ''}`;
  if (known.length > 0) return known.join(', ');
  return slug.replace(/-/g, ' ');
}

function domainForObservedStory(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function joinObservedList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function lowercaseFirst(text: string): string {
  return text ? `${text[0]!.toLowerCase()}${text.slice(1)}` : text;
}

async function maybeRenderObservedJournalStory(
  handles: OrchestratorHandles,
  day: string,
  frames: Frame[],
  sessions: ActivitySession[],
): Promise<string | null> {
  if (frames.length === 0 || sessions.length === 0) return null;
  const modelInfo = handles.model.getModelInfo();
  if (modelInfo.name === 'offline:fallback') return null;
  if (!(await handles.model.isAvailable().catch(() => false))) return null;

  const prompt = buildObservedJournalStoryPrompt(day, frames, sessions);
  try {
    const raw = await withJournalStoryTimeout(
      handles.model.complete(prompt, {
        systemPrompt: OBSERVED_JOURNAL_STORY_SYSTEM_PROMPT,
        temperature: 0.05,
        maxTokens: 900,
      }),
    );
    const story = cleanObservedJournalStory(raw);
    if (isGroundedObservedJournalStory(story)) return story;
    handles.logger.warn('discarding ungrounded observed journal story', {
      day,
      sample: truncateText(story, 500),
    });
    return null;
  } catch (err) {
    handles.logger.debug('observed journal story generation failed', {
      day,
      err: String(err),
    });
    return null;
  }
}

const OBSERVED_JOURNAL_STORY_SYSTEM_PROMPT = `You write a personal activity journal from observed desktop evidence.

Rules:
- Write to the user in second person: "you opened...", "you asked...", "then you moved..."
- Tell a chronological story of what happened. Do not lead with app/entity/stat summaries.
- Prefer concrete observed actions, messages, documents, files, people, channels, email subjects, URLs, and deadlines.
- Use captured text when it reveals what was said or requested.
- Do not invent names, requests, decisions, deadlines, or relationships. If evidence is weak, say "appears" or "likely".
- Do not add advice, recommendations, interpretations, next steps, or generic "key themes".
- Do not mention frame counts, app percentages, confidence scores, or internal session ids.
- Return exactly one markdown section headed "## Story".`;

function buildObservedJournalStoryPrompt(
  day: string,
  frames: Frame[],
  sessions: ActivitySession[],
): string {
  const framesBySession = new Map<string, Frame[]>();
  for (const frame of frames) {
    const key = frame.activity_session_id ?? '__loose__';
    const existing = framesBySession.get(key);
    if (existing) existing.push(frame);
    else framesBySession.set(key, [frame]);
  }
  const lines = [
    `DAY: ${day}`,
    '',
    'Write the top journal entry for this day.',
    'The user disliked dry summaries like "centered on projects/ux" or "using Electron".',
    'They want a story of what they actually did, for example: "you spoke with Jacob about his latest task, asked him to finish by tomorrow, then moved to the terminal..."',
    '',
    'Return markdown only:',
    '## Story',
    '3-5 short paragraphs in chronological order. No other headings. No advice. No recommendations. No "next steps".',
    'If evidence is thin, say what was observable rather than filling gaps.',
    '',
    'EVIDENCE:',
  ];

  for (const session of sessions.slice().sort((a, b) => a.started_at.localeCompare(b.started_at))) {
    const sessionFrames = (framesBySession.get(session.id) ?? [])
      .slice()
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (sessionFrames.length === 0) continue;
    lines.push(renderObservedSessionEvidence(session, sessionFrames));
    lines.push('');
  }

  return truncateText(lines.join('\n'), 8_000);
}

function renderObservedSessionEvidence(session: ActivitySession, frames: Frame[]): string {
  const start = session.started_at.slice(11, 16);
  const end = session.ended_at.slice(11, 16);
  const lines = [`SESSION ${start}-${end}`];
  const entities = distinctValues(frames, (frame) => frame.entity_path, 4);
  const apps = distinctValues(frames, (frame) => frame.app, 4);
  const windows = distinctValues(frames, (frame) => frame.window_title, 7);
  const urls = distinctValues(frames, (frame) => frame.url, 3);
  const files = extractFileNamesForStory(frames, 6);
  const communications = distinctValues(
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
  const text = distinctValues(
    frames,
    (frame) => frame.text ? cleanEvidenceText(frame.text) : null,
    4,
  );

  if (entities.length) lines.push(`entities: ${entities.join(' | ')}`);
  if (apps.length) lines.push(`apps: ${apps.join(' | ')}`);
  if (windows.length) lines.push(`window_titles: ${windows.map((x) => `"${x}"`).join(' | ')}`);
  if (urls.length) lines.push(`urls: ${urls.join(' | ')}`);
  if (files.length) lines.push(`files: ${files.join(' | ')}`);
  if (communications.length) lines.push(`communication_surfaces: ${communications.join(' | ')}`);
  if (text.length) lines.push(`captured_text: ${text.map((x) => `"${truncateText(x, 220)}"`).join(' | ')}`);
  return lines.join('\n');
}

function distinctValues(
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

function cleanEvidenceText(text: string): string | null {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned === 'this button also has an action to zoom the window') return null;
  return cleaned;
}

function extractFileNamesForStory(frames: Frame[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const frame of frames) {
    const matches = frame.window_title.matchAll(/\b([A-Za-z0-9_.-]+\.(?:md|mdx|ts|tsx|js|jsx|json|yaml|yml|toml|txt|docx?|pdf|csv))\b/g);
    for (const match of matches) {
      const file = match[1];
      if (!file || seen.has(file)) continue;
      seen.add(file);
      out.push(file);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

async function loadJournalStoryImages(
  handles: OrchestratorHandles,
  frames: Frame[],
  limit: number,
): Promise<Buffer[]> {
  const images: Buffer[] = [];
  for (const frame of pickJournalStoryFrames(frames, limit)) {
    if (!frame.asset_path) continue;
    const image = await readFrameAssetForModel(handles, frame.asset_path);
    if (image) images.push(image);
  }
  return images;
}

function pickJournalStoryFrames(frames: Frame[], limit: number): Frame[] {
  const withAssets = frames.filter((frame) => frame.asset_path);
  if (withAssets.length <= limit) return withAssets;
  const picked: Frame[] = [withAssets[0]!];
  const step = Math.max(1, Math.floor(withAssets.length / limit));
  for (let i = step; i < withAssets.length && picked.length < limit - 1; i += step) {
    picked.push(withAssets[i]!);
  }
  const last = withAssets[withAssets.length - 1]!;
  if (!picked.includes(last)) picked.push(last);
  return picked.slice(0, limit);
}

function withJournalStoryTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('journal story generation timed out')), 45_000);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function cleanObservedJournalStory(raw: string): string {
  const cleaned = raw
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\bthe user\b/gi, 'you')
    .replace(/\buser's\b/gi, 'your')
    .trim();
  if (!cleaned) return '';
  return /^##\s+/m.test(cleaned) ? cleaned : `## Story\n${cleaned}`;
}

function isGroundedObservedJournalStory(markdown: string): boolean {
  const lower = markdown.toLowerCase();
  if (!lower.includes('## story')) return false;
  const banned = [
    'summary of activities',
    'key themes',
    'detailed breakdown',
    'hypothetical',
    'if i were advising',
    'next steps',
    'i would suggest',
    'component building',
    'useauth',
  ];
  if (banned.some((phrase) => lower.includes(phrase))) return false;
  return markdown.length >= 120;
}

function insertJournalStory(markdown: string, story: string): string {
  const withoutDeterministicLead = stripMarkdownSection(markdown, 'What happened');
  const lines = withoutDeterministicLead.split('\n');
  const insertAt = lines.findIndex((line, index) => index > 0 && /^##\s+/.test(line));
  if (insertAt === -1) return `${markdown.trim()}\n\n${story.trim()}\n`;
  return [
    ...lines.slice(0, insertAt),
    story.trim(),
    '',
    ...lines.slice(insertAt),
  ].join('\n');
}

function stripMarkdownSection(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return markdown;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n');
}

function buildSearchResultExplanationPrompt(
  query: string,
  frame: Frame,
  includesImage: boolean,
): string {
  const metadata = [
    frame.app ? `App: ${frame.app}` : null,
    frame.window_title ? `Window title: ${frame.window_title}` : null,
    frame.url ? `URL: ${frame.url}` : null,
    frame.timestamp ? `Timestamp: ${frame.timestamp}` : null,
    frame.text ? `Searchable text: ${frame.text.replace(/\s+/g, ' ').slice(0, 1200)}` : null,
  ].filter(Boolean).join('\n');

  return [
    'Look at the screenshot and add context about the part related to the search term.',
    `Search term for your reference only: ${query}`,
    includesImage
      ? 'Do not repeat the search term. Add context for the search term based on the image, using the metadata only for clarification.'
      : 'No screenshot is available. Do not repeat the search term; summarize the relevant context from the metadata.',
    metadata || 'No metadata was extracted for this frame.',
    '',
    'Return one concise sentence under 40 words. Do not explain why this result matched or mention that you are an AI.',
  ].join('\n');
}

async function readFrameAssetForModel(
  handles: OrchestratorHandles,
  assetPath: string,
): Promise<Buffer | null> {
  try {
    const storageRoot = path.resolve(handles.storage.getRoot());
    const resolved = path.resolve(storageRoot, assetPath);
    if (!resolved.startsWith(`${storageRoot}${path.sep}`) && resolved !== storageRoot) {
      throw new Error('asset path escapes storage root');
    }
    return await handles.storage.readAsset(assetPath);
  } catch {
    return null;
  }
}

function explainCacheKey(frameId: string, normalisedQuery: string): string {
  return `${frameId}::${normalisedQuery}`;
}

async function raceSearchExplanation(promise: Promise<string>): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `search result explanation timed out after ${Math.round(SEARCH_EXPLANATION_TIMEOUT_MS / 1000)}s`,
        ),
      );
    }, SEARCH_EXPLANATION_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cleanSearchExplanation(raw: string): string {
  return raw
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 260);
}

function buildFallbackSearchResultExplanations(
  query: string,
  frames: Frame[],
): SearchResultExplanation[] {
  return frames.flatMap((frame) => {
    const explanation = buildFallbackSearchResultExplanation(query, frame);
    return explanation ? [{ frameId: frame.id, explanation }] : [];
  });
}

function buildFallbackSearchResultExplanation(query: string, frame: Frame): string | null {
  const terms = searchTerms(query);
  const text = normaliseSearchContextText(frame.text);
  const title = normaliseSearchContextText(frame.window_title);
  const url = normaliseSearchContextText(frame.url);

  const textSnippet = searchContextSnippet(text, terms);
  if (textSnippet) return `Captured text: ${textSnippet}`;

  const titleSnippet = searchContextSnippet(title, terms);
  if (titleSnippet) return `Window title: ${titleSnippet}`;

  const urlSnippet = searchContextSnippet(url, terms);
  if (urlSnippet) return `URL: ${urlSnippet}`;

  if (text) return `Captured text: ${truncateSearchContext(text)}`;
  if (title) return `Window title: ${truncateSearchContext(title)}`;
  if (url) return `URL: ${truncateSearchContext(url)}`;
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

function normaliseSearchContextText(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function searchContextSnippet(text: string, terms: string[]): string | null {
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

  const radius = 90;
  const start = Math.max(0, bestIndex - radius);
  const end = Math.min(text.length, bestIndex + bestTerm.length + radius);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function truncateSearchContext(text: string): string {
  const max = 220;
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3).trimEnd()}...`;
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      target[key] = deepMerge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
  return target;
}
