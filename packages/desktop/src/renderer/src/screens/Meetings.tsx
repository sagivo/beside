import * as React from 'react';
import {
  Calendar,
  ChevronRight,
  Clock,
  Loader2,
  Mic,
  RefreshCcw,
  Users,
  Video,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/PageHeader';
import { Markdown } from '@/components/Markdown';
import { formatLocalTime, prettyDay } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Meeting, MeetingPlatform } from '@/global';

function formatDuration(ms: number): string {
  const totalMin = durationMinutes(ms);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function durationMinutes(ms: number): number {
  return Math.round(ms / 60_000);
}

function shouldShowMeeting(meeting: Meeting): boolean {
  return durationMinutes(meeting.duration_ms) > 0;
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

function meetingDisplayTitle(meeting: Meeting): string {
  return meeting.title ?? meeting.summary_json?.title ?? platformLabel(meeting.platform);
}

function statusBadge(status: Meeting['summary_status']) {
  if (status === 'ready') return <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-600">Summarized</Badge>;
  if (status === 'running') return <Badge variant="outline" className="text-[10px] border-primary/40 text-primary animate-pulse">Summarizing…</Badge>;
  if (status === 'pending') return <Badge variant="outline" className="text-[10px] text-muted-foreground">Pending</Badge>;
  if (status === 'failed') return <Badge variant="outline" className="text-[10px] border-destructive/40 text-destructive">Failed</Badge>;
  if (status === 'skipped_short') return <Badge variant="outline" className="text-[10px] text-muted-foreground">Too short</Badge>;
  return null;
}

function groupByDay(meetings: Meeting[]): Array<{ day: string; items: Meeting[] }> {
  const map = new Map<string, Meeting[]>();
  for (const m of meetings) {
    const existing = map.get(m.day);
    if (existing) {
      existing.push(m);
    } else {
      map.set(m.day, [m]);
    }
  }
  return Array.from(map.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, items]) => ({ day, items }));
}

