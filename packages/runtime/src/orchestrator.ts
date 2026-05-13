import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  ICapture, IStorage, IModelAdapter, IIndexStrategy, IExport, IHookPlugin, Logger, RawEvent,
  PluginHostContext, ModelBootstrapHandler, ExportServices, CaptureHookDefinition,
} from '@beside/interfaces';
import {
  RawEventBus, Scheduler, PluginRegistry, discoverPlugins, findWorkspaceRoot, loadConfig,
  LoadGuard, type BesideConfig, type LoadGuardDecision, type LoadedConfig,
} from '@beside/core';
import { FrameBuilder } from './frame-builder.js';
import { SessionBuilder } from './session-builder.js';
import { MeetingBuilder } from './meeting-builder.js';
import { MeetingSummarizer } from './meeting-summarizer.js';
import { EventExtractor } from './event-extractor.js';
import { EmbeddingWorker } from './embedding-worker.js';
import { AudioTranscriptWorker } from './audio-transcript-worker.js';
import { OcrWorker } from './ocr-worker.js';
import { EntityResolverWorker } from './entity-resolver.js';
import { StorageVacuum } from './storage-vacuum.js';
import { OfflineFallbackAdapter } from './offline-model.js';
import { CaptureHookEngine } from './capture-hooks.js';

export interface OrchestratorOptions { configPath?: string; workspaceRoot?: string; }
export interface OrchestratorHandles {
  capture: ICapture; storage: IStorage; model: IModelAdapter; indexerModel: IModelAdapter;
  strategy: IIndexStrategy; exports: IExport[]; scheduler: Scheduler; bus: RawEventBus;
  config: BesideConfig; logger: Logger; loaded: LoadedConfig; registry: PluginRegistry;
  frameBuilder: FrameBuilder; ocrWorker: OcrWorker; audioTranscriptWorker: AudioTranscriptWorker;
  entityResolver: EntityResolverWorker; sessionBuilder: SessionBuilder; meetingBuilder: MeetingBuilder;
  meetingSummarizer: MeetingSummarizer; eventExtractor: EventExtractor; embeddingWorker: EmbeddingWorker;
  vacuum: StorageVacuum; loadGuard: LoadGuard; activityCoalescer: ActivityCoalescer; idlePowerCatchup: IdlePowerCatchup;
  captureHooks: CaptureHookEngine;
  hookWidgetManifests: HookWidgetManifestRuntime[];
}

export interface HookWidgetManifestRuntime {
  hookId: string;
  pluginName: string | null;
  widget: NonNullable<CaptureHookDefinition['widget']>;
  /** Absolute path on disk to the React bundle entrypoint, when present. */
  resolvedBundlePath: string | null;
}

const JOBS = {
  INCREMENTAL: 'index-incremental', REORG: 'index-reorganise', FRAME_BUILDER: 'frame-builder',
  OCR_WORKER: 'ocr-worker', AUDIO_TRANSCRIPT: 'audio-transcript-worker', ENTITY_RESOLVER: 'entity-resolver',
  SESSION_BUILDER: 'session-builder', MEETING_BUILDER: 'meeting-builder', MEETING_SUMMARIZER: 'meeting-summarizer',
  EVENT_EXTRACTOR: 'event-extractor', EMBEDDING_WORKER: 'embedding-worker', VACUUM: 'storage-vacuum',
  STORAGE_MAINTENANCE: 'storage-maintenance', STORAGE_RETENTION: 'storage-retention', IDLE_POWER_CATCHUP: 'idle-power-catchup'
};

const INTERVALS = {
  FRAME: 5 * 60_000, OCR: 60_000, OCR_IDLE: 5 * 60_000, ENTITY: 5 * 60_000, SESSION: 10 * 60_000,
  MEETING: 120_000, SUMMARIZER: 5 * 60_000, EVENT: 15 * 60_000, STORAGE_MAINT: 7 * 86400_000, RETENTION: 86400_000,
  COALESCE_DEBOUNCE: 60_000, COALESCE_MAX_WAIT: 240_000
};

class ActivityCoalescer {
  private timer: NodeJS.Timeout | null = null;
  private firstNudgeAt: number | null = null;
  private running = false;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;
  constructor(private readonly bus: RawEventBus, private readonly logger: Logger, private readonly run: () => Promise<void>) {}

