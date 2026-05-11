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
   * Defaults to 1100, which is plenty for OCR/perceptual-hash and
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
  // Delay before taking a screenshot for a focus change, so transient UI
  // like the macOS Cmd+Tab switcher can settle before pixels are captured.
  focus_settle_delay_ms: number;
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
  ids?: string[];
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
  /**
   * Meeting this frame belongs to, when applicable. Null for non-meeting
   * frames; populated by the MeetingBuilder for both meeting screenshot
   * frames and audio_transcript frames whose time window overlaps a
   * meeting. Distinct from `activity_session_id` because two meetings
   * in the same focus session each get their own meeting id.
   */
  meeting_id: string | null;
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
  /**
   * dHash of the captured screenshot, computed at capture time before
   * any vacuum re-encode. The OCR worker uses it to copy text from a
   * previously-OCR'd frame with identical pixels (e.g. user toggled
   * back to the same app/window/tab) instead of running Tesseract
   * again. Null when capture didn't produce one.
   */
  perceptual_hash?: string | null;
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

// ---------------------------------------------------------------------------
// Meetings — V2.
//
// A `Meeting` is a maximal time-contiguous run of frames whose entity_kind
// is `meeting` for the same `entity_path`, fused with any audio_transcript
// frames whose timestamp window overlaps that run. Distinct from
// ActivitySession: a meeting is its own first-class object so two meetings
// in the same session (back-to-back Zooms after a 10 min break) become
// independent summaries.
//
// Meetings are derived from frames; full reindex clears them with
// `clearAllMeetings()` and the MeetingBuilder rebuilds from scratch.
// ---------------------------------------------------------------------------

export type MeetingPlatform =
  | 'zoom'
  | 'meet'
  | 'teams'
  | 'webex'
  | 'whereby'
  | 'around'
  | 'other';

export type MeetingSummaryStatus =
  | 'pending'
  | 'running'
  | 'ready'
  | 'failed'
  | 'skipped_short';

export type MeetingTurnSource = 'whisper' | 'vtt' | 'srt' | 'import';

/**
 * One transcript turn — a single utterance with a timestamp. Aligned to
 * the screenshot frame whose validity window covers `t_start` so an
 * agent can look up "what was on the screen when this was said".
 */
export interface MeetingTurn {
  /** Auto-incremented row id. */
  id: number;
  meeting_id: string;
  /** ISO timestamp of the start of the utterance. */
  t_start: string;
  /** ISO timestamp of the end (best effort; may equal t_start when unknown). */
  t_end: string;
  /** Speaker label when available — VTT `<v Name>` tag or active-speaker OCR. */
  speaker: string | null;
  text: string;
  /** Frame id whose pixels were on screen at `t_start`, when known. */
  visual_frame_id: string | null;
  /** How this turn was extracted. */
  source: MeetingTurnSource;
}

export interface Meeting {
  id: string;
  /** Stable `meetings/<day>-<slug>` path — same as `frames.entity_path`. */
  entity_path: string;
  /** Human-readable meeting title extracted from window titles or the LLM summary. */
  title: string | null;
  /** Primary platform inferred from app/URL of the meeting frames. */
  platform: MeetingPlatform;
  started_at: string;
  ended_at: string;
  /** YYYY-MM-DD of started_at; meetings never span midnight. */
  day: string;
  duration_ms: number;
  /** All meeting frames + overlapping audio frames. */
  frame_count: number;
  /** Just the screen frames (not audio). */
  screenshot_count: number;
  /** Just the audio_transcript frames overlapping the meeting window. */
  audio_chunk_count: number;
  /** Sum of transcript text lengths across overlapping audio frames. */
  transcript_chars: number;
  /** Stable hash of (turn count, key screenshot ids). Drives summary staleness. */
  content_hash: string;
  summary_status: MeetingSummaryStatus;
  /** Markdown rendering of the structured summary. Null until ready. */
  summary_md: string | null;
  /** Structured summary (parsed JSON) — see MeetingSummaryJson. */
  summary_json: MeetingSummaryJson | null;
  /** Names extracted from speaker labels + active-speaker overlays. */
  attendees: string[];
  /** URLs spotted in OCR text or url_change events during the meeting. */
  links: string[];
  /** Reason summary failed, when status='failed'. */
  failure_reason: string | null;
  /** Last writer timestamp. */
  updated_at: string;
}

/**
 * Structured payload produced by the MeetingSummarizer. Rendered to
 * markdown for the journal but kept in this shape so MCP clients can
 * pluck individual fields without parsing prose.
 */
export interface MeetingSummaryJson {
  /** Short title for this meeting, e.g. "Weekly Engineering Standup". */
  title: string | null;
  tldr: string;
  agenda: string[];
  decisions: Array<{ text: string; evidence_turn_ids: number[] }>;
  action_items: Array<{
    owner: string | null;
    task: string;
    due: string | null;
    evidence_turn_ids: number[];
  }>;
  open_questions: Array<{ text: string; evidence_turn_ids: number[] }>;
  key_moments: Array<{
    t: string;
    what: string;
    frame_id: string | null;
  }>;
  attendees_seen: string[];
  links_shared: string[];
  /** Free-form notes from the model (e.g. "remote audio not captured"). */
  notes: string | null;
}

export interface ListMeetingsQuery {
  day?: string;
  from?: string;
  to?: string;
  platform?: MeetingPlatform;
  limit?: number;
  order?: 'recent' | 'chronological';
  /** When set, only meetings whose summary status matches. */
  summaryStatus?: MeetingSummaryStatus;
}

export interface MeetingSummaryUpdate {
  status: MeetingSummaryStatus;
  md?: string | null;
  json?: MeetingSummaryJson | null;
  contentHash?: string;
  failureReason?: string | null;
  /** When set, overwrite the meeting's stored title. */
  title?: string | null;
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

  /**
   * Find a previously-OCR'd frame with the same perceptual hash so the
   * OCR worker can copy its text instead of re-running Tesseract on
   * pixel-identical screens (typical when the user toggles back to a
   * previously-captured window/tab). Returns the OCR text + source on
   * a hit, `null` otherwise. Implementations that don't index by
   * perceptual hash can omit this method; the worker falls back to
   * always running OCR.
   */
  findOcrTextByPerceptualHash?(
    perceptualHash: string,
    excludeFrameId?: string,
  ): Promise<{
    text: string;
    source: Extract<FrameTextSource, 'ocr' | 'accessibility' | 'ocr_accessibility'>;
  } | null>;

  /** Mark raw events as having been folded into a frame. */
  markFramed(eventIds: string[]): Promise<void>;

  /**
   * Clear derived frame/search/entity state and reopen matching raw events for
   * FrameBuilder. Full reindex uses this so resolver/text extraction changes
   * can be applied to already-captured history.
   */
  resetFrameDerivatives(query?: { from?: string; to?: string }): Promise<void>;

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

  /** Insert or replace multiple frame embeddings in one storage transaction. */
  upsertFrameEmbeddings?(
    embeddings: Array<{
      frameId: string;
      model: string;
      contentHash: string;
      vector: number[];
    }>,
  ): Promise<void>;

