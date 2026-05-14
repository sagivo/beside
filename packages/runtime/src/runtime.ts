import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createLogger,
  defaultDataDir,
  expandPath,
  loadConfig,
  validateConfig,
  writeConfig,
  writeDefaultConfigIfMissing,
} from '@beside/core';
import type {
  ActivitySession, CaptureStatus, CaptureHookDefinition, DayEvent, DayEventKind, ExportStatus, Frame,
  FrameQuery, HookRecord, HookRecordQuery, IndexState, Logger, Meeting, RawEvent, StorageStats,
} from '@beside/interfaces';
import {
  bootstrapModel, buildOrchestrator, assertHeavyWorkAllowed, runFullReindex,
  runIncremental, runReorganisation, startAll, stopAll, type HookWidgetManifestRuntime, type OrchestratorHandles, type OrchestratorOptions,
} from './orchestrator.js';

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
  index: IndexState & { categories: RuntimeIndexCategory[] };
  indexing: RuntimeIndexingStatus;
  model: { name: string; isLocal: boolean; ready: boolean };
  exports: ExportStatus[];
  backgroundJobs: RuntimeBackgroundJobStatus[];
  system: {
    load: number | null;
    memory: { totalMB: number; freeMB: number; usedRatio: number };
    power: { source: 'ac' | 'battery' | 'unknown'; batteryPercent: number | null };
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
    recent: Array<{ path: string; title: string; kind: string; frameCount: number; lastSeen: string }>;
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

const OVERVIEW_CACHE_TTL_MS = 30_000;
const OVERVIEW_SLOW_LOG_MS = 500;
const EXPLAIN_SEARCH_CACHE_MAX = 256;
const SEARCH_EXPLANATION_TIMEOUT_MS = 20_000;
const MANUAL_EVENT_SCAN_OCR_TICKS = 6;
const MANUAL_EVENT_SCAN_LOOKBACK_DAYS = 2;

export class BesideRuntime {
  private readonly logger: Logger;
  private readonly opts: OrchestratorOptions;
  private handles: OrchestratorHandles | null = null;
  private status: RuntimeStatus = 'not_started';
  private overviewCache: { value: RuntimeOverview; expiresAt: number } | null = null;
  private overviewInFlight: Promise<RuntimeOverview> | null = null;
  private manualJob: { name: string; startedAt: string } | null = null;
  private lastManualJobCompletedAt: string | null = null;
  private readonly explainSearchCache = new Map<string, string>();

  constructor(opts: RuntimeOptions = {}) {
    this.logger = opts.logger ?? createLogger({ level: 'info' });
    this.opts = { configPath: opts.configPath, workspaceRoot: opts.workspaceRoot };
  }

  async init(): Promise<RuntimeInitResult> {
    return await writeDefaultConfigIfMissing(defaultDataDir());
  }

  async start(options: { bootstrap?: boolean } = {}): Promise<void> {
    if (this.status === 'running') return;
    this.status = 'starting';
    const handles = await this.getOrCreateHandles();
    if (options.bootstrap !== false) await bootstrapModel(handles);
    await startAll(handles);
    this.status = 'running';
    this.invalidateOverview();
  }

  async bootstrapModel(onProgress?: Parameters<typeof bootstrapModel>[1], opts?: Parameters<typeof bootstrapModel>[2]): Promise<void> {
    await this.withHandles((handles) => bootstrapModel(handles, onProgress, opts));
  }

  async stop(): Promise<void> {
    if (!this.handles) { this.status = 'stopped'; return; }
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

  async getOverview(options: { forceRefresh?: boolean; mode?: 'full' | 'fast' } = {}): Promise<RuntimeOverview> {
    if (options.mode === 'fast') return await this.getFastOverview();
    const now = Date.now();
    if (!options.forceRefresh && this.overviewCache && this.overviewCache.expiresAt > now) return this.overviewCache.value;
    if (!options.forceRefresh && this.overviewInFlight) return await this.overviewInFlight;

    const buildStartedAt = Date.now();
    const promise = this.withHandles(async (handles) => {
      const timings: Record<string, number> = {};
      const timed = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
        const startedAt = Date.now();
        try { return await fn(); } finally { timings[name] = Date.now() - startedAt; }
      };

      const capture = handles.capture.getStatus();
      try {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const hourAgo = new Date(Date.now() - 3600000);
        const [todayCount, lastHourCount] = await timed('captureCounts', () => Promise.all([
          handles.storage.countEvents({ from: today.toISOString() }),
          handles.storage.countEvents({ from: hourAgo.toISOString() })
        ]));
        capture.eventsToday = todayCount; capture.eventsLastHour = lastHourCount;
      } catch {}

      const storage = await timed('storageStats', () => handles.storage.getStats());
      const index = await timed('indexState', () => handles.strategy.getState());
      const categories = await timed('indexCategories', () => readIndexCategories(index.rootPath).catch(() => []));
      const indexing = await timed('indexingStatus', () => getIndexingStatus(handles, this.manualJob, this.lastManualJobCompletedAt));
      const modelInfo = await timed('modelInfo', () => handles.model.getModelInfo());
      const ready = await timed('modelAvailability', () => handles.model.isAvailable().catch(() => false));
      const loadSnapshot = await timed('loadGuard', () => handles.loadGuard.snapshot());
      const exports = await timed('exports', () => handles.exports.map((exp) => exp.getStatus()));
      const backgroundJobs = await timed('backgroundJobs', () => getBackgroundJobs(handles));

      const overviewDurationMs = Date.now() - buildStartedAt;
      if (overviewDurationMs >= OVERVIEW_SLOW_LOG_MS) this.logger.debug('overview generated slowly', { durationMs: overviewDurationMs });

      return {
        status: this.status, configPath: handles.loaded.sourcePath, dataDir: handles.loaded.dataDir,
        storageRoot: handles.storage.getRoot(), capture, storage, index: { ...index, categories },
        indexing, model: { name: modelInfo.name, isLocal: modelInfo.isLocal, ready }, exports, backgroundJobs,
        system: {
          load: loadSnapshot.normalised, memory: loadSnapshot.memory, power: loadSnapshot.power,
          loadGuardEnabled: handles.config.system.load_guard.enabled,
          backgroundModelJobs: handles.config.system.background_model_jobs,
          overviewGeneratedAt: new Date().toISOString(), overviewDurationMs, overviewCacheTtlMs: OVERVIEW_CACHE_TTL_MS,
          overviewMode: 'full' as const, overviewTimings: timings,
        },
      };
    });

    this.overviewInFlight = promise;
    try {
      const overview = await promise;
      this.overviewCache = { value: overview, expiresAt: Date.now() + OVERVIEW_CACHE_TTL_MS };
      return overview;
    } finally {
      if (this.overviewInFlight === promise) this.overviewInFlight = null;
    }
  }

  private async getFastOverview(): Promise<RuntimeOverview> {
    if (!this.overviewCache) return await this.getOverview({ forceRefresh: true });
    const startedAt = Date.now();
    return await this.withHandles(async (handles) => {
      const cached = this.overviewCache!.value;
      const capture = handles.capture.getStatus();
      capture.eventsToday = cached.capture.eventsToday; capture.eventsLastHour = cached.capture.eventsLastHour; capture.storageBytesToday = cached.capture.storageBytesToday;
      const snapshot = handles.loadGuard.snapshot();
      const overviewDurationMs = Date.now() - startedAt;

      return {
        ...cached, status: this.status, capture,
        indexing: getIndexingStatus(handles, this.manualJob, this.lastManualJobCompletedAt),
        exports: handles.exports.map((exp) => exp.getStatus()), backgroundJobs: getBackgroundJobs(handles),
        system: { ...cached.system, load: snapshot.normalised, memory: snapshot.memory, power: snapshot.power, overviewGeneratedAt: new Date().toISOString(), overviewDurationMs, overviewMode: 'fast' as const, overviewTimings: { fastPatch: overviewDurationMs } },
      };
    });
  }

  async getStats(): Promise<RuntimeStats> {
    return await this.withHandles(async (handles) => {
      const overview = await this.getOverview();
      const journalDays = await handles.storage.listDays();
      const recentEntities = await handles.storage.listEntities({ limit: 10 }).catch(() => []);
      return { overview, journalDays, entities: { total: recentEntities.length, recent: recentEntities } };
    });
  }

  async runDoctor(): Promise<RuntimeDoctorCheck[]> {
    const checks: RuntimeDoctorCheck[] = [];
    const loaded = await loadConfig(this.opts.configPath);
    checks.push({
      area: 'config', status: loaded.sourcePath === '<defaults>' ? 'warn' : 'ok',
      message: loaded.sourcePath === '<defaults>' ? 'Using built-in defaults; config.yaml has not been created yet' : `Config loaded from ${loaded.sourcePath}`,
      action: loaded.sourcePath === '<defaults>' ? 'Run init or open the desktop setup flow' : undefined,
    });
    checks.push({ area: 'data', status: 'ok', message: `Data directory: ${loaded.dataDir}` });
    try {
      await fs.mkdir(loaded.dataDir, { recursive: true });
      await fs.access(loaded.dataDir);
      checks.push({ area: 'data', status: 'ok', message: 'Data directory is writable' });
    } catch (err) {
      checks.push({ area: 'data', status: 'fail', message: 'Data directory is not writable', detail: String(err) });
    }

    await this.withHandles(async (handles) => {
      const modelInfo = handles.model.getModelInfo();
      const modelReady = await handles.model.isAvailable().catch(() => false);
      checks.push({
        area: 'model', status: modelReady ? 'ok' : 'warn',
        message: modelReady ? `${modelInfo.name} is ready` : `${modelInfo.name} is not reachable`,
        action: modelReady ? undefined : 'Prepare the local AI model from setup',
      });
      checks.push({ area: 'storage', status: await handles.storage.isAvailable().catch(() => false) ? 'ok' : 'fail', message: `Storage root: ${handles.storage.getRoot()}` });
      checks.push({ area: 'ai-connection', status: handles.exports.find((e) => e.name === 'mcp') ? 'ok' : 'warn', message: handles.exports.find((e) => e.name === 'mcp') ? 'AI app connection export is configured' : 'AI app connection export is not configured' });
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
    if (!validation.ok) throw new Error(`Invalid config: ${validation.issues.map((i: any) => `${i.path}: ${i.message}`).join('; ')}`);
    await writeConfig(validation.config, this.opts.configPath);
    if (this.handles) await this.stop();
    return await loadConfig(this.opts.configPath);
  }

  async listMeetings(query: { from?: string; to?: string; limit?: number } = {}): Promise<Meeting[]> {
    return await this.withHandles(async (handles) => handles.storage.listMeetings({ from: query.from, to: query.to, order: 'recent', limit: query.limit ?? 200 }).catch(() => []));
  }

  async listDayEvents(query: { day?: string; from?: string; to?: string; kind?: DayEventKind; limit?: number; order?: 'recent' | 'chronological'; } = {}): Promise<DayEvent[]> {
    return await this.withHandles(async (handles) => handles.storage.listDayEvents({ day: query.day, from: query.from, to: query.to, kind: query.kind, order: query.order ?? (query.day ? 'chronological' : 'recent'), limit: query.limit ?? (query.day ? 500 : 2000) }).catch(() => []));
  }

  async listJournalDays(): Promise<string[]> {
    return await this.withHandles((handles) => handles.storage.listDays());
  }

  // -----------------------------------------------------------------------
  // Capture hooks
  // -----------------------------------------------------------------------

  async listCaptureHookDefinitions(): Promise<CaptureHookDefinition[]> {
    return await this.withHandles(async (handles) => handles.captureHooks.listDefinitions());
  }

  async getCaptureHookDiagnostics() {
    return await this.withHandles(async (handles) => handles.captureHooks.getDiagnostics());
  }

  async listCaptureHookWidgetManifests(): Promise<HookWidgetManifestRuntime[]> {
    return await this.withHandles(async (handles) => [...handles.hookWidgetManifests]);
  }

  async queryCaptureHookStorage(hookId: string, query: HookRecordQuery = {}): Promise<HookRecord[]> {
    return await this.withHandles(async (handles) => handles.captureHooks.queryRecords(hookId, query));
  }

  async mutateCaptureHookStorage(
    hookId: string,
    mutation: {
      collection: string;
      id: string;
      data: unknown;
      evidenceEventIds?: string[];
      contentHash?: string | null;
    },
  ): Promise<HookRecord | null> {
    return await this.withHandles(async (handles) => handles.captureHooks.mutateRecord(hookId, mutation));
  }

  onCaptureHookUpdate(listener: (hookId: string) => void): () => void {
    if (!this.handles) return () => {};
    return this.handles.captureHooks.onUpdate(listener);
  }

  async getJournalDay(day: string): Promise<RuntimeJournalDay> {
    return await this.withHandles(async (handles) => ({
      day, frames: (await handles.storage.getJournal(day)).slice().sort((a, b) => Date.parse(b.timestamp ?? '') - Date.parse(a.timestamp ?? '')),
      sessions: await handles.storage.listSessions({ day, limit: 500 }).catch(() => []),
    }));
  }

  /**
   * Returns the rendered `journal/<day>.md` produced by the markdown
   * export plugin, if it exists. Used by the desktop Journal view to
   * surface the model-enriched day story alongside the agenda.
   */
  async readJournalMarkdown(day: string): Promise<{ day: string; path: string | null; content: string | null }> {
    return await this.withHandles(async (handles) => {
      const md = handles.config.export?.plugins?.find((p: any) => p.name === 'markdown' && p.enabled !== false) as any;
      if (!md) return { day, path: null, content: null };
      const out = typeof md.path === 'string' && md.path.trim() ? md.path : '~/.beside/export/markdown';
      const file = path.join(expandPath(out), 'journal', `${day}.md`);
      try { return { day, path: file, content: await fs.readFile(file, 'utf8') }; }
      catch { return { day, path: file, content: null }; }
    });
  }

  async searchFrames(query: FrameQuery): Promise<Frame[]> {
    return await this.withHandles((handles) => handles.storage.searchFrames(query));
  }

  async explainSearchResults(query: ExplainSearchResultsQuery): Promise<SearchResultExplanation[]> {
    const text = query.text.trim();
    if (!text || query.frames.length === 0) return [];
    const cacheText = text.toLowerCase().replace(/\s+/g, ' ');
    const cached: SearchResultExplanation[] = [];
    const misses: typeof query.frames = [];

    for (const frame of query.frames) {
      const key = `${frame.id}::${cacheText}`;
      const hit = this.explainSearchCache.get(key);
      if (hit !== undefined) {
        this.explainSearchCache.delete(key);
        this.explainSearchCache.set(key, hit);
        const explanation = hit || buildFallbackSearchResultExplanation(text, frame);
        if (explanation) cached.push({ frameId: frame.id, explanation });
      } else misses.push(frame);
    }

    if (misses.length === 0) return cached;

    return await this.withHandles(async (handles) => {
      if (!(await handles.model.isAvailable().catch(() => false))) return [...cached, ...buildFallbackSearchResultExplanations(text, misses)];

      const modelInfo = handles.model.getModelInfo();
      const fresh: SearchResultExplanation[] = [];
      for (const frame of misses) {
        const key = `${frame.id}::${cacheText}`;
        try {
          const image = modelInfo.supportsVision && frame.asset_path ? await readFrameAssetForModel(handles, frame.asset_path) : null;
          const prompt = buildSearchResultExplanationPrompt(text, frame, image != null);
          const raw = await raceSearchExplanation(image ? handles.model.completeWithVision(prompt, [image], { maxTokens: 120, temperature: 0.2 }) : handles.model.complete(prompt, { maxTokens: 120, temperature: 0.2 }));
          const explanation = cleanSearchExplanation(raw);
          this.rememberExplainCache(key, explanation);
          const displayExplanation = explanation || buildFallbackSearchResultExplanation(text, frame);
          if (displayExplanation) fresh.push({ frameId: frame.id, explanation: displayExplanation });
        } catch (err) {
          handles.logger.debug('search result explanation failed', { frameId: frame.id, err: String(err) });
          const fallback = buildFallbackSearchResultExplanation(text, frame);
          if (fallback) fresh.push({ frameId: frame.id, explanation: fallback });
        }
      }
      return [...cached, ...fresh];
    });
  }

  private rememberExplainCache(key: string, value: string): void {
    if (this.explainSearchCache.has(key)) this.explainSearchCache.delete(key);
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
      const events = sourceIds.length > 0 ? await handles.storage.readEvents({ ids: sourceIds, limit: sourceIds.length }) : [];
      const metadata = buildDisplayMetadata(frame, events);
      return { frameId: frame.id, caption: extractAiCaption(metadata), indexingText: buildFrameIndexingText(frame), metadata };
    });
  }

  async deleteFrame(frameId: string): Promise<{ assetPath: string | null }> {
    return await this.withHandles((handles) => handles.storage.deleteFrame(frameId));
  }

  async deleteFrames(query: { app?: string; urlDomain?: string }): Promise<{ frames: number; assetPaths: string[] }> {
    if (!query.app?.trim() && !query.urlDomain?.trim()) throw new Error('deleteFrames requires app or urlDomain');
    return await this.withHandles((handles) => handles.storage.deleteFrames({ ...(query.app ? { app: query.app.trim() } : {}), ...(query.urlDomain ? { urlDomain: query.urlDomain.trim() } : {}) }));
  }

  async deleteAllMemory(): Promise<{ frames: number; events: number; assetBytes: number }> {
    return await this.withHandles((handles) => handles.storage.deleteAllMemory());
  }

  async readAsset(assetPath: string): Promise<Buffer> {
    return await this.withHandles(async (handles) => {
      const storageRoot = path.resolve(handles.storage.getRoot());
      const resolved = path.resolve(storageRoot, assetPath);
      if (!resolved.startsWith(`${storageRoot}${path.sep}`) && resolved !== storageRoot) throw new Error('asset path escapes storage root');
      return await handles.storage.readAsset(assetPath);
    });
  }

  async triggerIndex(): Promise<void> {
    await this.runManualJob('index-incremental', async () => this.withHandles((h) => { assertHeavyWorkAllowed(h, 'index-incremental'); return runIncremental(h).then(() => undefined); }));
  }

  async triggerReorganise(): Promise<void> {
    await this.runManualJob('index-reorganise', async () => this.withHandles((h) => { assertHeavyWorkAllowed(h, 'index-reorganise'); return runReorganisation(h); }));
  }

  async triggerEventExtractor(): Promise<any> {
    return await this.withHandles(async (handles) => {
      const runDrain = async <T>(name: string, fn: () => Promise<T>, logMsg: (res: T) => string | null) => {
        try { const res = await fn(); const msg = logMsg(res); if (msg) handles.logger.info(`scan: ${msg}`); return res; }
        catch (err) { handles.logger.warn(`scan: ${name} failed (continuing)`, { err: String(err) }); return {} as T; }
      };

      const audio = await runDrain('audioTranscriptWorker.drain', () => handles.audioTranscriptWorker.drain(), (r) => (r.processed || r.silent || r.failed) ? `processed ${r.processed || 0} audio transcript(s), ${r.silent || 0} silent, ${r.failed || 0} failed` : null);
      const fb = await runDrain('frameBuilder.drain', () => handles.frameBuilder.drain(), (r) => r.framesCreated ? `built ${r.framesCreated} new frame(s)` : null);
      const ocr = await runDrain('ocrWorker.drain', () => handles.ocrWorker.drain(MANUAL_EVENT_SCAN_OCR_TICKS), (r) => r.processed ? `ran OCR over ${r.processed} frame(s)` : null);
      await runDrain('entityResolver.drain', () => handles.entityResolver.drain(), () => null);
      const mb = await runDrain('meetingBuilder.drain', () => handles.meetingBuilder.drain(), (r) => (r.meetingsCreated || r.meetingsExtended) ? `materialised ${r.meetingsCreated || 0} new + ${r.meetingsExtended || 0} extended meeting(s)` : null);
      const sum = await runDrain('meetingSummarizer.tick', () => handles.meetingSummarizer.tick(), (r) => r.attempted ? `summarised ${r.succeeded || 0} meeting(s), ${r.failed || 0} failed, ${r.skipped || 0} skipped` : null);

      try {
        const result = await handles.eventExtractor.tick({ lookbackDays: MANUAL_EVENT_SCAN_LOOKBACK_DAYS, sources: ['calendar_screen'], enrichContexts: false });
        return { ...result, framesBuilt: fb.framesCreated || 0, framesOcrd: ocr.processed || 0, audioProcessed: audio.processed || 0, audioTranscribed: audio.transcribed || 0, audioImported: audio.imported || 0, audioSilent: audio.silent || 0, audioFailed: audio.failed || 0, meetingFramesProcessed: mb.framesProcessed || 0, meetingsCreated: mb.meetingsCreated || 0, meetingsExtended: mb.meetingsExtended || 0, summariesAttempted: sum.attempted || 0, summariesSucceeded: sum.succeeded || 0, summariesFailed: sum.failed || 0, summariesSkipped: sum.skipped || 0 };
      } catch (err) {
        handles.logger.warn('manual event extractor tick failed', { err: String(err) });
        return { meetingsLifted: 0, llmExtracted: 0, contextEnriched: 0, daysScanned: 0, bucketsScanned: 0, framesScanned: 0, framesBuilt: fb.framesCreated || 0, framesOcrd: ocr.processed || 0, audioProcessed: audio.processed || 0, audioTranscribed: audio.transcribed || 0, audioImported: audio.imported || 0, audioSilent: audio.silent || 0, audioFailed: audio.failed || 0, meetingFramesProcessed: mb.framesProcessed || 0, meetingsCreated: mb.meetingsCreated || 0, meetingsExtended: mb.meetingsExtended || 0, summariesAttempted: sum.attempted || 0, summariesSucceeded: sum.succeeded || 0, summariesFailed: sum.failed || 0, summariesSkipped: sum.skipped || 0, modelAvailable: false, failed: 1 };
      }
    });
  }

  async triggerFullReindex(opts: { from?: string; to?: string } = {}): Promise<void> {
    await this.runManualJob('index-full-reindex', async () => this.withHandles((h) => { assertHeavyWorkAllowed(h, 'index-full-reindex'); return runFullReindex(h, opts); }));
  }

  private async runManualJob(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.manualJob) {
      if (this.manualJob.name === name) return this.logger.info('manual job already running; ignoring duplicate trigger', { job: name, startedAt: this.manualJob.startedAt });
      throw new Error(`Runtime job already running: ${this.manualJob.name}`);
    }
    this.manualJob = { name, startedAt: new Date().toISOString() };
    this.invalidateOverview();
    try { await fn(); } finally { this.lastManualJobCompletedAt = new Date().toISOString(); this.manualJob = null; this.invalidateOverview(); }
  }

  private async getOrCreateHandles(): Promise<OrchestratorHandles> {
    if (!this.handles) this.handles = await buildOrchestrator(this.logger, this.opts);
    return this.handles;
  }

  private invalidateOverview(): void { this.overviewCache = null; }

  private async withHandles<T>(fn: (handles: OrchestratorHandles) => Promise<T>): Promise<T> {
    const hadHandles = this.handles != null;
    const handles = await this.getOrCreateHandles();
    try { return await fn(handles); }
    finally {
      if (!hadHandles && this.status !== 'running') {
        await stopAll(handles).catch((err) => this.logger.warn('failed to stop temporary runtime handles', { err: String(err) }));
        this.handles = null; this.status = 'stopped';
      }
    }
  }
}