  start() { if (!this.unsubscribe && !this.stopped) this.unsubscribe = this.bus.on(() => this.nudge()); }
  stop() {
    this.stopped = true; if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.firstNudgeAt = null;
  }
  private nudge() {
    if (this.stopped) return;
    if (this.firstNudgeAt == null) this.firstNudgeAt = Date.now();
    if (Date.now() - this.firstNudgeAt >= INTERVALS.COALESCE_MAX_WAIT) return this.fire();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), INTERVALS.COALESCE_DEBOUNCE);
  }
  private fire() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.firstNudgeAt = null;
    if (this.running || this.stopped) return;
    this.running = true;
    this.run().catch((err) => this.logger.warn('coalescer failed', { err: String(err) })).finally(() => this.running = false);
  }
}

class IdlePowerCatchup {
  private timer: NodeJS.Timeout | null = null;
  private idle = false; private running = false; private stopped = false;
  private unsubscribe: (() => void) | null = null;
  constructor(private readonly bus: RawEventBus, private readonly logger: Logger, private readonly idleDelayMs: number, private readonly run: () => Promise<void>) {}

  start() { if (!this.unsubscribe && !this.stopped) this.unsubscribe = this.bus.on((e) => this.onEvent(e)); }
  stop() {
    this.stopped = true; if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
    this.clearTimer(); this.idle = false;
  }
  private onEvent(e: RawEvent) {
    if (this.stopped) return;
    if (e.type === 'idle_start') { this.idle = true; this.schedule(); }
    else if (e.type === 'idle_end') { this.idle = false; this.clearTimer(); }
  }
  private schedule() { this.clearTimer(); if (this.idle && !this.stopped) this.timer = setTimeout(() => this.fire(), this.idleDelayMs); }
  private clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  private fire() {
    this.clearTimer();
    if (!this.idle || this.running || this.stopped) return;
    this.running = true;
    this.run().catch((err) => this.logger.warn('catchup failed', { err: String(err) })).finally(() => { this.running = false; if (this.idle && !this.stopped) this.schedule(); });
  }
}

async function startPassiveExports(exports: IExport[], logger: Logger) {
  for (const exp of exports) if (exp.name !== 'mcp' && !exp.getStatus().running) await exp.start().catch((err) => logger.warn(`failed to start ${exp.name}`, { err: String(err) }));
}

