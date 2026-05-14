import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  IExport,
  IStorage,
  ExportStatus,
  ExportServices,
  IndexPage,
  IndexState,
  IIndexStrategy,
  ReorganisationSummary,
  PluginFactory,
  Logger,
} from '@beside/interfaces';
import { ensureDir, expandPath } from '@beside/core';

interface MarkdownExportConfig {
  path?: string;
  enabled?: boolean;
}

export interface MarkdownExportServices {
  storage: IStorage;
  strategy?: IIndexStrategy;
  /**
   * Absolute path to the data dir (where the `raw/` screenshot tree lives).
   * Used to rewrite `![](raw/…)` asset references in mirrored pages so the
   * export tree is portable when copied to e.g. an Obsidian vault.
   */
  dataDir: string;
}

class MarkdownExport implements IExport {
  readonly name = 'markdown';

  private readonly logger: Logger;
  private readonly outDir: string;
  private running = false;
  private lastSync: string | null = null;
  private pendingUpdates = 0;
  private errorCount = 0;
  private services: MarkdownExportServices | null = null;
  private rootIndexCache: string | null = null;

  constructor(outDir: string, logger: Logger) {
    this.outDir = outDir;
    this.logger = logger.child('export-markdown');
  }

  /**
   * Called by the orchestrator after instantiation to inject storage so
   * the export can rewrite asset paths against the absolute data dir.
   * Optional — installs that don't bind services still get wiki-page
   * mirroring as before.
   */
  bindServices(services: ExportServices | MarkdownExportServices): void {
    const bound: MarkdownExportServices = {
      storage: services.storage,
      dataDir: services.dataDir,
    };
    if ('strategy' in services && services.strategy) bound.strategy = services.strategy;
    this.services = bound;
  }

  async start(): Promise<void> {
    await ensureDir(this.outDir);
    this.running = true;
    this.logger.info(`markdown export ready at ${this.outDir}`);
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async onPageUpdate(page: IndexPage): Promise<void> {
    if (!this.running) return;
    this.pendingUpdates += 1;
    try {
      const target = path.join(this.outDir, page.path);
      await ensureDir(path.dirname(target));
      // We strip our internal metadata block — the export tree is for
      // humans / external agents, not for our own round-trip.
      await this.writeTextIfChanged(
        target,
        this.prepareMarkdownForExport(page.content, target),
      );
      await this.refreshRootIndex();
      this.lastSync = new Date().toISOString();
    } catch (err) {
      this.errorCount += 1;
      this.logger.error('export write failed', { err: String(err), page: page.path });
    } finally {
      this.pendingUpdates = Math.max(0, this.pendingUpdates - 1);
    }
  }

  async onPageDelete(pagePath: string): Promise<void> {
    if (!this.running) return;
    try {
      await fs.unlink(path.join(this.outDir, pagePath));
      await this.refreshRootIndex();
    } catch {
      // ignore
    }
  }

  async onReorganisation(summary: ReorganisationSummary): Promise<void> {
    if (!this.running) return;
    const log = path.join(this.outDir, '_log.md');
    const stamp = new Date().toISOString();
    const lines = [`\n## ${stamp}`, ''];
    if (summary.archived.length) lines.push(`- archived: ${summary.archived.join(', ')}`);
    if (summary.newSummaryPages.length) {
      lines.push(`- summaries: ${summary.newSummaryPages.join(', ')}`);
    }
    if (summary.notes) lines.push(`- notes: ${summary.notes}`);
    try {
      await fs.appendFile(log, lines.join('\n') + '\n', 'utf8');
    } catch (err) {
      this.errorCount += 1;
      this.logger.error('export log append failed', { err: String(err) });
    }
  }

  async fullSync(_state: IndexState, strategy: IIndexStrategy): Promise<void> {
    if (!this.running) await this.start();
    await ensureDir(this.outDir);

    await this.clearMarkdownFiles(this.outDir);
    this.rootIndexCache = null;
    await this.copyTree(_state.rootPath, this.outDir);
    await this.refreshRootIndex(strategy);

    // Day journals are now first-class index pages (`days/<day>.md`)
    // owned by the karpathy strategy, so they get mirrored by `copyTree`
    // above alongside every other entity page. No special-case journal
    // render here.

    this.lastSync = new Date().toISOString();
    this.logger.info('markdown export full sync complete');
  }

  getStatus(): ExportStatus {
    return {
      name: this.name,
      running: this.running,
      lastSync: this.lastSync,
      pendingUpdates: this.pendingUpdates,
      errorCount: this.errorCount,
    };
  }

  private async copyTree(srcRoot: string, dstRoot: string): Promise<void> {
    const walk = async (relDir: string): Promise<void> => {
      const srcDir = path.join(srcRoot, relDir);
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(srcDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const rel = path.join(relDir, e.name);
        if (e.isDirectory()) {
          await ensureDir(path.join(dstRoot, rel));
          await walk(rel);
        } else if (e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_state')) {
          const text = await fs.readFile(path.join(srcRoot, rel), 'utf8');
          await fs.writeFile(
            path.join(dstRoot, rel),
            this.prepareMarkdownForExport(text, path.join(dstRoot, rel)),
            'utf8',
          );
        }
      }
    };
    await walk('.');
  }

  private async clearMarkdownFiles(root: string): Promise<void> {
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== '_log.md') {
          await fs.unlink(abs);
        }
      }
    };
    await walk(root);
  }

  private async refreshRootIndex(strategy = this.services?.strategy): Promise<void> {
    if (!strategy) return;
    try {
      const target = path.join(this.outDir, 'index.md');
      const rootIndex = await strategy.readRootIndex();
      const rendered = this.prepareMarkdownForExport(rootIndex, target);
      if (rendered === this.rootIndexCache) return;
      await fs.writeFile(target, rendered, 'utf8');
      this.rootIndexCache = rendered;
    } catch (err) {
      this.errorCount += 1;
      this.logger.warn('root index export failed', { err: String(err) });
    }
  }

  private async writeTextIfChanged(target: string, text: string): Promise<boolean> {
    try {
      if ((await fs.readFile(target, 'utf8')) === text) return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await fs.writeFile(target, text, 'utf8');
    return true;
  }

  private prepareMarkdownForExport(text: string, target: string): string {
    return rewriteRawAssetLinks(stripMetaBlock(text), target, this.services?.dataDir);
  }

}

function stripMetaBlock(text: string): string {
  const start = text.indexOf('<!-- beside:meta');
  if (start === -1) return text;
  const end = text.indexOf('-->', start);
  if (end === -1) return text;
  return (text.slice(0, start) + text.slice(end + '-->'.length)).trim() + '\n';
}

function rewriteRawAssetLinks(text: string, target: string, dataDir?: string): string {
  if (!dataDir) return text;
  const relToData = path.relative(path.dirname(target), dataDir).replace(/\\/g, '/');
  const prefix = relToData ? `${relToData}/` : '';
  return text.replace(/(!\[[^\]]*\]\()raw\//g, `$1${prefix}raw/`);
}

const factory: PluginFactory<IExport> = async (ctx) => {
  const cfg = (ctx.config as MarkdownExportConfig) ?? {};
  const outDir = expandPath(cfg.path ?? path.join(ctx.dataDir, 'export', 'markdown'));
  return new MarkdownExport(outDir, ctx.logger);
};

export default factory;
export { MarkdownExport };