export function createRuntime(opts: RuntimeOptions = {}): BesideRuntime { return new BesideRuntime(opts); }

const AI_CAPTION_KEYS = ['ai_caption', 'caption', 'image_caption', 'screenshot_caption', 'vision_caption', 'visual_caption', 'description', 'summary'];
const HIDDEN_METADATA_KEYS = new Set(['ax_text', 'ocr_text', 'text', 'content']);

function buildFrameIndexingText(frame: Frame): string | null {
  const parts = [frame.app ? `App: ${frame.app}` : null, frame.window_title ? `Window: ${frame.window_title}` : null, frame.url ? `URL: ${frame.url}` : null, frame.entity_path ? `Entity: ${frame.entity_path}` : null, frame.text ? `Text: ${truncateIndexText(frame.text, 3000)}` : null].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

function buildDisplayMetadata(frame: Frame, events: RawEvent[]): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...(frame.text_source && { text_source: frame.text_source }), ...(frame.trigger && { trigger: frame.trigger }), ...(frame.entity_kind && { entity_kind: frame.entity_kind }), ...(frame.perceptual_hash && { perceptual_hash: frame.perceptual_hash }) };
  for (const event of events) {
    const eventMetadata = normaliseEventMetadata(event.metadata);
    for (const [key, value] of Object.entries(eventMetadata)) {
      const displayValue = normaliseMetadataValue(key, value);
      if (displayValue != null) metadata[key] = displayValue;
    }
  }
  if (frame.source_event_ids.length > 0) metadata.source_event_ids = frame.source_event_ids;
  return metadata;
}

function normaliseEventMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const nested = isRecord(metadata.metadata) ? metadata.metadata : {};
  const topLevel = Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'metadata'));
  return { ...nested, ...topLevel };
}

function normaliseMetadataValue(key: string, value: unknown): unknown {
  if (HIDDEN_METADATA_KEYS.has(key) || value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) { const safe = value.filter((i) => i == null || isScalar(i)); return safe.length > 0 && safe.length === value.length ? safe : null; }
  if (isRecord(value)) { const safe = Object.fromEntries(Object.entries(value).filter(([, i]) => i == null || isScalar(i))); return Object.keys(safe).length > 0 ? safe : null; }
  return null;
}

function extractAiCaption(metadata: Record<string, unknown>): string | null {
  return AI_CAPTION_KEYS.map((k) => metadata[k]).find((v) => typeof v === 'string' && v.trim()) as string || null;
}

function truncateIndexText(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length <= maxChars ? cleaned : cleaned.slice(0, maxChars).trimEnd();
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function isScalar(value: unknown): boolean { return ['string', 'number', 'boolean'].includes(typeof value); }

function getIndexingStatus(handles: OrchestratorHandles, manualJob: { name: string; startedAt: string } | null, lastManualJobCompletedAt: string | null): RuntimeIndexingStatus {
  if (manualJob) return { running: true, currentJob: manualJob.name, startedAt: manualJob.startedAt, lastCompletedAt: lastManualJobCompletedAt };
  const jobs = handles.scheduler.getJobs().filter((job) => ['index-incremental', 'index-reorganise'].includes(job.name));
  const runningJob = jobs.find((job) => job.running);
  return { running: !!runningJob, currentJob: runningJob?.name ?? null, startedAt: runningJob?.lastStartedAt ?? null, lastCompletedAt: latestIso([...jobs.map((job) => job.lastCompletedAt), lastManualJobCompletedAt]) };
}

function getBackgroundJobs(handles: OrchestratorHandles): RuntimeBackgroundJobStatus[] {
  return (handles.scheduler.getJobs() as any[]).map((job) => ({ name: job.name, kind: job.kind, running: job.running, lastStartedAt: job.lastStartedAt, lastCompletedAt: job.lastCompletedAt, lastDurationMs: job.lastDurationMs ?? null, lastError: job.lastError ?? null, runCount: job.runCount ?? 0, skippedCount: job.skippedCount ?? 0 }));
}

function latestIso(values: Array<string | null>): string | null {
  return values.filter(Boolean).sort().pop() || null;
}

const INDEX_CATEGORY_ORDER = ['projects', 'repos', 'meetings', 'contacts', 'channels', 'docs', 'web', 'apps', 'tools', 'topics', 'patterns'];
const INDEX_CATEGORY_CACHE_TTL_MS = 5 * 60_000;
const INDEX_CATEGORY_RECENT_PAGE_LIMIT = 3;
const INDEX_MANIFEST_FILENAME = '_manifest.json';
let indexCategoryCache: { rootPath: string; expiresAt: number; categories: RuntimeIndexCategory[] } | null = null;

async function readIndexCategories(rootPath: string): Promise<RuntimeIndexCategory[]> {
  const now = Date.now();
  if (indexCategoryCache?.rootPath === rootPath && indexCategoryCache.expiresAt > now) return indexCategoryCache.categories;

  const manifestCategories = await readIndexCategoriesFromManifest(rootPath);
  if (manifestCategories) { indexCategoryCache = { rootPath, expiresAt: now + INDEX_CATEGORY_CACHE_TTL_MS, categories: manifestCategories }; return manifestCategories; }

  const categories: RuntimeIndexCategory[] = [];
  try {
    for (const entry of await fs.readdir(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'archive') continue;
      const pages = await listMarkdownPages(path.join(rootPath, entry.name), entry.name);
      const contentPages = pages.filter((p) => path.basename(p.path) !== '_summary.md');
      if (!contentPages.length) continue;
      categories.push({ name: entry.name, pageCount: contentPages.length, summaryPath: pages.find((p) => path.basename(p.path) === '_summary.md')?.path, lastUpdated: latestIso(contentPages.map((p) => p.mtime)), recentPages: await Promise.all(contentPages.slice().sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, INDEX_CATEGORY_RECENT_PAGE_LIMIT).map((p) => readIndexPagePreview(rootPath, p))) });
    }
  } catch {}

  const sorted = sortIndexCategories(categories);
  indexCategoryCache = { rootPath, expiresAt: now + INDEX_CATEGORY_CACHE_TTL_MS, categories: sorted };
  return sorted;
}

