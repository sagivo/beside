import * as React from 'react';
import {
  Calendar,
  CalendarClock,
  CalendarDays,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Clock,
  Inbox,
  Loader2,
  MessageSquare,
  Mic,
  RefreshCcw,
  ScanLine,
  Sparkles,
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
import { formatLocalTime, localDayKey, prettyDay, shiftDay } from '@/lib/format';
import { uniqueStrings } from '@/lib/collections';
import {
  DAY_EVENT_KIND_COLORS as KIND_COLOR,
  DAY_EVENT_KIND_LABELS as KIND_LABELS,
  DAY_EVENT_SOURCE_LABELS as SOURCE_LABELS,
} from '@/lib/day-events';
import { actionItemLabel, collectMeetingSummarySignals } from '@/lib/meeting-signals';
import { cn } from '@/lib/utils';
import type {
  DayEvent,
  DayEventKind,
  Meeting,
  MeetingPlatform,
} from '@/global';

function compareDays(a: string, b: string): number {
  return a.localeCompare(b);
}

// ---------------------------------------------------------------------------
// Duration / platform helpers (kept for the meeting-detail body).
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

function useMinuteClock(): Date {
  const [now, setNow] = React.useState(() => new Date());

  React.useEffect(() => {
    let interval: number | null = null;
    const timeout = window.setTimeout(() => {
      setNow(new Date());
      interval = window.setInterval(() => setNow(new Date()), 60_000);
    }, 60_000 - (Date.now() % 60_000));

    return () => {
      window.clearTimeout(timeout);
      if (interval !== null) window.clearInterval(interval);
    };
  }, []);

  return now;
}

function eventBelongsBeforeNowIndicator(event: DayEvent, nowMs: number): boolean {
  const startMs = Date.parse(event.starts_at);
  const endMs = event.ends_at ? Date.parse(event.ends_at) : Number.NaN;
  const durationMs = Number.isFinite(endMs) && Number.isFinite(startMs)
    ? endMs - startMs
    : null;

  // All-day items should stay at the top of the agenda, but they
  // should not keep the live time marker above every timed event.
  if (durationMs !== null && durationMs >= 20 * 60 * 60_000) {
    return startMs <= nowMs;
  }

  if (Number.isFinite(endMs)) return endMs <= nowMs;
  return Number.isFinite(startMs) && startMs <= nowMs;
}

function nowIndicatorIndex(events: DayEvent[], now: Date): number {
  const nowMs = now.getTime();
  const idx = events.findIndex((event) => !eventBelongsBeforeNowIndicator(event, nowMs));
  return idx === -1 ? events.length : idx;
}

/**
 * Snap near-duplicates inside a day (same title within ±5 minutes) so
 * the same calendar entry surfaced by multiple OCR passes doesn't show
 * up twice. Prefers the meeting-sourced row if titles collide across
 * sources.
 */
function dedupeEvents(events: DayEvent[]): DayEvent[] {
  const seen = new Map<string, DayEvent>();
  for (const ev of events) {
    // Hide tombstoned events that the extractor used to collapse
    // duplicate-meeting rows. They survive the table as zero-duration
    // placeholders with a sentinel title.
    if (ev.title === '__merged__') continue;
    const minute = Math.floor(Date.parse(ev.starts_at) / 60_000);
    // Keep captured meetings distinct: the runtime already decides
    // meeting identity via meeting_id, and separate calls can share a
    // title within the same half-hour. Other sources still get a small
    // bucket to collapse repeated OCR observations of the same item.
    const bucketSize = ev.kind === 'meeting' ? 1 : 5;
    const bucket = Math.floor(minute / bucketSize) * bucketSize;
    const key =
      ev.kind === 'meeting'
        ? [ev.day, ev.kind, ev.meeting_id ?? ev.id].join('|')
        : [ev.day, ev.kind, bucket, ev.title.trim().toLowerCase()].join('|');
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, ev);
      continue;
    }
    // For meetings, prefer the row with audio + summary. For other
    // kinds, prefer the meeting-sourced row when titles collide.
    if (existing.kind === 'meeting' && ev.kind === 'meeting') {
      const score = (e: DayEvent) =>
        (e.context_md && e.context_md.length > 20 ? 2 : 0) +
        (e.meeting_id ? 1 : 0);
      if (score(ev) > score(existing)) seen.set(key, ev);
    } else if (existing.kind !== 'meeting' && ev.kind === 'meeting') {
      seen.set(key, ev);
    }
  }
  return Array.from(seen.values());
}

const MEETING_CALENDAR_LINK_GRACE_MS = 10 * 60_000;