export function Meetings({
  meetings,
  loading,
  onRefresh,
}: {
  meetings: Meeting[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const visibleMeetings = React.useMemo(
    () => meetings.filter(shouldShowMeeting),
    [meetings],
  );
  const selected = visibleMeetings.find((m) => m.id === selectedId) ?? null;

  const groups = groupByDay(visibleMeetings);

  React.useEffect(() => {
    if (selectedId && !visibleMeetings.find((m) => m.id === selectedId)) {
      setSelectedId(null);
    }
  }, [visibleMeetings, selectedId]);

  return (
    <div className="flex flex-col gap-6 pt-6">
      <PageHeader
        title="Meetings"
        description="Summaries of your recorded meetings, once indexed."
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

      {loading && visibleMeetings.length === 0 ? (
        <div className="grid min-h-[30vh] place-items-center text-muted-foreground text-sm gap-2">
          <Loader2 className="size-5 animate-spin" />
          Loading meetings…
        </div>
      ) : visibleMeetings.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex gap-4 min-h-0">
          {/* Left: meeting list */}
          <div className="w-72 shrink-0 flex flex-col gap-2">
            <ScrollArea className="h-[calc(100vh-14rem)]">
              <div className="flex flex-col gap-4 pr-2">
                {groups.map(({ day, items }) => (
                  <div key={day} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 px-1 mb-1">
                      <Calendar className="size-3 text-muted-foreground" />
                      <span className="text-xs font-medium text-muted-foreground">
                        {prettyDay(day)}
                      </span>
                    </div>
                    {items.map((meeting) => (
                      <MeetingListItem
                        key={meeting.id}
                        meeting={meeting}
                        active={meeting.id === selectedId}
                        onClick={() =>
                          setSelectedId(meeting.id === selectedId ? null : meeting.id)
                        }
                      />
                    ))}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>

          <Separator orientation="vertical" className="h-auto self-stretch" />

          {/* Right: meeting detail */}
          <div className="flex-1 min-w-0">
            {selected ? (
              <MeetingDetail meeting={selected} />
            ) : (
              <div className="grid h-full place-items-center text-muted-foreground text-sm">
                Select a meeting to view its summary
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MeetingListItem({
  meeting,
  active,
  onClick,
}: {
  meeting: Meeting;
  active: boolean;
  onClick: () => void;
}) {
  const hasTranscript = meeting.transcript_chars > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left rounded-lg border px-3 py-2.5 transition-colors',
        active
          ? 'border-primary/40 bg-primary/5 text-foreground'
          : 'border-border bg-card hover:bg-accent/50 text-foreground',
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="text-sm font-medium truncate leading-tight">
          {meetingDisplayTitle(meeting)}
        </span>
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 mt-0.5 transition-transform text-muted-foreground',
            active && 'rotate-90',
          )}
        />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wide">
          {platformLabel(meeting.platform)}
        </span>
        <span className="flex items-center gap-1">
          <Clock className="size-3" />
          {formatLocalTime(meeting.started_at)} · {formatDuration(meeting.duration_ms)}
        </span>
        {hasTranscript && <Mic className="size-3 shrink-0" />}
      </div>
      <div className="flex items-center gap-1.5 mt-1.5">
        {statusBadge(meeting.summary_status)}
        {meeting.attendees.length > 0 && (
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
            <Users className="size-3" />
            {meeting.attendees.length}
          </span>
        )}
      </div>
    </button>
  );
}

function MeetingDetail({ meeting }: { meeting: Meeting }) {
  const summary = meeting.summary_json;
  const hasMarkdown = !!meeting.summary_md;

  return (
    <ScrollArea className="h-[calc(100vh-14rem)]">
      <div className="flex flex-col gap-5 pr-2">
        {/* Header */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-lg font-semibold">{meetingDisplayTitle(meeting)}</span>
            {statusBadge(meeting.summary_status)}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Video className="size-3.5" />
              {platformLabel(meeting.platform)}
            </span>
            <span className="flex items-center gap-1.5">
              <Calendar className="size-3.5" />
              {prettyDay(meeting.day)}
            </span>
            <span className="flex items-center gap-1.5">
              <Clock className="size-3.5" />
              {formatLocalTime(meeting.started_at)} – {formatLocalTime(meeting.ended_at)}
              <span className="ml-1 text-muted-foreground/60">
                ({formatDuration(meeting.duration_ms)})
              </span>
            </span>
            {meeting.attendees.length > 0 && (
              <span className="flex items-center gap-1.5">
                <Users className="size-3.5" />
                {meeting.attendees.join(', ')}
              </span>
            )}
            {meeting.transcript_chars > 0 && (
              <span className="flex items-center gap-1.5">
                <Mic className="size-3.5" />
                Transcript available
              </span>
            )}
          </div>
        </div>

        <Separator />

        {/* Summary content */}
        {meeting.summary_status === 'ready' && hasMarkdown ? (
          <div className="flex flex-col gap-4">
            {summary?.tldr && (
              <Card>
                <CardContent className="pt-4 pb-4">
                  <p className="text-sm font-medium mb-1 text-muted-foreground uppercase tracking-wide text-[10px]">TL;DR</p>
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
                          <span className="ml-1.5 text-xs text-muted-foreground">→ {item.owner}</span>
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
        ) : meeting.summary_status === 'pending' || meeting.summary_status === 'running' ? (
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
          </div>
        ) : meeting.summary_status === 'skipped_short' ? (
          <div className="flex flex-col gap-1 py-6 text-sm text-muted-foreground">
            <p>This meeting was too short to summarize.</p>
          </div>
        ) : (
          <div className="py-6 text-sm text-muted-foreground">No summary available yet.</div>
        )}

        {/* Stats footer */}
        <Separator />
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground pb-4">
          <span>{meeting.screenshot_count} screenshots</span>
          {meeting.audio_chunk_count > 0 && (
            <span>{meeting.audio_chunk_count} audio chunks</span>
          )}
          {meeting.transcript_chars > 0 && (
            <span>{(meeting.transcript_chars / 1000).toFixed(1)}k transcript chars</span>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-muted-foreground">
      <Video className="size-10 opacity-30" />
      <div className="text-center">
        <p className="text-sm font-medium">No meetings yet</p>
        <p className="text-xs mt-1 max-w-64 text-center">
          Meetings are detected when you join a video call. Once indexed and summarized, they'll appear here.
        </p>
      </div>
    </div>
  );
}
