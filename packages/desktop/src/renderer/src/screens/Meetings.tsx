import * as React from 'react';
import { Calendar, CalendarClock, CalendarDays, CheckSquare, ChevronLeft, ChevronRight, Clock, ImageOff, Inbox, Loader2, MessageSquare, Mic, RefreshCcw, ScanLine, Sparkles, Users, Video } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/sonner';
import { PageHeader } from '@/components/PageHeader';
import { Markdown } from '@/components/Markdown';
import { useFrameDetail } from '@/components/FrameDetailDialog';
import { dayEventTitleKey, dedupeAllDayCalendarDuplicates, formatDayEventTime, formatDayEventTimeRange, formatLocalTime, isAllDayEvent, localDayKey, prettyDay, shiftDay } from '@/lib/format';
import { uniqueStrings } from '@/lib/collections';
import { DAY_EVENT_KIND_COLORS as KIND_COLOR, DAY_EVENT_KIND_LABELS as KIND_LABELS, DAY_EVENT_SOURCE_LABELS as SOURCE_LABELS } from '@/lib/day-events';
import { actionItemLabel, collectMeetingSummarySignals } from '@/lib/meeting-signals';
import { cacheThumbnail, resolveAssetUrl, thumbnailCache } from '@/lib/thumbnail-cache';
import { cn } from '@/lib/utils';
import type { DayEvent, DayEventKind, Frame, Meeting, MeetingPlatform } from '@/global';

