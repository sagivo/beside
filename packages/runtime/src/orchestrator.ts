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
  type LoadGuardDecision,
  type LoadedConfig,
} from '@cofounderos/core';
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
  /**
   * Adapter used by the indexing path (Karpathy strategy summarisation,
   * reorganisation). When the user has configured a separate
   * `indexer_model`, this is a distinct, smaller-model adapter; when
   * unset it points at the same instance as `model`. The chat agent
   * and vision recall always use `model`.
   */
  indexerModel: IModelAdapter;
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
  meetingBuilder: MeetingBuilder;
  meetingSummarizer: MeetingSummarizer;
  eventExtractor: EventExtractor;
  embeddingWorker: EmbeddingWorker;
  vacuum: StorageVacuum;
  loadGuard: LoadGuard;
  activityCoalescer: ActivityCoalescer;
  idlePowerCatchup: IdlePowerCatchup;
}

const INCREMENTAL_JOB = 'index-incremental';
const REORG_JOB = 'index-reorganise';
const FRAME_BUILDER_JOB = 'frame-builder';
// Active capture wakes the worker chain via the bus-driven coalescer
// (see ActivityCoalescer below) within ~30s of the burst settling, so
// this is now a backstop interval rather than the primary trigger. We
// stretch from the previous 60s to 5min — the coalescer dominates
// freshness while there's activity, and when the system is fully idle
// no work is needed at all. `runIncremental` also drains these workers
// before each indexing pass, so any drift is bounded by
// `incremental_interval_min` when scheduled model jobs are enabled.
const FRAME_BUILDER_INTERVAL_MS = 5 * 60_000;
const FRAME_BUILDER_BATCH_SIZE = 25;
const OCR_WORKER_JOB = 'ocr-worker';
// OCR is the single biggest CPU draw in the runtime — ~1–3s of Tesseract
// CPU per frame. Was 30s; doubled to 60s. The user-visible impact is that
// search-indexed text from a fresh screenshot appears within ≤60s instead
// of ≤30s, which is well under the 5-min FRAME_BUILDER backstop and the
// ENTITY_RESOLVER cadence that actually surfaces text into the wiki. In
// practice we still get OCR'd well before any meaningful reindex tick.
// During active capture the ActivityCoalescer also drains the OCR queue
// alongside the worker chain, so freshness during real work is bounded by
// the coalescer (~60s) rather than this backstop.
const OCR_WORKER_INTERVAL_MS = 60_000;
// Adaptive back-off. After this many consecutive no-work ticks (e.g.
// machine locked, user away from keyboard, no fresh screenshots) we
// retune the scheduler to the idle interval below so a quiescent
// machine doesn't keep waking the Node main loop every minute just to
// hit an empty DB query. The very next `screenshot` event on the bus
// snaps us back to the base interval (see `wireAdaptiveOcrCadence`).
const OCR_WORKER_IDLE_INTERVAL_MS = 5 * 60_000;
const OCR_WORKER_EMPTY_STREAK_TO_BACKOFF = 3;
const AUDIO_TRANSCRIPT_JOB = 'audio-transcript-worker';
const ENTITY_RESOLVER_JOB = 'entity-resolver';
// Same coalescer-vs-backstop logic as FRAME_BUILDER_INTERVAL_MS. Was 90s.
const ENTITY_RESOLVER_INTERVAL_MS = 5 * 60_000;
const ENTITY_RESOLVER_BATCH_SIZE = 25;
const SESSION_BUILDER_JOB = 'session-builder';
// Sessions have looser freshness needs (used by journals + entity
// timelines, not search), so a 10min backstop is fine. Was 120s.
const SESSION_BUILDER_INTERVAL_MS = 10 * 60_000;
const SESSION_BUILDER_BATCH_SIZE = 100;
const MEETING_BUILDER_JOB = 'meeting-builder';
// Meetings are a retrospective surface (timeline, summaries) — they don't
// need sub-minute freshness. Bumped from 60s → 120s; the meeting
// summariser still runs every 5min and the activity coalescer drains the
// builder alongside frames during real work, so post-meeting recap latency
// is unchanged.
const MEETING_BUILDER_INTERVAL_MS = 120_000;
const MEETING_SUMMARIZER_JOB = 'meeting-summarizer';
const MEETING_SUMMARIZER_INTERVAL_MS = 5 * 60_000;
const EVENT_EXTRACTOR_JOB = 'event-extractor';
// Event extractor runs the LLM over the day's calendar / mail / chat OCR.
// Slower cadence than meeting summarisation -- the user-visible artefact
// only needs to refresh a few times an hour, and the LLM call has the
// same cost as a meeting summary (~2-4s on local Ollama, less on hosted).
const EVENT_EXTRACTOR_INTERVAL_MS = 15 * 60_000;
const EMBEDDING_WORKER_JOB = 'embedding-worker';
const VACUUM_JOB = 'storage-vacuum';
const STORAGE_MAINTENANCE_JOB = 'storage-maintenance';
// Weekly. ANALYZE refreshes planner stats; VACUUM rewrites the DB
// file to reclaim free pages and defragment. Both are I/O heavy and
// briefly hold an exclusive lock, so we gate the job on AC power +
// LoadGuard. Daily would be overkill on a desktop install; monthly
// lets fragmentation and stale stats drift too far on heavy users.
const STORAGE_MAINTENANCE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const STORAGE_RETENTION_JOB = 'storage-retention';
// Daily. The retention cutoff moves at 24h/day, so a missed tick just
// means the next run deletes a slightly larger batch — no urgency.
const STORAGE_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const IDLE_POWER_CATCHUP_JOB = 'idle-power-catchup';
const FULL_REINDEX_EVENT_BATCH_SIZE = 1000;

/**
 * Debounce + max-wait used by the activity coalescer below. After 60s
 * with no new capture events, the worker chain runs once. If activity
 * is constant (debounce never settles), the max-wait forces a run
 * after 4 minutes so the queue can't grow unbounded during long-form
 * work. Stretched from 30s/90s — the embedding leg of the chain is an
 * LLM call when `system.background_model_jobs: scheduled`, and during
 * constant typing the previous cadence pegged Ollama every ~90s.
 */
const COALESCE_DEBOUNCE_MS = 60_000;
const COALESCE_MAX_WAIT_MS = 240_000;

/**
 * Bus-driven coalescer that runs the lightweight worker chain
 * (frame → entity → session → meeting, plus embeddings only in scheduled mode)
 * shortly after a burst of capture activity settles. Replaces the
 * fixed-cadence ticks as the primary freshness mechanism: when the user
 * is active, search results update within ~60s of the latest capture;
 * when the user is idle, we don't run at all. The scheduler `every`
 * intervals stretched out alongside this become safety nets that fire
 * only on long droughts of activity (e.g. one-off CLI commands that
 * bypass the bus).
 *
 * Single-flight: while a chain is running, additional bus events
 * just re-arm the timer. When the chain finishes, the next debounce
 * fires fresh.
 */
