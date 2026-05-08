import * as React from 'react';
import {
  AlertCircle,
  ChevronDown,
  CircleStop,
  ExternalLink,
  FolderOpen,
  ImageOff,
  Loader2,
  Mic,
  Pause,
  Play,
  Radio,
  RefreshCcw,
  Sparkles,
  Wand2,
  XCircle,
  Zap,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { useFrameDetail } from '@/components/FrameDetailDialog';
import { PageHeader } from '@/components/PageHeader';
import {
  bootstrapMessage,
  formatBytes,
  formatLocalDateTime,
  formatLocalTime,
  formatNumber,
  indexingStatusText,
  localDayKey,
} from '@/lib/format';
import {
  cacheThumbnail,
  resolveAssetUrl,
  thumbnailCache,
} from '@/lib/thumbnail-cache';
import { cn } from '@/lib/utils';
import type {
  ActivitySession,
  DoctorCheck,
  Frame,
  JournalDay,
  ModelBootstrapProgress,
  RuntimeOverview,
} from '@/global';

const FULL_JOURNAL_FRAME_LIMIT = 600;
const ACTIVITY_SAMPLE_LIMIT = 500;
const FILM_STRIP_FRAMES = 8;
const TOP_APPS = 4;

export function Dashboard({
  overview,
  doctor,
  bootstrapEvents,
  onRefresh,
  onStart,
  onStop,
  onPause,
  onResume,
  onTriggerIndex,
  onTriggerReorganise,
  onTriggerFullReindex,
  onBootstrap,
  onOpenMarkdownExport,
  onGoTimeline,
}: {
  overview: RuntimeOverview | null;
  doctor: DoctorCheck[] | null;
  bootstrapEvents: ModelBootstrapProgress[];
  onRefresh: () => void;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onTriggerIndex: () => Promise<void>;
  onTriggerReorganise: () => Promise<void>;
  onTriggerFullReindex: (fromDate: string) => Promise<void>;
  onBootstrap: () => Promise<void>;
  onOpenMarkdownExport: (category?: string) => Promise<void>;
  onGoTimeline: () => void;
}) {
  const [bootstrapping, setBootstrapping] = React.useState(false);

  // Single fetch of today's journal — used by both the timeline viz and the
  // bento tiles, so we don't double-poll the runtime.
  const { journal, loading } = useTodayJournal(overview);

  if (!overview) {
    return (
      <div className="flex flex-col gap-10 pt-6">
        <PageHeader title="Today" description="Getting things ready…" />
        <HeroSkeleton />
      </div>
    );
  }

  const running = overview.status === 'running';
  const captureLive = overview.capture.running && !overview.capture.paused;
  const capturePaused = overview.capture.running && overview.capture.paused;
  const failures = doctor?.filter((c) => c.status === 'fail') ?? [];
  const warnings = doctor?.filter((c) => c.status === 'warn') ?? [];
  const needsModelSetup = !overview.model.ready;

  const recentFrames = journal?.frames ?? [];

  return (
    <div className="flex flex-col gap-10 pt-4 pb-6">
      <PageHeader
        title="Today"
        eyebrow={prettyToday()}
        description="A simple view of what your second brain is doing right now."
        actions={
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            <RefreshCcw />
            Refresh
          </Button>
        }
      />

      <Hero
        overview={overview}
        captureLive={captureLive}
        capturePaused={capturePaused}
        running={running}
        journal={journal}
        loading={loading}
        onStart={onStart}
        onStop={onStop}
        onPause={onPause}
        onResume={onResume}
      />

      {overview.indexing.running && (
        <Alert>
          <Loader2 className="animate-spin" />
          <AlertTitle>{indexingStatusText(overview.indexing)}</AlertTitle>
          <AlertDescription>
            This runs in the background and may take a few minutes.
          </AlertDescription>
        </Alert>
      )}

      {needsModelSetup && (
        <Alert variant="warning">
          <Sparkles />
          <AlertTitle>Set up your local AI helper</AlertTitle>
          <AlertDescription className="gap-3">
            <p>
              One quick step. We'll download a small model so search and summaries
              work — fully offline.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={bootstrapping}
                onClick={async () => {
                  setBootstrapping(true);
                  try {
                    await onBootstrap();
                  } finally {
                    setBootstrapping(false);
                  }
                }}
              >
                {bootstrapping ? 'Setting up…' : 'Set up now'}
              </Button>
              {bootstrapEvents.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {bootstrapMessage(bootstrapEvents[bootstrapEvents.length - 1]!)}
                </span>
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Recent moments — full-bleed film strip. The most "alive" thing on the
          screen, designed to read like Photos.app rather than another card. */}
      {captureLive && recentFrames.length > 0 && (
        <FilmStrip
          frames={recentFrames.slice(0, FILM_STRIP_FRAMES)}
          onJump={onGoTimeline}
        />
      )}

      {/* Bento tile grid — replaces the old "Activity card with 4 stats inside".
          Each tile is its own container with its own dominant visual. */}
      <BentoGrid
        overview={overview}
        journal={journal}
        loading={loading}
      />

      {/* Hard problems surface inline */}
      {failures.length > 0 && (
        <section className="flex flex-col gap-2">
          {failures.map((check, i) => (
            <Alert key={i} variant="destructive">
              <XCircle />
              <AlertTitle>{check.area}</AlertTitle>
              <AlertDescription>
                <p>{check.message}</p>
                {check.action ? (
                  <p className="text-xs opacity-80 mt-1">→ {check.action}</p>
                ) : null}
              </AlertDescription>
            </Alert>
          ))}
        </section>
      )}

      <AdvancedSection
        overview={overview}
        warnings={warnings}
        onTriggerIndex={onTriggerIndex}
        onTriggerReorganise={onTriggerReorganise}
        onTriggerFullReindex={onTriggerFullReindex}
        onOpenMarkdownExport={onOpenMarkdownExport}
      />
    </div>
  );
}

function prettyToday(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   Today's-journal fetch
   Lifted out of ActivityCard so the bento grid + timeline viz share one
   data fetch instead of polling separately.
   ────────────────────────────────────────────────────────────────────── */
function useTodayJournal(overview: RuntimeOverview | null) {
  const eventsToday = overview?.capture.eventsToday ?? 0;
  const captureRunning = !!overview?.capture.running;

  const [journal, setJournal] = React.useState<JournalDay | null>(null);
  const [loading, setLoading] = React.useState(true);
  const lastSeen = React.useRef<number>(-1);

  React.useEffect(() => {
    if (!captureRunning && eventsToday === 0) {
      setLoading(false);
      setJournal(null);
      return;
    }
    if (eventsToday === lastSeen.current) return;
    lastSeen.current = eventsToday;

    let cancelled = false;
    (async () => {
      try {
        const today = localDayKey();
        const j =
          eventsToday <= FULL_JOURNAL_FRAME_LIMIT
            ? await window.cofounderos.getJournalDay(today)
            : {
                day: today,
                frames: await window.cofounderos.searchFrames({
                  day: today,
                  limit: ACTIVITY_SAMPLE_LIMIT,
                }),
                sessions: [],
              };
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

  return { journal, loading };
}

/* ──────────────────────────────────────────────────────────────────────────
   Hero — typography-led, full-bleed when capture is live
   No card wrapper. The single most important pixel real estate on screen.
   ────────────────────────────────────────────────────────────────────── */

function Hero({
  overview,
  captureLive,
  capturePaused,
  running,
  journal,
  loading,
  onStart,
  onStop,
  onPause,
  onResume,
}: {
  overview: RuntimeOverview;
  captureLive: boolean;
  capturePaused: boolean;
  running: boolean;
  journal: JournalDay | null;
  loading: boolean;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
}) {
  const events = overview.capture.eventsToday;
  const eventsLastHour = overview.capture.eventsLastHour;
  const activeMinutes = totalActiveMinutes(journal?.sessions ?? []);

  let eyebrowLabel = 'Idle';
  let title = 'Ready when you are';
  let subtitle = 'Hit Start when you want me to begin remembering.';
  let tone: 'live' | 'paused' | 'idle' = 'idle';

  if (captureLive) {
    eyebrowLabel = 'Live · Capturing';
    title = 'I’m remembering for you.';
    subtitle = 'Everything stays on this device.';
    tone = 'live';
  } else if (capturePaused) {
    eyebrowLabel = 'Paused';
    title = 'Capture is paused.';
    subtitle = 'Resume whenever you’re ready.';
    tone = 'paused';
  } else if (running) {
    eyebrowLabel = 'Almost there';
    title = 'Press Start to begin.';
    subtitle = 'The runtime is up; capture is waiting on your go-ahead.';
  }

  return (
    <section
      className={cn(
        'relative overflow-hidden rounded-2xl border bg-card/40 backdrop-blur-md',
        tone === 'live' && 'border-primary/30 shadow-glow',
        tone === 'paused' && 'border-warning/30',
      )}
    >
      {/* Decorative gradient wash. Loud when live, subtle when paused, off when idle. */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 transition-opacity duration-700',
          tone === 'live'
            ? 'opacity-100 bg-gradient-hero-live'
            : 'opacity-0',
        )}
      />
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 transition-opacity duration-700',
          tone === 'paused' ? 'opacity-100' : 'opacity-0',
        )}
        style={{
          background:
            'radial-gradient(ellipse 700px 350px at 110% -10%, oklch(0.74 0.17 65 / 0.16) 0%, transparent 60%)',
        }}
      />

      <div className="relative px-6 sm:px-9 pt-7 pb-7">
        {/* Top row: eyebrow + actions */}
        <div className="flex flex-wrap items-start justify-between gap-4 mb-7">
          <div className="flex items-center gap-2">
            <StatusBadge tone={tone}>{eyebrowLabel}</StatusBadge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!running && (
              <Button size="lg" onClick={() => void onStart()} className="btn-brand">
                <Play /> Start capturing
              </Button>
            )}
            {running && captureLive && (
              <Button size="lg" variant="secondary" onClick={() => void onPause()}>
                <Pause /> Pause
              </Button>
            )}
            {running && capturePaused && (
              <Button size="lg" onClick={() => void onResume()} className="btn-brand">
                <Play /> Resume
              </Button>
            )}
            {running && (
              <Button variant="ghost" onClick={() => void onStop()}>
                <CircleStop /> Stop
              </Button>
            )}
          </div>
        </div>

        {/* Title + subtitle. Display-grade scale. */}
        <h2 className="text-display max-w-3xl">
          {tone === 'live' ? (
            <>
              <span className="text-gradient-brand">I’m remembering</span>
              <span className="text-foreground"> for you.</span>
            </>
          ) : (
            title
          )}
        </h2>
        <p className="mt-3 text-base text-muted-foreground max-w-xl">
          {subtitle}
        </p>

        {/* Massive number readout */}
        <div className="mt-9 flex flex-wrap items-end gap-x-12 gap-y-6">
          <div className="min-w-0">
            <div className="flex items-baseline gap-3">
              <span className="text-display tabular text-foreground">
                {formatNumber(events)}
              </span>
              <span className="text-base text-muted-foreground">moments today</span>
            </div>
            <ActivityTimeline
              frames={journal?.frames ?? []}
              loading={loading}
              accent={tone === 'live'}
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-8 gap-y-3">
            <MiniStat
              label="Last hour"
              value={
                typeof eventsLastHour === 'number'
                  ? formatNumber(eventsLastHour)
                  : '—'
              }
              hint="moments"
            />
            <MiniStat
              label="Active"
              value={formatActiveMinutes(activeMinutes)}
              hint={journal?.sessions.length ? `${journal.sessions.length} session${journal.sessions.length === 1 ? '' : 's'}` : 'so far'}
            />
            <MiniStat
              label="All time"
              value={formatNumber(overview.storage.totalEvents)}
              hint={formatBytes(overview.storage.totalAssetBytes)}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function StatusBadge({
  tone,
  children,
}: {
  tone: 'live' | 'paused' | 'idle';
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.1em]',
        tone === 'live' && 'bg-success/15 text-success',
        tone === 'paused' && 'bg-warning/15 text-warning',
        tone === 'idle' && 'bg-muted text-muted-foreground',
      )}
    >
      <span className="relative grid place-items-center size-2">
        <span
          className={cn(
            'size-1.5 rounded-full',
            tone === 'live' && 'bg-success',
            tone === 'paused' && 'bg-warning',
            tone === 'idle' && 'bg-muted-foreground/60',
          )}
        />
        {tone === 'live' && (
          <span className="absolute inset-0 rounded-full bg-success/50 animate-ping" />
        )}
      </span>
      {children}
    </span>
  );
}

function MiniStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tabular tracking-tight">{value}</span>
        {hint && <span className="text-xs text-muted-foreground truncate">{hint}</span>}
      </div>
    </div>
  );
}

function HeroSkeleton() {
  return (
    <div className="rounded-2xl border bg-card/40 px-9 pt-7 pb-7 backdrop-blur-md">
      <Skeleton className="h-5 w-24 rounded-full" />
      <Skeleton className="mt-7 h-12 w-[60%]" />
      <Skeleton className="mt-3 h-4 w-72" />
      <div className="mt-9 flex gap-12">
        <div>
          <Skeleton className="h-12 w-40" />
          <Skeleton className="mt-3 h-3 w-full max-w-xs" />
        </div>
        <Skeleton className="h-12 w-72" />
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   ActivityTimeline
   24-hour bar visualization showing capture density per hour. Replaces a
   bullet stat with a real visualization — a non-technical user sees
   at-a-glance "I was busy this morning, quiet over lunch, picked up again".
   ────────────────────────────────────────────────────────────────────── */
function ActivityTimeline({
  frames,
  loading,
  accent,
}: {
  frames: Frame[];
  loading: boolean;
  accent: boolean;
}) {
  // Bucket frames by local hour (0–23)
  const hours = React.useMemo(() => {
    const buckets = new Array<number>(24).fill(0);
    for (const frame of frames) {
      if (!frame.timestamp) continue;
      const t = new Date(frame.timestamp);
      if (Number.isNaN(t.getTime())) continue;
      buckets[t.getHours()] += 1;
    }
    return buckets;
  }, [frames]);
  const max = Math.max(1, ...hours);
  const currentHour = new Date().getHours();
  const empty = frames.length === 0;

  if (loading && empty) {
    return <div className="mt-3 h-10 w-full max-w-md rounded-md shimmer" />;
  }

  return (
    <div className="mt-4 max-w-md">
      <div className="flex items-end gap-[3px] h-10">
        {hours.map((count, hour) => {
          const ratio = empty ? 0 : count / max;
          const isCurrent = hour === currentHour;
          const isPast = hour < currentHour;
          // Min height so empty hours still register, max-out at full bar
          const heightPct = empty
            ? 6
            : Math.max(8, Math.round(ratio * 100));
          return (
            <div
              key={hour}
              title={`${formatHour(hour)} · ${count} moment${count === 1 ? '' : 's'}`}
              className={cn(
                'flex-1 rounded-sm transition-all',
                isCurrent
                  ? accent
                    ? 'shadow-glow'
                    : 'ring-1 ring-primary/40'
                  : '',
                empty
                  ? 'bg-muted-foreground/15'
                  : isPast || isCurrent
                    ? accent && isCurrent
                      ? 'bg-gradient-brand'
                      : 'bg-foreground/70'
                    : 'bg-muted-foreground/20',
              )}
              style={{ height: `${heightPct}%` }}
            />
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground tabular">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>24:00</span>
      </div>
    </div>
  );
}

function formatHour(hour: number): string {
  const padded = String(hour).padStart(2, '0');
  return `${padded}:00`;
}

function totalActiveMinutes(sessions: ActivitySession[]): number {
  let ms = 0;
  for (const s of sessions) ms += s.active_ms || 0;
  return Math.round(ms / 60000);
}

function formatActiveMinutes(minutes: number): string {
  if (minutes <= 0) return '—';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/* ──────────────────────────────────────────────────────────────────────────
   FilmStrip
   Horizontal-scroll strip of large recent thumbnails. Replaces the old
   small-grid LiveCaptureStrip with something that reads like a creative
   tool, not an admin panel.
   ────────────────────────────────────────────────────────────────────── */

function FilmStrip({
  frames,
  onJump,
}: {
  frames: Frame[];
  onJump: () => void;
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="relative grid place-items-center size-5 rounded-full bg-success/15 text-success">
            <Radio className="size-3" />
            <span className="absolute inset-0 rounded-full bg-success/30 animate-ping" />
          </span>
          <h3 className="text-sm font-semibold">Just captured</h3>
          <span className="text-xs text-muted-foreground">— click any moment</span>
        </div>
        <button
          type="button"
          onClick={onJump}
          className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          See timeline →
        </button>
      </div>

      <div className="-mx-1 flex gap-3 overflow-x-auto pb-2 px-1 scrollbar-none scroll-smooth">
        {frames.map((frame, i) => (
          <FilmFrame key={frame.id ?? i} frame={frame} />
        ))}
      </div>
    </section>
  );
}

function FilmFrame({ frame }: { frame: Frame }) {
  const [thumbUrl, setThumbUrl] = React.useState<string | null>(null);
  const detail = useFrameDetail();
  const isAudio = frame.text_source === 'audio' || frame.app === 'Audio';

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
        setThumbUrl(null);
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
      className="group relative shrink-0 w-[260px] aspect-video rounded-xl overflow-hidden border border-border/50 bg-muted/30 shadow-card transition-all hover:scale-[1.015] hover:shadow-raised hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {thumbUrl ? (
        <img
          src={thumbUrl}
          alt=""
          className="size-full object-cover transition-transform group-hover:scale-[1.04]"
        />
      ) : (
        <div className="size-full grid place-items-center text-muted-foreground">
          {isAudio ? <Mic className="size-6" /> : <ImageOff className="size-6" />}
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent px-3 py-2 text-white">
        <div className="flex items-center justify-between text-[11px] font-medium">
          <span className="font-mono opacity-80">
            {formatLocalTime(frame.timestamp) || '—'}
          </span>
          <span className="truncate ml-2 opacity-95">{frame.app || ''}</span>
        </div>
        <div className="mt-0.5 truncate text-[12px] opacity-90">
          {frame.window_title || frame.entity_path || frame.url || ''}
        </div>
      </div>
    </button>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   BentoGrid — 3 stat tiles, each with its own dominant visual
   ────────────────────────────────────────────────────────────────────── */

function BentoGrid({
  overview,
  journal,
  loading,
}: {
  overview: RuntimeOverview;
  journal: JournalDay | null;
  loading: boolean;
}) {
  const apps = journal ? countByApp(journal.frames) : [];
  const total = journal?.frames.length ?? overview.capture.eventsToday;
  const indexing = overview.indexing.running;

  return (
    <section className="grid gap-4 lg:grid-cols-5">
      {/* Top apps — wide tile, dominant visual */}
      <Card className="lg:col-span-3">
        <CardContent className="flex flex-col gap-4 py-1">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Top apps today
            </h3>
            {apps.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {apps.length} app{apps.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {loading && !journal ? (
            <BarsSkeleton />
          ) : apps.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6">
              No app usage captured yet today.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {apps.slice(0, TOP_APPS).map((row, i) => (
                <AppBar
                  key={row.app}
                  app={row.app}
                  count={row.count}
                  percent={(row.count / Math.max(1, total)) * 100}
                  rank={i}
                />
              ))}
              {apps.length > TOP_APPS && (
                <div className="text-xs text-muted-foreground pt-1">
                  +{apps.length - TOP_APPS} more apps
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Memory — narrow tile, big number on top */}
      <Card className="lg:col-span-2">
        <CardContent className="flex flex-col gap-4 py-1">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Knowledge built
            </h3>
            {indexing && (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-primary">
                <Loader2 className="size-3 animate-spin" />
                Indexing
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <BigStat
              value={formatNumber(overview.index.pageCount)}
              label="pages"
            />
            <BigStat
              value={formatNumber(overview.index.eventsCovered)}
              label="grouped"
              muted
            />
            <BigStat
              value={formatBytes(overview.storage.totalAssetBytes)}
              label="on disk"
              muted
            />
            <BigStat
              value={formatNumber(overview.storage.totalEvents)}
              label="memories"
              muted
            />
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function BigStat({
  value,
  label,
  muted,
}: {
  value: string;
  label: string;
  muted?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div
        className={cn(
          'text-2xl font-semibold tabular tracking-tight truncate',
          muted ? 'text-foreground/70' : 'text-foreground',
        )}
      >
        {value}
      </div>
      <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground mt-0.5">
        {label}
      </div>
    </div>
  );
}

function AppBar({
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
      <div
        className="w-32 shrink-0 truncate text-sm font-medium"
        title={app}
      >
        {app}
      </div>
      <div className="flex-1 h-2.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-700 ease-out',
            rank === 0 ? 'bg-gradient-brand' : 'bg-foreground/30',
          )}
          style={{ width: `${Math.max(2, percent)}%` }}
        />
      </div>
      <div className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular">
        {count}{' '}
        <span className="opacity-50">· {percent < 1 ? '<1' : percent.toFixed(0)}%</span>
      </div>
    </div>
  );
}

function BarsSkeleton() {
  return (
    <div className="flex flex-col gap-3 py-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-2.5 flex-1 rounded-full" />
          <Skeleton className="h-4 w-12" />
        </div>
      ))}
    </div>
  );
}

function countByApp(frames: Frame[]): Array<{ app: string; count: number }> {
  const counts = new Map<string, number>();
  for (const f of frames) {
    const key = f.app || 'Unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([app, count]) => ({ app, count }))
    .sort((a, b) => b.count - a.count);
}

/* ──────────────────────────────────────────────────────────────────────────
   AdvancedSection — every "useful but technical" surface lives here
   Closed by default. Same content as before, just polished against the
   new palette.
   ────────────────────────────────────────────────────────────────────── */

function AdvancedSection({
  overview,
  warnings,
  onTriggerIndex,
  onTriggerReorganise,
  onTriggerFullReindex,
  onOpenMarkdownExport,
}: {
  overview: RuntimeOverview;
  warnings: DoctorCheck[];
  onTriggerIndex: () => Promise<void>;
  onTriggerReorganise: () => Promise<void>;
  onTriggerFullReindex: (fromDate: string) => Promise<void>;
  onOpenMarkdownExport: (category?: string) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const exportCategories = overview.index.categories ?? [];
  const markdownExport = overview.exports.find((exp) => exp.name === 'markdown');
  const backgroundJobs = overview.backgroundJobs ?? [];
  const indexLabel =
    overview.index.strategy === 'karpathy'
      ? 'Karpathy wiki'
      : `${overview.index.strategy ?? 'Memory'} index`;
  const warningsCount = warnings.length;
  const runningJobs = backgroundJobs.filter((j) => j.running).length;

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'group flex w-full items-center justify-between gap-3 rounded-xl border bg-card/40 px-4 py-3 text-left transition-colors backdrop-blur-md',
          'hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        )}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Wand2 className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium">Advanced controls</div>
            <div className="text-xs text-muted-foreground truncate">
              Re-index, browse the export folder, watch background jobs.
              {warningsCount > 0
                ? ` · ${warningsCount} thing${warningsCount === 1 ? '' : 's'} to look at`
                : runningJobs > 0
                  ? ` · ${runningJobs} job${runningJobs === 1 ? '' : 's'} running`
                  : ''}
            </div>
          </div>
        </div>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="mt-4 flex flex-col gap-4 animate-in fade-in-0 slide-in-from-top-1 duration-200">
          <KnowledgeExport
            overview={overview}
            indexLabel={indexLabel}
            markdownExport={markdownExport}
            exportCategories={exportCategories}
            onOpenMarkdownExport={onOpenMarkdownExport}
          />

          <MemoryOrganization
            overview={overview}
            onTriggerIndex={onTriggerIndex}
            onTriggerReorganise={onTriggerReorganise}
            onTriggerFullReindex={onTriggerFullReindex}
          />

          {backgroundJobs.length > 0 && <BackgroundWorkCard overview={overview} />}

          {warnings.length > 0 && (
            <div className="grid gap-2">
              {warnings.slice(0, 5).map((check, i) => (
                <Alert key={i} variant="warning">
                  <AlertCircle />
                  <AlertTitle>{check.area}</AlertTitle>
                  <AlertDescription>
                    <p>{check.message}</p>
                    {check.action ? (
                      <p className="text-xs opacity-80 mt-1">→ {check.action}</p>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function KnowledgeExport({
  overview,
  indexLabel,
  markdownExport,
  exportCategories,
  onOpenMarkdownExport,
}: {
  overview: RuntimeOverview;
  indexLabel: string;
  markdownExport: RuntimeOverview['exports'][number] | undefined;
  exportCategories: NonNullable<RuntimeOverview['index']['categories']>;
  onOpenMarkdownExport: (category?: string) => Promise<void>;
}) {
  return (
    <Card>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="grid size-11 place-items-center rounded-xl bg-primary-soft text-primary">
            <FolderOpen className="size-5" />
          </div>
          <div className="min-w-[220px] flex-1">
            <h4 className="font-semibold">{indexLabel}</h4>
            <p className="text-sm text-muted-foreground mt-0.5">
              Browse the Markdown export by category.
            </p>
          </div>
          <div className="text-right text-sm">
            <div className="font-semibold">
              {formatNumber(overview.index.pageCount)} pages
            </div>
            <div
              className={cn(
                'text-xs text-muted-foreground',
                markdownExport?.errorCount &&
                  markdownExport.errorCount > 0 &&
                  'text-destructive',
                markdownExport?.pendingUpdates &&
                  markdownExport.pendingUpdates > 0 &&
                  'text-warning',
              )}
            >
              {formatMarkdownExportStatus(markdownExport)}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void onOpenMarkdownExport()}>
            <FolderOpen />
            Open export
          </Button>
        </div>

        {exportCategories.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {exportCategories.map((category) => (
              <button
                key={category.name}
                type="button"
                className="group rounded-xl border bg-background p-4 text-left transition hover:border-primary/50 hover:bg-muted/40 hover:shadow-card"
                onClick={() => void onOpenMarkdownExport(category.name)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium capitalize">
                      {formatCategoryName(category.name)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {formatNumber(category.pageCount)} page
                      {category.pageCount === 1 ? '' : 's'}
                      {category.summaryPath ? ' · summary ready' : ''}
                    </div>
                  </div>
                  <ExternalLink className="size-3.5 text-muted-foreground transition group-hover:text-primary" />
                </div>
                <p className="text-[11px] text-muted-foreground mt-3">
                  {category.lastUpdated
                    ? `Updated ${formatLocalDateTime(category.lastUpdated)}`
                    : 'No update time yet'}
                </p>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
            No category folders yet. Run an index pass to generate the wiki pages.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MemoryOrganization({
  overview,
  onTriggerIndex,
  onTriggerReorganise,
  onTriggerFullReindex,
}: {
  overview: RuntimeOverview;
  onTriggerIndex: () => Promise<void>;
  onTriggerReorganise: () => Promise<void>;
  onTriggerFullReindex: (fromDate: string) => Promise<void>;
}) {
  const [organizing, setOrganizing] = React.useState<'index' | 'reorg' | 'full' | null>(
    null,
  );
  const [reindexFrom, setReindexFrom] = React.useState(localDayKey);

  return (
    <Card>
      <CardContent className="flex flex-col gap-0">
        <Row
          icon={<Zap className="size-4" />}
          title="Refresh the memory index"
          description="Run this if recent captures aren’t showing up in search yet."
          action={
            <Button
              disabled={organizing !== null || overview.indexing.running}
              onClick={async () => {
                setOrganizing('index');
                try {
                  await onTriggerIndex();
                } finally {
                  setOrganizing(null);
                }
              }}
            >
              <RefreshCcw />
              {organizing === 'index' ? 'Organizing…' : 'Organize now'}
            </Button>
          }
        />
        <Separator className="my-4" />
        <Row
          icon={<Wand2 className="size-4" />}
          title="Rebuild summaries"
          description="Reorganize pages and summaries after large capture sessions."
          action={
            <Button
              variant="outline"
              disabled={organizing !== null || overview.indexing.running}
              onClick={async () => {
                setOrganizing('reorg');
                try {
                  await onTriggerReorganise();
                } finally {
                  setOrganizing(null);
                }
              }}
            >
              <Wand2 />
              {organizing === 'reorg' ? 'Rebuilding…' : 'Rebuild summaries'}
            </Button>
          }
        />
        <Separator className="my-4" />
        <Row
          icon={<RefreshCcw className="size-4" />}
          title="Re-index from a date"
          description="Wipe generated pages and rebuild from raw captures starting on this date."
          action={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Input
                type="date"
                value={reindexFrom}
                onChange={(event) => setReindexFrom(event.currentTarget.value)}
                className="w-[150px]"
                aria-label="Re-index from date"
              />
              <Button
                variant="outline"
                disabled={
                  organizing !== null || overview.indexing.running || !reindexFrom
                }
                onClick={async () => {
                  setOrganizing('full');
                  try {
                    await onTriggerFullReindex(reindexFrom);
                  } finally {
                    setOrganizing(null);
                  }
                }}
              >
                <RefreshCcw />
                {organizing === 'full' ? 'Re-indexing…' : 'Re-index'}
              </Button>
            </div>
          }
        />
      </CardContent>
    </Card>
  );
}

function formatCategoryName(name: string): string {
  return name
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatMarkdownExportStatus(
  exp: RuntimeOverview['exports'][number] | undefined,
): string {
  if (!exp) return 'Markdown export not configured';
  if (exp.errorCount && exp.errorCount > 0) {
    return `${exp.errorCount} export error${exp.errorCount === 1 ? '' : 's'}`;
  }
  if (exp.pendingUpdates && exp.pendingUpdates > 0) {
    return `${exp.pendingUpdates} update${exp.pendingUpdates === 1 ? '' : 's'} pending`;
  }
  if (exp.lastSync) return `Synced ${formatLocalDateTime(exp.lastSync)}`;
  return exp.running ? 'Waiting for first sync' : 'Export is stopped';
}

function BackgroundWorkCard({ overview }: { overview: RuntimeOverview }) {
  const jobs = (overview.backgroundJobs ?? []).slice().sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return (b.lastCompletedAt ?? '').localeCompare(a.lastCompletedAt ?? '');
  });
  const visibleJobs = jobs.slice(0, 6);
  const runningCount = jobs.filter((job) => job.running).length;
  const slowest = jobs
    .filter((job) => typeof job.lastDurationMs === 'number')
    .sort((a, b) => (b.lastDurationMs ?? 0) - (a.lastDurationMs ?? 0))[0];

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium',
                runningCount > 0
                  ? 'border-warning/40 bg-warning/10 text-warning'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {runningCount > 0
                ? `${runningCount} job${runningCount === 1 ? '' : 's'} running`
                : 'All jobs idle'}
            </span>
            {slowest && (
              <span className="text-xs text-muted-foreground">
                Slowest recent: {formatJobName(slowest.name)} ·{' '}
                {formatDuration(slowest.lastDurationMs)}
              </span>
            )}
          </div>
          <div className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            {overview.system?.overviewMode === 'fast' ? 'Heartbeat' : 'Overview'} ·{' '}
            {formatDuration(overview.system?.overviewDurationMs)}
          </div>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {visibleJobs.map((job) => (
            <div
              key={job.name}
              className={cn(
                'rounded-lg border p-3 text-sm bg-background',
                job.running && 'border-warning/40 bg-warning/10',
                job.lastError && 'border-destructive/40 bg-destructive/10',
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium">{formatJobName(job.name)}</div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  {job.running && <Loader2 className="size-3 animate-spin" />}
                  {job.running
                    ? 'running'
                    : job.lastCompletedAt
                      ? formatLocalTime(job.lastCompletedAt)
                      : 'not run'}
                </div>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                last {formatDuration(job.lastDurationMs)} · runs {job.runCount}
                {job.skippedCount > 0 ? ` · skipped ${job.skippedCount}` : ''}
              </div>
              {job.lastError ? (
                <div className="mt-1 line-clamp-2 text-xs text-destructive">
                  {job.lastError}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function formatJobName(name: string): string {
  return name
    .replace(/^index-/, '')
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatDuration(ms?: number | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function Row({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex flex-1 min-w-[260px] items-start gap-3">
        {icon && (
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h4 className="font-medium">{title}</h4>
          <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
        </div>
      </div>
      <div>{action}</div>
    </div>
  );
}
