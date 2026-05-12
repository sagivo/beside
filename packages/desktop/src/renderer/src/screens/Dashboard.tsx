import * as React from 'react';
import {
  AlertCircle,
  ArrowRight,
  Calendar,
  ChevronDown,
  CheckSquare,
  CircleStop,
  Clock,
  ExternalLink,
  FileText,
  FolderOpen,
  History,
  Inbox,
  Loader2,
  MessageSquare,
  Mic,
  Pause,
  Play,
  RefreshCcw,
  Search as SearchIcon,
  Sparkles,
  Wand2,
  XCircle,
  Zap,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { useFrameDetail } from '@/components/FrameDetailDialog';
import { PageHeader } from '@/components/PageHeader';
import { dayEventSourceShortLabel } from '@/lib/day-events';
import {
  bootstrapMessage,
  formatBytes,
  formatLocalDateTime,
  formatLocalTime,
  formatNumber,
  indexingStatusText,
  localDayKey,
} from '@/lib/format';
import { actionItemLabel, collectMeetingSummarySignals } from '@/lib/meeting-signals';
import { cn } from '@/lib/utils';
import type {
  ActivitySession,
  DayEvent,
  DoctorCheck,
  Frame,
  JournalDay,
  Meeting,
  ModelBootstrapProgress,
  RuntimeActionCenter,
  RuntimeActionCenterFollowup,
  RuntimeActionCenterProject,
  RuntimeActionCenterUrgency,
  RuntimeMeetingWorkBridge,
  RuntimeOverview,
} from '@/global';

const FULL_JOURNAL_FRAME_LIMIT = 600;
const ACTIVITY_SAMPLE_LIMIT = 500;
const TIMELINE_UPCOMING_LIMIT = 3;
const TIMELINE_RECENT_LIMIT = 6;
const actionItemButtonClass =
  'group w-full rounded-md border border-border/70 bg-background/55 p-3 text-left shadow-xs transition-colors hover:border-primary/35 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40';

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
  onGoMeetings,
  onSearch,
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
  onGoMeetings: (target?: FounderAgendaTarget | null) => void;
  onSearch: (query: string) => void;
}) {
  const [bootstrapping, setBootstrapping] = React.useState(false);

  // Single fetch of today's journal — used by both the activity bars and the
  // bento tiles, so we don't double-poll the runtime.
  const { journal, loading } = useTodayJournal(overview);
  const founderBrief = useFounderBrief(overview);
  const actionCenter = useActionCenter(overview);

  if (!overview) {
    return (
      <div className="flex flex-col gap-10 pt-6">
        <PageHeader title="Today" description="Getting things ready…" />
        <TodayHomeSkeleton />
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
    <div className="flex flex-col gap-6 pt-4 pb-6">
      <PageHeader
        title="Today"
        eyebrow={prettyToday()}
        description="Search, timeline, and capture status for the day."
        actions={
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            <RefreshCcw />
            Refresh
          </Button>
        }
      />

      <TodayHome
        overview={overview}
        captureLive={captureLive}
        capturePaused={capturePaused}
        running={running}
        journal={journal}
        loading={loading || founderBrief.loading}
        actionCenter={actionCenter.center}
        actionLoading={actionCenter.loading}
        events={founderBrief.events}
        meetings={founderBrief.meetings}
        onStart={onStart}
        onStop={onStop}
        onPause={onPause}
        onResume={onResume}
        onSearch={onSearch}
        onGoMeetings={onGoMeetings}
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

function TodayHomeSkeleton() {
  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="rounded-lg border bg-card/70 p-4 shadow-card">
          <Skeleton className="h-11 w-full rounded-lg" />
          <div className="mt-3 flex gap-2">
            <Skeleton className="h-7 w-28 rounded-md" />
            <Skeleton className="h-7 w-24 rounded-md" />
            <Skeleton className="h-7 w-24 rounded-md" />
          </div>
        </div>
        <div className="rounded-lg border bg-card/70 p-4 shadow-card">
          <Skeleton className="h-4 w-28" />
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-lg" />
            ))}
          </div>
        </div>
        <div className="rounded-lg border bg-card/70 p-4 shadow-card">
          <Skeleton className="h-4 w-32" />
          <div className="mt-4 flex flex-col gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-md" />
            ))}
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Skeleton className="h-72 rounded-lg" />
        <Skeleton className="h-52 rounded-lg" />
      </div>
    </section>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Today's-journal fetch
   Shared by the bento grid + activity bars so the dashboard only pays for
   one journal fetch.
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