export async function buildOrchestrator(logger: Logger, opts: OrchestratorOptions = {}): Promise<OrchestratorHandles> {
  const loaded = await loadConfig(opts.configPath);
  const { config, dataDir } = loaded;
  const workspaceRoot = opts.workspaceRoot ?? process.env.BESIDE_RESOURCE_ROOT ?? findWorkspaceRoot(process.cwd());

  logger.info(`config loaded from ${loaded.sourcePath}`);
  const entries = await discoverPlugins(workspaceRoot, logger);
  const registry = new PluginRegistry(entries, logger);
  const baseCtx = (cfg: any): PluginHostContext => ({ dataDir, logger, config: { ...cfg, raw_root: dataDir } });

  const storageBlock = (config.storage as any)[config.storage.plugin];
  const storage = await registry.loadStorage(config.storage.plugin, baseCtx(storageBlock ?? {}));

  const modelBlock = (config.index.model as any)[config.index.model.plugin];
  const model = await registry.loadModel(config.index.model.plugin, baseCtx(modelBlock ?? {}));
  
  const indexerModelName = modelBlock?.indexer_model, primaryModelName = modelBlock?.model;
  let indexerModel = model;
  if (typeof indexerModelName === 'string' && indexerModelName.trim() && indexerModelName !== primaryModelName) {
    try { indexerModel = await registry.loadModel(config.index.model.plugin, baseCtx({ ...modelBlock, model: indexerModelName })); }
    catch (err) { logger.warn('failed to load indexer model, using primary', { err: String(err) }); indexerModel = model; }
  }

  const strategy = await registry.loadIndexStrategy(config.index.strategy, baseCtx({ index_path: config.index.index_path, batch_size: config.index.batch_size }));
  const captureConfig = { ...(config.capture as any), raw_root: dataDir };
  delete captureConfig.plugin;
  const capture = await registry.loadCapture(config.capture.plugin, baseCtx(captureConfig));

  const exports: IExport[] = [];
  for (const ref of config.export.plugins) {
    if ((ref as any).enabled === false) continue;
    exports.push(await registry.loadExport(ref.name, baseCtx({ ...ref })));
  }

  const bus = new RawEventBus(logger), scheduler = new Scheduler(logger), loadGuard = new LoadGuard(config.system.load_guard, logger);
  let handlesRef: OrchestratorHandles | null = null;

  capture.onEvent(async (e) => { await storage.write(e); await bus.publish(e); });

  const exportServices: ExportServices = {
    storage, strategy, model, embeddingModelName: getEmbeddingModelName(config),
    embeddingSearchWeight: config.index.embeddings.search_weight, dataDir,
    triggerReindex: async (full) => { if (full) await runFullReindex(handlesRef!); else if (scheduler.has(JOBS.INCREMENTAL)) await scheduler.runNow(JOBS.INCREMENTAL); else await runIncremental(handlesRef!); },
    summarizeMeeting: async (id, opts) => {
      const m = await storage.getMeeting(id);
      if (!m) return { status: 'not_found', message: 'not found' };
      if (!loadGuard.check(JOBS.MEETING_SUMMARIZER, { allowForced: false }).proceed) {
        if (opts?.force || ['failed', 'skipped_short'].includes(m.summary_status)) await storage.setMeetingSummary(id, { status: 'pending', failureReason: null });
        return { status: 'deferred', message: 'deferred by load guard' };
      }
      if (opts?.force || ['failed', 'skipped_short'].includes(m.summary_status)) await storage.setMeetingSummary(id, { status: 'pending', failureReason: null });
      try {
        const r = await handlesRef!.meetingSummarizer.tick();
        return r.failed > 0 && r.succeeded === 0 ? { status: 'failed', message: 'failed' } : { status: 'ok', message: 'ok' };
      } catch (err) { return { status: 'failed', message: String(err) }; }
    }
  };
  exports.forEach((e) => e.bindServices?.(exportServices));

  const sk = config.capture.privacy.sensitive_keywords ?? [];
  const frameBuilder = new FrameBuilder(storage, logger, { batchSize: 25, sensitiveKeywords: sk });
  const ocrWorker = new OcrWorker(storage, logger, { storageRoot: storage.getRoot(), sensitiveKeywords: sk });
  const audioTranscriptWorker = new AudioTranscriptWorker(storage, logger, { ...config.capture.audio, inboxPath: config.capture.audio.inbox_path, processedPath: config.capture.audio.processed_path, failedPath: config.capture.audio.failed_path, enabled: config.capture.capture_audio, whisperModel: config.capture.whisper_model, sensitiveKeywords: sk });
  const entityResolver = new EntityResolverWorker(storage, logger, 25);
  const sessionBuilder = new SessionBuilder(storage, logger, { idleThresholdMs: config.index.sessions.idle_threshold_sec * 1000, minActiveMs: config.index.sessions.min_active_ms, fallbackFrameAttentionMs: config.index.sessions.fallback_frame_attention_ms, batchSize: 100 });
  const meetingBuilder = new MeetingBuilder(storage, logger, { meetingIdleMs: config.index.meetings.idle_threshold_sec * 1000, minDurationMs: config.index.meetings.min_duration_sec * 1000, audioGraceMs: config.index.meetings.audio_grace_sec * 1000 });
  const meetingSummarizer = new MeetingSummarizer(storage, model, logger, { dataDir, enabled: config.index.meetings.summarize, cooldownMs: config.index.meetings.summarize_cooldown_sec * 1000, visionAttachments: config.index.meetings.vision_attachments });
  const eventsCfg = (config.index as any).events;
  const eventExtractor = new EventExtractor(storage, model, logger, { dataDir, lookbackDays: eventsCfg.lookback_days, minTextChars: eventsCfg.min_text_chars, maxFramesPerBucket: eventsCfg.max_frames_per_bucket, llmEnabled: eventsCfg.llm_enabled });
  const embeddingWorker = new EmbeddingWorker(storage, model, logger, { enabled: config.index.embeddings.enabled, batchSize: config.index.embeddings.batch_size, modelName: getEmbeddingModelName(config), strategy });
  const stageMs = (d: number, m?: number) => typeof m === 'number' ? m * 60000 : d * 86400000;
  const vCfg = config.storage.local.vacuum;
  const vacuum = new StorageVacuum(storage, logger, { storageRoot: storage.getRoot(), compressAfterMs: stageMs(vCfg.compress_after_days, vCfg.compress_after_minutes), compressQuality: vCfg.compress_quality, thumbnailAfterMs: stageMs(vCfg.thumbnail_after_days, vCfg.thumbnail_after_minutes), thumbnailMaxDim: vCfg.thumbnail_max_dim, deleteAfterMs: stageMs(vCfg.delete_after_days, vCfg.delete_after_minutes), batchSize: vCfg.batch_size });

  const activityCoalescer = new ActivityCoalescer(bus, logger.child('coalescer'), async () => {
    if (await hasActiveIndexMaintenanceLock(dataDir)) return;
    await frameBuilder.tick(); await entityResolver.tick(); await sessionBuilder.tick(); await meetingBuilder.tick();
    if (config.system.background_model_jobs !== 'scheduled' || !loadGuard.check(JOBS.EMBEDDING_WORKER, { allowForced: false }).proceed || await hasActiveIndexMaintenanceLock(dataDir)) return;
    await embeddingWorker.tick();
  });

  const idlePowerCatchup = new IdlePowerCatchup(bus, logger.child(JOBS.IDLE_POWER_CATCHUP), config.index.idle_trigger_min * 60_000, async () => {
    if (handlesRef) await runIdlePowerCatchup(handlesRef);
  });

  const captureHooks = new CaptureHookEngine({ bus, storage, model, logger, config, dataDir });
  const hookWidgetManifests: HookWidgetManifestRuntime[] = [];

  if (config.hooks?.enabled !== false) {
    for (const ref of config.hooks?.plugins ?? []) {
      if (ref.enabled === false) continue;
      try {
        const plugin = await registry.loadHook(ref.name, baseCtx({ ...ref }));
        await captureHooks.register(plugin);
        const defs = await Promise.resolve(plugin.definitions()).catch(() => [] as CaptureHookDefinition[]);
        for (const def of defs) {
          if (!def.widget) continue;
          const resolved = await resolveHookWidgetBundle(registry, ref.name, def.widget.bundlePath);
          hookWidgetManifests.push({
            hookId: def.id,
            pluginName: plugin.name,
            widget: { ...def.widget, id: def.widget.id ?? def.id, title: def.widget.title ?? def.title },
            resolvedBundlePath: resolved,
          });
        }
      } catch (err) {
        logger.warn(`hook plugin "${ref.name}" failed to load`, { err: String(err) });
      }
    }
    for (const def of config.hooks?.definitions ?? []) {
      try {
        captureHooks.registerDefinition(def as CaptureHookDefinition);
        if (def.widget) {
          hookWidgetManifests.push({
            hookId: def.id,
            pluginName: null,
            widget: {
              ...(def.widget as NonNullable<CaptureHookDefinition['widget']>),
              id: def.widget.id ?? def.id,
              title: def.widget.title ?? def.title,
            },
            resolvedBundlePath: null,
          });
        }
      } catch (err) {
        logger.warn(`config hook "${def.id}" failed to register`, { err: String(err) });
      }
    }
  }

  handlesRef = { capture, storage, model, indexerModel, strategy, exports, scheduler, bus, config, logger, loaded, registry, frameBuilder, ocrWorker, audioTranscriptWorker, entityResolver, sessionBuilder, meetingBuilder, meetingSummarizer, eventExtractor, embeddingWorker, vacuum, loadGuard, activityCoalescer, idlePowerCatchup, captureHooks, hookWidgetManifests };
  return handlesRef;
}

