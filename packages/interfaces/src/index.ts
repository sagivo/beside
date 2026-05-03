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
  /**
   * Events captured since local-day midnight. The runtime overrides
   * this with an accurate storage-backed count; capture plugins only
   * provide an in-memory tally that resets when the plugin restarts.
   */
  eventsToday: number;
  /** Events captured in the trailing 60 minutes (storage-backed). */
  eventsLastHour?: number;
  storageBytesToday: number;
  cpuPercent: number;
  memoryMB: number;
}

export interface CaptureConfig {
  pluginName: string;
  screenshot_diff_threshold: number;
  idle_threshold_sec: number;
  screenshot_format: 'webp' | 'jpeg';
  screenshot_quality: number;
  /**
   * Longest-edge cap applied at capture time. 0 = native resolution.
   * Defaults to 1280, which is plenty for OCR/perceptual-hash and
   * yields ~4-6× smaller files than native Retina.
   */
  screenshot_max_dim: number;
  /**
   * Soft-trigger throttle: minimum ms between two `content_change`
   * captures of the same display. Hard triggers (window_focus,
   * url_change, idle_end) bypass this floor.
   */
  content_change_min_interval_ms: number;
  /** @deprecated kept for back-compat with status panes; mirrors quality when format=jpeg. */
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
  /** Filter to events not yet indexed by the named strategy. */
  unindexed_for_strategy?: string;
  /** Filter to events not yet materialised into a frame. */
  unframed_only?: boolean;
}

/**
 * A `Frame` is the materialised retrieval unit of CofounderOS — a single
 * "moment" you were looking at, joining a screenshot with its window /
 * URL metadata and (eventually) its OCR'd, accessibility-extracted, or
 * audio-transcribed text.
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
  /** OCR'd, accessibility-extracted, combined visual text, or audio-transcribed text. */
  text: string | null;
  text_source: FrameTextSource | null;
  asset_path: string | null;
  perceptual_hash: string | null;
  trigger: string | null;
  session_id: string;
  /** Focused duration this frame represents, if known from a paired blur. */
  duration_ms: number | null;
  /** Resolved entity for this frame — null until the resolver runs. */
  entity_path: string | null;
  entity_kind: EntityKind | null;
  /**
   * Activity session this frame belongs to. Null until the
   * SessionBuilder worker has assigned it. Distinct from `session_id`,
   * which is the *capture* session (one per `cofounderos start` run);
   * activity sessions are user-visible focus runs bounded by idle gaps
   * and can span capture sessions cleanly.
   */
  activity_session_id: string | null;
  /** Raw event ids that contributed to this frame. */
  source_event_ids: string[];
}

export type FrameTextSource =
  | 'ocr'
  | 'accessibility'
  | 'ocr_accessibility'
  | 'audio'
  | 'none';

export interface FrameQuery {
  /** FTS5 query against `text`, `app`, `window_title`, `url`. */
  text?: string;
  /**
   * Optional semantic vector for conceptual retrieval. When provided,
   * storage adapters that materialise embeddings may return nearest
   * neighbours blended with any FTS filters. Adapters without embeddings
   * can ignore this field.
   */
  embedding?: number[];
  /** Which embedding model produced `embedding`. Defaults to adapter-specific. */
  embeddingModel?: string;
  from?: string;
  to?: string;
  apps?: string[];
  day?: string;
  entityPath?: string;
  entityKind?: EntityKind;
  activitySessionId?: string;
  urlDomain?: string;
  textSource?: FrameTextSource;
  limit?: number;
  offset?: number;
}

export interface FrameEmbeddingTask {
  id: string;
  /**
   * Stable text digest for change detection. If the frame text/title/url
   * changes, the worker writes a new embedding for the new digest.
   */
  content_hash: string;
  content: string;
}

export interface FrameSemanticMatch {
  frame: Frame;
  /** Cosine similarity in [0, 1] after normalisation. Higher is better. */
  score: number;
}