function sortIndexCategories(categories: RuntimeIndexCategory[]): RuntimeIndexCategory[] {
  return categories.sort((a, b) => {
    const ai = INDEX_CATEGORY_ORDER.indexOf(a.name), bi = INDEX_CATEGORY_ORDER.indexOf(b.name);
    return (ai !== -1 || bi !== -1) ? (ai === -1 ? 1 : bi === -1 ? -1 : ai - bi) : a.name.localeCompare(b.name);
  });
}

async function readIndexCategoriesFromManifest(rootPath: string): Promise<RuntimeIndexCategory[] | null> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(rootPath, INDEX_MANIFEST_FILENAME), 'utf8')) as any;
    if (manifest.version !== 1 || !Array.isArray(manifest.pages)) return null;

    const byCategory = new Map<string, any[]>();
    for (const page of manifest.pages) {
      const normalised = page.path.replace(/\\/g, '/'), cat = normalised.split('/')[0];
      if (!cat || cat.startsWith('.') || cat === 'archive' || path.basename(normalised) === '_summary.md') continue;
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push({ ...page, path: normalised });
    }

    return sortIndexCategories(Array.from(byCategory.entries()).map(([name, pages]) => ({ name, pageCount: pages.length, summaryPath: manifest.pages.find((p: any) => p.path === `${name}/_summary.md`)?.path, lastUpdated: latestIso(pages.map((p) => p.lastUpdated)), recentPages: pages.slice().sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated)).slice(0, INDEX_CATEGORY_RECENT_PAGE_LIMIT).map((p) => ({ path: p.path, title: p.title || path.basename(p.path, '.md'), summary: p.summary ?? null, lastUpdated: p.lastUpdated })) })));
  } catch { return null; }
}