  /**
   * Look up an existing embedding by `(model, contentHash)` from any
   * frame. The same captured window/title/url/text often produces
   * identical embedding inputs across many consecutive frames (the
   * user dwelling on one Slack channel, browser tab, IDE buffer, …).
   * The embedding worker calls this before invoking `model.embed()`
   * so we don't pay the LLM cost — typically the slowest part of any
   * indexing tick — to recompute a vector we've already stored. Each
   * cache hit saves a full nomic-embed-text round-trip (~50-200ms on
   * Apple Silicon, much more on CPU-only).
   *
   * Returns `null` when nothing matches. Implementations that don't
   * track content hashes can omit this method entirely; the worker
   * falls back to in-batch dedupe alone.
   */
  findExistingFrameEmbedding?(
    model: string,
    contentHash: string,
  ): Promise<{ vector: number[]; dims: number } | null>;

  /**
   * Batch variant of `findExistingFrameEmbedding`. Returns a Map from
   * contentHash → embedding for every hash that already has a stored vector.
   * Hashes with no stored embedding are absent from the Map. Implementations
   * that expose this method avoid N sequential DB round-trips in the embedding
   * worker by issuing a single `IN (…)` query instead.
   */
  findExistingFrameEmbeddings?(
    model: string,
    contentHashes: string[],
  ): Promise<Map<string, { vector: number[]; dims: number }>>;

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

  /**
   * Batch variant: attach entities to many frames inside one transaction so
   * the resolver can drain a tick's worth of frames with a single commit.
   */
  resolveFramesToEntities(
    items: ReadonlyArray<{ frameId: string; entity: EntityRef }>,
  ): Promise<void>;

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
   * Best-effort asset unlink that storage adapters can make reference-aware.
   * Vacuum uses this after nulling a frame's asset_path so content-addressed
   * assets are only removed once no remaining frame points at them.
   */
  deleteAssetIfUnreferenced(assetPath: string): Promise<void>;

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
  // Meetings — V2.
  //
  // Implementations may throw `not_implemented` if they don't materialise
  // meetings; the orchestrator gracefully degrades to "no meeting digests"
  // in that case. The local storage adapter implements them.
  // -------------------------------------------------------------------------

  upsertMeeting(meeting: Meeting): Promise<void>;
  getMeeting(id: string): Promise<Meeting | null>;
  listMeetings(query?: ListMeetingsQuery): Promise<Meeting[]>;

  /**
   * Frames flagged as meeting kind that haven't been attached to a
   * meeting row yet. Walked by the MeetingBuilder. Ordered ASC by
   * timestamp.
   */
  listFramesNeedingMeetingAssignment(limit: number): Promise<Frame[]>;

  /**
   * Bulk attach frames to a meeting. Both meeting screenshot frames
   * (entity_kind=meeting) and overlapping audio_transcript frames
   * may be attached; the meeting row must already exist.
   */
  assignFramesToMeeting(frameIds: string[], meetingId: string): Promise<void>;

  /** Frames belonging to a meeting (screens + audio), oldest first. */
  getMeetingFrames(meetingId: string): Promise<Frame[]>;

  /**
   * Audio_transcript frames whose timestamp falls inside `[from, to]`,
   * ordered ASC. Used by the MeetingBuilder to attach audio chunks to
   * a meeting after the screenshot run is closed (audio frames carry
   * their own entity_path of `apps/audio`, so they don't show up via
   * the meeting entity).
   */
  listAudioFramesInRange(fromIso: string, toIso: string): Promise<Frame[]>;

  /** Replace all turns for a meeting with a fresh list. */
  setMeetingTurns(
    meetingId: string,
    turns: Array<Omit<MeetingTurn, 'id' | 'meeting_id'>>,
  ): Promise<MeetingTurn[]>;

  /** All turns for a meeting, ordered ASC by t_start. */
  getMeetingTurns(meetingId: string): Promise<MeetingTurn[]>;

  /**
   * Update only the summary slot — status, optional markdown / json
   * payload, optional content hash for staleness tracking. Other
   * meeting fields are left alone.
   */
  setMeetingSummary(
    meetingId: string,
    update: MeetingSummaryUpdate,
  ): Promise<void>;

  /**
   * Wipe all meeting rows + null `frames.meeting_id`. Called from
   * `--full-reindex`.
   */
  clearAllMeetings(): Promise<void>;

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

  /**
   * Periodic database maintenance: deep integrity_check, ANALYZE to
   * refresh planner statistics, and VACUUM to reclaim freed pages.
   * Called from a low-frequency scheduler tick gated on idle / AC
   * power. Failures are logged but never thrown — maintenance is
   * best-effort.
   */
  runMaintenance(): Promise<{ vacuumed: boolean; analyzed: boolean }>;

  /**
   * Force a WAL checkpoint. `PASSIVE` (the default) returns immediately
   * if other readers/writers would block; `TRUNCATE` waits and then
   * shrinks the WAL file back to zero bytes on disk. Used by the
   * full-reindex pipeline between phases so the WAL doesn't grow into
   * the hundreds of MB during a long run. Best-effort: implementations
   * that don't use WAL (or aren't SQLite-backed) can no-op.
   */
  checkpointWal?(mode?: 'PASSIVE' | 'TRUNCATE'): Promise<void>;

  /**
   * Retention sweep: delete events / frames / sessions / meetings
   * older than `retentionDays`, plus entities whose `last_seen` falls
   * before the same cutoff (those entities have no surviving frames;
   * the resolver will recreate them if the user returns to that work).
   * `retentionDays <= 0` is a no-op so callers can pass the config
   * value directly without guarding.
   */
  deleteOldData(retentionDays: number): Promise<{
    frames: number;
    events: number;
    sessions: number;
    meetings: number;
    entities: number;
    assetPaths: string[];
  }>;
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
   * Optional memory-pressure hook. Local model adapters can use this to
   * unload resident model weights after an idle period or when the runtime
   * stops. Remote adapters can omit it.
   */
  unload?(): Promise<void>;

  /**
   * Optional first-run bootstrap. Adapters that need to install a runtime
   * (Ollama), start a daemon, or download a model implement this and emit
   * structured progress so the host (CLI / UI) can render a progress bar.
   *
   * Throws if the adapter cannot become ready (e.g. unsupported platform,
   * network failure, user denied permission).
   *
   * Idempotent — safe to call on every startup.
   *
   * Pass `{ force: true }` to re-run the model pull step even when the
   * model is already present locally. Adapters that download weights
   * (Ollama) use this to refresh a floating tag that points at newer
   * weights than what's on disk; remote adapters can ignore it.
   */
  ensureReady?(
    onProgress?: ModelBootstrapHandler,
    opts?: { force?: boolean },
  ): Promise<void>;
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
  /**
   * Optional content-addressed digest of the canonicalised "evidence"
   * the page was rendered from (frames, meeting digests, related
   * entities, etc.). When the strategy can prove the evidence hasn't
   * changed since the last render, it skips the LLM call and reuses
   * the existing page. Older pages without this field force a render
   * on the next pass — that's fine, the field self-populates over time.
   */
  evidenceHash?: string;
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
  /**
   * Summarise a single meeting on demand (used by the MCP
   * `summarize_meeting` tool). Optional — exports can ignore it. The
   * orchestrator wires this to the MeetingSummarizer.
   */
  summarizeMeeting?: (meetingId: string, opts?: { force?: boolean }) => Promise<{
    status: 'ok' | 'failed' | 'not_found' | 'deferred';
    message?: string;
  }>;
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
  /**
   * Meetings overlapping this day. When provided AND a meeting carries
   * a rendered `summary_md`, the meeting block is emitted at the top
   * of the day so the user can scan TL;DR + decisions + action items
   * without scrolling through the timeline.
   */
  meetings?: Meeting[];
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
  const meetings = options.meetings ?? [];
  const afkThresholdMs = options.afkThresholdMs ?? 2 * 60_000;

