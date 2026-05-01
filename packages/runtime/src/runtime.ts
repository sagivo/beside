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
  index: IndexState;
  indexing: RuntimeIndexingStatus;
  model: {
    name: string;
    isLocal: boolean;
    ready: boolean;
  };
  exports: ExportStatus[];
  system: {
    load: number | null;
    loadGuardEnabled: boolean;
  };
}

export interface RuntimeIndexingStatus {
  running: boolean;
  currentJob: string | null;
  startedAt: string | null;
  lastCompletedAt: string | null;
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

export type ConfigPatch = Record<string, unknown>;

export class CofounderRuntime {
  private readonly logger: Logger;
  private readonly opts: OrchestratorOptions;
  private handles: OrchestratorHandles | null = null;
  private status: RuntimeStatus = 'not_started';

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
    await stopAll(this.handles);
    this.handles = null;
    this.status = 'stopped';
  }

  async restart(options: { bootstrap?: boolean } = {}): Promise<void> {
    await this.stop();
    await this.start(options);
  }

  async pauseCapture(): Promise<RuntimeOverview> {
    return await this.withHandles(async (handles) => {
      await handles.capture.pause();
      return await this.getOverview();
    });
  }

  async resumeCapture(): Promise<RuntimeOverview> {
    return await this.withHandles(async (handles) => {
      await handles.capture.resume();
      return await this.getOverview();
    });
  }

  async getOverview(): Promise<RuntimeOverview> {
    return await this.withHandles(async (handles) => {
      const capture = handles.capture.getStatus();
      const storage = await handles.storage.getStats();
      const index = await handles.strategy.getState();
      const indexing = getIndexingStatus(handles);
      const modelInfo = handles.model.getModelInfo();
      const ready = await handles.model.isAvailable().catch(() => false);
      const load = handles.loadGuard.snapshot().normalised;
      return {
        status: this.status,
        configPath: handles.loaded.sourcePath,
        dataDir: handles.loaded.dataDir,
        storageRoot: handles.storage.getRoot(),
        capture,
        storage,
        index,
        indexing,
        model: {
          name: modelInfo.name,
          isLocal: modelInfo.isLocal,
          ready,
        },
        exports: handles.exports.map((exp) => exp.getStatus()),
        system: {
          load,
          loadGuardEnabled: handles.config.system.load_guard.enabled,
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
      const frames = await handles.storage.getJournal(day);
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
      return { day, frames, sessions };
    });
  }

  async searchFrames(query: FrameQuery): Promise<Frame[]> {
    return await this.withHandles((handles) => handles.storage.searchFrames(query));
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
    await this.withHandles((handles) => runIncremental(handles).then(() => undefined));
  }

  async triggerReorganise(): Promise<void> {
    await this.withHandles((handles) => runReorganisation(handles));
  }

  async triggerFullReindex(opts: { from?: string; to?: string } = {}): Promise<void> {
    await this.withHandles((handles) => runFullReindex(handles, opts));
  }

  private async getOrCreateHandles(): Promise<OrchestratorHandles> {
    if (!this.handles) {
      this.handles = await buildOrchestrator(this.logger, this.opts);
    }
    return this.handles;
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

function getIndexingStatus(handles: OrchestratorHandles): RuntimeIndexingStatus {
  const jobs = handles.scheduler
    .getJobs()
    .filter((job) => job.name === 'index-incremental' || job.name === 'index-reorganise');
  const runningJob = jobs.find((job) => job.running) ?? null;
  return {
    running: runningJob != null,
    currentJob: runningJob?.name ?? null,
    startedAt: runningJob?.lastStartedAt ?? null,
    lastCompletedAt: latestIso(jobs.map((job) => job.lastCompletedAt)),
  };
}

function latestIso(values: Array<string | null>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (value && (!latest || value > latest)) latest = value;
  }
  return latest;
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