async function listMarkdownPages(dir: string, relDir: string): Promise<Array<{ path: string; mtime: string }>> {
  const out: Array<{ path: string; mtime: string }> = [];
  try {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name), rel = path.join(relDir, entry.name).replace(/\\/g, '/');
      if (entry.isDirectory()) { out.push(...await listMarkdownPages(abs, rel)); continue; }
      if (entry.isFile() && entry.name.endsWith('.md')) out.push({ path: rel, mtime: (await fs.stat(abs).catch(() => null))?.mtime.toISOString() ?? new Date(0).toISOString() });
    }
  } catch {}
  return out;
}

async function readIndexPagePreview(rootPath: string, page: { path: string; mtime: string }): Promise<RuntimeIndexCategoryPage> {
  let text = '';
  try { text = await fs.readFile(path.join(rootPath, page.path), 'utf8'); } catch {}
  return { path: page.path, title: text.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(page.path, '.md'), summary: extractMarkdownSummary(text), lastUpdated: page.mtime };
}

function extractMarkdownSummary(content: string): string | null {
  const section = extractMarkdownSection(content, 'Summary') ?? extractMarkdownSection(content, 'Overview');
  const cleaned = section?.replace(/^---\n[\s\S]*?\n---\s*/m, '').split('\n').filter((l) => !l.startsWith('#') && !l.startsWith('![') && !/^\s*[-*]\s+/.test(l)).join(' ').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim() ?? '';
  return cleaned ? (cleaned.length <= 180 ? cleaned : `${cleaned.slice(0, 179)}…`) : null;
}

