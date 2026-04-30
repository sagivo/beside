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
} from '@cofounderos/interfaces';
import { renderJournalMarkdown } from '@cofounderos/interfaces';
import { ensureDir, expandPath, dayKey } from '@cofounderos/core';

interface MarkdownExportConfig {
  path?: string;
  enabled?: boolean;
}

export interface MarkdownExportServices {
  storage: IStorage;
  /**
   * Absolute path to the data dir (where the `raw/` screenshot tree lives).
   * Used to compute relative `![](…)` paths in the journal so the markdown
   * tree is portable when copied to e.g. an Obsidian vault.
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
  private journalsRendered = new Set<string>();

  constructor(outDir: string, logger: Logger) {
    this.outDir = outDir;
    this.logger = logger.child('export-markdown');
  }

  /**
   * Called by the orchestrator after instantiation to inject storage so
   * the export can render the daily journal alongside strategy pages.
   * Optional — pre-frames installs that don't bind services still get
   * wiki-page mirroring as before.
   */
  bindServices(services: ExportServices | MarkdownExportServices): void {
    this.services = {
      storage: services.storage,
      dataDir: services.dataDir,
    };
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
      await fs.writeFile(target, `${stripMetaBlock(page.content)}`, 'utf8');
      this.lastSync = new Date().toISOString();
      // Refresh today's journal opportunistically so it stays in lockstep
      // with the wiki. Cheap: a single SQL scan + one write.
      await this.maybeRenderJournal(dayKey());
    } catch (err) {
      this.errorCount += 1;
      this.logger.error('export write failed', { err: String(err), page: page.path });
    } finally {
      this.pendingUpdates = Math.max(0, this.pendingUpdates - 1);
    }
  }

  /**
   * Render `journal/<day>.md` from the frames table. Idempotent — safe
   * to call as often as you like; we coalesce by debouncing on the day
   * key when called from `onPageUpdate`.
   */
  async renderJournal(day: string): Promise<void> {
    if (!this.services) return;
    const frames = await this.services.storage.getJournal(day);
    const target = path.join(this.outDir, 'journal', `${day}.md`);
    await ensureDir(path.dirname(target));
    // Compute a relative prefix so screenshot links work when this tree
    // is copied to an Obsidian vault: from <export>/journal/<day>.md back
    // to <data_dir>/raw/... The data dir hosts `raw/` directly.
    const relToData = path.relative(
      path.dirname(target),
      this.services.dataDir,
    );
    const prefix = relToData ? `${relToData.replace(/\\/g, '/')}/` : '';
    const md = renderJournalMarkdown(day, frames, prefix);
    await fs.writeFile(target, md, 'utf8');
    this.journalsRendered.add(day);
  }

  private async maybeRenderJournal(day: string): Promise<void> {
    if (!this.services) return;
    try {
      await this.renderJournal(day);
    } catch (err) {
      this.errorCount += 1;
      this.logger.warn('journal render failed', {
        err: String(err),
        day,
      });
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
    const rootIndex = await strategy.readRootIndex();
    await ensureDir(this.outDir);
    await fs.writeFile(path.join(this.outDir, 'index.md'), rootIndex, 'utf8');

    await this.copyTree(_state.rootPath, this.outDir);

    // Re-render every day's journal we have data for.
    if (this.services) {
      const days = await this.services.storage.listDays();
      for (const d of days) {
        await this.maybeRenderJournal(d);
      }
    }

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