/** Lightweight projection used by the OCR worker. */
export interface FrameOcrTask {
  id: string;
  asset_path: string;
  existing_text: string | null;
  existing_source: FrameTextSource | null;
}

/**
 * Which retention tier a frame's asset has been pushed into. Promotion
 * is monotonic: original → compressed → thumbnail → deleted. The
 * frame's metadata + OCR text remain in SQLite forever; only the image
 * file changes shape.
 */
export type FrameAssetTier =
  | 'original'
  | 'compressed'
  | 'thumbnail'
  | 'deleted';

/** Lightweight projection used by the StorageVacuum worker. */
export interface FrameAsset {
  id: string;
  asset_path: string;
  timestamp: string;
  tier: FrameAssetTier;
}

/**
 * Kind of thing a frame represents in the user's life. The resolver
 * tries these in priority order; everything that doesn't match an earlier
 * kind falls through to `webpage` (if there's a URL) or `app` (last
 * resort). Adding a new kind is one new resolver function.
 */
export type EntityKind =
  | 'project'
  | 'repo'
  | 'meeting'
  | 'contact'
  | 'channel'
  | 'doc'
  | 'webpage'
  | 'app';

export interface EntityRef {
  kind: EntityKind;
  /** Stable filesystem path & DB primary key, e.g. "projects/cofounderos". */
  path: string;
  title: string;
}

export interface EntityRecord extends EntityRef {
  firstSeen: string;
  lastSeen: string;
  /** Total focused time aggregated from frames whose duration_ms is known. */
  totalFocusedMs: number;
  frameCount: number;
}

export interface ListEntitiesQuery {
  kind?: EntityKind;
  limit?: number;
  /** Only entities last seen on or after this ISO timestamp. */
  sinceLastSeen?: string;
}

export interface SearchEntitiesQuery {
  /** Free-text query — matched against `title` and the path tail. */
  text: string;
  /** Optionally restrict to one entity kind. */
  kind?: EntityKind;
  limit?: number;
  /**
   * If true, include `apps/*` entities flagged as noise (loginwindow,
   * electron, system-settings, …). Defaults to false — autocomplete
   * normally wants to surface meaningful entities only, but
   * diagnostic / debug UIs can opt back in.
   */
  includeNoise?: boolean;
}

/**
 * One row of an entity co-occurrence query — entities that share
 * activity sessions with a target entity, ranked by how often they
 * appear together. Used by the "who do I work with on X?" and "what
 * else lights up alongside this channel?" UI patterns.
 */
export interface EntityCoOccurrence {
  /** Path of the entity that appears alongside the target. */
  path: string;
  kind: EntityKind;
  title: string;
  /** Distinct activity sessions in which both entities appeared. */
  sharedSessions: number;
  /**
   * Combined attention time (frame `duration_ms` sum) the partner
   * accumulated across those shared sessions. Higher = more
   * meaningful overlap, not just a fleeting tab.
   */
  sharedFocusedMs: number;
  /** Most recent shared session's start time, ISO. */
  lastSharedAt: string;
}

/** Timeline bucket granularities supported by `getEntityTimeline`. */
export type TimelineGranularity = 'day' | 'hour';

export interface EntityTimelineBucket {
  /** Bucket label — `YYYY-MM-DD` for day, `YYYY-MM-DDTHH` for hour. */
  bucket: string;
  /** Frames in this bucket attributed to the entity. */
  frames: number;
  /** Sum of `frames.duration_ms` for those frames. */
  focusedMs: number;
  /** Distinct activity sessions touched in this bucket. */
  sessions: number;
}

export interface EntityTimelineQuery {
  granularity?: TimelineGranularity;
  /** Inclusive lower bound (ISO). Optional. */
  from?: string;
  /** Inclusive upper bound (ISO). Optional. */
  to?: string;
  /** Cap on returned buckets, newest first. Default 30. */
  limit?: number;
}

