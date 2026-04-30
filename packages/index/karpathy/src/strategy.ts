import path from 'node:path';
import type {
  IIndexStrategy,
  IModelAdapter,
  IndexPage,
  IndexState,
  IndexUpdate,
  IStorage,
  Logger,
  RawEvent,
  ReorganisationSummary,
} from '@cofounderos/interfaces';
import { isoTimestamp } from '@cofounderos/core';
import { bucketEvent, slugify, type BucketAssignment } from './bucketer.js';
import { PageStore } from './page-store.js';

const STRATEGY_NAME = 'karpathy';

const SYSTEM_PROMPT = `You are the indexer for a personal knowledge wiki called CofounderOS.
Each wiki page summarises one project, contact, meeting, tool, or topic the user spends time on.
You receive the existing page (if any) plus a batch of new raw activity events, and you produce
the new page content. Your output must be markdown only, no preamble.

Rules:
- Keep the page concise and useful. Aim for 80-300 words.
- Always begin with a single H1 line containing the page title (no metadata in the title).
- Use these sections when relevant: Summary, Recent activity, Key context, Related.
- "Recent activity" is a chronological bullet list. Newest first. Each bullet starts with the date.
- "Related" links use [[other/page]] markdown wiki links.
- Preserve existing useful detail unless the new events contradict it.
- Never invent facts the events do not support.`;

const REORG_SYSTEM_PROMPT = `You maintain the structure of a personal knowledge wiki.
Identify structural improvements (merges, splits, archives, summary pages, reclassifications).
Be conservative — only suggest changes when the benefit is clear.
Respond with JSON only, conforming exactly to the schema in the user message.`;

interface StrategyConfig {
  index_path?: string;
  batch_size?: number;
  archive_after_days?: number;
  summary_threshold_pages?: number;
}

export class KarpathyStrategy implements IIndexStrategy {
  readonly name = STRATEGY_NAME;
  readonly description =
    'Self-reorganising hierarchical markdown wiki (Karpathy LLM-wiki pattern).';

  private readonly logger: Logger;
  private readonly batchSize: number;
  private readonly archiveAfterDays: number;
  private readonly summaryThresholdPages: number;
  private store!: PageStore;

  constructor(private readonly config: StrategyConfig, logger: Logger) {
    this.logger = logger.child(`index-${STRATEGY_NAME}`);
    this.batchSize = config.batch_size ?? 50;
    this.archiveAfterDays = config.archive_after_days ?? 30;
    this.summaryThresholdPages = config.summary_threshold_pages ?? 5;
  }

  async init(rootPath: string): Promise<void> {
    this.store = new PageStore(rootPath, STRATEGY_NAME);
    await this.store.init();
  }

  async getUnindexedEvents(storage: IStorage): Promise<RawEvent[]> {
    return await storage.readEvents({
      unindexed_for_strategy: STRATEGY_NAME,
      limit: this.batchSize,
    });
  }

  async indexBatch(
    events: RawEvent[],
    currentIndex: IndexState,
    model: IModelAdapter,
  ): Promise<IndexUpdate> {
    if (events.length === 0) {
      return {
        pagesToCreate: [],
        pagesToUpdate: [],
        pagesToDelete: [],
        newRootIndex: await this.store.readRootIndex(),
        reorganisationNotes: '',
      };
    }

    // Group events by target page.
    const grouped = new Map<string, { assignment: BucketAssignment; events: RawEvent[] }>();
    for (const event of events) {
      const a = bucketEvent(event);
      if (!a) continue;
      const slot = grouped.get(a.path);
      if (slot) slot.events.push(event);
      else grouped.set(a.path, { assignment: a, events: [event] });
    }

    const pagesToCreate: IndexPage[] = [];
    const pagesToUpdate: IndexPage[] = [];

    for (const { assignment, events: bucketEvents } of grouped.values()) {
      const existing = await this.store.readPage(assignment.path);
      const updated = await this.updatePage(existing, assignment, bucketEvents, model);
      if (existing) pagesToUpdate.push(updated);
      else pagesToCreate.push(updated);
    }

    const newPagesByPath = new Map<string, IndexPage>();
    [...pagesToCreate, ...pagesToUpdate].forEach((p) => newPagesByPath.set(p.path, p));
    const allPages = await this.collectAllPagesAfterUpdate(newPagesByPath);
    const newRootIndex = renderRootIndex(allPages, {
      lastIncrementalRun: isoTimestamp(),
      lastReorganisationRun: currentIndex.lastReorganisationRun,
      eventsCovered: currentIndex.eventsCovered + events.length,
    });

    return {
      pagesToCreate,
      pagesToUpdate,
      pagesToDelete: [],
      newRootIndex,
      reorganisationNotes: '',
    };
  }