async function resolveHookWidgetBundle(
  registry: PluginRegistry,
  pluginName: string,
  bundlePath: string | undefined,
): Promise<string | null> {
  if (!bundlePath) return null;
  try {
    const entry = registry.byLayer('hook').find(
      (e) => e.manifest.name === pluginName || e.packageName.endsWith(`/hook-${pluginName}`) || e.packageName.endsWith(`/${pluginName}`),
    );
    if (!entry) return null;
    const abs = path.isAbsolute(bundlePath) ? bundlePath : path.resolve(entry.rootDir, bundlePath);
    await fsp.access(abs);
    return abs;
  } catch {
    return null;
  }
}

export async function runIncremental(h: OrchestratorHandles) {
  const log = h.logger.child('index');
  try {
    const aud = await h.audioTranscriptWorker.drain(), fb = await h.frameBuilder.drain(), er = await h.entityResolver.drain(), sb = await h.sessionBuilder.drain(), mb = await h.meetingBuilder.drain();
    try { await h.eventExtractor.tick(); } catch {}
    await h.embeddingWorker.drain();
    await h.model.unload?.().catch(() => {});
  } catch {}
  
  await startPassiveExports(h.exports, log);
  let totalEvents = 0, totalCreated = 0, totalUpdated = 0;

  for (let batch = 0; batch < 1000; batch++) {
    const events = await h.strategy.getUnindexedEvents(h.storage);
    if (!events.length) break;
    const update = await h.strategy.indexBatch(events, await h.strategy.getState(), h.indexerModel);
    await h.strategy.applyUpdate(update);
    for (const exp of h.exports) {
      for (const p of update.pagesToCreate) await exp.onPageUpdate(p);
      for (const p of update.pagesToUpdate) await exp.onPageUpdate(p);
      for (const d of update.pagesToDelete) await exp.onPageDelete(d);
    }
    await h.storage.markIndexed(h.strategy.name, events.map((e) => e.id));
    totalEvents += events.length; totalCreated += update.pagesToCreate.length; totalUpdated += update.pagesToUpdate.length;
    if (events.length < h.config.index.batch_size) break;
  }

  await h.indexerModel.unload?.().catch(() => {});
  if (totalCreated + totalUpdated > 0) await h.embeddingWorker.tick().catch(() => {});
  return { eventsProcessed: totalEvents, pagesCreated: totalCreated, pagesUpdated: totalUpdated };
}

