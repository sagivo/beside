/**
 * @cofounderos/interfaces
 *
 * Stable contracts shared by every layer of CofounderOS. The core never
 * imports concrete plugins — it talks to plugins exclusively through the
 * interfaces declared here.
 *
 * Implementing any of these interfaces is sufficient to ship a plugin.
 */

// ---------------------------------------------------------------------------
// Layer 1 — Capture
// ---------------------------------------------------------------------------

export type RawEventType =
  | 'screenshot'
  | 'audio_transcript'
  | 'window_focus'
  | 'window_blur'
  | 'url_change'
  | 'click'
  | 'keystroke_summary'
  | 'idle_start'
  | 'idle_end'
  | 'app_launch'
  | 'app_quit'
  | 'clipboard_summary';

export interface RawEvent {
  // Identity
  id: string;
  timestamp: string;            // ISO 8601 with offset
  session_id: string;

  // Classification
  type: RawEventType;
  app: string;
  app_bundle_id: string;
  window_title: string;
  url: string | null;

  // Content
  content: string | null;
  asset_path: string | null;

  // Context
  duration_ms: number | null;
  idle_before_ms: number | null;
  screen_index: number;

  // Metadata
  metadata: Record<string, unknown>;
  privacy_filtered: boolean;
  capture_plugin: string;
}

export interface CaptureStatus {
  running: boolean;
  paused: boolean;
  eventsToday: number;
  storageBytesToday: number;
  cpuPercent: number;
  memoryMB: number;
}

export interface CaptureConfig {
  pluginName: string;
  screenshot_diff_threshold: number;
  idle_threshold_sec: number;
  jpeg_quality: number;
  excluded_apps: string[];
  excluded_url_patterns: string[];
  capture_audio: boolean;
  privacy: {
    blur_password_fields: boolean;
    pause_on_screen_lock: boolean;
    sensitive_keywords: string[];
  };
  // Polling cadence used by event-driven recorders to detect window/url
  // change. NOT a screenshot interval — screenshots are event-driven.
  poll_interval_ms: number;
  // Storage root so the capture agent can write asset files directly
  // without round-tripping every byte through IPC.
  raw_root: string;
}

export type RawEventHandler = (event: RawEvent) => void | Promise<void>;

export interface ICapture {
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  onEvent(handler: RawEventHandler): void;
  getStatus(): CaptureStatus;
  getConfig(): CaptureConfig;
}

// ---------------------------------------------------------------------------
// Layer 2 — Storage
// ---------------------------------------------------------------------------

export interface StorageQuery {
  from?: string;
  to?: string;
  types?: RawEventType[];
  apps?: string[];
  limit?: number;
  offset?: number;
  /** Return all events with id strictly greater than this checkpoint. */
  since_checkpoint?: string;
  /** Free-text search against `content`, `app`, `window_title`. */
  text?: string;
  /** Filter to events not yet indexed by the named strategy. */
  unindexed_for_strategy?: string;
  /** Filter to events not yet materialised into a frame. */
  unframed_only?: boolean;
}

/**
 * A `Frame` is the materialised retrieval unit of CofounderOS — a single
 * "moment" you were looking at, joining a screenshot with its window /
 * URL metadata and (eventually) its OCR'd or accessibility-extracted text.
 *
 * Frames are derived from raw events by the FrameBuilder; they are the
 * primary substrate for search, the daily journal, and the wiki indexer.
 * Raw events remain the immutable source of truth — frames can always be
 * rebuilt by replaying events.
 */
export interface Frame {
  id: string;
  timestamp: string;
  day: string;
  monitor: number;
  app: string;
  app_bundle_id: string;
  window_title: string;
  url: string | null;
  /** OCR'd or accessibility-extracted text. Null until a worker fills it. */
  text: string | null;
  text_source: 'ocr' | 'accessibility' | 'none' | null;
  asset_path: string | null;
  perceptual_hash: string | null;
  trigger: string | null;
  session_id: string;
  /** Focused duration this frame represents, if known from a paired blur. */
  duration_ms: number | null;
  /** Raw event ids that contributed to this frame. */
  source_event_ids: string[];
}

export interface FrameQuery {
  /** FTS5 query against `text`, `app`, `window_title`, `url`. */
  text?: string;
  from?: string;
  to?: string;
  apps?: string[];
  limit?: number;
  offset?: number;
}

