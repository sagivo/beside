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
  ExportStatus,
  Frame,
  FrameQuery,
  IndexState,
  Logger,
  RawEvent,
  StorageStats,
} from '@cofounderos/interfaces';
import {
  bootstrapModel,
  buildOrchestrator,
  runFullReindex,
  runIncremental,
  runReorganisation,
  startAll,
  stopAll,
  type OrchestratorHandles,
  type OrchestratorOptions,
} from './orchestrator.js';
import { renderJournalMarkdown } from '@cofounderos/interfaces';
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
    loadGuardEnabled: boolean;
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

const OVERVIEW_CACHE_TTL_MS = 10_000;
const OVERVIEW_SLOW_LOG_MS = 500;

export class CofounderRuntime {
  private readonly logger: Logger;
  private readonly opts: OrchestratorOptions;
  private handles: OrchestratorHandles | null = null;
  private status: RuntimeStatus = 'not_started';
  private overviewCache: { value: RuntimeOverview; expiresAt: number } | null = null;
  private overviewInFlight: Promise<RuntimeOverview> | null = null;
  private manualJob: { name: string; startedAt: string } | null = null;
  private lastManualJobCompletedAt: string | null = null;

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

  async bootstrapModel(onProgress?: Parameters<typeof bootstrapModel>[1]): Promise<void> {
    await this.withHandles((handles) => bootstrapModel(handles, onProgress));
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
      const load = timedSync('loadGuard', () => handles.loadGuard.snapshot().normalised);
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
          load,
          loadGuardEnabled: handles.config.system.load_guard.enabled,
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
          load: handles.loadGuard.snapshot().normalised,
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
      return {
        day,
        markdown: renderJournalMarkdown(day, frames, {
          sessions,
        }),
      };
    });
  }

  async searchFrames(query: FrameQuery): Promise<Frame[]> {
    return await this.withHandles((handles) => handles.storage.searchFrames(query));
  }

  async explainSearchResults(query: ExplainSearchResultsQuery): Promise<SearchResultExplanation[]> {
    const text = query.text.trim();
    if (!text || query.frames.length === 0) return [];

    return await this.withHandles(async (handles) => {
      if (!(await handles.model.isAvailable().catch(() => false))) return [];

      const modelInfo = handles.model.getModelInfo();
      const explanations: SearchResultExplanation[] = [];
      for (const frame of query.frames) {
        try {
          const image = modelInfo.supportsVision && frame.asset_path
            ? await readFrameAssetForModel(handles, frame.asset_path)
            : null;
          const prompt = buildSearchResultExplanationPrompt(text, frame, image != null);
          const raw = image
            ? await handles.model.completeWithVision(prompt, [image], {
                maxTokens: 120,
                temperature: 0.2,
              })
            : await handles.model.complete(prompt, {
                maxTokens: 120,
                temperature: 0.2,
              });
          const explanation = cleanSearchExplanation(raw);
          if (explanation) {
            explanations.push({ frameId: frame.id, explanation });
          }
        } catch (err) {
          handles.logger.debug('search result explanation failed', {
            frameId: frame.id,
            err: String(err),
          });
        }
      }
      return explanations;
    });
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

  async triggerIndex(): Promise<void> {
    await this.runManualJob('index-incremental', async () => {
      await this.withHandles((handles) => runIncremental(handles).then(() => undefined));
    });
  }

  async triggerReorganise(): Promise<void> {
    await this.runManualJob('index-reorganise', async () => {
      await this.withHandles((handles) => runReorganisation(handles));
    });
  }

  async triggerFullReindex(opts: { from?: string; to?: string } = {}): Promise<void> {
    await this.runManualJob('index-full-reindex', async () => {
      await this.withHandles((handles) => runFullReindex(handles, opts));
    });
  }

  private async runManualJob(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.manualJob) {
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

const INDEX_CATEGORY_CACHE_TTL_MS = 30_000;
const INDEX_CATEGORY_RECENT_PAGE_LIMIT = 3;

let indexCategoryCache:
  | {
      rootPath: string;
      expiresAt: number;
      categories: RuntimeIndexCategory[];
    }
  | null = null;

async function readIndexCategories(rootPath: string): Promise<RuntimeIndexCategory[]> {
  const now = Date.now();
  if (
    indexCategoryCache &&
    indexCategoryCache.rootPath === rootPath &&
    indexCategoryCache.expiresAt > now
  ) {
    return indexCategoryCache.categories;
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

  const sorted = categories.sort((a, b) => {
    const ai = INDEX_CATEGORY_ORDER.indexOf(a.name);
    const bi = INDEX_CATEGORY_ORDER.indexOf(b.name);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return a.name.localeCompare(b.name);
  });
  indexCategoryCache = {
    rootPath,
    expiresAt: now + INDEX_CATEGORY_CACHE_TTL_MS,
    categories: sorted,
  };
  return sorted;
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

function cleanSearchExplanation(raw: string): string {
  return raw
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 260);
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
