import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  IStorage,
  RawEvent,
  StorageQuery,
  StorageStats,
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
        raw          TEXT NOT NULL
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
    `);
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
