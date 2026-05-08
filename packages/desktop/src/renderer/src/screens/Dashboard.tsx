import * as React from 'react';
import {
  AlertCircle,
  ChevronDown,
  CircleStop,
  ExternalLink,
  FolderOpen,
  Loader2,
  Pause,
  Play,
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
import { ActivityCard } from '@/components/ActivityCard';
import { LiveCaptureStrip } from '@/components/LiveCaptureStrip';
import { PageHeader } from '@/components/PageHeader';
import {
  bootstrapMessage,
  formatLocalDateTime,
  formatLocalTime,
  formatNumber,
  indexingStatusText,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import type {
  DoctorCheck,
  ModelBootstrapProgress,
  RuntimeOverview,
} from '@/global';

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

  if (!overview) {
    return (
      <div className="flex flex-col gap-6 pt-6">
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

  return (
    <div className="flex flex-col gap-6 pt-6">
      <PageHeader
        title="Today"
        description="A simple view of what your second brain is up to."
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

      {/* The two emotionally-important surfaces: just-captured + activity */}
      <LiveCaptureStrip overview={overview} onGoTimeline={onGoTimeline} />
      <ActivityCard overview={overview} onGoTimeline={onGoTimeline} />

      {/* Hard problems that need user attention surface inline as a tight stack.
          Soft warnings move into the Advanced disclosure below. */}
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

      {/* Everything that's "useful but technical" lives behind one disclosure.
          Default closed so the dashboard reads as a calm status page; one
          click reveals every admin lever for power users. */}
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

/* ──────────────────────────────────────────────────────────────────────────
   Hero
   The single-glance "what's happening now" panel. Replaces the old
   icon+text+button row with a real hero treatment: gradient background
   when capture is live, large lock-up of moments + active time, one
   primary action.
   ────────────────────────────────────────────────────────────────────── */

function Hero({
  overview,
  captureLive,
  capturePaused,
  running,
  onStart,
  onStop,
  onPause,
  onResume,
}: {
  overview: RuntimeOverview;
  captureLive: boolean;
  capturePaused: boolean;
  running: boolean;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
}) {
  const events = overview.capture.eventsToday;
  const eventsLastHour = overview.capture.eventsLastHour;

  let eyebrow = 'Idle';
  let title = 'Ready when you are';
  let subtitle = 'Your local memory is set up. Hit Start to begin capturing your work.';
  let tone: 'live' | 'paused' | 'idle' = 'idle';

  if (captureLive) {
    eyebrow = 'Live';
    title = "I'm remembering for you";
    subtitle = 'Everything stays on this device. Press Pause anytime.';
    tone = 'live';
  } else if (capturePaused) {
    eyebrow = 'Paused';
    title = 'Capture is paused';
    subtitle = 'Resume whenever you want to start remembering again.';
    tone = 'paused';
  } else if (running) {
    eyebrow = 'Almost there';
    title = 'Press Start to begin';
    subtitle = 'The runtime is up; capture is just waiting on your go-ahead.';
  }

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl border bg-card shadow-card',
        tone === 'live' && 'border-primary/20',
        tone === 'paused' && 'border-warning/30',
      )}
    >
      {/* Decorative gradient wash. Only loud when capture is live. */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500',
          tone === 'live' && 'opacity-100',
        )}
        style={{
          background:
            'radial-gradient(ellipse 700px 350px at 110% -10%, oklch(0.55 0.22 285 / 0.13) 0%, transparent 60%), radial-gradient(ellipse 500px 300px at -10% 110%, oklch(0.55 0.22 220 / 0.1) 0%, transparent 60%)',
        }}
      />
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500',
          tone === 'paused' && 'opacity-100',
        )}
        style={{
          background:
            'radial-gradient(ellipse 700px 350px at 110% -10%, oklch(0.74 0.17 65 / 0.1) 0%, transparent 60%)',
        }}
      />

      <div className="relative p-6 sm:p-7 flex flex-wrap items-end gap-6">
        <div className="flex-1 min-w-[260px]">
          <div className="flex items-center gap-2">
            <StatusDot tone={tone} />
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {eyebrow}
            </span>
          </div>
          <h2 className="mt-3 text-[30px] leading-[1.1] font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground max-w-md leading-relaxed">
            {subtitle}
          </p>

          {/* Big-number readout. The single most important fact on the dashboard. */}
          <div className="mt-6 flex flex-wrap items-baseline gap-x-7 gap-y-3">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                Captured today
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-[44px] leading-none font-semibold tracking-tight tabular-nums">
                  {formatNumber(events)}
                </span>
                <span className="text-sm text-muted-foreground">moments</span>
              </div>
            </div>
            {typeof eventsLastHour === 'number' && eventsLastHour > 0 && (
              <div>
                <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                  Last hour
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-semibold tracking-tight tabular-nums">
                    {formatNumber(eventsLastHour)}
                  </span>
                </div>
              </div>
            )}
          </div>
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
    </div>
  );
}

function StatusDot({ tone }: { tone: 'live' | 'paused' | 'idle' }) {
  return (
    <span className="relative grid place-items-center size-2.5">
      <span
        className={cn(
          'size-2 rounded-full',
          tone === 'live' && 'bg-success',
          tone === 'paused' && 'bg-warning',
          tone === 'idle' && 'bg-muted-foreground/40',
        )}
      />
      {tone === 'live' && (
        <span className="absolute inset-0 rounded-full bg-success/40 animate-ping" />
      )}
    </span>
  );
}

function HeroSkeleton() {
  return (
    <div className="rounded-2xl border bg-card shadow-card p-7">
      <Skeleton className="h-3 w-12" />
      <Skeleton className="mt-3 h-8 w-72" />
      <Skeleton className="mt-2 h-4 w-96" />
      <div className="mt-6 flex gap-7">
        <div>
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-2 h-10 w-32" />
        </div>
        <div>
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-2 h-7 w-16" />
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Advanced section
   Single disclosure containing every "useful but technical" surface that
   used to live as a peer of the hero. Closed by default — non-technical
   users never have to see it; power users open it once and find what
   they want under one heading.
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
          'group flex w-full items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 text-left transition-colors',
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
              Re-index, browse the export folder, and watch background jobs.
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
                {category.recentPages && category.recentPages.length > 0 ? (
                  <div className="mt-3 space-y-2 border-t pt-3">
                    {category.recentPages.map((page) => (
                      <div key={page.path}>
                        <div className="truncate text-sm font-medium">
                          {page.title}
                        </div>
                        {page.summary ? (
                          <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                            {page.summary}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
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
          description="Run this if recent captures are not showing up in search or journals yet."
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

function localDayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
