import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  ICapture,
  IStorage,
  IModelAdapter,
  IIndexStrategy,
  IExport,
  Logger,
  RawEvent,
  PluginHostContext,
  ModelBootstrapHandler,
} from '@cofounderos/interfaces';
import type { ExportServices } from '@cofounderos/interfaces';
import {
  RawEventBus,
  Scheduler,
  PluginRegistry,
  discoverPlugins,
  findWorkspaceRoot,
  loadConfig,
  LoadGuard,
  type CofounderOSConfig,
  type LoadedConfig,
} from '@cofounderos/core';
import { FrameBuilder } from './frame-builder.js';
import { SessionBuilder } from './session-builder.js';
import { EmbeddingWorker } from './embedding-worker.js';
import { AudioTranscriptWorker } from './audio-transcript-worker.js';
import { OcrWorker } from './ocr-worker.js';
import { EntityResolverWorker } from './entity-resolver.js';
import { StorageVacuum } from './storage-vacuum.js';
import { OfflineFallbackAdapter } from './offline-model.js';

export interface OrchestratorOptions {
  configPath?: string;
  workspaceRoot?: string;
}

export interface OrchestratorHandles {
  capture: ICapture;
  storage: IStorage;
  /**
   * Active model adapter. May be replaced at runtime by `useOfflineModel()`
   * when the user opts in via `--offline` or when bootstrap fails and the
   * user accepts the deterministic fallback.
   */
  model: IModelAdapter;
  strategy: IIndexStrategy;
  exports: IExport[];
  scheduler: Scheduler;
  bus: RawEventBus;
  config: CofounderOSConfig;
  logger: Logger;
  loaded: LoadedConfig;
  registry: PluginRegistry;
  frameBuilder: FrameBuilder;
  ocrWorker: OcrWorker;
  audioTranscriptWorker: AudioTranscriptWorker;
  entityResolver: EntityResolverWorker;
  sessionBuilder: SessionBuilder;
  embeddingWorker: EmbeddingWorker;
  vacuum: StorageVacuum;
  loadGuard: LoadGuard;
}

const INCREMENTAL_JOB = 'index-incremental';
const REORG_JOB = 'index-reorganise';
const FRAME_BUILDER_JOB = 'frame-builder';
const FRAME_BUILDER_INTERVAL_MS = 60_000;
const FRAME_BUILDER_BATCH_SIZE = 25;
const OCR_WORKER_JOB = 'ocr-worker';
const OCR_WORKER_INTERVAL_MS = 30_000;
const AUDIO_TRANSCRIPT_JOB = 'audio-transcript-worker';
const ENTITY_RESOLVER_JOB = 'entity-resolver';
const ENTITY_RESOLVER_INTERVAL_MS = 90_000;
const ENTITY_RESOLVER_BATCH_SIZE = 25;
const SESSION_BUILDER_JOB = 'session-builder';
const SESSION_BUILDER_INTERVAL_MS = 120_000;
const SESSION_BUILDER_BATCH_SIZE = 100;
const EMBEDDING_WORKER_JOB = 'embedding-worker';
const VACUUM_JOB = 'storage-vacuum';

async function startPassiveExports(exports: IExport[], logger: Logger): Promise<void> {
  for (const exp of exports) {
    if (exp.name === 'mcp') continue;
    if (!exp.getStatus().running) {
      try {
        await exp.start();
      } catch (err) {
        logger.warn(`failed to start export "${exp.name}"`, { err: String(err) });
      }
    }
  }
}