  if (frames.length === 0) {
    return `# Journal — ${day}\n\n_No frames captured on this day._\n`;
  }

  const lines: string[] = [];
  lines.push(`# Journal — ${day}`);
  lines.push('');
  // Meeting digest section — emitted before timelines so the
  // high-signal stuff is the first thing the user (or an AI agent)
  // sees on the page.
  renderMeetingsBlock(meetings, lines);

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
  renderDayOverview(frames, sessions, lines);
  renderCrossSessionReport(frames, sessions, lines);

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

    lines.push('## Timeline');
    lines.push('');

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
      lines.push(`### Loose frames`);
      lines.push(`_${loose.length} frame(s) not yet assigned to a session._`);
      lines.push('');
      renderFrameList(loose, lines, assetUrlPrefix);
    }
    return lines.join('\n') + '\n';
  }

  // -------------------------------------------------------------------------
  // Legacy app-grouped path.
  // -------------------------------------------------------------------------
  lines.push('## Timeline');
  lines.push('');
  let lastApp: string | null = null;
  for (const f of frames) {
    if (f.app !== lastApp) {
      lines.push(`### ${f.app || '(unknown)'}`);
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
    headerBits.push(formatJournalEntityReference(session.primary_entity_path));
  } else if (session.primary_app) {
    headerBits.push(session.primary_app);
  }
  headerBits.push(`${activeMin} min active`);
  if (frames.length > 0) {
    headerBits.push(`${frames.length} frame${frames.length === 1 ? '' : 's'}`);
  }
  lines.push(`### ${startTime} – ${endTime} · ${headerBits.join(' · ')}`);
  if (session.entities.length > 1) {
    const tail = session.entities
      .slice(1, 4)
      .map(formatJournalEntityReference)
      .join(', ');
    if (tail) lines.push(`_also touched: ${tail}_`);
  }
  lines.push('');
  if (frames.length === 0) {
    lines.push(`_(session has no frames in this journal slice)_`);
    lines.push('');
    return;
  }
  const context = describeSessionContext(frames);
  if (context) {
    lines.push(`_Context: ${context}_`);
    lines.push('');
  }
  const phases = summarizeSessionPhases(frames);
  if (phases.length > 1) {
    lines.push('_Phase summary:_');
    for (const phase of phases) {
      lines.push(`- ${phase}`);
    }
    lines.push('');
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
      lines.push(`#### ${f.app || '(unknown)'}`);
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
  const entityLink = f.entity_path ? ` → ${formatJournalEntityReference(f.entity_path)}` : '';
  lines.push(`- **${time}**${dur} — ${target || '(no title)'}${entityLink}`);
  // OCR, accessibility, mixed visual extraction, and audio are equally
  // valid sources of human-readable text — all pass through a PII redactor
  // before landing in storage, so none needs special treatment here.
  if (
    f.text &&
    (
      f.text_source === 'accessibility' ||
      f.text_source === 'audio'
    ) &&
    f.text.trim()
  ) {
    const snippet = readableFrameText(f);
    if (snippet) lines.push(`  > ${snippet}`);
  }
  if (f.asset_path) {
    lines.push(`  ![](${assetUrlPrefix}${f.asset_path})`);
  }
}

interface SessionPhase {
  key: string;
  frames: Frame[];
}

function summarizeSessionPhases(frames: Frame[]): string[] {
  const sorted = frames.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (sorted.length < 6) return [];
  const phases: SessionPhase[] = [];
  for (const frame of sorted) {
    const key = phaseKey(frame);
    const last = phases[phases.length - 1];
    const lastFrame = last?.frames[last.frames.length - 1];
    const gapMs = lastFrame
      ? Date.parse(frame.timestamp) - Date.parse(lastFrame.timestamp)
      : 0;
    if (!last || last.key !== key || gapMs > 3 * 60_000) {
      phases.push({ key, frames: [frame] });
    } else {
      last.frames.push(frame);
    }
  }

  const meaningful = phases.filter(isMeaningfulPhase);
  if (meaningful.length <= 1) return [];
  return selectRepresentativePhases(meaningful, 8).map(renderSessionPhase);
}

function phaseKey(frame: Frame): string {
  if (frame.entity_path?.startsWith('contacts/')) return 'communication';
  if (frame.entity_path?.startsWith('channels/')) return 'communication';
  if (frame.app === 'Mail') return 'communication';
  const domain = domainFromUrl(frame.url);
  if (domain) return `web:${domain}`;
  if (frame.entity_path) return `entity:${frame.entity_path}`;
  return `app:${frame.app || 'unknown'}`;
}

function isMeaningfulPhase(phase: SessionPhase): boolean {
  const durationMs = phaseDurationMs(phase);
  const first = phase.frames[0];
  const isCommunication = phase.key === 'communication';
  const isNoise = first ? isNoisePhaseFrame(first) : false;
  if (isNoise && durationMs < 60_000) return false;
  if (isCommunication) return phase.frames.length >= 2 || durationMs >= 15_000;
  return phase.frames.length >= 3 || durationMs >= 30_000;
}

function phaseDurationMs(phase: SessionPhase): number {
  const first = phase.frames[0];
  const last = phase.frames[phase.frames.length - 1];
  if (!first || !last) return 0;
  return Math.max(
    last.duration_ms ?? 0,
    Date.parse(last.timestamp) - Date.parse(first.timestamp),
  );
}

function isNoisePhaseFrame(frame: Frame): boolean {
  const app = frame.app.toLowerCase();
  return [
    'loginwindow',
    'captive network assistant',
    'cloudflare warp',
    'activity monitor',
    'system settings',
  ].includes(app);
}

function selectRepresentativePhases(phases: SessionPhase[], limit: number): SessionPhase[] {
  if (phases.length <= limit) return phases;
  const selected = new Set<SessionPhase>();
  selected.add(phases[0]!);
  selected.add(phases[phases.length - 1]!);
  const ranked = phases
    .slice(1, -1)
    .sort((a, b) => phaseImportance(b) - phaseImportance(a));
  for (const phase of ranked) {
    if (selected.size >= limit) break;
    selected.add(phase);
  }
  return phases.filter((phase) => selected.has(phase));
}

function phaseImportance(phase: SessionPhase): number {
  const frames = phase.frames;
  const durationMin = phaseDurationMs(phase) / 60_000;
  const hasCommunication = phase.key === 'communication' ? 4 : 0;
  const hasFiles = extractFilesFromFrames(frames, 1).length > 0 ? 2 : 0;
  const hasDomains = topValues(frames, (frame) => domainFromUrl(frame.url), 1).length > 0 ? 2 : 0;
  const nonNoise = frames[0] && !isNoisePhaseFrame(frames[0]) ? 1 : 0;
  return durationMin + frames.length * 0.35 + hasCommunication + hasFiles + hasDomains + nonNoise;
}

function renderSessionPhase(phase: SessionPhase): string {
  const frames = phase.frames;
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  const timeRange = phaseTimeRange(first, last);
  const duration = phaseDurationMs(phase);
  const action = inferSessionAction(frames) ?? describePhaseFallback(frames);
  const primaryEntity = phase.key === 'communication'
    ? topValues(
        frames,
        (frame) =>
          frame.entity_path?.startsWith('contacts/') || frame.entity_path?.startsWith('channels/')
            ? frame.entity_path
            : null,
        1,
      )[0]?.value
    : topValues(frames, (frame) => frame.entity_path, 1)[0]?.value;
  const primaryApp = topValues(frames, (frame) => frame.app, 1)[0]?.value;
  const target = primaryEntity ? formatJournalEntityReference(primaryEntity) : primaryApp ?? '(unknown)';
  const evidence = compactEvidence([
    extractFilesFromFrames(frames, 2).length
      ? `files ${extractFilesFromFrames(frames, 2).map((file) => `\`${file}\``).join(', ')}`
      : null,
    topValues(frames, (frame) => domainFromUrl(frame.url), 2).length
      ? `domains ${topValues(frames, (frame) => domainFromUrl(frame.url), 2).map((x) => x.value).join(', ')}`
      : null,
    representativeTitles(frames, 2).length
      ? `windows ${representativeTitles(frames, 2).map((title) => `"${title}"`).join(', ')}`
      : null,
  ]);
  const targetSuffix = shouldRenderPhaseTarget(action, target) ? ` via ${target}` : '';
  return `**${timeRange}** ${action}${targetSuffix}` +
    `${duration >= 30_000 ? ` _(${humaniseDuration(duration)})_` : ''}` +
    `${evidence ? ` (${evidence})` : ''}.`;
}

function shouldRenderPhaseTarget(action: string, target: string): boolean {
  if (!target || target === '(unknown)') return false;
  const actionText = action.toLowerCase();
  const targetText = target
    .replace(/^\[\[/, '')
    .replace(/\]\]$/, '')
    .split('/')
    .pop()
    ?.replace(/-/g, ' ')
    .toLowerCase();
  return Boolean(targetText && !actionText.includes(targetText));
}

function phaseTimeRange(first: Frame, last: Frame): string {
  const start = first.timestamp.slice(11, 16);
  const end = last.timestamp.slice(11, 16);
  if (start !== end) return `${start}-${end}`;
  return `${first.timestamp.slice(11, 19)}-${last.timestamp.slice(11, 19)}`;
}

function describePhaseFallback(frames: Frame[]): string {
  const entity = topValues(frames, (frame) => frame.entity_path, 1)[0]?.value;
  const app = topValues(frames, (frame) => frame.app, 1)[0]?.value;
  const communication = topValues(
    frames,
    (frame) =>
      frame.entity_path?.startsWith('contacts/') || frame.entity_path?.startsWith('channels/')
        ? frame.entity_path
        : frame.app === 'Mail'
          ? 'apps/mail'
          : null,
    1,
  )[0]?.value;
  if (communication) return `communicating via ${titleFromPath(communication)}`;
  if (entity?.startsWith('contacts/')) return `messaging ${titleFromPath(entity)}`;
  if (entity?.startsWith('channels/')) return `reviewing ${titleFromPath(entity)}`;
  if (app === 'Mail') return 'triaging email';
  if (app === 'Firefox' || app === 'firefox') return 'browsing web pages';
  if (app === 'Warp') return 'running terminal commands';
  if (app === 'Finder') return 'browsing files';
  return app ? `using ${app}` : 'working';
}

function renderDayOverview(
  frames: Frame[],
  sessions: ActivitySession[],
  lines: string[],
): void {
  const framesBySession = groupFramesByActivitySession(frames);
  const insights = sessions
    .slice()
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .map((session) => buildSessionInsight(session, framesBySession.get(session.id) ?? []))
    .filter((insight) => insight.frames.length > 0);

  lines.push('## What happened');
  if (insights.length > 0) {
    lines.push(...renderDayStoryParagraphs(insights, frames));
    const trail = renderConcreteTrail(insights, frames);
    if (trail.length > 0) {
      lines.push('');
      lines.push('### Concrete trail');
      lines.push(...trail);
    }
    lines.push('');
    return;
  }

  const action = inferSessionAction(frames);
  const topEntities = topValues(frames, (f) => f.entity_path, 3)
    .map((x) => formatJournalEntityReference(x.value));
  const artifacts = extractFilesFromFrames(frames, 5);
  const domains = topValues(frames, (frame) => domainFromUrl(frame.url), 3).map((x) => x.value);
  const context = compactEvidence([
    topEntities.length ? `centered on ${joinNatural(topEntities)}` : null,
    artifacts.length ? `with artifacts ${artifacts.map((file) => `\`${file}\``).join(', ')}` : null,
    domains.length ? `using web context from ${joinNatural(domains)}` : null,
  ]);
  if (action) {
    lines.push(`The captured frames suggest you were ${action}${context ? `, ${context}` : ''}.`);
  } else if (context) {
    lines.push(`The captured frames do not form a strong session story, but they do show activity ${context}.`);
  } else {
    lines.push('The capture does not contain enough structured signal to tell a reliable story yet; use the timeline below as raw evidence.');
  }
  const readable = firstReadableExcerpt(frames);
  if (readable) {
    lines.push(`Representative readable signal: "${readable}"`);
  }
  lines.push('');
}

interface SessionInsight {
  session: ActivitySession;
  frames: Frame[];
  action: string | null;
  confidence: 'high' | 'medium' | 'low';
  basis: string[];
  primaryTarget: string;
  communicationTargets: string[];
  files: string[];
  domains: string[];
}

function renderCrossSessionReport(
  frames: Frame[],
  sessions: ActivitySession[],
  lines: string[],
): void {
  if (sessions.length === 0) return;
  const framesBySession = groupFramesByActivitySession(frames);
  const insights = sessions
    .slice()
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .map((session) => buildSessionInsight(session, framesBySession.get(session.id) ?? []))
    .filter((insight) => insight.frames.length > 0);
  if (insights.length === 0) return;

  lines.push('## Chronological story');
  lines.push(...renderWorkArc(insights));

  const workstreams = renderWorkstreams(insights);
  if (workstreams.length > 0) {
    lines.push('');
    lines.push('### Supporting threads');
    lines.push(...workstreams);
  }
  const transitions = renderTransitions(insights);
  if (transitions.length > 0) {
    lines.push('');
    lines.push('### Transitions');
    lines.push(...transitions);
  }
  const followUps = renderFollowUpCandidates(insights);
  if (followUps.length > 0) {
    lines.push('');
    lines.push('### Follow-up candidates');
    lines.push(...followUps);
  }
  lines.push('');
}

function renderFocusMix(frames: Frame[]): string[] {
  const counts = new Map<string, number>();
  for (const frame of frames) {
    const category = focusCategory(frame);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([category, count]) => `${category} ${Math.round((count / Math.max(1, frames.length)) * 100)}%`);
}

function renderBrief(insights: SessionInsight[]): string[] {
  const workstreams = summarizeWorkstreams(insights)
    .filter((item) => item.activeMs >= 5 * 60_000 || item.files.length > 0 || item.communications.length > 0)
    .sort((a, b) => b.activeMs - a.activeMs);
  if (workstreams.length === 0) return [];
  const primary = workstreams[0]!;
  const comms = [...new Set(workstreams.flatMap((item) => item.communications))].slice(0, 5);
  const artifacts = [...new Set(workstreams.flatMap((item) => item.files))].slice(0, 5);
  const lines = [
    `- Primary workstream: ${primary.target} (${humaniseDuration(primary.activeMs)} across ${primary.sessions} session${primary.sessions === 1 ? '' : 's'}).`,
  ];
  if (artifacts.length > 0) {
    lines.push(`- Key artifacts: ${artifacts.map((file) => `\`${file}\``).join(', ')}.`);
  }
  if (comms.length > 0) {
    lines.push(`- Communication touched: ${comms.map(formatJournalEntityReference).join(', ')}.`);
  }
  return lines;
}

function renderDayStoryParagraphs(insights: SessionInsight[], frames: Frame[]): string[] {
  const workstreams = summarizeWorkstreams(insights)
    .filter((item) => item.activeMs >= 5 * 60_000 || item.files.length > 0 || item.communications.length > 0)
    .sort((a, b) => b.activeMs - a.activeMs);
  const primary = workstreams[0];
  const first = insights[0]!;
  const last = insights[insights.length - 1]!;
  const paragraphs: string[] = [];

  if (primary) {
    const actions = primary.actions.length
      ? joinNatural(primary.actions.slice(0, 3))
      : `focused work around ${primary.target}`;
    const evidence = compactEvidence([
      primary.files.length
        ? `the files ${primary.files.slice(0, 5).map((file) => `\`${file}\``).join(', ')}`
        : null,
      primary.domains.length
        ? `web context from ${joinNatural(primary.domains.slice(0, 3))}`
        : null,
      primary.communications.length
        ? `communication with ${joinNatural(primary.communications.slice(0, 4).map(formatJournalEntityReference))}`
        : null,
    ]);
    paragraphs.push(
      `The captured part of the day was centered on ${actions}.` +
        `${evidence ? ` The strongest evidence is ${evidence}` : ` The strongest entity signal is ${primary.target}`}` +
        `${evidence ? `, tied to ${primary.target}.` : '.'}`,
    );
  }

  const arc = selectNarrativeBeats(insights, 4).map(describeInsightBeat);
  if (arc.length > 0) {
    paragraphs.push(`Chronologically, ${joinNatural(arc)}.`);
  } else {
    paragraphs.push(`Chronologically, ${describeInsightBeat(first)}.`);
  }

  const communications = [...new Set(insights.flatMap((insight) => insight.communicationTargets))];
  if (communications.length > 0) {
    paragraphs.push(
      `The communication thread touched ${joinNatural(communications.slice(0, 5).map(formatJournalEntityReference))}. ` +
        `Given the nearby work context, those look like coordination or follow-up rather than standalone app usage.`,
    );
  } else if (first !== last) {
    paragraphs.push(
      `The story ends around ${last.session.started_at.slice(11, 16)}: you ${describeInsightAction(last)}; ` +
        `the evidence is mostly window titles, files, and entity attribution, so weaker claims stay tentative below.`,
    );
  }

  const readable = firstReadableExcerpt(frames);
  if (readable) {
    paragraphs.push(`A readable snippet from the capture says: "${readable}"`);
  }

  return paragraphs;
}

function renderConcreteTrail(insights: SessionInsight[], frames: Frame[]): string[] {
  const files = [...new Set(insights.flatMap((insight) => insight.files))].slice(0, 8);
  const communications = [...new Set(insights.flatMap((insight) => insight.communicationTargets))].slice(0, 6);
  const domains = [...new Set(insights.flatMap((insight) => insight.domains))].slice(0, 5);
  const titles = representativeTitles(frames, 5);
  const lines: string[] = [];
  if (files.length > 0) lines.push(`- Artifacts: ${files.map((file) => `\`${file}\``).join(', ')}.`);
  if (communications.length > 0) {
    lines.push(`- People/channels: ${communications.map(formatJournalEntityReference).join(', ')}.`);
  }
  if (domains.length > 0) lines.push(`- Web context: ${domains.join(', ')}.`);
  if (titles.length > 0) lines.push(`- Window evidence: ${titles.map((title) => `"${title}"`).join('; ')}.`);
  return lines;
}

function selectNarrativeBeats(insights: SessionInsight[], limit: number): SessionInsight[] {
  if (insights.length <= limit) return insights;
  const selected = new Set<SessionInsight>();
  selected.add(insights[0]!);
  selected.add(insights[insights.length - 1]!);
  const middle = insights
    .slice(1, -1)
    .sort((a, b) => insightImportance(b) - insightImportance(a));
  for (const insight of middle) {
    if (selected.size >= limit) break;
    selected.add(insight);
  }
  return insights.filter((insight) => selected.has(insight));
}

function insightImportance(insight: SessionInsight): number {
  return (insight.session.active_ms / 60_000) +
    insight.files.length * 2 +
    insight.communicationTargets.length * 3 +
    insight.domains.length +
    (insight.confidence === 'high' ? 2 : insight.confidence === 'medium' ? 1 : 0);
}

function describeInsightBeat(insight: SessionInsight): string {
  return `around ${insight.session.started_at.slice(11, 16)} you ${describeInsightAction(insight)}`;
}

function describeInsightAction(insight: SessionInsight): string {
  const action = formatActionTarget(insight.action, insight.primaryTarget);
  const evidence = compactEvidence([
    insight.files.length ? `files ${insight.files.map((file) => `\`${file}\``).join(', ')}` : null,
    insight.domains.length ? `domains ${insight.domains.join(', ')}` : null,
    insight.communicationTargets.length
      ? `comms ${insight.communicationTargets.map(formatJournalEntityReference).join(', ')}`
      : null,
  ]);
  return `were ${action}${evidence ? ` (${evidence})` : ''}`;
}

function joinNatural(values: string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

interface WorkstreamSummary {
  target: string;
  activeMs: number;
  sessions: number;
  actions: string[];
  files: string[];
  domains: string[];
  communications: string[];
}

function renderWorkstreams(insights: SessionInsight[]): string[] {
  return summarizeWorkstreams(insights)
    .filter((item) => item.activeMs >= 5 * 60_000 || item.files.length > 0 || item.communications.length > 0)
    .sort((a, b) => b.activeMs - a.activeMs)
    .slice(0, 6)
    .map((item) => {
      const details = compactEvidence([
        item.actions.length ? `actions ${item.actions.slice(0, 3).join('; ')}` : null,
        item.files.length ? `artifacts ${item.files.slice(0, 4).map((file) => `\`${file}\``).join(', ')}` : null,
        item.communications.length ? `comms ${item.communications.slice(0, 4).map(formatJournalEntityReference).join(', ')}` : null,
        item.domains.length ? `domains ${item.domains.slice(0, 3).join(', ')}` : null,
      ]);
      return `- ${item.target}: ${humaniseDuration(item.activeMs)} across ${item.sessions} session${item.sessions === 1 ? '' : 's'}` +
        `${details ? ` (${details})` : ''}.`;
    });
}

function summarizeWorkstreams(insights: SessionInsight[]): WorkstreamSummary[] {
  const grouped = new Map<string, WorkstreamSummary>();
  for (const insight of insights) {
    const current = grouped.get(insight.primaryTarget) ?? {
      target: insight.primaryTarget,
      activeMs: 0,
      sessions: 0,
      actions: [],
      files: [],
      domains: [],
      communications: [],
    };
    current.activeMs += insight.session.active_ms;
    current.sessions += 1;
    addUniqueString(current.actions, insight.action);
    for (const file of insight.files) addUniqueString(current.files, file);
    for (const domain of insight.domains) addUniqueString(current.domains, domain);
    for (const target of insight.communicationTargets) addUniqueString(current.communications, target);
    grouped.set(insight.primaryTarget, current);
  }
  return [...grouped.values()];
}

function addUniqueString(target: string[], value: string | null | undefined): void {
  if (!value || target.includes(value)) return;
  target.push(value);
}

function focusCategory(frame: Frame): string {
  const app = frame.app.toLowerCase();
  if (frame.entity_path?.startsWith('contacts/') || frame.entity_path?.startsWith('channels/')) {
    return 'communication';
  }
  if (app === 'mail' || app === 'slack' || app.includes('whatsapp')) return 'communication';
  if (app === 'cursor' || app === 'warp' || app === 'electron') return 'development';
  if (app === 'firefox' || app === 'google chrome' || app === 'safari') return 'web/research';
  if (app === 'finder') return 'files';
  if (app === 'claude') return 'assistant';
  return 'other';
}

function groupFramesByActivitySession(frames: Frame[]): Map<string, Frame[]> {
  const bySession = new Map<string, Frame[]>();
  for (const frame of frames) {
    const key = frame.activity_session_id ?? '__loose__';
    const existing = bySession.get(key);
    if (existing) existing.push(frame);
    else bySession.set(key, [frame]);
  }
  return bySession;
}

function buildSessionInsight(session: ActivitySession, frames: Frame[]): SessionInsight {
  const communicationTargets = topValues(
    frames,
    (frame) => {
      if (!frame.entity_path) return null;
      if (frame.entity_path.startsWith('contacts/') || frame.entity_path.startsWith('channels/')) {
        return frame.entity_path;
      }
      if (frame.app === 'Mail') return 'apps/mail';
      return null;
    },
    3,
  ).map((x) => x.value);

  const domains = topValues(frames, (frame) => domainFromUrl(frame.url), 3).map((x) => x.value);
  const target = sessionTarget(session, frames);
  const inference = inferSessionInference(frames);

  return {
    session,
    frames,
    action: inferSessionAction(frames),
    confidence: inference?.confidence ?? fallbackConfidence(frames),
    basis: inference?.basis ?? fallbackBasis(frames),
    primaryTarget: target,
    communicationTargets,
    files: extractFilesFromFrames(frames, 3),
    domains,
  };
}

function sessionTarget(session: ActivitySession, frames: Frame[]): string {
  if (!session.primary_entity_path) {
    return session.primary_app ? appTarget(session.primary_app) : '(unknown)';
  }
  if (session.primary_entity_kind === 'app') {
    const topApp = topValues(frames, (frame) => frame.app, 1)[0];
    const appEntityTail = session.primary_entity_path.split('/').pop()?.toLowerCase();
    const topAppNormalised = topApp?.value.toLowerCase().replace(/\s+/g, '-');
    if (topApp && appEntityTail && topAppNormalised && appEntityTail !== topAppNormalised) {
      return appTarget(topApp.value);
    }
  }
  return formatJournalEntityReference(session.primary_entity_path);
}

function appTarget(app: string): string {
  return app;
}

function formatJournalEntityReference(entityPath: string): string {
  if (entityPath.startsWith('apps/')) return titleFromPath(entityPath);
  return `[[${entityPath}]]`;
}

function slugifyForPath(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function renderWorkArc(insights: SessionInsight[]): string[] {
  const important = insights
    .filter((insight) => insight.action || insight.session.active_ms >= 5 * 60_000)
    .slice(0, 8);
  const selected = important.length > 0 ? important : insights.slice(0, 5);
  return selected.map((insight) => {
    const window = `${insight.session.started_at.slice(11, 16)}-${insight.session.ended_at.slice(11, 16)}`;
    const artifacts = compactEvidence([
      insight.files.length ? `files ${insight.files.map((file) => `\`${file}\``).join(', ')}` : null,
      insight.domains.length ? `domains ${insight.domains.join(', ')}` : null,
      insight.communicationTargets.length
        ? `communication ${insight.communicationTargets.map(formatJournalEntityReference).join(', ')}`
        : null,
    ]);
    return `- **${window}** You ${describeInsightAction(insight)}.` +
      `${artifacts ? ` Evidence: ${artifacts}.` : ''}` +
      ` _Confidence: ${insight.confidence}; based on ${insight.basis.join(', ')}._`;
  });
}

function formatActionTarget(action: string | null, target: string): string {
  const fallback = `focused on ${target}`;
  if (!action) return fallback;
  const normalizedAction = action.toLowerCase();
  const normalizedTarget = target
    .replace(/^\[\[/, '')
    .replace(/\]\]$/, '')
    .split('/')
    .pop()
    ?.replace(/-/g, ' ')
    .toLowerCase();
  if (normalizedTarget && normalizedAction.includes(normalizedTarget)) return action;
  return `${action} on ${target}`;
}

function renderTransitions(insights: SessionInsight[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < insights.length; i++) {
    const prev = insights[i - 1]!;
    const next = insights[i]!;
    const gapMs = Date.parse(next.session.started_at) - Date.parse(prev.session.ended_at);
    const handoff = inferTransition(prev, next, gapMs);
    if (handoff) out.push(`- ${handoff}`);
    if (out.length >= 5) break;
  }
  return out;
}

function renderFollowUpCandidates(insights: SessionInsight[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < insights.length; i++) {
    const prev = insights[i - 1]!;
    const next = insights[i]!;
    if (next.communicationTargets.length === 0) continue;
    const prevAction = prev.action ?? `focused on ${prev.primaryTarget}`;
    if (!isWorkAction(prevAction)) continue;
    const targets = next.communicationTargets.slice(0, 4).map(formatJournalEntityReference).join(', ');
    const files = next.files.length ? `; artifacts nearby: ${next.files.map((file) => `\`${file}\``).join(', ')}` : '';
    out.push(`- ${next.session.started_at.slice(11, 16)}: communication with ${targets} followed ${prevAction}${files}.`);
    if (out.length >= 5) break;
  }
  return out;
}

function inferTransition(
  prev: SessionInsight,
  next: SessionInsight,
  gapMs: number,
): string | null {
  const prevAction = prev.action ?? `focused on ${prev.primaryTarget}`;
  const nextAction = next.action ?? `focused on ${next.primaryTarget}`;
  const gap = gapMs >= 2 * 60_000 ? ` after ${humaniseDuration(gapMs)} idle` : '';

  if (next.communicationTargets.length > 0 && isWorkAction(prevAction)) {
    const targets = next.communicationTargets.map(formatJournalEntityReference).join(', ');
    return `${next.session.started_at.slice(11, 16)}${gap}: after ${formatActionTarget(prev.action, prev.primaryTarget)}, shifted into communication with ${targets}; likely follow-up or coordination around the previous work.`;
  }

  if (isBuildAction(prevAction) && isReviewAction(nextAction)) {
    return `${next.session.started_at.slice(11, 16)}${gap}: moved from building/running the app to reviewing or auditing the resulting work.`;
  }

  if (isReviewAction(prevAction) && isBuildAction(nextAction)) {
    return `${next.session.started_at.slice(11, 16)}${gap}: moved from review back into implementation/testing.`;
  }

  if (prev.primaryTarget !== next.primaryTarget && prev.action && next.action) {
    return `${next.session.started_at.slice(11, 16)}${gap}: switched from ${formatActionTarget(prev.action, prev.primaryTarget)} to ${formatActionTarget(next.action, next.primaryTarget)}.`;
  }

  return null;
}

function compactEvidence(parts: Array<string | null>): string {
  return parts.filter((part): part is string => Boolean(part)).join('; ');
}

function isWorkAction(action: string): boolean {
  return /working|building|running|designing|reviewing|auditing|improving|implementation|testing/i.test(action);
}

function isBuildAction(action: string): boolean {
  return /building|running|implementation|testing|terminal/i.test(action);
}

function isReviewAction(action: string): boolean {
  return /reviewing|auditing|proposal|export|mcp|wiki/i.test(action);
}

function describeSessionContext(frames: Frame[]): string | null {
  const parts: string[] = [];
  const action = inferSessionAction(frames);
  if (action) parts.push(`likely doing: ${action}`);

  const apps = topValues(frames, (f) => f.app, 3).map((x) => x.value);
  if (apps.length) parts.push(`mostly ${apps.join(', ')}`);

  const entities = topValues(frames, (f) => f.entity_path, 3)
    .map((x) => formatJournalEntityReference(x.value));
  if (entities.length) parts.push(`centered on ${entities.join(', ')}`);

  const titles = representativeTitles(frames, 3);
  if (titles.length) parts.push(`windows: ${titles.map((t) => `"${t}"`).join(', ')}`);

  const readable = firstReadableExcerpt(frames);
  if (readable) parts.push(`signal: "${readable}"`);

  const metadata = inferMetadataEvidence(frames);
  if (metadata.length) parts.push(`evidence: ${metadata.join(', ')}`);

  return parts.length ? parts.join('; ') : null;
}

function inferSessionAction(frames: Frame[]): string | null {
  return inferSessionInference(frames)?.label ?? inferFallbackAction(frames);
}

interface SessionInference {
  label: string;
  confidence: 'high' | 'medium' | 'low';
  basis: string[];
}

function inferSessionInference(frames: Frame[]): SessionInference | null {
  if (frames.length === 0) return null;
  const scored = INFERENCE_RULES
    .map((rule) => scoreRule(frames, rule))
    .filter((score): score is RuleScore => Boolean(score))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return null;
  return {
    label: best.rule.label,
    confidence: best.confidence,
    basis: best.basis,
  };
}

function inferFallbackAction(frames: Frame[]): string | null {
  if (frames.length === 0) return null;
  const primaryEntity = topValues(frames, (f) => f.entity_path, 1)[0]?.value;
  const primaryApp = topValues(frames, (f) => f.app, 1)[0]?.value;
  const files = extractFilesFromFrames(frames, 2);
  const projectEntities = topValues(
    frames,
    (f) => f.entity_path?.startsWith('projects/') ? f.entity_path : null,
    2,
  ).map((x) => x.value);
  const project = projectEntities[0] ? titleFromPath(projectEntities[0]) : null;

  if (files.length > 0 && project) {
    return `working on ${project} files (${files.map((f) => `\`${f}\``).join(', ')})`;
  }

  if (primaryEntity?.startsWith('projects/')) {
    const project = titleFromPath(primaryEntity);
    return files.length
      ? `working on ${project} files (${files.map((f) => `\`${f}\``).join(', ')})`
      : `working on ${project}`;
  }
  if (primaryEntity?.startsWith('channels/')) {
    return `reviewing Slack channel ${titleFromPath(primaryEntity)}`;
  }
  if (primaryEntity?.startsWith('contacts/')) {
    return `reviewing or messaging ${titleFromPath(primaryEntity)} in Slack`;
  }
  if (primaryEntity?.startsWith('apps/')) {
    return `using ${titleFromPath(primaryEntity)}`;
  }
  if (primaryApp === 'Mail') return 'triaging email';
  if (primaryApp === 'Cursor') return files.length ? `working in Cursor on ${files.map((f) => `\`${f}\``).join(', ')}` : 'working in Cursor';
  if (primaryApp === 'Warp') return 'running terminal commands';
  if (primaryApp === 'Finder') return 'browsing files in Finder';
  if (primaryApp === 'Claude') return 'using Claude for assistant work';
  const domains = topValues(frames, (f) => domainFromUrl(f.url), 2).map((x) => x.value);
  if (domains.length && isBrowserApp(primaryApp)) return `browsing ${domains.join(' and ')}`;
  if (primaryApp) return `using ${primaryApp}`;
  return null;
}

function isBrowserApp(app: string | null | undefined): boolean {
  return app === 'Firefox' || app === 'firefox' || app === 'Google Chrome' || app === 'Safari';
}

function fallbackConfidence(frames: Frame[]): 'high' | 'medium' | 'low' {
  if (frames.length >= 10 && representativeTitles(frames, 1).length > 0) return 'medium';
  return 'low';
}

function fallbackBasis(frames: Frame[]): string[] {
  const basis = [
    representativeTitles(frames, 1)[0] ? 'window titles' : null,
    topValues(frames, (frame) => frame.entity_path, 1)[0] ? 'entity attribution' : null,
    topValues(frames, (frame) => frame.app, 1)[0] ? 'app focus' : null,
  ].filter((x): x is string => Boolean(x));
  return basis.length ? basis : ['activity timing'];
}

interface InferenceRule {
  test: string[];
  label: string;
  minRatio?: number;
  primaryApps?: string[];
  primaryEntityPrefixes?: string[];
}

interface RuleScore {
  rule: InferenceRule;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  basis: string[];
}

const INFERENCE_RULES: InferenceRule[] = [
  {
    test: ['indexed journal', 'journal narrative', 'what happened', 'day story'],
    label: 'improving the indexed journal narrative',
    minRatio: 0.08,
    primaryEntityPrefixes: ['projects/cofounderos'],
  },
  {
    test: ['redesign app interface for modern ux', 'modern ux', 'app interface'],
    label: 'redesigning the CofounderOS app interface',
    minRatio: 0.08,
  },
  {
    test: ['karpathy wiki proposal', 'llm wiki'],
    label: 'reviewing the Karpathy/wiki indexing proposal',
    minRatio: 0.18,
  },
  {
    test: ['mcp server', 'llm tools'],
    label: 'auditing MCP tools for agent access',
    minRatio: 0.18,
  },
  {
    test: ['ask-first home', 'home redesign', 'user experience optimization'],
    label: 'working on the app user experience',
    minRatio: 0.18,
  },
  {
    test: ['desktop app design', 'desktop-app-design'],
    label: 'designing the CofounderOS desktop app',
    minRatio: 0.12,
    primaryEntityPrefixes: ['projects/cofounderos'],
  },
  {
    test: ['promotion nomination template', 'copy of promotion nomination'],
    label: 'working on a promotion nomination document',
    minRatio: 0.15,
  },
  {
    test: ['config.yaml', 'cofounderos/config.yaml'],
    label: 'editing CofounderOS configuration',
    minRatio: 0.25,
    primaryEntityPrefixes: ['projects/config-yaml'],
  },
  {
    test: ['export/markdown', 'output /export/markdown', 'actually useful export'],
    label: 'auditing and improving the Markdown export',
    minRatio: 0.18,
  },
  {
    test: ['pnpm build', 'pnpm start', 'pnpm run'],
    label: 'building and running the app from the terminal',
    minRatio: 0.12,
    primaryApps: ['Warp', 'Electron'],
  },
  {
    test: ['all inboxes', 'unread messages'],
    label: 'triaging email inboxes',
    minRatio: 0.35,
    primaryApps: ['Mail'],
    primaryEntityPrefixes: ['apps/mail'],
  },
  {
    test: ['calendar.google.com', 'google meet'],
    label: 'checking calendar and meeting context',
    minRatio: 0.25,
  },
  {
    test: ['youtube.com', 'youtube'],
    label: 'watching or searching YouTube',
    minRatio: 0.35,
    primaryApps: ['Firefox', 'firefox', 'Google Chrome'],
  },
  {
    test: ['booking.com', 'bankrate.com', 'trust.docx'],
    label: 'browsing web research pages',
    minRatio: 0.25,
    primaryApps: ['Firefox', 'firefox', 'Google Chrome'],
  },
];

function scoreRule(frames: Frame[], rule: InferenceRule): RuleScore | null {
  const frameMatches = frames
    .map((frame) => ({
      frame,
      matches: rule.test.filter((needle) => buildFrameInferenceText(frame).includes(needle)),
    }))
    .filter((entry) => entry.matches.length > 0);
  if (frameMatches.length === 0) return null;

  const ratio = frameMatches.length / Math.max(1, frames.length);
  const primaryApp = topValues(frames, (frame) => frame.app, 1)[0]?.value;
  const primaryEntity = topValues(frames, (frame) => frame.entity_path, 1)[0]?.value;
  const appPrimary = Boolean(primaryApp && rule.primaryApps?.includes(primaryApp));
  const entityPrimary = Boolean(
    primaryEntity && rule.primaryEntityPrefixes?.some((prefix) => primaryEntity.startsWith(prefix)),
  );
  const minRatio = rule.minRatio ?? 0.18;
  if (!appPrimary && !entityPrimary && ratio < minRatio) return null;

  const basis = [...new Set(frameMatches.flatMap((entry) => entry.matches))].slice(0, 3);
  const titleHits = frameMatches.filter((entry) =>
    basis.some((needle) => (entry.frame.window_title ?? '').toLowerCase().includes(needle)),
  ).length;
  const urlHits = frameMatches.filter((entry) =>
    basis.some((needle) => (entry.frame.url ?? '').toLowerCase().includes(needle)),
  ).length;
  const confidence = ratio >= 0.45 || titleHits >= 8
    ? 'high'
    : ratio >= minRatio || appPrimary || entityPrimary || titleHits > 0 || urlHits > 0
      ? 'medium'
      : 'low';
  const score = frameMatches.length + ratio * 10 + (appPrimary ? 4 : 0) + (entityPrimary ? 4 : 0) + titleHits * 0.5 + urlHits * 0.5;
  return { rule, score, confidence, basis };
}

function buildInferenceText(frames: Frame[]): string {
  return frames.map(buildFrameInferenceText).join(' ');
}

function buildFrameInferenceText(frame: Frame): string {
  return [
    frame.app,
    frame.window_title,
    frame.url,
    frame.entity_path,
    frame.text_source === 'accessibility' || frame.text_source === 'audio'
      ? frame.text
      : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function inferMetadataEvidence(frames: Frame[]): string[] {
  const evidence: string[] = [];
  const files = extractFilesFromFrames(frames, 3);
  const domains = topValues(frames, (f) => domainFromUrl(f.url), 3).map((x) => x.value);
  const triggers = topValues(frames, (f) => f.trigger, 2).map((x) => x.value);
  const textSources = topValues(frames, (f) => f.text_source, 2).map((x) => x.value);
  if (files.length) evidence.push(`files ${files.map((f) => `\`${f}\``).join(', ')}`);
  if (domains.length) evidence.push(`domains ${domains.join(', ')}`);
  if (triggers.length) evidence.push(`capture triggers ${triggers.join(', ')}`);
  if (textSources.length) evidence.push(`text sources ${textSources.join(', ')}`);
  return evidence;
}

function extractFilesFromFrames(frames: Frame[], limit: number): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const frame of frames) {
    const match = frame.window_title?.match(/(?:^|[\s●○•])([A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})\b/);
    const file = match?.[1];
    if (!file || !looksLikeRealFile(file) || seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    if (files.length >= limit) break;
  }
  return files;
}

const JOURNAL_FILE_EXTENSIONS = new Set([
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
  if (!ext || !JOURNAL_FILE_EXTENSIONS.has(ext)) return false;
  if (/^[a-z]+\.com$/i.test(name)) return false;
  if (/^[a-z]+\.io$/i.test(name)) return false;
  return true;
}

function domainFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function titleFromPath(entityPath: string): string {
  const tail = entityPath.split('/').pop() ?? entityPath;
  return tail
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function representativeTitles(frames: Frame[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of frames) {
    const title = f.window_title?.replace(/\s+/g, ' ').trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    out.push(truncateText(title, 70));
    if (out.length >= limit) break;
  }
  return out;
}

function firstReadableExcerpt(frames: Frame[]): string | null {
  for (const f of frames) {
    const text = readableFrameText(f);
    if (text) return truncateText(text, 180);
  }
  return null;
}

function readableFrameText(frame: Frame): string | null {
  if (frame.text_source !== 'accessibility' && frame.text_source !== 'audio') return null;
  if (!frame.text) return null;
  const cleaned = frame.text.replace(/\s+/g, ' ').trim();
  if (cleaned.length < 30) return null;
  const chars = cleaned.replace(/\s/g, '');
  if (!chars) return null;
  const readable = chars.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (readable / chars.length < 0.55) return null;
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const usefulWords = cleaned.match(/[\p{L}\p{N}][\p{L}\p{N}'._/-]{2,}/gu) ?? [];
  if (usefulWords.length < 5) return null;
  const shortTokens = tokens.filter((token) => token.replace(/[^\p{L}\p{N}]/gu, '').length <= 2);
  if (tokens.length > 0 && shortTokens.length / tokens.length > 0.45) return null;
  return truncateText(cleaned, 200);
}

function topValues(
  frames: Frame[],
  picker: (frame: Frame) => string | null | undefined,
  limit: number,
): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const frame of frames) {
    const value = picker(frame);
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function humaniseDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Render a "Meetings" digest section at the top of the journal,
 * inlining each meeting's summary_md when available. Skipped when no
 * meetings overlap the day; for meetings without a summary yet we still
 * emit a one-line entry so the user knows it was captured.
 */
function renderMeetingsBlock(meetings: Meeting[], lines: string[]): void {
  if (meetings.length === 0) return;
  const sorted = meetings
    .slice()
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  lines.push(`## Meetings (${sorted.length})`);
  lines.push('');
  for (const m of sorted) {
    if (m.summary_md && m.summary_md.trim()) {
      lines.push(m.summary_md.trim());
      lines.push('');
      continue;
    }
    const start = m.started_at.slice(11, 16);
    const end = m.ended_at.slice(11, 16);
    const dur = Math.max(1, Math.round(m.duration_ms / 60_000));
    const status =
      m.summary_status === 'pending'
        ? '_(summary pending)_'
        : m.summary_status === 'running'
          ? '_(summary in progress)_'
          : m.summary_status === 'failed'
            ? `_(summary failed: ${m.failure_reason ?? 'unknown'})_`
            : m.summary_status === 'skipped_short'
              ? '_(skipped — short meeting / no audio)_'
              : '';
    lines.push(
      `- **${start}-${end}** · [[${m.entity_path}]] · ${dur} min · ${m.platform} ${status}`,
    );
  }
  lines.push('');
}
