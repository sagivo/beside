import fs from 'node:fs/promises';
import path from 'node:path';
import type { IndexPage, IndexState } from '@cofounderos/interfaces';
import { ensureDir } from '@cofounderos/core';

const STATE_FILENAME = '_state.json';
const ROOT_INDEX_FILENAME = 'index.md';
const LOG_FILENAME = 'log.md';

interface PersistedState {
  strategy: string;
  lastIncrementalRun: string | null;
  lastReorganisationRun: string | null;
  pageCount: number;
  eventsCovered: number;
}

/**
 * On-disk representation of the index. Pages are stored as markdown with
 * a small JSON metadata block at the top wrapped in HTML comments — this
 * keeps the file fully readable to humans, valid markdown for any tool,
 * and round-trippable by us.
 */
export class PageStore {
  constructor(private readonly root: string, private readonly strategy: string) {}

  async init(): Promise<void> {
    await ensureDir(this.root);
  }

  rootPath(): string {
    return this.root;
  }

  async readState(): Promise<IndexState> {
    const file = path.join(this.root, STATE_FILENAME);
    let persisted: PersistedState;
    try {
      persisted = JSON.parse(await fs.readFile(file, 'utf8')) as PersistedState;
    } catch {
      persisted = {
        strategy: this.strategy,
        lastIncrementalRun: null,
        lastReorganisationRun: null,
        pageCount: 0,
        eventsCovered: 0,
      };
    }
    return {
      ...persisted,
      strategy: this.strategy,
      rootPath: this.root,
    };
  }

  async writeState(state: IndexState): Promise<void> {
    await ensureDir(this.root);
    const persisted: PersistedState = {
      strategy: state.strategy,
      lastIncrementalRun: state.lastIncrementalRun,
      lastReorganisationRun: state.lastReorganisationRun,
      pageCount: state.pageCount,
      eventsCovered: state.eventsCovered,
    };
    await fs.writeFile(
      path.join(this.root, STATE_FILENAME),
      JSON.stringify(persisted, null, 2),
      'utf8',
    );
  }

  async readRootIndex(): Promise<string> {
    try {
      return await fs.readFile(path.join(this.root, ROOT_INDEX_FILENAME), 'utf8');
    } catch {
      return '';
    }
  }

  async writeRootIndex(content: string): Promise<void> {
    await ensureDir(this.root);
    await fs.writeFile(path.join(this.root, ROOT_INDEX_FILENAME), content, 'utf8');
  }

  async appendLog(entry: string): Promise<void> {
    await ensureDir(this.root);
    const file = path.join(this.root, LOG_FILENAME);
    const stamp = new Date().toISOString();
    const block = `\n## ${stamp}\n\n${entry}\n`;
    try {
      await fs.appendFile(file, block, 'utf8');
    } catch {
      await fs.writeFile(file, `# Index log\n${block}`, 'utf8');
    }
  }

  async readPage(pagePath: string): Promise<IndexPage | null> {
    const abs = path.join(this.root, pagePath);
    let text: string;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch {
      return null;
    }
    return parsePage(pagePath, text);
  }

  async writePage(page: IndexPage): Promise<void> {
    const abs = path.join(this.root, page.path);
    await ensureDir(path.dirname(abs));
    await fs.writeFile(abs, serialisePage(page), 'utf8');
  }

  async deletePage(pagePath: string): Promise<void> {
    const abs = path.join(this.root, pagePath);
    try {
      await fs.unlink(abs);
    } catch {
      // ignore
    }
  }

  async listPages(): Promise<IndexPage[]> {
    const out: IndexPage[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (
          e.isFile() &&
          full.endsWith('.md') &&
          path.basename(full) !== ROOT_INDEX_FILENAME &&
          path.basename(full) !== LOG_FILENAME
        ) {
          const rel = path.relative(this.root, full);
          const page = await this.readPage(rel);
          if (page) out.push(page);
        }
      }
    };
    await walk(this.root);
    return out;
  }

  async reset(): Promise<void> {
    try {
      await fs.rm(this.root, { recursive: true, force: true });
    } catch {
      // ignore
    }
    await ensureDir(this.root);
  }
}

const META_OPEN = '<!-- cofounderos:meta';
const META_CLOSE = '-->';

interface PageMeta {
  sourceEventIds: string[];
  backlinks: string[];
  lastUpdated: string;
}

export function parsePage(pagePath: string, text: string): IndexPage {
  const start = text.indexOf(META_OPEN);
  let meta: PageMeta = { sourceEventIds: [], backlinks: [], lastUpdated: new Date().toISOString() };
  let body = text;
  if (start !== -1) {
    const end = text.indexOf(META_CLOSE, start);
    if (end !== -1) {
      const json = text.slice(start + META_OPEN.length, end).trim();
      try {
        meta = { ...meta, ...(JSON.parse(json) as Partial<PageMeta>) };
      } catch {
        // ignore malformed
      }
      body = (text.slice(0, start) + text.slice(end + META_CLOSE.length)).trim();
    }
  }
  return {
    path: pagePath,
    content: body,
    sourceEventIds: meta.sourceEventIds,
    backlinks: meta.backlinks,
    lastUpdated: meta.lastUpdated,
  };
}

export function serialisePage(page: IndexPage): string {
  const meta: PageMeta = {
    sourceEventIds: page.sourceEventIds,
    backlinks: page.backlinks,
    lastUpdated: page.lastUpdated,
  };
  return `${META_OPEN}\n${JSON.stringify(meta, null, 2)}\n${META_CLOSE}\n\n${page.content.trim()}\n`;
}