export async function runReorganisation(h: OrchestratorHandles) {
  await startPassiveExports(h.exports, h.logger.child('reorg'));
  const update = await h.strategy.reorganise(await h.strategy.getState(), h.indexerModel);
  await h.strategy.applyUpdate(update);
  for (const exp of h.exports) {
    for (const p of update.pagesToCreate) await exp.onPageUpdate(p);
    for (const d of update.pagesToDelete) await exp.onPageDelete(d);
    if (update.reorganisationNotes) await exp.onReorganisation({ merged: [], split: [], archived: update.pagesToDelete, newSummaryPages: update.pagesToCreate.filter((p) => p.path.endsWith('_summary.md')).map((p) => p.path), reclassified: [], notes: update.reorganisationNotes });
  }
  await h.indexerModel.unload?.().catch(() => {});
}

export async function runFullReindex(h: OrchestratorHandles, opts: { from?: string; to?: string } = {}) {
  const release = await acquireIndexMaintenanceLock(h, 'full-reindex');
  try {
    const log = h.logger.child('full-reindex');
    applyKeepAliveOverride(h.model, '30m'); if (h.indexerModel !== h.model) applyKeepAliveOverride(h.indexerModel, '30m');
    const captureRunning = h.capture.getStatus?.()?.running;
    if (captureRunning) await h.capture.stop().catch(() => {});
    
    try {
      await h.strategy.reset(); await h.storage.clearIndexCheckpoint(h.strategy.name);
      await Promise.all([h.audioTranscriptWorker.drain(), h.storage.resetFrameDerivatives(opts)]);
      await h.frameBuilder.drain(); await h.entityResolver.drain(); await h.storage.rebuildEntityCounts();
      await Promise.all([h.storage.clearAllSessions(), h.storage.clearAllMeetings(), h.storage.clearAllDayEvents().catch(() => {}), h.storage.clearFrameEmbeddings(getEmbeddingModelName(h.config))]);
      await Promise.all([h.sessionBuilder.drain(), h.meetingBuilder.drain(), h.embeddingWorker.drain()]);
      await h.eventExtractor.tick().catch(() => {});
      await checkpointWalIfSupported(h.storage, 'TRUNCATE');
      await unloadEmbeddingsOnly(h.model); if (h.indexerModel !== h.model) await unloadEmbeddingsOnly(h.indexerModel);
      await startPassiveExports(h.exports, log);
      await h.strategy.getUnindexedEvents(h.storage);

      let offset = 0, totalProcessed = 0, batchSize = Math.max(h.config.index.batch_size, 1000);
      while (true) {
        const events = await h.storage.readEvents({ ...opts, limit: batchSize, offset });
        if (!events.length) break;
        const update = await h.strategy.indexBatch(events, await h.strategy.getState(), h.indexerModel);
        await h.strategy.applyUpdate(update);
        for (const exp of h.exports) {
          for (const p of update.pagesToCreate) await exp.onPageUpdate(p);
          for (const p of update.pagesToUpdate) await exp.onPageUpdate(p);
          for (const d of update.pagesToDelete) await exp.onPageDelete(d);
        }
        await h.storage.markIndexed(h.strategy.name, events.map((e) => e.id));
        offset += events.length; totalProcessed += events.length;
        if (events.length < batchSize) break;
      }
      for (const exp of h.exports) if (exp.name !== 'mcp') await exp.fullSync(await h.strategy.getState(), h.strategy);
      await h.indexerModel.unload?.().catch(() => {});
      await checkpointWalIfSupported(h.storage, 'TRUNCATE'); await vacuumDbIfSupported(h.storage); await checkpointWalIfSupported(h.storage, 'TRUNCATE');
    } finally {
      resetKeepAliveIfSupported(h.model); if (h.indexerModel !== h.model) resetKeepAliveIfSupported(h.indexerModel);
      if (captureRunning) await h.capture.start().catch(() => {});
    }
  } finally { await release(); }
}