function extractMarkdownSection(content: string, heading: string): string | null {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return null;
  const out = [];
  for (const line of lines.slice(start + 1)) { if (/^##\s+/.test(line)) break; out.push(line); }
  return out.join('\n').trim() || null;
}

function buildFallbackSearchResultExplanations(query: string, frames: Frame[]): SearchResultExplanation[] {
  return frames.map((frame) => ({ frameId: frame.id, explanation: buildFallbackSearchResultExplanation(query, frame) })).filter((x) => x.explanation) as SearchResultExplanation[];
}

function buildFallbackSearchResultExplanation(query: string, frame: Frame): string | null {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/i).map((t) => t.trim()).filter(Boolean).slice(0, 8);
  const text = normaliseSearchContextText(frame.text), title = normaliseSearchContextText(frame.window_title), url = normaliseSearchContextText(frame.url);
  const findSnippet = (str: string) => {
    if (!str || !terms.length) return null;
    let bestIndex = -1, bestTerm = '';
    for (const term of terms) {
      const idx = str.toLowerCase().indexOf(term);
      if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) { bestIndex = idx; bestTerm = term; }
    }
    if (bestIndex === -1) return null;
    const start = Math.max(0, bestIndex - 90), end = Math.min(str.length, bestIndex + bestTerm.length + 90);
    return `${start > 0 ? '...' : ''}${str.slice(start, end).trim()}${end < str.length ? '...' : ''}`;
  };

  const textSnippet = findSnippet(text); if (textSnippet) return `Captured text: ${textSnippet}`;
  const titleSnippet = findSnippet(title); if (titleSnippet) return `Window title: ${titleSnippet}`;
  const urlSnippet = findSnippet(url); if (urlSnippet) return `URL: ${urlSnippet}`;

  const trunc = (s: string) => s.length <= 220 ? s : `${s.slice(0, 217).trimEnd()}...`;
  if (text) return `Captured text: ${trunc(text)}`;
  if (title) return `Window title: ${trunc(title)}`;
  if (url) return `URL: ${trunc(url)}`;
  if (frame.app) return `Captured in ${frame.app}.`;
  return null;
}