function useFounderBrief(overview: RuntimeOverview | null): {
  events: DayEvent[];
  meetings: Meeting[];
  loading: boolean;
} {
  const today = localDayKey();
  const hasOverview = overview !== null;
  const eventsToday = overview?.capture.eventsToday ?? 0;
  const refreshKey = React.useMemo(() => {
    if (!overview) return '';
    return (overview.backgroundJobs ?? [])
      .filter((job) =>
        ['event-extractor', 'meeting-builder', 'meeting-summarizer'].includes(job.name),
      )
      .map((job) => `${job.name}:${job.lastCompletedAt ?? ''}:${job.runCount}`)
      .join('|');
  }, [overview]);
  const [events, setEvents] = React.useState<DayEvent[]>([]);
  const [meetings, setMeetings] = React.useState<Meeting[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!hasOverview) {
      setEvents([]);
      setMeetings([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    (async () => {
      const start = new Date(`${today}T00:00:00`);
      const end = new Date(`${today}T23:59:59.999`);
      try {
        const [nextEvents, nextMeetings] = await Promise.all([
          window.cofounderos.listDayEvents({ day: today, limit: 200 }).catch(() => []),
          window.cofounderos
            .listMeetings({
              from: start.toISOString(),
              to: end.toISOString(),
              limit: 100,
            })
            .catch(() => []),
        ]);
        if (cancelled) return;
        setEvents(nextEvents.filter((event) => event.title !== '__merged__'));
        setMeetings(
          nextMeetings
            .filter((meeting) => meeting.day === today)
            .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at)),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasOverview, today, eventsToday, refreshKey]);

  return { events, meetings, loading };
}

function useActionCenter(overview: RuntimeOverview | null): {
  center: RuntimeActionCenter | null;
  loading: boolean;
} {
  const today = localDayKey();
  const hasOverview = overview !== null;
  const eventsToday = overview?.capture.eventsToday ?? 0;
  const eventBucket = Math.floor(eventsToday / 5);
  const refreshKey = React.useMemo(() => {
    if (!overview) return '';
    return (overview.backgroundJobs ?? [])
      .filter((job) =>
        ['event-extractor', 'meeting-builder', 'meeting-summarizer'].includes(job.name),
      )
      .map((job) => `${job.name}:${job.lastCompletedAt ?? ''}:${job.runCount}`)
      .join('|');
  }, [overview]);
  const [center, setCenter] = React.useState<RuntimeActionCenter | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!hasOverview) {
      setCenter(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const next = await window.cofounderos.getActionCenter({ day: today });
        if (!cancelled) setCenter(next);
      } catch {
        if (!cancelled) setCenter(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [eventBucket, hasOverview, refreshKey, today]);

  return { center, loading };
}

type FounderAgendaTarget = { eventId: string; day: string };

type FounderCardItem = { title: string; meta?: string; eventId?: string; day?: string };

type FounderCard = {
  title: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  empty: string;
  items: FounderCardItem[];
};

function buildFounderCards(
  journal: JournalDay | null,
  events: DayEvent[],
  meetings: Meeting[],
): FounderCard[] {
  const now = Date.now();
  const chronological = events
    .slice()
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const summarySignals = collectMeetingSummarySignals(meetings);
  const actions = summarySignals.actionItems.map((item) => ({
    title: actionItemLabel(item),
    meta: item.due ? `Due ${item.due}` : 'From meeting summary',
  }));
  const openQuestions = summarySignals.openQuestions.map((question) => ({
    title: question.text,
    meta: 'Open question',
  }));
  const decisions = summarySignals.decisions.map((decision) => ({
    title: decision.text,
    meta: 'Decision',
  }));
  const replyEvents = chronological
    .filter((event) =>
      isRelevantSignalEvent(event) &&
      (event.kind === 'communication' ||
        event.source === 'email_screen' ||
        event.source === 'slack_screen'),
    )
    .map(signalItemForEvent);
  const taskEvents = chronological
    .filter((event) => event.kind === 'task' && isRelevantSignalEvent(event))
    .map(signalItemForEvent);
  const recentChanges = chronological
    .filter(
      (event) =>
        event.kind !== 'meeting' &&
        Date.parse(event.starts_at) <= now &&
        isRelevantSignalEvent(event),
    )
    .slice(-4)
    .reverse()
    .map(signalItemForEvent);
  const topApps =
    journal && journal.frames.length > 0
      ? countByApp(journal.frames)
          .slice(0, 3)
          .map((row) => ({
            title: row.app,
            meta: `${formatNumber(row.count)} moment${row.count === 1 ? '' : 's'}`,
          }))
      : [];

  return [
    {
      title: 'What changed',
      label: `${recentChanges.length || topApps.length}`,
      icon: Zap,
      accent: 'text-primary',
      empty: 'Nothing notable has surfaced yet today.',
      items: recentChanges.length > 0 ? recentChanges : topApps,
    },
    {
      title: 'Replies',
      label: `${replyEvents.length}`,
      icon: Inbox,
      accent: 'text-blue-500 dark:text-blue-300',
      empty: 'No inbox or Slack replies detected yet.',
      items: replyEvents,
    },
    {
      title: 'Promises',
      label: `${actions.length + taskEvents.length}`,
      icon: CheckSquare,
      accent: 'text-emerald-500 dark:text-emerald-300',
      empty: 'No tasks or meeting action items found yet.',
      items: [...actions, ...taskEvents],
    },
    {
      title: 'Follow up',
      label: `${openQuestions.length + decisions.length}`,
      icon: AlertCircle,
      accent: 'text-amber-500 dark:text-amber-300',
      empty: 'No open questions or decisions to chase.',
      items: [...openQuestions, ...decisions],
    },
  ];
}

function eventMeta(event: DayEvent): string {
  const time = formatLocalTime(event.starts_at);
  const source = event.source_app || dayEventSourceShortLabel(event.source);
  return [time, source].filter(Boolean).join(' · ');
}

function signalItemForEvent(event: DayEvent): FounderCardItem {
  return {
    title: signalTitleForEvent(event),
    meta: eventMeta(event),
    eventId: event.id,
    day: event.day,
  };
}

function signalTitleForEvent(event: DayEvent): string {
  const title = event.title.trim();
  if (!isLowSignalText(title)) return title;
  const context = cleanSignalContext(event.context_md);
  if (context) return context;
  return event.source_app || dayEventSourceShortLabel(event.source);
}

function isRelevantSignalEvent(event: DayEvent): boolean {
  if (event.title === '__merged__') return false;
  if (!isLowSignalText(event.title)) return true;
  return cleanSignalContext(event.context_md).length > 0;
}

function cleanSignalContext(value?: string | null): string {
  const cleaned = stripMarkdown(value).trim();
  if (isLowSignalText(cleaned)) return '';
  if (/^visible in .+ accessibility text\.?$/i.test(cleaned)) return '';
  return cleaned;
}

function isLowSignalText(value?: string | null): boolean {
  const cleaned = stripMarkdown(value).trim();
  if (!cleaned) return true;
  const lower = cleaned.toLowerCase();
  return (
    lower === 'n/a' ||
    lower === 'na' ||
    lower === 'none' ||
    lower === 'unknown' ||
    lower === 'untitled' ||
    lower === '__merged__' ||
    /^no (summary|context|title) available/.test(lower)
  );
}

type TodayHomeProps = {
  overview: RuntimeOverview;
  captureLive: boolean;
  capturePaused: boolean;
  running: boolean;
  journal: JournalDay | null;
  loading: boolean;
  actionCenter: RuntimeActionCenter | null;
  actionLoading: boolean;
  events: DayEvent[];
  meetings: Meeting[];
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onSearch: (query: string) => void;
  onGoMeetings: (target?: FounderAgendaTarget | null) => void;
};

function TodayHome({
  overview,
  captureLive,
  capturePaused,
  running,
  journal,
  loading,
  actionCenter,
  actionLoading,
  events,
  meetings,
  onStart,
  onStop,
  onPause,
  onResume,
  onSearch,
  onGoMeetings,
}: TodayHomeProps) {
  const founderCards = React.useMemo(
    () => buildFounderCards(journal, events, meetings),
    [journal, events, meetings],
  );
  const briefs = React.useMemo(
    () => buildTimelyBriefs(meetings, founderCards),
    [meetings, founderCards],
  );
  const timeline = React.useMemo(
    () => buildTimelineItems(journal, events),
    [journal, events],
  );

  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        <QuickSearchPanel onSearch={onSearch} />

        <ActionCenterPanel
          center={actionCenter}
          loading={actionLoading}
          onSearch={onSearch}
        />

        <TimelyBriefsPanel
          briefs={briefs}
          onOpenItem={(item) =>
            item.eventId && item.day ? onGoMeetings({ eventId: item.eventId, day: item.day }) : null
          }
        />

        <ActivityTimeline
          items={timeline}
          loading={loading}
          onOpenEvent={(event) => onGoMeetings({ eventId: event.id, day: event.day })}
        />
      </div>

      <aside className="flex min-w-0 flex-col gap-4">
        <CapturePanel
          overview={overview}
          captureLive={captureLive}
          capturePaused={capturePaused}
          running={running}
          journal={journal}
          onStart={onStart}
          onStop={onStop}
          onPause={onPause}
          onResume={onResume}
        />
        <MemorySnapshot overview={overview} journal={journal} loading={loading} />
      </aside>
    </section>
  );
}

function QuickSearchPanel({ onSearch }: { onSearch: (query: string) => void }) {
  const [query, setQuery] = React.useState('');
  const suggestions = [
    'what changed today',
    'open loops today',
    'meetings today',
    'what was I doing this morning',
  ];

  function submit(value = query) {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSearch(trimmed);
  }

  return (
    <section className="rounded-lg border bg-card/70 p-4 shadow-card">
      <form
        className="flex flex-col gap-3 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search memory..."
            className="h-11 rounded-lg pl-9 text-base"
          />
        </div>
        <Button type="submit" className="h-11 sm:w-28">
          <SearchIcon />
          Search
        </Button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => submit(suggestion)}
            className="rounded-md border bg-background/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/35 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </section>
  );
}

function ActionCenterPanel({
  center,
  loading,
  onSearch,
}: {
  center: RuntimeActionCenter | null;
  loading: boolean;
  onSearch: (query: string) => void;
}) {
  if (loading && !center) {
    return (
      <section className="rounded-lg border bg-card/70 p-4 shadow-card">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-2 h-3 w-56" />
          </div>
          <Loader2 className="size-4 animate-spin text-primary" />
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-28 rounded-md" />
          <Skeleton className="h-28 rounded-md" />
          <Skeleton className="h-28 rounded-md" />
        </div>
      </section>
    );
  }

  if (!center) return null;
  const total = center.followups.length + center.projects.length + center.meetingBridges.length;
  if (total === 0) return null;

  return (
    <section className="rounded-lg border bg-card p-5 shadow-card">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold leading-6">Action center</h3>
            <span className={cn(
              'rounded-md border px-2 py-0.5 text-xs font-medium uppercase',
              center.source === 'llm'
                ? 'border-primary/25 bg-primary/10 text-primary'
                : 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
            )}>
              {center.source === 'llm' ? 'Local LLM' : 'Fallback'}
            </span>
          </div>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            Follow-ups, project memory, and meeting-to-work links.
          </p>
        </div>
        {loading ? <Loader2 className="size-5 animate-spin text-primary" /> : <Wand2 className="size-5 text-primary" />}
      </div>

      <div className="grid gap-5 xl:grid-cols-2 2xl:grid-cols-3">
        <ActionColumn
          title="Follow-up radar"
          icon={Inbox}
          accent="text-emerald-500 dark:text-emerald-300"
          empty="No follow-ups surfaced."
        >
          {center.followups.slice(0, 5).map((item, index) => (
            <FollowupRow
              key={`${item.title}-${index}`}
              item={item}
              onOpen={() => onSearch(item.title)}
            />
          ))}
        </ActionColumn>

        <ActionColumn
          title="Active projects"
          icon={FolderOpen}
          accent="text-blue-500 dark:text-blue-300"
          empty="No active projects surfaced."
        >
          {center.projects.slice(0, 4).map((project) => (
            <ProjectRow
              key={project.path}
              project={project}
              onOpen={() => onSearch(project.title)}
            />
          ))}
        </ActionColumn>

        <ActionColumn
          title="Meeting to work"
          icon={MessageSquare}
          accent="text-amber-500 dark:text-amber-300"
          empty="No meeting-to-work links yet."
        >
          {center.meetingBridges.slice(0, 4).map((bridge) => (
            <BridgeRow
              key={bridge.meetingId}
              bridge={bridge}
              onOpen={() => onSearch(bridge.title)}
            />
          ))}
        </ActionColumn>
      </div>
    </section>
  );
}

function ActionColumn({
  title,
  icon: Icon,
  accent,
  empty,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  empty: string;
  children: React.ReactNode;
}) {
  const count = React.Children.count(children);
  return (
    <div className="min-w-0 border-t pt-4">
      <div className="mb-3 flex items-center gap-2">
        <span className={cn('grid size-8 shrink-0 place-items-center rounded-md bg-muted', accent)}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 text-base font-semibold leading-6">{title}</div>
        <Badge variant={count > 0 ? 'outline' : 'muted'} className="ml-auto min-w-8 shrink-0">
          {count}
        </Badge>
      </div>
      {count > 0 ? (
        <div className="flex flex-col gap-3">{children}</div>
      ) : (
        <p className="rounded-md border border-dashed border-border/70 bg-background/35 p-3 text-sm leading-5 text-muted-foreground">
          {empty}
        </p>
      )}
    </div>
  );
}

function FollowupRow({
  item,
  onOpen,
}: {
  item: RuntimeActionCenterFollowup;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={actionItemButtonClass}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="line-clamp-3 min-w-0 break-words text-[15px] font-semibold leading-5 text-foreground">
          {cleanActionText(item.title) || followupCategoryLabel(item.category)}
        </span>
        <span className={cn(
          'mt-0.5 shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium',
          urgencyClass(item.urgency),
        )}>
          {followupCategoryLabel(item.category)}
        </span>
      </div>
      {cleanActionText(item.body) ? (
        <p className="mt-2 line-clamp-3 break-words text-sm leading-5 text-foreground/75">
          {cleanActionText(item.body)}
        </p>
      ) : null}
      <EvidenceHint className="mt-3" />
    </button>
  );
}

function ProjectRow({
  project,
  onOpen,
}: {
  project: RuntimeActionCenterProject;
  onOpen: () => void;
}) {
  const title = projectTitle(project);
  const summary = cleanActionText(project.summary);
  const nextAction = project.nextActions.map(cleanActionText).find(Boolean);
  const status = cleanActionText(project.status);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={actionItemButtonClass}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <span className="line-clamp-2 min-w-0 break-words text-[15px] font-semibold leading-5 text-foreground">
          {title}
        </span>
        {project.kind ? (
          <span className="mt-0.5 shrink-0 rounded-md border border-border/70 bg-muted/45 px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {kindLabel(project.kind)}
          </span>
        ) : null}
      </div>
      {summary ? (
        <p className="mt-2 line-clamp-3 break-words text-sm leading-5 text-foreground/75">
          {summary}
        </p>
      ) : null}
      {nextAction ? (
        <p className="mt-3 rounded-md bg-muted/45 px-2.5 py-2 text-sm leading-5 text-foreground/75">
          <span className="font-medium text-foreground">Next: </span>
          <span className="break-words">{nextAction}</span>
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        {status ? (
          <span className="text-xs leading-4 text-muted-foreground">
            {status}
          </span>
        ) : null}
        <EvidenceHint />
      </div>
    </button>
  );
}

function BridgeRow({
  bridge,
  onOpen,
}: {
  bridge: RuntimeMeetingWorkBridge;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={actionItemButtonClass}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="line-clamp-2 min-w-0 break-words text-[15px] font-semibold leading-5 text-foreground">
          {cleanActionText(bridge.title) || 'Meeting follow-up'}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatLocalTime(bridge.startedAt)}
        </span>
      </div>
      {cleanActionText(bridge.summary) ? (
        <p className="mt-2 line-clamp-3 break-words text-sm leading-5 text-foreground/75">
          {cleanActionText(bridge.summary)}
        </p>
      ) : null}
      {bridge.followups.length > 0 ? (
        <p className="mt-3 rounded-md bg-muted/45 px-2.5 py-2 text-sm leading-5 text-foreground/75">
          <span className="font-medium text-foreground">Follow-up: </span>
          <span className="break-words">{cleanActionText(bridge.followups[0])}</span>
        </p>
      ) : bridge.workAfter.length > 0 ? (
        <p className="mt-3 rounded-md bg-muted/45 px-2.5 py-2 text-sm leading-5 text-foreground/75">
          <span className="font-medium text-foreground">After: </span>
          <span className="break-words">{cleanActionText(bridge.workAfter[0])}</span>
        </p>
      ) : null}
      <EvidenceHint className="mt-3" />
    </button>
  );
}

function EvidenceHint({ className }: { className?: string }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 text-xs font-medium text-primary/90 group-hover:text-primary',
      className,
    )}>
      Search evidence
      <ArrowRight className="size-3" />
    </span>
  );
}