class ActivityCoalescer {
  private timer: NodeJS.Timeout | null = null;
  private firstNudgeAt: number | null = null;
  private running = false;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(
    private readonly bus: RawEventBus,
    private readonly logger: Logger,
    private readonly run: () => Promise<void>,
  ) {}

  start(): void {
    if (this.unsubscribe || this.stopped) return;
    this.unsubscribe = this.bus.on(() => this.nudge());
  }

  stop(): void {
    this.stopped = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.firstNudgeAt = null;
  }

  private nudge(): void {
    if (this.stopped) return;
    if (this.firstNudgeAt == null) this.firstNudgeAt = Date.now();
    const elapsed = Date.now() - this.firstNudgeAt;
    if (elapsed >= COALESCE_MAX_WAIT_MS) {
      // Constant activity has been resetting the debounce for too
      // long. Fire now so the queue can drain.
      this.fire();
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), COALESCE_DEBOUNCE_MS);
  }

  private fire(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.firstNudgeAt = null;
    if (this.running || this.stopped) return;
    this.running = true;
    void this.run()
      .catch((err) => {
        this.logger.warn('activity coalescer chain failed', { err: String(err) });
      })
      .finally(() => {
        this.running = false;
      });
  }
}

/**
 * Runs deferred heavy work only after the computer has been idle for the
 * configured window and is not on battery power. Capture continues to
 * collect screenshots/audio while this waits; this class only wakes the
 * expensive derived pipeline.
 */
class IdlePowerCatchup {
  private timer: NodeJS.Timeout | null = null;
  private idle = false;
  private running = false;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(
    private readonly bus: RawEventBus,
    private readonly logger: Logger,
    private readonly idleDelayMs: number,
    private readonly run: () => Promise<void>,
  ) {}

  start(): void {
    if (this.unsubscribe || this.stopped) return;
    this.unsubscribe = this.bus.on((event) => this.onEvent(event));
  }

  stop(): void {
    this.stopped = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.clearTimer();
    this.idle = false;
  }

  private onEvent(event: RawEvent): void {
    if (this.stopped) return;
    if (event.type === 'idle_start') {
      this.idle = true;
      this.schedule();
    } else if (event.type === 'idle_end') {
      this.idle = false;
      this.clearTimer();
    }
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.idle || this.stopped) return;
    this.timer = setTimeout(() => this.fire(), this.idleDelayMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private fire(): void {
    this.clearTimer();
    if (!this.idle || this.running || this.stopped) return;
    this.running = true;
    void this.run()
      .catch((err) => {
        this.logger.warn('idle power catch-up failed', { err: String(err) });
      })
      .finally(() => {
        this.running = false;
        if (this.idle && !this.stopped) this.schedule();
      });
  }
}

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