function normaliseSearchContextText(value: string | null | undefined): string { return String(value ?? '').replace(/\s+/g, ' ').trim(); }

function buildSearchResultExplanationPrompt(query: string, frame: Frame, includesImage: boolean): string {
  const metadata = [frame.app && `App: ${frame.app}`, frame.window_title && `Window title: ${frame.window_title}`, frame.url && `URL: ${frame.url}`, frame.timestamp && `Timestamp: ${frame.timestamp}`, frame.text && `Searchable text: ${frame.text.replace(/\s+/g, ' ').slice(0, 1200)}`].filter(Boolean).join('\n');
  return ['Look at the screenshot and add context about the part related to the search term.', `Search term for your reference only: ${query}`, includesImage ? 'Do not repeat the search term. Add context for the search term based on the image, using the metadata only for clarification.' : 'No screenshot is available. Do not repeat the search term; summarize the relevant context from the metadata.', metadata || 'No metadata was extracted for this frame.', '', 'Return one concise sentence under 40 words. Do not explain why this result matched or mention that you are an AI.'].join('\n');
}

async function readFrameAssetForModel(handles: OrchestratorHandles, assetPath: string): Promise<Buffer | null> {
  try {
    const storageRoot = path.resolve(handles.storage.getRoot()), resolved = path.resolve(storageRoot, assetPath);
    if (!resolved.startsWith(`${storageRoot}${path.sep}`) && resolved !== storageRoot) throw new Error('asset path escapes storage root');
    return await handles.storage.readAsset(assetPath);
  } catch { return null; }
}

async function raceSearchExplanation(promise: Promise<string>): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout`)), SEARCH_EXPLANATION_TIMEOUT_MS); timer.unref?.(); });
  try { return await Promise.race([promise, timeout]); } finally { if (timer) clearTimeout(timer); }
}

function cleanSearchExplanation(raw: string): string { return raw.replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').slice(0, 260); }

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) target[key] = deepMerge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    else target[key] = value;
  }
  return target;
}
