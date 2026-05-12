import * as React from 'react';
import {
  CalendarDays,
  Clock,
  ExternalLink,
  Globe2,
  ImageOff,
  Layers3,
  Mic,
  Search as SearchIcon,
  Sparkles,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PageHeader } from '@/components/PageHeader';
import { useFrameDetail } from '@/components/FrameDetailDialog';
import { formatLocalDateTime, prettyDay } from '@/lib/format';
import { listItemProps, useListKeyboardNav } from '@/lib/list-keys';
import { buildFrameSearchContext } from '@/lib/search-context';
import { cacheThumbnail, resolveAssetUrl, thumbnailCache } from '@/lib/thumbnail-cache';
import { domainFromUrl, isHttpUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import type { Frame } from '@/global';

const RECENT_KEY = 'cofounderos:recent-searches';
const RECENT_LIMIT = 6;
const EXPLANATION_LIMIT = 8;
const EXPLANATION_CONCURRENCY = 1;
const KNOWN_APPS_SAMPLE_LIMIT = 500;
const KNOWN_APPS_DAY_SAMPLE = 7;

const SUGGESTIONS: string[] = [
  'design doc',
  'github pull request',
  'slack message',
  'meeting notes',
  'pricing',
  'roadmap',
];

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

function writeRecent(items: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, RECENT_LIMIT)));
  } catch {
    /* ignore */
  }
}