/** Lightweight projection used by the OCR worker. */
export interface FrameOcrTask {
  id: string;
  asset_path: string;
}

export interface StorageStats {
  totalEvents: number;
  totalAssetBytes: number;
  oldestEvent: string | null;
  newestEvent: string | null;
  eventsByType: Record<string, number>;
  eventsByApp: Record<string, number>;
}

export interface IStorage {
  init(): Promise<void>;
  write(event: RawEvent): Promise<void>;
  writeAsset(assetPath: string, data: Buffer): Promise<void>;
  readEvents(query: StorageQuery): Promise<RawEvent[]>;
  readAsset(assetPath: string): Promise<Buffer>;
  listDays(): Promise<string[]>;
  getStats(): Promise<StorageStats>;
  isAvailable(): Promise<boolean>;

  /**
   * Mark events as indexed by the given strategy so subsequent
   * incremental passes skip them.
   */
  markIndexed(strategy: string, eventIds: string[]): Promise<void>;

  /** Reset the indexed marker for a strategy (used by --full-reindex). */
  clearIndexCheckpoint(strategy: string): Promise<void>;

  /** Last indexed event id for a strategy, or null if none yet. */
  getIndexCheckpoint(strategy: string): Promise<string | null>;

  /** Storage root on disk (when applicable). */
  getRoot(): string;

  // -------------------------------------------------------------------------
  // Frames — derived retrieval substrate (PR 2 / PR 3 / PR 4)
  //
  // Implementations that don't materialise frames may throw `not_implemented`
  // from these methods; the orchestrator gracefully degrades to event-only
  // search in that case.
  // -------------------------------------------------------------------------

  /** Insert or replace a frame row + its FTS entry. */
  upsertFrame(frame: Frame): Promise<void>;

  /**
   * Search frames. When `query.text` is set, ranks via FTS5 BM25.
   * Otherwise returns frames in reverse chronological order, newest first.
   */
  searchFrames(query: FrameQuery): Promise<Frame[]>;

  /** Get the chronological neighbourhood around a single frame. */
  getFrameContext(
    frameId: string,
    before: number,
    after: number,
  ): Promise<{ anchor: Frame; before: Frame[]; after: Frame[] } | null>;

  /** All frames captured on a given day (YYYY-MM-DD), oldest first. */
  getJournal(day: string): Promise<Frame[]>;

  /** Raw events that haven't been turned into a frame yet. */
  listFramesNeedingOcr(limit: number): Promise<FrameOcrTask[]>;

  /** Update a frame's text after OCR / a11y extraction. */
  setFrameText(
    frameId: string,
    text: string,
    source: 'ocr' | 'accessibility',
  ): Promise<void>;

