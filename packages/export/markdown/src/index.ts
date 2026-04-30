import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  IExport,
  ExportStatus,
  IndexPage,
  IndexState,
  IIndexStrategy,
  ReorganisationSummary,
  PluginFactory,
  Logger,
} from '@cofounderos/interfaces';
import { ensureDir, expandPath } from '@cofounderos/core';

interface MarkdownExportConfig {
  path?: string;
  enabled?: boolean;
}

class MarkdownExport implements IExport {
  readonly name = 'markdown';

  private readonly logger: Logger;
  private readonly outDir: string;
  private running = false;
  private lastSync: string | null = null;
  private pendingUpdates = 0;
  private errorCount = 0;

  constructor(outDir: string, logger: Logger) {
    this.outDir = outDir;
    this.logger = logger.child('export-markdown');
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
      await fs.writeFile(target, `${page.content.trim()}\n`, 'utf8');
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
    // Mirror entire tree from the source of truth.
    // Pages first.
    // Source pages live under strategy's root; we re-fetch via strategy
    // because that is the public read interface.
    // The strategy doesn't expose `listPages` directly — we discover from
    // the IndexState's rootPath instead.
    const rootIndex = await strategy.readRootIndex();
    await ensureDir(this.outDir);
    await fs.writeFile(path.join(this.outDir, 'index.md'), rootIndex, 'utf8');

    await this.copyTree(_state.rootPath, this.outDir);
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
          const cleaned = stripMetaBlock(text);
          await fs.writeFile(path.join(dstRoot, rel), cleaned, 'utf8');
        }
      }
    };
    await walk('.');
  }
}

function stripMetaBlock(text: string): string {
  const start = text.indexOf('<!-- cofounderos:meta');
  if (start === -1) return text;
  const end = text.indexOf('-->', start);
  if (end === -1) return text;
  return (text.slice(0, start) + text.slice(end + '-->'.length)).trim() + '\n';
}

const factory: PluginFactory<IExport> = async (ctx) => {
  const cfg = (ctx.config as MarkdownExportConfig) ?? {};
  const outDir = expandPath(cfg.path ?? path.join(ctx.dataDir, 'export', 'markdown'));
  return new MarkdownExport(outDir, ctx.logger);
};

export default factory;
export { MarkdownExport };