  // Optional separate adapter for the indexing path. When the user
  // has set `index.model.<plugin>.indexer_model` to a smaller variant
  // (e.g. `gemma4:e2b` when the primary is `gemma4:e4b`), we load a
  // second adapter so summarisation/reorganisation don't have to
  // hold the user-facing chat model in RAM. The chat agent and vision
  // recall keep using the primary `model`.
  //
  // When unset (or set to the same value as `model`), `indexerModel`
  // falls back to `model` and the orchestrator behaves as before.
  const indexerModelName = (modelBlock as Record<string, unknown> | undefined)?.indexer_model;
  const primaryModelName = (modelBlock as Record<string, unknown> | undefined)?.model;
  let indexerModel: IModelAdapter = model;
  if (
    typeof indexerModelName === 'string' &&
    indexerModelName.trim() &&
    indexerModelName !== primaryModelName
  ) {
    try {
      indexerModel = await registry.loadModel(
        config.index.model.plugin,
        baseCtx({
          ...(modelBlock as Record<string, unknown>),
          model: indexerModelName,
        }),
      );
      logger.info(
        `indexer model split: chat/vision="${String(primaryModelName)}", indexer="${indexerModelName}"`,
      );
    } catch (err) {
      logger.warn(
        `failed to load indexer model "${indexerModelName}"; falling back to primary`,
        { err: String(err) },
      );
      indexerModel = model;
    }
  }

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
  let handlesRef: OrchestratorHandles | null = null;

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
    embeddingSearchWeight: config.index.embeddings.search_weight,
    dataDir,
    triggerReindex: async (full = false) => {
      const target = handlesRef;
      if (!target) throw new Error('orchestrator handles not ready');
      if (full) {
        assertHeavyWorkAllowed(target, 'full-reindex');
        await runFullReindex(target);
        return;
      }
      if (scheduler.has(INCREMENTAL_JOB)) {
        await scheduler.runNow(INCREMENTAL_JOB);
        return;
      }
      assertHeavyWorkAllowed(target, INCREMENTAL_JOB);
      await runIncremental(target);
    },
    summarizeMeeting: async (meetingId, opts) => {
      const meeting = await storage.getMeeting(meetingId);
      if (!meeting) return { status: 'not_found', message: `meeting ${meetingId} not found` };
      const decision = loadGuard.check(MEETING_SUMMARIZER_JOB, { allowForced: false });
      if (!decision.proceed) {
        if (opts?.force || meeting.summary_status === 'failed' || meeting.summary_status === 'skipped_short') {
          await storage.setMeetingSummary(meetingId, { status: 'pending', failureReason: null });
        }
        return {
          status: 'deferred',
          message: `meeting summarization deferred: ${describeLoadGuardDecision(decision, config)}`,
        };
      }
      // `force` clears the existing summary so the next summarizer
      // tick treats it as pending again. We don't run the summarizer
      // synchronously here so an MCP client doesn't time out behind a
      // slow LLM call — instead we mark it pending and the scheduler
      // beat picks it up almost immediately.
      if (opts?.force || meeting.summary_status === 'failed' || meeting.summary_status === 'skipped_short') {
        await storage.setMeetingSummary(meetingId, { status: 'pending', failureReason: null });
      }
      try {
        const r = await meetingSummarizer.tick();
        if (r.failed > 0 && r.succeeded === 0) {
          return { status: 'failed', message: `${r.failed} summarisation(s) failed this tick` };
        }
        return { status: 'ok', message: `attempted=${r.attempted} succeeded=${r.succeeded} failed=${r.failed}` };
      } catch (err) {
        return { status: 'failed', message: String(err) };
      }
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
    deleteAudioAfterTranscribe: config.capture.audio.delete_audio_after_transcribe,
    maxAudioBytes: config.capture.audio.max_audio_bytes,
    minAudioBytesPerSec: config.capture.audio.min_audio_bytes_per_sec,
    minAudioRateCheckMs: config.capture.audio.min_audio_rate_check_ms,
  });
  const entityResolver = new EntityResolverWorker(storage, logger, ENTITY_RESOLVER_BATCH_SIZE);
  const sessionsCfg = config.index.sessions;
  const sessionBuilder = new SessionBuilder(storage, logger, {
    idleThresholdMs: sessionsCfg.idle_threshold_sec * 1000,
    minActiveMs: sessionsCfg.min_active_ms,
    fallbackFrameAttentionMs: sessionsCfg.fallback_frame_attention_ms,
    batchSize: SESSION_BUILDER_BATCH_SIZE,
  });
  const meetingsCfg = config.index.meetings;
  const meetingBuilder = new MeetingBuilder(storage, logger, {
    meetingIdleMs: meetingsCfg.idle_threshold_sec * 1000,
    minDurationMs: meetingsCfg.min_duration_sec * 1000,
    audioGraceMs: meetingsCfg.audio_grace_sec * 1000,
  });
  const meetingSummarizer = new MeetingSummarizer(storage, model, logger, {
    dataDir,
    enabled: meetingsCfg.summarize,
    cooldownMs: meetingsCfg.summarize_cooldown_sec * 1000,
    visionAttachments: meetingsCfg.vision_attachments,
  });
  // Event extractor uses the configured `index.events` block (typed
  // via Zod with sane defaults, so it's always populated even on a
  // bare config).
  const eventsCfg = (config.index as unknown as { events: {
    llm_enabled: boolean;
    lookback_days: number;
    min_text_chars: number;
    max_frames_per_bucket: number;
  } }).events;
  const eventExtractor = new EventExtractor(storage, model, logger, {
    dataDir,
    lookbackDays: eventsCfg.lookback_days,
    minTextChars: eventsCfg.min_text_chars,
    maxFramesPerBucket: eventsCfg.max_frames_per_bucket,
    llmEnabled: eventsCfg.llm_enabled,
  });
  const embeddingsCfg = config.index.embeddings;
  const embeddingWorker = new EmbeddingWorker(storage, model, logger, {
    enabled: embeddingsCfg.enabled,
    batchSize: embeddingsCfg.batch_size,
    modelName: getEmbeddingModelName(config),
    strategy,
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

  // Build the coalescer here so it's available on `handles` even
  // before the bus has any subscribers — `scheduleAll()` calls
  // `start()` to actually wire it up to events.
  const activityCoalescer = new ActivityCoalescer(
    bus,
    logger.child('activity-coalescer'),
    async () => {
      // The full coalescer chain — including frame/entity/session/meeting
      // builders — must be skipped while a maintenance job (full
      // reindex / reorganise) is running. Previously only the LLM
      // embedding step was gated; the lighter builders kept ticking
      // and clobbered the very tables the maintenance job was
      // rebuilding (clearAllSessions + sessionBuilder.drain races
      // with sessionBuilder.tick from a freshly captured frame).
      // Unconditional gate at the top of the chain is the simplest
      // correct fix — the coalescer fires again after the lock
      // releases.
      if (await hasActiveIndexMaintenanceLock(loaded.dataDir)) return;
      await frameBuilder.tick();
      await entityResolver.tick();
      await sessionBuilder.tick();
      await meetingBuilder.tick();
      if (config.system.background_model_jobs !== 'scheduled') return;
      // Embedding worker runs the LLM; gate it the same way
      // `scheduleAll` does (load guard + index-maintenance lock) so
      // the coalescer never fights the user during heavy work.
      const decision = loadGuard.check(EMBEDDING_WORKER_JOB, { allowForced: false });
      if (!decision.proceed) {
        logGuardSkip(logger, EMBEDDING_WORKER_JOB, decision, config);
        return;
      }
      if (await hasActiveIndexMaintenanceLock(loaded.dataDir)) return;
      await embeddingWorker.tick();
    },
  );

  const idlePowerCatchup = new IdlePowerCatchup(
    bus,
    logger.child(IDLE_POWER_CATCHUP_JOB),
    config.index.idle_trigger_min * 60_000,
    async () => {
      if (!handlesRef) return;
      await runIdlePowerCatchup(handlesRef);
    },
  );

  const handles: OrchestratorHandles = {
    capture,
    storage,
    model,
    indexerModel,
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
    meetingBuilder,
    meetingSummarizer,
    eventExtractor,
    embeddingWorker,
    vacuum,
    loadGuard,
    activityCoalescer,
    idlePowerCatchup,
  };
  handlesRef = handles;
  return handles;
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
  const { storage, strategy, model, indexerModel, exports, logger, config, audioTranscriptWorker, frameBuilder, entityResolver, sessionBuilder, meetingBuilder, eventExtractor, embeddingWorker } = handles;
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
    const mbResult = await meetingBuilder.drain();
    if (mbResult.meetingsCreated + mbResult.meetingsExtended > 0) {
      log.info(
        `materialised ${mbResult.meetingsCreated} new + ${mbResult.meetingsExtended} extended meeting(s) ` +
          `(${mbResult.audioFramesAttached} audio chunks, ${mbResult.turnsBuilt} transcript turns)`,
      );
    }
    // Lift meetings → DayEvents (deterministic; runs even with the LLM off).
    try {
      const evResult = await eventExtractor.tick();
      if (evResult.meetingsLifted + evResult.llmExtracted > 0) {
        log.info(
          `materialised ${evResult.meetingsLifted} meeting + ${evResult.llmExtracted} extracted day event(s) ` +
            `across ${evResult.daysScanned} day(s)`,
        );
      }
    } catch (err) {
      log.warn('event extractor failed (continuing)', { err: String(err) });
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
    const update = await strategy.indexBatch(events, state, indexerModel);
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

  await indexerModel.unload?.().catch((err: unknown) => {
    log.debug('model unload after incremental indexing failed', { err: String(err) });
  });

  if (totalCreated + totalUpdated > 0) {
    try {
      const embResult = await embeddingWorker.tick();
      if (embResult.processed > 0) {
        log.info(`refreshed semantic memory after indexing (${embResult.processed} embedding(s))`);
      }
    } catch (err) {
      log.warn('post-index memory embedding refresh failed (continuing)', {
        err: String(err),
      });
    }
  }

  return {
    eventsProcessed: totalEvents,
    pagesCreated: totalCreated,
    pagesUpdated: totalUpdated,
  };
}

export async function runReorganisation(handles: OrchestratorHandles): Promise<void> {
  const { strategy, indexerModel, exports, logger } = handles;
  const log = logger.child('index-reorg');
  await startPassiveExports(exports, log);
  const state = await strategy.getState();
  const update = await strategy.reorganise(state, indexerModel);
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
  await indexerModel.unload?.().catch((err: unknown) => {
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
  const { capture, storage, strategy, model, indexerModel, exports, logger, config, audioTranscriptWorker, frameBuilder, entityResolver, sessionBuilder, meetingBuilder, eventExtractor, embeddingWorker } = handles;
  const log = logger.child('full-reindex');
  const range = [
    opts.from ? `from=${opts.from}` : null,
    opts.to ? `to=${opts.to}` : null,
  ].filter(Boolean).join(', ');
  const t0 = Date.now();
  // Self-measurement: capture process resource usage at start so we
  // can report deltas at end. Helps the user see "this reindex cost
  // 14m wall, 5m CPU, peak 480MB RSS, +X MB on disk". `cpuUsage()`
  // returns microseconds; `memoryUsage().rss` is in bytes.
  const cpu0 = process.cpuUsage();
  let peakRssBytes = process.memoryUsage().rss;
  const rssSampler = setInterval(() => {
    const r = process.memoryUsage().rss;
    if (r > peakRssBytes) peakRssBytes = r;
  }, 2000);
  rssSampler.unref?.();
  log.info(
    `full re-index starting (strategy=${strategy.name}${range ? `, ${range}` : ''})`,
  );

  // Hold ollama models in VRAM for the duration of the reindex. Without
  // this override, the default `keep_alive` (30s in our config) drops
  // the chat/indexer model between batches; on a multi-GB Gemma model
  // every reload costs several seconds of pure latency. Restored in
  // `finally` so live chat reverts to the snappy default.
  // Duck-typed: only ollama-backed adapters expose `setKeepAlive`.
  const keepAliveOverride = '30m';
  applyKeepAliveOverride(model, keepAliveOverride);
  if (indexerModel !== model) applyKeepAliveOverride(indexerModel, keepAliveOverride);

  // Pause capture for the duration of the reindex. The native binary
  // keeps writing screenshots + events.jsonl into raw/ otherwise, which
  // (a) burns CPU we'd rather give to ollama, and (b) lets the desktop
  // runtime's ActivityCoalescer race with our drains. Track the
  // pre-reindex running state so we don't accidentally start capture in
  // contexts that had it stopped (e.g. CLI one-shots).
  const captureWasRunning = capture.getStatus?.()?.running === true;
  if (captureWasRunning) {
    try {
      await capture.stop();
      log.info('capture paused for reindex');
    } catch (err) {
      log.warn('failed to pause capture; reindex will continue', { err: String(err) });
    }
  }

  try {
    await strategy.reset();
    await storage.clearIndexCheckpoint(strategy.name);

    // Phase 1: ingest. Audio (file-backed inbox) is independent of the
    // frame-derivatives reset (raw-event-backed); run them in parallel.
    const [audio] = await Promise.all([
      audioTranscriptWorker.drain(),
      storage.resetFrameDerivatives(opts),
    ]);
    if (audio.processed > 0) {
      log.info(`ingested ${audio.processed} audio transcript(s) before full re-index`);
    }
    const fb = await frameBuilder.drain();
    if (fb.framesCreated > 0) {
      log.info(`rebuilt ${fb.framesCreated} frames from raw events`);
    }

    // Phase 2: entity assignment. Frames must exist before resolution.
    const er = await entityResolver.drain();
    if (er.resolved > 0) {
      log.info(`resolved ${er.resolved} frames to entities`);
    }
    // Recompute entity counts from the freshly resolved frames so any
    // resolver-rule changes take effect for all of history, not just new data.
    await storage.rebuildEntityCounts();

    // Phase 3: derived tables. Sessions, meetings, and embeddings are
    // independent now that frames+entities are rebuilt. They share the
    // SQLite write lock (better-sqlite3 serialises commits), but they
    // hit different model surfaces (embeddings → embedding model;
    // sessions+meetings → CPU/DB only) and overlapping their DB phases
    // shaves wall time.
    await Promise.all([
      storage.clearAllSessions(),
      storage.clearAllMeetings(),
      storage.clearAllDayEvents().catch(() => undefined),
      storage.clearFrameEmbeddings(getEmbeddingModelName(config)),
    ]);
    const [sb, mb, emb] = await Promise.all([
      sessionBuilder.drain(),
      meetingBuilder.drain(),
      embeddingWorker.drain(),
    ]);
    if (sb.framesProcessed > 0) {
      log.info(
        `rebuilt ${sb.sessionsCreated} session(s) from ${sb.framesProcessed} frames`,
      );
    }
    if (mb.framesProcessed > 0) {
      log.info(
        `rebuilt ${mb.meetingsCreated} meeting(s) from ${mb.framesProcessed} frames ` +
          `(${mb.audioFramesAttached} audio chunks, ${mb.turnsBuilt} transcript turns)`,
      );
    }
    if (emb.processed > 0) {
      log.info(`rebuilt ${emb.processed} frame embedding(s)`);
    }
    try {
      const ev = await eventExtractor.tick();
      if (ev.meetingsLifted + ev.llmExtracted > 0) {
        log.info(
          `rebuilt ${ev.meetingsLifted} meeting + ${ev.llmExtracted} extracted day event(s) ` +
            `(${ev.daysScanned} days scanned)`,
        );
      }
    } catch (err) {
      log.warn('event extractor pass during full reindex failed', { err: String(err) });
    }

    // Phase 3 wrote a lot — embedding rebuild + sessions/meetings
    // rebuild produce thousands of inserts and deletes. Force a
    // TRUNCATE checkpoint so the WAL is back to ~0 bytes on disk
    // before the LLM-bound page walk starts, otherwise the WAL stays
    // pinned at tens of MB through the entire run.
    await checkpointWalIfSupported(storage, 'TRUNCATE', log);

    // Embedding model is done; unload only it so we free VRAM before the
    // (heavier) chat/indexer model has to handle summarisation. The chat
    // model stays loaded — that was the costly bug in the old version,
    // which unloaded everything and then paid a multi-GB reload on the
    // very next batch.
    await unloadEmbeddingsOnly(model, log);
    if (indexerModel !== model) await unloadEmbeddingsOnly(indexerModel, log);

    await startPassiveExports(exports, log);

    // KarpathyStrategy captures the storage handle when getUnindexedEvents()
    // is called. Full reindex walks explicit date ranges instead, so bind once
    // up front before calling indexBatch directly.
    await strategy.getUnindexedEvents(storage);

    // Stream the requested raw event range through indexBatch in pages.
    // Use a larger page than live incremental indexing: full reindex runs
    // offline against a bounded query, and small pages repeatedly re-render
    // the same cross-page entities as their source-event set grows.
    const batchSize = Math.max(config.index.batch_size, FULL_REINDEX_EVENT_BATCH_SIZE);
    let offset = 0;
    let totalProcessed = 0;
    let batchIndex = 0;
    let lastHeartbeatAt = Date.now();
    const HEARTBEAT_MS = 30_000;

    while (true) {
      const events = await storage.readEvents({
        from: opts.from,
        to: opts.to,
        limit: batchSize,
        offset,
      });
      if (events.length === 0) break;

      const batchStart = Date.now();
      const state = await strategy.getState();
      const update = await strategy.indexBatch(events, state, indexerModel);
      await strategy.applyUpdate(update);
      for (const exp of exports) {
        for (const p of update.pagesToCreate) await exp.onPageUpdate(p);
        for (const p of update.pagesToUpdate) await exp.onPageUpdate(p);
        for (const d of update.pagesToDelete) await exp.onPageDelete(d);
      }
      await storage.markIndexed(strategy.name, events.map((e) => e.id));

      totalProcessed += events.length;
      offset += events.length;
      batchIndex += 1;

      // Heartbeat so a stuck reindex is distinguishable from a slow one.
      // Always print the first batch (so the user sees the pipeline did
      // move past phase 3), then again on a 30s cadence.
      const now = Date.now();
      if (batchIndex === 1 || now - lastHeartbeatAt >= HEARTBEAT_MS) {
        const elapsedSec = Math.round((now - t0) / 1000);
        const lastBatchSec = ((now - batchStart) / 1000).toFixed(1);
        log.info(
          `reindex progress: batch=${batchIndex} events=${totalProcessed} ` +
            `last_batch=${lastBatchSec}s elapsed=${elapsedSec}s`,
        );
        lastHeartbeatAt = now;
      }

      if (events.length < batchSize) break;
    }

    const finalState = await strategy.getState();
    for (const exp of exports) {
      if (exp.name === 'mcp') continue;
      await exp.fullSync(finalState, strategy);
    }

    await indexerModel.unload?.().catch((err: unknown) => {
      log.debug('model unload after full re-index failed', { err: String(err) });
    });

    // Final WAL truncate + best-effort VACUUM. The page walk
    // accumulates writes again (markIndexed + applyUpdate); without
    // a TRUNCATE the WAL ends the run at 30+ MB and the DB file
    // holds pages freed by the embeddings/sessions/meetings clears
    // earlier. VACUUM rewrites the file once — typically reclaims
    // 30–40% on a freshly-reindexed DB.
    //
    // Note the order: TRUNCATE → VACUUM → TRUNCATE. VACUUM itself
    // rewrites the entire DB into the WAL before atomically swapping
    // it back, so the WAL temporarily balloons during the run. A
    // post-VACUUM checkpoint shrinks it back to ~0 bytes on disk.
    // Skipping that second TRUNCATE leaves the WAL bigger than the
    // DB itself when the run ends — exactly the failure we hit
    // pre-fix in run #4 (122 MB WAL alongside a 121 MB DB).
    //
    // Best-effort: if VACUUM fails (e.g. the disk is tight), the
    // run is still successful.
    await checkpointWalIfSupported(storage, 'TRUNCATE', log);
    await vacuumDbIfSupported(storage, log);
    await checkpointWalIfSupported(storage, 'TRUNCATE', log);

    const totalSec = Math.round((Date.now() - t0) / 1000);
    // Self-measurement summary. CPU% is "how saturated was 1 core for
    // the runtime's lifetime"; on a single-threaded Node process this
    // peaks at 100%. Above that means we did real parallel work via
    // libuv workers (sharp, sqlite, fs). RSS shows the peak memory
    // the indexer process needed.
    clearInterval(rssSampler);
    const cpuTotal = process.cpuUsage(cpu0);
    const cpuMs = (cpuTotal.user + cpuTotal.system) / 1000;
    const wallMs = Date.now() - t0;
    const cpuPct = wallMs > 0 ? Math.round((cpuMs / wallMs) * 100) : 0;
    const rssMb = Math.round(peakRssBytes / 1024 / 1024);
    log.info(
      `full re-index complete — ${totalProcessed} events processed in ${totalSec}s ` +
        `(cpu=${Math.round(cpuMs / 1000)}s ~${cpuPct}% of one core, peak_rss=${rssMb} MB)`,
    );
  } finally {
    // Restore keep_alive so live chat/recall don't pin the model in VRAM
    // for 30 minutes after the reindex finishes.
    resetKeepAliveIfSupported(model);
    if (indexerModel !== model) resetKeepAliveIfSupported(indexerModel);

    // Resume capture if we paused it. Best-effort: a failure here is
    // logged but doesn't unwind the (already-completed) reindex.
    if (captureWasRunning) {
      try {
        await capture.start();
        log.info('capture resumed');
      } catch (err) {
        log.warn('failed to resume capture after reindex', { err: String(err) });
      }
    }
  }
}

/**
 * Duck-typed override hook — only the ollama adapter exposes
 * `setKeepAlive`. Other adapters (offline fallback, openai) silently no-op.
 */
function applyKeepAliveOverride(
  adapter: IModelAdapter,
  value: string | number,
): void {
  const fn = (adapter as { setKeepAlive?: (v: string | number) => void }).setKeepAlive;
  if (typeof fn === 'function') fn.call(adapter, value);
}

function resetKeepAliveIfSupported(adapter: IModelAdapter): void {
  const fn = (adapter as { resetKeepAlive?: () => void }).resetKeepAlive;
  if (typeof fn === 'function') fn.call(adapter);
}

/**
 * Force a SQLite WAL checkpoint via the optional `IStorage.checkpointWal`.
 * Storage backends without WAL (or non-SQLite) don't expose the method
 * and silently no-op. Used between full-reindex phases so the WAL
 * doesn't stay pinned at tens of MB across an LLM-bound run.
 */
async function checkpointWalIfSupported(
  storage: IStorage,
  mode: 'PASSIVE' | 'TRUNCATE',
  log: Logger,
): Promise<void> {
  const fn = (storage as { checkpointWal?: (m?: 'PASSIVE' | 'TRUNCATE') => Promise<void> })
    .checkpointWal;
  if (typeof fn !== 'function') return;
  try {
    await fn.call(storage, mode);
  } catch (err) {
    log.debug(`checkpointWal(${mode}) failed`, { err: String(err) });
  }
}

/**
 * Best-effort `runMaintenance()` invocation at the end of a full
 * reindex. Runs ANALYZE + VACUUM (and the integrity_check). VACUUM
 * rewrites the DB file once — typical reclaim is 30–40% after a
 * full reindex deleted/replaced sessions, meetings, and embeddings.
 * Failures are logged and swallowed so a tight-disk situation
 * doesn't unwind a successful reindex.
 */
async function vacuumDbIfSupported(storage: IStorage, log: Logger): Promise<void> {
  if (typeof storage.runMaintenance !== 'function') return;
  try {
    const start = Date.now();
    const result = await storage.runMaintenance();
    log.info(
      `post-reindex maintenance: vacuumed=${result.vacuumed} ` +
        `analyzed=${result.analyzed} (${Date.now() - start}ms)`,
    );
  } catch (err) {
    log.warn('post-reindex maintenance failed (non-fatal)', { err: String(err) });
  }
}

/**
 * Drop just the embedding model from VRAM. Adapters that don't expose
 * a separate handle (e.g. OpenAI) no-op — they don't manage local
 * memory anyway.
 */
async function unloadEmbeddingsOnly(adapter: IModelAdapter, log: Logger): Promise<void> {
  const fn = (adapter as { unloadEmbeddings?: () => Promise<void> }).unloadEmbeddings;
  if (typeof fn !== 'function') return;
  try {
    await fn.call(adapter);
  } catch (err) {
    log.debug('embedding-only unload failed', { err: String(err) });
  }
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

export function describeLoadGuardDecision(
  decision: LoadGuardDecision,
  config: CofounderOSConfig,
): string {
  const load = decision.snapshot.normalised;
  const loadText = load == null ? 'unknown' : load.toFixed(2);
  const memoryPct = Math.round(decision.snapshot.memory.usedRatio * 100);
  const memoryThresholdPct = Math.round(config.system.load_guard.memory_threshold * 100);
  const battery = decision.snapshot.power.batteryPercent;
  switch (decision.reason) {
    case 'on-battery-low':
      return `battery is ${battery ?? 'unknown'}% while unplugged (threshold ${config.system.load_guard.low_battery_threshold_pct}%)`;
    case 'on-battery':
      return 'computer is on battery; waiting for wall power';
    case 'memory-pressure':
      return `memory pressure is ${memoryPct}% (threshold ${memoryThresholdPct}%)`;
    case 'over-threshold':
      return `CPU load is ${loadText} (threshold ${config.system.load_guard.threshold})`;
    case 'unsupported-platform':
      return 'platform does not expose load average';
    default:
      return decision.reason;
  }
}

function logGuardSkip(
  logger: Logger,
  jobName: string,
  decision: LoadGuardDecision,
  config: CofounderOSConfig,
): void {
  logger.child(jobName).debug(`skipped — ${describeLoadGuardDecision(decision, config)}`, {
    reason: decision.reason,
    load: decision.snapshot.normalised,
    memory_used_ratio: decision.snapshot.memory.usedRatio,
    power_source: decision.snapshot.power.source,
    battery_percent: decision.snapshot.power.batteryPercent,
  });
}

export function assertHeavyWorkAllowed(handles: OrchestratorHandles, jobName: string): void {
  const decision = handles.loadGuard.check(jobName, { allowForced: false });
  if (decision.proceed) return;
  throw new Error(`Heavy processing deferred: ${describeLoadGuardDecision(decision, handles.config)}`);
}

async function runIdlePowerCatchup(handles: OrchestratorHandles): Promise<void> {
  const { scheduler, logger, loadGuard, config } = handles;
  const decision = loadGuard.check(IDLE_POWER_CATCHUP_JOB, {
    requireAcPower: true,
    allowForced: false,
  });
  if (!decision.proceed) {
    logGuardSkip(logger, IDLE_POWER_CATCHUP_JOB, decision, config);
    return;
  }
  if (await hasActiveIndexMaintenanceLock(handles.loaded.dataDir)) {
    logger.child(IDLE_POWER_CATCHUP_JOB).debug('skipped — index maintenance lock active');
    return;
  }

  logger.child(IDLE_POWER_CATCHUP_JOB).info(
    'idle on power; running deferred capture processing',
  );
  const runJob = async (name: string): Promise<void> => {
    if (!scheduler.has(name)) return;
    await scheduler.runNow(name);
  };

  await runJob(AUDIO_TRANSCRIPT_JOB);
  await runJob(FRAME_BUILDER_JOB);
  await runJob(OCR_WORKER_JOB);
  await runJob(ENTITY_RESOLVER_JOB);
  await runJob(SESSION_BUILDER_JOB);
  await runJob(MEETING_BUILDER_JOB);

  if (config.index.reorganise_on_idle) {
    await runJob(INCREMENTAL_JOB);
  } else {
    await runJob(EMBEDDING_WORKER_JOB);
  }
  await runJob(MEETING_SUMMARIZER_JOB);
  await runJob(EVENT_EXTRACTOR_JOB);
}

export function scheduleAll(handles: OrchestratorHandles): void {
  const { scheduler, config, storage, bus, frameBuilder, ocrWorker, audioTranscriptWorker, entityResolver, sessionBuilder, meetingBuilder, meetingSummarizer, eventExtractor, embeddingWorker, vacuum, logger, loadGuard, activityCoalescer, idlePowerCatchup } =
    handles;
  const backgroundModelJobsScheduled = config.system.background_model_jobs === 'scheduled';

  // Wrap heavier jobs so they skip when the machine is busy. Cheap jobs
  // (frame builder, entity resolver, session builder, meeting builder) are intentionally
  // not gated — they're small and keep the captured substrate fresh.
  const guarded = (jobName: string, run: () => Promise<unknown>) => async () => {
    const decision = loadGuard.check(jobName, { allowForced: false });
    if (!decision.proceed) {
      logGuardSkip(logger, jobName, decision, config);
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
  const modelJob = (
    jobName: string,
    run: () => Promise<unknown>,
  ) => async (ctx?: { trigger: 'schedule' | 'manual' }) => {
    if ((ctx?.trigger ?? 'schedule') === 'schedule' && !backgroundModelJobsScheduled) {
      logger.child(jobName).debug(
        'skipped — system.background_model_jobs is manual',
      );
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
  // Tesseract is the heaviest non-LLM job in the system (1-3s of CPU
  // per frame on Apple Silicon), so it's gated by the load guard —
  // when the user's machine is already under load we skip the tick and
  // catch up later. The frame builder + entity resolver intentionally
  // are NOT gated; they're tiny and keep search results fresh.
  // Adaptive cadence state. `ocrEmptyStreak` counts consecutive ticks
  // where `ocrWorker.tick()` returned no work; once we cross the
  // back-off threshold we retune the scheduler to the slow cadence.
  // A new `screenshot` bus event resets us to the fast cadence.
  let ocrEmptyStreak = 0;
  let ocrIntervalIsSlow = false;
  const setOcrSlow = (slow: boolean): void => {
    if (slow === ocrIntervalIsSlow) return;
    const next = slow ? OCR_WORKER_IDLE_INTERVAL_MS : OCR_WORKER_INTERVAL_MS;
    if (scheduler.setIntervalMs(OCR_WORKER_JOB, next)) {
      ocrIntervalIsSlow = slow;
      logger.child(OCR_WORKER_JOB).debug(
        slow
          ? `idle: backed off to ${Math.round(next / 60_000)}m cadence after ${OCR_WORKER_EMPTY_STREAK_TO_BACKOFF} empty ticks`
          : `activity resumed: restored ${Math.round(next / 1000)}s cadence`,
      );
    }
  };
  // Reset to the fast cadence the moment a new screenshot lands. Other
  // event types (focus, url_change, audio_transcript) don't directly
  // produce OCR work — only screenshots do — so we filter to keep the
  // listener cheap.
  bus.on((event) => {
    if (event.type !== 'screenshot') return;
    if (ocrEmptyStreak !== 0 || ocrIntervalIsSlow) {
      ocrEmptyStreak = 0;
      setOcrSlow(false);
    }
  });
  scheduler.every(OCR_WORKER_JOB, OCR_WORKER_INTERVAL_MS, skipDuringIndexMaintenance(OCR_WORKER_JOB, guarded(OCR_WORKER_JOB, async () => {
    try {
      const result = await ocrWorker.tick();
      const didWork = (result.processed + result.failed) > 0;
      if (didWork) {
        ocrEmptyStreak = 0;
        setOcrSlow(false);
      } else {
        ocrEmptyStreak += 1;
        if (ocrEmptyStreak >= OCR_WORKER_EMPTY_STREAK_TO_BACKOFF) {
          setOcrSlow(true);
        }
      }
    } catch (err) {
      logger.child('ocr-worker').warn('tick failed', { err: String(err) });
    }
  })));
  scheduler.every(
    AUDIO_TRANSCRIPT_JOB,
    Math.max(15_000, config.capture.audio.tick_interval_sec * 1000),
    skipDuringIndexMaintenance(AUDIO_TRANSCRIPT_JOB, guarded(AUDIO_TRANSCRIPT_JOB, async () => {
      try {
        await audioTranscriptWorker.tick();
      } catch (err) {
        logger.child('audio-transcript-worker').warn('tick failed', { err: String(err) });
      }
    })),
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
  // catches up. A 10-minute cadence is only a backstop because the
  // activity coalescer keeps active sessions fresh after capture bursts.
  scheduler.every(SESSION_BUILDER_JOB, SESSION_BUILDER_INTERVAL_MS, skipDuringIndexMaintenance(SESSION_BUILDER_JOB, async () => {
    try {
      await sessionBuilder.tick();
    } catch (err) {
      logger.child('session-builder').warn('tick failed', { err: String(err) });
    }
  }));
  // Meeting builder: runs after the entity resolver so meeting frames
  // already have their entity_path populated. A 1-minute cadence keeps
  // open meetings extending live while the call is happening.
  scheduler.every(MEETING_BUILDER_JOB, MEETING_BUILDER_INTERVAL_MS, skipDuringIndexMaintenance(MEETING_BUILDER_JOB, async () => {
    try {
      await meetingBuilder.tick();
    } catch (err) {
      logger.child('meeting-builder').warn('tick failed', { err: String(err) });
    }
  }));
  // Meeting summarizer: runs every 5 min and gates on the load guard
  // so it never fights the user during active work. Stage A is
  // deterministic; the LLM stage is controlled by index.meetings.summarize.
  scheduler.every(
    MEETING_SUMMARIZER_JOB,
    MEETING_SUMMARIZER_INTERVAL_MS,
    skipDuringIndexMaintenance(MEETING_SUMMARIZER_JOB, guarded(MEETING_SUMMARIZER_JOB, async () => {
      try {
        await meetingSummarizer.tick();
      } catch (err) {
        logger.child('meeting-summarizer').warn('tick failed', { err: String(err) });
      }
    })),
  );
  // Event extractor: lifts every captured meeting into a DayEvent
  // (deterministic, always runs) and -- when the model is online --
  // OCR-extracts calendar entries / Slack threads / mail items into
  // the same timeline. The deterministic side is cheap so we don't gate
  // it behind the load guard / manual-model setting; only the LLM side
  // (inside `eventExtractor.tick()`) skips when the model isn't ready.
  scheduler.every(
    EVENT_EXTRACTOR_JOB,
    EVENT_EXTRACTOR_INTERVAL_MS,
    skipDuringIndexMaintenance(EVENT_EXTRACTOR_JOB, async () => {
      try {
        await eventExtractor.tick();
      } catch (err) {
        logger.child('event-extractor').warn('tick failed', { err: String(err) });
      }
    }),
  );
  scheduler.every(
    EMBEDDING_WORKER_JOB,
    Math.max(60_000, config.index.embeddings.tick_interval_min * 60_000),
    modelJob(EMBEDDING_WORKER_JOB, skipDuringIndexMaintenance(EMBEDDING_WORKER_JOB, guarded(EMBEDDING_WORKER_JOB, async () => {
      try {
        await embeddingWorker.tick();
      } catch (err) {
        logger.child('embedding-worker').warn('tick failed', { err: String(err) });
      }
    }))),
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
    STORAGE_MAINTENANCE_JOB,
    STORAGE_MAINTENANCE_INTERVAL_MS,
    skipDuringIndexMaintenance(STORAGE_MAINTENANCE_JOB, async () => {
      // Stricter than the default `guarded` wrapper: VACUUM rewrites
      // the entire DB file and we don't want to spin disks on battery.
      const decision = loadGuard.check(STORAGE_MAINTENANCE_JOB, {
        requireAcPower: true,
        allowForced: false,
      });
      if (!decision.proceed) {
        logGuardSkip(logger, STORAGE_MAINTENANCE_JOB, decision, config);
        return;
      }
      try {
        await storage.runMaintenance();
      } catch (err) {
        logger.child(STORAGE_MAINTENANCE_JOB).warn('tick failed', {
          err: String(err),
        });
      }
    }),
  );
  // Honor config.storage.local.retention_days. 0 means "keep forever"
  // -- the storage method is a no-op in that case, but skipping the
  // schedule entirely avoids waking the timer.
  const retentionDays = config.storage.local.retention_days;
  if (retentionDays > 0) {
    scheduler.every(
      STORAGE_RETENTION_JOB,
      STORAGE_RETENTION_INTERVAL_MS,
      skipDuringIndexMaintenance(STORAGE_RETENTION_JOB, async () => {
        // Mass deletes can churn many MB of WAL; gate on AC power so
        // we don't drain a laptop battery on housekeeping work.
        const decision = loadGuard.check(STORAGE_RETENTION_JOB, {
          requireAcPower: true,
          allowForced: false,
        });
        if (!decision.proceed) {
          logGuardSkip(logger, STORAGE_RETENTION_JOB, decision, config);
          return;
        }
        try {
          const result = await storage.deleteOldData(retentionDays);
          if (
            result.frames > 0 ||
            result.events > 0 ||
            result.sessions > 0 ||
            result.meetings > 0 ||
            result.entities > 0
          ) {
            logger.child(STORAGE_RETENTION_JOB).info(
              `retention swept ${result.frames} frames, ${result.events} events, ` +
                `${result.sessions} sessions, ${result.meetings} meetings, ` +
                `${result.entities} entities (cutoff ${retentionDays}d)`,
            );
          }
        } catch (err) {
          logger.child(STORAGE_RETENTION_JOB).warn('tick failed', {
            err: String(err),
          });
        }
      }),
    );
  }
  scheduler.every(
    INCREMENTAL_JOB,
    config.index.incremental_interval_min * 60 * 1000,
    modelJob(
      INCREMENTAL_JOB,
      skipDuringIndexMaintenance(
        INCREMENTAL_JOB,
        guarded(INCREMENTAL_JOB, () => runIncremental(handles).then(() => undefined)),
      ),
    ),
  );
  scheduler.cron(
    REORG_JOB,
    config.index.reorganise_schedule,
    modelJob(
      REORG_JOB,
      skipDuringIndexMaintenance(REORG_JOB, guarded(REORG_JOB, () => runReorganisation(handles))),
    ),
  );

  // Subscribe after all scheduler jobs are registered. Capture activity
  // drives lightweight freshness via the coalescer; idle_start drives a
  // separate catch-up path that only runs heavy jobs after the user is
  // away and the machine is on wall power.
  activityCoalescer.start();
  idlePowerCatchup.start();
}

export async function startAll(handles: OrchestratorHandles): Promise<void> {
  await handles.capture.start();
  for (const exp of handles.exports) {
    await exp.start();
  }
  scheduleAll(handles);
}

export async function stopAll(handles: OrchestratorHandles): Promise<void> {
  // Tear the coalescer down before the scheduler so a pending debounce
  // can't fire after the workers have been shut down.
  handles.idlePowerCatchup.stop();
  handles.activityCoalescer.stop();
  handles.scheduler.stop();
  for (const exp of handles.exports) {
    await exp.stop();
  }
  await handles.capture.stop();
  await handles.ocrWorker.stop();
  // Call as method (not extracted reference) so `this` is bound — the
  // ollama adapter's `unload` reaches into `this.client` and breaks
  // when invoked as a free function. Same applies to the indexer
  // adapter when it's a separate instance.
  await handles.model.unload?.().catch((err: unknown) => {
    handles.logger.child('model').debug('model unload failed during runtime stop', { err: String(err) });
  });
  if (handles.indexerModel !== handles.model) {
    await handles.indexerModel.unload?.().catch((err: unknown) => {
      handles.logger.child('indexer-model').debug('indexer unload failed during runtime stop', { err: String(err) });
    });
  }
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
 * Reads `index.model.ollama.model_revision` (or the equivalent block for
 * the active model plugin) and compares it against `.model-revision` in
 * the data dir. When the configured revision is greater than the marker,
 * the bootstrap is run with `force: true` so weights get re-pulled even
 * when the tag is already cached locally — that's how we ship the
 * "refresh existing installs" upgrade for floating Ollama tags
 * (e.g. `gemma4:e2b` getting new weights under the same name).
 *
 * Pass `force: true` to bypass the revision marker entirely (used by the
 * `cofounderos model:update` CLI command).
 *
 * Throws if bootstrap fails. The CLI catches this and offers `--offline`.
 */
export async function bootstrapModel(
  handles: OrchestratorHandles,
  onProgress?: ModelBootstrapHandler,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (typeof handles.model.ensureReady !== 'function') return;

  const markerPath = path.join(handles.loaded.dataDir, '.model-revision');
  const configuredRevision = readConfiguredModelRevision(handles.config);
  const markerData = await readModelRevisionMarker(markerPath);
  const modelInfo = handles.model.getModelInfo();

  // Force when the caller explicitly asks for it, when the configured
  // revision moved forward, or when the model identity itself changed
  // (e.g. user edited config.yaml from gemma4:e2b → gemma4:e4b — the
  // new model needs a pull but the cached "ready" check could pass for
  // the old one if both happen to be present).
  const revisionMoved = configuredRevision != null
    && (markerData?.revision == null || markerData.revision < configuredRevision);
  const modelChanged = !!markerData && markerData.model !== modelInfo.name;
  const force = opts.force === true || revisionMoved || modelChanged;

  await handles.model.ensureReady(onProgress, force ? { force: true } : undefined);

  // If the user has configured a separate indexer adapter, make sure
  // its weights are also pulled. We don't track a separate revision
  // marker for it — the primary model's revision bump implicitly
  // covers "you upgraded; refresh everything", and the indexer model
  // is typically a smaller variant of the same family.
  if (
    handles.indexerModel !== handles.model &&
    typeof handles.indexerModel.ensureReady === 'function'
  ) {
    await handles.indexerModel.ensureReady(
      onProgress,
      force ? { force: true } : undefined,
    );
  }

  if (configuredRevision != null) {
    await writeModelRevisionMarker(markerPath, {
      revision: configuredRevision,
      model: modelInfo.name,
      updatedAt: new Date().toISOString(),
    });
  }
}

interface ModelRevisionMarker {
  revision: number;
  model: string;
  updatedAt: string;
}

function readConfiguredModelRevision(config: CofounderOSConfig): number | null {
  // Only the ollama plugin currently exposes a revision; remote plugins
  // (claude / openai) don't manage local weights, so there's nothing to
  // refresh and the marker mechanism is a no-op for them.
  const block = config.index.model.ollama as { model_revision?: unknown } | undefined;
  if (!block) return null;
  const v = block.model_revision;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

async function readModelRevisionMarker(
  markerPath: string,
): Promise<ModelRevisionMarker | null> {
  try {
    const raw = await fsp.readFile(markerPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ModelRevisionMarker>;
    if (
      typeof parsed.revision === 'number' &&
      typeof parsed.model === 'string' &&
      typeof parsed.updatedAt === 'string'
    ) {
      return parsed as ModelRevisionMarker;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeModelRevisionMarker(
  markerPath: string,
  marker: ModelRevisionMarker,
): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(markerPath), { recursive: true });
    await fsp.writeFile(markerPath, JSON.stringify(marker, null, 2));
  } catch {
    // Marker is best-effort. Failing to write it just means the next
    // start may try the force-pull again, which is idempotent (Ollama
    // skips bytes that match its content-addressed store).
  }
}

/** Swap the active model for the offline deterministic adapter. */
export function useOfflineModel(handles: OrchestratorHandles): void {
  const offline = new OfflineFallbackAdapter(handles.logger);
  // Replace BOTH adapters when the user opts into offline mode: the
  // indexer adapter would otherwise still try to reach Ollama for
  // every indexing pass even though the user explicitly asked us to
  // run without an LLM. Sharing one offline instance is intentional
  // (it's stateless) and means a single `unload` covers both.
  handles.model = offline;
  handles.indexerModel = offline;
  handles.embeddingWorker.setModel(offline);
  const exportServices: ExportServices = {
    storage: handles.storage,
    strategy: handles.strategy,
    model: offline,
    embeddingModelName: getEmbeddingModelName(handles.config),
    embeddingSearchWeight: handles.config.index.embeddings.search_weight,
    dataDir: handles.loaded.dataDir,
    triggerReindex: async (_full) => {
      await handles.scheduler.runNow(INCREMENTAL_JOB);
    },
  };
  for (const exp of handles.exports) {
    exp.bindServices?.(exportServices);
  }
  handles.logger.info('using offline deterministic model (no LLM calls).');
}