  async reorganise(currentIndex: IndexState, model: IModelAdapter): Promise<IndexUpdate> {
    const pages = await this.store.listPages();
    if (pages.length === 0) {
      return {
        pagesToCreate: [],
        pagesToUpdate: [],
        pagesToDelete: [],
        newRootIndex: await this.store.readRootIndex(),
        reorganisationNotes: 'No pages yet.',
      };
    }

    const summary: ReorganisationSummary = {
      merged: [],
      split: [],
      archived: [],
      newSummaryPages: [],
      reclassified: [],
      notes: '',
    };

    // 1. Deterministic archive pass — anything untouched for archive_after_days.
    const cutoff = Date.now() - this.archiveAfterDays * 24 * 60 * 60 * 1000;
    const pagesToCreate: IndexPage[] = [];
    const pagesToDelete: string[] = [];
    for (const p of pages) {
      if (p.path.startsWith('archive/')) continue;
      const ts = Date.parse(p.lastUpdated);
      if (Number.isFinite(ts) && ts < cutoff) {
        const archived: IndexPage = {
          ...p,
          path: `archive/${path.basename(p.path)}`,
          lastUpdated: p.lastUpdated,
        };
        pagesToCreate.push(archived);
        pagesToDelete.push(p.path);
        summary.archived.push(p.path);
      }
    }

    // 2. Deterministic summary-of-summaries — for any category with > N pages.
    const byCategory = groupByCategory(
      pages.filter((p) => !pagesToDelete.includes(p.path)),
    );
    for (const [cat, catPages] of byCategory) {
      if (catPages.length <= this.summaryThresholdPages) continue;
      const summaryPath = `${cat}/_summary.md`;
      const summaryPage = renderCategorySummary(cat, catPages);
      pagesToCreate.push(summaryPage);
      summary.newSummaryPages.push(summaryPath);
    }

    // 3. LLM-driven structural suggestions (best effort — silently no-op if
    //    the model returns malformed JSON or is the offline fallback).
    try {
      const suggestion = await askModelForReorg(model, pages);
      if (suggestion?.notes) summary.notes = suggestion.notes;
    } catch (err) {
      this.logger.debug('reorg LLM suggestion failed', { err: String(err) });
    }

    const allPages = await this.collectAllPagesAfterUpdate(
      new Map(pagesToCreate.map((p) => [p.path, p])),
      new Set(pagesToDelete),
    );
    const newRootIndex = renderRootIndex(allPages, {
      lastIncrementalRun: currentIndex.lastIncrementalRun,
      lastReorganisationRun: isoTimestamp(),
      eventsCovered: currentIndex.eventsCovered,
    });

    const notes = renderReorgNotes(summary);

    return {
      pagesToCreate,
      pagesToUpdate: [],
      pagesToDelete,
      newRootIndex,
      reorganisationNotes: notes,
    };
  }

