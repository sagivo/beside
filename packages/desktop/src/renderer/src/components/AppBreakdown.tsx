import * as React from 'react';
import { BarChart3, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { localDayKey } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ActivitySession, JournalDay, RuntimeOverview } from '@/global';

const TOP_N = 5;

/**
 * Today-in-numbers card. Shows top apps as horizontal bars and aggregate
 * active time from work sessions. Refreshes when `eventsToday` changes
 * via the same piggyback strategy as `LiveCaptureStrip` so the dashboard
 * has at most one "today's frames" fetch in flight at a time.
 */
export function AppBreakdown({ overview }: { overview: RuntimeOverview }) {
  const eventsToday = overview.capture.eventsToday;
  const captureRunning = overview.capture.running;
  const [journal, setJournal] = React.useState<JournalDay | null>(null);
  const [loading, setLoading] = React.useState(true);
  const lastSeenCountRef = React.useRef<number>(-1);

  React.useEffect(() => {
    if (!captureRunning && eventsToday === 0) {
      setLoading(false);
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
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [captureRunning, eventsToday]);

  if (loading && !journal) return <SkeletonCard />;
  if (!journal || journal.frames.length === 0) return null;

  const apps = countByApp(journal.frames);
  const total = journal.frames.length;
  const top = apps.slice(0, TOP_N);
  const activeMinutes = totalActiveMinutes(journal.sessions);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="size-4" />
              Today's activity
            </CardTitle>
            <CardDescription>
              {total} moments across {apps.length} app{apps.length === 1 ? '' : 's'}
            </CardDescription>
          </div>
          {activeMinutes > 0 && (
            <Badge variant="muted" className="gap-1.5">
              <Clock className="size-3" />
              {formatDuration(activeMinutes)} active
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2.5">
          {top.map((entry, i) => (
            <AppRow
              key={entry.app}
              app={entry.app}
              count={entry.count}
              percent={(entry.count / total) * 100}
              rank={i}
            />
          ))}
          {apps.length > TOP_N && (
            <div className="text-xs text-muted-foreground pt-1">
              +{apps.length - TOP_N} more
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SkeletonCard() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-44 mt-2" />
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-2 flex-1 rounded-full" />
            <Skeleton className="h-4 w-10" />
          </div>
        ))}
      </CardContent>
    </Card>
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
