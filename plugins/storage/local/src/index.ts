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

class LocalStorage implements IStorage {
  private readonly root: string;
  private readonly logger: Logger;
  private db!: Database.Database;
  private readonly writeStreams = new Map<string, fs.WriteStream>();

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
    const day = dayKey(new Date(event.timestamp));
    const dayDir = path.join(this.root, 'raw', day);
    await ensureDir(dayDir);
    const jsonlPath = path.join(dayDir, 'events.jsonl');
    const stream = this.getStream(jsonlPath);

    await new Promise<void>((resolve, reject) => {
      stream.write(JSON.stringify(event) + '\n', (err) =>
        err ? reject(err) : resolve(),
      );
    });

    this.upsertEventRow(event, day);
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
    const sql: string[] = ['SELECT raw FROM events WHERE 1=1'];
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
    if (query.text) {
      // Use FTS table for free-text search.
      sql.push(
        'AND id IN (SELECT event_id FROM events_fts WHERE events_fts MATCH @text)',
      );
      params.text = query.text;
    }
    if (query.unindexed_for_strategy) {
      sql.push(
        'AND id NOT IN (SELECT event_id FROM index_marks WHERE strategy = @strat)',
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

    const rows = this.db.prepare(sql.join(' ')).all(params) as Array<{ raw: string }>;
    return rows.map((r) => JSON.parse(r.raw) as RawEvent);
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
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO index_marks (strategy, event_id, marked_at) VALUES (@s, @e, @t)',
    );
    const tx = this.db.transaction((ids: string[]) => {
      const t = new Date().toISOString();
      for (const id of ids) stmt.run({ s: strategy, e: id, t });
    });
    tx(eventIds);
  }

  async clearIndexCheckpoint(strategy: string): Promise<void> {
    this.db.prepare('DELETE FROM index_marks WHERE strategy = ?').run(strategy);
  }

  async getIndexCheckpoint(strategy: string): Promise<string | null> {
    const row = this.db
      .prepare(
        'SELECT MAX(event_id) AS last FROM index_marks WHERE strategy = ?',
      )
      .get(strategy) as { last: string | null };
    return row?.last ?? null;
  }

  // -------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------