export async function buildOrchestrator(
  logger: Logger,
  opts: OrchestratorOptions = {},
): Promise<OrchestratorHandles> {
  const loaded = await loadConfig(opts.configPath);
  const { config, dataDir } = loaded;
  const workspaceRoot = opts.workspaceRoot
    ?? process.env.COFOUNDEROS_RESOURCE_ROOT
    ?? findWorkspaceRoot(process.cwd());

  logger.info(`config loaded from ${loaded.sourcePath}`);
  logger.info(`data_dir = ${dataDir}`);

  const entries = await discoverPlugins(workspaceRoot, logger);
  const registry = new PluginRegistry(entries, logger);
  logger.info(
    `plugins discovered: ${entries.map((e) => `${e.manifest.name}(${e.manifest.layer})`).join(', ')}`,
  );

  const baseCtx = (extraConfig: Record<string, unknown>): PluginHostContext => ({
    dataDir,
    logger,
    config: { ...extraConfig, raw_root: dataDir },
  });

  const storageBlock = (config.storage as unknown as Record<string, unknown>)[config.storage.plugin];
  const modelBlock = (config.index.model as unknown as Record<string, unknown>)[
    config.index.model.plugin
  ];

  // Storage first — everything depends on it.
  const storage = await registry.loadStorage(
    config.storage.plugin,
    baseCtx((storageBlock as Record<string, unknown>) ?? {}),
  );

  // Model.
  const model = await registry.loadModel(
    config.index.model.plugin,
    baseCtx((modelBlock as Record<string, unknown>) ?? {}),
  );

  // Index strategy.
  const strategy = await registry.loadIndexStrategy(config.index.strategy, baseCtx({
    index_path: config.index.index_path,
    batch_size: config.index.batch_size,
  }));

  // Capture.
  // `config.capture` is a Zod `passthrough()` schema, so plugin-specific
  // fields like `multi_screen`, `screens`, and `capture_mode` ride
  // through on the parsed object even though they aren't part of
  // `CaptureSchema`. We forward the *whole* capture block (minus the
  // `plugin` selector itself) to the plugin so any current or future
  // plugin-specific keys reach the plugin without requiring a host edit.
  // The previous explicit allowlist silently dropped exactly these
  // fields — symptom: users set `multi_screen: true` in config.yaml,
  // restarted, and saw the plugin still log "capturing only display 0".
  const captureConfig = (() => {
    const { plugin: _ignored, ...rest } = config.capture as Record<string, unknown>;
    return { ...rest, raw_root: dataDir };
  })();
  const capture = await registry.loadCapture(config.capture.plugin, baseCtx(captureConfig));

  // Exports — multiple may be active simultaneously.
  const exports: IExport[] = [];
  for (const exportRef of config.export.plugins) {
    if ((exportRef as { enabled?: boolean }).enabled === false) continue;
    const exp = await registry.loadExport(exportRef.name, baseCtx({
      ...exportRef,
    }));
    exports.push(exp);
  }

  const bus = new RawEventBus(logger);
  const scheduler = new Scheduler(logger);
  const loadGuard = new LoadGuard(config.system.load_guard, logger);

  // Wire capture → bus → storage. The storage write is awaited so we
  // never lose events on a hang.
  capture.onEvent(async (event) => {
    await storage.write(event);
    await bus.publish(event);
  });

  // Hand every export plugin the full services bag. Plugins that need
  // host services declare `bindServices` (see IExport.bindServices); the
  // rest are no-ops. This keeps the host decoupled from concrete plugin
  // classes — no `instanceof` checks, no static imports of plugin code.
  const exportServices: ExportServices = {
    storage,
    strategy,
    model,
    embeddingModelName: getEmbeddingModelName(config),
    dataDir,
    triggerReindex: async (_full) => {
      await scheduler.runNow(INCREMENTAL_JOB);
    },
  };
  for (const exp of exports) {
    if (typeof exp.bindServices === 'function') {
      exp.bindServices(exportServices);
    }
  }

  const sensitiveKeywords = config.capture.privacy.sensitive_keywords ?? [];
  const frameBuilder = new FrameBuilder(storage, logger, {
    batchSize: FRAME_BUILDER_BATCH_SIZE,
    sensitiveKeywords,
  });
  const ocrWorker = new OcrWorker(storage, logger, {
    storageRoot: storage.getRoot(),
    sensitiveKeywords,
  });
  const audioTranscriptWorker = new AudioTranscriptWorker(storage, logger, {
    enabled: config.capture.capture_audio,
    inboxPath: config.capture.audio.inbox_path,
    processedPath: config.capture.audio.processed_path,
    failedPath: config.capture.audio.failed_path,
    whisperCommand: config.capture.audio.whisper_command,
    whisperModel: config.capture.whisper_model,
    whisperLanguage: config.capture.audio.whisper_language,
    batchSize: config.capture.audio.batch_size,
    sensitiveKeywords,
  });
  const entityResolver = new EntityResolverWorker(storage, logger, ENTITY_RESOLVER_BATCH_SIZE);
  const sessionsCfg = config.index.sessions;
  const sessionBuilder = new SessionBuilder(storage, logger, {
    idleThresholdMs: sessionsCfg.idle_threshold_sec * 1000,
    minActiveMs: sessionsCfg.min_active_ms,
    fallbackFrameAttentionMs: sessionsCfg.fallback_frame_attention_ms,
    batchSize: SESSION_BUILDER_BATCH_SIZE,
  });
  const embeddingsCfg = config.index.embeddings;
  const embeddingWorker = new EmbeddingWorker(storage, model, logger, {
    enabled: embeddingsCfg.enabled,
    batchSize: embeddingsCfg.batch_size,
    modelName: getEmbeddingModelName(config),
  });
  const vacuumCfg = config.storage.local.vacuum;
  // Resolve the effective window in ms. `*_minutes` (when set) wins
  // over `*_days` so users can dial in tight retention for testing or
  // small machines without losing the legacy day-granularity defaults.
  const stageMs = (days: number, minutes: number | undefined): number => {
    if (typeof minutes === 'number') return minutes * 60_000;
    return days * 24 * 60 * 60 * 1000;
  };
  const vacuum = new StorageVacuum(storage, logger, {
    storageRoot: storage.getRoot(),
    compressAfterMs: stageMs(vacuumCfg.compress_after_days, vacuumCfg.compress_after_minutes),
    compressQuality: vacuumCfg.compress_quality,
    thumbnailAfterMs: stageMs(vacuumCfg.thumbnail_after_days, vacuumCfg.thumbnail_after_minutes),
    thumbnailMaxDim: vacuumCfg.thumbnail_max_dim,
    deleteAfterMs: stageMs(vacuumCfg.delete_after_days, vacuumCfg.delete_after_minutes),
    batchSize: vacuumCfg.batch_size,
  });

  return {
    capture,
    storage,
    model,
    strategy,
    exports,
    scheduler,
    bus,
    config,
    logger,
    loaded,
    registry,
    frameBuilder,
    ocrWorker,
    audioTranscriptWorker,
    entityResolver,
    sessionBuilder,
    embeddingWorker,
    vacuum,
    loadGuard,
  };
}

