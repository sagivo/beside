import fs from 'node:fs/promises';
import path from 'node:path';
import type { IndexPage, IndexState } from '@beside/interfaces';
import { ensureDir } from '@beside/core';

const STATE_FILENAME = '_state.json';
const ROOT_INDEX_FILENAME = 'index.md';
const LOG_FILENAME = 'log.md';
const MANIFEST_FILENAME = '_manifest.json';
const LOG_MAX_SIZE_BYTES = 1024 * 1024; // rotate at 1 MB

interface PersistedState {
  strategy: string;
  lastIncrementalRun: string | null;
  lastReorganisationRun: string | null;
  pageCount: number;
  eventsCovered: number;
}

interface PageManifestEntry {
  path: string;
  title: string;
  summary: string | null;
  lastUpdated: string;
}

interface PageManifest {
  version: 1;
  generatedAt: string;
  pages: PageManifestEntry[];
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
    await this.writeTextIfChanged(
      path.join(this.root, STATE_FILENAME),
      JSON.stringify(persisted, null, 2),
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
    await this.writeTextIfChanged(path.join(this.root, ROOT_INDEX_FILENAME), content);
  }

  async appendLog(entry: string): Promise<void> {
    await ensureDir(this.root);
    const file = path.join(this.root, LOG_FILENAME);
    try {
      const { size } = await fs.stat(file);
      if (size >= LOG_MAX_SIZE_BYTES) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archive = path.join(this.root, `log.${stamp}.md`);
        await fs.rename(file, archive);
      }
    } catch {
      // file doesn't exist yet — nothing to rotate
    }
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
    await this.applyPageChanges([page], []);
  }

  async deletePage(pagePath: string): Promise<void> {
    await this.applyPageChanges([], [pagePath]);
  }

  async applyPageChanges(upserts: IndexPage[], deletes: string[]): Promise<void> {
    if (upserts.length === 0 && deletes.length === 0) return;

    for (const page of upserts) {
      const abs = path.join(this.root, page.path);
      await ensureDir(path.dirname(abs));
      await this.writeTextIfChanged(abs, serialisePage(page));
    }

    for (const pagePath of deletes) {
      try {
        await fs.unlink(path.join(this.root, pagePath));
      } catch {
        // ignore
      }
    }

    await this.updateManifestEntries(upserts, deletes);
  }

  async listPages(): Promise<IndexPage[]> {
    const manifest = await this.readManifest();
    if (manifest) {
      const pages = await Promise.all(manifest.pages.map((entry) => this.readPage(entry.path)));
      return pages.filter((page): page is IndexPage => page != null);
    }

    const pages = await this.walkPages();
    await this.writeManifestFromPages(pages);
    return pages;
  }

  async reset(): Promise<void> {
    try {
      await fs.rm(this.root, { recursive: true, force: true });
    } catch {
      // ignore
    }
    await ensureDir(this.root);
  }

  private async walkPages(): Promise<IndexPage[]> {
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
          const rel = path.relative(this.root, full).replace(/\\/g, '/');
          const page = await this.readPage(rel);
          if (page) out.push(page);
        }
      }
    };
    await walk(this.root);
    return out;
  }

  private async readManifest(): Promise<PageManifest | null> {
    try {
      const raw = await fs.readFile(path.join(this.root, MANIFEST_FILENAME), 'utf8');
      const parsed = JSON.parse(raw) as PageManifest;
      if (parsed.version !== 1 || !Array.isArray(parsed.pages)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeManifest(manifest: PageManifest): Promise<void> {
    await ensureDir(this.root);
    await this.writeTextIfChanged(
      path.join(this.root, MANIFEST_FILENAME),
      JSON.stringify(manifest, null, 2),
    );
  }

  private async writeManifestFromPages(pages: IndexPage[]): Promise<void> {
    await this.writeManifest({
      version: 1,
      generatedAt: new Date().toISOString(),
      pages: pages.map((page) => pageToManifestEntry(page)).sort((a, b) => a.path.localeCompare(b.path)),
    });
  }

  private async updateManifestEntries(
    upserts: IndexPage[],
    deletes: string[],
  ): Promise<void> {
    const manifest = await this.readManifest();
    if (!manifest) {
      await this.writeManifestFromPages(await this.walkPages());
      return;
    }
    const pages = new Map((manifest?.pages ?? []).map((entry) => [entry.path, entry]));
    for (const page of upserts) pages.set(page.path, pageToManifestEntry(page));
    for (const pagePath of deletes) pages.delete(pagePath);
    const nextPages = [...pages.values()].sort((a, b) => a.path.localeCompare(b.path));
    if (manifestEntriesEqual(manifest.pages, nextPages)) return;
    await this.writeManifest({
      version: 1,
      generatedAt: new Date().toISOString(),
      pages: nextPages,
    });
  }

  private async writeTextIfChanged(abs: string, text: string): Promise<void> {
    try {
      if ((await fs.readFile(abs, 'utf8')) === text) return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await fs.writeFile(abs, text, 'utf8');
  }
}

const META_OPEN = '<!-- beside:meta';
const META_CLOSE = '-->';

interface PageMeta {
  sourceEventIds: string[];
  backlinks: string[];
  lastUpdated: string;
  /**
   * Optional content-addressed digest of the evidence buffer the page
   * was rendered from. Persisted in the markdown frontmatter so a
   * subsequent reindex can detect "evidence unchanged → skip the LLM
   * call" across process restarts. Pages written by older versions
   * lack this and will be re-rendered once.
   */
  evidenceHash?: string;
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
    evidenceHash: meta.evidenceHash,
  };
}

export function serialisePage(page: IndexPage): string {
  const meta: PageMeta = {
    sourceEventIds: page.sourceEventIds,
    backlinks: page.backlinks,
    lastUpdated: page.lastUpdated,
    ...(page.evidenceHash ? { evidenceHash: page.evidenceHash } : {}),
  };
  return `${META_OPEN}\n${JSON.stringify(meta, null, 2)}\n${META_CLOSE}\n\n${page.content.trim()}\n`;
}

function pageToManifestEntry(page: IndexPage): PageManifestEntry {
  return {
    path: page.path,
    title: extractMarkdownTitle(page.content) ?? path.basename(page.path, '.md'),
    summary: extractMarkdownSummary(page.content),
    lastUpdated: page.lastUpdated,
  };
}

function manifestEntriesEqual(a: PageManifestEntry[], b: PageManifestEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.path !== right.path ||
      left.title !== right.title ||
      left.summary !== right.summary ||
      left.lastUpdated !== right.lastUpdated
    ) {
      return false;
    }
  }
  return true;
}

function extractMarkdownTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || null;
}

function extractMarkdownSummary(content: string): string | null {
  const section = extractMarkdownSection(content, 'Summary') ?? extractMarkdownSection(content, 'Overview');
  const cleaned = stripMarkdownForPreview(section ?? '').trim();
  return cleaned ? truncateText(cleaned, 180) : null;
}

function extractMarkdownSection(content: string, heading: string): string | null {
  const lines = content.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##\s+/.test(line.trim())) break;
    body.push(line);
  }
  return body.join('\n');
}

function stripMarkdownForPreview(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_\-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function truncateText(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}
