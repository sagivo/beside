import * as React from 'react';
import { BarChart3, Clock, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes, formatNumber, localDayKey } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ActivitySession, JournalDay, RuntimeOverview } from '@/global';

const TOP_N = 5;

/**
 * Unified activity card. Replaces the older 3-stat grid + separate
 * AppBreakdown card. Top stats come from the runtime overview (cheap,
 * always available); the per-app bars piggyback on `eventsToday` to
 * trigger a single journal fetch when new captures arrive.
 */
export function ActivityCard({
  overview,
  onGoTimeline,
}: {
  overview: RuntimeOverview;
  onGoTimeline: () => void;
}) {
  const eventsToday = overview.capture.eventsToday;
  const eventsLastHour = overview.capture.eventsLastHour;
  const captureRunning = overview.capture.running;
  const indexing = overview.indexing.running;

  const [journal, setJournal] = React.useState<JournalDay | null>(null);
  const [loadingJournal, setLoadingJournal] = React.useState(true);
  const lastSeenCountRef = React.useRef<number>(-1);

  React.useEffect(() => {
    if (!captureRunning && eventsToday === 0) {
      setLoadingJournal(false);
      setJournal(null);
      return;
    }
    if (eventsToday === lastSeenCountRef.current) return;
    lastSeenCountRef.current = eventsToday;

    let cancelled = false;
    (async () => {
      try {
        const today = localDayKey();
        const j = await window.cofounderos.getJournalDay(today);
        if (!cancelled) setJournal(j);
      } catch {
        if (!cancelled) setJournal(null);
      } finally {
        if (!cancelled) setLoadingJournal(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [captureRunning, eventsToday]);

  const apps = journal ? countByApp(journal.frames) : [];
  const top = apps.slice(0, TOP_N);
  const totalToday = journal?.frames.length ?? eventsToday;
  const activeMinutes = journal ? totalActiveMinutes(journal.sessions) : 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="size-4" />
            Activity
          </CardTitle>
          {activeMinutes > 0 && (
            <Badge variant="muted" className="gap-1.5">
              <Clock className="size-3" />
              {formatDuration(activeMinutes)} active today
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
          <Stat
            label="Today"
            value={formatNumber(eventsToday)}
            sub="moments"
            onClick={onGoTimeline}
          />
          <Stat
            label="Last hour"
            value={
              eventsLastHour !== undefined ? formatNumber(eventsLastHour) : '—'
            }
            sub="moments"
          />
          <Stat
            label="Total"
            value={formatNumber(overview.storage.totalEvents)}
            sub={formatBytes(overview.storage.totalAssetBytes)}
          />
          <Stat
            label="Pages"
            value={formatNumber(overview.index.pageCount)}
            sub={`${formatNumber(overview.index.eventsCovered)} grouped`}
            badge={
              indexing ? (
                <Badge variant="secondary" className="text-[10px]">
                  <Loader2 className="size-3 animate-spin" />
                  Indexing
                </Badge>
              ) : null
            }
          />
        </div>

        {(top.length > 0 || loadingJournal) && (
          <>
            <Separator />
            <div>
              <div className="flex items-center justify-between mb-2.5">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Top apps today
                </h4>
                {journal && totalToday > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {apps.length} app{apps.length === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              {loadingJournal && !journal ? (
                <BarsSkeleton />
              ) : (
                <div className="flex flex-col gap-2.5">
                  {top.map((entry, i) => (
                    <AppRow
                      key={entry.app}
                      app={entry.app}
                      count={entry.count}
                      percent={(entry.count / Math.max(1, totalToday)) * 100}
                      rank={i}
                    />
                  ))}
                  {apps.length > TOP_N && (
                    <div className="text-xs text-muted-foreground pt-1">
                      +{apps.length - TOP_N} more
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  sub,
  badge,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  badge?: React.ReactNode;
  onClick?: () => void;
}) {
  const content = (
    <div className="flex flex-col gap-0.5 text-left">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {label}
        {badge}
      </div>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </div>
      {sub && (
        <div className="text-xs text-muted-foreground truncate">{sub}</div>
      )}
    </div>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="rounded-md -m-1 p-1 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {content}
      </button>
    );
  }
  return content;
}

function BarsSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-2 flex-1 rounded-full" />
          <Skeleton className="h-4 w-10" />
        </div>
      ))}
    </div>
  );
}

function AppRow({
  app,
  count,
  percent,
  rank,
}: {
  app: string;
  count: number;
  percent: number;
  rank: number;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-32 shrink-0 truncate text-sm font-medium" title={app}>
        {app}
      </div>
      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            rank === 0 ? 'bg-primary' : 'bg-primary/60',
          )}
          style={{ width: `${Math.max(2, percent)}%` }}
        />
      </div>
      <div className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {count} <span className="opacity-60">· {percent.toFixed(0)}%</span>
      </div>
    </div>
  );
}

function countByApp(frames: JournalDay['frames']): Array<{ app: string; count: number }> {
  const counts = new Map<string, number>();
  for (const f of frames) {
    const key = f.app || 'Unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([app, count]) => ({ app, count }))
    .sort((a, b) => b.count - a.count);
}

function totalActiveMinutes(sessions: ActivitySession[]): number {
  let ms = 0;
  for (const s of sessions) ms += s.active_ms || 0;
  return Math.round(ms / 60000);
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