/**
 * Run a single incremental indexing pass.
 * Reads unindexed events for the active strategy, runs the model, applies
 * the resulting update, marks events as indexed, fans the diff out to
 * every export plugin.
 */
export async function runIncremental(handles: OrchestratorHandles): Promise<{
  eventsProcessed: number;
  pagesCreated: number;
  pagesUpdated: number;
}> {
  const { storage, strategy, model, exports, logger, config, audioTranscriptWorker, frameBuilder, entityResolver, sessionBuilder, embeddingWorker } = handles;
  const log = logger.child('index-runner');

  // Materialise frames + resolve entities + group into sessions before
  // indexing so the strategy can read from a fully-prepared substrate.
  // All passes are cheap and incremental — together they cost ~20ms
  // when there's no work.
  try {
    const audioResult = await audioTranscriptWorker.drain();
    if (audioResult.processed > 0) {
      log.info(
        `ingested ${audioResult.processed} audio transcript(s) before indexing`,
      );
    }
    const fbResult = await frameBuilder.drain();
    if (fbResult.framesCreated > 0) {
      log.info(`built ${fbResult.framesCreated} new frames before indexing`);
    }
    const erResult = await entityResolver.drain();
    if (erResult.resolved > 0) {
      log.info(`resolved ${erResult.resolved} frames to entities`);
    }
    const sbResult = await sessionBuilder.drain();
    if (sbResult.framesProcessed > 0) {
      log.info(
        `grouped ${sbResult.framesProcessed} frames into ${sbResult.sessionsCreated} new + ${sbResult.sessionsExtended} extended session(s)`,
      );
    }
    const embResult = await embeddingWorker.drain();
    if (embResult.processed > 0) {
      log.info(`embedded ${embResult.processed} frame(s) for semantic search`);
    }
    await model.unload?.().catch((err: unknown) => {
      log.debug('model unload after indexing preparation failed', { err: String(err) });
    });
  } catch (err) {
    log.warn('frame/entity/session preparation failed (continuing)', { err: String(err) });
  }

  // Lazy-start passive exports (file mirrors, etc.) so one-off `index --once`
  // / `--full-reindex` runs still propagate. Network-server exports like MCP
  // are skipped — they only start when the user runs `start` or `mcp`
  // explicitly so we never bind a port behind their back.
  await startPassiveExports(exports, log);

  let totalEvents = 0;
  let totalCreated = 0;
  let totalUpdated = 0;

  // Loop through batches until storage reports no more unindexed events.
  for (let batch = 0; batch < 1000; batch++) {
    const events = await strategy.getUnindexedEvents(storage);
    if (events.length === 0) break;

    log.info(`indexing batch of ${events.length} events`);
    const state = await strategy.getState();
    const update = await strategy.indexBatch(events, state, model);
    await strategy.applyUpdate(update);

    for (const exp of exports) {
      for (const p of update.pagesToCreate) await exp.onPageUpdate(p);
      for (const p of update.pagesToUpdate) await exp.onPageUpdate(p);
      for (const d of update.pagesToDelete) await exp.onPageDelete(d);
    }

    await storage.markIndexed(strategy.name, events.map((e) => e.id));

    totalEvents += events.length;
    totalCreated += update.pagesToCreate.length;
    totalUpdated += update.pagesToUpdate.length;

    if (events.length < config.index.batch_size) break;
  }

  if (totalEvents === 0) log.debug('no new events to index');
  else log.info(`indexed ${totalEvents} events (${totalCreated} created, ${totalUpdated} updated)`);

  await model.unload?.().catch((err: unknown) => {
    log.debug('model unload after incremental indexing failed', { err: String(err) });
  });

  return {
    eventsProcessed: totalEvents,
    pagesCreated: totalCreated,
    pagesUpdated: totalUpdated,
  };
}

