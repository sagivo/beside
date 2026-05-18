import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  IStorage,
  RawEvent,
  StorageQuery,
  StorageStats,
  Frame,
  FrameDeleteQuery,
  FrameQuery,
  FrameEmbeddingTask,
  FrameSemanticMatch,
  FrameOcrTask,
  FrameTextSource,
  FrameAsset,
  FrameAssetTier,
  MemoryChunk,
  MemoryChunkEmbeddingTask,
  MemoryChunkKind,
  MemoryChunkQuery,
  MemoryChunkSemanticMatch,
  MemoryIndexStats,
  EntityRef,
  EntityRecord,
  EntityKind,
  ListEntitiesQuery,
  SearchEntitiesQuery,
  EntityCoOccurrence,
  EntityTimelineBucket,
  EntityTimelineQuery,
  ActivitySession,
  ListSessionsQuery,
  Meeting,
  MeetingPlatform,
  MeetingSummaryStatus,
  MeetingSummaryJson,
  MeetingSummaryUpdate,
  MeetingTurn,
  ListMeetingsQuery,
  DayEvent,
  DayEventKind,
  DayEventSource,
  DayEventStatus,
  ListDayEventsQuery,
  CalendarSource,
  CalendarCapture,
  CalendarEvent,
  CalendarEventStatus,
  ListCalendarEventsQuery,
  CalendarReconcileInput,
  CalendarReconcileResult,
  HookRecord,
  HookRecordQuery,
  PluginFactory,
  Logger,
} from '@beside/interfaces';
import { dayKey, expandPath, ensureDir } from '@beside/core';

interface LocalStorageConfig {
  path?: string;
  max_size_gb?: number;
  retention_days?: number;
}

const MAX_EMBEDDING_TEXT_CHARS = 1200;
const ASSET_BYTES_CACHE_TTL_MS = 5 * 60_000;
const CACHEABLE_SCREENSHOT_EXTENSIONS = new Set(['.webp']);
// Cap the in-memory parsed-meeting cache. Meetings are paginated 200
// at a time in listMeetings, so 256 covers two pages plus headroom.
// Each entry is the fully parsed Meeting object (summary_json,
// attendees, links) -- a few KB each, bounded total memory.
const MEETING_PARSE_CACHE_CAP = 256;
const FLAT_INTERNED_SCREENSHOT_RE =
  /^raw\/\d{4}-\d{2}-\d{2}\/screenshots\/[a-f0-9]{64}\.webp$/i;
const LEGACY_INTERNED_SCREENSHOT_MARKER = '/screenshots/_cache/sha256/';

interface FrameFtsFrameRow {
  text: string | null;
  text_source: string | null;
  window_title: string | null;
  url: string | null;
  app: string | null;
  entity_path: string | null;
  entity_kind: string | null;
}

interface HookRecordRow {
  hook_id: string;
  collection: string;
  id: string;
  data_json: string;
  evidence_ids_json: string;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
}

