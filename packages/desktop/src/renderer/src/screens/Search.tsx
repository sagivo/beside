import * as React from 'react';
import { Clock, ImageOff, Search as SearchIcon, Sparkles, X } from 'lucide-react';
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
import { formatLocalDateTime } from '@/lib/format';
import { listItemProps, useListKeyboardNav } from '@/lib/list-keys';
import { cacheThumbnail, thumbnailCache } from '@/lib/thumbnail-cache';
import { cn } from '@/lib/utils';
import type { Frame } from '@/global';

const RECENT_KEY = 'cofounderos:recent-searches';
const RECENT_LIMIT = 6;

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
  const [results, setResults] = React.useState<Frame[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [searched, setSearched] = React.useState(false);
  const [knownApps, setKnownApps] = React.useState<string[]>([]);
  const [recent, setRecent] = React.useState<string[]>(() => readRecent());
  const handledSearchRequestRef = React.useRef<number | null>(null);

  useListKeyboardNav();

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const today = days[days.length - 1];
        if (!today) return;
        const j = await window.cofounderos.getJournalDay(today);
        if (cancelled) return;
        setKnownApps(
          Array.from(new Set(j.frames.map((f) => f.app).filter(Boolean) as string[])).sort(),
        );
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days]);

  const runSearch = React.useCallback(async (text?: string) => {
    const q = (text ?? query).trim();
    if (!q) {
      setResults(null);
      setSearched(false);
      return;
    }
    if (text !== undefined) setQuery(text);
    setLoading(true);
    setSearched(true);
    try {
      const found = await window.cofounderos.searchFrames({
        text: q,
        day: dayFilter !== '__all__' ? dayFilter : undefined,
        apps: appFilter !== '__all__' ? [appFilter] : undefined,
        limit: 80,
      });
      setResults(found);
      // Update recent searches: dedupe (case-insensitive) and prepend.
      setRecent((prev) => {
        const lower = q.toLowerCase();
        const next = [q, ...prev.filter((r) => r.toLowerCase() !== lower)].slice(0, RECENT_LIMIT);
        writeRecent(next);
        return next;
      });
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [appFilter, dayFilter, query]);

  React.useEffect(() => {
    if (!searchRequest || handledSearchRequestRef.current === searchRequest.id) return;
    handledSearchRequestRef.current = searchRequest.id;
    void runSearch(searchRequest.query);
  }, [runSearch, searchRequest]);

  function clearRecent() {
    setRecent([]);
    writeRecent([]);
  }

  return (
    <div className="flex flex-col gap-6 pt-6">
      <PageHeader
        title="Search"
        description="Find anything you've worked on across your captured memory."
      />

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3">
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

          <Button onClick={() => void runSearch()} disabled={loading || !query.trim()}>
            <SearchIcon />
            {loading ? 'Searching…' : 'Search'}
          </Button>
          {(results || query) && (
            <Button
              variant="ghost"
              onClick={() => {
                setQuery('');
                setResults(null);
                setSearched(false);
              }}
            >
              Clear
            </Button>
          )}
        </CardContent>
      </Card>

      {searched && (
        <section>
          {results && results.length > 0 ? (
            <>
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">
                {results.length} result{results.length === 1 ? '' : 's'}
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {results.map((frame, i) => (
                  <ResultCard key={i} frame={frame} />
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

function ResultCard({ frame }: { frame: Frame }) {
  const [thumbUrl, setThumbUrl] = React.useState<string | null>(null);
  const detail = useFrameDetail();
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
        const bytes = await window.cofounderos.readAsset(frame.asset_path);
        if (cancelled) return;
        const type = frame.asset_path.endsWith('.png')
          ? 'image/png'
          : frame.asset_path.match(/\.jpe?g$/)
            ? 'image/jpeg'
            : 'image/webp';
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
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
    <button
      type="button"
      onClick={() => detail.open(frame)}
      {...listItemProps}
      className="group rounded-xl border bg-card overflow-hidden text-left transition-all hover:border-primary/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
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
        </div>
        <div className="text-sm line-clamp-2">
          {frame.window_title ||
            frame.url ||
            (frame.text ? String(frame.text).replace(/\s+/g, ' ').slice(0, 140) : '—')}
        </div>
      </div>
    </button>
  );
}