export function Search({
  days,
  searchRequest,
}: {
  days: string[];
  searchRequest?: { id: number; query: string } | null;
}) {
  const [query, setQuery] = React.useState('');
  const [appFilter, setAppFilter] = React.useState<string>('__all__');
  const [dayFilter, setDayFilter] = React.useState<string>('__all__');
  const [domainFilter, setDomainFilter] = React.useState<string>('__all__');
  const [textSourceFilter, setTextSourceFilter] = React.useState<string>('__all__');
  const [results, setResults] = React.useState<Frame[] | null>(null);
  const [activeSearchQuery, setActiveSearchQuery] = React.useState('');
  const [explanations, setExplanations] = React.useState<Record<string, string>>({});
  const [loading, setLoading] = React.useState(false);
  const [searched, setSearched] = React.useState(false);
  const [knownApps, setKnownApps] = React.useState<string[]>([]);
  const [knownDomains, setKnownDomains] = React.useState<string[]>([]);
  const [recent, setRecent] = React.useState<string[]>(() => readRecent());
  const handledSearchRequestRef = React.useRef<number | null>(null);
  const searchRunRef = React.useRef(0);
  const lastSearchFilterKeyRef = React.useRef('');

  useListKeyboardNav();

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sampleDays = days.slice(-KNOWN_APPS_DAY_SAMPLE).reverse();
        if (sampleDays.length === 0) return;
        const perDayLimit = Math.max(
          80,
          Math.ceil(KNOWN_APPS_SAMPLE_LIMIT / sampleDays.length),
        );
        const framesByDay = await Promise.all(
          sampleDays.map((day) =>
            window.cofounderos
              .searchFrames({ day, limit: perDayLimit })
              .catch(() => [] as Frame[]),
          ),
        );
        const frames = framesByDay.flat().slice(0, KNOWN_APPS_SAMPLE_LIMIT);
        if (cancelled) return;
        setKnownApps(
          Array.from(new Set(frames.map((f) => f.app).filter(Boolean) as string[])).sort(),
        );
        setKnownDomains(
          Array.from(
            new Set(
              frames
                .map((f) => domainFromUrl(f.url))
                .filter((v): v is string => Boolean(v)),
            ),
          ).sort(),
        );
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days]);

  const currentFilterKey = React.useMemo(
    () => JSON.stringify([dayFilter, appFilter, domainFilter, textSourceFilter]),
    [appFilter, dayFilter, domainFilter, textSourceFilter],
  );

  const runSearch = React.useCallback(async (text?: string, syncQuery = text !== undefined) => {
    const q = (text ?? query).trim();
    if (!q) {
      searchRunRef.current += 1;
      lastSearchFilterKeyRef.current = '';
      setResults(null);
      setActiveSearchQuery('');
      setExplanations({});
      setSearched(false);
      return;
    }
    const runId = searchRunRef.current + 1;
    searchRunRef.current = runId;
    if (text !== undefined && syncQuery) setQuery(text);
    setLoading(true);
    setExplanations({});
    setActiveSearchQuery(q);
    setSearched(true);
    lastSearchFilterKeyRef.current = currentFilterKey;
    try {
      const found = await window.cofounderos.searchFrames({
        text: q,
        day: dayFilter !== '__all__' ? dayFilter : undefined,
        apps: appFilter !== '__all__' ? [appFilter] : undefined,
        urlDomain: domainFilter !== '__all__' ? domainFilter : undefined,
        textSource: textSourceFilter !== '__all__' ? textSourceFilter : undefined,
        limit: 80,
      });
      if (searchRunRef.current !== runId) return;
      setResults(found);
      const framesToExplain = found.slice(0, EXPLANATION_LIMIT);
      if (framesToExplain.length > 0) {
        void (async () => {
          let nextIndex = 0;
          const explainNext = async (): Promise<void> => {
            while (searchRunRef.current === runId && nextIndex < framesToExplain.length) {
              const frame = framesToExplain[nextIndex];
              nextIndex += 1;
              try {
                const explained = await window.cofounderos.explainSearchResults({
                  text: q,
                  frames: [frame],
                });
                const item = explained[0];
                if (searchRunRef.current !== runId || !item) continue;
                setExplanations((prev) => ({
                  ...prev,
                  [item.frameId]: item.explanation,
                }));
              } catch {
                /* Keep the result visible even if one explanation fails. */
              }
            }
          };

          try {
            await Promise.all(
              Array.from(
                { length: Math.min(EXPLANATION_CONCURRENCY, framesToExplain.length) },
                () => explainNext(),
              ),
            );
          } catch {
            if (searchRunRef.current === runId) setExplanations({});
          }
        })();
      }
      // Update recent searches: dedupe (case-insensitive) and prepend.
      setRecent((prev) => {
        const lower = q.toLowerCase();
        const next = [q, ...prev.filter((r) => r.toLowerCase() !== lower)].slice(0, RECENT_LIMIT);
        writeRecent(next);
        return next;
      });
    } catch {
      if (searchRunRef.current !== runId) return;
      setResults([]);
    } finally {
      if (searchRunRef.current === runId) setLoading(false);
    }
  }, [appFilter, currentFilterKey, dayFilter, domainFilter, query, textSourceFilter]);

  React.useEffect(() => {
    if (!searchRequest || handledSearchRequestRef.current === searchRequest.id) return;
    handledSearchRequestRef.current = searchRequest.id;
    void runSearch(searchRequest.query);
  }, [runSearch, searchRequest]);

  React.useEffect(() => {
    if (!searched || !activeSearchQuery) return;
    if (lastSearchFilterKeyRef.current === currentFilterKey) return;
    void runSearch(activeSearchQuery, false);
  }, [activeSearchQuery, currentFilterKey, runSearch, searched]);

  function clearRecent() {
    setRecent([]);
    writeRecent([]);
  }

  const resultGroups = React.useMemo(
    () => (results ? groupResultsByDay(results) : []),
    [results],
  );
  const activeFilters = [
    dayFilter !== '__all__' ? dayFilter : null,
    appFilter !== '__all__' ? appFilter : null,
    domainFilter !== '__all__' ? domainFilter : null,
    textSourceFilter !== '__all__' ? textSourceLabel(textSourceFilter) : null,
  ].filter((v): v is string => Boolean(v));

  return (
    <div className="flex flex-col gap-6 pt-6">
      <PageHeader
        title="Search"
        description="Find anything you've worked on across your captured memory."
      />

      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[280px]">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              autoFocus
              placeholder="What were you working on…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runSearch();
              }}
              className="pl-9"
            />
            </div>

            <Button onClick={() => void runSearch()} disabled={loading || !query.trim()}>
              <SearchIcon />
              {loading ? 'Searching…' : 'Search'}
            </Button>
            {(results || query || activeFilters.length > 0) && (
              <Button
                variant="ghost"
                onClick={() => {
                  searchRunRef.current += 1;
                  lastSearchFilterKeyRef.current = '';
                  setQuery('');
                  setResults(null);
                  setActiveSearchQuery('');
                  setExplanations({});
                  setSearched(false);
                  setAppFilter('__all__');
                  setDayFilter('__all__');
                  setDomainFilter('__all__');
                  setTextSourceFilter('__all__');
                }}
              >
                Clear
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
          <Select value={dayFilter} onValueChange={setDayFilter}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Any day" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Any day</SelectItem>
              {days
                .slice()
                .reverse()
                .slice(0, 30)
                .map((day) => (
                  <SelectItem key={day} value={day}>
                    {day}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>

          {knownApps.length > 0 && (
            <Select value={appFilter} onValueChange={setAppFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Any app" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Any app</SelectItem>
                {knownApps.map((app) => (
                  <SelectItem key={app} value={app}>
                    {app}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {knownDomains.length > 0 && (
            <Select value={domainFilter} onValueChange={setDomainFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Any website" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Any website</SelectItem>
                {knownDomains.map((domain) => (
                  <SelectItem key={domain} value={domain}>
                    {domain}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select value={textSourceFilter} onValueChange={setTextSourceFilter}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Any source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Any source</SelectItem>
              <SelectItem value="ocr">Screen text</SelectItem>
              <SelectItem value="accessibility">App text</SelectItem>
              <SelectItem value="ocr_accessibility">Screen + app</SelectItem>
              <SelectItem value="audio">Audio</SelectItem>
            </SelectContent>
          </Select>

          {activeFilters.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {activeFilters.map((filter) => (
                <Badge key={filter} variant="muted">
                  {filter}
                </Badge>
              ))}
            </div>
          )}
          </div>
        </CardContent>
      </Card>

      {searched && (
        <section>
          {results && results.length > 0 ? (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                  {results.length} result{results.length === 1 ? '' : 's'}
                </h3>
                <span className="text-xs text-muted-foreground">
                  Grouped by captured day
                </span>
              </div>
              <div className="flex flex-col gap-5">
                {resultGroups.map((group) => (
                  <section key={group.day} className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <CalendarDays className="size-3.5" />
                      <span>{group.label}</span>
                      <span className="font-normal normal-case tracking-normal">
                        {group.frames.length} result{group.frames.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {group.frames.map((frame) => (
                        <ResultCard
                          key={frame.id ?? `${frame.timestamp}-${frame.app}-${frame.url}`}
                          frame={frame}
                          searchQuery={activeSearchQuery}
                          explanation={frame.id ? explanations[frame.id] : undefined}
                          onDeleted={(deleted) =>
                            setResults((prev) =>
                              prev ? prev.filter((f) => f.id !== deleted.id) : prev,
                            )
                          }
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center text-center py-12">
                <Sparkles className="size-8 text-muted-foreground/60 mb-3" />
                <h4 className="font-medium">No matches</h4>
                <p className="text-sm text-muted-foreground mt-1 max-w-md">
                  Try a different word, broaden your filters, or check that capture has been
                  running long enough to gather context.
                </p>
              </CardContent>
            </Card>
          )}
        </section>
      )}

      {!searched && (
        <Card>
          <CardContent className="flex flex-col gap-6 py-10">
            <div className="flex flex-col items-center text-center gap-2">
              <SearchIcon className="size-8 text-muted-foreground/60" />
              <h4 className="font-medium">Ask your memory anything</h4>
              <p className="text-sm text-muted-foreground max-w-md">
                Type a keyword from a doc, an app name, or anything you saw on screen. We'll
                search everything you've captured.
              </p>
            </div>

            {recent.length > 0 && (
              <ChipSection
                icon={<Clock className="size-3.5" />}
                label="Recent"
                items={recent}
                onPick={(v) => void runSearch(v)}
                onClear={clearRecent}
                clearLabel="Clear history"
              />
            )}

            <ChipSection
              icon={<Sparkles className="size-3.5" />}
              label="Try"
              items={SUGGESTIONS}
              onPick={(v) => void runSearch(v)}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ChipSection({
  icon,
  label,
  items,
  onPick,
  onClear,
  clearLabel,
}: {
  icon: React.ReactNode;
  label: string;
  items: string[];
  onPick: (value: string) => void;
  onClear?: () => void;
  clearLabel?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
          {icon}
          <span>{label}</span>
        </div>
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            className="flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-foreground transition-colors"
          >
            <X className="size-3" />
            {clearLabel || 'Clear'}
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => onPick(item)}
            className={cn(
              'rounded-full border bg-background px-3 py-1 text-xs font-medium transition-colors',
              'hover:bg-accent hover:border-primary/40 hover:text-accent-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            )}
          >
            {item}
          </button>
        ))}
      </div>
    </div>
  );
}

function ResultCard({
  frame,
  searchQuery,
  explanation,
  onDeleted,
}: {
  frame: Frame;
  searchQuery: string;
  explanation?: string;
  onDeleted?: (frame: Frame) => void;
}) {
  const [thumbUrl, setThumbUrl] = React.useState<string | null>(null);
  const detail = useFrameDetail();
  const context = explanation ?? buildFrameSearchContext(searchQuery, frame);
  const domain = domainFromUrl(frame.url);
  const source = textSourceLabel(frame.text_source);
  const openMemory = React.useCallback(() => {
    detail.open(frame, {
      onDeleted: onDeleted ? (deleted) => onDeleted(deleted) : undefined,
      searchContext: searchQuery
        ? {
            query: searchQuery,
            explanation,
          }
        : undefined,
    });
  }, [detail, explanation, frame, onDeleted, searchQuery]);
  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!frame.asset_path) return;
      const cached = thumbnailCache.get(frame.asset_path);
      if (cached) {
        setThumbUrl(cached);
        return;
      }
      try {
        const url = await resolveAssetUrl(frame.asset_path);
        if (cancelled) return;
        cacheThumbnail(frame.asset_path, url);
        setThumbUrl(url);
      } catch {
        /* ignore */
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [frame.asset_path]);

  return (
    <div
      className="group rounded-xl border bg-card overflow-hidden text-left transition-all hover:border-primary/40 hover:shadow-sm"
    >
      <div className="aspect-video w-full bg-muted/40 grid place-items-center overflow-hidden">
        {thumbUrl ? (
          <img
            className="w-full h-full object-cover transition-transform group-hover:scale-[1.02]"
            src={thumbUrl}
            alt=""
          />
        ) : (
          <div className="flex flex-col items-center gap-1 text-muted-foreground">
            <ImageOff className="size-6" />
            <span className="text-xs">No screenshot</span>
          </div>
        )}
      </div>
      <div className="p-3 flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">
            {formatLocalDateTime(frame.timestamp)}
          </span>
          <Badge variant="muted">{frame.app || 'Unknown app'}</Badge>
          {source && <Badge variant="outline">{source}</Badge>}
        </div>
        <div className="text-sm line-clamp-2">
          {frame.window_title ||
            frame.url ||
            (frame.text ? String(frame.text).replace(/\s+/g, ' ').slice(0, 140) : '—')}
        </div>
        {context && (
          <div className="mt-1 flex items-start gap-1.5 rounded-lg bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
            <Sparkles className="mt-0.5 size-3 shrink-0" />
            <span className="line-clamp-3">
              {context}
            </span>
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {domain && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <Globe2 className="size-3" />
              <span className="truncate">{domain}</span>
            </span>
          )}
          {frame.entity_path && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <Layers3 className="size-3" />
              <span className="truncate">{frame.entity_path}</span>
            </span>
          )}
          {frame.text_source === 'audio' && (
            <span className="inline-flex items-center gap-1">
              <Mic className="size-3" />
              transcript
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={openMemory}
            {...listItemProps}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <SearchIcon className="size-3" />
            Open memory
          </button>
          {isHttpUrl(frame.url) && (
            <button
              type="button"
              onClick={() => void window.cofounderos.openExternalUrl(frame.url!)}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <ExternalLink className="size-3" />
              Open source
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function groupResultsByDay(frames: Frame[]): Array<{ day: string; label: string; frames: Frame[] }> {
  const groups = new Map<string, Frame[]>();
  for (const frame of frames) {
    const day = frame.day || frame.timestamp?.slice(0, 10) || 'unknown';
    const existing = groups.get(day) ?? [];
    existing.push(frame);
    groups.set(day, existing);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, groupFrames]) => ({
      day,
      label: dayLabel(day),
      frames: groupFrames,
    }));
}

function dayLabel(day: string): string {
  if (day === 'unknown') return 'Unknown day';
  return prettyDay(day);
}

function textSourceLabel(source?: string | null): string | null {
  switch (source) {
    case 'ocr':
      return 'Screen text';
    case 'accessibility':
      return 'App text';
    case 'ocr_accessibility':
      return 'Screen + app';
    case 'audio':
      return 'Audio';
    default:
      return null;
  }
}