function hookRecordFromRow(row: HookRecordRow): HookRecord {
  let data: unknown = null;
  try {
    data = JSON.parse(row.data_json);
  } catch {
    data = null;
  }
  let evidenceEventIds: string[] = [];
  try {
    const parsed = JSON.parse(row.evidence_ids_json);
    if (Array.isArray(parsed)) {
      evidenceEventIds = parsed.filter((v) => typeof v === 'string');
    }
  } catch {
    evidenceEventIds = [];
  }
  return {
    hookId: row.hook_id,
    collection: row.collection,
    id: row.id,
    data,
    evidenceEventIds,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface DayEventRow {
  id: string;
  day: string;
  starts_at: string;
  ends_at: string | null;
  kind: string;
  source: string;
  title: string;
  source_app: string | null;
  context_md: string | null;
  attendees_json: string;
  links_json: string;
  meeting_id: string | null;
  evidence_frame_ids_json: string;
  content_hash: string;
  status: string;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface CalendarSourceRow {
  source_key: string;
  provider: string;
  label: string;
  app: string | null;
  app_bundle_id: string | null;
  url_host: string | null;
  created_at: string;
  updated_at: string;
}

interface CalendarCaptureRow {
  id: string;
  source_key: string;
  day: string;
  captured_at: string;
  frame_ids_json: string;
  evidence_hash: string;
  parser: string;
  status: string;
  confidence: number;
  visible_days_json: string;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface CalendarEventRow {
  id: string;
  source_key: string;
  provider: string;
  day: string;
  starts_at: string;
  ends_at: string | null;
  title: string;
  location: string | null;
  attendees_json: string;
  links_json: string;
  notes: string | null;
  source_app: string | null;
  source_url: string | null;
  source_bundle_id: string | null;
  evidence_frame_ids_json: string;
  first_seen_capture_id: string | null;
  last_seen_capture_id: string | null;
  status: string;
  content_hash: string;
  meeting_id: string | null;
  actual_started_at: string | null;
  actual_ended_at: string | null;
  meeting_platform: string | null;
  meeting_summary_status: string | null;
  created_at: string;
  updated_at: string;
}

interface MemoryChunkRow {
  id: string;
  kind: string;
  source_id: string;
  title: string;
  body: string;
  entity_path: string | null;
  entity_kind: string | null;
  day: string | null;
  timestamp: string | null;
  source_refs_json: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

function memoryChunkFromRow(row: MemoryChunkRow): MemoryChunk {
  let sourceRefs: string[] = [];
  try {
    const parsed = JSON.parse(row.source_refs_json);
    if (Array.isArray(parsed)) {
      sourceRefs = parsed.filter((v): v is string => typeof v === 'string');
    }
  } catch {
    sourceRefs = [];
  }
  return {
    id: row.id,
    kind: row.kind as MemoryChunkKind,
    sourceId: row.source_id,
    title: row.title,
    body: row.body,
    entityPath: row.entity_path,
    entityKind: (row.entity_kind as MemoryChunk['entityKind']) ?? null,
    day: row.day,
    timestamp: row.timestamp,
    sourceRefs,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function dayEventFromRow(row: DayEventRow): DayEvent {
  return {
    id: row.id,
    day: row.day,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    kind: row.kind as DayEventKind,
    source: row.source as DayEventSource,
    title: row.title,
    source_app: row.source_app,
    context_md: row.context_md,
    attendees: parseJsonStringArray(row.attendees_json),
    links: parseJsonStringArray(row.links_json),
    meeting_id: row.meeting_id,
    evidence_frame_ids: parseJsonStringArray(row.evidence_frame_ids_json),
    content_hash: row.content_hash,
    status: row.status as DayEventStatus,
    failure_reason: row.failure_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function calendarSourceFromRow(row: CalendarSourceRow): CalendarSource {
  return { ...row };
}

function calendarCaptureFromRow(row: CalendarCaptureRow): CalendarCapture {
  return {
    id: row.id,
    source_key: row.source_key,
    day: row.day,
    captured_at: row.captured_at,
    frame_ids: parseJsonStringArray(row.frame_ids_json),
    evidence_hash: row.evidence_hash,
    parser: row.parser,
    status: row.status as CalendarCapture['status'],
    confidence: row.confidence,
    visible_days: parseJsonStringArray(row.visible_days_json),
    failure_reason: row.failure_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function calendarEventFromRow(row: CalendarEventRow): CalendarEvent {
  return {
    id: row.id,
    source_key: row.source_key,
    provider: row.provider,
    day: row.day,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    title: row.title,
    location: row.location,
    attendees: parseJsonStringArray(row.attendees_json),
    links: parseJsonStringArray(row.links_json),
    notes: row.notes,
    source_app: row.source_app,
    source_url: row.source_url,
    source_bundle_id: row.source_bundle_id,
    evidence_frame_ids: parseJsonStringArray(row.evidence_frame_ids_json),
    first_seen_capture_id: row.first_seen_capture_id,
    last_seen_capture_id: row.last_seen_capture_id,
    status: row.status as CalendarEventStatus,
    content_hash: row.content_hash,
    meeting_id: row.meeting_id,
    actual_started_at: row.actual_started_at,
    actual_ended_at: row.actual_ended_at,
    meeting_platform: row.meeting_platform as CalendarEvent['meeting_platform'],
    meeting_summary_status: row.meeting_summary_status as CalendarEvent['meeting_summary_status'],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string')
      : [];
  } catch {
    return [];
  }
}

class LocalStorage implements IStorage {
  private readonly root: string;
  private readonly logger: Logger;
  private db!: Database.Database;
  private readonly writeStreams = new Map<string, fs.WriteStream>();
  private frameFtsInsertStmt: Database.Statement | null = null;
  private frameFtsUpdateStmt: Database.Statement | null = null;
  private frameFtsFrameSelectStmt: Database.Statement | null = null;
  private resolveFrameTagStmt: Database.Statement | null = null;
  private resolveFrameSelectStmt: Database.Statement | null = null;
  private resolveEntityUpsertStmt: Database.Statement | null = null;
  // Parsed-Meeting LRU. Key: `${id}|${updated_at}`. Both meeting
  // upsert paths bump updated_at on every write, so the key naturally
  // shifts when the row mutates -- no separate invalidation needed.
  private readonly meetingParseCache = new Map<string, Meeting>();
  private assetBytesCache: { value: number; expiresAt: number } | null = null;

  constructor(root: string, logger: Logger) {
    this.root = root;
    this.logger = logger.child('storage-local');
  }

  async init(): Promise<void> {
    await ensureDir(this.root);
    await ensureDir(path.join(this.root, 'raw'));
    await ensureDir(path.join(this.root, 'checkpoints'));
    await this.openDb();
  }

  getRoot(): string {
    return this.root;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await fsp.access(this.root, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  async write(event: RawEvent): Promise<void> {
    const normalisedEvent = normaliseEventTimestamp(event);
    const storedEvent = await this.internScreenshotAsset(normalisedEvent);
    if (storedEvent !== event) {
      // The orchestrator publishes the same object after storage.write().
      // Keep it in sync so downstream workers see the canonical asset path.
      Object.assign(event, storedEvent);
    }

    const day = dayKey(new Date(storedEvent.timestamp));
    const dayDir = path.join(this.root, 'raw', day);
    await ensureDir(dayDir);
    const jsonlPath = path.join(dayDir, 'events.jsonl');
    const stream = this.getStream(jsonlPath);

    await new Promise<void>((resolve, reject) => {
      stream.write(JSON.stringify(storedEvent) + '\n', (err) =>
        err ? reject(err) : resolve(),
      );
    });

    this.upsertEventRow(storedEvent, day);
  }

  async writeAsset(assetPath: string, data: Buffer): Promise<void> {
    const abs = this.absoluteAssetPath(assetPath);
    await ensureDir(path.dirname(abs));
    await fsp.writeFile(abs, data);
    this.invalidateAssetBytesCache();
  }

  async readAsset(assetPath: string): Promise<Buffer> {
    return await fsp.readFile(this.absoluteAssetPath(assetPath));
  }

  async readEvents(query: StorageQuery): Promise<RawEvent[]> {
    const sql: string[] = [`SELECT ${EVENT_SELECT_COLUMNS} FROM events WHERE 1=1`];
    const params: Record<string, unknown> = {};

    if (query.ids?.length) {
      sql.push(`AND id IN (${query.ids.map((_, i) => `@id_${i}`).join(',')})`);
      query.ids.forEach((id, i) => {
        params[`id_${i}`] = id;
      });
    }
    if (query.from) {
      sql.push('AND timestamp >= @from_ts');
      params.from_ts = query.from;
    }
    if (query.to) {
      sql.push('AND timestamp <= @to_ts');
      params.to_ts = query.to;
    }
    if (query.types?.length) {
      sql.push(`AND type IN (${query.types.map((_, i) => `@type_${i}`).join(',')})`);
      query.types.forEach((t, i) => {
        params[`type_${i}`] = t;
      });
    }
    if (query.apps?.length) {
      sql.push(`AND app IN (${query.apps.map((_, i) => `@app_${i}`).join(',')})`);
      query.apps.forEach((a, i) => {
        params[`app_${i}`] = a;
      });
    }
    if (query.since_checkpoint) {
      sql.push('AND id > @cp');
      params.cp = query.since_checkpoint;
    }
    if (query.unindexed_for_strategy) {
      // High-water mark: anything strictly newer than the strategy's
      // last marked event is unindexed. COALESCE handles the "never
      // indexed" case (returns '' so all events qualify).
      sql.push(
        "AND id > COALESCE((SELECT last_event_id FROM index_state WHERE strategy = @strat), '')",
      );
      params.strat = query.unindexed_for_strategy;
    }
    if (query.unframed_only) {
      sql.push('AND framed_at IS NULL');
    }

    sql.push('ORDER BY id ASC');
    if (query.limit) {
      sql.push(`LIMIT ${Math.max(1, Math.floor(query.limit))}`);
    }
    if (query.offset) {
      sql.push(`OFFSET ${Math.max(0, Math.floor(query.offset))}`);
    }

    const rows = this.db.prepare(sql.join(' ')).all(params) as RawEventRow[];
    return rows.map(rowToEvent);
  }

  async countEvents(query: StorageQuery): Promise<number> {
    const sql: string[] = ['SELECT COUNT(*) AS n FROM events WHERE 1=1'];
    const params: Record<string, unknown> = {};

    if (query.ids?.length) {
      sql.push(`AND id IN (${query.ids.map((_, i) => `@id_${i}`).join(',')})`);
      query.ids.forEach((id, i) => {
        params[`id_${i}`] = id;
      });
    }
    if (query.from) {
      sql.push('AND timestamp >= @from_ts');
      params.from_ts = query.from;
    }
    if (query.to) {
      sql.push('AND timestamp <= @to_ts');
      params.to_ts = query.to;
    }
    if (query.types?.length) {
      sql.push(`AND type IN (${query.types.map((_, i) => `@type_${i}`).join(',')})`);
      query.types.forEach((t, i) => {
        params[`type_${i}`] = t;
      });
    }
    if (query.apps?.length) {
      sql.push(`AND app IN (${query.apps.map((_, i) => `@app_${i}`).join(',')})`);
      query.apps.forEach((a, i) => {
        params[`app_${i}`] = a;
      });
    }
    if (query.since_checkpoint) {
      sql.push('AND id > @cp');
      params.cp = query.since_checkpoint;
    }
    if (query.unindexed_for_strategy) {
      sql.push(
        "AND id > COALESCE((SELECT last_event_id FROM index_state WHERE strategy = @strat), '')",
      );
      params.strat = query.unindexed_for_strategy;
    }
    if (query.unframed_only) {
      sql.push('AND framed_at IS NULL');
    }

    const row = this.db.prepare(sql.join(' ')).get(params) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  async listDays(): Promise<string[]> {
    const rawDir = path.join(this.root, 'raw');
    try {
      const entries = await fsp.readdir(rawDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  async getStats(): Promise<StorageStats> {
    const totals = this.db
      .prepare(
        `SELECT
          COUNT(*) AS count,
          MIN(timestamp) AS oldest,
          MAX(timestamp) AS newest
        FROM events`,
      )
      .get() as { count: number; oldest: string | null; newest: string | null };

    const byType = (
      this.db
        .prepare('SELECT type, COUNT(*) AS n FROM events GROUP BY type')
        .all() as Array<{ type: string; n: number }>
    ).reduce<Record<string, number>>((acc, r) => {
      acc[r.type] = r.n;
      return acc;
    }, {});

    const byApp = (
      this.db
        .prepare(
          'SELECT app, COUNT(*) AS n FROM events WHERE app IS NOT NULL GROUP BY app ORDER BY n DESC LIMIT 50',
        )
        .all() as Array<{ app: string; n: number }>
    ).reduce<Record<string, number>>((acc, r) => {
      acc[r.app] = r.n;
      return acc;
    }, {});

    const totalAssetBytes = await this.getCachedAssetBytes();

    return {
      totalEvents: totals.count,
      totalAssetBytes,
      oldestEvent: totals.oldest,
      newestEvent: totals.newest,
      eventsByType: byType,
      eventsByApp: byApp,
    };
  }

  async markIndexed(strategy: string, eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    // Find the lex-max event id in the batch. Event ids are
    // `evt_<base36-ms>_<uuid>` (see @beside/core/ids.ts), so
    // string ordering = chronological ordering.
    let maxId = eventIds[0]!;
    for (let i = 1; i < eventIds.length; i++) {
      if (eventIds[i]! > maxId) maxId = eventIds[i]!;
    }
    // Monotonic upsert — the HWM only ever moves forward, even if a
    // batch happens to include an out-of-order id smaller than the
    // current checkpoint (which would be a bug in the indexer flow,
    // but defending here is cheap).
    this.db
      .prepare(
        `INSERT INTO index_state (strategy, last_event_id, last_marked_at)
         VALUES (@s, @e, @t)
         ON CONFLICT(strategy) DO UPDATE SET
           last_event_id  = MAX(index_state.last_event_id, excluded.last_event_id),
           last_marked_at = excluded.last_marked_at`,
      )
      .run({ s: strategy, e: maxId, t: new Date().toISOString() });
  }

  async clearIndexCheckpoint(strategy: string): Promise<void> {
    this.db.prepare('DELETE FROM index_state WHERE strategy = ?').run(strategy);
  }

  async getIndexCheckpoint(strategy: string): Promise<string | null> {
    const row = this.db
      .prepare('SELECT last_event_id AS last FROM index_state WHERE strategy = ?')
      .get(strategy) as { last: string | null } | undefined;
    return row?.last ?? null;
  }

  // -------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------

  async upsertFrame(frame: Frame): Promise<void> {
    const upsert = this.db.prepare(`
      INSERT INTO frames (
        id, timestamp, day, monitor, app, app_bundle_id, window_title, url, url_host,
        text, text_source, asset_path, perceptual_hash, trigger, session_id,
        duration_ms, source_event_ids, created_at
      ) VALUES (
        @id, @timestamp, @day, @monitor, @app, @app_bundle_id, @window_title, @url, @url_host,
        @text, @text_source, @asset_path, @perceptual_hash, @trigger, @session_id,
        @duration_ms, @source_event_ids, @created_at
      )
      ON CONFLICT(id) DO UPDATE SET
        text = COALESCE(excluded.text, frames.text),
        text_source = COALESCE(excluded.text_source, frames.text_source),
        url = COALESCE(excluded.url, frames.url),
        url_host = COALESCE(excluded.url_host, frames.url_host),
        duration_ms = COALESCE(excluded.duration_ms, frames.duration_ms),
        source_event_ids = excluded.source_event_ids
    `);
    const tx = this.db.transaction(() => {
      upsert.run({
        id: frame.id,
        timestamp: frame.timestamp,
        day: frame.day,
        monitor: frame.monitor,
        app: frame.app ?? null,
        app_bundle_id: frame.app_bundle_id ?? null,
        window_title: frame.window_title ?? null,
        url: frame.url,
        url_host: extractUrlHost(frame.url),
        text: frame.text,
        text_source: frame.text_source,
        asset_path: frame.asset_path,
        perceptual_hash: frame.perceptual_hash,
        trigger: frame.trigger,
        session_id: frame.session_id,
        duration_ms: frame.duration_ms,
        source_event_ids: JSON.stringify(frame.source_event_ids),
        created_at: new Date().toISOString(),
      });
      this.refreshFrameFtsRow({
        frameId: frame.id,
        text: frame.text ?? '',
        windowTitle: frame.window_title ?? '',
        url: frame.url ?? '',
        app: frame.app ?? '',
        entitySearch: entityToFtsText(frame.entity_path, frame.entity_kind),
      });
    });
    tx();
  }

  async searchFrames(query: FrameQuery): Promise<Frame[]> {
    const params: Record<string, unknown> = {};
    const where: string[] = ['1=1'];

    if (query.text && query.text.trim()) {
      // BM25 ranking via FTS5; lower is better.
      const join =
        'JOIN frame_text ON frame_text.frame_id = frames.id';
      where.push('frame_text MATCH @text');
      params.text = sanitiseFtsQuery(query.text);
      const sql: string[] = [
        `SELECT frames.* FROM frames ${join} WHERE ${where.join(' AND ')}`,
      ];
      if (query.from) {
        sql.push('AND timestamp >= @from_ts');
        params.from_ts = query.from;
      }
      if (query.to) {
        sql.push('AND timestamp <= @to_ts');
        params.to_ts = query.to;
      }
      if (query.apps?.length) {
        sql.push(`AND frames.app IN (${query.apps.map((_, i) => `@app_${i}`).join(',')})`);
        query.apps.forEach((a, i) => (params[`app_${i}`] = a));
      }
      if (query.day) {
        sql.push('AND frames.day = @day');
        params.day = query.day;
      }
      if (query.entityPath) {
        sql.push('AND frames.entity_path = @entity_path');
        params.entity_path = query.entityPath;
      }
      if (query.entityKind) {
        sql.push('AND frames.entity_kind = @entity_kind');
        params.entity_kind = query.entityKind;
      }
      if (query.activitySessionId) {
        sql.push('AND frames.activity_session_id = @activity_session_id');
        params.activity_session_id = query.activitySessionId;
      }
      if (query.urlDomain) {
        // Indexed exact-host match plus a single-pass subdomain LIKE.
        // The OR combines as a small UNION — first half hits
        // idx_frames_url_host, second half scans only rows already
        // narrowed by the other AND predicates.
        sql.push('AND (frames.url_host = @url_host OR frames.url_host LIKE @url_host_sub)');
        const host = normaliseHostFilter(query.urlDomain);
        params.url_host = host;
        params.url_host_sub = `%.${host}`;
      }
      if (query.textSource) {
        sql.push('AND frames.text_source = @text_source');
        params.text_source = query.textSource;
      }
      sql.push(
        'ORDER BY bm25(frame_text, 0.0, 1.2, 5.0, 0.4, 4.0) ASC, frames.timestamp DESC',
      );
      sql.push(`LIMIT ${Math.max(1, Math.floor(query.limit ?? 25))}`);
      if (query.offset) sql.push(`OFFSET ${Math.max(0, Math.floor(query.offset))}`);
      return (this.db.prepare(sql.join(' ')).all(params) as RawFrameRow[]).map(rowToFrame);
    }

    const sql: string[] = ['SELECT * FROM frames WHERE 1=1'];
    if (query.from) {
      sql.push('AND timestamp >= @from_ts');
      params.from_ts = query.from;
    }
    if (query.to) {
      sql.push('AND timestamp <= @to_ts');
      params.to_ts = query.to;
    }
    if (query.apps?.length) {
      sql.push(`AND app IN (${query.apps.map((_, i) => `@app_${i}`).join(',')})`);
      query.apps.forEach((a, i) => (params[`app_${i}`] = a));
    }
    if (query.day) {
      sql.push('AND day = @day');
      params.day = query.day;
    }
    if (query.entityPath) {
      sql.push('AND entity_path = @entity_path');
      params.entity_path = query.entityPath;
    }
    if (query.entityKind) {
      sql.push('AND entity_kind = @entity_kind');
      params.entity_kind = query.entityKind;
    }
    if (query.activitySessionId) {
      sql.push('AND activity_session_id = @activity_session_id');
      params.activity_session_id = query.activitySessionId;
    }
    if (query.urlDomain) {
      sql.push('AND (url_host = @url_host OR url_host LIKE @url_host_sub)');
      const host = normaliseHostFilter(query.urlDomain);
      params.url_host = host;
      params.url_host_sub = `%.${host}`;
    }
    if (query.textSource) {
      sql.push('AND text_source = @text_source');
      params.text_source = query.textSource;
    }
    sql.push('ORDER BY timestamp DESC');
    sql.push(`LIMIT ${Math.max(1, Math.floor(query.limit ?? 50))}`);
    if (query.offset) sql.push(`OFFSET ${Math.max(0, Math.floor(query.offset))}`);
    return (this.db.prepare(sql.join(' ')).all(params) as RawFrameRow[]).map(rowToFrame);
  }

  async getFrameContext(
    frameId: string,
    before: number,
    after: number,
  ): Promise<{ anchor: Frame; before: Frame[]; after: Frame[] } | null> {
    const anchorRow = this.db
      .prepare('SELECT * FROM frames WHERE id = ?')
      .get(frameId) as RawFrameRow | undefined;
    if (!anchorRow) return null;
    const anchor = rowToFrame(anchorRow);
    const beforeRows = this.db
      .prepare(
        'SELECT * FROM frames WHERE timestamp < ? ORDER BY timestamp DESC LIMIT ?',
      )
      .all(anchor.timestamp, Math.max(0, Math.floor(before))) as RawFrameRow[];
    const afterRows = this.db
      .prepare(
        'SELECT * FROM frames WHERE timestamp > ? ORDER BY timestamp ASC LIMIT ?',
      )
      .all(anchor.timestamp, Math.max(0, Math.floor(after))) as RawFrameRow[];
    return {
      anchor,
      before: beforeRows.reverse().map(rowToFrame),
      after: afterRows.map(rowToFrame),
    };
  }

  async getJournal(day: string): Promise<Frame[]> {
    const rows = this.db
      .prepare('SELECT * FROM frames WHERE day = ? ORDER BY timestamp ASC')
      .all(day) as RawFrameRow[];
    return rows.map(rowToFrame);
  }

  async listFramesNeedingOcr(limit: number): Promise<FrameOcrTask[]> {
    const rows = this.db
      .prepare(
        `SELECT id, asset_path, text AS existing_text,
                text_source AS existing_source,
                perceptual_hash
         FROM frames
         WHERE asset_path IS NOT NULL
           AND (text_source IS NULL OR text_source = 'accessibility')
         ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.floor(limit))) as Array<{
        id: string;
        asset_path: string;
        existing_text: string | null;
        existing_source: string | null;
        perceptual_hash: string | null;
      }>;
    return rows.map((r) => ({
      id: r.id,
      asset_path: r.asset_path,
      existing_text: r.existing_text,
      existing_source: (r.existing_source as FrameTextSource | null) ?? null,
      perceptual_hash: r.perceptual_hash,
    }));
  }

  /**
   * Find any previously-OCR'd frame with the same perceptual hash. The
   * OCR worker calls this before running Tesseract — when the user
   * toggles back to a recently-captured window/tab the pixels are
   * identical and re-running OCR is pure waste. We restrict to frames
   * whose `text_source` already includes OCR results so the copy is
   * actually useful. The candidate set is ordered by timestamp DESC
   * so the most recent OCR result wins on ties (avoids picking up
   * very old, possibly stale text for a tab that's been re-rendered).
   */
  async findOcrTextByPerceptualHash(
    perceptualHash: string,
    excludeFrameId?: string,
  ): Promise<{
    text: string;
    source: Extract<FrameTextSource, 'ocr' | 'accessibility' | 'ocr_accessibility'>;
  } | null> {
    if (!perceptualHash) return null;
    const row = this.db
      .prepare(
        `SELECT text, text_source
         FROM frames
         WHERE perceptual_hash = ?
           AND text IS NOT NULL
           AND text != ''
           AND text_source IN ('ocr', 'ocr_accessibility')
           ${excludeFrameId ? 'AND id != ?' : ''}
         ORDER BY timestamp DESC
         LIMIT 1`,
      )
      .get(...(excludeFrameId ? [perceptualHash, excludeFrameId] : [perceptualHash])) as
        | { text: string; text_source: string }
        | undefined;
    if (!row) return null;
    const source = row.text_source as FrameTextSource;
    if (source !== 'ocr' && source !== 'ocr_accessibility') return null;
    return { text: row.text, source };
  }

  async setFrameText(
    frameId: string,
    text: string,
    source: Extract<FrameTextSource, 'ocr' | 'accessibility' | 'ocr_accessibility'>,
  ): Promise<void> {
    const tx = this.db.transaction(() => {
      const row = this.getFrameFtsFrameSelectStmt().get(frameId) as
        | FrameFtsFrameRow
        | undefined;
      if (!row) return;

      const currentText = row.text ?? '';
      const changed = currentText !== text || row.text_source !== source;
      if (!changed) return;

      this.db
        .prepare('UPDATE frames SET text = ?, text_source = ? WHERE id = ?')
        .run(text, source, frameId);

      this.refreshFrameFtsRow({
        frameId,
        text,
        windowTitle: row.window_title ?? '',
        url: row.url ?? '',
        app: row.app ?? '',
        entitySearch: entityToFtsText(row.entity_path, row.entity_kind),
      });
    });
    tx();
  }

  async markFramed(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    const stmt = this.db.prepare('UPDATE events SET framed_at = ? WHERE id = ?');
    const t = new Date().toISOString();
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) stmt.run(t, id);
    });
    tx(eventIds);
  }

  async resetFrameDerivatives(query: { from?: string; to?: string } = {}): Promise<void> {
    const hasRange = Boolean(query.from || query.to);
    const frameWhere: string[] = ['1=1'];
    const eventWhere: string[] = ['1=1'];
    const params: Record<string, unknown> = {};
    if (query.from) {
      frameWhere.push('timestamp >= @from_ts');
      eventWhere.push('timestamp >= @from_ts');
      params.from_ts = query.from;
    }
    if (query.to) {
      frameWhere.push('timestamp <= @to_ts');
      eventWhere.push('timestamp <= @to_ts');
      params.to_ts = query.to;
    }

    const frameIds = hasRange
      ? (this.db
          .prepare(`SELECT id FROM frames WHERE ${frameWhere.join(' AND ')}`)
          .all(params) as Array<{ id: string }>).map((r) => r.id)
      : [];

    const tx = this.db.transaction(() => {
      if (hasRange) {
        this.deleteFrameRowsById(frameIds);
      } else {
        this.db.exec(`
          DELETE FROM frame_text;
          DELETE FROM frame_embeddings;
          DELETE FROM frames;
        `);
      }

      // These tables are derived from frames. Full reindex rebuilds them
      // immediately after FrameBuilder/EntityResolver have run.
      this.db.exec(`
        DELETE FROM entities_fts;
        DELETE FROM entities;
        DELETE FROM sessions;
        DELETE FROM meeting_turns;
        DELETE FROM meetings;
        DELETE FROM memory_chunk_text WHERE chunk_id IN (
          SELECT id FROM memory_chunks
          WHERE kind IN ('index_page', 'entity_summary', 'meeting_summary', 'day_event')
        );
        DELETE FROM memory_chunk_embeddings WHERE chunk_id IN (
          SELECT id FROM memory_chunks
          WHERE kind IN ('index_page', 'entity_summary', 'meeting_summary', 'day_event')
        );
        DELETE FROM memory_chunks
          WHERE kind IN ('index_page', 'entity_summary', 'meeting_summary', 'day_event');
        UPDATE frames SET activity_session_id = NULL, meeting_id = NULL;
      `);

      this.db
        .prepare(`UPDATE events SET framed_at = NULL WHERE ${eventWhere.join(' AND ')}`)
        .run(params);
    });
    tx();
  }

  private deleteFrameRowsById(frameIds: string[]): void {
    if (frameIds.length === 0) return;
    for (let i = 0; i < frameIds.length; i += 500) {
      const chunk = frameIds.slice(i, i + 500);
      const placeholders = chunk.map((_, idx) => `@id_${idx}`).join(',');
      const params = Object.fromEntries(chunk.map((id, idx) => [`id_${idx}`, id]));
      this.db.prepare(`DELETE FROM frame_text WHERE frame_id IN (${placeholders})`).run(params);
      this.db.prepare(`DELETE FROM frame_embeddings WHERE frame_id IN (${placeholders})`).run(params);
      this.db.prepare(`DELETE FROM frames WHERE id IN (${placeholders})`).run(params);
    }
  }

  async listFramesNeedingEmbedding(
    model: string,
    limit: number,
  ): Promise<FrameEmbeddingTask[]> {
    const cap = Math.max(1, Math.floor(limit));
    const missingRows = this.db
      .prepare(
        `SELECT frames.*,
                frame_embeddings.content_hash AS existing_hash
         FROM frames
         LEFT JOIN frame_embeddings
           ON frame_embeddings.frame_id = frames.id
          AND frame_embeddings.model = @model
         WHERE (
           COALESCE(frames.text, '') != ''
           OR COALESCE(frames.window_title, '') != ''
           OR COALESCE(frames.url, '') != ''
         )
           AND frame_embeddings.frame_id IS NULL
         ORDER BY frames.timestamp DESC
         LIMIT @limit`,
      )
      .all({
        model,
        limit: cap,
      }) as Array<RawFrameRow & { existing_hash: string | null }>;

    const out: FrameEmbeddingTask[] = [];
    for (const row of missingRows) {
      const content = frameEmbeddingContent(rowToFrame(row));
      if (!content) continue;
      const hash = sha256(content);
      out.push({ id: row.id, content_hash: hash, content });
      if (out.length >= cap) break;
    }
    if (out.length >= cap) return out;

    const staleRows = this.db
      .prepare(
        `SELECT frames.*,
                frame_embeddings.content_hash AS existing_hash
         FROM frames
         JOIN frame_embeddings
           ON frame_embeddings.frame_id = frames.id
          AND frame_embeddings.model = @model
         WHERE (
           COALESCE(frames.text, '') != ''
           OR COALESCE(frames.window_title, '') != ''
           OR COALESCE(frames.url, '') != ''
         )
         ORDER BY frame_embeddings.created_at ASC
         LIMIT @scanLimit`,
      )
      .all({
        model,
        scanLimit: Math.max(1, cap - out.length) * 10,
      }) as Array<RawFrameRow & { existing_hash: string | null }>;

    const queuedIds = new Set(out.map((task) => task.id));
    for (const row of staleRows) {
      if (queuedIds.has(row.id)) continue;
      const content = frameEmbeddingContent(rowToFrame(row));
      if (!content) continue;
      const hash = sha256(content);
      if (row.existing_hash === hash) continue;
      out.push({ id: row.id, content_hash: hash, content });
      queuedIds.add(row.id);
      if (out.length >= cap) break;
    }
    return out;
  }

  async upsertFrameEmbedding(
    frameId: string,
    model: string,
    contentHash: string,
    vector: number[],
  ): Promise<void> {
    const cleaned = normaliseVector(vector);
    if (cleaned.length === 0) return;
    const blob = packFloat32(cleaned);
    this.db
      .prepare(
        `INSERT INTO frame_embeddings
          (frame_id, model, content_hash, vector, dims, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(frame_id, model) DO UPDATE SET
           content_hash = excluded.content_hash,
           vector = excluded.vector,
           dims = excluded.dims,
           created_at = excluded.created_at`,
      )
      .run(
        frameId,
        model,
        contentHash,
        blob,
        cleaned.length,
        new Date().toISOString(),
      );
  }

  async upsertFrameEmbeddings(
    embeddings: Array<{
      frameId: string;
      model: string;
      contentHash: string;
      vector: number[];
    }>,
  ): Promise<void> {
    if (embeddings.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO frame_embeddings
        (frame_id, model, content_hash, vector, dims, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(frame_id, model) DO UPDATE SET
         content_hash = excluded.content_hash,
         vector = excluded.vector,
         dims = excluded.dims,
         created_at = excluded.created_at`,
    );
    const now = new Date().toISOString();
    const insertMany = this.db.transaction((items: typeof embeddings) => {
      for (const item of items) {
        const cleaned = normaliseVector(item.vector);
        if (cleaned.length === 0) continue;
        stmt.run(
          item.frameId,
          item.model,
          item.contentHash,
          packFloat32(cleaned),
          cleaned.length,
          now,
        );
      }
    });
    insertMany(embeddings);
  }

  /**
   * Look up an existing embedding by `(model, contentHash)` so the
   * embedding worker can avoid re-running the model on identical
   * input. A user dwelling on one Slack channel / browser tab /
   * editor buffer produces many frames with identical
   * `App + Window + URL + Entity + Text` content, and re-embedding
   * each one is wasted work. The query uses the existing
   * `idx_frame_embeddings_model` index to narrow by model, then a
   * filtered scan over duplicate content hashes (typically tiny);
   * `LIMIT 1` short-circuits as soon as any match is found.
   */
  async findExistingFrameEmbedding(
    model: string,
    contentHash: string,
  ): Promise<{ vector: number[]; dims: number } | null> {
    const row = this.db
      .prepare(
        `SELECT vector, dims
         FROM frame_embeddings
         WHERE model = ? AND content_hash = ?
         LIMIT 1`,
      )
      .get(model, contentHash) as { vector: Buffer; dims: number } | undefined;
    if (!row) return null;
    const vector = unpackFloat32(row.vector);
    if (vector.length === 0) return null;
    return { vector: Array.from(vector), dims: row.dims };
  }

  async findExistingFrameEmbeddings(
    model: string,
    contentHashes: string[],
  ): Promise<Map<string, { vector: number[]; dims: number }>> {
    const result = new Map<string, { vector: number[]; dims: number }>();
    if (contentHashes.length === 0) return result;
    const placeholders = contentHashes.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT content_hash, vector, dims
         FROM frame_embeddings
         WHERE model = ? AND content_hash IN (${placeholders})
         GROUP BY content_hash`,
      )
      .all(model, ...contentHashes) as Array<{ content_hash: string; vector: Buffer; dims: number }>;
    for (const row of rows) {
      const vector = unpackFloat32(row.vector);
      if (vector.length > 0) {
        result.set(row.content_hash, { vector: Array.from(vector), dims: row.dims });
      }
    }
    return result;
  }

  async searchFrameEmbeddings(
    vector: number[],
    query: Omit<FrameQuery, 'text' | 'embedding' | 'embeddingModel'> & {
      model?: string;
    } = {},
  ): Promise<FrameSemanticMatch[]> {
    const target = normaliseVector(vector);
    if (target.length === 0) return [];

    const where: string[] = ['1=1'];
    const params: Record<string, unknown> = {};
    if (query.model) {
      where.push('frame_embeddings.model = @model');
      params.model = query.model;
    }
    if (query.from) {
      where.push('frames.timestamp >= @from_ts');
      params.from_ts = query.from;
    }
    if (query.to) {
      where.push('frames.timestamp <= @to_ts');
      params.to_ts = query.to;
    }
    if (query.apps?.length) {
      where.push(`frames.app IN (${query.apps.map((_, i) => `@app_${i}`).join(',')})`);
      query.apps.forEach((a, i) => (params[`app_${i}`] = a));
    }
    if (query.day) {
      where.push('frames.day = @day');
      params.day = query.day;
    }
    if (query.entityPath) {
      where.push('frames.entity_path = @entity_path');
      params.entity_path = query.entityPath;
    }
    if (query.entityKind) {
      where.push('frames.entity_kind = @entity_kind');
      params.entity_kind = query.entityKind;
    }
    if (query.activitySessionId) {
      where.push('frames.activity_session_id = @activity_session_id');
      params.activity_session_id = query.activitySessionId;
    }
    if (query.urlDomain) {
      where.push('(frames.url_host = @url_host OR frames.url_host LIKE @url_host_sub)');
      const host = normaliseHostFilter(query.urlDomain);
      params.url_host = host;
      params.url_host_sub = `%.${host}`;
    }
    if (query.textSource) {
      where.push('frames.text_source = @text_source');
      params.text_source = query.textSource;
    }

    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const limit = Math.max(1, Math.floor(query.limit ?? 25));
    const keep = offset + limit;
    const spillLimit = Math.max(keep * 4, 100);
    const keepLimit = Math.max(keep * 2, 50);
    const candidates: Array<{ row: RawFrameRow; score: number }> = [];
    const stmt = this.db.prepare(
      `SELECT frames.*, frame_embeddings.vector AS vector_blob
       FROM frame_embeddings
       JOIN frames ON frames.id = frame_embeddings.frame_id
       WHERE ${where.join(' AND ')}`,
    );

    for (const row of stmt.iterate(params) as Iterable<RawFrameRow & { vector_blob: Buffer }>) {
      const candidate = unpackFloat32(row.vector_blob);
      if (candidate.length !== target.length) continue;
      const score = dot(target, candidate);
      if (!Number.isFinite(score)) continue;
      candidates.push({ row, score });
      if (candidates.length > spillLimit) {
        candidates.sort(compareSemanticCandidates);
        candidates.length = keepLimit;
      }
    }
    candidates.sort(compareSemanticCandidates);
    return candidates.slice(offset, offset + limit).map(({ row, score }) => ({
      frame: rowToFrame(row),
      score,
    }));
  }

  async clearFrameEmbeddings(model?: string): Promise<void> {
    if (model) {
      this.db.prepare('DELETE FROM frame_embeddings WHERE model = ?').run(model);
    } else {
      this.db.prepare('DELETE FROM frame_embeddings').run();
    }
  }

  async replaceMemoryChunks(
    generatedKinds: MemoryChunkKind[],
    chunks: MemoryChunk[],
  ): Promise<void> {
    const kinds = [...new Set(generatedKinds)];
    if (kinds.length === 0) return;
    const now = new Date().toISOString();
    const upsert = this.memoryChunkUpsertStatement();
    const ftsDelete = this.db.prepare('DELETE FROM memory_chunk_text WHERE chunk_id = ?');
    const ftsInsert = this.db.prepare(
      'INSERT INTO memory_chunk_text (chunk_id, title, body, entity_search, kind) VALUES (?, ?, ?, ?, ?)',
    );
    const tx = this.db.transaction(() => {
      for (const chunk of chunks) {
        const createdAt = chunk.createdAt || now;
        const updatedAt = chunk.updatedAt || now;
        upsert.run(
          chunk.id,
          chunk.kind,
          chunk.sourceId,
          chunk.title,
          chunk.body,
          chunk.entityPath,
          chunk.entityKind,
          chunk.day,
          chunk.timestamp,
          JSON.stringify(chunk.sourceRefs ?? []),
          chunk.contentHash,
          createdAt,
          updatedAt,
        );
        ftsDelete.run(chunk.id);
        ftsInsert.run(
          chunk.id,
          chunk.title,
          chunk.body,
          entityToFtsText(chunk.entityPath, chunk.entityKind),
          chunk.kind,
        );
      }

      const kindPlaceholders = kinds.map((_, i) => `@kind_${i}`).join(',');
      const params: Record<string, unknown> = Object.fromEntries(
        kinds.map((kind, i) => [`kind_${i}`, kind]),
      );
      const keepIds = new Set(chunks.map((chunk) => chunk.id));
      const stale = this.db
        .prepare(
          `SELECT id FROM memory_chunks WHERE kind IN (${kindPlaceholders})`,
        )
        .all(params) as Array<{ id: string }>;
      const staleIds = stale.map((row) => row.id).filter((id) => !keepIds.has(id));
      for (let i = 0; i < staleIds.length; i += 500) {
        const batch = staleIds.slice(i, i + 500);
        if (batch.length === 0) continue;
        const placeholders = batch.map((_, idx) => `@id_${idx}`).join(',');
        const idParams = Object.fromEntries(batch.map((id, idx) => [`id_${idx}`, id]));
        this.db.prepare(`DELETE FROM memory_chunk_text WHERE chunk_id IN (${placeholders})`).run(idParams);
        this.db.prepare(`DELETE FROM memory_chunk_embeddings WHERE chunk_id IN (${placeholders})`).run(idParams);
        this.db.prepare(`DELETE FROM memory_chunks WHERE id IN (${placeholders})`).run(idParams);
      }
    });
    tx();
  }

  async upsertMemoryChunks(chunks: MemoryChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const upsert = this.memoryChunkUpsertStatement();
    const ftsDelete = this.db.prepare('DELETE FROM memory_chunk_text WHERE chunk_id = ?');
    const ftsInsert = this.db.prepare(
      'INSERT INTO memory_chunk_text (chunk_id, title, body, entity_search, kind) VALUES (?, ?, ?, ?, ?)',
    );
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      for (const chunk of chunks) {
        upsert.run(
          chunk.id,
          chunk.kind,
          chunk.sourceId,
          chunk.title,
          chunk.body,
          chunk.entityPath,
          chunk.entityKind,
          chunk.day,
          chunk.timestamp,
          JSON.stringify(chunk.sourceRefs ?? []),
          chunk.contentHash,
          chunk.createdAt || now,
          chunk.updatedAt || now,
        );
        ftsDelete.run(chunk.id);
        ftsInsert.run(
          chunk.id,
          chunk.title,
          chunk.body,
          entityToFtsText(chunk.entityPath, chunk.entityKind),
          chunk.kind,
        );
      }
    });
    tx();
  }

  async searchMemoryChunks(query: MemoryChunkQuery): Promise<MemoryChunk[]> {
    const params: Record<string, unknown> = {};
    const where: string[] = ['1=1'];
    const limit = Math.max(1, Math.floor(query.limit ?? 10));
    const offset = Math.max(0, Math.floor(query.offset ?? 0));

    const addFilters = (prefix = 'memory_chunks'): void => {
      if (query.kind) {
        where.push(`${prefix}.kind = @kind`);
        params.kind = query.kind;
      }
      if (query.entityPath) {
        where.push(`${prefix}.entity_path = @entity_path`);
        params.entity_path = query.entityPath;
      }
      if (query.day) {
        where.push(`${prefix}.day = @day`);
        params.day = query.day;
      }
      if (query.from) {
        where.push(`COALESCE(${prefix}.timestamp, ${prefix}.updated_at) >= @from_ts`);
        params.from_ts = query.from;
      }
      if (query.to) {
        where.push(`COALESCE(${prefix}.timestamp, ${prefix}.updated_at) <= @to_ts`);
        params.to_ts = query.to;
      }
    };

    if (query.text && query.text.trim()) {
      const ftsQuery = sanitiseFtsQuery(query.text);
      params.text = ftsQuery;
      where.push('memory_chunk_text MATCH @text');
      addFilters('memory_chunks');
      const rows = this.db
        .prepare(
          `SELECT memory_chunks.*
           FROM memory_chunks
           JOIN memory_chunk_text ON memory_chunk_text.chunk_id = memory_chunks.id
           WHERE ${where.join(' AND ')}
           ORDER BY bm25(memory_chunk_text, 4.0, 2.0, 1.0) ASC,
                    COALESCE(memory_chunks.timestamp, memory_chunks.updated_at) DESC
           LIMIT @limit OFFSET @offset`,
        )
        .all({ ...params, limit, offset }) as MemoryChunkRow[];
      return rows.map(memoryChunkFromRow);
    }

    addFilters('memory_chunks');
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_chunks
         WHERE ${where.join(' AND ')}
         ORDER BY COALESCE(timestamp, updated_at) DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit, offset }) as MemoryChunkRow[];
    return rows.map(memoryChunkFromRow);
  }

  async listMemoryChunksNeedingEmbedding(
    model: string,
    limit: number,
  ): Promise<MemoryChunkEmbeddingTask[]> {
    const cap = Math.max(1, Math.floor(limit));
    const missingRows = this.db
      .prepare(
        `SELECT memory_chunks.*, memory_chunk_embeddings.content_hash AS existing_hash
         FROM memory_chunks
         LEFT JOIN memory_chunk_embeddings
           ON memory_chunk_embeddings.chunk_id = memory_chunks.id
          AND memory_chunk_embeddings.model = @model
         WHERE memory_chunk_embeddings.chunk_id IS NULL
           AND COALESCE(memory_chunks.body, '') != ''
         ORDER BY COALESCE(memory_chunks.timestamp, memory_chunks.updated_at) DESC
         LIMIT @limit`,
      )
      .all({ model, limit: cap }) as Array<MemoryChunkRow & { existing_hash: string | null }>;

    const out: MemoryChunkEmbeddingTask[] = [];
    for (const row of missingRows) {
      const chunk = memoryChunkFromRow(row);
      const content = memoryChunkEmbeddingContent(chunk);
      if (!content) continue;
      out.push({ id: row.id, content_hash: sha256(content), content });
      if (out.length >= cap) return out;
    }

    const staleRows = this.db
      .prepare(
        `SELECT memory_chunks.*, memory_chunk_embeddings.content_hash AS existing_hash
         FROM memory_chunks
         JOIN memory_chunk_embeddings
           ON memory_chunk_embeddings.chunk_id = memory_chunks.id
          AND memory_chunk_embeddings.model = @model
         WHERE COALESCE(memory_chunks.body, '') != ''
         ORDER BY memory_chunk_embeddings.created_at ASC
         LIMIT @scanLimit`,
      )
      .all({
        model,
        scanLimit: Math.max(1, cap - out.length) * 10,
      }) as Array<MemoryChunkRow & { existing_hash: string | null }>;
    const queued = new Set(out.map((task) => task.id));
    for (const row of staleRows) {
      if (queued.has(row.id)) continue;
      const chunk = memoryChunkFromRow(row);
      const content = memoryChunkEmbeddingContent(chunk);
      if (!content) continue;
      const hash = sha256(content);
      if (row.existing_hash === hash) continue;
      out.push({ id: row.id, content_hash: hash, content });
      queued.add(row.id);
      if (out.length >= cap) break;
    }
    return out;
  }

  async upsertMemoryChunkEmbeddings(
    embeddings: Array<{
      chunkId: string;
      model: string;
      contentHash: string;
      vector: number[];
    }>,
  ): Promise<void> {
    if (embeddings.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO memory_chunk_embeddings
        (chunk_id, model, content_hash, vector, dims, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chunk_id, model) DO UPDATE SET
         content_hash = excluded.content_hash,
         vector = excluded.vector,
         dims = excluded.dims,
         created_at = excluded.created_at`,
    );
    const now = new Date().toISOString();
    const tx = this.db.transaction((items: typeof embeddings) => {
      for (const item of items) {
        const cleaned = normaliseVector(item.vector);
        if (cleaned.length === 0) continue;
        stmt.run(
          item.chunkId,
          item.model,
          item.contentHash,
          packFloat32(cleaned),
          cleaned.length,
          now,
        );
      }
    });
    tx(embeddings);
  }

  async findExistingMemoryChunkEmbeddings(
    model: string,
    contentHashes: string[],
  ): Promise<Map<string, { vector: number[]; dims: number }>> {
    const result = new Map<string, { vector: number[]; dims: number }>();
    if (contentHashes.length === 0) return result;
    const placeholders = contentHashes.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT content_hash, vector, dims
         FROM memory_chunk_embeddings
         WHERE model = ? AND content_hash IN (${placeholders})
         GROUP BY content_hash`,
      )
      .all(model, ...contentHashes) as Array<{ content_hash: string; vector: Buffer; dims: number }>;
    for (const row of rows) {
      const vector = unpackFloat32(row.vector);
      if (vector.length > 0) {
        result.set(row.content_hash, { vector: Array.from(vector), dims: row.dims });
      }
    }
    return result;
  }

  async searchMemoryChunkEmbeddings(
    vector: number[],
    query: Omit<MemoryChunkQuery, 'text'> & { model?: string } = {},
  ): Promise<MemoryChunkSemanticMatch[]> {
    const target = normaliseVector(vector);
    if (target.length === 0) return [];
    const where: string[] = ['1=1'];
    const params: Record<string, unknown> = {};
    if (query.model) {
      where.push('memory_chunk_embeddings.model = @model');
      params.model = query.model;
    }
    if (query.kind) {
      where.push('memory_chunks.kind = @kind');
      params.kind = query.kind;
    }
    if (query.entityPath) {
      where.push('memory_chunks.entity_path = @entity_path');
      params.entity_path = query.entityPath;
    }
    if (query.day) {
      where.push('memory_chunks.day = @day');
      params.day = query.day;
    }
    if (query.from) {
      where.push('COALESCE(memory_chunks.timestamp, memory_chunks.updated_at) >= @from_ts');
      params.from_ts = query.from;
    }
    if (query.to) {
      where.push('COALESCE(memory_chunks.timestamp, memory_chunks.updated_at) <= @to_ts');
      params.to_ts = query.to;
    }
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const limit = Math.max(1, Math.floor(query.limit ?? 10));
    const keep = offset + limit;
    const spillLimit = Math.max(keep * 4, 100);
    const keepLimit = Math.max(keep * 2, 50);
    const candidates: Array<{ row: MemoryChunkRow; score: number }> = [];
    const stmt = this.db.prepare(
      `SELECT memory_chunks.*, memory_chunk_embeddings.vector AS vector_blob
       FROM memory_chunk_embeddings
       JOIN memory_chunks ON memory_chunks.id = memory_chunk_embeddings.chunk_id
       WHERE ${where.join(' AND ')}`,
    );
    for (const row of stmt.iterate(params) as Iterable<MemoryChunkRow & { vector_blob: Buffer }>) {
      const candidate = unpackFloat32(row.vector_blob);
      if (candidate.length !== target.length) continue;
      const score = dot(target, candidate);
      if (!Number.isFinite(score)) continue;
      candidates.push({ row, score });
      if (candidates.length > spillLimit) {
        candidates.sort(compareMemoryChunkCandidates);
        candidates.length = keepLimit;
      }
    }
    candidates.sort(compareMemoryChunkCandidates);
    return candidates.slice(offset, offset + limit).map(({ row, score }) => ({
      chunk: memoryChunkFromRow(row),
      score,
    }));
  }

  async getMemoryIndexStats(model?: string): Promise<MemoryIndexStats> {
    const chunks = (
      this.db.prepare('SELECT COUNT(*) AS n FROM memory_chunks').get() as { n: number }
    ).n;
    const byKindRows = this.db
      .prepare('SELECT kind, COUNT(*) AS n FROM memory_chunks GROUP BY kind')
      .all() as Array<{ kind: MemoryChunkKind; n: number }>;
    const chunkEmbeddings = (
      this.db.prepare('SELECT COUNT(*) AS n FROM memory_chunk_embeddings').get() as { n: number }
    ).n;
    const byModelRows = this.db
      .prepare('SELECT model, COUNT(*) AS n FROM memory_chunk_embeddings GROUP BY model')
      .all() as Array<{ model: string; n: number }>;
    const missingChunkRows = this.db
      .prepare(
        `SELECT c.*, e.content_hash AS existing_hash
         FROM memory_chunks c
         LEFT JOIN memory_chunk_embeddings e
           ON e.chunk_id = c.id ${model ? 'AND e.model = @model' : ''}
         WHERE COALESCE(c.body, '') != ''
           AND (e.chunk_id IS NULL OR e.content_hash != c.content_hash)`,
      )
      .all(model ? { model } : {}) as Array<MemoryChunkRow & { existing_hash: string | null }>;
    const framesWithEmbeddings = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT frames.id) AS n
           FROM frames
           JOIN frame_embeddings ON frame_embeddings.frame_id = frames.id
           ${model ? 'WHERE frame_embeddings.model = @model' : ''}`,
        )
        .get(model ? { model } : {}) as { n: number }
    ).n;
    const framesMissingEmbeddings = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM frames
           LEFT JOIN frame_embeddings
             ON frame_embeddings.frame_id = frames.id ${model ? 'AND frame_embeddings.model = @model' : ''}
           WHERE (
             COALESCE(frames.text, '') != ''
             OR COALESCE(frames.window_title, '') != ''
             OR COALESCE(frames.url, '') != ''
           )
             AND frame_embeddings.frame_id IS NULL`,
        )
        .get(model ? { model } : {}) as { n: number }
    ).n;
    return {
      chunks,
      chunksByKind: Object.fromEntries(byKindRows.map((row) => [row.kind, row.n])),
      chunkEmbeddings,
      chunkEmbeddingsByModel: Object.fromEntries(byModelRows.map((row) => [row.model, row.n])),
      chunksMissingEmbedding: missingChunkRows.length,
      framesWithEmbeddings,
      framesMissingEmbeddings,
    };
  }

  private memoryChunkUpsertStatement(): Database.Statement {
    return this.db.prepare(
      `INSERT INTO memory_chunks (
         id, kind, source_id, title, body, entity_path, entity_kind, day,
         timestamp, source_refs_json, content_hash, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         source_id = excluded.source_id,
         title = excluded.title,
         body = excluded.body,
         entity_path = excluded.entity_path,
         entity_kind = excluded.entity_kind,
         day = excluded.day,
         timestamp = excluded.timestamp,
         source_refs_json = excluded.source_refs_json,
         content_hash = excluded.content_hash,
         updated_at = excluded.updated_at`,
    );
  }

  // -------------------------------------------------------------------------
  // Entities
  // -------------------------------------------------------------------------

  async listFramesNeedingResolution(limit: number): Promise<Frame[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM frames WHERE entity_path IS NULL
         ORDER BY timestamp ASC LIMIT ?`,
      )
      .all(Math.max(1, Math.floor(limit))) as RawFrameRow[];
    return rows.map(rowToFrame);
  }

  async resolveFrameToEntity(frameId: string, entity: EntityRef): Promise<void> {
    const tx = this.db.transaction(() => {
      this.resolveFrameToEntityInTx(frameId, entity);
    });
    tx();
  }

  async resolveFramesToEntities(
    items: ReadonlyArray<{ frameId: string; entity: EntityRef }>,
  ): Promise<void> {
    if (items.length === 0) return;
    const tx = this.db.transaction(() => {
      for (const item of items) {
        this.resolveFrameToEntityInTx(item.frameId, item.entity);
      }
    });
    tx();
  }

  // Shared body for single-frame and batched entity resolution. Must
  // run inside a db.transaction so the frame tag, entity rollup, and
  // FTS refresh commit atomically.
  private resolveFrameToEntityInTx(frameId: string, entity: EntityRef): void {
    // 1. Tag the frame.
    const updated = this.getResolveFrameTagStmt().run(
      entity.path,
      entity.kind,
      frameId,
    ).changes;
    if (updated === 0) return;

    // 2. Pull the frame's contribution to the entity stats.
    const frameRow = this.getResolveFrameSelectStmt().get(frameId) as
      | {
          timestamp: string;
          duration_ms: number | null;
          text: string | null;
          window_title: string | null;
          url: string | null;
          app: string | null;
        }
      | undefined;
    if (!frameRow) return;
    const ts = frameRow.timestamp;
    const dur = frameRow.duration_ms ?? 0;

    // 3. Upsert the entity. ON CONFLICT updates first_seen / last_seen
    //    monotonically and accumulates the running totals.
    this.getResolveEntityUpsertStmt().run(
      entity.path,
      entity.kind,
      entity.title,
      ts,
      ts,
      dur,
    );

    // 4. Refresh the frame's FTS row so a search like "milan" or
    //    "beside" actually matches all the frames now attributed
    //    to that entity, not just the ones that literally typed it.
    this.refreshFrameFtsRow({
      frameId,
      text: frameRow.text ?? '',
      windowTitle: frameRow.window_title ?? '',
      url: frameRow.url ?? '',
      app: frameRow.app ?? '',
      entitySearch: entityToFtsText(entity.path, entity.kind),
    });
  }

  private getResolveFrameTagStmt(): Database.Statement {
    this.resolveFrameTagStmt ??= this.db.prepare(
      `UPDATE frames SET entity_path = ?, entity_kind = ?
       WHERE id = ? AND entity_path IS NULL`,
    );
    return this.resolveFrameTagStmt;
  }

  private getResolveFrameSelectStmt(): Database.Statement {
    this.resolveFrameSelectStmt ??= this.db.prepare(
      'SELECT timestamp, duration_ms, text, window_title, url, app FROM frames WHERE id = ?',
    );
    return this.resolveFrameSelectStmt;
  }

  private getResolveEntityUpsertStmt(): Database.Statement {
    this.resolveEntityUpsertStmt ??= this.db.prepare(
      `INSERT INTO entities (
         path, kind, title, first_seen, last_seen, total_focused_ms, frame_count
       ) VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(path) DO UPDATE SET
         kind = excluded.kind,
         title = excluded.title,
         first_seen = MIN(entities.first_seen, excluded.first_seen),
         last_seen = MAX(entities.last_seen, excluded.last_seen),
         total_focused_ms = entities.total_focused_ms + excluded.total_focused_ms,
         frame_count = entities.frame_count + 1`,
    );
    return this.resolveEntityUpsertStmt;
  }

  /**
   * Update the entity_search column on the FTS row for one frame.
   * Used after the per-frame resolver attaches an entity, after
   * SessionBuilder lifts a frame to a different entity, and after
   * any other path that mutates frames.entity_path.
   */
  private refreshFrameFtsEntity(
    frameId: string,
    entityPath: string | null,
    entityKind: string | null,
  ): void {
    const row = this.getFrameFtsFrameSelectStmt().get(frameId) as
      | FrameFtsFrameRow
      | undefined;
    if (!row) return;
    this.refreshFrameFtsRow({
      frameId,
      text: row.text ?? '',
      windowTitle: row.window_title ?? '',
      url: row.url ?? '',
      app: row.app ?? '',
      entitySearch: entityToFtsText(entityPath, entityKind),
    });
  }

  // FTS5 supports UPDATE on UNINDEXED columns since SQLite 3.33. Try
  // it first and fall back to INSERT only when the row doesn't exist
  // yet -- saves the second statement (and the FTS token re-index it
  // implies) on every mutation of an existing row, which is the hot
  // path during entity resolution and OCR backfill.
  private refreshFrameFtsRow(input: {
    frameId: string;
    text: string;
    windowTitle: string;
    url: string;
    app: string;
    entitySearch: string;
  }): boolean {
    const body = ftsBodyText(input.text, input.url);
    const changes = this.getFrameFtsUpdateStmt().run(
      body,
      input.windowTitle,
      input.app,
      input.entitySearch,
      input.frameId,
    ).changes;
    if (changes === 0) {
      this.getFrameFtsInsertStmt().run(
        input.frameId,
        body,
        input.windowTitle,
        input.app,
        input.entitySearch,
      );
    }
    return true;
  }

  private getFrameFtsInsertStmt(): Database.Statement {
    this.frameFtsInsertStmt ??= this.db.prepare(
      'INSERT INTO frame_text (frame_id, text, window_title, app, entity_search) VALUES (?, ?, ?, ?, ?)',
    );
    return this.frameFtsInsertStmt;
  }

  private getFrameFtsUpdateStmt(): Database.Statement {
    this.frameFtsUpdateStmt ??= this.db.prepare(
      'UPDATE frame_text SET text = ?, window_title = ?, app = ?, entity_search = ? WHERE frame_id = ?',
    );
    return this.frameFtsUpdateStmt;
  }

  private getFrameFtsFrameSelectStmt(): Database.Statement {
    this.frameFtsFrameSelectStmt ??= this.db.prepare(
      'SELECT text, text_source, window_title, url, app, entity_path, entity_kind FROM frames WHERE id = ?',
    );
    return this.frameFtsFrameSelectStmt;
  }

  async rebuildEntityCounts(): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.exec('DELETE FROM entities');
      const rows = this.db
        .prepare(
          `SELECT entity_path, entity_kind,
                  MIN(timestamp) AS first_seen,
                  MAX(timestamp) AS last_seen,
                  COALESCE(SUM(duration_ms), 0) AS total_focused_ms,
                  COUNT(*) AS frame_count,
                  COALESCE(MAX(window_title), '') AS title_hint
           FROM frames
           WHERE entity_path IS NOT NULL
           GROUP BY entity_path, entity_kind`,
        )
        .all() as Array<{
        entity_path: string;
        entity_kind: string;
        first_seen: string;
        last_seen: string;
        total_focused_ms: number;
        frame_count: number;
        title_hint: string;
      }>;
      const insert = this.db.prepare(
        `INSERT INTO entities (path, kind, title, first_seen, last_seen, total_focused_ms, frame_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        const title = pathToTitle(r.entity_path) || r.title_hint || r.entity_path;
        insert.run(
          r.entity_path,
          r.entity_kind,
          title,
          r.first_seen,
          r.last_seen,
          r.total_focused_ms,
          r.frame_count,
        );
      }
    });
    tx();
  }

  async getEntity(path: string): Promise<EntityRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM entities WHERE path = ?')
      .get(path) as RawEntityRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  async listEntities(query: ListEntitiesQuery = {}): Promise<EntityRecord[]> {
    const params: Record<string, unknown> = {};
    const where: string[] = ['1=1'];
    if (query.kind) {
      where.push('kind = @kind');
      params.kind = query.kind;
    }
    if (query.sinceLastSeen) {
      where.push('last_seen >= @since');
      params.since = query.sinceLastSeen;
    }
    const sql =
      `SELECT * FROM entities WHERE ${where.join(' AND ')} ` +
      `ORDER BY last_seen DESC LIMIT ${Math.max(1, Math.floor(query.limit ?? 100))}`;
    const rows = this.db.prepare(sql).all(params) as RawEntityRow[];
    return rows.map(rowToEntity);
  }

  async getEntityFrames(entityPath: string, limit?: number): Promise<Frame[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM frames WHERE entity_path = ?
         ORDER BY timestamp ASC LIMIT ?`,
      )
      .all(entityPath, Math.max(1, Math.floor(limit ?? 500))) as RawFrameRow[];
    return rows.map(rowToFrame);
  }

  async listEntityCoOccurrences(
    entityPath: string,
    limit?: number,
  ): Promise<EntityCoOccurrence[]> {
    const cap = Math.max(1, Math.floor(limit ?? 25));
    // Self-join frames on activity_session_id, restrict the LHS to
    // the target entity, then aggregate by partner. The
    // idx_frames_activity_session + idx_frames_entity_ts indexes let
    // SQLite drive both sides cheaply. We pull `partner.entity_kind`
    // (NOT NULL when entity_path is) so the result type stays clean.
    const rows = this.db
      .prepare(
        `SELECT
           partner.entity_path AS path,
           partner.entity_kind AS kind,
           COALESCE(entities.title, '') AS title,
           COUNT(DISTINCT partner.activity_session_id) AS shared_sessions,
           COALESCE(SUM(partner.duration_ms), 0) AS shared_ms,
           MAX(partner.timestamp) AS last_shared_at
         FROM frames target
         JOIN frames partner
           ON partner.activity_session_id = target.activity_session_id
          AND partner.entity_path IS NOT NULL
          AND partner.entity_path != target.entity_path
         LEFT JOIN entities ON entities.path = partner.entity_path
         WHERE target.entity_path = @path
           AND target.activity_session_id IS NOT NULL
         GROUP BY partner.entity_path, partner.entity_kind
         ORDER BY shared_sessions DESC, shared_ms DESC, last_shared_at DESC
         LIMIT @limit`,
      )
      .all({ path: entityPath, limit: cap }) as Array<{
      path: string;
      kind: string;
      title: string;
      shared_sessions: number;
      shared_ms: number;
      last_shared_at: string;
    }>;
    return rows.map((r) => ({
      path: r.path,
      kind: r.kind as EntityKind,
      title: r.title || pathToTitle(r.path),
      sharedSessions: r.shared_sessions,
      sharedFocusedMs: r.shared_ms,
      lastSharedAt: r.last_shared_at,
    }));
  }

  async getEntityTimeline(
    entityPath: string,
    query: EntityTimelineQuery = {},
  ): Promise<EntityTimelineBucket[]> {
    const granularity = query.granularity ?? 'day';
    const limit = Math.max(1, Math.floor(query.limit ?? 30));
    // Bucket key: SQLite has no DATE_TRUNC. For day, we already store
    // the YYYY-MM-DD `day` column on every frame. For hour, slice the
    // ISO timestamp at 13 chars (`YYYY-MM-DDTHH`).
    const bucketExpr =
      granularity === 'day' ? 'day' : 'substr(timestamp, 1, 13)';
    const where: string[] = ['entity_path = @path'];
    const params: Record<string, unknown> = { path: entityPath, limit };
    if (query.from) {
      where.push('timestamp >= @from_ts');
      params.from_ts = query.from;
    }
    if (query.to) {
      where.push('timestamp <= @to_ts');
      params.to_ts = query.to;
    }
    const rows = this.db
      .prepare(
        `SELECT
           ${bucketExpr} AS bucket,
           COUNT(*) AS frames,
           COALESCE(SUM(duration_ms), 0) AS focused_ms,
           COUNT(DISTINCT activity_session_id) AS sessions
         FROM frames
         WHERE ${where.join(' AND ')}
         GROUP BY bucket
         ORDER BY bucket DESC
         LIMIT @limit`,
      )
      .all(params) as Array<{
      bucket: string;
      frames: number;
      focused_ms: number;
      sessions: number;
    }>;
    return rows.map((r) => ({
      bucket: r.bucket,
      frames: r.frames,
      focusedMs: r.focused_ms,
      sessions: r.sessions,
    }));
  }

  async searchEntities(query: SearchEntitiesQuery): Promise<EntityRecord[]> {
    const text = (query.text ?? '').trim();
    if (!text) return [];
    const limit = Math.max(1, Math.floor(query.limit ?? 25));

    // FTS5 path — sanitised query, BM25 ranking. We OR-match against
    // both the title column and the tokenised path tail so a single
    // query like "beside" hits both `title=Beside` and
    // `path=projects/beside`.
    const ftsQuery = sanitiseFtsQuery(text);
    if (ftsQuery && ftsQuery !== '""') {
      const params: Record<string, unknown> = { q: ftsQuery, limit };
      let kindClause = '';
      if (query.kind) {
        kindClause = 'AND entities.kind = @kind';
        params.kind = query.kind;
      }
      const rows = this.db
        .prepare(
          `SELECT entities.*
           FROM entities_fts
           JOIN entities ON entities.path = entities_fts.path
           WHERE entities_fts MATCH @q ${kindClause}
           ORDER BY bm25(entities_fts) ASC, entities.last_seen DESC
           LIMIT @limit`,
        )
        .all(params) as RawEntityRow[];
      if (rows.length > 0) return rows.map(rowToEntity);
    }

    // Fallback substring scan — handles inputs that the FTS sanitiser
    // strips entirely (pure punctuation) and very fresh DBs where the
    // FTS hasn't been backfilled yet. Includes a noise filter that
    // mirrors the entities_ai trigger, opt-out via `includeNoise`.
    const params: Record<string, unknown> = {
      like: `%${text.toLowerCase()}%`,
      limit,
    };
    let kindClause = '';
    if (query.kind) {
      kindClause = 'AND kind = @kind';
      params.kind = query.kind;
    }
    const noiseClause = query.includeNoise
      ? ''
      : `AND path NOT IN (
          'apps/loginwindow', 'apps/captive-network-assistant',
          'apps/system-settings', 'apps/activity-monitor',
          'apps/electron', 'apps/cloudflare-warp',
          'apps/spotlight', 'apps/window-server', 'apps/dock',
          'apps/control-center', 'apps/notification-center',
          'apps/screencaptureui', 'apps/beside', 'apps/audio'
        )`;
    const rows = this.db
      .prepare(
        `SELECT * FROM entities
         WHERE (LOWER(title) LIKE @like OR LOWER(path) LIKE @like)
           ${kindClause} ${noiseClause}
         ORDER BY last_seen DESC
         LIMIT @limit`,
      )
      .all(params) as RawEntityRow[];
    return rows.map(rowToEntity);
  }

  async reattributeFrames(input: {
    frameIds: string[];
    fromAppPaths: string[];
    target: EntityRef;
  }): Promise<{ moved: number; refreshedEntities: string[] }> {
    if (input.fromAppPaths.length === 0 || input.frameIds.length === 0) {
      return { moved: 0, refreshedEntities: [] };
    }

    const targetPath = input.target.path;
    const fromPlaceholders = input.fromAppPaths.map(() => '?').join(',');
    const idPlaceholders = input.frameIds.map(() => '?').join(',');

    // 1. Identify the affected entities up front — both the source
    //    apps/* rows we're shrinking and the target row we're growing.
    //    `affectedPaths` is the deduped set we'll re-aggregate at the end.
    const affectedPaths = new Set<string>([targetPath, ...input.fromAppPaths]);

    // 2. Identify the exact frame ids that will move (so we can
    //    refresh their FTS rows after the bulk UPDATE). Same predicate
    //    as the UPDATE that follows.
    const movedIds = (
      this.db
        .prepare(
          `SELECT id FROM frames
             WHERE id IN (${idPlaceholders})
               AND entity_path IN (${fromPlaceholders})
               AND entity_path != ?`,
        )
        .all(...input.frameIds, ...input.fromAppPaths, targetPath) as Array<{
        id: string;
      }>
    ).map((r) => r.id);

    if (movedIds.length === 0) return { moved: 0, refreshedEntities: [] };

    // 3. Move the frames in one statement.
    const updateStmt = this.db.prepare(
      `UPDATE frames
         SET entity_path = ?, entity_kind = ?
       WHERE id IN (${idPlaceholders})
         AND entity_path IN (${fromPlaceholders})
         AND entity_path != ?`,
    );
    const moved = updateStmt.run(
      targetPath,
      input.target.kind,
      ...input.frameIds,
      ...input.fromAppPaths,
      targetPath,
    ).changes;

    if (moved === 0) return { moved: 0, refreshedEntities: [] };

    // 4. Refresh the FTS entity_search for every moved frame so a
    //    search for the new target's tokens reaches them. Keep this in
    //    one transaction so FTS shadow-table writes are amortised.
    const refreshMovedFts = this.db.transaction(() => {
      for (const id of movedIds) {
        this.refreshFrameFtsEntity(id, targetPath, input.target.kind);
      }
    });
    refreshMovedFts();

    // 5. Recompute the entities table for only the affected rows. This
    //    is much cheaper than the global rebuildEntityCounts() — we only
    //    touch the few entities that actually changed shape.
    const refreshed: string[] = [];
    const tx = this.db.transaction(() => {
      for (const path of affectedPaths) {
        const stats = this.db
          .prepare(
            `SELECT MIN(timestamp) AS first_seen,
                    MAX(timestamp) AS last_seen,
                    COALESCE(SUM(duration_ms), 0) AS total_focused_ms,
                    COUNT(*) AS frame_count,
                    MAX(entity_kind) AS kind,
                    COALESCE(MAX(window_title), '') AS title_hint
             FROM frames WHERE entity_path = ?`,
          )
          .get(path) as
          | {
              first_seen: string | null;
              last_seen: string | null;
              total_focused_ms: number;
              frame_count: number;
              kind: string | null;
              title_hint: string;
            }
          | undefined;

        if (!stats || stats.frame_count === 0) {
          // Source apps/* row that lost its last frame. Drop the row
          // (the `entities_ad` trigger cleans up the FTS entry).
          this.db.prepare('DELETE FROM entities WHERE path = ?').run(path);
          refreshed.push(path);
          continue;
        }

        // Title preference: when refreshing the lift target, use the
        // resolver-supplied title (it already encodes "projects/beside"
        // → "Beside"). For other refreshed rows, fall back to the
        // existing entity's title or a path-derived best guess.
        let title = path === targetPath ? input.target.title : '';
        if (!title) {
          const existing = this.db
            .prepare('SELECT title FROM entities WHERE path = ?')
            .get(path) as { title: string } | undefined;
          title = existing?.title || pathToTitle(path) || stats.title_hint || path;
        }

        const kind =
          path === targetPath
            ? input.target.kind
            : ((stats.kind as EntityKind | null) ??
              ((this.db
                .prepare('SELECT kind FROM entities WHERE path = ?')
                .get(path) as { kind: string } | undefined)?.kind as EntityKind | undefined) ??
              'app');

        this.db
          .prepare(
            `INSERT INTO entities
              (path, kind, title, first_seen, last_seen, total_focused_ms, frame_count)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET
               kind = excluded.kind,
               title = excluded.title,
               first_seen = excluded.first_seen,
               last_seen = excluded.last_seen,
               total_focused_ms = excluded.total_focused_ms,
               frame_count = excluded.frame_count`,
          )
          .run(
            path,
            kind,
            title,
            stats.first_seen ?? new Date().toISOString(),
            stats.last_seen ?? new Date().toISOString(),
            stats.total_focused_ms,
            stats.frame_count,
          );
        refreshed.push(path);
      }
    });
    tx();

    return { moved, refreshedEntities: refreshed };
  }

  // -------------------------------------------------------------------------
  // Vacuum
  // -------------------------------------------------------------------------

  async listFramesForVacuum(
    currentTier: FrameAssetTier,
    olderThanIso: string,
    limit: number,
  ): Promise<FrameAsset[]> {
    // `vacuum_tier IS NULL` is treated as 'original' for back-compat.
    const tierCondition =
      currentTier === 'original'
        ? "(vacuum_tier IS NULL OR vacuum_tier = 'original')"
        : 'vacuum_tier = @tier';
    const rows = this.db
      .prepare(
        `SELECT id, asset_path, timestamp, vacuum_tier
         FROM frames
         WHERE asset_path IS NOT NULL
           AND timestamp < @olderThan
           AND ${tierCondition}
         ORDER BY timestamp ASC
         LIMIT @limit`,
      )
      .all({
        olderThan: olderThanIso,
        tier: currentTier,
        limit: Math.max(1, Math.floor(limit)),
      }) as Array<{
      id: string;
      asset_path: string;
      timestamp: string;
      vacuum_tier: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      asset_path: r.asset_path,
      timestamp: r.timestamp,
      tier: (r.vacuum_tier as FrameAssetTier) ?? 'original',
    }));
  }

  async updateFrameAsset(
    frameId: string,
    update: { assetPath?: string | null; tier: FrameAssetTier },
  ): Promise<void> {
    if (update.assetPath !== undefined) {
      this.db
        .prepare('UPDATE frames SET asset_path = ?, vacuum_tier = ? WHERE id = ?')
        .run(update.assetPath, update.tier, frameId);
    } else {
      this.db
        .prepare('UPDATE frames SET vacuum_tier = ? WHERE id = ?')
        .run(update.tier, frameId);
    }
    this.invalidateAssetBytesCache();
  }

  async countFramesByTier(): Promise<Record<FrameAssetTier, number>> {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(vacuum_tier, 'original') AS tier, COUNT(*) AS n
         FROM frames WHERE asset_path IS NOT NULL
         GROUP BY tier`,
      )
      .all() as Array<{ tier: string; n: number }>;
    const out: Record<FrameAssetTier, number> = {
      original: 0,
      compressed: 0,
      thumbnail: 0,
      deleted: 0,
    };
    for (const r of rows) {
      const t = r.tier as FrameAssetTier;
      if (t in out) out[t] = r.n;
    }
    // 'deleted' frames have asset_path IS NULL — count them separately.
    const deletedRow = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM frames
         WHERE asset_path IS NULL AND vacuum_tier = 'deleted'`,
      )
      .get() as { n: number };
    out.deleted = deletedRow.n;
    return out;
  }

  async deleteAssetIfUnreferenced(assetPath: string): Promise<void> {
    await this.unlinkAsset(assetPath);
  }

  // -------------------------------------------------------------------------
  // Activity sessions
  // -------------------------------------------------------------------------

  async upsertSession(session: ActivitySession): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sessions
          (id, started_at, ended_at, day, duration_ms, active_ms,
           frame_count, primary_entity_path, primary_entity_kind,
           primary_app, entities_json)
         VALUES
          (@id, @started_at, @ended_at, @day, @duration_ms, @active_ms,
           @frame_count, @primary_entity_path, @primary_entity_kind,
           @primary_app, @entities_json)
         ON CONFLICT(id) DO UPDATE SET
           ended_at = excluded.ended_at,
           duration_ms = excluded.duration_ms,
           active_ms = excluded.active_ms,
           frame_count = excluded.frame_count,
           primary_entity_path = excluded.primary_entity_path,
           primary_entity_kind = excluded.primary_entity_kind,
           primary_app = excluded.primary_app,
           entities_json = excluded.entities_json`,
      )
      .run({
        id: session.id,
        started_at: session.started_at,
        ended_at: session.ended_at,
        day: session.day,
        duration_ms: session.duration_ms,
        active_ms: session.active_ms,
        frame_count: session.frame_count,
        primary_entity_path: session.primary_entity_path,
        primary_entity_kind: session.primary_entity_kind,
        primary_app: session.primary_app,
        entities_json: JSON.stringify(session.entities),
      });
  }

  async getSession(id: string): Promise<ActivitySession | null> {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(id) as RawSessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  async listSessions(query: ListSessionsQuery = {}): Promise<ActivitySession[]> {
    const where: string[] = ['1=1'];
    const params: Record<string, unknown> = {};
    if (query.day) {
      where.push('day = @day');
      params.day = query.day;
    }
    if (query.from) {
      where.push('started_at >= @from');
      params.from = query.from;
    }
    if (query.to) {
      where.push('started_at <= @to');
      params.to = query.to;
    }
    const order = query.order === 'chronological' ? 'ASC' : 'DESC';
    const limit = query.limit ?? 200;
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE ${where.join(' AND ')}
         ORDER BY started_at ${order}
         LIMIT @limit`,
      )
      .all({ ...params, limit }) as RawSessionRow[];
    return rows.map(rowToSession);
  }

  async listFramesNeedingSessionAssignment(limit: number): Promise<Frame[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM frames
         WHERE activity_session_id IS NULL
         ORDER BY timestamp ASC
         LIMIT ?`,
      )
      .all(limit) as RawFrameRow[];
    return rows.map(rowToFrame);
  }

  async assignFramesToSession(frameIds: string[], sessionId: string): Promise<void> {
    if (frameIds.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE frames SET activity_session_id = ? WHERE id = ?`,
    );
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) stmt.run(sessionId, id);
    });
    tx(frameIds);
  }

  async getSessionFrames(sessionId: string): Promise<Frame[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM frames
         WHERE activity_session_id = ?
         ORDER BY timestamp ASC`,
      )
      .all(sessionId) as RawFrameRow[];
    return rows.map(rowToFrame);
  }

  async clearAllSessions(): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.exec(`UPDATE frames SET activity_session_id = NULL`);
      this.db.exec(`DELETE FROM sessions`);
    });
    tx();
  }

  // -------------------------------------------------------------------------
  // Meetings
  // -------------------------------------------------------------------------

  async upsertMeeting(meeting: Meeting): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO meetings
          (id, entity_path, title, platform, started_at, ended_at, day,
           duration_ms, frame_count, screenshot_count, audio_chunk_count,
           transcript_chars, content_hash, summary_status, summary_md,
           summary_json, attendees_json, links_json, failure_reason,
           updated_at)
         VALUES
          (@id, @entity_path, @title, @platform, @started_at, @ended_at, @day,
           @duration_ms, @frame_count, @screenshot_count, @audio_chunk_count,
           @transcript_chars, @content_hash, @summary_status, @summary_md,
           @summary_json, @attendees_json, @links_json, @failure_reason,
           @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           title = COALESCE(excluded.title, meetings.title),
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           day = excluded.day,
           duration_ms = excluded.duration_ms,
           frame_count = excluded.frame_count,
           screenshot_count = excluded.screenshot_count,
           audio_chunk_count = excluded.audio_chunk_count,
           transcript_chars = excluded.transcript_chars,
           content_hash = excluded.content_hash,
           summary_status = CASE
             WHEN meetings.content_hash != excluded.content_hash
             THEN excluded.summary_status
             WHEN meetings.summary_status = 'skipped_short'
              AND excluded.summary_status <> 'skipped_short'
             THEN excluded.summary_status
             ELSE meetings.summary_status
           END,
           summary_md = CASE
             WHEN meetings.content_hash != excluded.content_hash
             THEN excluded.summary_md
             ELSE meetings.summary_md
           END,
           summary_json = CASE
             WHEN meetings.content_hash != excluded.content_hash
             THEN excluded.summary_json
             ELSE meetings.summary_json
           END,
           attendees_json = excluded.attendees_json,
           links_json = excluded.links_json,
           failure_reason = CASE
             WHEN meetings.content_hash != excluded.content_hash
             THEN excluded.failure_reason
             WHEN meetings.summary_status = 'skipped_short'
              AND excluded.summary_status <> 'skipped_short'
             THEN NULL
             ELSE meetings.failure_reason
           END,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: meeting.id,
        entity_path: meeting.entity_path,
        title: meeting.title ?? null,
        platform: meeting.platform,
        started_at: meeting.started_at,
        ended_at: meeting.ended_at,
        day: meeting.day,
        duration_ms: meeting.duration_ms,
        frame_count: meeting.frame_count,
        screenshot_count: meeting.screenshot_count,
        audio_chunk_count: meeting.audio_chunk_count,
        transcript_chars: meeting.transcript_chars,
        content_hash: meeting.content_hash,
        summary_status: meeting.summary_status,
        summary_md: meeting.summary_md,
        summary_json: meeting.summary_json
          ? JSON.stringify(meeting.summary_json)
          : null,
        attendees_json: JSON.stringify(meeting.attendees ?? []),
        links_json: JSON.stringify(meeting.links ?? []),
        failure_reason: meeting.failure_reason,
        updated_at: meeting.updated_at,
      });
  }

  async getMeeting(id: string): Promise<Meeting | null> {
    const row = this.db
      .prepare(`SELECT * FROM meetings WHERE id = ?`)
      .get(id) as RawMeetingRow | undefined;
    return row ? this.cachedRowToMeeting(row) : null;
  }

  // Parse-cache wrapper around rowToMeeting. summary_json is the
  // expensive parse; attendees / links are smaller but parse on the
  // same row, so we cache the full Meeting object to avoid repeating
  // any of the work. Key includes updated_at so writes naturally
  // invalidate without needing a separate invalidation hook.
  private cachedRowToMeeting(row: RawMeetingRow): Meeting {
    const key = `${row.id}|${row.updated_at}`;
    const cached = this.meetingParseCache.get(key);
    if (cached) {
      // Refresh recency: re-insert at the tail of the Map.
      this.meetingParseCache.delete(key);
      this.meetingParseCache.set(key, cached);
      return cached;
    }
    const parsed = rowToMeeting(row);
    this.meetingParseCache.set(key, parsed);
    while (this.meetingParseCache.size > MEETING_PARSE_CACHE_CAP) {
      const oldest = this.meetingParseCache.keys().next().value;
      if (oldest === undefined) break;
      this.meetingParseCache.delete(oldest);
    }
    return parsed;
  }

  async listMeetings(query: ListMeetingsQuery = {}): Promise<Meeting[]> {
    const where: string[] = ['1=1'];
    const params: Record<string, unknown> = {};
    if (query.day) {
      where.push('day = @day');
      params.day = query.day;
    }
    if (query.from) {
      where.push('started_at >= @from');
      params.from = query.from;
    }
    if (query.to) {
      where.push('started_at <= @to');
      params.to = query.to;
    }
    if (query.platform) {
      where.push('platform = @platform');
      params.platform = query.platform;
    }
    if (query.summaryStatus) {
      where.push('summary_status = @status');
      params.status = query.summaryStatus;
    }
    const order = query.order === 'chronological' ? 'ASC' : 'DESC';
    const limit = query.limit ?? 200;
    const rows = this.db
      .prepare(
        `SELECT * FROM meetings
         WHERE ${where.join(' AND ')}
         ORDER BY started_at ${order}
         LIMIT @limit`,
      )
      .all({ ...params, limit }) as RawMeetingRow[];
    return rows.map((r) => this.cachedRowToMeeting(r));
  }

  async listFramesNeedingMeetingAssignment(limit: number): Promise<Frame[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM frames
         WHERE entity_kind = 'meeting' AND meeting_id IS NULL
         ORDER BY timestamp ASC
         LIMIT ?`,
      )
      .all(limit) as RawFrameRow[];
    return rows.map(rowToFrame);
  }

  async assignFramesToMeeting(frameIds: string[], meetingId: string): Promise<void> {
    if (frameIds.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE frames SET meeting_id = ? WHERE id = ?`,
    );
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) stmt.run(meetingId, id);
    });
    tx(frameIds);
  }

  async getMeetingFrames(meetingId: string): Promise<Frame[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM frames
         WHERE meeting_id = ?
         ORDER BY timestamp ASC`,
      )
      .all(meetingId) as RawFrameRow[];
    return rows.map(rowToFrame);
  }

  async listAudioFramesInRange(fromIso: string, toIso: string): Promise<Frame[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM frames
         WHERE text_source = 'audio'
           AND timestamp >= ?
           AND timestamp <= ?
         ORDER BY timestamp ASC`,
      )
      .all(fromIso, toIso) as RawFrameRow[];
    return rows.map(rowToFrame);
  }

  async setMeetingTurns(
    meetingId: string,
    turns: Array<Omit<MeetingTurn, 'id' | 'meeting_id'>>,
  ): Promise<MeetingTurn[]> {
    const insert = this.db.prepare(
      `INSERT INTO meeting_turns
        (meeting_id, t_start, t_end, speaker, text, visual_frame_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM meeting_turns WHERE meeting_id = ?`).run(meetingId);
      for (const turn of turns) {
        insert.run(
          meetingId,
          turn.t_start,
          turn.t_end,
          turn.speaker,
          turn.text,
          turn.visual_frame_id,
          turn.source,
        );
      }
    });
    tx();
    return this.getMeetingTurns(meetingId);
  }

  async getMeetingTurns(meetingId: string): Promise<MeetingTurn[]> {
    const rows = this.db
      .prepare(
        `SELECT id, meeting_id, t_start, t_end, speaker, text, visual_frame_id, source
         FROM meeting_turns
         WHERE meeting_id = ?
         ORDER BY t_start ASC, id ASC`,
      )
      .all(meetingId) as RawMeetingTurnRow[];
    return rows.map(rowToMeetingTurn);
  }

  async setMeetingSummary(
    meetingId: string,
    update: MeetingSummaryUpdate,
  ): Promise<void> {
    const fields: string[] = ['summary_status = @status', 'updated_at = @updated_at'];
    const params: Record<string, unknown> = {
      id: meetingId,
      status: update.status,
      updated_at: new Date().toISOString(),
    };
    if (update.md !== undefined) {
      fields.push('summary_md = @md');
      params.md = update.md;
    }
    if (update.json !== undefined) {
      fields.push('summary_json = @json');
      params.json = update.json ? JSON.stringify(update.json) : null;
    }
    if (update.contentHash !== undefined) {
      fields.push('content_hash = @hash');
      params.hash = update.contentHash;
    }
    if (update.failureReason !== undefined) {
      fields.push('failure_reason = @reason');
      params.reason = update.failureReason;
    }
    if (update.title !== undefined && update.title !== null) {
      fields.push('title = @title');
      params.title = update.title;
    }
    this.db
      .prepare(`UPDATE meetings SET ${fields.join(', ')} WHERE id = @id`)
      .run(params);
  }

  async clearAllMeetings(): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.exec(`UPDATE frames SET meeting_id = NULL`);
      this.db.exec(`UPDATE calendar_events SET meeting_id = NULL, actual_started_at = NULL, actual_ended_at = NULL, meeting_platform = NULL, meeting_summary_status = NULL`);
      this.db.exec(`DELETE FROM meeting_turns`);
      this.db.exec(`DELETE FROM meetings`);
      this.db.exec(`
        DELETE FROM memory_chunk_text WHERE chunk_id IN (
          SELECT id FROM memory_chunks WHERE kind = 'meeting_summary'
        );
        DELETE FROM memory_chunk_embeddings WHERE chunk_id IN (
          SELECT id FROM memory_chunks WHERE kind = 'meeting_summary'
        );
        DELETE FROM memory_chunks WHERE kind = 'meeting_summary';
      `);
    });
    tx();
  }

  // -------------------------------------------------------------------------
  // Calendar events (canonical calendar capture model).
  // -------------------------------------------------------------------------

  async upsertCalendarSource(source: CalendarSource): Promise<void> {
    this.db.prepare(`
      INSERT INTO calendar_sources (
        source_key, provider, label, app, app_bundle_id, url_host, created_at, updated_at
      ) VALUES (
        @source_key, @provider, @label, @app, @app_bundle_id, @url_host, @created_at, @updated_at
      )
      ON CONFLICT(source_key) DO UPDATE SET
        provider = excluded.provider,
        label = excluded.label,
        app = COALESCE(excluded.app, calendar_sources.app),
        app_bundle_id = COALESCE(excluded.app_bundle_id, calendar_sources.app_bundle_id),
        url_host = COALESCE(excluded.url_host, calendar_sources.url_host),
        updated_at = excluded.updated_at
    `).run(source);
  }

  async upsertCalendarCapture(capture: CalendarCapture): Promise<void> {
    this.db.prepare(`
      INSERT INTO calendar_captures (
        id, source_key, day, captured_at, frame_ids_json, evidence_hash,
        parser, status, confidence, visible_days_json, failure_reason, created_at, updated_at
      ) VALUES (
        @id, @source_key, @day, @captured_at, @frame_ids_json, @evidence_hash,
        @parser, @status, @confidence, @visible_days_json, @failure_reason, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        source_key = excluded.source_key,
        day = excluded.day,
        captured_at = excluded.captured_at,
        frame_ids_json = excluded.frame_ids_json,
        evidence_hash = excluded.evidence_hash,
        parser = excluded.parser,
        status = excluded.status,
        confidence = excluded.confidence,
        visible_days_json = excluded.visible_days_json,
        failure_reason = excluded.failure_reason,
        updated_at = excluded.updated_at
    `).run({
      ...capture,
      frame_ids_json: JSON.stringify(capture.frame_ids ?? []),
      visible_days_json: JSON.stringify(capture.visible_days ?? []),
    });
  }

  async reconcileCalendarEvents(input: CalendarReconcileInput): Promise<CalendarReconcileResult> {
    const tx = this.db.transaction(() => {
      this.upsertCalendarSource(input.source);
      this.upsertCalendarCapture(input.capture);
      let upserted = 0;
      for (const event of input.events) {
        this.upsertCalendarEvent(event);
        upserted++;
      }
      let stale = 0;
      if (input.markMissingStale !== false && input.capture.status === 'ready') {
        const activeIds = new Set(input.events.map((event) => event.id));
        const rows = this.db
          .prepare("SELECT id FROM calendar_events WHERE source_key = ? AND day = ? AND status = 'active'")
          .all(input.source.source_key, input.capture.day) as Array<{ id: string }>;
        const missing = rows.map((row) => row.id).filter((id) => !activeIds.has(id));
        if (missing.length > 0) {
          const now = input.capture.updated_at;
          const placeholders = missing.map((_, i) => `?`).join(',');
          stale = this.db
            .prepare(`UPDATE calendar_events SET status = 'stale', updated_at = ? WHERE id IN (${placeholders})`)
            .run(now, ...missing).changes;
        }
      }
      return { upserted, stale };
    });
    return tx() as CalendarReconcileResult;
  }

  async upsertCalendarEvent(event: CalendarEvent): Promise<void> {
    this.db.prepare(`
      INSERT INTO calendar_events (
        id, source_key, provider, day, starts_at, ends_at, title, location,
        attendees_json, links_json, notes, source_app, source_url, source_bundle_id,
        evidence_frame_ids_json, first_seen_capture_id, last_seen_capture_id, status,
        content_hash, meeting_id, actual_started_at, actual_ended_at, meeting_platform,
        meeting_summary_status, created_at, updated_at
      ) VALUES (
        @id, @source_key, @provider, @day, @starts_at, @ends_at, @title, @location,
        @attendees_json, @links_json, @notes, @source_app, @source_url, @source_bundle_id,
        @evidence_frame_ids_json, @first_seen_capture_id, @last_seen_capture_id, @status,
        @content_hash, @meeting_id, @actual_started_at, @actual_ended_at, @meeting_platform,
        @meeting_summary_status, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        source_key = excluded.source_key,
        provider = excluded.provider,
        day = excluded.day,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        title = excluded.title,
        location = excluded.location,
        attendees_json = excluded.attendees_json,
        links_json = excluded.links_json,
        notes = excluded.notes,
        source_app = excluded.source_app,
        source_url = excluded.source_url,
        source_bundle_id = excluded.source_bundle_id,
        evidence_frame_ids_json = excluded.evidence_frame_ids_json,
        last_seen_capture_id = excluded.last_seen_capture_id,
        status = excluded.status,
        content_hash = excluded.content_hash,
        meeting_id = COALESCE(excluded.meeting_id, calendar_events.meeting_id),
        actual_started_at = COALESCE(excluded.actual_started_at, calendar_events.actual_started_at),
        actual_ended_at = COALESCE(excluded.actual_ended_at, calendar_events.actual_ended_at),
        meeting_platform = COALESCE(excluded.meeting_platform, calendar_events.meeting_platform),
        meeting_summary_status = COALESCE(excluded.meeting_summary_status, calendar_events.meeting_summary_status),
        updated_at = excluded.updated_at
    `).run({
      ...event,
      attendees_json: JSON.stringify(event.attendees ?? []),
      links_json: JSON.stringify(event.links ?? []),
      evidence_frame_ids_json: JSON.stringify(event.evidence_frame_ids ?? []),
    });
  }

  async clearCalendarEventMeetingLink(id: string): Promise<void> {
    this.db
      .prepare(`
        UPDATE calendar_events
        SET meeting_id = NULL,
            actual_started_at = NULL,
            actual_ended_at = NULL,
            meeting_platform = NULL,
            meeting_summary_status = NULL,
            updated_at = ?
        WHERE id = ?
      `)
      .run(new Date().toISOString(), id);
  }

  async getCalendarEvent(id: string): Promise<CalendarEvent | null> {
    const row = this.db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) as CalendarEventRow | undefined;
    return row ? calendarEventFromRow(row) : null;
  }

  async listCalendarEvents(query: ListCalendarEventsQuery = {}): Promise<CalendarEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.sourceKey) { where.push('source_key = ?'); params.push(query.sourceKey); }
    if (query.day) { where.push('day = ?'); params.push(query.day); }
    if (query.from) { where.push('starts_at >= ?'); params.push(query.from); }
    if (query.to) { where.push('starts_at <= ?'); params.push(query.to); }
    if (query.status) { where.push('status = ?'); params.push(query.status); }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = query.order === 'chronological' ? 'ORDER BY starts_at ASC' : 'ORDER BY starts_at DESC';
    const limit = Math.max(1, Math.min(query.limit ?? 500, 5000));
    const rows = this.db.prepare(`SELECT * FROM calendar_events ${whereSql} ${orderSql} LIMIT ?`).all(...params, limit) as CalendarEventRow[];
    return rows.map(calendarEventFromRow);
  }

  async clearAllCalendarEvents(): Promise<void> {
    this.db.exec(`
      DELETE FROM calendar_events;
      DELETE FROM calendar_captures;
      DELETE FROM calendar_sources;
    `);
  }

  // -------------------------------------------------------------------------
  // Day events (cross-source event log).
  // -------------------------------------------------------------------------

  async upsertDayEvent(event: DayEvent): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO day_events (
        id, day, starts_at, ends_at, kind, source, title, source_app,
        context_md, attendees_json, links_json, meeting_id,
        evidence_frame_ids_json, content_hash, status, failure_reason,
        created_at, updated_at
      ) VALUES (
        @id, @day, @starts_at, @ends_at, @kind, @source, @title, @source_app,
        @context_md, @attendees_json, @links_json, @meeting_id,
        @evidence_frame_ids_json, @content_hash, @status, @failure_reason,
        @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        day = excluded.day,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        kind = excluded.kind,
        source = excluded.source,
        title = excluded.title,
        source_app = excluded.source_app,
        context_md = excluded.context_md,
        attendees_json = excluded.attendees_json,
        links_json = excluded.links_json,
        meeting_id = excluded.meeting_id,
        evidence_frame_ids_json = excluded.evidence_frame_ids_json,
        content_hash = excluded.content_hash,
        status = excluded.status,
        failure_reason = excluded.failure_reason,
        updated_at = excluded.updated_at
    `);
    stmt.run({
      id: event.id,
      day: event.day,
      starts_at: event.starts_at,
      ends_at: event.ends_at,
      kind: event.kind,
      source: event.source,
      title: event.title,
      source_app: event.source_app,
      context_md: event.context_md,
      attendees_json: JSON.stringify(event.attendees ?? []),
      links_json: JSON.stringify(event.links ?? []),
      meeting_id: event.meeting_id,
      evidence_frame_ids_json: JSON.stringify(event.evidence_frame_ids ?? []),
      content_hash: event.content_hash,
      status: event.status,
      failure_reason: event.failure_reason,
      created_at: event.created_at,
      updated_at: event.updated_at,
    });
  }

  async getDayEvent(id: string): Promise<DayEvent | null> {
    const row = this.db
      .prepare('SELECT * FROM day_events WHERE id = ?')
      .get(id) as DayEventRow | undefined;
    return row ? dayEventFromRow(row) : null;
  }

  async listDayEvents(query: ListDayEventsQuery = {}): Promise<DayEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.day) {
      where.push('day = ?');
      params.push(query.day);
    }
    if (query.from) {
      where.push('starts_at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      where.push('starts_at <= ?');
      params.push(query.to);
    }
    if (query.kind) {
      where.push('kind = ?');
      params.push(query.kind);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql =
      query.order === 'chronological'
        ? 'ORDER BY starts_at ASC'
        : 'ORDER BY starts_at DESC';
    const limit = Math.max(1, Math.min(query.limit ?? 500, 5000));
    const rows = this.db
      .prepare(`SELECT * FROM day_events ${whereSql} ${orderSql} LIMIT ?`)
      .all(...params, limit) as DayEventRow[];
    return rows.map(dayEventFromRow);
  }

  async deleteDayEvent(id: string): Promise<void> {
    this.deleteDayEventsAndChunks([id]);
  }

  async deleteDayEventsBySourceForDay(
    day: string,
    source: DayEventSource,
  ): Promise<void> {
    const ids = (
      this.db
        .prepare('SELECT id FROM day_events WHERE day = ? AND source = ?')
        .all(day, source) as Array<{ id: string }>
    ).map((row) => row.id);
    this.deleteDayEventsAndChunks(ids);
  }

  async clearAllDayEvents(): Promise<void> {
    this.db.exec(`
      DELETE FROM day_events;
      DELETE FROM memory_chunk_text WHERE chunk_id IN (
        SELECT id FROM memory_chunks WHERE kind = 'day_event'
      );
      DELETE FROM memory_chunk_embeddings WHERE chunk_id IN (
        SELECT id FROM memory_chunks WHERE kind = 'day_event'
      );
      DELETE FROM memory_chunks WHERE kind = 'day_event';
    `);
  }

  // -------------------------------------------------------------------------
  // Hook records (per-hook isolated storage)
  // -------------------------------------------------------------------------

  async hookPut(
    hookId: string,
    record: {
      collection: string;
      id: string;
      data: unknown;
      evidenceEventIds?: string[];
      contentHash?: string | null;
    },
  ): Promise<HookRecord> {
    const now = new Date().toISOString();
    const evidence = JSON.stringify(record.evidenceEventIds ?? []);
    const dataJson = JSON.stringify(record.data ?? null);
    const contentHash = record.contentHash ?? null;

    const stmt = this.db.prepare(`
      INSERT INTO hook_records (hook_id, collection, id, data_json, evidence_ids_json, content_hash, created_at, updated_at)
      VALUES (@hook_id, @collection, @id, @data_json, @evidence_ids_json, @content_hash, @created_at, @updated_at)
      ON CONFLICT(hook_id, collection, id) DO UPDATE SET
        data_json = excluded.data_json,
        evidence_ids_json = excluded.evidence_ids_json,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
    `);
    stmt.run({
      hook_id: hookId,
      collection: record.collection,
      id: record.id,
      data_json: dataJson,
      evidence_ids_json: evidence,
      content_hash: contentHash,
      created_at: now,
      updated_at: now,
    });

    const row = this.db
      .prepare(
        `SELECT * FROM hook_records WHERE hook_id = ? AND collection = ? AND id = ?`,
      )
      .get(hookId, record.collection, record.id) as HookRecordRow;
    return hookRecordFromRow(row);
  }

  async hookGet(
    hookId: string,
    collection: string,
    id: string,
  ): Promise<HookRecord | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM hook_records WHERE hook_id = ? AND collection = ? AND id = ?`,
      )
      .get(hookId, collection, id) as HookRecordRow | undefined;
    return row ? hookRecordFromRow(row) : null;
  }

  async hookDelete(hookId: string, collection: string, id: string): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM hook_records WHERE hook_id = ? AND collection = ? AND id = ?`,
      )
      .run(hookId, collection, id);
  }

  async hookList(
    hookId: string,
    query: HookRecordQuery = {},
  ): Promise<HookRecord[]> {
    const where: string[] = ['hook_id = ?'];
    const params: unknown[] = [hookId];
    if (query.collection) {
      where.push('collection = ?');
      params.push(query.collection);
    }
    if (query.id) {
      where.push('id = ?');
      params.push(query.id);
    }
    if (query.evidenceEventId) {
      where.push('evidence_ids_json LIKE ?');
      params.push(`%"${query.evidenceEventId}"%`);
    }
    if (query.updatedAfter) {
      where.push('updated_at >= ?');
      params.push(query.updatedAfter);
    }
    const orderSql =
      query.order === 'chronological' ? 'ORDER BY created_at ASC' : 'ORDER BY updated_at DESC';
    const limit = Math.max(1, Math.min(query.limit ?? 200, 5000));
    const offset = Math.max(0, query.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT * FROM hook_records WHERE ${where.join(' AND ')} ${orderSql} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as HookRecordRow[];
    return rows.map(hookRecordFromRow);
  }

  async hookClear(hookId: string, collection?: string): Promise<{ removed: number }> {
    if (collection) {
      const res = this.db
        .prepare(`DELETE FROM hook_records WHERE hook_id = ? AND collection = ?`)
        .run(hookId, collection);
      return { removed: res.changes };
    }
    const res = this.db
      .prepare(`DELETE FROM hook_records WHERE hook_id = ?`)
      .run(hookId);
    return { removed: res.changes };
  }

  // -------------------------------------------------------------------------
  // Deletion (privacy-driven)
  //
  // We always remove DB rows and disk assets together, in that order, so a
  // crash mid-delete leaves orphaned files (recoverable by a future
  // cleanup pass) rather than orphaned DB rows pointing at missing files.
  // Asset deletes are best-effort: a missing file is logged but not fatal.
  // -------------------------------------------------------------------------

  async deleteFrame(frameId: string): Promise<{ assetPath: string | null }> {
    const row = this.db
      .prepare('SELECT asset_path FROM frames WHERE id = ?')
      .get(frameId) as { asset_path: string | null } | undefined;
    if (!row) return { assetPath: null };

    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM frame_text WHERE frame_id = ?').run(frameId);
      this.db.prepare('DELETE FROM frame_embeddings WHERE frame_id = ?').run(frameId);
      const frameRef = `%frame:${frameId}%`;
      this.db.prepare(`
        DELETE FROM memory_chunk_text WHERE chunk_id IN (
          SELECT id FROM memory_chunks WHERE source_refs_json LIKE ?
        )
      `).run(frameRef);
      this.db.prepare(`
        DELETE FROM memory_chunk_embeddings WHERE chunk_id IN (
          SELECT id FROM memory_chunks WHERE source_refs_json LIKE ?
        )
      `).run(frameRef);
      this.db.prepare('DELETE FROM memory_chunks WHERE source_refs_json LIKE ?').run(frameRef);
      this.db.prepare('DELETE FROM frames WHERE id = ?').run(frameId);
    });
    tx();

    if (row.asset_path) {
      await this.unlinkAsset(row.asset_path);
    }
    this.invalidateAssetBytesCache();
    return { assetPath: row.asset_path };
  }

  async deleteFrames(
    query: FrameDeleteQuery,
  ): Promise<{ frames: number; assetPaths: string[] }> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    const app = query.app?.trim();
    if (app) {
      where.push('app = @app');
      params.app = app;
    }

    const domain = query.urlDomain?.trim();
    if (domain) {
      const host = normaliseHostFilter(domain);
      if (host) {
        where.push('(url_host = @url_host OR url_host LIKE @url_host_sub)');
        params.url_host = host;
        params.url_host_sub = `%.${host}`;
      }
    }

    if (where.length === 0) {
      throw new Error('deleteFrames requires app or urlDomain');
    }

    const rows = this.db
      .prepare(
        `SELECT id, asset_path, meeting_id, source_event_ids
         FROM frames
         WHERE ${where.join(' AND ')}`,
      )
      .all(params) as Array<{
        id: string;
        asset_path: string | null;
        meeting_id: string | null;
        source_event_ids: string;
      }>;

    if (rows.length === 0) return { frames: 0, assetPaths: [] };

    const ids = rows.map((r) => r.id);
    const assetPaths = rows
      .map((r) => r.asset_path)
      .filter((p): p is string => Boolean(p));
    const meetingIds = Array.from(
      new Set(rows.map((r) => r.meeting_id).filter((id): id is string => Boolean(id))),
    );
    const eventIds = Array.from(
      new Set(
        rows.flatMap((r) => parseJsonStringArray(r.source_event_ids)),
      ),
    );

    const tx = this.db.transaction(() => {
      const framePlaceholders = ids.map(() => '?').join(',');
      this.db
        .prepare(`DELETE FROM frame_text WHERE frame_id IN (${framePlaceholders})`)
        .run(...ids);
      this.db
        .prepare(`DELETE FROM frame_embeddings WHERE frame_id IN (${framePlaceholders})`)
        .run(...ids);

      const dayEventIds = this.dayEventIdsForFrameIds(ids);
      this.deleteMemoryChunksForFrameIds(ids);
      this.deleteDayEventsAndChunks(dayEventIds);

      if (meetingIds.length > 0) {
        this.deleteMeetingsAndChunks(meetingIds);
      }

      this.db
        .prepare(`DELETE FROM frames WHERE id IN (${framePlaceholders})`)
        .run(...ids);

      if (eventIds.length > 0) {
        const eventPlaceholders = eventIds.map(() => '?').join(',');
        this.db
          .prepare(`DELETE FROM events WHERE id IN (${eventPlaceholders})`)
          .run(...eventIds);
      }

      this.db.exec(`
        DELETE FROM sessions
        WHERE id NOT IN (
          SELECT DISTINCT activity_session_id
          FROM frames
          WHERE activity_session_id IS NOT NULL
        );
        DELETE FROM entities
        WHERE path NOT IN (
          SELECT DISTINCT entity_path
          FROM frames
          WHERE entity_path IS NOT NULL
        );
      `);
    });
    tx();

    for (const p of assetPaths) {
      await this.unlinkAsset(p);
    }
    this.invalidateAssetBytesCache();

    return { frames: ids.length, assetPaths };
  }

  async deleteOldData(retentionDays: number): Promise<{
    frames: number;
    events: number;
    sessions: number;
    meetings: number;
    entities: number;
    assetPaths: string[];
  }> {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return {
        frames: 0,
        events: 0,
        sessions: 0,
        meetings: 0,
        entities: 0,
        assetPaths: [],
      };
    }

    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Asset paths must be collected BEFORE the cascade so we still
    // know which on-disk screenshots to unlink.
    const assetPaths = (
      this.db
        .prepare(
          'SELECT asset_path FROM frames WHERE timestamp < ? AND asset_path IS NOT NULL',
        )
        .all(cutoff) as Array<{ asset_path: string }>
    ).map((r) => r.asset_path);

    let frames = 0;
    let events = 0;
    let sessions = 0;
    let meetings = 0;
    let entities = 0;

    const tx = this.db.transaction(() => {
      // Cascade: child rows keyed by frame_id / meeting_id first, so
      // when we delete the parents we don't leave orphans behind. Use
      // subqueries so we don't pull thousands of IDs into JS just to
      // shove them back into an IN-clause.
      this.db
        .prepare(
          'DELETE FROM frame_text WHERE frame_id IN (SELECT id FROM frames WHERE timestamp < ?)',
        )
        .run(cutoff);
      this.db
        .prepare(
          'DELETE FROM frame_embeddings WHERE frame_id IN (SELECT id FROM frames WHERE timestamp < ?)',
        )
        .run(cutoff);
      this.db
        .prepare(
          'DELETE FROM meeting_turns WHERE meeting_id IN (SELECT id FROM meetings WHERE started_at < ?)',
        )
        .run(cutoff);

      frames = this.db
        .prepare('DELETE FROM frames WHERE timestamp < ?')
        .run(cutoff).changes;
      events = this.db
        .prepare('DELETE FROM events WHERE timestamp < ?')
        .run(cutoff).changes;
      sessions = this.db
        .prepare('DELETE FROM sessions WHERE started_at < ?')
        .run(cutoff).changes;
      meetings = this.db
        .prepare('DELETE FROM meetings WHERE started_at < ?')
        .run(cutoff).changes;
      this.db
        .prepare('DELETE FROM day_events WHERE starts_at < ?')
        .run(cutoff);
      this.db
        .prepare(`
          DELETE FROM memory_chunk_text WHERE chunk_id IN (
            SELECT id FROM memory_chunks
            WHERE COALESCE(timestamp, updated_at) < ?
          )
        `)
        .run(cutoff);
      this.db
        .prepare(`
          DELETE FROM memory_chunk_embeddings WHERE chunk_id IN (
            SELECT id FROM memory_chunks
            WHERE COALESCE(timestamp, updated_at) < ?
          )
        `)
        .run(cutoff);
      this.db
        .prepare('DELETE FROM memory_chunks WHERE COALESCE(timestamp, updated_at) < ?')
        .run(cutoff);
      // Entities aren't time-series rows but their last_seen tracks
      // the most recent frame that resolved to them. If that's before
      // the cutoff, the entity has no surviving frames. Drop it; if
      // the user returns to that work tomorrow the resolver will
      // recreate it from scratch.
      entities = this.db
        .prepare('DELETE FROM entities WHERE last_seen < ?')
        .run(cutoff).changes;
    });
    tx();

    if (assetPaths.length > 0) {
      for (const p of assetPaths) {
        await this.unlinkAsset(p);
      }
      this.invalidateAssetBytesCache();
    }

    return { frames, events, sessions, meetings, entities, assetPaths };
  }

  async deleteAllMemory(): Promise<{
    frames: number;
    events: number;
    assetBytes: number;
  }> {
    const assetBytes = await this.measureAssetBytes();
    const frames = (
      this.db.prepare('SELECT COUNT(*) AS n FROM frames').get() as { n: number }
    ).n;
    const events = (
      this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    ).n;

    // Tables we own. Wrapped in one transaction so a crash leaves the DB
    // either fully wiped or fully intact.
    const tablesToWipe = [
      'frame_text',
      'frame_embeddings',
      'frames',
      'sessions',
      'entities',
      'meetings',
      'meeting_turns',
      'calendar_events',
      'calendar_captures',
      'calendar_sources',
      'day_events',
      'memory_chunk_text',
      'memory_chunk_embeddings',
      'memory_chunks',
      'events',
      'index_state',
      'index_marks',
    ];
    const tx = this.db.transaction(() => {
      for (const table of tablesToWipe) {
        try {
          this.db.exec(`DELETE FROM ${table}`);
        } catch {
          // Table may not exist on older schemas — non-fatal.
        }
      }
    });
    tx();

    // Reclaim freed pages so on-disk size actually shrinks.
    try {
      this.db.exec('VACUUM');
    } catch (err) {
      this.logger.warn('VACUUM after deleteAllMemory failed', { err: String(err) });
    }

    // Wipe asset directories on disk. We keep `raw/` and `checkpoints/`
    // top-level dirs so the runtime can keep writing without re-init.
    const rawDir = path.join(this.root, 'raw');
    try {
      const entries = await fsp.readdir(rawDir).catch(() => [] as string[]);
      await Promise.all(
        entries.map((entry) =>
          fsp.rm(path.join(rawDir, entry), { recursive: true, force: true }),
        ),
      );
    } catch (err) {
      this.logger.warn('asset wipe in deleteAllMemory failed', {
        err: String(err),
      });
    }
    this.invalidateAssetBytesCache();

    return {
      frames,
      events,
      assetBytes,
    };
  }

  private dayEventIdsForFrameIds(frameIds: string[]): string[] {
    if (frameIds.length === 0) return [];
    const stmt = this.db.prepare(
      'SELECT id FROM day_events WHERE evidence_frame_ids_json LIKE ?',
    );
    const ids = new Set<string>();
    for (const frameId of frameIds) {
      const rows = stmt.all(`%"${frameId}"%`) as Array<{ id: string }>;
      for (const row of rows) ids.add(row.id);
    }
    return Array.from(ids);
  }

  private deleteMemoryChunksForFrameIds(frameIds: string[]): void {
    const selectSql = 'SELECT id FROM memory_chunks WHERE source_refs_json LIKE ?';
    for (const frameId of frameIds) {
      const ref = `%frame:${frameId}%`;
      this.db.prepare(`
        DELETE FROM memory_chunk_text WHERE chunk_id IN (${selectSql})
      `).run(ref);
      this.db.prepare(`
        DELETE FROM memory_chunk_embeddings WHERE chunk_id IN (${selectSql})
      `).run(ref);
      this.db.prepare('DELETE FROM memory_chunks WHERE source_refs_json LIKE ?').run(ref);
    }
  }

  private deleteDayEventsAndChunks(dayEventIds: string[]): void {
    if (dayEventIds.length === 0) return;
    const placeholders = dayEventIds.map(() => '?').join(',');
    this.db.prepare(`
      DELETE FROM memory_chunk_text WHERE chunk_id IN (
        SELECT id FROM memory_chunks
        WHERE kind = 'day_event' AND source_id IN (${placeholders})
      )
    `).run(...dayEventIds);
    this.db.prepare(`
      DELETE FROM memory_chunk_embeddings WHERE chunk_id IN (
        SELECT id FROM memory_chunks
        WHERE kind = 'day_event' AND source_id IN (${placeholders})
      )
    `).run(...dayEventIds);
    this.db
      .prepare(`DELETE FROM memory_chunks WHERE kind = 'day_event' AND source_id IN (${placeholders})`)
      .run(...dayEventIds);
    this.db
      .prepare(`DELETE FROM day_events WHERE id IN (${placeholders})`)
      .run(...dayEventIds);
  }

  private deleteMeetingsAndChunks(meetingIds: string[]): void {
    if (meetingIds.length === 0) return;
    const placeholders = meetingIds.map(() => '?').join(',');
    const dayEventIds = (
      this.db
        .prepare(`SELECT id FROM day_events WHERE meeting_id IN (${placeholders})`)
        .all(...meetingIds) as Array<{ id: string }>
    ).map((row) => row.id);
    this.deleteDayEventsAndChunks(dayEventIds);

    this.db.prepare(`
      DELETE FROM memory_chunk_text WHERE chunk_id IN (
        SELECT id FROM memory_chunks
        WHERE kind = 'meeting_summary' AND source_id IN (${placeholders})
      )
    `).run(...meetingIds);
    this.db.prepare(`
      DELETE FROM memory_chunk_embeddings WHERE chunk_id IN (
        SELECT id FROM memory_chunks
        WHERE kind = 'meeting_summary' AND source_id IN (${placeholders})
      )
    `).run(...meetingIds);
    this.db
      .prepare(`DELETE FROM memory_chunks WHERE kind = 'meeting_summary' AND source_id IN (${placeholders})`)
      .run(...meetingIds);
    this.db
      .prepare(`UPDATE calendar_events SET meeting_id = NULL, actual_started_at = NULL, actual_ended_at = NULL, meeting_platform = NULL, meeting_summary_status = NULL WHERE meeting_id IN (${placeholders})`)
      .run(...meetingIds);
    this.db
      .prepare(`DELETE FROM meeting_turns WHERE meeting_id IN (${placeholders})`)
      .run(...meetingIds);
    this.db
      .prepare(`DELETE FROM meetings WHERE id IN (${placeholders})`)
      .run(...meetingIds);
    this.meetingParseCache.clear();
  }

  private async unlinkAsset(assetPath: string): Promise<void> {
    if (this.isInternedScreenshotAsset(assetPath) && this.countFrameAssetReferences(assetPath) > 0) {
      return;
    }
    try {
      await fsp.unlink(this.absoluteAssetPath(assetPath));
    } catch (err) {
      // Missing files (already-vacuumed or never-existed) aren't fatal —
      // the user-visible deletion succeeded as far as the DB is concerned.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.warn('asset unlink failed', { assetPath, err: String(err) });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async internScreenshotAsset(event: RawEvent): Promise<RawEvent> {
    if (event.type !== 'screenshot' || !event.asset_path) return event;
    if (this.isInternedScreenshotAsset(event.asset_path)) return event;

    const ext = path.extname(event.asset_path).toLowerCase();
    if (!CACHEABLE_SCREENSHOT_EXTENSIONS.has(ext)) return event;

    try {
      const sourceAbs = this.absoluteAssetPath(event.asset_path);
      const input = await fsp.readFile(sourceAbs);
      const sha256 = createHash('sha256').update(input).digest('hex');
      const day = dayKey(new Date(event.timestamp));
      const cachedRel = path.join(
        'raw',
        day,
        'screenshots',
        `${sha256}${ext}`,
      );
      const cachedAbs = this.absoluteAssetPath(cachedRel);

      if (path.resolve(sourceAbs) !== path.resolve(cachedAbs)) {
        await ensureDir(path.dirname(cachedAbs));
        const cachedExists = await fileExists(cachedAbs);
        if (cachedExists) {
          await fsp.rm(sourceAbs, { force: true });
        } else {
          try {
            await fsp.rename(sourceAbs, cachedAbs);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'EXDEV') throw err;
            await fsp.copyFile(sourceAbs, cachedAbs);
            await fsp.rm(sourceAbs, { force: true });
          }
        }
      }

      return {
        ...event,
        asset_path: cachedRel,
        metadata: {
          ...event.metadata,
          asset_sha256: sha256,
          asset_storage: 'content-addressed',
          asset_original_path: event.asset_path,
        },
      };
    } catch (err) {
      this.logger.warn('screenshot asset interning failed; keeping original path', {
        assetPath: event.asset_path,
        err: String(err),
      });
      return event;
    }
  }

  private isInternedScreenshotAsset(assetPath: string): boolean {
    const normalised = assetPath.replace(/\\/g, '/');
    return (
      FLAT_INTERNED_SCREENSHOT_RE.test(normalised) ||
      normalised.includes(LEGACY_INTERNED_SCREENSHOT_MARKER)
    );
  }

  private countFrameAssetReferences(assetPath: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM frames WHERE asset_path = ?')
      .get(assetPath) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  private absoluteAssetPath(assetPath: string): string {
    if (path.isAbsolute(assetPath)) return assetPath;
    return path.join(this.root, assetPath);
  }

  private getStream(filePath: string): fs.WriteStream {
    const existing = this.writeStreams.get(filePath);
    if (existing && !existing.destroyed) return existing;
    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    stream.on('error', (err) => this.logger.error('stream error', { err: String(err), filePath }));
    this.writeStreams.set(filePath, stream);
    return stream;
  }

  // Opt-in slow-query logging. When BESIDE_DB_SLOW_QUERY_MS is set
  // to a positive integer, wraps db.prepare so any subsequent
  // .run / .get / .all that exceeds the threshold logs a one-line
  // warning with the SQL preview, elapsed ms, and row count. Zero
  // overhead when the env is unset (we skip wrapping entirely), so
  // production installs are unaffected.
  private installSlowQueryLogger(db: Database.Database): void {
    const raw = process.env.BESIDE_DB_SLOW_QUERY_MS;
    const threshold = raw ? Number.parseInt(raw, 10) : 0;
    if (!Number.isFinite(threshold) || threshold <= 0) return;

    const logger = this.logger;
    const origPrepare = db.prepare.bind(db);
    const previewSql = (sql: string): string =>
      sql.replace(/\s+/g, ' ').trim().slice(0, 160);

    (db as { prepare: typeof db.prepare }).prepare = function (sql: string) {
      const stmt = origPrepare(sql);
      const preview = previewSql(sql);
      const time = <T,>(fn: () => T, kind: 'run' | 'get' | 'all'): T => {
        const start = process.hrtime.bigint();
        const result = fn();
        const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
        if (ms >= threshold) {
          const rowCount =
            kind === 'all' && Array.isArray(result)
              ? result.length
              : kind === 'get'
                ? result == null
                  ? 0
                  : 1
                : null;
          logger.warn(`slow query ${ms.toFixed(1)}ms`, {
            sql: preview,
            kind,
            rowCount,
          });
        }
        return result;
      };
      const origRun = stmt.run.bind(stmt);
      const origGet = stmt.get.bind(stmt);
      const origAll = stmt.all.bind(stmt);
      stmt.run = ((...args: unknown[]) =>
        time(() => origRun(...(args as [])), 'run')) as typeof stmt.run;
      stmt.get = ((...args: unknown[]) =>
        time(() => origGet(...(args as [])), 'get')) as typeof stmt.get;
      stmt.all = ((...args: unknown[]) =>
        time(() => origAll(...(args as [])), 'all')) as typeof stmt.all;
      return stmt;
    } as typeof db.prepare;
  }

  private async openDb(): Promise<void> {
    const dbPath = path.join(this.root, 'beside.db');
    this.db = new Database(dbPath);
    this.installSlowQueryLogger(this.db);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    // Heavy-write tuning. Full reindex deletes thousands of rows and
    // re-writes embeddings/sessions/meetings; without these the WAL
    // grows unbounded mid-run, every commit pays an extra fsync, and
    // temp tables (FTS rebuild, GROUP BY) spill to disk.
    //
    // wal_autocheckpoint: pages, default 1000 (~4 MB). Bumped to ~8 MB
    //   so checkpoints batch more work but still fire well under the
    //   31 MB+ WAL we observed mid-reindex.
    // cache_size: negative = KB. -200000 = 200 MB page cache (was the
    //   3 MB default — too small for the join-heavy entity rebuilds).
    // temp_store: keep transient tables in RAM rather than spilling to
    //   /var/folders. Cheap on machines with multi-GB free RAM.
    // mmap_size: 256 MB read-side memory map skips one syscall per
    //   page on hot reads (entity counts, FTS scans).
    this.db.pragma('wal_autocheckpoint = 2000');
    this.db.pragma('cache_size = -200000');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('mmap_size = 268435456');

    // ---------------------------------------------------------------------
    // Base schema. Everything is `IF NOT EXISTS` so this runs cleanly on
    // both fresh installs and existing DBs. The `runSchemaMigrations`
    // call below handles backfills for older shapes (added columns,
    // dropped tables, vector format change).
    // ---------------------------------------------------------------------
    this.db.exec(`
      -- events: append-only audit log of raw capture events.
      --
      -- The previous schema kept the entire JSON event in a "raw" TEXT
      -- column alongside the typed projections, doubling storage on
      -- every row. That column has been retired: every field RawEvent
      -- carries either has its own typed column below, or rides in
      -- "extra_json" (which holds metadata plus any future fields the
      -- schema doesn't know about -- this preserves forward
      -- compatibility without paying ~2KB/row for duplicated payload).
      CREATE TABLE IF NOT EXISTS events (
        id                TEXT PRIMARY KEY,
        timestamp         TEXT NOT NULL,
        type              TEXT NOT NULL,
        app               TEXT,
        app_bundle_id     TEXT,
        window_title      TEXT,
        url               TEXT,
        content           TEXT,
        asset_path        TEXT,
        session_id        TEXT,
        day               TEXT,
        duration_ms       INTEGER,
        idle_before_ms    INTEGER,
        screen_index      INTEGER,
        capture_plugin    TEXT,
        privacy_filtered  INTEGER,
        extra_json        TEXT,
        framed_at         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_day ON events(day);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_app ON events(app);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

      -- index_state: per-strategy high-water mark. The previous
      -- design (index_marks) stored one row per (strategy, event_id),
      -- which scaled O(events) and chewed ~800KB on a small DB. Since
      -- events are processed in chronological order and event IDs sort
      -- lexicographically by time (see core/ids.ts), a single
      -- per-strategy "last_event_id" row is sufficient to identify
      -- "everything newer is unindexed".
      CREATE TABLE IF NOT EXISTS index_state (
        strategy        TEXT PRIMARY KEY,
        last_event_id   TEXT NOT NULL,
        last_marked_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS frames (
        id                  TEXT PRIMARY KEY,
        timestamp           TEXT NOT NULL,
        day                 TEXT NOT NULL,
        monitor             INTEGER NOT NULL DEFAULT 0,
        app                 TEXT,
        app_bundle_id       TEXT,
        window_title        TEXT,
        url                 TEXT,
        url_host            TEXT,
        text                TEXT,
        text_source         TEXT,
        asset_path          TEXT,
        perceptual_hash     TEXT,
        trigger             TEXT,
        session_id          TEXT,
        duration_ms         INTEGER,
        entity_path         TEXT,
        entity_kind         TEXT,
        vacuum_tier         TEXT,
        activity_session_id TEXT,
        meeting_id          TEXT,
        source_event_ids    TEXT NOT NULL,
        created_at          TEXT NOT NULL
      );

      -- frame_text: free-text search over a frame's body + URL hints +
      -- window title + app + the entity it was attributed to. The canonical
      -- URL still lives in frames.url/url_host for exact filtering; this FTS
      -- copy only gives recall for page names, host tokens, and slugs.
      --
      -- entity_search holds a tokenised projection of the frame's
      -- entity_path + entity_kind (e.g. "beside project" for
      -- projects/beside). Without this column, searching
      -- "beside" only matches frames that literally type the word
      -- in their title or OCR text, missing the hundreds of frames
      -- attributed to the entity by the resolver. With it, a query
      -- like "milan" returns frames in milan-lazic's sessions even
      -- when the screenshot doesn't show the name on screen.
      --
      -- Search uses weighted BM25 (see searchFrames): window-title and
      -- entity hits dominate, body next, app-name downweighted.
      CREATE VIRTUAL TABLE IF NOT EXISTS frame_text USING fts5(
        frame_id UNINDEXED,
        text,
        window_title,
        app,
        entity_search,
        tokenize='porter unicode61 remove_diacritics 2'
      );

      -- Embeddings: vector stored as packed Float32 BLOB (4 bytes/dim).
      -- ~5x smaller than the previous JSON representation and decodes
      -- without JSON.parse on every search.
      CREATE TABLE IF NOT EXISTS frame_embeddings (
        frame_id     TEXT NOT NULL,
        model        TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        vector       BLOB NOT NULL,
        dims         INTEGER NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (frame_id, model)
      );
      CREATE INDEX IF NOT EXISTS idx_frame_embeddings_model
        ON frame_embeddings(model);
      CREATE INDEX IF NOT EXISTS idx_frame_embeddings_model_hash
        ON frame_embeddings(model, content_hash);

      -- memory_chunks: higher-level passages derived from wiki pages,
      -- entity rollups, meeting summaries, day events, and user-curated
      -- facts/procedures. Frames remain the evidence substrate; chunks are
      -- the compact long-term memory layer used for retrieval.
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id               TEXT PRIMARY KEY,
        kind             TEXT NOT NULL,
        source_id        TEXT NOT NULL,
        title            TEXT NOT NULL,
        body             TEXT NOT NULL,
        entity_path      TEXT,
        entity_kind      TEXT,
        day              TEXT,
        timestamp        TEXT,
        source_refs_json TEXT NOT NULL,
        content_hash     TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_chunks_kind
        ON memory_chunks(kind);
      CREATE INDEX IF NOT EXISTS idx_memory_chunks_entity
        ON memory_chunks(entity_path);
      CREATE INDEX IF NOT EXISTS idx_memory_chunks_day
        ON memory_chunks(day);
      CREATE INDEX IF NOT EXISTS idx_memory_chunks_timestamp
        ON memory_chunks(timestamp DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunk_text USING fts5(
        chunk_id UNINDEXED,
        title,
        body,
        entity_search,
        kind UNINDEXED,
        tokenize='porter unicode61 remove_diacritics 2'
      );

      CREATE TABLE IF NOT EXISTS memory_chunk_embeddings (
        chunk_id     TEXT NOT NULL,
        model        TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        vector       BLOB NOT NULL,
        dims         INTEGER NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (chunk_id, model)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_chunk_embeddings_model
        ON memory_chunk_embeddings(model);
      CREATE INDEX IF NOT EXISTS idx_memory_chunk_embeddings_model_hash
        ON memory_chunk_embeddings(model, content_hash);

      CREATE TABLE IF NOT EXISTS entities (
        path             TEXT PRIMARY KEY,
        kind             TEXT NOT NULL,
        title            TEXT NOT NULL,
        first_seen       TEXT NOT NULL,
        last_seen        TEXT NOT NULL,
        total_focused_ms INTEGER NOT NULL DEFAULT 0,
        frame_count      INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
      CREATE INDEX IF NOT EXISTS idx_entities_last_seen ON entities(last_seen DESC);

      -- entities_fts: free-text search over entity title + path tail
      -- (the human-readable parts). The path is stored alongside title so
      -- the desktop UI can autocomplete on either ("beside" matches
      -- both "projects/beside" and "Beside"). The kind column
      -- is non-tokenised so we can filter without scanning.
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        path UNINDEXED,
        title,
        path_tail,
        kind UNINDEXED,
        tokenize='unicode61 remove_diacritics 2'
      );

      -- Keep entities_fts in sync with the entities table via triggers
      -- so we never have to remember to update it from app code.
      -- The WHEN clause skips system-noise apps (loginwindow,
      -- electron, system-settings, ...) -- they're useless in
      -- autocomplete. searchEntities can opt back in via
      -- includeNoise: true, which falls through to the LIKE scan.
      CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities
      WHEN NEW.path NOT IN (
        'apps/loginwindow', 'apps/captive-network-assistant',
        'apps/system-settings', 'apps/activity-monitor',
        'apps/electron', 'apps/cloudflare-warp',
        'apps/spotlight', 'apps/window-server', 'apps/dock',
        'apps/control-center', 'apps/notification-center',
        'apps/screencaptureui', 'apps/beside', 'apps/audio'
      )
      BEGIN
        INSERT INTO entities_fts(rowid, path, title, path_tail, kind)
        VALUES (NULL, NEW.path, NEW.title,
                REPLACE(REPLACE(NEW.path, '/', ' '), '-', ' '), NEW.kind);
      END;
      CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
        DELETE FROM entities_fts WHERE path = OLD.path;
        INSERT INTO entities_fts(rowid, path, title, path_tail, kind)
        SELECT NULL, NEW.path, NEW.title,
               REPLACE(REPLACE(NEW.path, '/', ' '), '-', ' '), NEW.kind
        WHERE NEW.path NOT IN (
          'apps/loginwindow', 'apps/captive-network-assistant',
          'apps/system-settings', 'apps/activity-monitor',
          'apps/electron', 'apps/cloudflare-warp',
          'apps/spotlight', 'apps/window-server', 'apps/dock',
          'apps/control-center', 'apps/notification-center',
          'apps/screencaptureui', 'apps/beside', 'apps/audio'
        );
      END;
      CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
        DELETE FROM entities_fts WHERE path = OLD.path;
      END;

      -- Activity sessions: continuous user-focus runs derived from frames,
      -- bounded by idle gaps. Distinct from frames.session_id (capture
      -- session) — that field tracks process lifetime; this one tracks
      -- user attention. Rebuilt from scratch on --full-reindex.
      CREATE TABLE IF NOT EXISTS sessions (
        id                  TEXT PRIMARY KEY,
        started_at          TEXT NOT NULL,
        ended_at            TEXT NOT NULL,
        day                 TEXT NOT NULL,
        duration_ms         INTEGER NOT NULL,
        active_ms           INTEGER NOT NULL,
        frame_count         INTEGER NOT NULL,
        primary_entity_path TEXT,
        primary_entity_kind TEXT,
        primary_app         TEXT,
        entities_json       TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);

      -- Meetings (V2): one row per Zoom/Meet/Teams/etc. session, fusing
      -- meeting screenshot frames with overlapping audio_transcript
      -- frames. Distinct from sessions -- a meeting is its own first-class
      -- object so two back-to-back Zooms get independent summaries.
      CREATE TABLE IF NOT EXISTS meetings (
        id                  TEXT PRIMARY KEY,
        entity_path         TEXT NOT NULL,
        title               TEXT,
        platform            TEXT NOT NULL,
        started_at          TEXT NOT NULL,
        ended_at            TEXT NOT NULL,
        day                 TEXT NOT NULL,
        duration_ms         INTEGER NOT NULL,
        frame_count         INTEGER NOT NULL DEFAULT 0,
        screenshot_count    INTEGER NOT NULL DEFAULT 0,
        audio_chunk_count   INTEGER NOT NULL DEFAULT 0,
        transcript_chars    INTEGER NOT NULL DEFAULT 0,
        content_hash        TEXT NOT NULL DEFAULT '',
        summary_status      TEXT NOT NULL DEFAULT 'pending',
        summary_md          TEXT,
        summary_json        TEXT,
        attendees_json      TEXT NOT NULL DEFAULT '[]',
        links_json          TEXT NOT NULL DEFAULT '[]',
        failure_reason      TEXT,
        updated_at          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_meetings_started ON meetings(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meetings_day ON meetings(day, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meetings_entity ON meetings(entity_path);

      -- Per-meeting transcript turns (one utterance each). Rows are
      -- regenerated atomically by setMeetingTurns when a meeting's
      -- audio inputs change.
      CREATE TABLE IF NOT EXISTS meeting_turns (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id      TEXT NOT NULL,
        t_start         TEXT NOT NULL,
        t_end           TEXT NOT NULL,
        speaker         TEXT,
        text            TEXT NOT NULL,
        visual_frame_id TEXT,
        source          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_meeting_turns_meeting
        ON meeting_turns(meeting_id, t_start);

      -- Calendar sources/captures/events: canonical calendar state. Day
      -- events remain a projection; these tables preserve source-scoped
      -- snapshots and meeting enrichment without flattening provenance.
      CREATE TABLE IF NOT EXISTS calendar_sources (
        source_key     TEXT PRIMARY KEY,
        provider       TEXT NOT NULL,
        label          TEXT NOT NULL,
        app            TEXT,
        app_bundle_id  TEXT,
        url_host       TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calendar_captures (
        id                 TEXT PRIMARY KEY,
        source_key         TEXT NOT NULL,
        day                TEXT NOT NULL,
        captured_at        TEXT NOT NULL,
        frame_ids_json     TEXT NOT NULL DEFAULT '[]',
        evidence_hash      TEXT NOT NULL,
        parser             TEXT NOT NULL,
        status             TEXT NOT NULL,
        confidence         REAL NOT NULL DEFAULT 0,
        visible_days_json  TEXT NOT NULL DEFAULT '[]',
        failure_reason     TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calendar_events (
        id                       TEXT PRIMARY KEY,
        source_key               TEXT NOT NULL,
        provider                 TEXT NOT NULL,
        day                      TEXT NOT NULL,
        starts_at                TEXT NOT NULL,
        ends_at                  TEXT,
        title                    TEXT NOT NULL,
        location                 TEXT,
        attendees_json           TEXT NOT NULL DEFAULT '[]',
        links_json               TEXT NOT NULL DEFAULT '[]',
        notes                    TEXT,
        source_app               TEXT,
        source_url               TEXT,
        source_bundle_id         TEXT,
        evidence_frame_ids_json  TEXT NOT NULL DEFAULT '[]',
        first_seen_capture_id    TEXT,
        last_seen_capture_id     TEXT,
        status                   TEXT NOT NULL DEFAULT 'active',
        content_hash             TEXT NOT NULL,
        meeting_id               TEXT,
        actual_started_at        TEXT,
        actual_ended_at          TEXT,
        meeting_platform         TEXT,
        meeting_summary_status   TEXT,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_calendar_captures_source_day
        ON calendar_captures(source_key, day, captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_calendar_events_source_day
        ON calendar_events(source_key, day, starts_at);
      CREATE INDEX IF NOT EXISTS idx_calendar_events_day
        ON calendar_events(day, starts_at);
      CREATE INDEX IF NOT EXISTS idx_calendar_events_meeting
        ON calendar_events(meeting_id) WHERE meeting_id IS NOT NULL;

      -- Day events: the unified "event log" surface. One row per item
      -- the EventExtractor materialised onto a day -- a live meeting we
      -- captured, a calendar entry the OCR pass pulled off Google
      -- Calendar, a Slack thread it judged notable, etc. Rows are
      -- upserted under deterministic ids so re-running extraction over
      -- the same evidence is a no-op.
      CREATE TABLE IF NOT EXISTS day_events (
        id                       TEXT PRIMARY KEY,
        day                      TEXT NOT NULL,
        starts_at                TEXT NOT NULL,
        ends_at                  TEXT,
        kind                     TEXT NOT NULL,
        source                   TEXT NOT NULL,
        title                    TEXT NOT NULL,
        source_app               TEXT,
        context_md               TEXT,
        attendees_json           TEXT NOT NULL DEFAULT '[]',
        links_json               TEXT NOT NULL DEFAULT '[]',
        meeting_id               TEXT,
        evidence_frame_ids_json  TEXT NOT NULL DEFAULT '[]',
        content_hash             TEXT NOT NULL,
        status                   TEXT NOT NULL DEFAULT 'ready',
        failure_reason           TEXT,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_day_events_day_starts
        ON day_events(day, starts_at);
      CREATE INDEX IF NOT EXISTS idx_day_events_starts
        ON day_events(starts_at DESC);
      CREATE INDEX IF NOT EXISTS idx_day_events_source_day
        ON day_events(source, day);
      CREATE INDEX IF NOT EXISTS idx_day_events_meeting
        ON day_events(meeting_id) WHERE meeting_id IS NOT NULL;

      -- Capture-hook records: per-hook isolated storage. Each row belongs
      -- to a single hook id and a logical "collection" name the hook
      -- chooses. The host is responsible for hook-id scoping; plugins
      -- never see other hooks' rows. Records are deterministic by
      -- (hook_id, collection, id) so a hook can upsert idempotently
      -- across re-runs of the same evidence.
      CREATE TABLE IF NOT EXISTS hook_records (
        hook_id              TEXT NOT NULL,
        collection           TEXT NOT NULL,
        id                   TEXT NOT NULL,
        data_json            TEXT NOT NULL,
        evidence_ids_json    TEXT NOT NULL DEFAULT '[]',
        content_hash         TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        PRIMARY KEY (hook_id, collection, id)
      );
      CREATE INDEX IF NOT EXISTS idx_hook_records_hook_updated
        ON hook_records(hook_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_hook_records_hook_collection_updated
        ON hook_records(hook_id, collection, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_hook_records_evidence
        ON hook_records(evidence_ids_json);
    `);

    this.runSchemaMigrations();
    this.runStartupIntegrityCheck();
  }

  // PRAGMA quick_check on every cold start. quick_check covers the
  // common corruption modes (page tree, free-list, out-of-order rows)
  // and runs in well under a second even on multi-hundred-MB DBs --
  // cheap insurance that surfaces hardware/journal corruption before
  // it gets buried under more writes. The deeper PRAGMA integrity_check
  // belongs in the weekly maintenance job (runMaintenance) where it
  // can scan the entire database without holding up startup.
  private runStartupIntegrityCheck(): void {
    try {
      const rows = this.db.pragma('quick_check') as Array<{ quick_check: string }>;
      const result = rows[0]?.quick_check ?? '';
      if (result !== 'ok') {
        this.logger.error('database quick_check failed', {
          result: rows.map((r) => r.quick_check).join('; ').slice(0, 500),
        });
      }
    } catch (err) {
      this.logger.warn('quick_check threw', { err: String(err) });
    }
  }

  /**
   * Periodic maintenance: deep integrity_check, ANALYZE to refresh
   * planner statistics, then VACUUM to reclaim freed pages and
   * defragment. Driven by the orchestrator's weekly STORAGE_MAINTENANCE
   * tick under LoadGuard + AC-power gating.
   *
   * VACUUM cannot run inside a transaction and rewrites the entire DB
   * file, so it can take seconds and briefly holds an exclusive lock.
   * The orchestrator gates the call on idle/AC power; here we just do
   * the work and surface failures.
   */
  /**
   * Force a WAL checkpoint. PASSIVE returns quickly; TRUNCATE blocks
   * until the WAL can be shrunk to zero on disk. The full-reindex
   * pipeline calls this between phases so the WAL doesn't balloon
   * during long, write-heavy runs (we observed it pinning at 30 MB+
   * across reindexes despite `wal_autocheckpoint = 2000`, because
   * passive checkpoints run but never truncate the file).
   *
   * Best-effort. A failure here is logged and swallowed — the next
   * incremental tick will get another shot.
   */
  async checkpointWal(mode: 'PASSIVE' | 'TRUNCATE' = 'PASSIVE'): Promise<void> {
    try {
      const result = this.db.pragma(`wal_checkpoint(${mode})`) as Array<{
        busy: number;
        log: number;
        checkpointed: number;
      }>;
      const r = result[0];
      if (r) {
        this.logger.debug(
          `wal_checkpoint(${mode}): busy=${r.busy} log_pages=${r.log} checkpointed=${r.checkpointed}`,
        );
      }
    } catch (err) {
      this.logger.warn(`wal_checkpoint(${mode}) failed`, { err: String(err) });
    }
  }

  async runMaintenance(): Promise<{ vacuumed: boolean; analyzed: boolean }> {
    let analyzed = false;
    let vacuumed = false;

    try {
      const rows = this.db.pragma('integrity_check') as Array<{
        integrity_check: string;
      }>;
      const result = rows[0]?.integrity_check ?? '';
      if (result !== 'ok') {
        this.logger.error('database integrity_check failed', {
          result: rows.map((r) => r.integrity_check).join('; ').slice(0, 1000),
        });
      }
    } catch (err) {
      this.logger.warn('integrity_check threw', { err: String(err) });
    }

    try {
      this.db.exec('ANALYZE');
      analyzed = true;
    } catch (err) {
      this.logger.warn('ANALYZE failed', { err: String(err) });
    }

    try {
      const start = Date.now();
      this.db.exec('VACUUM');
      vacuumed = true;
      this.logger.info(`VACUUM reclaimed pages in ${Date.now() - start}ms`);
    } catch (err) {
      this.logger.warn('VACUUM failed', { err: String(err) });
    }

    return { vacuumed, analyzed };
  }

  /**
   * Idempotent schema migrations for older databases. Safe to run on
   * every startup — each step is gated on a `PRAGMA table_info` check
   * or `IF EXISTS` so a fresh DB pays effectively nothing.
   *
   * Each step is logged so the migration trail is visible in `cli logs`.
   */
  private runSchemaMigrations(): void {
    // 1. Column backfills for shape changes that landed after the first
    //    public release. ALL of these no-op on a fresh install where the
    //    base CREATE TABLE already declares the column.
    this.maybeAddColumn('events', 'framed_at', 'TEXT');
    // Event columns promoted out of `raw` JSON (see maybeMigrateEventsRaw).
    this.maybeAddColumn('events', 'app_bundle_id', 'TEXT');
    this.maybeAddColumn('events', 'duration_ms', 'INTEGER');
    this.maybeAddColumn('events', 'idle_before_ms', 'INTEGER');
    this.maybeAddColumn('events', 'screen_index', 'INTEGER');
    this.maybeAddColumn('events', 'capture_plugin', 'TEXT');
    this.maybeAddColumn('events', 'privacy_filtered', 'INTEGER');
    this.maybeAddColumn('events', 'extra_json', 'TEXT');
    this.maybeAddColumn('frames', 'entity_path', 'TEXT');
    this.maybeAddColumn('frames', 'entity_kind', 'TEXT');
    this.maybeAddColumn('frames', 'vacuum_tier', 'TEXT');
    this.maybeAddColumn('frames', 'activity_session_id', 'TEXT');
    this.maybeAddColumn('frames', 'meeting_id', 'TEXT');
    this.maybeAddColumn('frames', 'url_host', 'TEXT');
    this.maybeAddColumn('meetings', 'title', 'TEXT');
    this.repairInvalidTimestamps();

    // 2. Drop the dead `events_fts` virtual table. The free-text search
    //    path moved to `frames` / `frame_text` long ago; the FTS table
    //    here was never populated (events.content is always empty) but
    //    its 5 shadow tables still cost write amplification on every
    //    event insert. Safe to drop unconditionally.
    if (this.tableExists('events_fts')) {
      this.db.exec('DROP TABLE IF EXISTS events_fts;');
      this.logger.info('migrated: dropped dead events_fts virtual table');
    }

    // 3. frame_embeddings.vector_json (TEXT) -> vector (BLOB Float32).
    //    Migrate row-by-row, then drop the old column. Requires SQLite
    //    >= 3.35 for DROP COLUMN (better-sqlite3 11.x ships with that).
    this.migrateEmbeddingsToBlob();

    // 4. Backfill `frames.url_host` for existing rows that have a URL
    //    but no extracted host (everything pre-migration).
    const needBackfill = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM frames WHERE url IS NOT NULL AND url != '' AND url_host IS NULL",
        )
        .get() as { n: number }
    ).n;
    if (needBackfill > 0) {
      const rows = this.db
        .prepare("SELECT id, url FROM frames WHERE url IS NOT NULL AND url != '' AND url_host IS NULL")
        .all() as Array<{ id: string; url: string }>;
      const upd = this.db.prepare('UPDATE frames SET url_host = ? WHERE id = ?');
      let updated = 0;
      const tx = this.db.transaction(() => {
        for (const r of rows) {
          upd.run(extractUrlHost(r.url) ?? '', r.id);
          updated += 1;
        }
      });
      tx();
      this.logger.info(`migrated: backfilled url_host for ${updated} frames`);
    }

    // 5. Indexes — composite & partial. Replace single-column indexes
    //    that are strictly subsumed by the new composites so we don't
    //    pay double on writes.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_framed
        ON events(framed_at) WHERE framed_at IS NULL;

      -- Composite (entity_path, timestamp) — kills the temp B-TREE on
      -- the indexer's hottest query: "all frames for entity X in time
      -- order".
      CREATE INDEX IF NOT EXISTS idx_frames_entity_ts
        ON frames(entity_path, timestamp);

      -- Composite (day, timestamp) — drops temp B-TREE on the journal
      -- query and on session-needing-assignment scans.
      CREATE INDEX IF NOT EXISTS idx_frames_day_ts
        ON frames(day, timestamp);

      -- Composite (app, timestamp DESC) — covers "what was I doing in
      -- app X recently" without an in-memory sort.
      CREATE INDEX IF NOT EXISTS idx_frames_app_ts
        ON frames(app, timestamp DESC);

      -- Composite (day, started_at DESC) for the sessions query that
      -- previously needed a temp B-TREE.
      CREATE INDEX IF NOT EXISTS idx_sessions_day_started
        ON sessions(day, started_at DESC);

      -- Indexed url_host enables exact-domain filtering without the old
      -- '%domain%' LIKE that could never use an index.
      CREATE INDEX IF NOT EXISTS idx_frames_url_host
        ON frames(url_host) WHERE url_host IS NOT NULL;

      -- Worker partials. These are tiny (cover only currently-pending
      -- rows) and let the workers iterate without scanning the full
      -- frames table.
      -- Lookup OCR'd frames by perceptual hash to skip Tesseract on
      -- pixel-identical screens (user toggled back to a recently-seen
      -- window/tab). Partial: indexes only frames that already have
      -- usable OCR text, so the table stays tiny relative to the
      -- frames table.
      CREATE INDEX IF NOT EXISTS idx_frames_phash_ocr
        ON frames(perceptual_hash, timestamp DESC)
        WHERE perceptual_hash IS NOT NULL
          AND text_source IN ('ocr', 'ocr_accessibility');
      CREATE INDEX IF NOT EXISTS idx_frames_pending_ocr
        ON frames(timestamp DESC)
        WHERE asset_path IS NOT NULL
          AND (text_source IS NULL OR text_source = 'accessibility');
      CREATE INDEX IF NOT EXISTS idx_frames_pending_entity
        ON frames(timestamp DESC) WHERE entity_path IS NULL;
      CREATE INDEX IF NOT EXISTS idx_frames_pending_session
        ON frames(timestamp ASC) WHERE activity_session_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_frames_vacuum
        ON frames(vacuum_tier, timestamp) WHERE asset_path IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_frames_activity_session
        ON frames(activity_session_id);
      -- Composite (activity_session_id, entity_path) — narrows the
      -- co-occurrence self-join in listEntityCoOccurrences so the
      -- partner side doesn't visit frames missing an entity. Partial
      -- on activity_session_id IS NOT NULL keeps it tiny.
      CREATE INDEX IF NOT EXISTS idx_frames_session_entity
        ON frames(activity_session_id, entity_path)
        WHERE activity_session_id IS NOT NULL AND entity_path IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_frames_session
        ON frames(session_id);
      CREATE INDEX IF NOT EXISTS idx_frames_meeting
        ON frames(meeting_id);
      -- Partial index for the MeetingBuilder's "find unattached meeting
      -- frames" query — covers the hot path without scanning the whole
      -- frames table on every tick.
      CREATE INDEX IF NOT EXISTS idx_frames_pending_meeting
        ON frames(timestamp ASC)
        WHERE entity_kind = 'meeting' AND meeting_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_frame_embeddings_model_hash
        ON frame_embeddings(model, content_hash);
    `);

    // 6. Drop redundant single-column indexes now subsumed by the new
    //    composites. Leading-column queries on the composites are just
    //    as fast, and we get smaller writes + smaller DB.
    this.db.exec(`
      DROP INDEX IF EXISTS idx_frames_app;       -- subsumed by idx_frames_app_ts
      DROP INDEX IF EXISTS idx_frames_day;       -- subsumed by idx_frames_day_ts
      DROP INDEX IF EXISTS idx_frames_entity;    -- subsumed by idx_frames_entity_ts
      DROP INDEX IF EXISTS idx_frames_url;       -- replaced by idx_frames_url_host
      DROP INDEX IF EXISTS idx_sessions_day;     -- subsumed by idx_sessions_day_started
      DROP INDEX IF EXISTS idx_frames_ts;        -- frames are practically always filtered by day/entity/app first
    `);

    // 7a. frame_text schema migration: drop the legacy `url` column
    //     (URLs now live in the indexed `frames.url_host` column where
    //     they don't poison the porter stemmer) and rebuild the FTS
    //     content from the `frames` table. Detected by inspecting
    //     `pragma table_info(frame_text)`.
    this.maybeRebuildFrameTextFts();

    // 7c. index_marks → index_state. Compress 1-row-per-event into
    //     1-row-per-strategy (the per-event marker was vestigial; we
    //     only ever query MAX(event_id) by strategy).
    this.maybeMigrateIndexMarks();

    // 7d. events.raw → typed columns + extra_json. Parses the existing
    //     JSON and writes its components into the new columns added
    //     by the maybeAddColumn calls above, then drops `raw`.
    this.maybeMigrateEventsRaw();

    // 7b. Recreate the entities triggers so the new noise filter
    //     (WHEN clause excluding system app entities like apps/electron,
    //     apps/loginwindow, ...) takes effect on existing installs.
    //     `CREATE TRIGGER IF NOT EXISTS` is a no-op when the trigger
    //     name exists, so we drop+recreate to pick up the new body.
    this.db.exec(`
      DROP TRIGGER IF EXISTS entities_ai;
      DROP TRIGGER IF EXISTS entities_au;
      DROP TRIGGER IF EXISTS entities_ad;
      CREATE TRIGGER entities_ai AFTER INSERT ON entities
      WHEN NEW.path NOT IN (
        'apps/loginwindow', 'apps/captive-network-assistant',
        'apps/system-settings', 'apps/activity-monitor',
        'apps/electron', 'apps/cloudflare-warp',
        'apps/spotlight', 'apps/window-server', 'apps/dock',
        'apps/control-center', 'apps/notification-center',
        'apps/screencaptureui', 'apps/beside', 'apps/audio'
      )
      BEGIN
        INSERT INTO entities_fts(rowid, path, title, path_tail, kind)
        VALUES (NULL, NEW.path, NEW.title,
                REPLACE(REPLACE(NEW.path, '/', ' '), '-', ' '), NEW.kind);
      END;
      CREATE TRIGGER entities_au AFTER UPDATE ON entities BEGIN
        DELETE FROM entities_fts WHERE path = OLD.path;
        INSERT INTO entities_fts(rowid, path, title, path_tail, kind)
        SELECT NULL, NEW.path, NEW.title,
               REPLACE(REPLACE(NEW.path, '/', ' '), '-', ' '), NEW.kind
        WHERE NEW.path NOT IN (
          'apps/loginwindow', 'apps/captive-network-assistant',
          'apps/system-settings', 'apps/activity-monitor',
          'apps/electron', 'apps/cloudflare-warp',
          'apps/spotlight', 'apps/window-server', 'apps/dock',
          'apps/control-center', 'apps/notification-center',
          'apps/screencaptureui', 'apps/beside', 'apps/audio'
        );
      END;
      CREATE TRIGGER entities_ad AFTER DELETE ON entities BEGIN
        DELETE FROM entities_fts WHERE path = OLD.path;
      END;
    `);

    // 7c. Backfill entities_fts for installs that already had entities
    //     before the FTS table existed; also purge any noise-app rows
    //     a previous backfill (pre-noise-filter) leaked into the index.
    const purged = this.db
      .prepare(
        `DELETE FROM entities_fts WHERE path IN (
          'apps/loginwindow', 'apps/captive-network-assistant',
          'apps/system-settings', 'apps/activity-monitor',
          'apps/electron', 'apps/cloudflare-warp',
          'apps/spotlight', 'apps/window-server', 'apps/dock',
          'apps/control-center', 'apps/notification-center',
          'apps/screencaptureui', 'apps/beside', 'apps/audio'
        )`,
      )
      .run().changes;
    if (purged > 0) {
      this.logger.info(`migrated: purged ${purged} noise app row(s) from entities_fts`);
    }
    const ftsCount = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM entities_fts')
        .get() as { n: number }
    ).n;
    const entCount = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM entities')
        .get() as { n: number }
    ).n;
    if (ftsCount === 0 && entCount > 0) {
      this.db.exec(`
        INSERT INTO entities_fts(rowid, path, title, path_tail, kind)
        SELECT NULL, path, title,
               REPLACE(REPLACE(path, '/', ' '), '-', ' '), kind
        FROM entities
        WHERE path NOT IN (
          'apps/loginwindow', 'apps/captive-network-assistant',
          'apps/system-settings', 'apps/activity-monitor',
          'apps/electron', 'apps/cloudflare-warp',
          'apps/spotlight', 'apps/window-server', 'apps/dock',
          'apps/control-center', 'apps/notification-center',
          'apps/screencaptureui', 'apps/beside', 'apps/audio'
        );
      `);
      this.logger.info(`migrated: backfilled entities_fts with ${entCount} entity row(s)`);
    }

    // 8. One-shot reclaim & re-stats. Driven by PRAGMA user_version so
    //    we only pay the VACUUM cost once across all installs that
    //    upgrade through this migration. ANALYZE is cheap and updates
    //    the planner's stat1 tables for the new composite indexes.
    const versionRow = this.db.prepare('PRAGMA user_version').get() as
      | { user_version: number }
      | undefined;
    const currentVersion = versionRow?.user_version ?? 0;
    const TARGET_VERSION = 7;
    if (currentVersion < TARGET_VERSION) {
      try {
        this.db.exec('VACUUM');
        this.logger.info('migrated: VACUUM reclaimed freed pages');
      } catch (err) {
        // VACUUM can fail if there are open prepared statements held
        // outside our control. Non-fatal — pages will be reused on
        // their own over time.
        this.logger.warn('VACUUM failed, leaving freed pages in place', {
          err: String(err),
        });
      }
      try {
        this.db.exec('ANALYZE');
      } catch (err) {
        this.logger.debug('ANALYZE failed', { err: String(err) });
      }
      this.db.pragma(`user_version = ${TARGET_VERSION}`);
    }
  }

  /**
   * Migrate `frame_embeddings.vector_json` (TEXT) into `vector` (BLOB).
   * No-op if the table already has the new shape. Done in one
   * transaction so a crash mid-migration leaves the DB in a consistent
   * state.
   */
  private migrateEmbeddingsToBlob(): void {
    const cols = this.db
      .prepare("PRAGMA table_info(frame_embeddings)")
      .all() as Array<{ name: string; type: string }>;
    const hasJson = cols.some((c) => c.name === 'vector_json');
    const hasBlob = cols.some((c) => c.name === 'vector');

    if (!hasJson) return; // already migrated (or fresh install)

    if (!hasBlob) {
      // Older DBs only have vector_json — add the BLOB column first.
      this.db.exec('ALTER TABLE frame_embeddings ADD COLUMN vector BLOB');
    }

    const pending = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM frame_embeddings WHERE vector IS NULL')
        .get() as { n: number }
    ).n;

    if (pending > 0) {
      const rows = this.db
        .prepare(
          'SELECT frame_id, model, vector_json FROM frame_embeddings WHERE vector IS NULL',
        )
        .all() as Array<{ frame_id: string; model: string; vector_json: string }>;
      const upd = this.db.prepare(
        'UPDATE frame_embeddings SET vector = ? WHERE frame_id = ? AND model = ?',
      );
      const tx = this.db.transaction(() => {
        for (const r of rows) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(r.vector_json);
          } catch {
            continue;
          }
          if (!Array.isArray(parsed)) continue;
          const buf = packFloat32(parsed);
          if (buf.byteLength === 0) continue;
          upd.run(buf, r.frame_id, r.model);
        }
      });
      tx();
      this.logger.info(`migrated: packed ${rows.length} embedding(s) into BLOB`);
    }

    // Now safe to drop the legacy column.
    try {
      this.db.exec('ALTER TABLE frame_embeddings DROP COLUMN vector_json');
      this.logger.info('migrated: dropped frame_embeddings.vector_json');
    } catch (err) {
      // SQLite < 3.35 fallback: copy table. Should never hit on
      // better-sqlite3 11.x, but defensive in case the user has bundled
      // an older runtime.
      this.logger.warn('DROP COLUMN failed, falling back to table rebuild', {
        err: String(err),
      });
      this.db.exec(`
        CREATE TABLE frame_embeddings_new (
          frame_id     TEXT NOT NULL,
          model        TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          vector       BLOB NOT NULL,
          dims         INTEGER NOT NULL,
          created_at   TEXT NOT NULL,
          PRIMARY KEY (frame_id, model)
        );
        INSERT INTO frame_embeddings_new
          SELECT frame_id, model, content_hash, vector, dims, created_at
          FROM frame_embeddings WHERE vector IS NOT NULL;
        DROP TABLE frame_embeddings;
        ALTER TABLE frame_embeddings_new RENAME TO frame_embeddings;
        CREATE INDEX IF NOT EXISTS idx_frame_embeddings_model
          ON frame_embeddings(model);
        CREATE INDEX IF NOT EXISTS idx_frame_embeddings_model_hash
          ON frame_embeddings(model, content_hash);
      `);
    }
  }

  private tableExists(name: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table','view')")
      .get(name) as { 1: number } | undefined;
    return Boolean(row);
  }

  /**
   * Rebuild `frame_text` if its column shape no longer matches what
   * the storage adapter writes. FTS5 virtual tables don't support
   * `ALTER TABLE`, so we DROP + CREATE + repopulate from the canonical
   * `frames` table. Idempotent: a no-op once `frame_text` has the
   * expected columns/content. Currently triggers when:
   *   - the legacy `url` column is still present, or
   *   - the `entity_search` column is missing (added later), or
   *   - the FTS body has not yet been rebuilt with URL hint text.
   */
  private maybeRebuildFrameTextFts(): void {
    const cols = this.db
      .prepare('PRAGMA table_info(frame_text)')
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    const hasUrl = names.has('url');
    const hasEntitySearch = names.has('entity_search');
    const versionRow = this.db.prepare('PRAGMA user_version').get() as
      | { user_version: number }
      | undefined;
    const needsUrlHints = (versionRow?.user_version ?? 0) < 7;
    if (!hasUrl && hasEntitySearch && !needsUrlHints) return;

    this.logger.info(
      `migrating: rebuilding frame_text FTS (had url=${hasUrl}, had entity_search=${hasEntitySearch}, url_hints=${needsUrlHints})`,
    );
    const start = Date.now();
    this.db.exec(`
      DROP TABLE IF EXISTS frame_text;
      CREATE VIRTUAL TABLE frame_text USING fts5(
        frame_id UNINDEXED,
        text,
        window_title,
        app,
        entity_search,
        tokenize='porter unicode61 remove_diacritics 2'
      );
    `);
    // Backfill with entity_search built per-row so existing
    // resolver-attached frames are immediately searchable by entity
    // name without waiting for the indexer to touch them again.
    const rows = this.db
      .prepare(
        `SELECT id, text, window_title, url, app, entity_path, entity_kind FROM frames`,
      )
      .all() as Array<{
      id: string;
      text: string | null;
      window_title: string | null;
      url: string | null;
      app: string | null;
      entity_path: string | null;
      entity_kind: string | null;
    }>;
    const insert = this.db.prepare(
      'INSERT INTO frame_text(frame_id, text, window_title, app, entity_search) VALUES (?, ?, ?, ?, ?)',
    );
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        insert.run(
          r.id,
          ftsBodyText(r.text ?? '', r.url ?? ''),
          r.window_title ?? '',
          r.app ?? '',
          entityToFtsText(r.entity_path, r.entity_kind),
        );
      }
    });
    tx();
    this.logger.info(
      `migrated: rebuilt frame_text with ${rows.length} row(s) in ${Date.now() - start}ms`,
    );
  }

  private maybeAddColumn(table: string, column: string, ddl: string): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      this.logger.info(`migrated: added ${table}.${column}`);
    }
  }

  /**
   * Repair legacy rows written with empty/invalid timestamps. Their IDs carry
   * the capture timestamp (`evt_<base36ms>_...` / `frm_<base36ms>_...`), so we
   * can recover chronology without guessing from row order.
   */
  private repairInvalidTimestamps(): void {
    const eventRows = this.db
      .prepare(
        `SELECT id, timestamp, day
         FROM events
         WHERE timestamp IS NULL
            OR trim(timestamp) = ''
            OR day IS NULL
            OR trim(day) = ''
            OR day LIKE 'NaN%'`,
      )
      .all() as Array<{ id: string; timestamp: string | null; day: string | null }>;
    const frameRows = this.db
      .prepare(
        `SELECT id, timestamp, day
         FROM frames
         WHERE timestamp IS NULL
            OR trim(timestamp) = ''
            OR day IS NULL
            OR trim(day) = ''
            OR day LIKE 'NaN%'`,
      )
      .all() as Array<{ id: string; timestamp: string | null; day: string | null }>;

    const updateEvents = this.db.prepare(
      'UPDATE events SET timestamp = @timestamp, day = @day WHERE id = @id',
    );
    const updateFrames = this.db.prepare(
      'UPDATE frames SET timestamp = @timestamp, day = @day WHERE id = @id',
    );
    let repairedEvents = 0;
    let repairedFrames = 0;

    const tx = this.db.transaction(() => {
      for (const row of eventRows) {
        const timestamp = normaliseTimestampValue(row.timestamp) ?? timestampFromRecordId(row.id);
        if (!timestamp) continue;
        const day = dayKey(new Date(timestamp));
        if (row.timestamp === timestamp && row.day === day) continue;
        updateEvents.run({ id: row.id, timestamp, day });
        repairedEvents += 1;
      }
      for (const row of frameRows) {
        const timestamp = normaliseTimestampValue(row.timestamp) ?? timestampFromRecordId(row.id);
        if (!timestamp) continue;
        const day = dayKey(new Date(timestamp));
        if (row.timestamp === timestamp && row.day === day) continue;
        updateFrames.run({ id: row.id, timestamp, day });
        repairedFrames += 1;
      }
    });
    tx();

    if (repairedEvents > 0 || repairedFrames > 0) {
      this.logger.info(
        `migrated: repaired invalid timestamps (${repairedEvents} event(s), ${repairedFrames} frame(s))`,
      );
    }
  }

  /**
   * Migrate the legacy `index_marks` table (1 row per (strategy,
   * event_id), ~800KB on a small DB) into `index_state` (1 row per
   * strategy holding a high-water `last_event_id`). Called only if
   * the legacy table still exists; idempotent.
   */
  private maybeMigrateIndexMarks(): void {
    if (!this.tableExists('index_marks')) return;
    const rows = this.db
      .prepare(
        `SELECT strategy, MAX(event_id) AS last_event_id, MAX(marked_at) AS last_marked_at
         FROM index_marks
         GROUP BY strategy`,
      )
      .all() as Array<{
        strategy: string;
        last_event_id: string;
        last_marked_at: string;
      }>;
    const upsert = this.db.prepare(
      `INSERT INTO index_state (strategy, last_event_id, last_marked_at)
       VALUES (@strategy, @last_event_id, @last_marked_at)
       ON CONFLICT(strategy) DO UPDATE SET
         last_event_id  = MAX(index_state.last_event_id, excluded.last_event_id),
         last_marked_at = excluded.last_marked_at`,
    );
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        upsert.run(r);
      }
      this.db.exec('DROP TABLE index_marks;');
    });
    tx();
    this.logger.info(
      `migrated: collapsed index_marks (${rows.length} strategy row(s)) into index_state`,
    );
  }

  /**
   * Migrate the legacy `events.raw` JSON column into the typed
   * columns added by `maybeAddColumn` above + an `extra_json` column
   * for fields not promoted to columns. Drops `raw` at the end.
   * Idempotent — detects the legacy column via `PRAGMA table_info`.
   */
  private maybeMigrateEventsRaw(): void {
    const cols = this.db
      .prepare('PRAGMA table_info(events)')
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'raw')) return;

    // Anything still NULL in extra_json (or any of the promoted
    // columns) on rows where `raw` is set needs reconstruction. We
    // gate on `extra_json IS NULL` as the cheap heuristic — it's
    // never null after a fresh insert under the new schema.
    const pending = (
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM events WHERE raw IS NOT NULL AND extra_json IS NULL',
        )
        .get() as { n: number }
    ).n;

    if (pending > 0) {
      const start = Date.now();
      const rows = this.db
        .prepare(
          'SELECT id, raw FROM events WHERE raw IS NOT NULL AND extra_json IS NULL',
        )
        .all() as Array<{ id: string; raw: string }>;
      const upd = this.db.prepare(
        `UPDATE events SET
            app_bundle_id    = @app_bundle_id,
            duration_ms      = @duration_ms,
            idle_before_ms   = @idle_before_ms,
            screen_index     = @screen_index,
            capture_plugin   = @capture_plugin,
            privacy_filtered = @privacy_filtered,
            extra_json       = @extra_json
          WHERE id = @id`,
      );
      const tx = this.db.transaction(() => {
        for (const r of rows) {
          let parsed: Partial<RawEvent>;
          try {
            parsed = JSON.parse(r.raw) as Partial<RawEvent>;
          } catch {
            // Unparseable payload — leave row's promoted columns NULL
            // but still set extra_json so we can drop the column.
            upd.run({
              id: r.id,
              app_bundle_id: null,
              duration_ms: null,
              idle_before_ms: null,
              screen_index: null,
              capture_plugin: null,
              privacy_filtered: 0,
              extra_json: '{"_corrupt":true}',
            });
            continue;
          }
          upd.run({
            id: r.id,
            app_bundle_id: parsed.app_bundle_id ?? null,
            duration_ms: parsed.duration_ms ?? null,
            idle_before_ms: parsed.idle_before_ms ?? null,
            screen_index:
              typeof parsed.screen_index === 'number' ? parsed.screen_index : null,
            capture_plugin: parsed.capture_plugin ?? null,
            privacy_filtered: parsed.privacy_filtered ? 1 : 0,
            extra_json: serialiseEventExtra(parsed as RawEvent),
          });
        }
      });
      tx();
      this.logger.info(
        `migrated: backfilled ${rows.length} event(s) from raw JSON into typed columns ` +
          `in ${Date.now() - start}ms`,
      );
    }

    // Now drop `raw`.
    try {
      this.db.exec('ALTER TABLE events DROP COLUMN raw');
      this.logger.info('migrated: dropped events.raw');
    } catch (err) {
      this.logger.warn('DROP COLUMN events.raw failed; leaving in place', {
        err: String(err),
      });
    }
  }

  private upsertEventRow(event: RawEvent, day: string): void {
    // NOTE: free-text search on events was removed in favour of `frames` /
    // `frame_text`. Frames carry the full OCR + accessibility text, joined
    // with app/window/url; events are kept as the raw audit log only.
    const upsert = this.db.prepare(`
      INSERT INTO events
        (id, timestamp, type, app, app_bundle_id, window_title, url, content,
         asset_path, session_id, day, duration_ms, idle_before_ms, screen_index,
         capture_plugin, privacy_filtered, extra_json)
      VALUES
        (@id, @timestamp, @type, @app, @app_bundle_id, @window_title, @url, @content,
         @asset_path, @session_id, @day, @duration_ms, @idle_before_ms, @screen_index,
         @capture_plugin, @privacy_filtered, @extra_json)
      ON CONFLICT(id) DO NOTHING
    `);
    upsert.run({
      id: event.id,
      timestamp: event.timestamp,
      type: event.type,
      app: event.app ?? null,
      app_bundle_id: event.app_bundle_id ?? null,
      window_title: event.window_title ?? null,
      url: event.url,
      content: event.content,
      asset_path: event.asset_path,
      session_id: event.session_id,
      day,
      duration_ms: event.duration_ms,
      idle_before_ms: event.idle_before_ms,
      screen_index: typeof event.screen_index === 'number' ? event.screen_index : null,
      capture_plugin: event.capture_plugin ?? null,
      privacy_filtered: event.privacy_filtered ? 1 : 0,
      extra_json: serialiseEventExtra(event),
    });
  }

  private async measureAssetBytes(): Promise<number> {
    const rawDir = path.join(this.root, 'raw');
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile() && !full.endsWith('events.jsonl')) {
          try {
            const stat = await fsp.stat(full);
            total += stat.size;
          } catch {
            // ignore
          }
        }
      }
    };
    await walk(rawDir);
    return total;
  }

  private async getCachedAssetBytes(): Promise<number> {
    const now = Date.now();
    if (this.assetBytesCache && this.assetBytesCache.expiresAt > now) {
      return this.assetBytesCache.value;
    }
    const value = await this.measureAssetBytes();
    this.assetBytesCache = {
      value,
      expiresAt: now + ASSET_BYTES_CACHE_TTL_MS,
    };
    return value;
  }

  private invalidateAssetBytesCache(): void {
    this.assetBytesCache = null;
  }
}

// ---------------------------------------------------------------------------
// Event row helpers — reconstruct RawEvent from the typed columns +
// extra_json, instead of round-tripping through a duplicated `raw` JSON
// string. Saves ~10MB on the live DB, scales with retention.
// ---------------------------------------------------------------------------

const EVENT_SELECT_COLUMNS =
  'id, timestamp, type, app, app_bundle_id, window_title, url, content, ' +
  'asset_path, session_id, duration_ms, idle_before_ms, screen_index, ' +
  'capture_plugin, privacy_filtered, extra_json';

interface RawEventRow {
  id: string;
  timestamp: string;
  type: string;
  app: string | null;
  app_bundle_id: string | null;
  window_title: string | null;
  url: string | null;
  content: string | null;
  asset_path: string | null;
  session_id: string | null;
  duration_ms: number | null;
  idle_before_ms: number | null;
  screen_index: number | null;
  capture_plugin: string | null;
  privacy_filtered: number | null;
  extra_json: string | null;
}

function rowToEvent(r: RawEventRow): RawEvent {
  const metadata = eventMetadataFromExtraJson(r.extra_json);
  return {
    id: r.id,
    timestamp: r.timestamp,
    type: r.type as RawEvent['type'],
    app: r.app ?? '',
    app_bundle_id: r.app_bundle_id ?? '',
    window_title: r.window_title ?? '',
    url: r.url,
    content: r.content,
    asset_path: r.asset_path,
    session_id: r.session_id ?? '',
    duration_ms: r.duration_ms,
    idle_before_ms: r.idle_before_ms,
    screen_index: r.screen_index ?? 0,
    metadata,
    privacy_filtered: r.privacy_filtered === 1,
    capture_plugin: r.capture_plugin ?? '',
  };
}

function eventMetadataFromExtraJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    const metadata: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key !== 'metadata') metadata[key] = value;
    }
    if (isRecord(parsed.metadata)) {
      Object.assign(metadata, parsed.metadata);
    }
    return metadata;
  } catch {
    // tolerate corruption — empty metadata is better than crashing reads
    return {};
  }
}

function normaliseEventTimestamp(event: RawEvent): RawEvent {
  if (isValidTimestamp(event.timestamp)) return event;
  const timestamp = timestampFromRecordId(event.id) ?? new Date().toISOString();
  return { ...event, timestamp };
}

function normaliseTimestampValue(value: string | null | undefined): string | null {
  if (!isValidTimestamp(value)) return null;
  return new Date(Date.parse(value!)).toISOString();
}

function isValidTimestamp(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function timestampFromRecordId(id: string | null | undefined): string | null {
  if (!id) return null;
  const parts = id.split('_');
  if (parts.length < 2) return null;
  const ms = Number.parseInt(parts[1]!, 36);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const timestamp = new Date(ms).toISOString();
  return isValidTimestamp(timestamp) ? timestamp : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Persist any event field NOT mapped to a typed column into a single
 * JSON blob. Today that's just `metadata` plus any future top-level
 * field a newer capture plugin might emit (forward-compatibility
 * insurance). Returns null when there's nothing to keep so older
 * rows don't carry empty `{}` strings.
 */
function serialiseEventExtra(event: RawEvent): string | null {
  const TYPED_KEYS = new Set([
    'id',
    'timestamp',
    'type',
    'app',
    'app_bundle_id',
    'window_title',
    'url',
    'content',
    'asset_path',
    'session_id',
    'duration_ms',
    'idle_before_ms',
    'screen_index',
    'capture_plugin',
    'privacy_filtered',
  ]);
  const extras: Record<string, unknown> = {};
  // Always include metadata (kitchen sink) when non-empty.
  if (event.metadata && Object.keys(event.metadata).length > 0) {
    extras.metadata = event.metadata;
  }
  // Sweep up unknown top-level fields in case a future capture plugin
  // adds a property not declared on the RawEvent interface yet.
  for (const [k, v] of Object.entries(event as unknown as Record<string, unknown>)) {
    if (TYPED_KEYS.has(k) || k === 'metadata') continue;
    extras[k] = v;
  }
  if (Object.keys(extras).length === 0) return null;
  return JSON.stringify(extras);
}

interface RawFrameRow {
  id: string;
  timestamp: string;
  day: string;
  monitor: number;
  app: string | null;
  app_bundle_id: string | null;
  window_title: string | null;
  url: string | null;
  text: string | null;
  text_source: string | null;
  asset_path: string | null;
  perceptual_hash: string | null;
  trigger: string | null;
  session_id: string | null;
  duration_ms: number | null;
  entity_path: string | null;
  entity_kind: string | null;
  activity_session_id: string | null;
  meeting_id: string | null;
  source_event_ids: string;
}

function rowToFrame(r: RawFrameRow): Frame {
  let sourceEventIds: string[] = [];
  try {
    sourceEventIds = JSON.parse(r.source_event_ids) as string[];
  } catch {
    // tolerate corruption: an empty list is better than crashing search
  }
  return {
    id: r.id,
    timestamp: r.timestamp,
    day: r.day,
    monitor: r.monitor ?? 0,
    app: r.app ?? '',
    app_bundle_id: r.app_bundle_id ?? '',
    window_title: r.window_title ?? '',
    url: r.url,
    text: r.text,
    text_source: (r.text_source as Frame['text_source']) ?? null,
    asset_path: r.asset_path,
    perceptual_hash: r.perceptual_hash,
    trigger: r.trigger,
    session_id: r.session_id ?? '',
    duration_ms: r.duration_ms,
    entity_path: r.entity_path,
    entity_kind: (r.entity_kind as Frame['entity_kind']) ?? null,
    activity_session_id: r.activity_session_id,
    meeting_id: r.meeting_id ?? null,
    source_event_ids: sourceEventIds,
  };
}

interface RawMeetingRow {
  id: string;
  entity_path: string;
  title: string | null;
  platform: string;
  started_at: string;
  ended_at: string;
  day: string;
  duration_ms: number;
  frame_count: number;
  screenshot_count: number;
  audio_chunk_count: number;
  transcript_chars: number;
  content_hash: string;
  summary_status: string;
  summary_md: string | null;
  summary_json: string | null;
  attendees_json: string;
  links_json: string;
  failure_reason: string | null;
  updated_at: string;
}

function rowToMeeting(r: RawMeetingRow): Meeting {
  let attendees: string[] = [];
  let links: string[] = [];
  let summaryJson: MeetingSummaryJson | null = null;
  try {
    const parsed = JSON.parse(r.attendees_json) as unknown;
    if (Array.isArray(parsed)) {
      attendees = parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    // tolerate corruption
  }
  try {
    const parsed = JSON.parse(r.links_json) as unknown;
    if (Array.isArray(parsed)) {
      links = parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    // tolerate corruption
  }
  if (r.summary_json) {
    try {
      summaryJson = JSON.parse(r.summary_json) as MeetingSummaryJson;
    } catch {
      summaryJson = null;
    }
  }
  return {
    id: r.id,
    entity_path: r.entity_path,
    title: r.title ?? null,
    platform: r.platform as MeetingPlatform,
    started_at: r.started_at,
    ended_at: r.ended_at,
    day: r.day,
    duration_ms: r.duration_ms,
    frame_count: r.frame_count,
    screenshot_count: r.screenshot_count,
    audio_chunk_count: r.audio_chunk_count,
    transcript_chars: r.transcript_chars,
    content_hash: r.content_hash,
    summary_status: r.summary_status as MeetingSummaryStatus,
    summary_md: r.summary_md,
    summary_json: summaryJson,
    attendees,
    links,
    failure_reason: r.failure_reason,
    updated_at: r.updated_at,
  };
}

interface RawMeetingTurnRow {
  id: number;
  meeting_id: string;
  t_start: string;
  t_end: string;
  speaker: string | null;
  text: string;
  visual_frame_id: string | null;
  source: string;
}

function rowToMeetingTurn(r: RawMeetingTurnRow): MeetingTurn {
  return {
    id: r.id,
    meeting_id: r.meeting_id,
    t_start: r.t_start,
    t_end: r.t_end,
    speaker: r.speaker,
    text: r.text,
    visual_frame_id: r.visual_frame_id,
    source: r.source as MeetingTurn['source'],
  };
}

function frameEmbeddingContent(frame: Frame): string {
  const parts = [
    frame.app ? `App: ${frame.app}` : null,
    frame.window_title ? `Window: ${frame.window_title}` : null,
    frame.url ? `URL: ${frame.url}` : null,
    frame.entity_path ? `Entity: ${frame.entity_path}` : null,
    frame.text ? `Text: ${truncateForEmbedding(frame.text, MAX_EMBEDDING_TEXT_CHARS)}` : null,
  ].filter((p): p is string => Boolean(p));
  return parts.join('\n').trim();
}

function memoryChunkEmbeddingContent(chunk: MemoryChunk): string {
  const parts = [
    `Kind: ${chunk.kind}`,
    chunk.title ? `Title: ${chunk.title}` : null,
    chunk.entityPath ? `Entity: ${chunk.entityPath}` : null,
    chunk.day ? `Day: ${chunk.day}` : null,
    chunk.timestamp ? `Timestamp: ${chunk.timestamp}` : null,
    chunk.body ? `Body: ${truncateForEmbedding(chunk.body, MAX_EMBEDDING_TEXT_CHARS * 2)}` : null,
  ].filter((p): p is string => Boolean(p));
  return parts.join('\n').trim();
}

function truncateForEmbedding(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars).trimEnd();
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function normaliseVector(values: unknown[]): number[] {
  const nums = values
    .map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null))
    .filter((v): v is number => v != null);
  const norm = Math.sqrt(nums.reduce((acc, v) => acc + v * v, 0));
  if (!Number.isFinite(norm) || norm === 0) return [];
  return nums.map((v) => v / norm);
}

/**
 * Pack a numeric vector into a Float32 Buffer suitable for storage as
 * a SQLite BLOB. Empty input -> empty Buffer (caller should treat as
 * "skip write"). Caller is expected to pre-normalise.
 */
function packFloat32(values: ArrayLike<number>): Buffer {
  if (!values || values.length === 0) return Buffer.alloc(0);
  const out = Buffer.allocUnsafe(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out.writeFloatLE(typeof v === 'number' && Number.isFinite(v) ? v : 0, i * 4);
  }
  return out;
}

/**
 * Inverse of `packFloat32`. Returns a typed Float32Array view backed by
 * a copy of `buf` (we copy because better-sqlite3 buffers are pooled
 * and may be reused across `.all()` rows).
 */
function unpackFloat32(buf: Buffer | null | undefined): Float32Array {
  if (!buf || buf.byteLength === 0) return new Float32Array(0);
  const dims = Math.floor(buf.byteLength / 4);
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const len = Math.min(a.length, b.length);
  let out = 0;
  for (let i = 0; i < len; i++) out += (a[i] ?? 0) * (b[i] ?? 0);
  // Convert cosine [-1, 1] into a friendlier [0, 1] score.
  return (out + 1) / 2;
}

function compareSemanticCandidates(
  a: { row: RawFrameRow; score: number },
  b: { row: RawFrameRow; score: number },
): number {
  if (b.score !== a.score) return b.score - a.score;
  return b.row.timestamp.localeCompare(a.row.timestamp);
}

function compareMemoryChunkCandidates(
  a: { row: MemoryChunkRow; score: number },
  b: { row: MemoryChunkRow; score: number },
): number {
  if (b.score !== a.score) return b.score - a.score;
  return (b.row.timestamp ?? b.row.updated_at).localeCompare(a.row.timestamp ?? a.row.updated_at);
}

/**
 * Extract a normalised lower-case hostname from a URL string. Returns
 * null for non-URL inputs. The leading `www.` is stripped so `www.x.com`
 * and `x.com` collapse to one host (matches user expectations for
 * domain filters).
 */
function extractUrlHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}

/** Normalise a user-supplied domain filter to match `extractUrlHost`. */
function normaliseHostFilter(domain: string): string {
  return domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]!;
}

interface RawEntityRow {
  path: string;
  kind: string;
  title: string;
  first_seen: string;
  last_seen: string;
  total_focused_ms: number;
  frame_count: number;
}

function rowToEntity(r: RawEntityRow): EntityRecord {
  return {
    path: r.path,
    kind: r.kind as EntityRecord['kind'],
    title: r.title,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    totalFocusedMs: r.total_focused_ms ?? 0,
    frameCount: r.frame_count ?? 0,
  };
}

interface RawSessionRow {
  id: string;
  started_at: string;
  ended_at: string;
  day: string;
  duration_ms: number;
  active_ms: number;
  frame_count: number;
  primary_entity_path: string | null;
  primary_entity_kind: string | null;
  primary_app: string | null;
  entities_json: string;
}

function rowToSession(r: RawSessionRow): ActivitySession {
  let entities: string[] = [];
  try {
    const parsed = JSON.parse(r.entities_json) as unknown;
    if (Array.isArray(parsed)) {
      entities = parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    // Tolerate corrupt rows — better an empty list than a crash on read.
  }
  return {
    id: r.id,
    started_at: r.started_at,
    ended_at: r.ended_at,
    day: r.day,
    duration_ms: r.duration_ms,
    active_ms: r.active_ms,
    frame_count: r.frame_count,
    primary_entity_path: r.primary_entity_path,
    primary_entity_kind: r.primary_entity_kind as EntityKind | null,
    primary_app: r.primary_app,
    entities,
  };
}

/**
 * Tokenise an entity path + kind into a string suitable for FTS.
 * Strips the kind-prefix segment (`projects/`, `apps/`, ...) so the
 * meaningful slug is what gets indexed; replaces `-` and `_` with
 * spaces so "milan-lazic" matches a search for "milan" or "lazic";
 * appends the kind so a query like "project" narrows correctly.
 * Returns empty string when the frame has no resolved entity yet.
 *
 * Examples:
 *   ("projects/beside", "project")   -> "beside project"
 *   ("contacts/milan-lazic", "contact")   -> "milan lazic contact"
 *   ("channels/postman-liblab-prs", ...)  -> "postman liblab prs channel"
 *   (null, null)                          -> ""
 */
function entityToFtsText(
  path: string | null | undefined,
  kind: string | null | undefined,
): string {
  if (!path) return '';
  const tail = path.split('/').slice(-1)[0] ?? path;
  const tokens = tail.replace(/[-_/]+/g, ' ').trim();
  return kind ? `${tokens} ${kind}` : tokens;
}

function ftsBodyText(text: string, url: string | null | undefined): string {
  const parts = [text.trim(), urlToFtsHints(url)].filter((part) => part.length > 0);
  return parts.join('\n');
}

function urlToFtsHints(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const host = extractUrlHost(url);
    const hostTokens = host ? host.replace(/[.-]+/g, ' ') : '';
    const pathTokens = decodeURIComponent(parsed.pathname)
      .replace(/\.[A-Za-z0-9]+$/g, ' ')
      .replace(/[^A-Za-z0-9]+/g, ' ')
      .trim();
    return [host, hostTokens, pathTokens].filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

/**
 * Best-effort title from an entity path. Used by `rebuildEntityCounts`
 * when the original resolver-supplied title is not available.
 */
function pathToTitle(p: string): string {
  const last = p.split('/').pop() ?? p;
  return last
    .replace(/[-_]+/g, ' ')
    .replace(/\.md$/i, '')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Strip characters that have special meaning in FTS5 to make user input
 * safe. Anything that survives is treated as a phrase / prefix query so
 * `cloudflare dns` works without forcing users to write `"cloudflare dns"`.
 */
function sanitiseFtsQuery(input: string): string {
  const cleaned = input
    .replace(/["'()*:^-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '""';
  // Quote each token to neutralise any FTS keyword (NEAR / OR / AND / NOT)
  // and append `*` for prefix matching on the last token. Multi-token =
  // implicit AND.
  const tokens = cleaned.split(' ').filter((t) => t.length > 0);
  return tokens
    .map((t, i) => {
      const quoted = `"${t.replace(/"/g, '')}"`;
      return i === tokens.length - 1 ? `${quoted}*` : quoted;
    })
    .join(' ');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const factory: PluginFactory<IStorage> = async (ctx) => {
  const cfg = ctx.config as LocalStorageConfig;
  // `local.path` is the storage root that contains raw/, checkpoints/,
  // and beside.db. Falls back to the app's data_dir.
  const root = expandPath(cfg.path ?? ctx.dataDir);
  const storage = new LocalStorage(root, ctx.logger);
  await storage.init();
  return storage;
};

export default factory;