function applyKeepAliveOverride(a: IModelAdapter, v: string | number) { (a as any).setKeepAlive?.(v); }
function resetKeepAliveIfSupported(a: IModelAdapter) { (a as any).resetKeepAlive?.(); }
async function checkpointWalIfSupported(s: IStorage, mode: 'PASSIVE' | 'TRUNCATE') { await (s as any).checkpointWal?.(mode).catch(() => {}); }
async function vacuumDbIfSupported(s: IStorage) { await s.runMaintenance?.().catch(() => {}); }
async function unloadEmbeddingsOnly(a: IModelAdapter) { await (a as any).unloadEmbeddings?.().catch(() => {}); }

async function acquireIndexMaintenanceLock(h: OrchestratorHandles, job: string) {
  const lp = path.join(h.loaded.dataDir, '.index-maintenance.lock');
  for (let i = 0; i < 2; i++) {
    try {
      await fsp.writeFile(lp, JSON.stringify({ job, pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });
      return async () => { await fsp.unlink(lp).catch(() => {}); };
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      if (!(await clearStaleIndexMaintenanceLock(lp))) throw new Error('Lock held');
    }
  }
  throw new Error('Lock failed');
}

async function hasActiveIndexMaintenanceLock(d: string) {
  try {
    const s = await fsp.stat(path.join(d, '.index-maintenance.lock'));
    if (Date.now() - s.mtimeMs > 14400000) { await fsp.unlink(path.join(d, '.index-maintenance.lock')).catch(() => {}); return false; }
    return true;
  } catch { return false; }
}

async function clearStaleIndexMaintenanceLock(p: string) {
  try { const s = await fsp.stat(p); if (Date.now() - s.mtimeMs <= 14400000) return false; await fsp.unlink(p); return true; } catch { return true; }
}

export function describeLoadGuardDecision(d: LoadGuardDecision, c: BesideConfig) { return d.reason; }

export function assertHeavyWorkAllowed(h: OrchestratorHandles, job: string) {
  if (!h.loadGuard.check(job, { allowForced: false }).proceed) throw new Error('Heavy work deferred');
}

async function runIdlePowerCatchup(h: OrchestratorHandles) {
  if (!h.loadGuard.check(JOBS.IDLE_POWER_CATCHUP, { requireAcPower: true, allowForced: false }).proceed || await hasActiveIndexMaintenanceLock(h.loaded.dataDir)) return;
  for (const job of [JOBS.AUDIO_TRANSCRIPT, JOBS.FRAME_BUILDER, JOBS.OCR_WORKER, JOBS.ENTITY_RESOLVER, JOBS.SESSION_BUILDER, JOBS.MEETING_BUILDER]) if (h.scheduler.has(job)) await h.scheduler.runNow(job);
  if (h.config.index.reorganise_on_idle) await h.scheduler.runNow(JOBS.INCREMENTAL); else await h.scheduler.runNow(JOBS.EMBEDDING_WORKER);
  await h.scheduler.runNow(JOBS.MEETING_SUMMARIZER); await h.scheduler.runNow(JOBS.EVENT_EXTRACTOR);
}

export function scheduleAll(h: OrchestratorHandles) {
  const skipLock = (n: string, fn: () => Promise<any>) => async () => { if (await hasActiveIndexMaintenanceLock(h.loaded.dataDir)) return; await fn(); };
  const guard = (n: string, fn: () => Promise<any>) => async () => { if (h.loadGuard.check(n, { allowForced: false }).proceed) await fn(); };
  
  h.scheduler.every(JOBS.FRAME_BUILDER, INTERVALS.FRAME, skipLock(JOBS.FRAME_BUILDER, () => h.frameBuilder.tick().catch(() => {})));
  let ocrStreak = 0, ocrSlow = false;
  h.bus.on((e) => { if (e.type === 'screenshot' && (ocrStreak || ocrSlow)) { ocrStreak = 0; ocrSlow = false; h.scheduler.setIntervalMs(JOBS.OCR_WORKER, INTERVALS.OCR); } });
  h.scheduler.every(JOBS.OCR_WORKER, INTERVALS.OCR, skipLock(JOBS.OCR_WORKER, guard(JOBS.OCR_WORKER, async () => {
    const res = await h.ocrWorker.tick().catch(() => ({ processed: 0, failed: 0 }));
    if (res.processed + res.failed > 0) { ocrStreak = 0; ocrSlow = false; } else if (++ocrStreak >= 3) { ocrSlow = true; h.scheduler.setIntervalMs(JOBS.OCR_WORKER, INTERVALS.OCR_IDLE); }
  })));
  
  h.scheduler.every(JOBS.AUDIO_TRANSCRIPT, Math.max(15_000, h.config.capture.audio.tick_interval_sec * 1000), skipLock(JOBS.AUDIO_TRANSCRIPT, guard(JOBS.AUDIO_TRANSCRIPT, () => h.audioTranscriptWorker.tick().catch(() => {}))));
  h.scheduler.every(JOBS.ENTITY_RESOLVER, INTERVALS.ENTITY, skipLock(JOBS.ENTITY_RESOLVER, () => h.entityResolver.tick().catch(() => {})));
  h.scheduler.every(JOBS.SESSION_BUILDER, INTERVALS.SESSION, skipLock(JOBS.SESSION_BUILDER, () => h.sessionBuilder.tick().catch(() => {})));
  h.scheduler.every(JOBS.MEETING_BUILDER, INTERVALS.MEETING, skipLock(JOBS.MEETING_BUILDER, () => h.meetingBuilder.tick().catch(() => {})));
  h.scheduler.every(JOBS.MEETING_SUMMARIZER, INTERVALS.SUMMARIZER, skipLock(JOBS.MEETING_SUMMARIZER, guard(JOBS.MEETING_SUMMARIZER, () => h.meetingSummarizer.tick().catch(() => {}))));
  h.scheduler.every(JOBS.EVENT_EXTRACTOR, INTERVALS.EVENT, skipLock(JOBS.EVENT_EXTRACTOR, () => h.eventExtractor.tick().catch(() => {})));
  h.scheduler.every(JOBS.EMBEDDING_WORKER, Math.max(60000, h.config.index.embeddings.tick_interval_min * 60000), skipLock(JOBS.EMBEDDING_WORKER, guard(JOBS.EMBEDDING_WORKER, async () => { if (h.config.system.background_model_jobs === 'scheduled') await h.embeddingWorker.tick().catch(() => {}); })));
  h.scheduler.every(JOBS.VACUUM, Math.max(60000, h.config.storage.local.vacuum.tick_interval_min * 60000), skipLock(JOBS.VACUUM, guard(JOBS.VACUUM, () => h.vacuum.tick().catch(() => {}))));
  h.scheduler.every(JOBS.STORAGE_MAINTENANCE, INTERVALS.STORAGE_MAINT, skipLock(JOBS.STORAGE_MAINTENANCE, async () => { if (h.loadGuard.check(JOBS.STORAGE_MAINTENANCE, { requireAcPower: true, allowForced: false }).proceed) await h.storage.runMaintenance().catch(() => {}); }));
  if (h.config.storage.local.retention_days > 0) h.scheduler.every(JOBS.STORAGE_RETENTION, INTERVALS.RETENTION, skipLock(JOBS.STORAGE_RETENTION, async () => { if (h.loadGuard.check(JOBS.STORAGE_RETENTION, { requireAcPower: true, allowForced: false }).proceed) await h.storage.deleteOldData(h.config.storage.local.retention_days).catch(() => {}); }));
  h.scheduler.every(JOBS.INCREMENTAL, h.config.index.incremental_interval_min * 60000, skipLock(JOBS.INCREMENTAL, guard(JOBS.INCREMENTAL, async () => { if (h.config.system.background_model_jobs === 'scheduled') await runIncremental(h).catch(() => {}); })));
  h.scheduler.cron(JOBS.REORG, h.config.index.reorganise_schedule, skipLock(JOBS.REORG, guard(JOBS.REORG, async () => { if (h.config.system.background_model_jobs === 'scheduled') await runReorganisation(h).catch(() => {}); })));
  
  h.activityCoalescer.start(); h.idlePowerCatchup.start();
}

export async function startAll(h: OrchestratorHandles) { await h.capture.start(); for (const e of h.exports) await e.start(); h.captureHooks.start(); scheduleAll(h); }
export async function stopAll(h: OrchestratorHandles) {
  h.idlePowerCatchup.stop(); h.activityCoalescer.stop(); h.scheduler.stop();
  h.captureHooks.stop();
  for (const e of h.exports) await e.stop(); await h.capture.stop(); await h.ocrWorker.stop();
  await h.model.unload?.().catch(() => {}); if (h.indexerModel !== h.model) await h.indexerModel.unload?.().catch(() => {});
}

export function exportRoot(dataDir: string) { return path.join(dataDir, 'export'); }
function getEmbeddingModelName(c: BesideConfig) { const b = (c.index.model as any)[c.index.model.plugin]; return (typeof b?.embedding_model === 'string' && b.embedding_model.trim()) ? b.embedding_model : c.index.model.plugin; }

export async function bootstrapModel(h: OrchestratorHandles, onP?: ModelBootstrapHandler, opts: { force?: boolean } = {}) {
  if (typeof h.model.ensureReady !== 'function') return;
  const mp = path.join(h.loaded.dataDir, '.model-revision'), cRev = (h.config.index.model.ollama as any)?.model_revision, mData = await fsp.readFile(mp, 'utf8').then((r) => JSON.parse(r)).catch(() => null);
  const force = opts.force || (cRev != null && (mData?.revision == null || mData.revision < cRev)) || (!!mData && mData.model !== h.model.getModelInfo().name);
  await h.model.ensureReady(onP, force ? { force: true } : undefined);
  if (h.indexerModel !== h.model && typeof h.indexerModel.ensureReady === 'function') await h.indexerModel.ensureReady(onP, force ? { force: true } : undefined);
  if (cRev != null) await fsp.mkdir(path.dirname(mp), { recursive: true }).then(() => fsp.writeFile(mp, JSON.stringify({ revision: cRev, model: h.model.getModelInfo().name, updatedAt: new Date().toISOString() }))).catch(() => {});
}

export function useOfflineModel(h: OrchestratorHandles) {
  const o = new OfflineFallbackAdapter(h.logger); h.model = o; h.indexerModel = o; h.embeddingWorker.setModel(o);
  for (const exp of h.exports) exp.bindServices?.({ storage: h.storage, strategy: h.strategy, model: o, embeddingModelName: getEmbeddingModelName(h.config), embeddingSearchWeight: h.config.index.embeddings.search_weight, dataDir: h.loaded.dataDir, triggerReindex: async () => { await h.scheduler.runNow(JOBS.INCREMENTAL); } });
}