export async function runReorganisation(handles: OrchestratorHandles): Promise<void> {
  const { strategy, model, exports, logger } = handles;
  const log = logger.child('index-reorg');
  await startPassiveExports(exports, log);
  const state = await strategy.getState();
  const update = await strategy.reorganise(state, model);
  await strategy.applyUpdate(update);

  for (const exp of exports) {
    for (const p of update.pagesToCreate) await exp.onPageUpdate(p);
    for (const d of update.pagesToDelete) await exp.onPageDelete(d);
    if (update.reorganisationNotes) {
      await exp.onReorganisation({
        merged: [],
        split: [],
        archived: update.pagesToDelete,
        newSummaryPages: update.pagesToCreate
          .filter((p) => p.path.endsWith('_summary.md'))
          .map((p) => p.path),
        reclassified: [],
        notes: update.reorganisationNotes,
      });
    }
  }
  await model.unload?.().catch((err: unknown) => {
    log.debug('model unload after reorganisation failed', { err: String(err) });
  });
  log.info('reorganisation complete');
}

export async function runFullReindex(
  handles: OrchestratorHandles,
  opts: { from?: string; to?: string } = {},
): Promise<void> {
  const release = await acquireIndexMaintenanceLock(handles, 'full-reindex');
  try {
    await runFullReindexLocked(handles, opts);
  } finally {
    await release();
  }
}

