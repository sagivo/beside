import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  IStorage,
  RawEvent,
  StorageQuery,
  StorageStats,
  Frame,
  FrameQuery,
  FrameOcrTask,
  PluginFactory,
  Logger,
} from '@cofounderos/interfaces';
import { dayKey, expandPath, ensureDir } from '@cofounderos/core';

interface LocalStorageConfig {
  path?: string;
  max_size_gb?: number;
  retention_days?: number;
}

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
        `SELECT id, asset_path FROM frames
         WHERE text_source IS NULL AND asset_path IS NOT NULL
         ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.floor(limit))) as Array<{ id: string; asset_path: string }>;
    return rows.map((r) => ({ id: r.id, asset_path: r.asset_path }));
  }

  async setFrameText(
    frameId: string,
    text: string,
    source: 'ocr' | 'accessibility',
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
        source_event_ids TEXT NOT NULL,
        created_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_frames_day ON frames(day);
      CREATE INDEX IF NOT EXISTS idx_frames_ts ON frames(timestamp);
      CREATE INDEX IF NOT EXISTS idx_frames_app ON frames(app);
      CREATE INDEX IF NOT EXISTS idx_frames_url ON frames(url);
      CREATE INDEX IF NOT EXISTS idx_frames_session ON frames(session_id);
      -- Workers find un-OCR'd frames via this partial index.
      CREATE INDEX IF NOT EXISTS idx_frames_pending_ocr
        ON frames(timestamp DESC) WHERE text_source IS NULL AND asset_path IS NOT NULL;

      CREATE VIRTUAL TABLE IF NOT EXISTS frame_text USING fts5(
        frame_id UNINDEXED,
        text,
        app,
        window_title,
        url,
        tokenize='porter unicode61 remove_diacritics 2'
      );
    `);

    // Migrate older databases that predate the framed_at column. Must
    // happen *before* we create indexes that reference it.
    this.maybeAddColumn('events', 'framed_at', 'TEXT');
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_events_framed ON events(framed_at) WHERE framed_at IS NULL',
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
    source_event_ids: sourceEventIds,
  };
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