  async applyUpdate(update: IndexUpdate): Promise<IndexState> {
    for (const p of update.pagesToCreate) await this.store.writePage(p);
    for (const p of update.pagesToUpdate) await this.store.writePage(p);
    for (const p of update.pagesToDelete) await this.store.deletePage(p);

    if (update.newRootIndex) await this.store.writeRootIndex(update.newRootIndex);
    if (update.reorganisationNotes) await this.store.appendLog(update.reorganisationNotes);

    const pages = await this.store.listPages();
    const prev = await this.store.readState();
    const eventsCovered = sumEventCoverage(pages);
    const next: IndexState = {
      strategy: STRATEGY_NAME,
      rootPath: this.store.rootPath(),
      pageCount: pages.length,
      eventsCovered,
      lastIncrementalRun: prev.lastIncrementalRun,
      lastReorganisationRun: prev.lastReorganisationRun,
    };
    // Heuristic: any update writes counts as an incremental run; reorg
    // notes mark a reorganisation.
    next.lastIncrementalRun = isoTimestamp();
    if (update.reorganisationNotes) {
      next.lastReorganisationRun = isoTimestamp();
    }
    await this.store.writeState(next);
    return next;
  }

  async getState(): Promise<IndexState> {
    return await this.store.readState();
  }

  async readPage(pagePath: string): Promise<IndexPage | null> {
    return await this.store.readPage(pagePath);
  }

  async readRootIndex(): Promise<string> {
    return await this.store.readRootIndex();
  }