/**
 * A continuous run of focused user activity, bounded by idle gaps. The
 * SessionBuilder groups frames into sessions whenever the gap between
 * adjacent frames stays below `idle_threshold_sec` (default 5 minutes).
 *
 * Sessions are the unit of "what was I doing for the last hour?" — they
 * surface in journal headers, drive the `list_sessions` MCP tool, and
 * give entities accurate `total_focused_ms` numbers (since a session
 * can attribute its time to exactly one primary entity).
 */
export interface ActivitySession {
  id: string;
  started_at: string;
  ended_at: string;
  /** YYYY-MM-DD of `started_at`. Sessions never span midnight. */
  day: string;
  /** ended_at - started_at, in milliseconds. */
  duration_ms: number;
  /**
   * Sum of inter-frame gaps that fell *under* the idle threshold —
   * roughly the user's continuous focus time inside this session.
   * Differs from duration_ms when there were brief idle stretches.
   */
  active_ms: number;
  frame_count: number;
  /** Entity that received the most attention in this session. Null if no frame had an entity. */
  primary_entity_path: string | null;
  primary_entity_kind: EntityKind | null;
  /** App with the most attention. Useful when no entity resolved. */
  primary_app: string | null;
  /**
   * All entities touched in this session, sorted by attention
   * descending. Each entry is the entity's stable path.
   */
  entities: string[];
}