function compareDays(a: string, b: string): number { return a.localeCompare(b); }
function formatDuration(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 > 0 ? ` ${m % 60}m` : ''}`;
}
function platformLabel(p: MeetingPlatform): string { return { zoom: 'Zoom', meet: 'Google Meet', teams: 'Teams', webex: 'Webex', whereby: 'Whereby', around: 'Around', other: 'Meeting' }[p] ?? 'Meeting'; }

function KindIcon({ kind, className }: { kind: DayEventKind; className?: string }) {
  const Cmp = kind === 'meeting' ? Video : kind === 'calendar' ? CalendarClock : kind === 'communication' ? MessageSquare : kind === 'task' ? CheckSquare : Sparkles;
  return <Cmp className={cn('size-3.5', className)} />;
}

function eventDuration(e: DayEvent): number | null {
  if (isAllDayEvent(e)) return null;
  if (!e.ends_at) return null;
  const ms = Date.parse(e.ends_at) - Date.parse(e.starts_at);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function useMinuteClock(): Date {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    let int: number | null = null;
    const t = window.setTimeout(() => { setNow(new Date()); int = window.setInterval(() => setNow(new Date()), 60000); }, 60000 - (Date.now() % 60000));
    return () => { window.clearTimeout(t); if (int !== null) window.clearInterval(int); };
  }, []);
  return now;
}

function eventBelongsBeforeNowIndicator(e: DayEvent, nowMs: number): boolean {
  const s = Date.parse(e.starts_at);
  return Number.isFinite(s) && s <= nowMs;
}

function eventStartsAfterNow(e: DayEvent, nowMs: number): boolean {
  const s = Date.parse(e.starts_at);
  return Number.isFinite(s) && s > nowMs;
}

function nowIndicatorIndex(es: DayEvent[], now: Date): number { const idx = es.findIndex(e => !eventBelongsBeforeNowIndicator(e, now.getTime())); return idx === -1 ? es.length : idx; }

function dedupeEvents(es: DayEvent[]): DayEvent[] {
  const allDayKeys = new Set(es.filter(isAllDayEvent).map(e => `${e.day}|${e.kind}|${dayEventTitleKey(e.title)}`));
  const seen = new Map<string, DayEvent>();
  for (const e of es) {
    if (e.title === '__merged__') continue;
    if (!isAllDayEvent(e) && (e.kind === 'calendar' || e.source === 'calendar_screen') && allDayKeys.has(`${e.day}|${e.kind}|${dayEventTitleKey(e.title)}`)) continue;
    const m = Math.floor(Date.parse(e.starts_at) / 60000), bs = e.kind === 'meeting' ? 1 : 5, b = Math.floor(m / bs) * bs;
    const k = e.kind === 'meeting' ? `${e.day}|${e.kind}|${e.meeting_id ?? e.id}` : isAllDayEvent(e) ? `${e.day}|${e.kind}|all-day|${dayEventTitleKey(e.title)}` : `${e.day}|${e.kind}|${b}|${e.title.trim().toLowerCase()}`;
    const ex = seen.get(k);
    if (!ex) { seen.set(k, e); continue; }
    if (ex.kind === 'meeting' && e.kind === 'meeting') {
      const sc = (x: DayEvent) => (x.context_md && x.context_md.length > 20 ? 2 : 0) + (x.meeting_id ? 1 : 0);
      if (sc(e) > sc(ex)) seen.set(k, e);
    } else if (ex.kind !== 'meeting' && e.kind === 'meeting') seen.set(k, e);
  }
  return dedupeAllDayCalendarDuplicates(Array.from(seen.values()));
}

function eventTimeRange(e: DayEvent) {
  const s = Date.parse(e.starts_at), pe = e.ends_at ? Date.parse(e.ends_at) : Number.NaN;
  const en = Number.isFinite(pe) && pe > s ? pe : s + Math.max(eventDuration(e) ?? 1800000, 300000);
  return Number.isFinite(s) && Number.isFinite(en) ? { start: s, end: en } : null;
}

function normaliseAgendaTitle(t: string) { return t.toLowerCase().replace(/\b(?:google\s+meet|zoom|teams|meeting|call)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function titlesLikelySame(a: string, b: string) { const l = normaliseAgendaTitle(a), r = normaliseAgendaTitle(b); return !!(l && r && (l === r || (l.length >= 6 && r.length >= 6 && (l.includes(r) || r.includes(l))))); }

const SOLO_ACTIVITY_TITLE_RE = /\b(focus|deep work|heads down|busy|hold|blocked|personal|lunch|break|commute|ooo|out of office)\b/i;
const COLLABORATIVE_MEETING_TITLE_RE = /\b(1\s*:\s*1|1-on-1|one[-\s]?on[-\s]?one|stand[-\s]?up|sync|office hours?|all hands|planning|retro|demo|interview|review|check[-\s]?in|kickoff)\b/i;
const REMOTE_MEETING_SIGNAL_RE = /\b(zoom(?:\.us)?|google meet|meet\.google|teams\.microsoft|microsoft teams|webex|whereby|around)\b/i;
const TITLE_TOKEN_STOP_WORDS = new Set(['calendar', 'call', 'conference', 'cupertino', 'event', 'google', 'meet', 'meeting', 'office', 'hour', 'hours', 'palaven', 'room', 'session', 'teams', 'today', 'tomorrow', 'vimire', 'webex', 'whereby', 'zoom']);
const PARTICIPANT_NOISE_WORDS = new Set([...TITLE_TOKEN_STOP_WORDS, 'zoom room']);
const LOW_SIGNAL_COMMUNICATION_RE = /\b(newsletter|morning brew|unsubscribe|digest|roundup|promotion|promotional|marketing|sale|discount|coupon|receipt|statement|notification|alert|password reset|security code|verification code|recruit(?:er|ing|s)?|talent on demand|sponsored)\b/i;
const IMPORTANT_COMMUNICATION_RE = /\b(action item|assigned|blocked|decision|deadline|due|follow[-\s]?up|need(?:s|ed)?|please|proposal|question|request(?:ed|s)?|review|schedule(?:d|ing)?|sync|meeting|call|interview|intro|asks?|asked|reply|respond|waiting on|approval|approved|urgent|customer|client|contract|pricing|invoice dispute|bug|incident|outage|launch|ship|hiring loop)\b/i;

function cleanParticipantName(n: string) { return n.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/[^a-z0-9@.' -]+/gi, ' ').replace(/\s+/g, ' ').trim(); }
function isMeaningfulParticipantName(n: string) { const c = cleanParticipantName(n), k = c.toLowerCase(); return c.length >= 2 && c.length <= 60 && !/^\d+$/.test(c) && !PARTICIPANT_NOISE_WORDS.has(k) && !/\b(?:meeting|room|zoom room|calendar)\b/i.test(c) && /[a-z]/i.test(c); }
function extractTitleParticipantNames(t: string) { const h = t.split(/\s+-\s+/)[0] ?? t; return !/[\/&]|\b(?:and|with)\b/i.test(h) ? [] : uniqueStrings(h.split(/\s*(?:\/|&|\band\b|\bwith\b)\s*/i).map(cleanParticipantName).filter(isMeaningfulParticipantName)).slice(0, 8); }
function participantNamesForEvent(e: DayEvent, m: Meeting | null) { return uniqueStrings([...e.attendees, ...(m?.attendees ?? []), ...(m?.summary_json?.attendees_seen ?? []), ...extractTitleParticipantNames(m?.summary_json?.title ?? m?.title ?? e.title)]).filter(isMeaningfulParticipantName); }
function isCollaborativeMeetingEvent(e: DayEvent, m: Meeting | null) {
  if (SOLO_ACTIVITY_TITLE_RE.test(e.title)) return false;
  if (e.kind !== 'meeting' && e.kind !== 'calendar' && !m) return false;
  if (participantNamesForEvent(e, m).length > 0 || extractTitleParticipantNames(e.title).length >= 2 || COLLABORATIVE_MEETING_TITLE_RE.test(e.title)) return true;
  return REMOTE_MEETING_SIGNAL_RE.test([e.title, e.source_app ?? '', ...e.links, m?.title ?? '', ...(m?.links ?? []), ...(m?.summary_json?.links_shared ?? [])].join(' ')) && e.kind === 'meeting';
}

function isAgendaWorthyEvent(e: DayEvent): boolean {
  if (e.title === '__merged__') return false;
  if (e.kind === 'meeting' || e.kind === 'calendar' || e.kind === 'task') return true;
  if (e.source === 'meeting_capture' || e.source === 'calendar_screen' || e.source === 'task_screen') return true;
  if (e.meeting_id) return true;

  if (e.kind === 'communication' && (e.source === 'email_screen' || e.source === 'slack_screen')) {
    const text = [e.title, e.context_md, e.source_app, ...e.attendees].filter(Boolean).join(' ');
    if (LOW_SIGNAL_COMMUNICATION_RE.test(text)) return false;
    return IMPORTANT_COMMUNICATION_RE.test(text);
  }

  return false;
}

function calendarMatchScore(c: DayEvent, e: DayEvent): number {
  if (!titlesLikelySame(c.title, e.title)) return 0;
  const cr = eventTimeRange(c), er = eventTimeRange(e); if (!cr || !er) return 0;
  const o = Math.min(cr.end, er.end) - Math.max(cr.start, er.start), sd = Math.abs(cr.start - er.start), si = er.start >= cr.start - 600000 && er.start <= cr.end + 600000;
  return o <= 0 && !si && sd > 600000 ? 0 : Math.max(1, o / 60000) + Math.max(0, 30 - sd / 60000);
}

function reconcileCalendarMeetingItems(events: DayEvent[], meetingsById: Map<string, Meeting>): DayEvent[] {
  const dd = dedupeEvents(events), ce = dd.filter(e => e.source === 'calendar_screen' && e.kind === 'calendar');
  if (!ce.length) return dd;
  const hd = new Set<string>(), lk = new Map<string, { id: string; score: number }>();
  for (const e of dd) {
    if (e.source !== 'meeting_capture' || e.kind !== 'meeting' || !e.meeting_id) continue;
    let b = null;
    for (const c of ce) { const s = calendarMatchScore(c, e); if (s > 0 && (!b || s > b.score)) b = { calendar: c, score: s }; }
    if (!b) continue;
    hd.add(e.id);
    const m = meetingsById.get(e.meeting_id) ?? null;
    const qs = (m?.summary_status === 'ready' ? 10000 : 0) + (m?.summary_json?.tldr ? 3000 : 0) + (m?.transcript_chars ?? 0) + (m?.audio_chunk_count ?? 0) * 500 + Math.min(eventDuration(e) ?? 0, 5400000) / 1000 + (e.context_md?.length ?? 0);
    const curr = lk.get(b.calendar.id);
    if (!curr || qs > curr.score) lk.set(b.calendar.id, { id: e.meeting_id, score: qs });
  }
  return hd.size === 0 ? dd : dd.filter(e => !hd.has(e.id)).map(e => {
    const l = lk.get(e.id); if (!l) return e;
    const m = meetingsById.get(l.id) ?? null;
    return { ...e, meeting_id: l.id, context_md: m?.summary_json?.tldr ?? e.context_md, attendees: Array.from(new Set([...e.attendees, ...(m?.attendees ?? [])])), links: Array.from(new Set([...e.links, ...(m?.links ?? [])])) };
  });
}

export function Meetings({ events, meetings, loading, focusRequest, onRefresh }: any) {
  const [scanning, setScanning] = React.useState(false);
  const runScan = React.useCallback(async () => {
    if (scanning) return; setScanning(true);
    try {
      const r = await window.beside.triggerEventExtractor();
      if (r.meetingsLifted + r.llmExtracted + r.contextEnriched > 0 || r.audioTranscribed + r.audioImported > 0 || r.summariesSucceeded > 0) toast.success('Event scan complete', { description: `${r.audioTranscribed + r.audioImported > 0 ? `${r.audioTranscribed + r.audioImported} audio ` : ''}${r.meetingsCreated + r.meetingsExtended > 0 ? `${r.meetingsCreated + r.meetingsExtended} meetings ` : ''}processed` });
      else if (!r.modelAvailable) toast.info('Event scan skipped', { description: 'Model offline.' });
      else toast.info('No new events', { description: `Scanned ${r.framesScanned} frames.` });
      await onRefresh();
    } catch (err: any) { toast.error('Scan failed', { description: err.message || String(err) }); } finally { setScanning(false); }
  }, [scanning, onRefresh]);

  const [dayOverrides, setDayOverrides] = React.useState<Map<string, DayEvent[]>>(() => new Map()), [perDayLoading, setPerDayLoading] = React.useState<string | null>(null);
  React.useEffect(() => { setDayOverrides(new Map()); }, [events]);

  const currentTime = useMinuteClock(), today = React.useMemo(() => localDayKey(currentTime), [currentTime]);
  const meetingsById = React.useMemo(() => new Map<string, Meeting>(meetings.map((m: Meeting) => [m.id, m])), [meetings]);
  const daysFromProps = React.useMemo(() => Array.from(new Set(events.map((e: DayEvent) => e.day))).sort((a: any, b: any) => compareDays(b, a)) as string[], [events]);

  const [selectedDay, setSelectedDay] = React.useState<string>(today), pfRef = React.useRef<string | null>(null), hfRef = React.useRef(0), ajRef = React.useRef(false);
  React.useEffect(() => { if (!ajRef.current && !pfRef.current && daysFromProps.length) { ajRef.current = true; if (!events.some((e: DayEvent) => e.day === today)) setSelectedDay(daysFromProps[0]!); } }, [daysFromProps, events, today]);

  const visibleEvents = React.useMemo(() => reconcileCalendarMeetingItems(dayOverrides.get(selectedDay) ?? events.filter((e: DayEvent) => e.day === selectedDay), meetingsById).filter(isAgendaWorthyEvent).sort((a, b) => a.starts_at.localeCompare(b.starts_at)), [selectedDay, events, dayOverrides, meetingsById]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!focusRequest || focusRequest.id === hfRef.current) return;
    hfRef.current = focusRequest.id;
    if (!focusRequest.target) { pfRef.current = null; return; }
    ajRef.current = true; pfRef.current = focusRequest.target.eventId; setSelectedDay(focusRequest.target.day);
  }, [focusRequest]);

  React.useEffect(() => {
    if (pfRef.current) { if (visibleEvents.some(e => e.id === pfRef.current)) { setSelectedId(pfRef.current); pfRef.current = null; } else setSelectedId(null); return; }
    if (!visibleEvents.length) setSelectedId(null); else if (!selectedId || !visibleEvents.find(e => e.id === selectedId)) setSelectedId(visibleEvents[0]!.id);
  }, [selectedDay, visibleEvents, selectedId]);

  const loadDay = React.useCallback(async (day: string) => {
    if ((daysFromProps.includes(day) && !dayOverrides.has(day)) || perDayLoading === day) return;
    setPerDayLoading(day);
    try { const f = await window.beside.listDayEvents({ day }) ?? []; setDayOverrides(p => new Map(p).set(day, f)); }
    catch { setDayOverrides(p => p.has(day) ? p : new Map(p).set(day, [])); } finally { setPerDayLoading(c => c === day ? null : c); }
  }, [daysFromProps, dayOverrides, perDayLoading]);

  React.useEffect(() => { if (selectedDay && !daysFromProps.includes(selectedDay) && !dayOverrides.has(selectedDay)) loadDay(selectedDay); }, [selectedDay, daysFromProps, dayOverrides, loadDay]);

  const ni = selectedDay === today && visibleEvents.length ? nowIndicatorIndex(visibleEvents, currentTime) : -1;
  const selEvent = visibleEvents.find(e => e.id === selectedId) ?? null;

  return (
    <div className="flex flex-col h-full gap-5 pt-6 pb-2 min-h-0">
      <div className="flex-none">
        <PageHeader title="Agenda" description="Meetings, calendar entries, and extracted events." actions={<><Button variant="outline" size="sm" onClick={runScan} disabled={scanning} className="gap-1.5">{scanning ? <Loader2 className="size-3.5 animate-spin" /> : <ScanLine className="size-3.5" />}Scan now</Button><Button variant="outline" size="sm" onClick={onRefresh} disabled={loading} className="gap-1.5">{loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCcw className="size-3.5" />}Refresh</Button></>} />
      </div>

      {loading && !visibleEvents.length && !dayOverrides.size ? <div className="flex-1 grid place-items-center text-muted-foreground text-sm gap-2"><div className="flex flex-col items-center gap-2"><Loader2 className="size-5 animate-spin" />Loading…</div></div> : (
        <div className="flex gap-5 min-h-0 flex-1">
          <div className="w-[340px] shrink-0 flex flex-col gap-4">
            <div className="flex-none">
              <DayPicker selectedDay={selectedDay} today={today} loading={perDayLoading === selectedDay} eventCount={visibleEvents.length} onPrev={() => setSelectedDay(d => shiftDay(d, -1))} onNext={() => setSelectedDay(d => shiftDay(d, 1))} onToday={() => setSelectedDay(today)} onPick={setSelectedDay} />
            </div>
            <Card className="flex-1 flex flex-col min-h-0 overflow-hidden bg-card border-border/50 shadow-sm">
              <ScrollArea className="flex-1">
                <div className="flex flex-col p-2 gap-1.5">
                  {!visibleEvents.length ? <DayEmptyState day={selectedDay} loading={perDayLoading === selectedDay} onScan={runScan} scanning={scanning} /> : visibleEvents.map((e, i) => <React.Fragment key={e.id}>{i === ni && <NowIndicator now={currentTime} />}<EventRow event={e} active={e.id === selectedId} onClick={() => setSelectedId(e.id === selectedId ? null : e.id)} meeting={e.meeting_id ? meetingsById.get(e.meeting_id) ?? null : null} /></React.Fragment>)}
                  {ni === visibleEvents.length && <NowIndicator now={currentTime} />}
                </div>
              </ScrollArea>
            </Card>
          </div>
          
          <div className="flex-1 flex flex-col min-w-0 gap-5">
            <DayBriefRecap events={visibleEvents} meetingsById={meetingsById} selectedDay={selectedDay} today={today} now={currentTime} onSelectEvent={setSelectedId} />
            <Card className="flex-1 flex flex-col min-h-0 overflow-hidden bg-card border-border/50 shadow-sm">
              {!selEvent ? (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-4">
                  <CalendarDays className="size-12 opacity-20" />
                  <p className="text-sm font-medium">Select an event to view details</p>
                </div>
              ) : (
                <ScrollArea className="flex-1">
                  <div className="flex flex-col p-8 max-w-4xl mx-auto w-full gap-8">
                    <EventDetailHeader event={selEvent} meeting={selEvent.meeting_id ? meetingsById.get(selEvent.meeting_id) ?? null : null} />
                    <Separator className="bg-border/50" />
                    {selEvent.meeting_id ? <MeetingBody event={selEvent} meeting={meetingsById.get(selEvent.meeting_id)!} allMeetings={meetings} now={currentTime} /> : <NonMeetingBody event={selEvent} allMeetings={meetings} now={currentTime} />}
                  </div>
                </ScrollArea>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function DayPicker({ selectedDay, today, loading, eventCount, onPrev, onNext, onToday, onPick }: any) {
  const r = React.useRef<HTMLInputElement>(null), it = selectedDay === today;
  return (
    <div className="flex items-center gap-2">
      <div className="relative inline-flex items-center gap-1 rounded-full border border-border/50 bg-card p-1 shadow-sm"><Button variant="ghost" size="icon" onClick={onPrev} className="rounded-full size-8 hover:text-foreground"><ChevronLeft className="size-4" /></Button><button type="button" onClick={() => { if (r.current?.showPicker) { try { r.current.showPicker(); } catch { r.current.focus(); r.current.click(); } } else { r.current?.focus(); r.current?.click(); } }} className="inline-flex h-8 min-w-28 items-center justify-center gap-2 rounded-full px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground">{loading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : <CalendarDays className="size-3.5" />}<span>{prettyDay(selectedDay)}</span></button><Button variant="ghost" size="icon" onClick={onNext} className="rounded-full size-8 hover:text-foreground"><ChevronRight className="size-4" /></Button><input ref={r} type="date" value={selectedDay} onChange={e => e.target.value && onPick(e.target.value)} className="absolute inset-0 opacity-0 pointer-events-none" /></div>
      {!it && <Button variant="outline" size="sm" onClick={onToday} className="h-9 rounded-full px-3 font-medium">Today</Button>}
      {eventCount > 0 && <span className="ml-2 text-xs font-medium text-muted-foreground bg-muted px-2 py-1 rounded-full">{eventCount} event{eventCount > 1 ? 's' : ''}</span>}
    </div>
  );
}

function DayBriefRecap({ events, meetingsById, selectedDay, today, now, onSelectEvent }: any) {
  if (!events.length) return null;
  const nMs = now.getTime();
  const upc = selectedDay === today
    ? events.find((e: DayEvent) => eventStartsAfterNow(e, nMs)) ?? null
    : events[0];
  const mtgs = events.map((e: DayEvent) => e.meeting_id ? meetingsById.get(e.meeting_id) ?? null : null).filter(Boolean);
  const sigs = collectMeetingSummarySignals(mtgs);
  const followups = sigs.actionItems.slice(0, 4);
  if (!upc && followups.length === 0) return null;

  const meetingIdForAction = (task: string): string | null => {
    for (const m of mtgs as Meeting[]) {
      if (m.summary_json?.action_items?.some((a: any) => a.task === task)) {
        const ev = events.find((e: DayEvent) => e.meeting_id === m.id);
        return ev?.id ?? null;
      }
    }
    return null;
  };

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] flex-none">
      {upc ? (
        <button type="button" onClick={() => onSelectEvent(upc.id)} className="rounded-xl border border-border/50 bg-card p-5 text-left transition-all hover:border-primary/40 hover:shadow-md group flex flex-col gap-2 min-w-0">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground group-hover:text-primary transition-colors"><CalendarClock className="size-4" />{selectedDay === today ? 'Next up' : 'First event'}</div>
          <div className="min-w-0">
            <div className="text-base font-semibold leading-tight truncate">{upc.title}</div>
            <div className="mt-1 text-sm text-muted-foreground font-medium truncate">{formatDayEventTimeRange(upc)}{upc.attendees.length > 0 && <span className="opacity-80"> · {upc.attendees.slice(0, 2).join(', ')}{upc.attendees.length > 2 ? `, +${upc.attendees.length - 2}` : ''}</span>}</div>
          </div>
        </button>
      ) : <div className="rounded-xl border border-dashed border-border/50 bg-card/50 p-5 flex items-center justify-center text-sm text-muted-foreground">Nothing else scheduled today</div>}

      <div className="rounded-xl border border-border/50 bg-card p-5 shadow-sm flex flex-col gap-3 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground"><CheckSquare className="size-4" />Follow-ups</div>
          {followups.length > 0 && <Badge variant="default" className="px-2">{sigs.actionItems.length}</Badge>}
        </div>
        {followups.length > 0 ? (
          <ul className="flex flex-col gap-1.5 text-sm text-foreground/90">
            {followups.map((item: any, i: number) => {
              const evId = meetingIdForAction(item.task);
              const content = (
                <>
                  <span className="text-primary mt-0.5 shrink-0">•</span>
                  <span className="min-w-0 line-clamp-1"><span className="font-medium">{item.task}</span>{item.owner && <span className="text-muted-foreground"> — {item.owner}</span>}</span>
                </>
              );
              return evId ? (
                <li key={i}><button type="button" onClick={() => onSelectEvent(evId)} className="flex gap-2 items-start text-left w-full rounded-md px-1.5 py-1 -mx-1.5 hover:bg-muted/60 transition-colors">{content}</button></li>
              ) : (
                <li key={i} className="flex gap-2 items-start px-1.5 py-1">{content}</li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No action items captured for this day.</p>
        )}
      </div>
    </div>
  );
}

function DayEmptyState({ day, loading, onScan, scanning }: any) {
  if (loading) return <div className="flex items-center gap-2 py-16 px-3 text-muted-foreground text-sm font-medium justify-center"><Loader2 className="size-5 animate-spin text-primary" />Loading {prettyDay(day)}…</div>;
  return <div className="flex flex-col items-center text-center gap-4 py-16 px-4 text-muted-foreground"><CalendarClock className="size-10 opacity-20" /><div className="space-y-1"><p className="text-base font-semibold text-foreground">No events on {prettyDay(day)}</p><p className="text-sm max-w-[16rem] leading-relaxed">The event extractor runs on a 15-min cadence. Scan it manually to refresh.</p></div><Button variant="outline" size="sm" onClick={onScan} disabled={scanning} className="gap-1.5 mt-2 rounded-full px-4">{scanning ? <Loader2 className="size-3.5 animate-spin" /> : <ScanLine className="size-3.5" />}Scan now</Button></div>;
}

function NowIndicator({ now }: { now: Date }) {
  return <div className="grid grid-cols-[3.5rem_1fr] items-center gap-2 px-1 py-2"><span className="text-[11px] font-bold tabular-nums text-primary">{formatLocalTime(now.toISOString())}</span><div className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-primary shadow-[0_0_0_4px_hsl(var(--primary)/0.15)]" /><span className="h-0.5 flex-1 bg-primary/40 rounded-full" /><span className="text-[10px] font-bold uppercase tracking-widest text-primary">Now</span></div></div>;
}

function EventRow({ event, active, onClick, meeting }: { event: DayEvent; active: boolean; onClick: () => void; meeting: Meeting | null }) {
  const dur = eventDuration(event), ht = (meeting?.transcript_chars ?? 0) > 0;
  return (
    <button type="button" onClick={onClick} className={cn('group w-full text-left rounded-xl px-3 py-3.5 transition-all border', active ? 'border-primary/30 bg-primary/5 shadow-sm' : 'border-transparent hover:bg-muted/50')}>
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-start min-w-[3.5rem] pt-0.5"><span className={cn("text-xs font-bold tabular-nums", active ? "text-primary" : "text-foreground")}>{formatDayEventTime(event)}</span>{dur != null && <span className="text-[10px] text-muted-foreground tabular-nums font-medium mt-0.5">{formatDuration(dur)}</span>}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2">
            <span className={cn('mt-0.5 shrink-0 text-muted-foreground/50 transition-colors', active ? KIND_COLOR[event.kind] : 'group-hover:text-muted-foreground/80')} aria-hidden="true"><KindIcon kind={event.kind} className="size-3.5" /></span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold leading-tight line-clamp-2">{event.title}</div>
              {event.kind !== 'meeting' && event.context_md && <p className="mt-1.5 text-xs text-muted-foreground/75 line-clamp-2 leading-relaxed">{event.context_md}</p>}
              {event.kind === 'meeting' && meeting?.summary_json?.tldr && !event.context_md && <p className="mt-1.5 text-xs text-muted-foreground/75 line-clamp-2 leading-relaxed">{meeting.summary_json.tldr}</p>}
              {event.kind === 'meeting' && ht && !meeting?.summary_json?.tldr && <p className="mt-1.5 text-xs text-muted-foreground/60 italic line-clamp-2">Summary pending.</p>}
            </div>
          </div>
        </div>
      </div>
    </button>
  );
}

function EventDetailHeader({ event, meeting }: { event: DayEvent; meeting: Meeting | null }) {
  const dur = eventDuration(event), sl = SOURCE_LABELS[event.source] ?? event.source;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{event.title}</h1>
        <div className="flex items-center gap-2 mt-1">
          <Badge variant="secondary" className={cn('text-xs gap-1.5 px-2.5 py-0.5', KIND_COLOR[event.kind])}><KindIcon kind={event.kind} className="size-3.5" />{KIND_LABELS[event.kind]}</Badge>
          {meeting && <Badge variant="outline" className="text-xs px-2.5 py-0.5 font-medium">{platformLabel(meeting.platform)}</Badge>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-muted-foreground">
        <div className="flex items-center gap-2"><Calendar className="size-4 opacity-70" /><span className="font-medium">{prettyDay(event.day)}</span></div>
        <div className="flex items-center gap-2"><Clock className="size-4 opacity-70" /><span className="font-medium">{formatDayEventTimeRange(event)}</span>{dur != null && <span className="text-muted-foreground/60 font-normal">({formatDuration(dur)})</span>}</div>
        {event.source_app && <div className="flex items-center gap-2"><Inbox className="size-4 opacity-70" /><span className="font-medium">{event.source_app}</span></div>}
        <div className="flex items-center gap-2 text-muted-foreground/80"><span className="text-xs uppercase tracking-wider font-bold">{sl}</span></div>
      </div>
      {event.attendees.length > 0 && (
        <div className="flex items-center gap-2.5 text-sm text-muted-foreground mt-1">
          <Users className="size-4 opacity-70 shrink-0" />
          <div className="flex flex-wrap gap-1.5">
            {event.attendees.slice(0, 8).map(a => <span key={a} className="inline-flex items-center rounded-md bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground hover:bg-muted/80 transition-colors">{a}</span>)}
            {event.attendees.length > 8 && <span className="inline-flex items-center rounded-md bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">+{event.attendees.length - 8}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function MeetingBody({ event, meeting, allMeetings, now }: any) {
  const s = meeting.summary_json, hm = !!meeting.summary_md, pb = buildPrepBrief(event, meeting, allMeetings, now);
  return (
    <div className="flex flex-col gap-8">
      <PrepBrief prep={pb} />
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {meeting.transcript_chars === 0 && <span className="inline-flex items-center gap-1.5"><Mic className="size-3.5 opacity-50" />No audio captured</span>}
        <MeetingStatusBadge status={meeting.summary_status} />
      </div>
      {meeting.summary_status === 'ready' && hm ? (
        <div className="flex flex-col gap-8">
          {s?.tldr && <Card className="bg-primary/5 border-primary/20 shadow-sm"><CardContent className="pt-5 pb-5"><p className="text-xs font-bold mb-2 text-primary uppercase tracking-wider">TL;DR</p><p className="text-base font-medium leading-relaxed">{s.tldr}</p></CardContent></Card>}
          {s && s.action_items.length > 0 && <div className="flex flex-col gap-4"><h3 className="text-sm font-bold uppercase tracking-wider text-foreground border-b border-border/50 pb-2">Action Items</h3><ul className="flex flex-col gap-4 mt-1">{s.action_items.map((item: any, i: number) => <li key={i} className="flex items-start gap-3.5 text-base"><span className="mt-0.5 size-6 shrink-0 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold">{i + 1}</span><div className="flex flex-col gap-1"><span className="font-medium text-foreground">{item.task}</span>{item.owner && <span className="text-sm text-muted-foreground">Assigned to: <span className="font-medium text-foreground">{item.owner}</span></span>}</div></li>)}</ul></div>}
          {s && s.decisions.length > 0 && <div className="flex flex-col gap-4"><h3 className="text-sm font-bold uppercase tracking-wider text-foreground border-b border-border/50 pb-2">Decisions</h3><ul className="flex flex-col gap-3 mt-1">{s.decisions.map((d: any, i: number) => <li key={i} className="flex items-start gap-3.5 text-base"><div className="mt-2.5 size-1.5 rounded-full bg-primary shrink-0" /><span className="text-foreground leading-relaxed">{d.text}</span></li>)}</ul></div>}
          {s && s.open_questions.length > 0 && <div className="flex flex-col gap-4"><h3 className="text-sm font-bold uppercase tracking-wider text-foreground border-b border-border/50 pb-2">Open Questions</h3><ul className="flex flex-col gap-3 mt-1">{s.open_questions.map((q: any, i: number) => <li key={i} className="flex items-start gap-3.5 text-base"><div className="mt-2.5 size-1.5 rounded-full bg-primary shrink-0" /><span className="text-foreground leading-relaxed">{q.text}</span></li>)}</ul></div>}
          <div className="mt-4"><h3 className="text-sm font-bold uppercase tracking-wider text-foreground border-b border-border/50 pb-2 mb-5">Full Summary</h3><div className="prose prose-sm md:prose-base dark:prose-invert max-w-none prose-p:leading-relaxed prose-pre:bg-muted/50"><Markdown content={meeting.summary_md!} /></div></div>
        </div>
      ) : meeting.summary_status === 'pending' || meeting.summary_status === 'running' ? (
        <div className="flex flex-col items-center justify-center gap-4 py-20 text-muted-foreground bg-muted/20 rounded-xl border border-dashed border-border/50"><Loader2 className="size-8 animate-spin text-primary" /><p className="text-base font-medium">{meeting.summary_status === 'running' ? 'Summary is being generated…' : 'Summary is queued and will be ready shortly.'}</p></div>
      ) : meeting.summary_status === 'failed' ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 bg-destructive/5 rounded-xl border border-destructive/20"><p className="text-base font-bold text-destructive">Summary generation failed</p>{meeting.failure_reason && <p className="text-sm text-destructive/80 max-w-md text-center">{meeting.failure_reason}</p>}{event.context_md && <p className="text-sm text-muted-foreground italic mt-2 max-w-md text-center">{event.context_md}</p>}</div>
      ) : meeting.summary_status === 'skipped_short' ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 bg-muted/20 rounded-xl border border-dashed border-border/50 text-muted-foreground"><p className="text-base font-medium">This meeting was too short to summarize.</p>{event.context_md && <p className="text-sm italic max-w-md text-center">{event.context_md}</p>}</div>
      ) : <div className="py-16 text-center text-base font-medium text-muted-foreground bg-muted/10 rounded-xl border border-dashed border-border/50">{event.context_md ?? 'No summary available yet.'}</div>}
      <MeetingScreenshots meeting={meeting} />
    </div>
  );
}

function NonMeetingBody({ event, allMeetings, now }: any) {
  const pb = buildPrepBrief(event, null, allMeetings, now);
  return (
    <div className="flex flex-col gap-8">
      <PrepBrief prep={pb} />
      <div className="text-sm font-medium text-muted-foreground bg-muted/30 border border-border/50 px-4 py-2 rounded-md inline-flex self-start">Extracted from {event.evidence_frame_ids.length || 'recent'} screen capture{event.evidence_frame_ids.length === 1 ? '' : 's'} of {event.source_app ?? 'your screen'}.</div>
      {event.context_md ? <Card className="bg-card shadow-sm border-border/50"><CardContent className="pt-6 pb-6"><p className="text-xs font-bold mb-4 text-muted-foreground uppercase tracking-wider border-b border-border/50 pb-2">Context</p><p className="text-base whitespace-pre-wrap leading-relaxed text-foreground">{event.context_md}</p></CardContent></Card> : <div className="text-base font-medium text-muted-foreground py-12 text-center bg-muted/10 rounded-xl border border-dashed border-border/50">No additional context was extracted for this event.</div>}
      <LinkList title="Links seen" links={event.links} />
      <div className="text-xs font-mono font-medium text-muted-foreground/60 flex flex-wrap gap-4 mt-8 pt-6 border-t border-border/50"><span>ID: {event.id}</span><span>Updated: {formatLocalTime(event.updated_at)}</span></div>
    </div>
  );
}

function PrepBrief({ prep }: any) {
  if (!prep || !prep.related.length || (!prep.context.length && !prep.openQuestions.length && !prep.actions.length && !prep.decisions.length && !prep.links.length)) return null;
  return (
    <Card className="border-primary/20 bg-primary/5 shadow-sm"><CardContent className="flex flex-col gap-5 pt-5 pb-5">
      <div className="flex items-start justify-between gap-3 border-b border-primary/10 pb-3"><div><div className="flex items-center gap-2.5 text-base font-bold text-foreground"><Sparkles className="size-4.5 text-primary" />Prep brief</div><p className="mt-1 text-sm font-medium text-muted-foreground">Based on {prep.related.length} related earlier meeting{prep.related.length === 1 ? '' : 's'}.</p></div><Badge variant="outline" className="bg-background">{prep.related.length}</Badge></div>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-5">
          {prep.context.length > 0 && <BriefList title="Recent Context" items={prep.context.slice(0, 3)} />}
          {prep.decisions.length > 0 && <BriefList title="Last Decisions" items={prep.decisions.slice(0, 3)} />}
        </div>
        <div className="flex flex-col gap-5">
          {prep.openQuestions.length > 0 && <BriefList title="Open Questions" items={prep.openQuestions.slice(0, 4)} />}
          {prep.actions.length > 0 && <BriefList title="Follow-ups" items={prep.actions.slice(0, 4)} />}
        </div>
      </div>
      {prep.links.length > 0 && <div className="mt-2"><h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">Links To Revisit</h3><div className="flex flex-wrap gap-2">{prep.links.slice(0, 5).map((l: string) => <a key={l} href={l} target="_blank" rel="noreferrer" className="rounded-md border border-border/50 bg-background/70 px-3 py-1.5 text-sm font-medium text-primary hover:underline hover:bg-background transition-colors break-all">{l}</a>)}</div></div>}
    </CardContent></Card>
  );
}

function LinkList({ title, links }: any) {
  if (!links.length) return null;
  return <div><h3 className="text-sm font-bold uppercase tracking-wider text-foreground border-b border-border/50 pb-2 mb-4">{title}</h3><ul className="flex flex-col gap-2.5 text-base">{links.map((l: string) => <li key={l} className="flex"><a href={l} target="_blank" rel="noreferrer" className="text-primary font-medium underline-offset-4 hover:underline break-all">{l}</a></li>)}</ul></div>;
}

function MeetingScreenshots({ meeting }: { meeting: Meeting }) {
  const [frames, setFrames] = React.useState<Frame[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!meeting.entity_path || meeting.screenshot_count <= 0) { setFrames([]); return; }
      setLoading(true);
      try {
        const from = new Date(Date.parse(meeting.started_at) - 10 * 60_000).toISOString();
        const to = new Date(Date.parse(meeting.ended_at) + 2 * 60_000).toISOString();
        const all = await window.beside.searchFrames({ entityPath: meeting.entity_path, entityKind: 'meeting', from, to, limit: 80 }) as Frame[];
        if (!cancelled) setFrames(all.filter(f => f.asset_path && f.timestamp).sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '')).slice(0, 12));
      } catch {
        if (!cancelled) setFrames([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [meeting.entity_path, meeting.ended_at, meeting.screenshot_count, meeting.started_at]);

  if (!loading && frames.length === 0) return null;
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm font-bold uppercase tracking-wider text-foreground border-b border-border/50 pb-2">Screenshots</h3>
      {loading && frames.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading screenshots…</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {frames.map(frame => <MeetingScreenshotThumb key={frame.id} frame={frame} />)}
        </div>
      )}
    </div>
  );
}

function MeetingScreenshotThumb({ frame }: { frame: Frame }) {
  const [thumb, setThumb] = React.useState<string | null>(null);
  const detail = useFrameDetail();
  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!frame.asset_path) return;
      const cached = thumbnailCache.get(frame.asset_path);
      if (cached) { setThumb(cached); return; }
      try {
        const url = await resolveAssetUrl(frame.asset_path);
        if (!cancelled) { cacheThumbnail(frame.asset_path, url); setThumb(url); }
      } catch {
        if (!cancelled) setThumb(null);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [frame.asset_path]);

  return (
    <button type="button" onClick={() => detail.open(frame)} className="group overflow-hidden rounded-xl border border-border/50 bg-muted/30 text-left transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <div className="aspect-video grid place-items-center overflow-hidden bg-muted/50">
        {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]" /> : <div className="flex flex-col items-center gap-1 text-muted-foreground"><ImageOff className="size-5" /><span className="text-xs">No preview</span></div>}
      </div>
      <div className="flex flex-col gap-1 p-2.5">
        <span className="font-mono text-[11px] text-muted-foreground">{formatLocalTime(frame.timestamp)}</span>
        <span className="line-clamp-1 text-xs font-medium text-foreground">{frame.window_title || frame.app || 'Meeting screenshot'}</span>
      </div>
    </button>
  );
}

function BriefList({ title, items }: any) {
  return <div className="flex flex-col gap-2.5"><h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</h3><ul className="flex flex-col gap-2 text-sm">{items.map((it: string, i: number) => <li key={i} className="text-foreground leading-relaxed flex gap-2"><span className="text-primary/50 mt-0.5">•</span><span>{it}</span></li>)}</ul></div>;
}

function buildPrepBrief(event: DayEvent, meeting: Meeting | null, allMeetings: Meeting[], now: Date) {
  if (!(Number.isFinite(Date.parse(event.starts_at)) && now.getTime() < Date.parse(event.starts_at) && isCollaborativeMeetingEvent(event, meeting))) return null;
  const t = meeting?.summary_json?.title ?? meeting?.title ?? event.title;
  const a = uniqueStrings([...event.attendees, ...(meeting?.attendees ?? []), ...(meeting?.summary_json?.attendees_seen ?? []), ...extractTitleParticipantNames(t)]);
  const r = allMeetings.filter(c => c.id !== meeting?.id && c.summary_json).map(c => ({ m: c, s: relatedMeetingScore(t, a, Date.parse(event.starts_at), c) })).filter(x => x.s > 0).sort((x, y) => x.s !== y.s ? y.s - x.s : y.m.started_at.localeCompare(x.m.started_at)).slice(0, 3).map(x => x.m);
  if (!r.length) return null;
  const sigs = collectMeetingSummarySignals(r);
  return { related: r, context: r.map(m => m.summary_json?.tldr ? `${formatLocalTime(m.started_at)} · ${m.summary_json.title ?? m.title ?? platformLabel(m.platform)}: ${m.summary_json.tldr}` : '').filter(Boolean), openQuestions: uniqueStrings(sigs.openQuestions.map((q: any) => q.text)), decisions: uniqueStrings(sigs.decisions.map((d: any) => d.text)), actions: uniqueStrings(sigs.actionItems.map(actionItemLabel)), links: uniqueStrings([...r.flatMap(m => m.links), ...sigs.links]) };
}

function relatedMeetingScore(tTitle: string, tAtts: string[], eStart: number, cand: Meeting) {
  const cStart = Date.parse(cand.started_at); if (!Number.isFinite(cStart) || cStart >= eStart) return 0;
  const cTitle = cand.summary_json?.title ?? cand.title ?? '', cAtts = uniqueStrings([...cand.attendees, ...(cand.summary_json?.attendees_seen ?? []), ...extractTitleParticipantNames(cTitle)]).filter(isMeaningfulParticipantName);
  const aOv = tAtts.filter(n => cAtts.some(c => (n.toLowerCase().trim() === c.toLowerCase().trim() || n.toLowerCase().trim().includes(c.toLowerCase().trim()) || c.toLowerCase().trim().includes(n.toLowerCase().trim())))).length, sTitle = titlesLikelySame(tTitle, cTitle);
  const tOv = new Set(tTitle.toLowerCase().replace(/\b(?:google\s+meet|zoom|teams|meeting|call)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(t => t.length > 2 && !/^\d+$/.test(t) && !TITLE_TOKEN_STOP_WORDS.has(t)));
  let cT = 0; new Set(cTitle.toLowerCase().replace(/\b(?:google\s+meet|zoom|teams|meeting|call)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(t => t.length > 2 && !/^\d+$/.test(t) && !TITLE_TOKEN_STOP_WORDS.has(t))).forEach(t => { if (tOv.has(t)) cT++; });
  if (!sTitle && cT < 2 && aOv < 2 && !(aOv >= 1 && (sTitle || cT >= 2))) return 0;
  return (sTitle ? 20 : 0) + (cT >= 2 ? cT * 4 : 0) + aOv * 6 + (cand.summary_json?.open_questions.length ? 1 : 0) + (cand.summary_json?.action_items.length ? 1 : 0) + (cand.summary_json?.tldr ? 1 : 0);
}

function MeetingStatusBadge({ status }: any) {
  if (status === 'ready') return <Badge variant="outline" className="text-xs font-semibold border-emerald-500/30 bg-emerald-500/10 text-emerald-600 px-2.5 py-0.5 rounded-md">Summarized</Badge>;
  if (status === 'running') return <Badge variant="outline" className="text-xs font-semibold border-primary/30 bg-primary/10 text-primary animate-pulse px-2.5 py-0.5 rounded-md">Summarizing…</Badge>;
  if (status === 'pending') return <Badge variant="secondary" className="text-xs font-semibold px-2.5 py-0.5 rounded-md">Pending</Badge>;
  if (status === 'failed') return <Badge variant="outline" className="text-xs font-semibold border-destructive/30 bg-destructive/10 text-destructive px-2.5 py-0.5 rounded-md">Failed</Badge>;
  if (status === 'skipped_short') return <Badge variant="secondary" className="text-xs font-semibold px-2.5 py-0.5 rounded-md opacity-80">Too short</Badge>;
  return null;
}