async function runFullReindexLocked(
  handles: OrchestratorHandles,
  opts: { from?: string; to?: string } = {},
): Promise<void> {
  const { storage, strategy, model, exports, logger, config, audioTranscriptWorker, frameBuilder, entityResolver, sessionBuilder, embeddingWorker } = handles;
  const log = logger.child('full-reindex');
  const range = [
    opts.from ? `from=${opts.from}` : null,
    opts.to ? `to=${opts.to}` : null,
  ].filter(Boolean).join(', ');
  log.info(
    `full re-index starting (strategy=${strategy.name}${range ? `, ${range}` : ''})`,
  );

  await strategy.reset();
  await storage.clearIndexCheckpoint(strategy.name);

  const audio = await audioTranscriptWorker.drain();
  if (audio.processed > 0) {
    log.info(`ingested ${audio.processed} audio transcript(s) before full re-index`);
  }

  // Rebuild frames + entities from scratch — both are derived tables and
  // the resolver rules may have improved between runs.
  const fb = await frameBuilder.drain();
  if (fb.framesCreated > 0) {
    log.info(`rebuilt ${fb.framesCreated} frames from raw events`);
  }
  const er = await entityResolver.drain();
  if (er.resolved > 0) {
    log.info(`resolved ${er.resolved} frames to entities`);
  }
  // Recompute entity counts from the freshly resolved frames so any
  // resolver-rule changes take effect for all of history, not just new data.
  await storage.rebuildEntityCounts();
  // Sessions are derived from frames + entities, so they need to be
  // rebuilt last and from scratch. A change to idle_threshold_sec or to
  // entity rules can change session boundaries; clearing first means
  // the new config takes effect on every frame, not just future ones.
  await storage.clearAllSessions();
  const sb = await sessionBuilder.drain();
  if (sb.framesProcessed > 0) {
    log.info(
      `rebuilt ${sb.sessionsCreated} session(s) from ${sb.framesProcessed} frames`,
    );
  }
  await storage.clearFrameEmbeddings(getEmbeddingModelName(config));
  const emb = await embeddingWorker.drain();
  if (emb.processed > 0) {
    log.info(`rebuilt ${emb.processed} frame embedding(s)`);
  }
  await model.unload?.().catch((err: unknown) => {
    log.debug('model unload after full-reindex embeddings failed', { err: String(err) });
  });

  await startPassiveExports(exports, log);

  // KarpathyStrategy captures the storage handle when getUnindexedEvents()
  // is called. Full reindex walks explicit date ranges instead, so bind once
  // up front before calling indexBatch directly.
  await strategy.getUnindexedEvents(storage);

  // Collect the requested raw event range, then render entity pages once.
  // The strategy builds pages from the materialised entity/frame tables, not
  // from individual raw events, so invoking it once avoids re-rendering the
  // same active entities for every historical event batch.
  const batchSize = config.index.batch_size;
  let offset = 0;
  const allEvents: RawEvent[] = [];

  while (true) {
    const events = await storage.readEvents({
      from: opts.from,
      to: opts.to,
      limit: batchSize,
      offset,
    });
    if (events.length === 0) break;

    allEvents.push(...events);
    offset += events.length;
    if (events.length < batchSize) break;
  }

  if (allEvents.length > 0) {
    const state = await strategy.getState();
    const update = await strategy.indexBatch(allEvents, state, model);
    await strategy.applyUpdate(update);
    for (const exp of exports) {
      for (const p of update.pagesToCreate) await exp.onPageUpdate(p);
      for (const p of update.pagesToUpdate) await exp.onPageUpdate(p);
      for (const d of update.pagesToDelete) await exp.onPageDelete(d);
    }
    await storage.markIndexed(strategy.name, allEvents.map((e) => e.id));
  }

  const finalState = await strategy.getState();
  for (const exp of exports) {
    if (exp.name === 'mcp') continue;
    await exp.fullSync(finalState, strategy);
  }

  await model.unload?.().catch((err: unknown) => {
    log.debug('model unload after full re-index failed', { err: String(err) });
  });

  log.info(`full re-index complete — ${allEvents.length} events processed`);
}

const INDEX_MAINTENANCE_LOCK = '.index-maintenance.lock';
const INDEX_MAINTENANCE_LOCK_STALE_MS = 4 * 60 * 60_000;

async function acquireIndexMaintenanceLock(
  handles: OrchestratorHandles,
  job: string,
): Promise<() => Promise<void>> {
  const lockPath = indexMaintenanceLockPath(handles.loaded.dataDir);
  const payload = JSON.stringify({
    job,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fsp.writeFile(lockPath, payload, { flag: 'wx' });
      return async () => {
        await fsp.unlink(lockPath).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') {
            handles.logger.child(job).debug('failed to remove index maintenance lock', {
              err: String(err),
            });
          }
        });
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      if (!(await clearStaleIndexMaintenanceLock(lockPath))) {
        throw new Error(`another index maintenance job is already running (${lockPath})`);
      }
    }
  }

  throw new Error(`could not acquire index maintenance lock (${lockPath})`);
}

