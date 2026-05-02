import * as React from 'react';
import {
  AlertCircle,
  Brain,
  CircleStop,
  Loader2,
  Pause,
  Play,
  RefreshCcw,
  Sparkles,
  Wand2,
  XCircle,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { PageHeader } from '@/components/PageHeader';
import { bootstrapMessage, formatBytes, formatNumber, indexingStatusText } from '@/lib/format';
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
  onBootstrap,
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
  onBootstrap: () => Promise<void>;
  onGoTimeline: () => void;
}) {
  const [bootstrapping, setBootstrapping] = React.useState(false);
  const [organizing, setOrganizing] = React.useState<'index' | 'reorg' | null>(null);

  if (!overview) {
    return (
      <div className="flex flex-col gap-6 pt-6">
        <PageHeader title="Dashboard" description="Getting things ready…" />
      </div>
    );
  }

  const running = overview.status === 'running';
  const captureLive = overview.capture.running && !overview.capture.paused;
  const capturePaused = overview.capture.running && overview.capture.paused;
  const failures = doctor?.filter((c) => c.status === 'fail') ?? [];
  const warnings = doctor?.filter((c) => c.status === 'warn') ?? [];
  const needsModelSetup = !overview.model.ready;

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

      <div className="grid gap-4 sm:grid-cols-3">
        <button
          type="button"
          onClick={onGoTimeline}
          className="text-left group"
        >
          <Card className="h-full transition-colors group-hover:border-primary/40">
            <CardHeader>
              <CardDescription>Captured today</CardDescription>
              <CardTitle className="text-3xl">{formatNumber(overview.capture.eventsToday)}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">moments saved</CardContent>
          </Card>
        </button>
        <Card>
          <CardHeader>
            <CardDescription>Total memories</CardDescription>
            <CardTitle className="text-3xl">{formatNumber(overview.storage.totalEvents)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {formatBytes(overview.storage.totalAssetBytes)} stored locally
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              Organized pages
              {overview.indexing.running ? (
                <Badge variant="secondary" className="text-[10px]">
                  <Loader2 className="size-3 animate-spin" />
                  Indexing
                </Badge>
              ) : null}
            </CardDescription>
            <CardTitle className="text-3xl">{formatNumber(overview.index.pageCount)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {formatNumber(overview.index.eventsCovered)} memories grouped
          </CardContent>
        </Card>
      </div>

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