  async upsertFrame(frame: Frame): Promise<void> {
    const upsert = this.db.prepare(`
      INSERT INTO frames (
        id, timestamp, day, monitor, app, app_bundle_id, window_title, url,
        text, text_source, asset_path, perceptual_hash, trigger, session_id,
        duration_ms, source_event_ids, created_at
      ) VALUES (
        @id, @timestamp, @day, @monitor, @app, @app_bundle_id, @window_title, @url,
        @text, @text_source, @asset_path, @perceptual_hash, @trigger, @session_id,
        @duration_ms, @source_event_ids, @created_at
      )
      ON CONFLICT(id) DO UPDATE SET
        text = COALESCE(excluded.text, frames.text),
        text_source = COALESCE(excluded.text_source, frames.text_source),
        url = COALESCE(excluded.url, frames.url),
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
      // Re-index the FTS row. FTS5 doesn't support upsert; we delete-then-insert.
      this.db.prepare('DELETE FROM frame_text WHERE frame_id = ?').run(frame.id);
      this.db
        .prepare(
          'INSERT INTO frame_text (frame_id, text, app, window_title, url) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          frame.id,
          frame.text ?? '',
          frame.app ?? '',
          frame.window_title ?? '',
          frame.url ?? '',
        );
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
      sql.push('ORDER BY bm25(frame_text) ASC');
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
      this.db
        .prepare('UPDATE frames SET text = ?, text_source = ? WHERE id = ?')
        .run(text, source, frameId);
      // Refresh FTS row so the new text is immediately searchable.
      const row = this.db
        .prepare(
          'SELECT app, window_title, url FROM frames WHERE id = ?',
        )
        .get(frameId) as
        | { app: string | null; window_title: string | null; url: string | null }
        | undefined;
      if (row) {
        this.db.prepare('DELETE FROM frame_text WHERE frame_id = ?').run(frameId);
        this.db
          .prepare(
            'INSERT INTO frame_text (frame_id, text, app, window_title, url) VALUES (?, ?, ?, ?, ?)',
          )
          .run(frameId, text, row.app ?? '', row.window_title ?? '', row.url ?? '');
      }
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
    this.db
      .prepare(
        `INSERT INTO frame_embeddings
          (frame_id, model, content_hash, vector_json, dims, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(frame_id, model) DO UPDATE SET
           content_hash = excluded.content_hash,
           vector_json = excluded.vector_json,
           dims = excluded.dims,
           created_at = excluded.created_at`,
      )
      .run(
        frameId,
        model,
        contentHash,
        JSON.stringify(cleaned),
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

    const rows = this.db
      .prepare(
        `SELECT frames.*, frame_embeddings.vector_json
         FROM frame_embeddings
         JOIN frames ON frames.id = frame_embeddings.frame_id
         WHERE ${where.join(' AND ')}`,
      )
      .all(params) as Array<RawFrameRow & { vector_json: string }>;

    const matches: FrameSemanticMatch[] = [];
    for (const row of rows) {
      const candidate = parseVector(row.vector_json);
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
          'SELECT timestamp, duration_ms FROM frames WHERE id = ?',
        )
        .get(frameId) as
        | { timestamp: string; duration_ms: number | null }
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
    });
    tx();
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
  // Internals
  // -------------------------------------------------------------------------

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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id           TEXT PRIMARY KEY,
        timestamp    TEXT NOT NULL,
        type         TEXT NOT NULL,
        app          TEXT,
        window_title TEXT,
        url          TEXT,
        content      TEXT,
        asset_path   TEXT,
        session_id   TEXT,
        day          TEXT,
        raw          TEXT NOT NULL,
        framed_at    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_day ON events(day);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_app ON events(app);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

      CREATE TABLE IF NOT EXISTS index_marks (
        strategy   TEXT NOT NULL,
        event_id   TEXT NOT NULL,
        marked_at  TEXT NOT NULL,
        PRIMARY KEY (strategy, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_marks_strategy ON index_marks(strategy);

      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        event_id UNINDEXED,
        content,
        app,
        window_title
      );

      CREATE TABLE IF NOT EXISTS frames (
        id               TEXT PRIMARY KEY,
        timestamp        TEXT NOT NULL,
        day              TEXT NOT NULL,
        monitor          INTEGER NOT NULL DEFAULT 0,
        app              TEXT,
        app_bundle_id    TEXT,
        window_title     TEXT,
        url              TEXT,
        text             TEXT,
        text_source      TEXT,
        asset_path       TEXT,
        perceptual_hash  TEXT,
        trigger          TEXT,
        session_id       TEXT,
        duration_ms      INTEGER,
        entity_path      TEXT,
        entity_kind      TEXT,
        source_event_ids TEXT NOT NULL,
        created_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_frames_day ON frames(day);
      CREATE INDEX IF NOT EXISTS idx_frames_ts ON frames(timestamp);
      CREATE INDEX IF NOT EXISTS idx_frames_app ON frames(app);
      CREATE INDEX IF NOT EXISTS idx_frames_url ON frames(url);
      CREATE INDEX IF NOT EXISTS idx_frames_session ON frames(session_id);
      -- Workers find frames that still need visual OCR. Pure AX text is
      -- queued too because browser accessibility trees often expose chrome
      -- labels before page content; OCR supplements that with visible text.
      CREATE INDEX IF NOT EXISTS idx_frames_pending_ocr
        ON frames(timestamp DESC)
        WHERE asset_path IS NOT NULL
          AND (text_source IS NULL OR text_source = 'accessibility');

      CREATE VIRTUAL TABLE IF NOT EXISTS frame_text USING fts5(
        frame_id UNINDEXED,
        text,
        app,
        window_title,
        url,
        tokenize='porter unicode61 remove_diacritics 2'
      );

      CREATE TABLE IF NOT EXISTS frame_embeddings (
        frame_id     TEXT NOT NULL,
        model        TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        vector_json  TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_sessions_day ON sessions(day);
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
    `);

    // Migrate older databases that predate the framed_at column. Must
    // happen *before* we create indexes that reference it.
    this.maybeAddColumn('events', 'framed_at', 'TEXT');
    this.maybeAddColumn('frames', 'entity_path', 'TEXT');
    this.maybeAddColumn('frames', 'entity_kind', 'TEXT');
    // Vacuum retention tier — null means "original" so existing rows
    // are correctly classified without a backfill UPDATE.
    this.maybeAddColumn('frames', 'vacuum_tier', 'TEXT');
    // Activity-session FK on frames. Null on existing rows; the
    // SessionBuilder backfills incrementally on its next tick.
    this.maybeAddColumn('frames', 'activity_session_id', 'TEXT');
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_events_framed ON events(framed_at) WHERE framed_at IS NULL;
       CREATE INDEX IF NOT EXISTS idx_frames_entity ON frames(entity_path);
       DROP INDEX IF EXISTS idx_frames_pending_ocr;
       CREATE INDEX idx_frames_pending_ocr
         ON frames(timestamp DESC)
         WHERE asset_path IS NOT NULL
           AND (text_source IS NULL OR text_source = 'accessibility');
       CREATE INDEX IF NOT EXISTS idx_frames_pending_entity
         ON frames(timestamp DESC) WHERE entity_path IS NULL;
       CREATE INDEX IF NOT EXISTS idx_frames_vacuum
         ON frames(vacuum_tier, timestamp) WHERE asset_path IS NOT NULL;
       CREATE INDEX IF NOT EXISTS idx_frames_activity_session
         ON frames(activity_session_id);
       CREATE INDEX IF NOT EXISTS idx_frames_pending_session
         ON frames(timestamp ASC) WHERE activity_session_id IS NULL;`,
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

  private upsertEventRow(event: RawEvent, day: string): void {
    const upsert = this.db.prepare(`
      INSERT INTO events
        (id, timestamp, type, app, window_title, url, content,
         asset_path, session_id, day, raw)
      VALUES
        (@id, @timestamp, @type, @app, @window_title, @url, @content,
         @asset_path, @session_id, @day, @raw)
      ON CONFLICT(id) DO NOTHING
    `);
    upsert.run({
      id: event.id,
      timestamp: event.timestamp,
      type: event.type,
      app: event.app ?? null,
      window_title: event.window_title ?? null,
      url: event.url,
      content: event.content,
      asset_path: event.asset_path,
      session_id: event.session_id,
      day,
      raw: JSON.stringify(event),
    });

    if (event.content && event.content.length > 0) {
      this.db
        .prepare(
          'INSERT INTO events_fts (event_id, content, app, window_title) VALUES (?, ?, ?, ?)',
        )
        .run(event.id, event.content, event.app ?? '', event.window_title ?? '');
    }
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

function parseVector(json: string): number[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normaliseVector(parsed);
  } catch {
    return [];
  }
}

function normaliseVector(values: unknown[]): number[] {
  const nums = values
    .map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null))
    .filter((v): v is number => v != null);
  const norm = Math.sqrt(nums.reduce((acc, v) => acc + v * v, 0));
  if (!Number.isFinite(norm) || norm === 0) return [];
  return nums.map((v) => v / norm);
}

function dot(a: number[], b: number[]): number {
  let out = 0;
  for (let i = 0; i < a.length; i++) out += a[i]! * b[i]!;
  // Convert cosine [-1, 1] into a friendlier [0, 1] score.
  return (out + 1) / 2;
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