  async reset(): Promise<void> {
    await this.store.reset();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async updatePage(
    existing: IndexPage | null,
    assignment: BucketAssignment,
    events: RawEvent[],
    model: IModelAdapter,
  ): Promise<IndexPage> {
    let content: string;
    // Skip the model entirely when only the offline fallback is wired up —
    // it produces a much nicer page than echoing back our prompt.
    if (model.getModelInfo().name === 'offline:fallback') {
      content = renderFallbackPage(existing, assignment, events);
    } else {
      const userPrompt = buildPagePrompt(existing, assignment, events);
      try {
        content = await model.complete(userPrompt, {
          systemPrompt: SYSTEM_PROMPT,
          temperature: 0.2,
          maxTokens: 800,
        });
      } catch (err) {
        this.logger.warn('model.complete failed, falling back to deterministic page', {
          err: String(err),
        });
        content = renderFallbackPage(existing, assignment, events);
      }
    }

    const sourceEventIds = uniqueStrings([
      ...(existing?.sourceEventIds ?? []),
      ...events.map((e) => e.id),
    ]).slice(-200); // cap so the metadata block doesn't grow without bound

    return {
      path: assignment.path,
      content: content.trim(),
      sourceEventIds,
      backlinks: existing?.backlinks ?? [],
      lastUpdated: isoTimestamp(),
    };
  }

  private async collectAllPagesAfterUpdate(
    upsertedByPath: Map<string, IndexPage>,
    deletedPaths: Set<string> = new Set(),
  ): Promise<IndexPage[]> {
    const onDisk = await this.store.listPages();
    const merged = new Map<string, IndexPage>();
    for (const p of onDisk) {
      if (deletedPaths.has(p.path)) continue;
      merged.set(p.path, p);
    }
    for (const [k, v] of upsertedByPath) merged.set(k, v);
    return [...merged.values()];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPagePrompt(
  existing: IndexPage | null,
  assignment: BucketAssignment,
  events: RawEvent[],
): string {
  const eventLines = events
    .slice()
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map(formatEventLine)
    .join('\n');

  const existingBlock = existing?.content
    ? `EXISTING PAGE (update in place; preserve useful detail):\n\n${existing.content}\n`
    : `EXISTING PAGE: (none — this is a brand-new page)`;

  return `PAGE PATH: ${assignment.path}
PAGE CATEGORY: ${assignment.category}
PAGE TITLE: ${assignment.title}

${existingBlock}

NEW RAW EVENTS (most recent at the bottom):
${eventLines}

Produce the updated full page markdown now.`;
}

function formatEventLine(e: RawEvent): string {
  const meta = [
    e.app,
    e.window_title ? `"${e.window_title}"` : null,
    e.url ? `<${e.url}>` : null,
  ].filter(Boolean).join(' · ');
  const content = e.content ? ` — ${truncate(e.content, 220)}` : '';
  return `- [${e.timestamp}] (${e.type}) ${meta}${content}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function renderFallbackPage(
  existing: IndexPage | null,
  assignment: BucketAssignment,
  events: RawEvent[],
): string {
  const lines: string[] = [];
  lines.push(`# ${assignment.title}`);
  lines.push('');
  lines.push(`*Category: ${assignment.category} · ${events.length} new event(s) ingested.*`);
  lines.push('');

  // Carry over any prior "Summary" section so existing context is preserved.
  const priorSummary = extractSection(existing?.content ?? '', 'Summary');
  if (priorSummary) {
    lines.push('## Summary');
    lines.push(priorSummary);
    lines.push('');
  } else if (!existing) {
    lines.push('## Summary');
    lines.push(`Activity in ${assignment.category}/${assignment.title}.`);
    lines.push('');
  }

  // Recent activity — newest first, capped to 30 entries to keep the page
  // readable. Older entries from the existing page are merged in below.
  lines.push('## Recent activity');
  const newBullets = events
    .slice()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map(formatEventLine);
  const oldBullets = extractListSection(existing?.content ?? '', 'Recent activity');
  const merged = [...newBullets, ...oldBullets].slice(0, 30);
  for (const b of merged) lines.push(b);
  lines.push('');

  // Distinct apps/urls observed — useful "Key context" surface.
  const apps = [...new Set(events.map((e) => e.app).filter(Boolean))];
  const urls = [...new Set(events.map((e) => e.url).filter((u): u is string => Boolean(u)))];
  if (apps.length || urls.length) {
    lines.push('## Key context');
    if (apps.length) lines.push(`- Apps: ${apps.join(', ')}`);
    if (urls.length) {
      lines.push('- URLs:');
      for (const u of urls.slice(0, 5)) lines.push(`  - ${u}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

function extractSection(content: string, heading: string): string | null {
  const re = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|\\Z)`, 'm');
  const m = content.match(re);
  return m && m[1] ? m[1].trim() : null;
}

function extractListSection(content: string, heading: string): string[] {
  const sec = extractSection(content, heading);
  if (!sec) return [];
  return sec.split('\n').filter((l) => l.trimStart().startsWith('- '));
}

function uniqueStrings(arr: string[]): string[] {
  return [...new Set(arr)];
}

function sumEventCoverage(pages: IndexPage[]): number {
  return pages.reduce((acc, p) => acc + p.sourceEventIds.length, 0);
}

function groupByCategory(pages: IndexPage[]): Map<string, IndexPage[]> {
  const map = new Map<string, IndexPage[]>();
  for (const p of pages) {
    const cat = p.path.split('/')[0] ?? 'uncategorised';
    const existing = map.get(cat);
    if (existing) existing.push(p);
    else map.set(cat, [p]);
  }
  return map;
}

interface RootMeta {
  lastIncrementalRun: string | null;
  lastReorganisationRun: string | null;
  eventsCovered: number;
}

function renderRootIndex(pages: IndexPage[], meta: RootMeta): string {
  const byCat = groupByCategory(pages.filter((p) => !p.path.startsWith('archive/')));
  const lines: string[] = [];
  lines.push('# CofounderOS — index');
  lines.push('');
  lines.push(`Last incremental run: ${meta.lastIncrementalRun ?? 'never'}`);
  lines.push(`Last reorganisation: ${meta.lastReorganisationRun ?? 'never'}`);
  lines.push(`Events covered: ${meta.eventsCovered} | Pages: ${pages.length}`);
  lines.push('');

  const categoryOrder = ['projects', 'meetings', 'contacts', 'topics', 'tools', 'patterns'];
  const sortedCategories = [
    ...categoryOrder.filter((c) => byCat.has(c)),
    ...[...byCat.keys()].filter((c) => !categoryOrder.includes(c)),
  ];

  for (const cat of sortedCategories) {
    const catPages = (byCat.get(cat) ?? []).sort(
      (a, b) => Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated),
    );
    if (catPages.length === 0) continue;
    lines.push(`## ${capitalise(cat)} (${catPages.length})`);
    for (const p of catPages.slice(0, 20)) {
      const slug = p.path.replace(/\.md$/, '');
      const title = extractTitle(p.content) ?? slug;
      lines.push(`- [[${slug}]] — ${title}  _(updated ${shortDate(p.lastUpdated)})_`);
    }
    if (catPages.length > 20) {
      lines.push(`- _… and ${catPages.length - 20} more_`);
    }
    lines.push('');
  }

  const archived = pages.filter((p) => p.path.startsWith('archive/'));
  if (archived.length > 0) {
    lines.push(`## Archive (${archived.length})`);
    lines.push('See [[archive/]] for stale pages.');
    lines.push('');
  }
  return lines.join('\n');
}

function renderCategorySummary(category: string, pages: IndexPage[]): IndexPage {
  const lines: string[] = [];
  lines.push(`# ${capitalise(category)} — summary`);
  lines.push(`*Auto-generated from ${pages.length} pages.*`);
  lines.push('');
  for (const p of pages.sort((a, b) => Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated))) {
    const title = extractTitle(p.content) ?? p.path;
    const excerpt = extractExcerpt(p.content);
    lines.push(`### [[${p.path.replace(/\.md$/, '')}]] — ${title}`);
    if (excerpt) lines.push(excerpt);
    lines.push('');
  }
  return {
    path: `${category}/_summary.md`,
    content: lines.join('\n'),
    sourceEventIds: pages.flatMap((p) => p.sourceEventIds).slice(-200),
    backlinks: pages.map((p) => p.path),
    lastUpdated: isoTimestamp(),
  };
}

function extractTitle(content: string): string | null {
  const m = content.match(/^#\s+(.+)$/m);
  return m && m[1] ? m[1].trim() : null;
}

function extractExcerpt(content: string): string | null {
  const stripped = content
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join(' ')
    .trim();
  if (!stripped) return null;
  return truncate(stripped, 240);
}

function shortDate(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderReorgNotes(summary: ReorganisationSummary): string {
  const parts: string[] = [];
  if (summary.archived.length) {
    parts.push(`Archived ${summary.archived.length} stale page(s): ${summary.archived.join(', ')}`);
  }
  if (summary.newSummaryPages.length) {
    parts.push(`Created summary pages: ${summary.newSummaryPages.join(', ')}`);
  }
  if (summary.merged.length) {
    parts.push(`Merged: ${summary.merged.map((m) => `${m.from.join(' + ')} → ${m.into}`).join('; ')}`);
  }
  if (summary.split.length) {
    parts.push(`Split: ${summary.split.map((s) => `${s.from} → ${s.into.join(', ')}`).join('; ')}`);
  }
  if (summary.reclassified.length) {
    parts.push(`Reclassified: ${summary.reclassified.map((r) => `${r.page} → ${r.newCategory}`).join('; ')}`);
  }
  if (summary.notes) parts.push(summary.notes);
  return parts.join('\n\n');
}

interface ReorgSuggestion {
  pages_to_merge?: Array<[string, string, string]>;
  pages_to_split?: Array<[string, string, string]>;
  pages_to_archive?: string[];
  new_summary_pages?: Array<[string, string]>;
  reclassifications?: Array<[string, string]>;
  notes?: string;
}

async function askModelForReorg(
  model: IModelAdapter,
  pages: IndexPage[],
): Promise<ReorgSuggestion | null> {
  const list = pages
    .map((p) => {
      const wc = p.content.split(/\s+/).length;
      return `- ${p.path} (${wc}w, last ${p.lastUpdated.slice(0, 10)})`;
    })
    .join('\n');

  const prompt = `CURRENT PAGE LIST:
${list}

Return JSON exactly matching this shape:
{
  "pages_to_merge": [["page_a", "page_b", "merged_title"], ...],
  "pages_to_split": [["page", "subtopic_1", "subtopic_2"], ...],
  "pages_to_archive": ["page", ...],
  "new_summary_pages": [["category", "title"], ...],
  "reclassifications": [["page", "new_category"], ...],
  "notes": "human-readable explanation"
}
Be conservative.`;

  const raw = await model.complete(prompt, {
    systemPrompt: REORG_SYSTEM_PROMPT,
    responseFormat: 'json',
    temperature: 0.1,
    maxTokens: 1024,
  });
  try {
    return JSON.parse(raw) as ReorgSuggestion;
  } catch {
    return null;
  }
}

export { slugify };