async function hasActiveIndexMaintenanceLock(dataDir: string): Promise<boolean> {
  const lockPath = indexMaintenanceLockPath(dataDir);
  try {
    const stat = await fsp.stat(lockPath);
    if (Date.now() - stat.mtimeMs > INDEX_MAINTENANCE_LOCK_STALE_MS) {
      await fsp.unlink(lockPath).catch(() => undefined);
      return false;
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return false;
  }
}

async function clearStaleIndexMaintenanceLock(lockPath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(lockPath);
    if (Date.now() - stat.mtimeMs <= INDEX_MAINTENANCE_LOCK_STALE_MS) {
      return false;
    }
    await fsp.unlink(lockPath);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function indexMaintenanceLockPath(dataDir: string): string {
  return path.join(dataDir, INDEX_MAINTENANCE_LOCK);
}

export function scheduleAll(handles: OrchestratorHandles): void {
  const { scheduler, config, frameBuilder, ocrWorker, audioTranscriptWorker, entityResolver, sessionBuilder, embeddingWorker, vacuum, logger, loadGuard } =
    handles;

  // Wrap heavier jobs so they skip when the machine is busy. Cheap jobs
  // (frame builder, OCR, entity resolver) are intentionally not gated —
  // they're small and keep search results fresh on the order of seconds.
  const guarded = (jobName: string, run: () => Promise<unknown>) => async () => {
    const decision = loadGuard.check(jobName);
    if (!decision.proceed) {
      const load = decision.snapshot.normalised?.toFixed(2) ?? '?';
      logger.child(jobName).debug(
        `skipped — system load ${load} >= threshold ${config.system.load_guard.threshold}`,
      );
      return;
    }
    if (decision.reason === 'forced-after-skips') {
      logger.child(jobName).info(
        `running despite high load — hit max_consecutive_skips (${config.system.load_guard.max_consecutive_skips})`,
      );
    }
    await run();
  };
  const skipDuringIndexMaintenance = (
    jobName: string,
    run: () => Promise<unknown>,
  ) => async () => {
    if (await hasActiveIndexMaintenanceLock(handles.loaded.dataDir)) {
      logger.child(jobName).debug('skipped — index maintenance lock active');
      return;
    }
    await run();
  };
  // Frame builder runs frequently and cheaply so search results stay
  // close to real-time even when a full index pass hasn't fired yet.
  scheduler.every(FRAME_BUILDER_JOB, FRAME_BUILDER_INTERVAL_MS, skipDuringIndexMaintenance(FRAME_BUILDER_JOB, async () => {
    try {
      await frameBuilder.tick();
    } catch (err) {
      logger.child('frame-builder').warn('tick failed', { err: String(err) });
    }
  }));
  // OCR worker runs slightly faster than the frame builder so a frame
  // built at second 0 typically has searchable text by second 60-90.
  scheduler.every(OCR_WORKER_JOB, OCR_WORKER_INTERVAL_MS, skipDuringIndexMaintenance(OCR_WORKER_JOB, async () => {
    try {
      await ocrWorker.tick();
    } catch (err) {
      logger.child('ocr-worker').warn('tick failed', { err: String(err) });
    }
  }));
  scheduler.every(
    AUDIO_TRANSCRIPT_JOB,
    Math.max(15_000, config.capture.audio.tick_interval_sec * 1000),
    skipDuringIndexMaintenance(AUDIO_TRANSCRIPT_JOB, async () => {
      try {
        await audioTranscriptWorker.tick();
      } catch (err) {
        logger.child('audio-transcript-worker').warn('tick failed', { err: String(err) });
      }
    }),
  );
  // Entity resolver runs after the frame builder so freshly built frames
  // become resolvable in the next ~30s.
  scheduler.every(ENTITY_RESOLVER_JOB, ENTITY_RESOLVER_INTERVAL_MS, skipDuringIndexMaintenance(ENTITY_RESOLVER_JOB, async () => {
    try {
      await entityResolver.tick();
    } catch (err) {
      logger.child('entity-resolver').warn('tick failed', { err: String(err) });
    }
  }));
  // Session builder runs slightly slower than the resolver — sessions
  // benefit from frames that already have entity assignments, so we
  // don't want to assign frames to sessions before entity resolution
  // catches up. A 2-minute cadence keeps journals current to roughly
  // the last activity-session boundary at any moment.
  scheduler.every(SESSION_BUILDER_JOB, SESSION_BUILDER_INTERVAL_MS, skipDuringIndexMaintenance(SESSION_BUILDER_JOB, async () => {
    try {
      await sessionBuilder.tick();
    } catch (err) {
      logger.child('session-builder').warn('tick failed', { err: String(err) });
    }
  }));
  scheduler.every(
    EMBEDDING_WORKER_JOB,
    Math.max(60_000, config.index.embeddings.tick_interval_min * 60_000),
    skipDuringIndexMaintenance(EMBEDDING_WORKER_JOB, guarded(EMBEDDING_WORKER_JOB, async () => {
      try {
        await embeddingWorker.tick();
      } catch (err) {
        logger.child('embedding-worker').warn('tick failed', { err: String(err) });
      }
    })),
  );
  // Vacuum runs on a slow tick (default hourly). Each tick processes a
  // small batch so it never starves capture.
  const vacuumIntervalMs = Math.max(60_000, config.storage.local.vacuum.tick_interval_min * 60_000);
  scheduler.every(
    VACUUM_JOB,
    vacuumIntervalMs,
    skipDuringIndexMaintenance(VACUUM_JOB, guarded(VACUUM_JOB, async () => {
      try {
        await vacuum.tick();
      } catch (err) {
        logger.child('storage-vacuum').warn('tick failed', { err: String(err) });
      }
    })),
  );
  scheduler.every(
    INCREMENTAL_JOB,
    config.index.incremental_interval_min * 60 * 1000,
    skipDuringIndexMaintenance(INCREMENTAL_JOB, guarded(INCREMENTAL_JOB, () => runIncremental(handles).then(() => undefined))),
  );
  scheduler.cron(
    REORG_JOB,
    config.index.reorganise_schedule,
    skipDuringIndexMaintenance(REORG_JOB, guarded(REORG_JOB, () => runReorganisation(handles))),
  );
}

export async function startAll(handles: OrchestratorHandles): Promise<void> {
  await handles.capture.start();
  for (const exp of handles.exports) {
    await exp.start();
  }
  scheduleAll(handles);
}

export async function stopAll(handles: OrchestratorHandles): Promise<void> {
  handles.scheduler.stop();
  for (const exp of handles.exports) {
    await exp.stop();
  }
  await handles.capture.stop();
  await handles.ocrWorker.stop();
  const unloadModel = (handles.model as IModelAdapter & { unload?: () => Promise<void> }).unload;
  await unloadModel?.().catch((err: unknown) => {
    handles.logger.child('model').debug('model unload failed during runtime stop', { err: String(err) });
  });
}

export function exportRoot(dataDir: string): string {
  return path.join(dataDir, 'export');
}

function getEmbeddingModelName(config: CofounderOSConfig): string {
  const modelBlock = config.index.model as unknown as Record<string, unknown>;
  const pluginBlock = modelBlock[config.index.model.plugin] as
    | Record<string, unknown>
    | undefined;
  const configured = pluginBlock?.embedding_model;
  if (typeof configured === 'string' && configured.trim()) return configured;
  return config.index.model.plugin;
}

/**
 * Run the model adapter's first-run bootstrap (install + start daemon +
 * pull model) if it supports `ensureReady`. No-op for adapters without
 * that capability.
 *
 * Throws if bootstrap fails. The CLI catches this and offers `--offline`.
 */
export async function bootstrapModel(
  handles: OrchestratorHandles,
  onProgress?: ModelBootstrapHandler,
): Promise<void> {
  if (typeof handles.model.ensureReady !== 'function') return;
  await handles.model.ensureReady(onProgress);
}

/** Swap the active model for the offline deterministic adapter. */
export function useOfflineModel(handles: OrchestratorHandles): void {
  handles.model = new OfflineFallbackAdapter(handles.logger);
  handles.logger.info('using offline deterministic model (no LLM calls).');
}
