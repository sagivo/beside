import * as React from 'react';
import {
  Calendar,
  CalendarClock,
  CheckSquare,
  ChevronRight,
  Clock,
  Inbox,
  Loader2,
  MessageSquare,
  Mic,
  RefreshCcw,
  Sparkles,
  Users,
  Video,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { PageHeader } from '@/components/PageHeader';
import { Markdown } from '@/components/Markdown';
import { formatLocalTime, prettyDay } from '@/lib/format';
import { cn } from '@/lib/utils';
import type {
  DayEvent,
  DayEventKind,
  DayEventSource,
  Meeting,
  MeetingPlatform,
} from '@/global';

// ---------------------------------------------------------------------------
// Time / duration helpers (kept around because the meeting-detail panel
// still needs them when a `kind=meeting` event is selected).
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const totalMin = Math.max(1, Math.round(ms / 60_000));
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function platformLabel(platform: MeetingPlatform): string {
  const map: Record<MeetingPlatform, string> = {
    zoom: 'Zoom',
    meet: 'Google Meet',
    teams: 'Teams',
    webex: 'Webex',
    whereby: 'Whereby',
    around: 'Around',
    other: 'Meeting',
  };
  return map[platform] ?? 'Meeting';
}

// ---------------------------------------------------------------------------
// DayEvent presentation helpers.
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<DayEventKind, string> = {
  meeting: 'Meeting',
  calendar: 'Calendar',
  communication: 'Communication',
  task: 'Task',
  other: 'Event',
};

const SOURCE_LABELS: Record<DayEventSource, string> = {
  meeting_capture: 'Captured call',
  calendar_screen: 'Seen on calendar',
  email_screen: 'Seen in inbox',
  slack_screen: 'Seen in Slack',
  task_screen: 'Seen in tasks',
  other_screen: 'Seen on screen',
};

const KIND_COLOR: Record<DayEventKind, string> = {
  meeting: 'text-red-500 dark:text-red-300',
  calendar: 'text-amber-500 dark:text-amber-300',
  communication: 'text-blue-500 dark:text-blue-300',
  task: 'text-emerald-500 dark:text-emerald-300',
  other: 'text-muted-foreground',
};

function KindIcon({
  kind,
  className,
}: {
  kind: DayEventKind;
  className?: string;
}) {
  const Cmp = (() => {
    switch (kind) {
      case 'meeting':
        return Video;
      case 'calendar':
        return CalendarClock;
      case 'communication':
        return MessageSquare;
      case 'task':
        return CheckSquare;
      default:
        return Sparkles;
    }
  })();
  return <Cmp className={cn('size-3.5', className)} />;
}

function eventDuration(event: DayEvent): number | null {
  if (!event.ends_at) return null;
  const ms = Date.parse(event.ends_at) - Date.parse(event.starts_at);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function groupByDay(events: DayEvent[]): Array<{ day: string; items: DayEvent[] }> {
  const map = new Map<string, DayEvent[]>();
  for (const ev of events) {
    const bucket = map.get(ev.day);
    if (bucket) bucket.push(ev);
    else map.set(ev.day, [ev]);
  }
  const days = Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  return days.map(([day, items]) => ({
    day,
    items: items.slice().sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
  }));
}

/**
 * Hide near-duplicate events the same day-bucket can accumulate over
 * many extraction passes: identical title + same hour ± 5 minutes is
 * almost certainly the same underlying calendar entry surfaced twice.
 */
function dedupeEvents(events: DayEvent[]): DayEvent[] {
  const seen = new Map<string, DayEvent>();
  for (const ev of events) {
    const minute = Math.floor(Date.parse(ev.starts_at) / 60_000);
    // Snap to a 5-minute bucket so the same event captured a few
    // refreshes apart still collides.
    const bucket = Math.round(minute / 5) * 5;
    const key = [
      ev.day,
      ev.kind,
      bucket,
      ev.title.trim().toLowerCase(),
    ].join('|');
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, ev);
      continue;
    }
    // Prefer the meeting-sourced event (richest data) when titles
    // collide across sources.
    if (existing.kind !== 'meeting' && ev.kind === 'meeting') {
      seen.set(key, ev);
    }
  }
  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Screen.
// ---------------------------------------------------------------------------

export function Meetings({
  events,
  meetings,
  loading,
  onRefresh,
}: {
  events: DayEvent[];
  meetings: Meeting[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const meetingsById = React.useMemo(() => {
    const map = new Map<string, Meeting>();
    for (const m of meetings) map.set(m.id, m);
    return map;
  }, [meetings]);

  const visible = React.useMemo(() => dedupeEvents(events), [events]);
  const groups = React.useMemo(() => groupByDay(visible), [visible]);
  const selected = visible.find((e) => e.id === selectedId) ?? null;

  React.useEffect(() => {
    if (selectedId && !visible.find((e) => e.id === selectedId)) {
      setSelectedId(null);
    }
  }, [visible, selectedId]);

  // First load auto-selects the most recent event so the detail panel
  // isn't a wall of "Select an event…".
  React.useEffect(() => {
    if (!selectedId && visible.length > 0) {
      const today = groups[0]?.items;
      const pick = today?.[today.length - 1] ?? visible[0];
      if (pick) setSelectedId(pick.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length]);

  return (
    <div className="flex flex-col gap-6 pt-6">
      <PageHeader
        title="Event log"
        description="Meetings, calendar entries, and events extracted from what you've seen on screen."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
            className="gap-1.5"
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="size-3.5" />
            )}
            Refresh
          </Button>
        }
      />

      {loading && visible.length === 0 ? (
        <div className="grid min-h-[30vh] place-items-center text-muted-foreground text-sm gap-2">
          <Loader2 className="size-5 animate-spin" />
          Loading events…
        </div>
      ) : visible.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex gap-4 min-h-0">
          {/* Left: per-day event list */}
          <div className="w-80 shrink-0 flex flex-col gap-2">
            <ScrollArea className="h-[calc(100vh-14rem)]">
              <div className="flex flex-col gap-5 pr-2">
                {groups.map(({ day, items }) => (
                  <div key={day} className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2 px-1 mb-1 sticky top-0 bg-background/95 backdrop-blur py-1">
                      <Calendar className="size-3 text-muted-foreground" />
                      <span className="text-xs font-medium text-muted-foreground">
                        {prettyDay(day)}
                      </span>
                      <span className="ml-auto text-[10px] text-muted-foreground/60">
                        {items.length} {items.length === 1 ? 'event' : 'events'}
                      </span>
                    </div>
                    {items.map((event) => (
                      <EventRow
                        key={event.id}
                        event={event}
                        active={event.id === selectedId}
                        onClick={() =>
                          setSelectedId(event.id === selectedId ? null : event.id)
                        }
                        meeting={
                          event.meeting_id
                            ? meetingsById.get(event.meeting_id) ?? null
                            : null
                        }
                      />
                    ))}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>

          <Separator orientation="vertical" className="h-auto self-stretch" />

          {/* Right: detail */}
          <div className="flex-1 min-w-0">
            {selected ? (
              <EventDetail
                event={selected}
                meeting={
                  selected.meeting_id
                    ? meetingsById.get(selected.meeting_id) ?? null
                    : null
                }
              />
            ) : (
              <div className="grid h-full place-items-center text-muted-foreground text-sm">
                Select an event to see its details
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Left-pane list row.
// ---------------------------------------------------------------------------

function EventRow({
  event,
  active,
  onClick,
  meeting,
}: {
  event: DayEvent;
  active: boolean;
  onClick: () => void;
  meeting: Meeting | null;
}) {
  const duration = eventDuration(event);
  const sourceLabel = SOURCE_LABELS[event.source] ?? event.source;
  const hasAudio = meeting ? meeting.audio_chunk_count > 0 : false;
  const hasTranscript = meeting ? meeting.transcript_chars > 0 : false;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group w-full text-left rounded-lg border px-3 py-2.5 transition-colors',
        active
          ? 'border-primary/40 bg-primary/5 text-foreground'
          : 'border-border bg-card hover:bg-accent/50 text-foreground',
      )}
    >
      <div className="flex items-start gap-2.5">
        {/* Time column */}
        <div className="flex flex-col items-start min-w-12 pt-0.5">
          <span className="text-xs font-medium tabular-nums">
            {formatLocalTime(event.starts_at)}
          </span>
          {duration != null && (
            <span className="text-[10px] text-muted-foreground/70 tabular-nums">
              {formatDuration(duration)}
            </span>
          )}
        </div>

        {/* Main column */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 mb-0.5">
            <span className="text-sm font-medium leading-tight line-clamp-2">
              {event.title}
            </span>
            <ChevronRight
              className={cn(
                'size-3.5 shrink-0 mt-0.5 transition-transform text-muted-foreground',
                active && 'rotate-90',
              )}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className={cn('inline-flex items-center gap-1', KIND_COLOR[event.kind])}>
              <KindIcon kind={event.kind} />
              {KIND_LABELS[event.kind]}
            </span>
            {event.source_app && (
              <span className="text-muted-foreground/80">· {event.source_app}</span>
            )}
            {hasAudio && (
              <span className="inline-flex items-center gap-0.5 text-muted-foreground/80">
                <Mic className="size-3" />
                audio
              </span>
            )}
            {!hasAudio && event.kind !== 'meeting' && (
              <span className="text-muted-foreground/60">{sourceLabel}</span>
            )}
          </div>
          {event.kind !== 'meeting' && event.context_md && (
            <p className="mt-1 text-[11px] text-muted-foreground/90 line-clamp-2 leading-snug">
              {event.context_md}
            </p>
          )}
          {event.kind === 'meeting' && meeting?.summary_json?.tldr && (
            <p className="mt-1 text-[11px] text-muted-foreground/90 line-clamp-2 leading-snug">
              {meeting.summary_json.tldr}
            </p>
          )}
          {event.kind === 'meeting' && hasTranscript && !meeting?.summary_json?.tldr && (
            <p className="mt-1 text-[11px] text-muted-foreground/80 italic line-clamp-2">
              Summary pending — transcript captured.
            </p>
          )}
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Detail pane.
// ---------------------------------------------------------------------------

function EventDetail({
  event,
  meeting,
}: {
  event: DayEvent;
  meeting: Meeting | null;
}) {
  return (
    <ScrollArea className="h-[calc(100vh-14rem)]">
      <div className="flex flex-col gap-5 pr-2">
        <EventDetailHeader event={event} meeting={meeting} />
        <Separator />
        {event.kind === 'meeting' && meeting ? (
          <MeetingBody event={event} meeting={meeting} />
        ) : (
          <NonMeetingBody event={event} />
        )}
      </div>
    </ScrollArea>
  );
}

function EventDetailHeader({
  event,
  meeting,
}: {
  event: DayEvent;
  meeting: Meeting | null;
}) {
  const duration = eventDuration(event);
  const sourceLabel = SOURCE_LABELS[event.source] ?? event.source;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-lg font-semibold leading-tight">{event.title}</span>
        <Badge
          variant="outline"
          className={cn('text-[10px] gap-1', KIND_COLOR[event.kind])}
        >
          <KindIcon kind={event.kind} />
          {KIND_LABELS[event.kind]}
        </Badge>
        {event.kind === 'meeting' && meeting && (
          <Badge variant="outline" className="text-[10px]">
            {platformLabel(meeting.platform)}
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Calendar className="size-3.5" />
          {prettyDay(event.day)}
        </span>
        <span className="flex items-center gap-1.5">
          <Clock className="size-3.5" />
          {formatLocalTime(event.starts_at)}
          {event.ends_at && <> – {formatLocalTime(event.ends_at)}</>}
          {duration != null && (
            <span className="ml-1 text-muted-foreground/60">
              ({formatDuration(duration)})
            </span>
          )}
        </span>
        {event.source_app && (
          <span className="flex items-center gap-1.5">
            <Inbox className="size-3.5" />
            {event.source_app}
          </span>
        )}
        <span className="text-xs text-muted-foreground/70">{sourceLabel}</span>
        {event.attendees.length > 0 && (
          <span className="flex items-center gap-1.5">
            <Users className="size-3.5" />
            {event.attendees.slice(0, 6).join(', ')}
            {event.attendees.length > 6 && ` +${event.attendees.length - 6}`}
          </span>
        )}
      </div>
    </div>
  );
}

function MeetingBody({
  event,
  meeting,
}: {
  event: DayEvent;
  meeting: Meeting;
}) {
  const summary = meeting.summary_json;
  const hasMarkdown = !!meeting.summary_md;

  return (
    <div className="flex flex-col gap-5">
      {/* Meeting-specific status row */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {meeting.transcript_chars > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <Mic className="size-3.5" />
            Transcript captured ({(meeting.transcript_chars / 1000).toFixed(1)}k chars)
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground/70">
            <Mic className="size-3.5 opacity-60" />
            No audio captured
          </span>
        )}
        <span>{meeting.screenshot_count} screenshots</span>
        {meeting.audio_chunk_count > 0 && (
          <span>{meeting.audio_chunk_count} audio chunks</span>
        )}
        <MeetingStatusBadge status={meeting.summary_status} />
      </div>

      {/* Summary content */}
      {meeting.summary_status === 'ready' && hasMarkdown ? (
        <div className="flex flex-col gap-4">
          {summary?.tldr && (
            <Card>
              <CardContent className="pt-4 pb-4">
                <p className="text-sm font-medium mb-1 text-muted-foreground uppercase tracking-wide text-[10px]">
                  TL;DR
                </p>
                <p className="text-sm">{summary.tldr}</p>
              </CardContent>
            </Card>
          )}
          {summary && summary.action_items.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Action Items
              </h3>
              <ul className="flex flex-col gap-1.5">
                {summary.action_items.map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className="mt-0.5 size-4 shrink-0 rounded-full border border-border flex items-center justify-center text-[9px] text-muted-foreground font-mono">
                      {i + 1}
                    </span>
                    <span>
                      {item.task}
                      {item.owner && (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          → {item.owner}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {summary && summary.decisions.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Decisions
              </h3>
              <ul className="flex flex-col gap-1.5">
                {summary.decisions.map((d, i) => (
                  <li key={i} className="text-sm text-muted-foreground">
                    • {d.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              Full Summary
            </h3>
            <Markdown content={meeting.summary_md!} />
          </div>
        </div>
      ) : meeting.summary_status === 'pending' ||
        meeting.summary_status === 'running' ? (
        <div className="flex flex-col items-center gap-3 py-10 text-muted-foreground text-sm">
          <Loader2 className="size-5 animate-spin" />
          <p>
            {meeting.summary_status === 'running'
              ? 'Summary is being generated…'
              : 'Summary is queued and will be ready shortly.'}
          </p>
        </div>
      ) : meeting.summary_status === 'failed' ? (
        <div className="flex flex-col gap-2 py-6">
          <p className="text-sm text-destructive">Summary generation failed.</p>
          {meeting.failure_reason && (
            <p className="text-xs text-muted-foreground">{meeting.failure_reason}</p>
          )}
          {event.context_md && (
            <p className="text-xs text-muted-foreground italic">{event.context_md}</p>
          )}
        </div>
      ) : meeting.summary_status === 'skipped_short' ? (
        <div className="flex flex-col gap-1 py-6 text-sm text-muted-foreground">
          <p>This meeting was too short to summarize.</p>
          {event.context_md && (
            <p className="text-xs italic">{event.context_md}</p>
          )}
        </div>
      ) : (
        <div className="py-6 text-sm text-muted-foreground">
          {event.context_md ?? 'No summary available yet.'}
        </div>
      )}

      {meeting.links.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Links shared
          </h3>
          <ul className="flex flex-col gap-1 text-sm">
            {meeting.links.map((link) => (
              <li key={link}>
                <a
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline break-all"
                >
                  {link}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function NonMeetingBody({ event }: { event: DayEvent }) {
  return (
    <div className="flex flex-col gap-5">
      {/* "Why this is here" line — explain that the event was extracted
          from screen capture, not pulled from a calendar API. Lets the
          user calibrate trust. */}
      <div className="text-xs text-muted-foreground/80 italic">
        Extracted from {event.evidence_frame_ids.length || 'recent'} screen capture
        {event.evidence_frame_ids.length === 1 ? '' : 's'} of {event.source_app ?? 'your screen'}.
      </div>

      {event.context_md ? (
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-sm font-medium mb-1 text-muted-foreground uppercase tracking-wide text-[10px]">
              Context
            </p>
            <p className="text-sm whitespace-pre-wrap leading-relaxed">
              {event.context_md}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="text-sm text-muted-foreground py-6">
          No additional context was extracted for this event.
        </div>
      )}

      {event.attendees.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Attendees / participants
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {event.attendees.map((a) => (
              <Badge key={a} variant="outline" className="text-xs">
                {a}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {event.links.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Links seen
          </h3>
          <ul className="flex flex-col gap-1 text-sm">
            {event.links.map((link) => (
              <li key={link}>
                <a
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline break-all"
                >
                  {link}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="text-[11px] text-muted-foreground/70 flex flex-wrap gap-3">
        <span>id {event.id}</span>
        <span>updated {formatLocalTime(event.updated_at)}</span>
      </div>
    </div>
  );
}

function MeetingStatusBadge({ status }: { status: Meeting['summary_status'] }) {
  if (status === 'ready')
    return (
      <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-600">
        Summarized
      </Badge>
    );
  if (status === 'running')
    return (
      <Badge variant="outline" className="text-[10px] border-primary/40 text-primary animate-pulse">
        Summarizing…
      </Badge>
    );
  if (status === 'pending')
    return (
      <Badge variant="outline" className="text-[10px] text-muted-foreground">
        Pending
      </Badge>
    );
  if (status === 'failed')
    return (
      <Badge variant="outline" className="text-[10px] border-destructive/40 text-destructive">
        Failed
      </Badge>
    );
  if (status === 'skipped_short')
    return (
      <Badge variant="outline" className="text-[10px] text-muted-foreground">
        Too short
      </Badge>
    );
  return null;
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-muted-foreground">
      <CalendarClock className="size-10 opacity-30" />
      <div className="text-center max-w-md">
        <p className="text-sm font-medium">No events yet</p>
        <p className="text-xs mt-1">
          Once we&apos;ve seen your calendar, inbox, Slack, or you&apos;ve sat through a
          recorded meeting, your day&apos;s events will appear here.
        </p>
      </div>
    </div>
  );
}