export interface ListSessionsQuery {
  /** Restrict to a single day (YYYY-MM-DD). */
  day?: string;
  /** Sessions starting on or after this ISO timestamp. */
  from?: string;
  /** Sessions starting on or before this ISO timestamp. */
  to?: string;
  limit?: number;
  /** Order: 'recent' (started_at DESC, default) or 'chronological' (ASC). */
  order?: 'recent' | 'chronological';
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
  /**
   * Count events matching `query` without loading them. Used by the
   * runtime overview to report accurate "today" / "last hour" capture
   * counts, since `CaptureStatus.eventsToday` is only an in-memory
   * counter that resets on plugin restart.
   */
  countEvents(query: StorageQuery): Promise<number>;
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
    source: Extract<FrameTextSource, 'ocr' | 'accessibility' | 'ocr_accessibility'>,
  ): Promise<void>;

  /** Mark raw events as having been folded into a frame. */
  markFramed(eventIds: string[]): Promise<void>;

  /**
   * Frames whose searchable content has no current embedding for the
   * requested model. Used by the EmbeddingWorker.
   */
  listFramesNeedingEmbedding(
    model: string,
    limit: number,
  ): Promise<FrameEmbeddingTask[]>;

  /** Insert or replace a frame embedding for `model`. */
  upsertFrameEmbedding(
    frameId: string,
    model: string,
    contentHash: string,
    vector: number[],
  ): Promise<void>;

  /** Semantic nearest-neighbour search over frame embeddings. */
  searchFrameEmbeddings(
    vector: number[],
    query?: Omit<FrameQuery, 'text' | 'embedding' | 'embeddingModel'> & {
      model?: string;
    },
  ): Promise<FrameSemanticMatch[]>;

  /** Clear all derived embeddings, or only embeddings for one model. */
  clearFrameEmbeddings(model?: string): Promise<void>;

  // -------------------------------------------------------------------------
  // Entities (PR 6) — semantic rollup of frames
  //
  // Implementations may throw `not_implemented` if they don't materialise
  // entities; consumers should treat absence of entities as "every frame
  // resolves to its app" gracefully.
  // -------------------------------------------------------------------------

  /** Frames that haven't been resolved to an entity yet. */
  listFramesNeedingResolution(limit: number): Promise<Frame[]>;

  /** Attach an entity to a frame and (atomically) bump the entity's stats. */
  resolveFrameToEntity(frameId: string, entity: EntityRef): Promise<void>;

  /** Frames whose entity is known but for which no entity record exists. */
  rebuildEntityCounts(): Promise<void>;

  /** Look up an entity by its stable path. */
  getEntity(path: string): Promise<EntityRecord | null>;

  /** List entities, newest activity first. */
  listEntities(query?: ListEntitiesQuery): Promise<EntityRecord[]>;

  /**
   * Free-text search across entity titles + paths. Backed by FTS5 on
   * adapters that materialise an `entities_fts` table; otherwise falls
   * back to a `LIKE` scan. Used by the desktop UI for entity
   * autocomplete and by the indexer for fuzzy entity lookups.
   */
  searchEntities(query: SearchEntitiesQuery): Promise<EntityRecord[]>;

  /** Frames belonging to an entity, oldest first. */
  getEntityFrames(path: string, limit?: number): Promise<Frame[]>;

  /**
   * Find entities that frequently appear in the same activity
   * sessions as `entityPath`. Powers "who do I work with on X?",
   * "what projects involve channel Y?", "what apps are part of my
   * cofounderos work?" — questions that today need raw SQL.
   *
   * Implementations should:
   *  - Self-exclude the target entity from results.
   *  - Rank by shared session count, breaking ties by combined
   *    attention ms, then recency.
   *  - Return at most `limit` rows (default 25).
   */
  listEntityCoOccurrences(
    entityPath: string,
    limit?: number,
  ): Promise<EntityCoOccurrence[]>;

  /**
   * Bucket an entity's frames into per-day or per-hour slots, with
   * frame count, focused-time sum, and distinct-session count for
   * each bucket. Powers timeline charts ("when have I worked on
   * cofounderos this week?") without forcing the UI to build the
   * aggregation itself.
   */
  getEntityTimeline(
    entityPath: string,
    query?: EntityTimelineQuery,
  ): Promise<EntityTimelineBucket[]>;

  /**
   * Reattribute a known set of frames from one or more "fallback" app
   * entities (e.g. `apps/cursor`, `apps/warp`) to a single concrete
   * target entity (typically the dominant project of the activity
   * session those frames belong to).
   *
   * Used by the SessionBuilder to rescue editor / terminal frames that
   * the per-frame resolver couldn't tie to a project on their own —
   * window titles like just `"Cursor"` or `"Cursor Agents"` carry no
   * project hint, so they otherwise pile up under `apps/<editor>`.
   *
   * The caller passes `frameIds` rather than a session id so this can
   * run before frames have been assigned to a session, and so its
   * filtering semantics are explicit ("move exactly these frames if
   * their current entity matches one of `fromAppPaths`").
   *
   * Implementations MUST:
   *  1. Move only frames whose id is in `frameIds` AND whose current
   *     `entity_path` is in `fromAppPaths`.
   *  2. Refresh the `entities` rollup for every entity touched (the
   *     source `apps/*` rows shrink, the target row grows). A null /
   *     zero-frame source row should be deleted to keep the entities
   *     table clean.
   *
   * Returns the number of frames moved + the paths of the entity rows
   * that were refreshed (caller can use this for logging).
   */
  reattributeFrames(input: {
    frameIds: string[];
    fromAppPaths: string[];
    target: EntityRef;
  }): Promise<{ moved: number; refreshedEntities: string[] }>;

  // -------------------------------------------------------------------------
  // Vacuum (asset retention)
  // -------------------------------------------------------------------------

  /**
   * List frames whose asset is currently at `currentTier` and whose
   * timestamp is older than `olderThan`. Used by the vacuum worker to
   * find candidates for promotion to the next tier.
   */
  listFramesForVacuum(
    currentTier: FrameAssetTier,
    olderThanIso: string,
    limit: number,
  ): Promise<FrameAsset[]>;

  /**
   * Update a frame's asset metadata after a vacuum operation. `assetPath`
   * may be set to `null` to mark the asset deleted while preserving the
   * frame row. `tier` is monotonically advanced.
   */
  updateFrameAsset(
    frameId: string,
    update: { assetPath?: string | null; tier: FrameAssetTier },
  ): Promise<void>;

  /**
   * Aggregate counts of frames by current vacuum tier — feeds the
   * `cofounderos status` command and the vacuum scheduler's no-op
   * fast-path.
   */
  countFramesByTier(): Promise<Record<FrameAssetTier, number>>;

  // -------------------------------------------------------------------------
  // Activity sessions — continuous user-focus runs, bounded by idle gaps.
  //
  // Sessions are derived from frames; full reindex clears them with
  // `clearAllSessions()` and the SessionBuilder rebuilds from scratch.
  // -------------------------------------------------------------------------

  /** Insert or replace a session row. */
  upsertSession(session: ActivitySession): Promise<void>;

  /** Read one session by id. */
  getSession(id: string): Promise<ActivitySession | null>;

  /** List sessions matching `query`, newest first by default. */
  listSessions(query?: ListSessionsQuery): Promise<ActivitySession[]>;

  /**
   * Frames that haven't been assigned to a session yet, ordered by
   * timestamp ASC. The SessionBuilder drains this queue.
   */
  listFramesNeedingSessionAssignment(limit: number): Promise<Frame[]>;

  /**
   * Bulk-attach frames to a session id. The session row must already
   * exist (the SessionBuilder always upserts the session before calling
   * this).
   */
  assignFramesToSession(frameIds: string[], sessionId: string): Promise<void>;

  /**
   * Frames that belong to a given session, oldest first. Used by
   * `get_session` MCP tool and to render session-grouped journals.
   */
  getSessionFrames(sessionId: string): Promise<Frame[]>;

  /**
   * Clear every session row + null out `frames.activity_session_id`.
   * Called from `--full-reindex` so a changed idle threshold can
   * regroup history cleanly.
   */
  clearAllSessions(): Promise<void>;

  // -------------------------------------------------------------------------
  // Deletion (privacy-driven). Implementations MUST also remove on-disk
  // assets referenced by deleted frames so the user-visible promise that
  // "delete actually deletes" holds. Storage adapters that don't track
  // assets at all may leave the asset side as a no-op.
  // -------------------------------------------------------------------------

  /**
   * Permanently delete a single frame and any derived rows
   * (text / embeddings / session attribution) plus the screenshot on
   * disk. Returns the asset path that was removed (or null if none was
   * stored) so callers can surface byte counts in UI confirmations.
   */
  deleteFrame(frameId: string): Promise<{ assetPath: string | null }>;

  /**
   * Permanently delete every frame, raw event, and session for a given
   * day (YYYY-MM-DD) along with all their assets on disk. Returns the
   * count of deleted frames and the list of asset paths removed for
   * UI feedback.
   */
  deleteFramesByDay(day: string): Promise<{ frames: number; assetPaths: string[] }>;

  /**
   * Wipe ALL memory — every frame, event, session, entity, embedding,
   * page, and asset on disk. The DB schema and the storage root remain
   * intact so the runtime can keep capturing fresh data immediately
   * after. Returns aggregate counts so the UI can confirm the scope of
   * the action ("deleted N moments, ~M GB on disk").
   */
  deleteAllMemory(): Promise<{ frames: number; events: number; assetBytes: number }>;
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
  /**
   * Optional streaming variant. Adapters that support token streaming
   * (Ollama, OpenAI) implement this and emit chunks via `onChunk` as
   * they arrive. The returned promise resolves with the full text once
   * streaming finishes. The host falls back to `complete` when this is
   * unavailable.
   */
  completeStream?(
    prompt: string,
    options: CompletionOptions,
    onChunk: (chunk: string) => void,
  ): Promise<string>;
  /**
   * Optional embedding endpoint. Adapters that implement this return one
   * vector per input, in the same order. The host normalises/storage-ranks
   * vectors, so adapters may return raw model output.
   */
  embed?(texts: string[]): Promise<number[][]>;
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

