import * as React from 'react';
import {
  AlertCircle,
  Brain,
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
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { ActivityCard } from '@/components/ActivityCard';
import { LiveCaptureStrip } from '@/components/LiveCaptureStrip';
import { PageHeader } from '@/components/PageHeader';
import { bootstrapMessage, formatLocalDateTime, formatLocalTime, formatNumber, indexingStatusText } from '@/lib/format';
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
  const [organizing, setOrganizing] = React.useState<'index' | 'reorg' | 'full' | null>(null);
  const [reindexFrom, setReindexFrom] = React.useState(localDayKey);

  if (!overview) {
    return (
      <div className="flex flex-col gap-6 pt-6">
        <PageHeader title="Dashboard" description="Getting things ready…" />
        <Card>
          <CardContent className="flex items-center gap-5">
            <Skeleton className="size-14 rounded-xl" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-72" />
            </div>
            <Skeleton className="h-10 w-24" />
          </CardContent>
        </Card>
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-9 w-20 mt-1" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-3 w-32" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const running = overview.status === 'running';
  const captureLive = overview.capture.running && !overview.capture.paused;
  const capturePaused = overview.capture.running && overview.capture.paused;
  const failures = doctor?.filter((c) => c.status === 'fail') ?? [];
  const warnings = doctor?.filter((c) => c.status === 'warn') ?? [];
  const needsModelSetup = !overview.model.ready;
  const exportCategories = overview.index.categories ?? [];
  const markdownExport = overview.exports.find((exp) => exp.name === 'markdown');
  const backgroundJobs = overview.backgroundJobs ?? [];
  const indexLabel = overview.index.strategy === 'karpathy'
    ? 'Karpathy wiki'
    : `${overview.index.strategy ?? 'Memory'} index`;

  let heroTitle = 'Welcome back';
  let heroText = 'Your local memory is ready. Start capturing whenever you like.';
  let heroVariant: 'idle' | 'live' | 'paused' = 'idle';

  if (captureLive) {
    heroTitle = "I'm remembering for you";
    heroText = `${formatNumber(overview.capture.eventsToday)} moments captured today. Everything stays on this device.`;
    heroVariant = 'live';
  } else if (capturePaused) {
    heroTitle = 'Capture is paused';
    heroText = 'Resume whenever you want to start remembering again.';
    heroVariant = 'paused';
  } else if (running) {
    heroTitle = 'Almost ready';
    heroText = 'Press Start to begin capturing your work.';
  }

  return (
    <div className="flex flex-col gap-6 pt-6">
      <PageHeader
        title="Dashboard"
        description="A simple view of your second brain."
        actions={
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            <RefreshCcw />
            Refresh
          </Button>
        }
      />

      <Card>
        <CardContent className="flex flex-wrap items-center gap-5">
          <div
            className={cn(
              'grid size-14 place-items-center rounded-xl border',
              heroVariant === 'live' && 'border-success/40 bg-success/10 text-success',
              heroVariant === 'paused' && 'border-warning/40 bg-warning/10 text-warning',
              heroVariant === 'idle' && 'border-border bg-muted text-muted-foreground',
            )}
          >
            <Brain className="size-7" />
          </div>
          <div className="flex-1 min-w-[200px]">
            <h2 className="text-xl font-semibold tracking-tight">{heroTitle}</h2>
            <p className="text-sm text-muted-foreground mt-1">{heroText}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!running && (
              <Button size="lg" onClick={() => void onStart()}>
                <Play /> Start
              </Button>
            )}
            {running && captureLive && (
              <Button size="lg" variant="secondary" onClick={() => void onPause()}>
                <Pause /> Pause
              </Button>
            )}
            {running && capturePaused && (
              <Button size="lg" onClick={() => void onResume()}>
                <Play /> Resume
              </Button>
            )}
            {running && (
              <Button variant="ghost" onClick={() => void onStop()}>
                <CircleStop /> Stop
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {overview.indexing.running && (
        <Alert>
          <Loader2 className="animate-spin" />
          <AlertTitle>{indexingStatusText(overview.indexing)}</AlertTitle>
          <AlertDescription>
            This runs in the background and may take a few minutes.
          </AlertDescription>
        </Alert>
      )}

      <LiveCaptureStrip overview={overview} onGoTimeline={onGoTimeline} />

      {needsModelSetup && (
        <Alert variant="warning">
          <Sparkles />
          <AlertTitle>Set up your local AI helper</AlertTitle>
          <AlertDescription className="gap-3">
            <p>
              One quick step. We'll download a small model so search and summaries work — fully offline.
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

      <ActivityCard overview={overview} onGoTimeline={onGoTimeline} />

      {backgroundJobs.length > 0 && <BackgroundWorkCard overview={overview} />}

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Knowledge export
          </h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onOpenMarkdownExport()}
          >
            <FolderOpen />
            Open export
          </Button>
        </div>
        <Card>
          <CardContent className="space-y-5">
            <div className="flex flex-wrap items-center gap-4">
              <div className="grid size-11 place-items-center rounded-lg border bg-muted text-muted-foreground">
                <FolderOpen className="size-5" />
              </div>
              <div className="min-w-[220px] flex-1">
                <h4 className="font-medium">{indexLabel}</h4>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Browse the Markdown export by category, matching the folders your index generates.
                </p>
              </div>
              <div className="text-right text-sm">
                <div className="font-medium">{formatNumber(overview.index.pageCount)} pages</div>
                <div
                  className={cn(
                    'text-muted-foreground',
                    markdownExport?.errorCount && markdownExport.errorCount > 0 && 'text-destructive',
                    markdownExport?.pendingUpdates && markdownExport.pendingUpdates > 0 && 'text-warning',
                  )}
                >
                  {formatMarkdownExportStatus(markdownExport)}
                </div>
              </div>
            </div>

            {exportCategories.length > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {exportCategories.map((category) => (
                  <button
                    key={category.name}
                    type="button"
                    className="group rounded-lg border bg-background p-4 text-left transition hover:border-primary/50 hover:bg-muted/40"
                    onClick={() => void onOpenMarkdownExport(category.name)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium capitalize">{formatCategoryName(category.name)}</div>
                        <div className="text-sm text-muted-foreground mt-1">
                          {formatNumber(category.pageCount)} page{category.pageCount === 1 ? '' : 's'}
                          {category.summaryPath ? ' - summary ready' : ''}
                        </div>
                      </div>
                      <ExternalLink className="size-4 text-muted-foreground transition group-hover:text-primary" />
                    </div>
                    <p className="text-xs text-muted-foreground mt-3">
                      {category.lastUpdated
                        ? `Updated ${formatLocalDateTime(category.lastUpdated)}`
                        : 'No update time yet'}
                    </p>
                    {category.recentPages && category.recentPages.length > 0 ? (
                      <div className="mt-3 space-y-2 border-t pt-3">
                        {category.recentPages.map((page) => (
                          <div key={page.path}>
                            <div className="truncate text-sm font-medium">{page.title}</div>
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
                No category folders yet. Run an index pass to generate the Karpathy pages, then this
                section will group the export by projects, meetings, docs, apps, and other folders.
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Memory organization
        </h3>
        <Card>
          <CardContent className="flex flex-col gap-0">
            <Row
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
              title="Rebuild summaries"
              description="Ask the indexer to reorganize pages and summaries after larger capture sessions."
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
              title="Re-index from date"
              description="Wipe generated index pages and rebuild them from raw captures starting on this date."
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
                    disabled={organizing !== null || overview.indexing.running || !reindexFrom}
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
      </section>

      {(failures.length > 0 || warnings.length > 0) && (
        <section>
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">
            Things to look at
          </h3>
          <div className="grid gap-3">
            {[...failures, ...warnings].slice(0, 5).map((check, i) => (
              <Alert
                key={i}
                variant={check.status === 'fail' ? 'destructive' : 'warning'}
              >
                {check.status === 'fail' ? <XCircle /> : <AlertCircle />}
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
        </section>
      )}
    </div>
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
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Background work
        </h3>
        <div className="text-xs text-muted-foreground">
          {overview.system?.overviewMode === 'fast' ? 'Heartbeat' : 'Overview'} built in {formatDuration(overview.system?.overviewDurationMs)}; cached for{' '}
          {formatDuration(overview.system?.overviewCacheTtlMs)}
        </div>
      </div>
      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className={cn(
              'rounded-full border px-2.5 py-1',
              runningCount > 0 ? 'border-warning/40 bg-warning/10 text-warning' : 'bg-muted text-muted-foreground',
            )}>
              {runningCount > 0 ? `${runningCount} running` : 'All jobs idle'}
            </span>
            {slowest ? (
              <span className="text-muted-foreground">
                Slowest recent job: {formatJobName(slowest.name)} took {formatDuration(slowest.lastDurationMs)}
              </span>
            ) : (
              <span className="text-muted-foreground">Waiting for first scheduler tick.</span>
            )}
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {visibleJobs.map((job) => (
              <div
                key={job.name}
                className={cn(
                  'rounded-lg border p-3 text-sm',
                  job.running && 'border-warning/40 bg-warning/10',
                  job.lastError && 'border-destructive/40 bg-destructive/10',
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium">{formatJobName(job.name)}</div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    {job.running && <Loader2 className="size-3 animate-spin" />}
                    {job.running ? 'running' : job.lastCompletedAt ? formatLocalTime(job.lastCompletedAt) : 'not run'}
                  </div>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  last {formatDuration(job.lastDurationMs)} · runs {job.runCount}
                  {job.skippedCount > 0 ? ` · skipped ${job.skippedCount}` : ''}
                </div>
                {job.lastError ? (
                  <div className="mt-1 line-clamp-2 text-xs text-destructive">{job.lastError}</div>
                ) : null}
              </div>
            ))}
          </div>
          {overview.system?.overviewTimings && Object.keys(overview.system.overviewTimings).length > 0 ? (
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Overview timing
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                {Object.entries(overview.system.overviewTimings)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 6)
                  .map(([name, ms]) => (
                    <span key={name} className="rounded-full border bg-background px-2 py-1">
                      {formatJobName(name)} {formatDuration(ms)}
                    </span>
                  ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
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
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex-1 min-w-[260px]">
        <h4 className="font-medium">{title}</h4>
        <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div>{action}</div>
    </div>
  );
}