function cleanActionText(value?: string | null): string {
  return stripMarkdown(value).replace(/\s+/g, ' ').trim();
}

function urgencyClass(urgency: RuntimeActionCenterFollowup['urgency']): string {
  switch (urgency) {
    case 'high':
      return 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300';
    case 'medium':
      return 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300';
    case 'low':
      return 'border-muted bg-muted/60 text-muted-foreground';
  }
}

function followupCategoryLabel(category: RuntimeActionCenterFollowup['category']): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function projectTitle(project: RuntimeActionCenterProject): string {
  const title = cleanActionText(project.title);
  if (title) return title;

  const summaryApp = cleanActionText(project.summary).match(/^([^:]{2,48}):/);
  if (summaryApp?.[1]) return summaryApp[1];

  const pathName = project.path.split(/[\\/]/).filter(Boolean).at(-1);
  return pathName || kindLabel(project.kind) || 'Active project';
}

type TimelyBriefItem = {
  id: string;
  title: string;
  body: string;
  meta: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  eventId?: string;
  day?: string;
};

function TimelyBriefsPanel({
  briefs,
  onOpenItem,
}: {
  briefs: TimelyBriefItem[];
  onOpenItem: (item: TimelyBriefItem) => void;
}) {
  if (briefs.length === 0) return null;

  return (
    <section className="rounded-lg border bg-card/70 p-4 shadow-card">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Insights</h3>
          <p className="text-xs text-muted-foreground">Actionable context that is not already on the timeline.</p>
        </div>
        <Sparkles className="size-4 text-primary" />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {briefs.map((brief) => {
          const Icon = brief.icon;
          const clickable = Boolean(brief.eventId && brief.day);
          return (
            <button
              key={brief.id}
              type="button"
              onClick={() => clickable && onOpenItem(brief)}
              className={cn(
                'min-w-0 rounded-lg border bg-background/55 p-3 text-left transition-colors',
                clickable
                  ? 'hover:border-primary/35 hover:bg-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
                  : 'cursor-default',
              )}
            >
              <div className="flex items-start gap-3">
                <span
                  className={cn(
                    'grid size-8 shrink-0 place-items-center rounded-md bg-muted',
                    brief.accent,
                  )}
                >
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0">
                  <div className="line-clamp-1 text-sm font-medium">{brief.title}</div>
                  <p className="mt-1 line-clamp-2 text-sm leading-snug text-muted-foreground">
                    {brief.body}
                  </p>
                  <div className="mt-2 truncate text-[11px] text-muted-foreground">
                    {brief.meta}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function CapturePanel({
  overview,
  captureLive,
  capturePaused,
  running,
  journal,
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
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
}) {
  const activeMinutes = totalActiveMinutes(journal?.sessions ?? []);
  let status = 'Ready';
  let tone: 'live' | 'paused' | 'idle' = 'idle';
  if (captureLive) {
    status = 'Live';
    tone = 'live';
  } else if (capturePaused) {
    status = 'Paused';
    tone = 'paused';
  } else if (!running) {
    status = 'Stopped';
  }

  return (
    <section className="rounded-lg border bg-card/70 p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <StatusBadge tone={tone}>{status}</StatusBadge>
          <h3 className="mt-3 text-lg font-semibold">
            {captureLive ? 'Capturing today' : capturePaused ? 'Capture paused' : 'Capture ready'}
          </h3>
        </div>
        <div className="flex items-center gap-1.5">
          {!running && (
            <Button size="icon" onClick={() => void onStart()} title="Start capturing">
              <Play />
            </Button>
          )}
          {running && captureLive && (
            <Button size="icon" variant="secondary" onClick={() => void onPause()} title="Pause">
              <Pause />
            </Button>
          )}
          {running && capturePaused && (
            <Button size="icon" onClick={() => void onResume()} title="Resume">
              <Play />
            </Button>
          )}
          {running && (
            <Button size="icon" variant="ghost" onClick={() => void onStop()} title="Stop">
              <CircleStop />
            </Button>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <MiniStat label="Moments" value={formatNumber(overview.capture.eventsToday)} />
        <MiniStat
          label="Last hour"
          value={
            typeof overview.capture.eventsLastHour === 'number'
              ? formatNumber(overview.capture.eventsLastHour)
              : '-'
          }
        />
        <MiniStat label="Active" value={formatActiveMinutes(activeMinutes)} />
      </div>

      <ActivityBars
        frames={journal?.frames ?? []}
        loading={false}
        accent={captureLive}
      />
    </section>
  );
}

function MemorySnapshot({
  overview,
  journal,
  loading,
}: {
  overview: RuntimeOverview;
  journal: JournalDay | null;
  loading: boolean;
}) {
  const apps = journal ? countByApp(journal.frames).slice(0, 3) : [];
  const total = Math.max(1, journal?.frames.length ?? overview.capture.eventsToday);

  return (
    <section className="rounded-lg border bg-card/70 p-4 shadow-card">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Memory snapshot</h3>
        {overview.indexing.running ? (
          <span className="inline-flex items-center gap-1 text-xs text-primary">
            <Loader2 className="size-3 animate-spin" />
            Indexing
          </span>
        ) : (
          <FileText className="size-4 text-muted-foreground" />
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <BigStat value={formatNumber(overview.index.pageCount)} label="pages" />
        <BigStat value={formatNumber(overview.storage.totalEvents)} label="memories" muted />
      </div>

      <Separator className="my-4" />

      {loading && !journal ? (
        <BarsSkeleton />
      ) : apps.length === 0 ? (
        <p className="text-sm text-muted-foreground">Top apps will appear as memory builds.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {apps.map((row, index) => (
            <AppBar
              key={row.app}
              app={row.app}
              count={row.count}
              percent={(row.count / total) * 100}
              rank={index}
            />
          ))}
        </div>
      )}
    </section>
  );
}

type TimelineItem = {
  id: string;
  at: string;
  title: string;
  meta: string;
  description?: string;
  bucket: 'upcoming' | 'history';
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  frame?: Frame;
  event?: DayEvent;
};

function ActivityTimeline({
  items,
  loading,
  onOpenEvent,
}: {
  items: TimelineItem[];
  loading: boolean;
  onOpenEvent: (event: DayEvent) => void;
}) {
  const detail = useFrameDetail();

  return (
    <section className="rounded-lg border bg-card/70 p-4 shadow-card">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Activity timeline</h3>
          <p className="text-xs text-muted-foreground">Soonest upcoming, then recent captured history.</p>
        </div>
        <History className="size-4 text-muted-foreground" />
      </div>

      {loading && items.length === 0 ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="size-8 rounded-md" />
              <div className="flex-1">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="mt-2 h-3 w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recent or upcoming activity captured yet today.</p>
      ) : (
        <div className="relative flex flex-col gap-1">
          <div className="absolute bottom-3 left-[15px] top-3 w-px bg-border" />
          {items.map((item, index) => {
            const Icon = item.icon;
            const clickable = Boolean(item.frame || item.event);
            const showLabel = index === 0 || items[index - 1]?.bucket !== item.bucket;
            return (
              <React.Fragment key={item.id}>
                {showLabel ? (
                  <div className="relative z-10 ml-11 mt-2 text-[10px] font-medium uppercase text-muted-foreground first:mt-0">
                    {item.bucket === 'upcoming' ? 'Up next' : 'Recent history'}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    if (item.frame) detail.open(item.frame);
                    else if (item.event) onOpenEvent(item.event);
                  }}
                  className={cn(
                    'relative flex min-w-0 gap-3 rounded-md px-1 py-2 text-left transition-colors',
                    clickable
                      ? 'hover:bg-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
                      : 'cursor-default',
                  )}
                >
                  <span className={cn('z-10 grid size-8 shrink-0 place-items-center rounded-md bg-muted', item.accent)}>
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center justify-between gap-3">
                      <span className="line-clamp-1 text-sm font-medium">{item.title}</span>
                      <span className="shrink-0 text-[11px] tabular text-muted-foreground">
                        {formatLocalTime(item.at)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {item.meta}
                    </span>
                    {item.description ? (
                      <span className="mt-1 block line-clamp-2 text-sm leading-snug text-muted-foreground">
                        {item.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </section>
  );
}

function buildTimelyBriefs(
  meetings: Meeting[],
  cards: FounderCard[],
): TimelyBriefItem[] {
  const byTitle = new Map(cards.map((card) => [card.title, card]));
  const replies = byTitle.get('Replies');
  const promises = byTitle.get('Promises');
  const followUp = byTitle.get('Follow up');
  const readyMeetings = meetings.filter((meeting) => meeting.summary_status === 'ready');
  const briefs: TimelyBriefItem[] = [];

  if (readyMeetings.length > 0) {
    const latest = readyMeetings
      .slice()
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0]!;
    briefs.push({
      id: `meeting-${latest.id}`,
      title: 'Meeting summary ready',
      body: latest.summary_json?.tldr || latest.title || platformLabel(latest.platform),
      meta: `${formatLocalTime(latest.started_at)} · ${platformLabel(latest.platform)}`,
      icon: MessageSquare,
      accent: 'text-blue-500 dark:text-blue-300',
    });
  }

  if (promises && promises.items.length > 0) {
    briefs.push({
      id: 'promises',
      title: `${promises.items.length} promise${promises.items.length === 1 ? '' : 's'} to track`,
      body: promises.items[0]?.title ?? 'Meeting action items and task captures are ready.',
      meta: promises.items[0]?.meta ?? 'Tasks and summaries',
      icon: CheckSquare,
      accent: 'text-emerald-500 dark:text-emerald-300',
      eventId: promises.items[0]?.eventId,
      day: promises.items[0]?.day,
    });
  }

  if (followUp && followUp.items.length > 0) {
    briefs.push({
      id: 'follow-up',
      title: `${followUp.items.length} follow-up${followUp.items.length === 1 ? '' : 's'} surfaced`,
      body: followUp.items[0]?.title ?? 'Open questions and next calendar items are ready.',
      meta: followUp.items[0]?.meta ?? 'Open loops',
      icon: AlertCircle,
      accent: 'text-amber-500 dark:text-amber-300',
      eventId: followUp.items[0]?.eventId,
      day: followUp.items[0]?.day,
    });
  }

  if (replies && replies.items.length > 0) {
    briefs.push({
      id: 'replies',
      title: `${replies.items.length} reply signal${replies.items.length === 1 ? '' : 's'}`,
      body: replies.items[0]?.title ?? 'Inbox and chat activity surfaced from capture.',
      meta: replies.items[0]?.meta ?? 'Communication',
      icon: Inbox,
      accent: 'text-blue-500 dark:text-blue-300',
      eventId: replies.items[0]?.eventId,
      day: replies.items[0]?.day,
    });
  }

  if (briefs.length === 0) {
    return [];
  }

  return briefs.slice(0, 4);
}

function buildTimelineItems(journal: JournalDay | null, events: DayEvent[]): TimelineItem[] {
  const now = Date.now();
  const upcoming: TimelineItem[] = [];
  const history: TimelineItem[] = [];

  for (const event of events) {
    const ts = Date.parse(event.starts_at);
    if (!Number.isFinite(ts)) continue;
    if (!isRelevantSignalEvent(event)) continue;
    const description = cleanSignalContext(event.context_md);
    const bucket: TimelineItem['bucket'] = ts >= now ? 'upcoming' : 'history';
    const item: TimelineItem = {
      id: `event-${event.id}`,
      at: event.starts_at,
      title: signalTitleForEvent(event),
      meta: [kindLabel(event.kind), eventMeta(event)].filter(Boolean).join(' · '),
      description: description.slice(0, 180),
      bucket,
      icon: iconForDayEvent(event),
      accent: accentForDayEvent(event),
      event,
    };
    if (bucket === 'upcoming') upcoming.push(item);
    else history.push(item);
  }

  for (const session of journal?.sessions ?? []) {
    if (!session.started_at) continue;
    const ts = Date.parse(session.started_at);
    if (!Number.isFinite(ts) || ts > now) continue;
    const activeMs = session.active_ms ?? 0;
    const frameCount = session.frame_count ?? 0;
    history.push({
      id: `session-${session.id ?? session.started_at}`,
      at: session.started_at,
      title: focusLabel(session),
      meta: `${formatActiveMinutes(Math.round(activeMs / 60000))} · ${formatNumber(frameCount)} moment${frameCount === 1 ? '' : 's'}`,
      description: session.primary_entity_path
        ? prettyEntityPath(session.primary_entity_path)
        : undefined,
      bucket: 'history',
      icon: Clock,
      accent: 'text-primary',
    });
  }

  const frames = (journal?.frames ?? [])
    .filter((frame) => frame.timestamp)
    .slice()
    .sort((a, b) => Date.parse(b.timestamp ?? '') - Date.parse(a.timestamp ?? ''))
    .slice(0, TIMELINE_RECENT_LIMIT);
  for (const frame of frames) {
    if (!frame.timestamp) continue;
    const ts = Date.parse(frame.timestamp);
    if (!Number.isFinite(ts) || ts > now) continue;
    history.push({
      id: `frame-${frame.id ?? frame.timestamp}`,
      at: frame.timestamp,
      title: frame.window_title || frame.entity_path || frame.url || frame.app || 'Captured moment',
      meta: [frame.app, frame.entity_kind ? kindLabel(frame.entity_kind) : null]
        .filter(Boolean)
        .join(' · '),
      bucket: 'history',
      icon: frame.text_source === 'audio' || frame.app === 'Audio' ? Mic : FileText,
      accent: 'text-muted-foreground',
      frame,
    });
  }

  const soonestUpcoming = upcoming
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(0, TIMELINE_UPCOMING_LIMIT);
  const recentHistory = history
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, TIMELINE_RECENT_LIMIT);

  return [...soonestUpcoming, ...recentHistory];
}

function stripMarkdown(value?: string | null): string {
  if (!value) return '';
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function kindLabel(kind: string): string {
  return kind
    .split(/[_-]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function iconForDayEvent(event: DayEvent): React.ComponentType<{ className?: string }> {
  if (event.kind === 'meeting' || event.kind === 'calendar') return Calendar;
  if (event.kind === 'communication') return MessageSquare;
  if (event.kind === 'task') return CheckSquare;
  return Zap;
}

function accentForDayEvent(event: DayEvent): string {
  if (event.kind === 'meeting' || event.kind === 'calendar') {
    return 'text-amber-500 dark:text-amber-300';
  }
  if (event.kind === 'communication') return 'text-blue-500 dark:text-blue-300';
  if (event.kind === 'task') return 'text-emerald-500 dark:text-emerald-300';
  return 'text-primary';
}

function focusLabel(session: ActivitySession): string {
  if (session.primary_entity_path) return prettyEntityPath(session.primary_entity_path);
  if (session.primary_app) return session.primary_app;
  return 'Focused work session';
}

function prettyEntityPath(path: string): string {
  const tail = path.split('/').filter(Boolean).pop() ?? path;
  return tail
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function platformLabel(platform: Meeting['platform']): string {
  const labels: Record<Meeting['platform'], string> = {
    zoom: 'Zoom',
    meet: 'Google Meet',
    teams: 'Teams',
    webex: 'Webex',
    whereby: 'Whereby',
    around: 'Around',
    other: 'Meeting',
  };
  return labels[platform] ?? 'Meeting';
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

/* ──────────────────────────────────────────────────────────────────────────
   ActivityBars
   24-hour bar visualization showing capture density per hour. Replaces a
   bullet stat with a real visualization — a non-technical user sees
   at-a-glance "I was busy this morning, quiet over lunch, picked up again".
   ────────────────────────────────────────────────────────────────────── */
function ActivityBars({
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