  /** Mark raw events as having been folded into a frame. */
  markFramed(eventIds: string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Layer 3 — Index
// ---------------------------------------------------------------------------

export interface ModelInfo {
  name: string;
  contextWindowTokens: number;
  isLocal: boolean;
  supportsVision: boolean;
  costPerMillionTokens: number;
}

export interface CompletionOptions {
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'text' | 'json';
  systemPrompt?: string;
}

/**
 * Lifecycle event emitted while a model adapter installs its runtime,
 * starts its daemon, or downloads a model. CLI / UI surfaces translate
 * these into a progress bar.
 */
export type ModelBootstrapProgress =
  | { kind: 'check'; message: string }
  | { kind: 'install_started'; tool: string; message?: string }
  | { kind: 'install_log'; line: string; progress?: boolean }
  | { kind: 'install_done'; tool: string }
  | { kind: 'install_failed'; tool: string; reason: string }
  | { kind: 'server_starting'; host: string }
  | { kind: 'server_ready'; host: string }
  | { kind: 'server_failed'; host: string; reason: string }
  | { kind: 'pull_started'; model: string; sizeHint?: string }
  | {
      kind: 'pull_progress';
      model: string;
      status: string;
      completed: number;
      total: number;
    }
  | { kind: 'pull_done'; model: string }
  | { kind: 'pull_failed'; model: string; reason: string }
  | { kind: 'ready'; model: string };

export type ModelBootstrapHandler = (event: ModelBootstrapProgress) => void;

export interface IModelAdapter {
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
  completeWithVision(
    prompt: string,
    images: Buffer[],
    options?: CompletionOptions,
  ): Promise<string>;
  isAvailable(): Promise<boolean>;
  getModelInfo(): ModelInfo;

  /**
   * Optional first-run bootstrap. Adapters that need to install a runtime
   * (Ollama), start a daemon, or download a model implement this and emit
   * structured progress so the host (CLI / UI) can render a progress bar.
   *
   * Throws if the adapter cannot become ready (e.g. unsupported platform,
   * network failure, user denied permission).
   *
   * Idempotent — safe to call on every startup.
   */
  ensureReady?(onProgress?: ModelBootstrapHandler): Promise<void>;
}

export interface IndexState {
  strategy: string;
  lastIncrementalRun: string | null;
  lastReorganisationRun: string | null;
  pageCount: number;
  eventsCovered: number;
  rootPath: string;
}

export interface IndexPage {
  path: string;
  content: string;
  sourceEventIds: string[];
  backlinks: string[];
  lastUpdated: string;
}

export interface ReorganisationSummary {
  merged: Array<{ from: string[]; into: string }>;
  split: Array<{ from: string; into: string[] }>;
  archived: string[];
  newSummaryPages: string[];
  reclassified: Array<{ page: string; newCategory: string }>;
  notes: string;
}

export interface IndexUpdate {
  pagesToCreate: IndexPage[];
  pagesToUpdate: IndexPage[];
  pagesToDelete: string[];
  newRootIndex: string;
  reorganisationNotes: string;
}

export interface IIndexStrategy {
  readonly name: string;
  readonly description: string;

  init(rootPath: string): Promise<void>;

  /** Returns events not yet indexed under this strategy. */
  getUnindexedEvents(storage: IStorage): Promise<RawEvent[]>;

  /** Incremental pass against a batch of new events. */
  indexBatch(
    events: RawEvent[],
    currentIndex: IndexState,
    model: IModelAdapter,
  ): Promise<IndexUpdate>;

  /** Periodic full reorganisation against the existing index. */
  reorganise(
    currentIndex: IndexState,
    model: IModelAdapter,
  ): Promise<IndexUpdate>;

  /** Apply an IndexUpdate to disk and return the resulting state. */
  applyUpdate(update: IndexUpdate): Promise<IndexState>;

  /** Read the current persisted state. */
  getState(): Promise<IndexState>;

  /** Read a page by its relative path (e.g. "projects/auth-feature.md"). */
  readPage(pagePath: string): Promise<IndexPage | null>;

  /** Read the root index.md verbatim. */
  readRootIndex(): Promise<string>;

  /** Wipe the index — used by --full-reindex. */
  reset(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Layer 4 — Export
// ---------------------------------------------------------------------------

export interface ExportStatus {
  name: string;
  running: boolean;
  lastSync: string | null;
  pendingUpdates: number;
  errorCount: number;
}

export interface IExport {
  readonly name: string;

  start(): Promise<void>;
  stop(): Promise<void>;

  onPageUpdate(page: IndexPage): Promise<void>;
  onPageDelete(pagePath: string): Promise<void>;
  onReorganisation(summary: ReorganisationSummary): Promise<void>;

  /** Push the entire current index to this target. */
  fullSync(index: IndexState, strategy: IIndexStrategy): Promise<void>;

  getStatus(): ExportStatus;
}

// ---------------------------------------------------------------------------
// Plugin manifest (shared by every plugin folder)
// ---------------------------------------------------------------------------

export type PluginLayer = 'capture' | 'storage' | 'model' | 'index' | 'export';

export type PluginInterfaceName =
  | 'ICapture'
  | 'IStorage'
  | 'IModelAdapter'
  | 'IIndexStrategy'
  | 'IExport';

export interface PluginManifest {
  name: string;
  version: string;
  layer: PluginLayer;
  interface: PluginInterfaceName;
  entrypoint: string;
  description?: string;
  config_schema?: Record<string, unknown>;
}

/**
 * Each plugin module's default export must be a factory matching this
 * signature. The factory receives the plugin's slice of `config.yaml` plus
 * a few host services (logger, data dir) and returns the implementation.
 */
export interface PluginHostContext {
  dataDir: string;
  logger: Logger;
  /** Resolved config block for this specific plugin (already validated upstream). */
  config: Record<string, unknown>;
}

export type PluginFactory<T> = (
  context: PluginHostContext,
) => T | Promise<T>;

// ---------------------------------------------------------------------------
// Cross-cutting helpers
// ---------------------------------------------------------------------------

export interface Logger {
  debug(msg: string, ...rest: unknown[]): void;
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
  child(scope: string): Logger;
}