function eventTimeRange(event: DayEvent): { start: number; end: number } | null {
  const start = Date.parse(event.starts_at);
  const parsedEnd = event.ends_at ? Date.parse(event.ends_at) : Number.NaN;
  const end =
    Number.isFinite(parsedEnd) && parsedEnd > start
      ? parsedEnd
      : start + Math.max(eventDuration(event) ?? 30 * 60_000, 5 * 60_000);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

function normaliseAgendaTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b(?:google\s+meet|zoom|teams|meeting|call)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titlesLikelySame(a: string, b: string): boolean {
  const left = normaliseAgendaTitle(a);
  const right = normaliseAgendaTitle(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.length >= 6 && right.length >= 6 && (left.includes(right) || right.includes(left));
}

const SOLO_ACTIVITY_TITLE_RE =
  /\b(focus|deep work|heads down|busy|hold|blocked|personal|lunch|break|commute|ooo|out of office)\b/i;
const COLLABORATIVE_MEETING_TITLE_RE =
  /\b(1\s*:\s*1|1-on-1|one[-\s]?on[-\s]?one|stand[-\s]?up|sync|office hours?|all hands|planning|retro|demo|interview|review|check[-\s]?in|kickoff)\b/i;
const REMOTE_MEETING_SIGNAL_RE =
  /\b(zoom(?:\.us)?|google meet|meet\.google|teams\.microsoft|microsoft teams|webex|whereby|around)\b/i;
const PARTICIPANT_NOISE_WORDS = new Set([
  'calendar',
  'call',
  'conference',
  'event',
  'google',
  'meet',
  'meeting',
  'room',
  'teams',
  'webex',
  'whereby',
  'zoom',
  'zoom room',
]);
const TITLE_TOKEN_STOP_WORDS = new Set([
  'calendar',
  'call',
  'conference',
  'cupertino',
  'event',
  'google',
  'meet',
  'meeting',
  'office',
  'hour',
  'hours',
  'palaven',
  'room',
  'session',
  'teams',
  'today',
  'tomorrow',
  'vimire',
  'webex',
  'whereby',
  'zoom',
]);

function isBeforeEventStart(event: DayEvent, now: Date): boolean {
  const start = Date.parse(event.starts_at);
  return Number.isFinite(start) && now.getTime() < start;
}

function cleanParticipantName(name: string): string {
  return name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9@.' -]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMeaningfulParticipantName(name: string): boolean {
  const cleaned = cleanParticipantName(name);
  const key = cleaned.toLowerCase();
  if (cleaned.length < 2 || cleaned.length > 60) return false;
  if (/^\d+$/.test(cleaned)) return false;
  if (PARTICIPANT_NOISE_WORDS.has(key)) return false;
  if (/\b(?:meeting|room|zoom room|calendar)\b/i.test(cleaned)) return false;
  return /[a-z]/i.test(cleaned);
}

function extractTitleParticipantNames(title: string): string[] {
  const head = title.split(/\s+-\s+/)[0] ?? title;
  if (!/[\/&]|\b(?:and|with)\b/i.test(head)) return [];
  return uniqueStrings(
    head
      .split(/\s*(?:\/|&|\band\b|\bwith\b)\s*/i)
      .map(cleanParticipantName)
      .filter(isMeaningfulParticipantName),
  ).slice(0, 8);
}

function participantNamesForEvent(event: DayEvent, meeting: Meeting | null): string[] {
  return uniqueStrings([
    ...event.attendees,
    ...(meeting?.attendees ?? []),
    ...(meeting?.summary_json?.attendees_seen ?? []),
    ...extractTitleParticipantNames(meeting?.summary_json?.title ?? meeting?.title ?? event.title),
  ]).filter(isMeaningfulParticipantName);
}

function hasRemoteMeetingSignal(event: DayEvent, meeting: Meeting | null): boolean {
  const haystack = [
    event.title,
    event.source_app ?? '',
    ...event.links,
    meeting?.title ?? '',
    ...(meeting?.links ?? []),
    ...(meeting?.summary_json?.links_shared ?? []),
  ].join(' ');
  return REMOTE_MEETING_SIGNAL_RE.test(haystack);
}

function isCollaborativeMeetingEvent(event: DayEvent, meeting: Meeting | null): boolean {
  if (SOLO_ACTIVITY_TITLE_RE.test(event.title)) return false;
  if (event.kind !== 'meeting' && event.kind !== 'calendar' && !meeting) return false;

  const participantCount = participantNamesForEvent(event, meeting).length;
  if (participantCount > 0) return true;

  const titleParticipantCount = extractTitleParticipantNames(event.title).length;
  if (titleParticipantCount >= 2) return true;

  if (COLLABORATIVE_MEETING_TITLE_RE.test(event.title)) return true;
  return hasRemoteMeetingSignal(event, meeting) && event.kind === 'meeting';
}

function shouldShowPrepBrief(event: DayEvent, meeting: Meeting | null, now: Date): boolean {
  return isBeforeEventStart(event, now) && isCollaborativeMeetingEvent(event, meeting);
}

function meetingQualityScore(event: DayEvent, meeting: Meeting | null): number {
  return (
    (meeting?.summary_status === 'ready' ? 10_000 : 0) +
    (meeting?.summary_json?.tldr ? 3_000 : 0) +
    (meeting?.transcript_chars ?? 0) +
    (meeting?.audio_chunk_count ?? 0) * 500 +
    Math.min(eventDuration(event) ?? 0, 90 * 60_000) / 1000 +
    (event.context_md?.length ?? 0)
  );
}

function calendarMatchScore(calendar: DayEvent, captured: DayEvent): number {
  if (!titlesLikelySame(calendar.title, captured.title)) return 0;
  const calRange = eventTimeRange(calendar);
  const capRange = eventTimeRange(captured);
  if (!calRange || !capRange) return 0;

  const overlap =
    Math.min(calRange.end, capRange.end) - Math.max(calRange.start, capRange.start);
  const startDistance = Math.abs(calRange.start - capRange.start);
  const startsInside =
    capRange.start >= calRange.start - MEETING_CALENDAR_LINK_GRACE_MS &&
    capRange.start <= calRange.end + MEETING_CALENDAR_LINK_GRACE_MS;

  if (overlap <= 0 && !startsInside && startDistance > MEETING_CALENDAR_LINK_GRACE_MS) {
    return 0;
  }

  return Math.max(1, overlap / 60_000) + Math.max(0, 30 - startDistance / 60_000);
}

function reconcileCalendarMeetingItems(
  events: DayEvent[],
  meetingsById: Map<string, Meeting>,
): DayEvent[] {
  const deduped = dedupeEvents(events);
  const calendarEvents = deduped.filter(
    (event) => event.source === 'calendar_screen' && event.kind === 'calendar',
  );
  if (calendarEvents.length === 0) return deduped;

  const hiddenMeetingEventIds = new Set<string>();
  const linkedMeetingByCalendarId = new Map<string, { id: string; score: number }>();

  for (const event of deduped) {
    if (event.source !== 'meeting_capture' || event.kind !== 'meeting' || !event.meeting_id) {
      continue;
    }

    let best: { calendar: DayEvent; score: number } | null = null;
    for (const calendar of calendarEvents) {
      const score = calendarMatchScore(calendar, event);
      if (score > 0 && (!best || score > best.score)) {
        best = { calendar, score };
      }
    }
    if (!best) continue;

    hiddenMeetingEventIds.add(event.id);
    const meeting = meetingsById.get(event.meeting_id) ?? null;
    const quality = meetingQualityScore(event, meeting);
    const current = linkedMeetingByCalendarId.get(best.calendar.id);
    if (!current || quality > current.score) {
      linkedMeetingByCalendarId.set(best.calendar.id, {
        id: event.meeting_id,
        score: quality,
      });
    }
  }

  if (hiddenMeetingEventIds.size === 0) return deduped;

  return deduped
    .filter((event) => !hiddenMeetingEventIds.has(event.id))
    .map((event) => {
      const linked = linkedMeetingByCalendarId.get(event.id);
      if (!linked) return event;
      const meeting = meetingsById.get(linked.id) ?? null;
      return {
        ...event,
        meeting_id: linked.id,
        context_md:
          meeting?.summary_json?.tldr ??
          event.context_md,
        attendees: Array.from(new Set([...event.attendees, ...(meeting?.attendees ?? [])])),
        links: Array.from(new Set([...event.links, ...(meeting?.links ?? [])])),
      };
    });
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
  onRefresh: () => void | Promise<void>;
}) {
  // Manual "scan now" — triggers the EventExtractor immediately so the
  // user doesn't wait 15 min for the next scheduled tick.
  const [scanning, setScanning] = React.useState(false);
  const runScan = React.useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const r = await window.cofounderos.triggerEventExtractor();
      const surfaced =
        r.meetingsLifted + r.llmExtracted + r.contextEnriched;
      const preparedMeetings = r.meetingsCreated + r.meetingsExtended;
      const processedAudio = r.audioTranscribed + r.audioImported;
      const summaryWork = r.summariesSucceeded + r.summariesFailed + r.summariesSkipped;
      if (surfaced > 0 || processedAudio > 0 || r.summariesSucceeded > 0) {
        toast.success('Event scan complete', {
          description: [
            processedAudio > 0 &&
              `${processedAudio} audio transcript${processedAudio === 1 ? '' : 's'} processed`,
            preparedMeetings > 0 &&
              `${preparedMeetings} meeting record${preparedMeetings === 1 ? '' : 's'} prepared`,
            r.summariesSucceeded > 0 &&
              `${r.summariesSucceeded} meeting summar${r.summariesSucceeded === 1 ? 'y' : 'ies'} ready`,
            r.meetingsLifted > 0 && `${r.meetingsLifted} meeting${r.meetingsLifted === 1 ? '' : 's'} lifted`,
            r.llmExtracted > 0 && `${r.llmExtracted} event${r.llmExtracted === 1 ? '' : 's'} extracted`,
            r.contextEnriched > 0 && `${r.contextEnriched} context${r.contextEnriched === 1 ? '' : 's'} added`,
          ]
            .filter(Boolean)
            .join(' · '),
        });
      } else if (!r.modelAvailable) {
        toast.info('Event scan skipped', {
          description:
            'Model is offline. Captured meetings still surface; calendar / inbox extraction needs a running model.',
        });
      } else if (r.bucketsScanned === 0) {
        const prep = [
          r.framesBuilt > 0 && `built ${r.framesBuilt} frame${r.framesBuilt === 1 ? '' : 's'}`,
          r.framesOcrd > 0 && `OCR'd ${r.framesOcrd}`,
        ]
          .filter(Boolean)
          .join(', ');
        toast.info('No calendar captures yet', {
          description: `${prep ? `Prepped ${prep}. ` : ''}No calendar frames detected on the days scanned. Open the calendar app for a few seconds, then click Scan now again.`,
        });
      } else {
        const prep = [
          r.framesBuilt > 0 && `built ${r.framesBuilt} frame${r.framesBuilt === 1 ? '' : 's'}`,
          r.framesOcrd > 0 && `OCR'd ${r.framesOcrd}`,
          processedAudio > 0 && `processed ${processedAudio} audio transcript${processedAudio === 1 ? '' : 's'}`,
          preparedMeetings > 0 && `prepared ${preparedMeetings} meeting record${preparedMeetings === 1 ? '' : 's'}`,
          summaryWork > 0 && `checked ${summaryWork} meeting summar${summaryWork === 1 ? 'y' : 'ies'}`,
        ]
          .filter(Boolean)
          .join(', ');
        toast.info('No new events found', {
          description: `${prep ? `Prepped ${prep}. ` : ''}Scanned ${r.framesScanned} frame${r.framesScanned === 1 ? '' : 's'} across ${r.bucketsScanned} surface${r.bucketsScanned === 1 ? '' : 's'} — the model returned nothing new.`,
        });
      }
      await onRefresh();
    } catch (err) {
      toast.error('Event scan failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setScanning(false);
    }
  }, [scanning, onRefresh]);

  // Per-day cache that the day-picker writes into. When the user
  // navigates to a day we already pulled in the initial prop, we just
  // filter; when they jump to an older / empty day we still issue a
  // targeted fetch so the badge counts stay honest.
  const [dayOverrides, setDayOverrides] = React.useState<
    Map<string, DayEvent[]>
  >(() => new Map());
  const [perDayLoading, setPerDayLoading] = React.useState<string | null>(null);

  // A global refresh (including after Scan now) returns the freshest
  // event list. Drop targeted day caches so newly extracted events on
  // past, current, or future days become visible immediately.
  React.useEffect(() => {
    setDayOverrides(new Map());
  }, [events]);

  const currentTime = useMinuteClock();
  const today = React.useMemo(() => localDayKey(currentTime), [currentTime]);
  const meetingsById = React.useMemo(() => {
    const map = new Map<string, Meeting>();
    for (const m of meetings) map.set(m.id, m);
    return map;
  }, [meetings]);

  // Universe of days the props gave us, sorted descending.
  const daysFromProps = React.useMemo(() => {
    const set = new Set<string>();
    for (const ev of events) set.add(ev.day);
    return Array.from(set).sort((a, b) => compareDays(b, a));
  }, [events]);

  const [selectedDay, setSelectedDay] = React.useState<string>(() => {
    // Initial pick: today if it has events, else most recent day with
    // events, else today (we'll just show an empty state).
    return today;
  });

  // Once the props arrive, if today is empty but a recent day has data,
  // auto-jump there so the user sees something on first paint. Only
  // happens once — the user can navigate back to today freely.
  const autoJumpedRef = React.useRef(false);
  React.useEffect(() => {
    if (autoJumpedRef.current) return;
    if (daysFromProps.length === 0) return;
    autoJumpedRef.current = true;
    const todayHasEvents = events.some((ev) => ev.day === today);
    if (!todayHasEvents) {
      setSelectedDay(daysFromProps[0]);
    }
  }, [daysFromProps, events, today]);

  // Resolve the visible events for the selected day. Prefer the
  // override (most fresh) and fall back to filtering the props.
  const visibleEvents = React.useMemo(() => {
    const fromOverride = dayOverrides.get(selectedDay);
    const raw = fromOverride ?? events.filter((ev) => ev.day === selectedDay);
    return reconcileCalendarMeetingItems(raw, meetingsById).sort((a, b) =>
      a.starts_at.localeCompare(b.starts_at),
    );
  }, [selectedDay, events, dayOverrides, meetingsById]);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  React.useEffect(() => {
    // Clear selection when day changes; auto-pick the first event so the
    // detail pane isn't empty when the day has data.
    if (visibleEvents.length === 0) {
      setSelectedId(null);
    } else if (!selectedId || !visibleEvents.find((e) => e.id === selectedId)) {
      setSelectedId(visibleEvents[0].id);
    }
  }, [selectedDay, visibleEvents, selectedId]);

  // Lazy-load a specific day's events if it isn't in the prop set yet.
  // This is what makes "go back 30 days" actually work without bumping
  // the initial fetch limit forever.
  const loadDay = React.useCallback(
    async (day: string) => {
      // Already have fresh data via prop? Skip.
      if (daysFromProps.includes(day) && !dayOverrides.has(day)) return;
      if (perDayLoading === day) return;
      setPerDayLoading(day);
      try {
        const fresh =
          (await window.cofounderos.listDayEvents({ day })) ?? [];
        setDayOverrides((prev) => {
          const next = new Map(prev);
          next.set(day, fresh);
          return next;
        });
      } catch {
        // Surface failures by writing an empty bucket so the UI shows
        // a real empty state instead of spinning forever.
        setDayOverrides((prev) => {
          const next = new Map(prev);
          if (!next.has(day)) next.set(day, []);
          return next;
        });
      } finally {
        setPerDayLoading((current) => (current === day ? null : current));
      }
    },
    [daysFromProps, dayOverrides, perDayLoading],
  );

  // Whenever the user lands on a day that isn't already part of the
  // initial prop set, kick off a targeted fetch. Refreshing the global
  // list is reserved for the explicit refresh button.
  React.useEffect(() => {
    if (!selectedDay) return;
    if (daysFromProps.includes(selectedDay)) return;
    if (dayOverrides.has(selectedDay)) return;
    void loadDay(selectedDay);
  }, [selectedDay, daysFromProps, dayOverrides, loadDay]);

  const dayIsLoading = perDayLoading === selectedDay;
  const showNowIndicator = selectedDay === today && visibleEvents.length > 0;
  const nowIndex = showNowIndicator
    ? nowIndicatorIndex(visibleEvents, currentTime)
    : -1;

  const goPrev = () => setSelectedDay((d) => shiftDay(d, -1));
  const goNext = () => setSelectedDay((d) => shiftDay(d, 1));
  const goToday = () => setSelectedDay(today);

  return (
    <div className="flex flex-col gap-5 pt-6 min-h-0">
      <PageHeader
        title="Agenda"
        description="Meetings, calendar entries, and events extracted from what you've seen on screen."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runScan()}
              disabled={scanning}
              className="gap-1.5"
              title="Run the event extractor over recent screen captures right now"
            >
              {scanning ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <ScanLine className="size-3.5" />
              )}
              Scan now
            </Button>
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
          </>
        }
      />

      <DayPicker
        selectedDay={selectedDay}
        today={today}
        loading={dayIsLoading}
        eventCount={visibleEvents.length}
        onPrev={goPrev}
        onNext={goNext}
        onToday={goToday}
        onPick={setSelectedDay}
      />

      <DayBriefRecap
        events={visibleEvents}
        meetingsById={meetingsById}
        selectedDay={selectedDay}
        today={today}
        now={currentTime}
        onSelectEvent={setSelectedId}
      />

      {loading && visibleEvents.length === 0 && dayOverrides.size === 0 ? (
        <div className="grid min-h-[30vh] place-items-center text-muted-foreground text-sm gap-2">
          <Loader2 className="size-5 animate-spin" />
          Loading events…
        </div>
      ) : (
        <div className="flex gap-4 min-h-0 flex-1">
          {/* Left: events for the selected day */}
          <div className="w-80 shrink-0 flex flex-col gap-2">
            <ScrollArea className="h-[calc(100vh-17rem)]">
              <div className="flex flex-col gap-1.5 pr-2">
                {visibleEvents.length === 0 ? (
                  <DayEmptyState
                    day={selectedDay}
                    loading={dayIsLoading}
                    onScan={runScan}
                    scanning={scanning}
                  />
                ) : (
                  <>
                    {visibleEvents.map((event, index) => (
                      <React.Fragment key={event.id}>
                        {index === nowIndex && <NowIndicator now={currentTime} />}
                        <EventRow
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
                      </React.Fragment>
                    ))}
                    {nowIndex === visibleEvents.length && (
                      <NowIndicator now={currentTime} />
                    )}
                  </>
                )}
              </div>
            </ScrollArea>
          </div>

          <Separator orientation="vertical" className="h-auto self-stretch" />

          {/* Right: detail */}
          <div className="flex-1 min-w-0">
            {(() => {
              const selected = visibleEvents.find((e) => e.id === selectedId) ?? null;
              if (!selected) {
                return (
                  <div className="grid h-full place-items-center text-muted-foreground text-sm">
                    {visibleEvents.length === 0
                      ? 'Nothing to show for this day.'
                      : 'Select an event to see its details'}
                  </div>
                );
              }
              return (
                <EventDetail
                  event={selected}
                  meeting={
                    selected.meeting_id
                      ? meetingsById.get(selected.meeting_id) ?? null
                      : null
                  }
                  allMeetings={meetings}
                  now={currentTime}
                />
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day picker:
//
//  The middle button names the selected day and opens the native date
//  picker. The chevrons step ±1 day from that selected day. When the
//  selection moves away from today, a separate Today shortcut appears.
//
// `color-scheme` is set on :root / .dark in style.css so the
// OS-rendered date popover follows the active light/dark theme.
// ---------------------------------------------------------------------------

function DayPicker({
  selectedDay,
  today,
  loading,
  eventCount,
  onPrev,
  onNext,
  onToday,
  onPick,
}: {
  selectedDay: string;
  today: string;
  loading: boolean;
  eventCount: number;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onPick: (day: string) => void;
}) {
  const dateInputRef = React.useRef<HTMLInputElement>(null);
  const isToday = selectedDay === today;

  const openPicker = () => {
    const input = dateInputRef.current;
    if (!input) return;
    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker();
        return;
      }
    } catch {
      /* fall through */
    }
    input.focus();
    input.click();
  };

  return (
    <div className="flex items-center gap-2">
      <div className="relative inline-flex items-center gap-1 rounded-full border border-border bg-card p-1 shadow-sm">
        <Button
          variant="ghost"
          size="icon"
          onClick={onPrev}
          aria-label="Previous day"
          className="rounded-full size-8 text-foreground/80 hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
        </Button>

        <button
          type="button"
          onClick={openPicker}
          aria-label={`Viewing ${prettyDay(selectedDay)}. Pick another date`}
          title={`${prettyDay(selectedDay)} (${selectedDay}) — click to pick another date`}
          className={cn(
            'inline-flex h-8 min-w-28 items-center justify-center gap-2 rounded-full px-3',
            'text-sm font-medium text-foreground tabular-nums transition-colors',
            'hover:bg-accent hover:text-accent-foreground',
          )}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : (
            <CalendarDays className="size-3.5 text-foreground/80" />
          )}
          <span>{prettyDay(selectedDay)}</span>
        </button>

        <Button
          variant="ghost"
          size="icon"
          onClick={onNext}
          aria-label="Next day"
          className="rounded-full size-8 text-foreground/80 hover:text-foreground"
        >
          <ChevronRight className="size-4" />
        </Button>
        <input
          ref={dateInputRef}
          type="date"
          value={selectedDay}
          onChange={(e) => {
            const v = e.target.value;
            if (v) onPick(v);
          }}
          tabIndex={-1}
          aria-hidden="true"
          className="absolute inset-0 opacity-0 pointer-events-none"
        />
      </div>

      {!isToday && (
        <Button
          variant="outline"
          size="sm"
          onClick={onToday}
          className="h-9 rounded-full px-3"
        >
          Today
        </Button>
      )}

      {eventCount > 0 && (
        <span className="ml-1 text-xs text-muted-foreground">
          {eventCount} {eventCount === 1 ? 'event' : 'events'}
        </span>
      )}
    </div>
  );
}

function DayBriefRecap({
  events,
  meetingsById,
  selectedDay,
  today,
  now,
  onSelectEvent,
}: {
  events: DayEvent[];
  meetingsById: Map<string, Meeting>;
  selectedDay: string;
  today: string;
  now: Date;
  onSelectEvent: (eventId: string) => void;
}) {
  if (events.length === 0) return null;

  const nowMs = now.getTime();
  const upcoming =
    selectedDay === today
      ? events.find((event) => {
          const start = Date.parse(event.starts_at);
          const end = event.ends_at ? Date.parse(event.ends_at) : start;
          return Number.isFinite(start) && Math.max(start, end) >= nowMs;
        }) ?? events[events.length - 1]!
      : events[0]!;

  const meetings = events
    .map((event) => (event.meeting_id ? meetingsById.get(event.meeting_id) ?? null : null))
    .filter((meeting): meeting is Meeting => Boolean(meeting));
  const { actionItems, decisions, openQuestions } = collectMeetingSummarySignals(meetings);
  const links = uniqueStrings(events.flatMap((event) => event.links));

  return (
    <div className="grid gap-3 md:grid-cols-3">
      <button
        type="button"
        onClick={() => onSelectEvent(upcoming.id)}
        className="rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/30"
      >
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <CalendarClock className="size-3.5" />
          {selectedDay === today ? 'Next up' : 'First event'}
        </div>
        <div className="mt-2 text-sm font-medium line-clamp-2">{upcoming.title}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {formatLocalTime(upcoming.starts_at)}
          {upcoming.attendees.length > 0 && ` · ${upcoming.attendees.slice(0, 3).join(', ')}`}
        </div>
      </button>

      <BriefMetric
        icon={<CheckSquare />}
        label="Follow-ups"
        count={actionItems.length}
        empty="No action items captured"
        items={actionItems.slice(0, 3).map((item) => item.task)}
      />

      <BriefMetric
        icon={<Sparkles />}
        label="Recap"
        count={decisions.length + openQuestions.length + links.length}
        empty="No recap yet"
        items={[
          ...decisions.slice(0, 2).map((item) => item.text),
          ...openQuestions.slice(0, 1).map((item) => item.text),
          ...(decisions.length === 0 && openQuestions.length === 0 && links.length > 0
            ? [`${links.length} link${links.length === 1 ? '' : 's'} seen`]
            : []),
        ]}
      />
    </div>
  );
}

function BriefMetric({
  icon,
  label,
  count,
  empty,
  items,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  empty: string;
  items: string[];
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground [&>svg]:size-3.5">
          {icon}
          {label}
        </div>
        <Badge variant={count > 0 ? 'outline' : 'muted'}>{count}</Badge>
      </div>
      {items.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
          {items.map((item, i) => (
            <li key={`${item}-${i}`} className="line-clamp-1">
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

function DayEmptyState({
  day,
  loading,
  onScan,
  scanning,
}: {
  day: string;
  loading: boolean;
  onScan: () => void;
  scanning: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 px-3 text-muted-foreground text-sm justify-center">
        <Loader2 className="size-4 animate-spin" />
        Loading {prettyDay(day)}…
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center text-center gap-3 py-12 px-3 text-muted-foreground">
      <CalendarClock className="size-8 opacity-30" />
      <p className="text-sm font-medium">No events on {prettyDay(day)}</p>
      <p className="text-xs max-w-[16rem] leading-relaxed">
        The event extractor runs on a 15-min cadence. If you just opened the
        app or want to refresh now from recent screen captures, scan it
        manually.
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={onScan}
        disabled={scanning}
        className="gap-1.5 mt-1"
      >
        {scanning ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <ScanLine className="size-3.5" />
        )}
        Scan now
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Left-pane list row.
// ---------------------------------------------------------------------------

function NowIndicator({ now }: { now: Date }) {
  return (
    <div
      className="grid grid-cols-[3rem_1fr] items-center gap-2 px-1 py-1.5"
      aria-label={`Current time ${formatLocalTime(now.toISOString())}`}
    >
      <span className="text-[10px] font-semibold tabular-nums text-primary">
        {formatLocalTime(now.toISOString())}
      </span>
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-full bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.16)]" />
        <span className="h-px flex-1 bg-primary/55" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-primary">
          Now
        </span>
      </div>
    </div>
  );
}

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
          {event.kind === 'meeting' && meeting?.summary_json?.tldr && !event.context_md && (
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
  allMeetings,
  now,
}: {
  event: DayEvent;
  meeting: Meeting | null;
  allMeetings: Meeting[];
  now: Date;
}) {
  return (
    <ScrollArea className="h-[calc(100vh-17rem)]">
      <div className="flex flex-col gap-5 pr-2">
        <EventDetailHeader event={event} meeting={meeting} />
        <Separator />
        {meeting ? (
          <MeetingBody event={event} meeting={meeting} allMeetings={allMeetings} now={now} />
        ) : (
          <NonMeetingBody event={event} allMeetings={allMeetings} now={now} />
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
        {meeting && (
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
  allMeetings,
  now,
}: {
  event: DayEvent;
  meeting: Meeting;
  allMeetings: Meeting[];
  now: Date;
}) {
  const summary = meeting.summary_json;
  const hasMarkdown = !!meeting.summary_md;
  const prep = buildPrepBrief(event, meeting, allMeetings, now);

  return (
    <div className="flex flex-col gap-5">
      <PrepBrief prep={prep} />

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
          {summary && summary.open_questions.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Open Questions
              </h3>
              <ul className="flex flex-col gap-1.5">
                {summary.open_questions.map((q, i) => (
                  <li key={i} className="text-sm text-muted-foreground">
                    • {q.text}
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

      <LinkList title="Links shared" links={meeting.links} />
    </div>
  );
}

function NonMeetingBody({
  event,
  allMeetings,
  now,
}: {
  event: DayEvent;
  allMeetings: Meeting[];
  now: Date;
}) {
  const prep = buildPrepBrief(event, null, allMeetings, now);
  return (
    <div className="flex flex-col gap-5">
      <PrepBrief prep={prep} />

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

      <LinkList title="Links seen" links={event.links} />

      <div className="text-[11px] text-muted-foreground/70 flex flex-wrap gap-3">
        <span>id {event.id}</span>
        <span>updated {formatLocalTime(event.updated_at)}</span>
      </div>
    </div>
  );
}

interface PrepBriefData {
  related: Meeting[];
  context: string[];
  openQuestions: string[];
  decisions: string[];
  actions: string[];
  links: string[];
}

function PrepBrief({ prep }: { prep: PrepBriefData | null }) {
  if (!prep || prep.related.length === 0) return null;
  const hasUsefulContext =
    prep.context.length > 0 ||
    prep.openQuestions.length > 0 ||
    prep.actions.length > 0 ||
    prep.decisions.length > 0 ||
    prep.links.length > 0;
  if (!hasUsefulContext) return null;

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="size-4 text-primary" />
              Prep brief
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Based on {prep.related.length} related earlier meeting
              {prep.related.length === 1 ? '' : 's'}.
            </p>
          </div>
          <Badge variant="outline">{prep.related.length}</Badge>
        </div>

        {prep.context.length > 0 && (
          <BriefList title="Recent Context" items={prep.context.slice(0, 3)} />
        )}
        {prep.openQuestions.length > 0 && (
          <BriefList title="Open Questions" items={prep.openQuestions.slice(0, 4)} />
        )}
        {prep.actions.length > 0 && (
          <BriefList title="Follow-ups" items={prep.actions.slice(0, 4)} />
        )}
        {prep.decisions.length > 0 && (
          <BriefList title="Last Decisions" items={prep.decisions.slice(0, 3)} />
        )}
        <LinkChipList title="Links To Revisit" links={prep.links.slice(0, 5)} />
      </CardContent>
    </Card>
  );
}

function LinkList({ title, links }: { title: string; links: string[] }) {
  if (links.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        {title}
      </h3>
      <ul className="flex flex-col gap-1 text-sm">
        {links.map((link) => (
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
  );
}

function LinkChipList({ title, links }: { title: string; links: string[] }) {
  if (links.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {links.map((link) => (
          <a
            key={link}
            href={link}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border bg-background/70 px-2 py-1 text-xs text-primary hover:underline break-all"
          >
            {link}
          </a>
        ))}
      </div>
    </div>
  );
}

function BriefList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <ul className="flex flex-col gap-1 text-sm">
        {items.map((item, i) => (
          <li key={`${title}-${i}`} className="text-muted-foreground">
            • {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function buildPrepBrief(
  event: DayEvent,
  meeting: Meeting | null,
  allMeetings: Meeting[],
  now: Date,
): PrepBriefData | null {
  if (!shouldShowPrepBrief(event, meeting, now)) return null;
  const related = findRelatedPriorMeetings(event, meeting, allMeetings);
  if (related.length === 0) return null;
  const summarySignals = collectMeetingSummarySignals(related);

  return {
    related,
    context: related
      .flatMap((m) => {
        if (!m.summary_json?.tldr) return [];
        const title = m.summary_json?.title ?? m.title ?? platformLabel(m.platform);
        return [`${formatLocalTime(m.started_at)} · ${title}: ${m.summary_json.tldr}`];
      })
      .filter(Boolean),
    openQuestions: uniqueStrings(
      summarySignals.openQuestions.map((q) => q.text),
    ),
    decisions: uniqueStrings(
      summarySignals.decisions.map((d) => d.text),
    ),
    actions: uniqueStrings(
      summarySignals.actionItems.map(actionItemLabel),
    ),
    links: uniqueStrings([
      ...related.flatMap((m) => m.links),
      ...summarySignals.links,
    ]),
  };
}

function findRelatedPriorMeetings(
  event: DayEvent,
  meeting: Meeting | null,
  allMeetings: Meeting[],
): Meeting[] {
  const eventStart = Date.parse(event.starts_at);
  if (!Number.isFinite(eventStart)) return [];
  const targetTitle = meeting?.summary_json?.title ?? meeting?.title ?? event.title;
  const targetAttendees = uniqueStrings([
    ...event.attendees,
    ...(meeting?.attendees ?? []),
    ...(meeting?.summary_json?.attendees_seen ?? []),
    ...extractTitleParticipantNames(targetTitle),
  ]);

  return allMeetings
    .filter((candidate) => candidate.id !== meeting?.id && candidate.summary_json)
    .map((candidate) => ({
      meeting: candidate,
      score: relatedMeetingScore(targetTitle, targetAttendees, eventStart, candidate),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.meeting.started_at.localeCompare(a.meeting.started_at);
    })
    .slice(0, 3)
    .map((item) => item.meeting);
}

function relatedMeetingScore(
  targetTitle: string,
  targetAttendees: string[],
  eventStart: number,
  candidate: Meeting,
): number {
  const candidateStart = Date.parse(candidate.started_at);
  if (!Number.isFinite(candidateStart) || candidateStart >= eventStart) return 0;

  const candidateTitle = candidate.summary_json?.title ?? candidate.title ?? '';
  const candidateAttendees = uniqueStrings([
    ...candidate.attendees,
    ...(candidate.summary_json?.attendees_seen ?? []),
    ...extractTitleParticipantNames(candidateTitle),
  ]).filter(isMeaningfulParticipantName);
  const attendeeOverlap = targetAttendees.filter((name) =>
    candidateAttendees.some((candidateName) => samePersonName(name, candidateName)),
  ).length;
  const sameTitle = titlesLikelySame(targetTitle, candidateTitle);
  const tokenOverlap = titleTokenOverlap(targetTitle, candidateTitle);
  const hasStrongTitleMatch = sameTitle || tokenOverlap >= 2;
  const hasStrongAttendeeMatch =
    attendeeOverlap >= 2 || (attendeeOverlap >= 1 && hasStrongTitleMatch);
  if (!hasStrongTitleMatch && !hasStrongAttendeeMatch) return 0;

  let score = 0;
  if (sameTitle) score += 20;
  if (tokenOverlap >= 2) score += tokenOverlap * 4;
  score += attendeeOverlap * 6;
  if (candidate.summary_json?.open_questions.length) score += 1;
  if (candidate.summary_json?.action_items.length) score += 1;
  if (candidate.summary_json?.tldr) score += 1;
  return score;
}

function titleTokenOverlap(a: string, b: string): number {
  const left = new Set(titleTokens(a));
  const right = new Set(titleTokens(b));
  let count = 0;
  for (const token of left) {
    if (right.has(token)) count += 1;
  }
  return count;
}

function titleTokens(title: string): string[] {
  return normaliseAgendaTitle(title)
    .split(' ')
    .filter(
      (token) =>
        token.length > 2 &&
        !/^\d+$/.test(token) &&
        !TITLE_TOKEN_STOP_WORDS.has(token),
    );
}

function samePersonName(a: string, b: string): boolean {
  const left = a.toLowerCase().trim();
  const right = b.toLowerCase().trim();
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
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
