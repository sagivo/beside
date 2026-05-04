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
  FrameQuery,
  FrameEmbeddingTask,
  FrameSemanticMatch,
  FrameOcrTask,
  FrameTextSource,
  FrameAsset,
  FrameAssetTier,
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
  PluginFactory,
  Logger,
} from '@cofounderos/interfaces';
import { dayKey, expandPath, ensureDir } from '@cofounderos/core';

interface LocalStorageConfig {
  path?: string;
  max_size_gb?: number;
  retention_days?: number;
}

const MAX_EMBEDDING_TEXT_CHARS = 3000;
const CACHEABLE_SCREENSHOT_EXTENSIONS = new Set(['.webp']);
const FLAT_INTERNED_SCREENSHOT_RE =
  /^raw\/\d{4}-\d{2}-\d{2}\/screenshots\/[a-f0-9]{64}\.webp$/i;
const LEGACY_INTERNED_SCREENSHOT_MARKER = '/screenshots/_cache/sha256/';

interface FrameFtsFrameRow {
  text: string | null;
  text_source: string | null;
  window_title: string | null;
  app: string | null;
  entity_path: string | null;
  entity_kind: string | null;
}

class LocalStorage implements IStorage {
  private readonly root: string;
  private readonly logger: Logger;
  private db!: Database.Database;
  private readonly writeStreams = new Map<string, fs.WriteStream>();
  private frameFtsDeleteStmt: Database.Statement | null = null;
  private frameFtsInsertStmt: Database.Statement | null = null;
  private frameFtsFrameSelectStmt: Database.Statement | null = null;

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
    const storedEvent = await this.internScreenshotAsset(event);
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
  }

  async readAsset(assetPath: string): Promise<Buffer> {
    return await fsp.readFile(this.absoluteAssetPath(assetPath));
  }

  async readEvents(query: StorageQuery): Promise<RawEvent[]> {
    const sql: string[] = [`SELECT ${EVENT_SELECT_COLUMNS} FROM events WHERE 1=1`];
    const params: Record<string, unknown> = {};

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

    const totalAssetBytes = await this.measureAssetBytes();

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
    // `evt_<base36-ms>_<uuid>` (see @cofounderos/core/ids.ts), so
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
      sql.push('ORDER BY frames.timestamp DESC');
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
        `SELECT id, asset_path, text AS existing_text, text_source AS existing_source
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
      }>;
    return rows.map((r) => ({
      id: r.id,
      asset_path: r.asset_path,
      existing_text: r.existing_text,
      existing_source: (r.existing_source as FrameTextSource | null) ?? null,
    }));
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

  async listFramesNeedingEmbedding(
    model: string,
    limit: number,
  ): Promise<FrameEmbeddingTask[]> {
    const rows = this.db
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
         ORDER BY frames.timestamp DESC
         LIMIT @scanLimit`,
      )
      .all({
        model,
        // Scan a little beyond the requested batch so changed hashes can
        // be filtered in JS without starving the worker on already-current
        // rows near the top of the timeline.
        scanLimit: Math.max(1, Math.floor(limit)) * 5,
      }) as Array<RawFrameRow & { existing_hash: string | null }>;

    const out: FrameEmbeddingTask[] = [];
    for (const row of rows) {
      const content = frameEmbeddingContent(rowToFrame(row));
      if (!content) continue;
      const hash = sha256(content);
      if (row.existing_hash === hash) continue;
      out.push({ id: row.id, content_hash: hash, content });
      if (out.length >= limit) break;
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

    const rows = this.db
      .prepare(
        `SELECT frames.*, frame_embeddings.vector AS vector_blob
         FROM frame_embeddings
         JOIN frames ON frames.id = frame_embeddings.frame_id
         WHERE ${where.join(' AND ')}`,
      )
      .all(params) as Array<RawFrameRow & { vector_blob: Buffer }>;

    const matches: FrameSemanticMatch[] = [];
    for (const row of rows) {
      const candidate = unpackFloat32(row.vector_blob);
      if (candidate.length !== target.length) continue;
      const score = dot(target, candidate);
      if (!Number.isFinite(score)) continue;
      matches.push({ frame: rowToFrame(row), score });
    }
    matches.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.frame.timestamp.localeCompare(a.frame.timestamp);
    });
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const limit = Math.max(1, Math.floor(query.limit ?? 25));
    return matches.slice(offset, offset + limit);
  }

  async clearFrameEmbeddings(model?: string): Promise<void> {
    if (model) {
      this.db.prepare('DELETE FROM frame_embeddings WHERE model = ?').run(model);
    } else {
      this.db.prepare('DELETE FROM frame_embeddings').run();
    }
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
      // 1. Tag the frame.
      const updated = this.db
        .prepare(
          `UPDATE frames SET entity_path = ?, entity_kind = ?
           WHERE id = ? AND entity_path IS NULL`,
        )
        .run(entity.path, entity.kind, frameId).changes;
      if (updated === 0) return;

      // 2. Pull the frame's contribution to the entity stats.
      const frameRow = this.db
        .prepare(
          'SELECT timestamp, duration_ms, text, window_title, app FROM frames WHERE id = ?',
        )
        .get(frameId) as
        | {
            timestamp: string;
            duration_ms: number | null;
            text: string | null;
            window_title: string | null;
            app: string | null;
          }
        | undefined;
      if (!frameRow) return;
      const ts = frameRow.timestamp;
      const dur = frameRow.duration_ms ?? 0;

      // 3. Upsert the entity. ON CONFLICT updates first_seen / last_seen
      //    monotonically and accumulates the running totals.
      this.db
        .prepare(
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
        )
        .run(entity.path, entity.kind, entity.title, ts, ts, dur);

      // 4. Refresh the frame's FTS row so a search like "milan" or
      //    "cofounderos" actually matches all the frames now attributed
      //    to that entity, not just the ones that literally typed it.
      this.refreshFrameFtsRow({
        frameId,
        text: frameRow.text ?? '',
        windowTitle: frameRow.window_title ?? '',
        app: frameRow.app ?? '',
        entitySearch: entityToFtsText(entity.path, entity.kind),
      });
    });
    tx();
  }

  /**
   * Update the entity_search column on the FTS row for one frame.
   * Used after the per-frame resolver attaches an entity, after
   * SessionBuilder lifts a frame to a different entity, and after
   * any other path that mutates frames.entity_path.
   *
   * Implemented as DELETE + INSERT against frame_text -- FTS5 supports
   * UPDATE in modern SQLite, but the codebase already standardises
   * on delete+insert for FTS row mutations, so we stay consistent.
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
      app: row.app ?? '',
      entitySearch: entityToFtsText(entityPath, entityKind),
    });
  }

  private refreshFrameFtsRow(input: {
    frameId: string;
    text: string;
    windowTitle: string;
    app: string;
    entitySearch: string;
  }): boolean {
    this.getFrameFtsDeleteStmt().run(input.frameId);
    this.getFrameFtsInsertStmt().run(
      input.frameId,
      input.text,
      input.windowTitle,
      input.app,
      input.entitySearch,
    );
    return true;
  }

  private getFrameFtsDeleteStmt(): Database.Statement {
    this.frameFtsDeleteStmt ??= this.db.prepare(
      'DELETE FROM frame_text WHERE frame_id = ?',
    );
    return this.frameFtsDeleteStmt;
  }

  private getFrameFtsInsertStmt(): Database.Statement {
    this.frameFtsInsertStmt ??= this.db.prepare(
      'INSERT INTO frame_text (frame_id, text, window_title, app, entity_search) VALUES (?, ?, ?, ?, ?)',
    );
    return this.frameFtsInsertStmt;
  }

  private getFrameFtsFrameSelectStmt(): Database.Statement {
    this.frameFtsFrameSelectStmt ??= this.db.prepare(
      'SELECT text, text_source, window_title, app, entity_path, entity_kind FROM frames WHERE id = ?',
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
    // query like "cofounder" hits both `title=Cofounderos` and
    // `path=projects/cofounderos`.
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
          'apps/screencaptureui', 'apps/cofounderos'
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
        // resolver-supplied title (it already encodes "projects/cofounderos"
        // → "Cofounderos"). For other refreshed rows, fall back to the
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
      this.db.prepare('DELETE FROM frames WHERE id = ?').run(frameId);
    });
    tx();

    if (row.asset_path) {
      await this.unlinkAsset(row.asset_path);
    }
    return { assetPath: row.asset_path };
  }

  async deleteFramesByDay(
    day: string,
  ): Promise<{ frames: number; assetPaths: string[] }> {
    const rows = this.db
      .prepare('SELECT id, asset_path FROM frames WHERE day = ?')
      .all(day) as Array<{ id: string; asset_path: string | null }>;
    const ids = rows.map((r) => r.id);
    const assetPaths = rows
      .map((r) => r.asset_path)
      .filter((p): p is string => Boolean(p));

    const tx = this.db.transaction(() => {
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        this.db
          .prepare(`DELETE FROM frame_text WHERE frame_id IN (${placeholders})`)
          .run(...ids);
        this.db
          .prepare(`DELETE FROM frame_embeddings WHERE frame_id IN (${placeholders})`)
          .run(...ids);
      }
      this.db.prepare('DELETE FROM frames WHERE day = ?').run(day);
      // Sessions never span midnight, so a day-scoped delete is well-defined.
      this.db.prepare('DELETE FROM sessions WHERE day = ?').run(day);
      // Raw events: events.timestamp + events.day live together; depending on
      // schema age, `day` may not be a column on events. Filter by ISO prefix
      // on `timestamp` for portability.
      this.db
        .prepare("DELETE FROM events WHERE substr(timestamp, 1, 10) = ?")
        .run(day);
    });
    tx();

    for (const p of assetPaths) {
      await this.unlinkAsset(p);
    }
    // Best-effort: drop the day's raw/<day> directory if it's now empty.
    try {
      const dayDir = path.join(this.root, 'raw', day);
      const entries = await fsp.readdir(dayDir).catch(() => null);
      if (entries && entries.length === 0) {
        await fsp.rmdir(dayDir).catch(() => undefined);
      }
    } catch {
      /* ignore */
    }

    return { frames: ids.length, assetPaths };
  }

  async deleteAllMemory(): Promise<{
    frames: number;
    events: number;
    assetBytes: number;
  }> {
    const stats = await this.getStats();
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

    return {
      frames,
      events,
      assetBytes: stats.totalAssetBytes,
    };
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

  private async openDb(): Promise<void> {
    const dbPath = path.join(this.root, 'cofounderOS.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');

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
        source_event_ids    TEXT NOT NULL,
        created_at          TEXT NOT NULL
      );

      -- frame_text: free-text search over a frame's body + window
      -- title + app + the entity it was attributed to. URL is
      -- intentionally excluded -- it lives in the indexed
      -- frames.url_host column where it can be exact-matched without
      -- polluting the porter stemmer.
      --
      -- entity_search holds a tokenised projection of the frame's
      -- entity_path + entity_kind (e.g. "cofounderos project" for
      -- projects/cofounderos). Without this column, searching
      -- "cofounderos" only matches frames that literally type the word
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
      -- the desktop UI can autocomplete on either ("cofounder" matches
      -- both "projects/cofounderos" and "Cofounderos"). The kind column
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
        'apps/screencaptureui', 'apps/cofounderos'
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
          'apps/screencaptureui', 'apps/cofounderos'
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
    `);

    this.runSchemaMigrations();
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
    this.maybeAddColumn('frames', 'url_host', 'TEXT');

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
      const tx = this.db.transaction(() => {
        for (const r of rows) {
          const host = extractUrlHost(r.url);
          if (host) upd.run(host, r.id);
        }
      });
      tx();
      this.logger.info(`migrated: backfilled url_host for ${rows.length} frames`);
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
      CREATE INDEX IF NOT EXISTS idx_frames_session
        ON frames(session_id);
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
        'apps/screencaptureui', 'apps/cofounderos'
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
          'apps/screencaptureui', 'apps/cofounderos'
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
          'apps/screencaptureui', 'apps/cofounderos'
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
          'apps/screencaptureui', 'apps/cofounderos'
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
    const TARGET_VERSION = 6;
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
   * expected columns. Currently triggers when:
   *   - the legacy `url` column is still present, or
   *   - the `entity_search` column is missing (added later).
   */
  private maybeRebuildFrameTextFts(): void {
    const cols = this.db
      .prepare('PRAGMA table_info(frame_text)')
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    const hasUrl = names.has('url');
    const hasEntitySearch = names.has('entity_search');
    if (!hasUrl && hasEntitySearch) return;

    this.logger.info(
      `migrating: rebuilding frame_text FTS (had url=${hasUrl}, had entity_search=${hasEntitySearch})`,
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
        `SELECT id, text, window_title, app, entity_path, entity_kind FROM frames`,
      )
      .all() as Array<{
      id: string;
      text: string | null;
      window_title: string | null;
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
          r.text ?? '',
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
  let metadata: Record<string, unknown> = {};
  if (r.extra_json) {
    try {
      const parsed = JSON.parse(r.extra_json) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') metadata = parsed;
    } catch {
      // tolerate corruption — empty metadata is better than crashing read
    }
  }
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
    source_event_ids: sourceEventIds,
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
 *   ("projects/cofounderos", "project")   -> "cofounderos project"
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
  // and cofounderOS.db. Falls back to the app's data_dir.
  const root = expandPath(cfg.path ?? ctx.dataDir);
  const storage = new LocalStorage(root, ctx.logger);
  await storage.init();
  return storage;
};

export default factory;