/**
 * Services the orchestrator can offer to an export plugin via
 * `bindServices()`. Plugins pick what they need by structural typing —
 * the orchestrator passes the full bag and the plugin reads only the
 * fields it cares about. New service slots can be added here without
 * breaking existing plugins.
 */
export interface ExportServices {
  storage: IStorage;
  strategy: IIndexStrategy;
  /** Active model adapter. Query-style exports use this for embeddings. */
  model: IModelAdapter;
  /** Storage key for embeddings produced by the active model adapter. */
  embeddingModelName?: string;
  /** Absolute path to the data dir (raw assets root). */
  dataDir: string;
  /**
   * Trigger an incremental (or full) re-index pass. Used by query-style
   * exports (e.g. MCP) when a client requests fresh data.
   */
  triggerReindex: (full?: boolean) => Promise<void>;
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

  /**
   * Optional: receive references to host services after instantiation,
   * before `start()`. The orchestrator calls this on every export
   * plugin that defines it. Plugins should treat the services bag as
   * structurally typed — read what you need, ignore the rest.
   */
  bindServices?(services: ExportServices): void;
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

/**
 * Render a day's worth of frames as a chronological markdown timeline.
 * Used by both the markdown export (writes to disk) and the MCP server
 * (returns over the wire). Pure function — no IO, no state.
 *
 * `assetUrlPrefix` lets callers point screenshot links at either the raw
 * data dir (for the on-disk export) or a relative path (for MCP).
 */
export interface JournalRenderOptions {
  /** Prepend to every screenshot link. Defaults to ''. */
  assetUrlPrefix?: string;
  /**
   * Activity sessions overlapping this day. When provided, the journal
   * is grouped under per-session headers and AFK gaps are inserted
   * between adjacent sessions. Frames whose `activity_session_id` does
   * not appear in this list still render — they're grouped under a
   * trailing "Loose frames" section.
   */
  sessions?: ActivitySession[];
  /** Threshold (ms) above which inter-session gaps render as AFK markers. Default 2 min. */
  afkThresholdMs?: number;
}

export function renderJournalMarkdown(
  day: string,
  frames: Frame[],
  optionsOrPrefix: JournalRenderOptions | string = {},
): string {
  const options: JournalRenderOptions =
    typeof optionsOrPrefix === 'string'
      ? { assetUrlPrefix: optionsOrPrefix }
      : optionsOrPrefix;
  const assetUrlPrefix = options.assetUrlPrefix ?? '';
  const sessions = options.sessions ?? [];
  const afkThresholdMs = options.afkThresholdMs ?? 2 * 60_000;

  if (frames.length === 0) {
    return `# Journal — ${day}\n\n_No frames captured on this day._\n`;
  }

  const lines: string[] = [];
  lines.push(`# Journal — ${day}`);
  lines.push('');

  const totalMs = frames.reduce((acc, f) => acc + (f.duration_ms ?? 0), 0);
  const minutes = Math.round(totalMs / 60_000);
  const summaryParts: string[] = [`${frames.length} frame(s) captured`];
  if (minutes > 0) summaryParts.push(`~${minutes} min focused`);
  if (sessions.length > 0) {
    const activeMin = Math.round(
      sessions.reduce((s, x) => s + x.active_ms, 0) / 60_000,
    );
    summaryParts.push(`${sessions.length} session(s), ${activeMin} active min`);
  }
  lines.push(`_${summaryParts.join(', ')}._`);
  lines.push('');

  // -------------------------------------------------------------------------
  // Session-grouped path. We preserve the legacy app-grouped output for
  // back-compat when no sessions are supplied.
  // -------------------------------------------------------------------------
  if (sessions.length > 0) {
    const framesBySession = new Map<string, Frame[]>();
    for (const f of frames) {
      const sid = f.activity_session_id ?? '__loose__';
      const arr = framesBySession.get(sid);
      if (arr) arr.push(f);
      else framesBySession.set(sid, [f]);
    }

    const ordered = [...sessions].sort((a, b) =>
      a.started_at.localeCompare(b.started_at),
    );

    let prevEnded: string | null = null;
    for (const session of ordered) {
      if (prevEnded) {
        const gapMs = Date.parse(session.started_at) - Date.parse(prevEnded);
        if (gapMs >= afkThresholdMs) {
          lines.push(`---`);
          lines.push(`_…idle for ${humaniseDuration(gapMs)}…_`);
          lines.push('');
        }
      }
      const sessionFrames = framesBySession.get(session.id) ?? [];
      renderSession(session, sessionFrames, lines, assetUrlPrefix);
      prevEnded = session.ended_at;
    }

    // Frames not in any provided session — render at the end so they're
    // not silently dropped (e.g. SessionBuilder hasn't caught up yet).
    const loose = framesBySession.get('__loose__') ?? [];
    if (loose.length > 0) {
      lines.push(`---`);
      lines.push(`## Loose frames`);
      lines.push(`_${loose.length} frame(s) not yet assigned to a session._`);
      lines.push('');
      renderFrameList(loose, lines, assetUrlPrefix);
    }
    return lines.join('\n') + '\n';
  }

  // -------------------------------------------------------------------------
  // Legacy app-grouped path.
  // -------------------------------------------------------------------------
  let lastApp: string | null = null;
  for (const f of frames) {
    if (f.app !== lastApp) {
      lines.push(`## ${f.app || '(unknown)'}`);
      lastApp = f.app;
    }
    renderFrame(f, lines, assetUrlPrefix);
  }
  return lines.join('\n') + '\n';
}

function renderSession(
  session: ActivitySession,
  frames: Frame[],
  lines: string[],
  assetUrlPrefix: string,
): void {
  const startTime = session.started_at.slice(11, 16);
  const endTime = session.ended_at.slice(11, 16);
  const activeMin = Math.max(1, Math.round(session.active_ms / 60_000));
  const headerBits: string[] = [];
  if (session.primary_entity_path) {
    headerBits.push(`[[${session.primary_entity_path}]]`);
  } else if (session.primary_app) {
    headerBits.push(session.primary_app);
  }
  headerBits.push(`${activeMin} min active`);
  if (frames.length > 0) {
    headerBits.push(`${frames.length} frame${frames.length === 1 ? '' : 's'}`);
  }
  lines.push(`## ${startTime} – ${endTime} · ${headerBits.join(' · ')}`);
  if (session.entities.length > 1) {
    const tail = session.entities
      .slice(1, 4)
      .map((p) => `[[${p}]]`)
      .join(', ');
    if (tail) lines.push(`_also touched: ${tail}_`);
  }
  lines.push('');
  if (frames.length === 0) {
    lines.push(`_(session has no frames in this journal slice)_`);
    lines.push('');
    return;
  }
  renderFrameList(frames, lines, assetUrlPrefix);
}

function renderFrameList(
  frames: Frame[],
  lines: string[],
  assetUrlPrefix: string,
): void {
  let lastApp: string | null = null;
  for (const f of frames) {
    if (f.app !== lastApp) {
      lines.push(`### ${f.app || '(unknown)'}`);
      lastApp = f.app;
    }
    renderFrame(f, lines, assetUrlPrefix);
  }
}

function renderFrame(f: Frame, lines: string[], assetUrlPrefix: string): void {
  const time = f.timestamp.slice(11, 19);
  const dur = f.duration_ms ? ` _(${Math.round(f.duration_ms / 1000)}s)_` : '';
  const target = [
    f.window_title ? `"${f.window_title}"` : null,
    f.url ? `<${f.url}>` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const entityLink = f.entity_path ? ` → [[${f.entity_path}]]` : '';
  lines.push(`- **${time}**${dur} — ${target || '(no title)'}${entityLink}`);
  // OCR, accessibility, mixed visual extraction, and audio are equally
  // valid sources of human-readable text — all pass through a PII redactor
  // before landing in storage, so none needs special treatment here.
  if (
    f.text &&
    (
      f.text_source === 'ocr' ||
      f.text_source === 'accessibility' ||
      f.text_source === 'ocr_accessibility' ||
      f.text_source === 'audio'
    ) &&
    f.text.trim()
  ) {
    const snippet = f.text.replace(/\s+/g, ' ').trim().slice(0, 200);
    lines.push(`  > ${snippet}${snippet.length === 200 ? '…' : ''}`);
  }
  if (f.asset_path) {
    lines.push(`  ![](${assetUrlPrefix}${f.asset_path})`);
  }
}

function humaniseDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
