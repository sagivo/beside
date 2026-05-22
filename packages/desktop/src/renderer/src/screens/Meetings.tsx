import * as React from 'react';
import { ArrowRight, BookOpen, Calendar, CalendarClock, CalendarDays, CheckSquare, ChevronLeft, ChevronRight, Clock, Compass, ImageOff, Inbox, List, Loader2, MessageSquare, Mic, Moon, RefreshCcw, ScanLine, Sparkles, Sun, Sunrise, Sunset, Users, Video, X } from 'lucide-react';
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
function agendaTitleTokens(t: string) { return normaliseAgendaTitle(t).split(' ').filter(x => x.length > 1 && !/^\d+$/.test(x) && !TITLE_TOKEN_STOP_WORDS.has(x)); }
function titlesLikelySame(a: string, b: string) {
  const l = normaliseAgendaTitle(a), r = normaliseAgendaTitle(b);
  if (!l || !r) return false;
  if (l === r || (l.length >= 6 && r.length >= 6 && (l.includes(r) || r.includes(l)))) return true;
  const lt = new Set(agendaTitleTokens(a)), rt = new Set(agendaTitleTokens(b));
  const min = Math.min(lt.size, rt.size);
  if (min === 0) return false;
  let overlap = 0;
  lt.forEach(t => { if (rt.has(t)) overlap++; });
  return overlap >= Math.min(2, min);
}

const SOLO_ACTIVITY_TITLE_RE = /\b(focus|deep work|heads down|busy|hold|blocked|personal|lunch|break|commute|ooo|out of office)\b/i;
const COLLABORATIVE_MEETING_TITLE_RE = /\b(1\s*:\s*1|1-on-1|one[-\s]?on[-\s]?one|stand[-\s]?up|sync|office hours?|all hands|planning|retro|demo|interview|review|check[-\s]?in|kickoff)\b/i;
const REMOTE_MEETING_SIGNAL_RE = /\b(zoom(?:\.us)?|google meet|meet\.google|teams\.microsoft|microsoft teams|webex|whereby|around)\b/i;
const TITLE_TOKEN_STOP_WORDS = new Set(['calendar', 'call', 'conference', 'cupertino', 'event', 'google', 'meet', 'meeting', 'office', 'hour', 'hours', 'palaven', 'room', 'session', 'teams', 'today', 'tomorrow', 'vimire', 'webex', 'whereby', 'zoom']);
const PARTICIPANT_NOISE_WORDS = new Set([...TITLE_TOKEN_STOP_WORDS, 'zoom room']);
const LOW_SIGNAL_COMMUNICATION_RE = /\b(newsletter|morning brew|unsubscribe|digest|roundup|promotion|promotional|marketing|sale|discount|coupon|receipt|statement|notification|alert|password reset|security code|verification code|recruit(?:er|ing|s)?|talent on demand|sponsored)\b/i;
const IMPORTANT_COMMUNICATION_RE = /\b(action item|assigned|block(?:ed|er|ing)?|decision|deadline|due|follow[-\s]?up|need(?:s|ed)?|proposal|review|waiting on|approval|approved|urgent|customer|client|contract|pricing|invoice dispute|bug|incident|outage|sev(?:\d+)?|post[-\s]?mortem|launch|ship|hiring loop|prod(?:uction)?|error|failure|failed|fix)\b/i;
const IMPORTANT_TASK_RE = /\b(action item|assigned|block(?:ed|er|ing)?|deadline|due|follow[-\s]?up|post[-\s]?mortem|customer|client|bug|incident|outage|launch|ship|approval|review)\b/i;
const CALENDAR_ECHO_RE = /\b(a scheduled|scheduled meeting|scheduled standup|calendar invite|updated invitation|meeting details|visible in accessibility text|no audio|the team discussed)\b/i;

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

function eventSearchText(e: DayEvent): string {
  return [e.title, e.context_md, e.source_app, ...e.attendees].filter((v): v is string => !!v).join(' ');
}

function isPrimaryAgendaEvent(e: DayEvent): boolean {
  return e.source === 'calendar_screen' || e.source === 'meeting_capture' || e.kind === 'calendar' || e.kind === 'meeting' || !!e.meeting_id;
}

function isAgendaWorthyEvent(e: DayEvent): boolean {
  if (e.title === '__merged__') return false;
  if (isPrimaryAgendaEvent(e)) return true;
  if (e.source === 'task_screen') return true;

  if (e.kind === 'task') {
    const text = eventSearchText(e);
    if (CALENDAR_ECHO_RE.test(text) && COLLABORATIVE_MEETING_TITLE_RE.test(text)) return false;
    return IMPORTANT_TASK_RE.test(text);
  }

  if (e.kind === 'communication' && (e.source === 'email_screen' || e.source === 'slack_screen')) {
    const text = eventSearchText(e);
    if (LOW_SIGNAL_COMMUNICATION_RE.test(text)) return false;
    return IMPORTANT_COMMUNICATION_RE.test(text);
  }

  return false;
}

function calendarMatchScore(c: DayEvent, e: DayEvent): number {
  if (c.day !== e.day) return 0;
  if (!titlesLikelySame(c.title, e.title)) return 0;
  const cr = eventTimeRange(c), er = eventTimeRange(e); if (!cr || !er) return 0;
  const o = Math.min(cr.end, er.end) - Math.max(cr.start, er.start), sd = Math.abs(cr.start - er.start), si = er.start >= cr.start - 600000 && er.start <= cr.end + 600000;
  return o <= 0 && !si && sd > 600000 ? 0 : Math.max(1, o / 60000) + Math.max(0, 30 - sd / 60000);
}

function meetingForEvent(e: DayEvent, meetingsById: Map<string, Meeting>): Meeting | null {
  if (!e.meeting_id) return null;
  const meeting = meetingsById.get(e.meeting_id) ?? null;
  return meeting && meeting.day === e.day ? meeting : null;
}

function agendaEventPriority(e: DayEvent, meetingsById: Map<string, Meeting>): number {
  const meeting = meetingForEvent(e, meetingsById);
  let score = 0;
  if (e.source === 'calendar_screen') score += 120;
  if (e.kind === 'calendar') score += 80;
  if (e.meeting_id) score += 45;
  if (e.kind === 'meeting' || e.source === 'meeting_capture') score += 70;
  if (e.source === 'task_screen') score += 45;
  if (e.kind === 'task') score += 25;
  if (e.kind === 'communication') score += IMPORTANT_COMMUNICATION_RE.test(eventSearchText(e)) ? 18 : 5;
  if (meeting?.summary_status === 'ready') score += 12;
  if (meeting?.summary_json?.tldr || e.context_md) score += 4;
  if (e.attendees.length > 0) score += Math.min(e.attendees.length, 6);
  return score;
}

function eventsLikelySameAgendaItem(a: DayEvent, b: DayEvent): boolean {
  if (a.id === b.id) return true;
  if (a.day !== b.day) return false;
  if (!titlesLikelySame(a.title, b.title)) return false;
  const ar = eventTimeRange(a), br = eventTimeRange(b);
  if (!ar || !br) return true;
  const overlap = Math.min(ar.end, br.end) - Math.max(ar.start, br.start);
  const startDelta = Math.abs(ar.start - br.start);
  const windowMs = (isPrimaryAgendaEvent(a) || isPrimaryAgendaEvent(b)) ? 20 * 60_000 : 8 * 60_000;
  return overlap > 0 || startDelta <= windowMs;
}

function dedupeAgendaItems(events: DayEvent[], meetingsById: Map<string, Meeting>): DayEvent[] {
  const ranked = events.slice().sort((a, b) => {
    const ap = agendaEventPriority(a, meetingsById), bp = agendaEventPriority(b, meetingsById);
    return bp !== ap ? bp - ap : a.starts_at.localeCompare(b.starts_at);
  });
  const kept: DayEvent[] = [];
  for (const event of ranked) {
    if (!kept.some(existing => eventsLikelySameAgendaItem(existing, event))) kept.push(event);
  }
  return kept;
}

function buildVisibleAgendaEvents(events: DayEvent[], meetingsById: Map<string, Meeting>): DayEvent[] {
  return dedupeAgendaItems(reconcileCalendarMeetingItems(events, meetingsById).filter(isAgendaWorthyEvent), meetingsById);
}

function reconcileCalendarMeetingItems(events: DayEvent[], meetingsById: Map<string, Meeting>): DayEvent[] {
  const dd = dedupeEvents(events), ce = dd.filter(e => e.source === 'calendar_screen' && e.kind === 'calendar');
  if (!ce.length) return dd;
  const hd = new Set<string>(), lk = new Map<string, { id: string; score: number }>();
  for (const e of dd) {
    if (e.source !== 'meeting_capture' || e.kind !== 'meeting' || !e.meeting_id) continue;
    const m = meetingForEvent(e, meetingsById);
    if (!m) continue;
    let b = null;
    for (const c of ce) { const s = calendarMatchScore(c, e); if (s > 0 && (!b || s > b.score)) b = { calendar: c, score: s }; }
    if (!b) continue;
    hd.add(e.id);
    const qs = (m?.summary_status === 'ready' ? 10000 : 0) + (m?.summary_json?.tldr ? 3000 : 0) + (m?.transcript_chars ?? 0) + (m?.audio_chunk_count ?? 0) * 500 + Math.min(eventDuration(e) ?? 0, 5400000) / 1000 + (e.context_md?.length ?? 0);
    const curr = lk.get(b.calendar.id);
    if (!curr || qs > curr.score) lk.set(b.calendar.id, { id: e.meeting_id, score: qs });
  }
  return hd.size === 0 ? dd : dd.filter(e => !hd.has(e.id)).map(e => {
    const l = lk.get(e.id); if (!l) return e;
    const m = meetingForEvent({ ...e, meeting_id: l.id }, meetingsById);
    if (!m) return e;
    return { ...e, meeting_id: l.id, context_md: m?.summary_json?.tldr ?? e.context_md, attendees: Array.from(new Set([...e.attendees, ...(m?.attendees ?? [])])), links: Array.from(new Set([...e.links, ...(m?.links ?? [])])) };
  });
}

// ─── New helpers ───────────────────────────────────────────────────

type Bucket = 'allday' | 'morning' | 'midday' | 'afternoon' | 'evening';
const BUCKET_META: Record<Bucket, { label: string; short: string; icon: React.ComponentType<{ className?: string }> }> = {
  allday:    { label: 'All day',   short: 'All day',  icon: CalendarDays },
  morning:   { label: 'Morning',   short: 'Morning',  icon: Sunrise },
  midday:    { label: 'Midday',    short: 'Midday',   icon: Sun },
  afternoon: { label: 'Afternoon', short: 'Afternoon',icon: Sunset },
  evening:   { label: 'Evening',   short: 'Evening',  icon: Moon },
};
const BUCKET_ORDER: Bucket[] = ['allday', 'morning', 'midday', 'afternoon', 'evening'];

function bucketFor(e: DayEvent): Bucket {
  if (isAllDayEvent(e)) return 'allday';
  const h = new Date(e.starts_at).getHours();
  if (h < 12) return 'morning';
  if (h < 15) return 'midday';
  if (h < 18) return 'afternoon';
  return 'evening';
}

function groupByBucket(events: DayEvent[]): Array<{ id: Bucket; events: DayEvent[] }> {
  const map = new Map<Bucket, DayEvent[]>();
  for (const e of events) {
    const b = bucketFor(e);
    const arr = map.get(b);
    if (arr) arr.push(e); else map.set(b, [e]);
  }
  return BUCKET_ORDER.filter(id => map.has(id)).map(id => ({ id, events: map.get(id)! }));
}

type KindAccent = 'amber' | 'violet' | 'sky' | 'emerald' | 'muted';
function kindTone(kind: DayEventKind): { tick: string; icon: string; chip: string; halo: string; accent: KindAccent } {
  switch (kind) {
    case 'meeting':
      return { tick: 'bg-amber-400', icon: 'text-amber-300', chip: 'bg-amber-500/12 ring-1 ring-amber-400/25', halo: 'bg-amber-400', accent: 'amber' };
    case 'calendar':
      return { tick: 'bg-violet-400', icon: 'text-violet-300', chip: 'bg-violet-500/12 ring-1 ring-violet-400/25', halo: 'bg-violet-400', accent: 'violet' };
    case 'communication':
      return { tick: 'bg-sky-400', icon: 'text-sky-300', chip: 'bg-sky-500/12 ring-1 ring-sky-400/25', halo: 'bg-sky-400', accent: 'sky' };
    case 'task':
      return { tick: 'bg-emerald-400', icon: 'text-emerald-300', chip: 'bg-emerald-500/12 ring-1 ring-emerald-400/25', halo: 'bg-emerald-400', accent: 'emerald' };
    default:
      return { tick: 'bg-muted-foreground/40', icon: 'text-muted-foreground', chip: 'bg-muted/40 ring-1 ring-border', halo: 'bg-muted-foreground', accent: 'muted' };
  }
}

function timeUntil(iso: string, now: Date): string | null {
  const ms = Date.parse(iso) - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const m = Math.round(ms / 60000);
  if (m < 1) return 'starting now';
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60), rem = m % 60;
  return rem ? `in ${h}h ${rem}m` : `in ${h}h`;
}

// ─── Main screen ───────────────────────────────────────────────────

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

  const [selectedDay, setSelectedDay] = React.useState<string>(today), pfRef = React.useRef<string | null>(null), hfRef = React.useRef(0);

  const visibleEvents = React.useMemo(() => buildVisibleAgendaEvents(dayOverrides.get(selectedDay) ?? events.filter((e: DayEvent) => e.day === selectedDay), meetingsById).sort((a, b) => a.starts_at.localeCompare(b.starts_at)), [selectedDay, events, dayOverrides, meetingsById]);
  const buckets = React.useMemo(() => groupByBucket(visibleEvents), [visibleEvents]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!focusRequest || focusRequest.id === hfRef.current) return;
    hfRef.current = focusRequest.id;
    if (!focusRequest.target) { pfRef.current = null; return; }
    pfRef.current = focusRequest.target.eventId; setSelectedDay(focusRequest.target.day);
  }, [focusRequest]);

  React.useEffect(() => {
    if (pfRef.current) {
      if (visibleEvents.some(e => e.id === pfRef.current)) { setSelectedId(pfRef.current); pfRef.current = null; }
      else setSelectedId(null);
      return;
    }
    if (!visibleEvents.length) setSelectedId(null);
    else if (selectedId && !visibleEvents.find(e => e.id === selectedId)) setSelectedId(null);
  }, [selectedDay, visibleEvents, selectedId]);

  const loadDay = React.useCallback(async (day: string) => {
    if ((daysFromProps.includes(day) && !dayOverrides.has(day)) || perDayLoading === day) return;
    setPerDayLoading(day);
    try { const f = await window.beside.listDayEvents({ day }) ?? []; setDayOverrides(p => new Map(p).set(day, f)); }
    catch { setDayOverrides(p => p.has(day) ? p : new Map(p).set(day, [])); } finally { setPerDayLoading(c => c === day ? null : c); }
  }, [daysFromProps, dayOverrides, perDayLoading]);

  React.useEffect(() => { if (selectedDay && !daysFromProps.includes(selectedDay) && !dayOverrides.has(selectedDay)) loadDay(selectedDay); }, [selectedDay, daysFromProps, dayOverrides, loadDay]);

  const nowIdx = selectedDay === today && visibleEvents.length ? nowIndicatorIndex(visibleEvents, currentTime) : -1;
  const selEvent = visibleEvents.find(e => e.id === selectedId) ?? null;
  const selMeeting = selEvent ? meetingForEvent(selEvent, meetingsById) : null;
  const isToday = selectedDay === today;

  const brief = useDayBrief(selectedDay);
  const [briefOpen, setBriefOpen] = React.useState(false);
  React.useEffect(() => { if (brief.status === 'ready' && !brief.content) setBriefOpen(false); }, [brief.status, brief.content]);

  const openBrief = React.useCallback(() => { setBriefOpen(true); setSelectedId(null); }, []);
  const handleSelectEvent = React.useCallback((id: string) => { setBriefOpen(false); setSelectedId(prev => prev === id ? null : id); }, []);
  const handleSetSelectedEvent = React.useCallback((id: string) => { setBriefOpen(false); setSelectedId(id); }, []);

  return (
    <div className="relative flex flex-col h-full min-h-0 gap-4 pt-6 pb-2">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-12 h-48 opacity-50"
        style={{ background: 'radial-gradient(60% 80% at 30% 0%, hsl(var(--primary) / 0.08), transparent 70%)' }}
      />

      <div className="relative flex-none flex flex-col gap-4">
        <PageHeader
          title="Journal"
          actions={<>
            <Button variant="outline" size="sm" onClick={runScan} disabled={scanning} className="gap-1.5">{scanning ? <Loader2 className="size-3.5 animate-spin" /> : <ScanLine className="size-3.5" />}Scan now</Button>
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading} className="gap-1.5">{loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCcw className="size-3.5" />}Refresh</Button>
          </>}
        />
        <DayStrip
          selectedDay={selectedDay}
          today={today}
          loading={perDayLoading === selectedDay}
          buckets={buckets}
          eventCount={visibleEvents.length}
          onPrev={() => setSelectedDay(d => shiftDay(d, -1))}
          onNext={() => setSelectedDay(d => shiftDay(d, 1))}
          onToday={() => setSelectedDay(today)}
          onPick={setSelectedDay}
        />
      </div>

      {loading && !visibleEvents.length && !dayOverrides.size ? (
        <div className="relative flex-1 grid place-items-center text-muted-foreground text-sm">
          <div className="flex flex-col items-center gap-2"><Loader2 className="size-5 animate-spin" />Loading…</div>
        </div>
      ) : (
        <div className="relative flex gap-5 min-h-0 flex-1">
          <div className={cn('w-[380px] shrink-0 flex flex-col min-h-0 gap-3', briefOpen && 'hidden')}>
            <DayBriefCard day={selectedDay} brief={brief} active={briefOpen} onOpen={openBrief} />
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden rounded-2xl border border-border/40 bg-card/40 backdrop-blur-sm shadow-[0_1px_0_0_hsl(var(--border)/0.4)_inset,0_30px_60px_-40px_rgba(0,0,0,0.6)]">
              <ScrollArea className="flex-1">
                <div className="px-3 py-3">
                  {!visibleEvents.length ? (
                    <DayEmptyState day={selectedDay} loading={perDayLoading === selectedDay} onScan={runScan} scanning={scanning} />
                  ) : (
                    <AgendaList buckets={buckets} now={currentTime} isToday={isToday} nowIdx={nowIdx} selectedId={selectedId} onSelect={handleSelectEvent} meetingsById={meetingsById} />
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>

          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            {briefOpen ? (
              <DayBriefReader day={selectedDay} brief={brief} onClose={() => setBriefOpen(false)} />
            ) : !selEvent ? (
              <JournalLanding
                events={visibleEvents}
                meetingsById={meetingsById}
                selectedDay={selectedDay}
                today={today}
                now={currentTime}
                loading={perDayLoading === selectedDay}
                onSelectEvent={handleSetSelectedEvent}
                onScan={runScan}
                scanning={scanning}
              />
            ) : (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden rounded-2xl border border-border/40 bg-card/60 backdrop-blur-sm shadow-[0_1px_0_0_hsl(var(--border)/0.4)_inset,0_30px_80px_-50px_rgba(0,0,0,0.6)]">
                <ScrollArea className="flex-1">
                  <div className="flex flex-col p-8 max-w-4xl mx-auto w-full gap-8">
                    <EventDetailHeader event={selEvent} meeting={selMeeting} />
                    <Separator className="bg-border/40" />
                    {selMeeting ? <MeetingBody event={selEvent} meeting={selMeeting} allMeetings={meetings} now={currentTime} /> : <NonMeetingBody event={selEvent} allMeetings={meetings} now={currentTime} />}
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Top strip ─────────────────────────────────────────────────────

function DayStrip({ selectedDay, today, loading, buckets, eventCount, onPrev, onNext, onToday, onPick }: any) {
  const r = React.useRef<HTMLInputElement>(null);
  const isToday = selectedDay === today;
  const date = new Date(`${selectedDay}T12:00:00`);
  const weekday = date.toLocaleDateString(undefined, { weekday: 'long' });
  const monthDay = date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });

  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border/30 pb-4">
      <div className="flex items-end gap-5 min-w-0">
        <div className="relative inline-flex items-center gap-0.5 rounded-full border border-border/50 bg-card/60 p-0.5 backdrop-blur-sm">
          <Button variant="ghost" size="icon" onClick={onPrev} className="rounded-full size-8 text-muted-foreground hover:text-foreground"><ChevronLeft className="size-4" /></Button>
          <button
            type="button"
            onClick={() => { if (r.current?.showPicker) { try { r.current.showPicker(); } catch { r.current.focus(); } } else { r.current?.focus(); r.current?.click(); } }}
            className="relative inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[11px] font-bold uppercase tracking-[0.16em] text-foreground/80 transition-colors hover:bg-accent"
          >
            {loading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : <CalendarDays className="size-3.5 text-muted-foreground" />}
            <span className="tabular-nums">{isToday ? 'Today' : prettyDay(selectedDay)}</span>
          </button>
          <Button variant="ghost" size="icon" onClick={onNext} className="rounded-full size-8 text-muted-foreground hover:text-foreground"><ChevronRight className="size-4" /></Button>
          <input ref={r} type="date" value={selectedDay} onChange={e => e.target.value && onPick(e.target.value)} className="absolute inset-0 -z-10 opacity-0 pointer-events-none" />
        </div>

        <div className="min-w-0 leading-none">
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/70 font-semibold">{weekday}</div>
          <div className="mt-1.5 text-3xl font-semibold tracking-tight text-foreground tabular-nums" style={{ fontFamily: 'var(--font-sans)' }}>{monthDay}</div>
        </div>
      </div>

      {eventCount > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/70 font-semibold pr-1 tabular-nums">{eventCount} item{eventCount === 1 ? '' : 's'}</span>
          {buckets.map((b: { id: Bucket; events: DayEvent[] }) => {
            const Icon = BUCKET_META[b.id].icon;
            return (
              <span key={b.id} className="inline-flex items-center gap-1.5 rounded-full border border-border/40 bg-card/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                <Icon className="size-3 opacity-60" />
                {BUCKET_META[b.id].short}
                <span className="tabular-nums text-foreground/70 ml-0.5">{b.events.length}</span>
              </span>
            );
          })}
          {!isToday && <Button variant="ghost" size="sm" onClick={onToday} className="ml-1 h-7 rounded-full px-2.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground">Jump to today</Button>}
        </div>
      )}
    </div>
  );
}

// ─── Day brief (card + reading view) ───────────────────────────────

type BriefState = { status: 'loading' | 'ready'; content: string | null };

function useDayBrief(day: string): BriefState {
  const [state, setState] = React.useState<BriefState>({ status: 'loading', content: null });
  React.useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', content: null });
    (async () => {
      try {
        const res = await window.beside.readJournalMarkdown(day);
        if (!cancelled) setState({ status: 'ready', content: res?.content ?? null });
      } catch { if (!cancelled) setState({ status: 'ready', content: null }); }
    })();
    return () => { cancelled = true; };
  }, [day]);
  return state;
}

const TIMELINE_HEADING_RE = /^(?:timeline|loose frames)$/i;
function isSkippableSection(text: string): boolean { return TIMELINE_HEADING_RE.test(text.trim()); }
function slugifyHeading(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'section';
}
function briefWordCount(md: string): number {
  return md.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`~\[\]()-]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
}
function briefTeaser(md: string): string {
  for (const raw of md.split(/\n{2,}/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^[_*]+[^*_]+[_*]+$/.test(line) && line.length < 80) continue;
    if (/^!\[/.test(line)) continue;
    const cleaned = line.replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`~>]/g, '').replace(/\s+/g, ' ').trim();
    if (cleaned.length > 24) return cleaned;
  }
  return '';
}
type BriefSection = { id: string; level: 2 | 3; text: string };
function briefSections(md: string): BriefSection[] {
  const out: BriefSection[] = [];
  const seen = new Set<string>();
  let inFence = false;
  for (const raw of md.split('\n')) {
    if (/^```/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = raw.match(/^(##{1,2})\s+(.+?)\s*$/);
    if (!m) continue;
    const level = (m[1].length === 2 ? 2 : 3) as 2 | 3;
    const text = m[2].replace(/[*_`]/g, '').trim();
    if (!text || isSkippableSection(text)) continue;
    let id = slugifyHeading(text), i = 2;
    while (seen.has(id)) { id = `${slugifyHeading(text)}-${i++}`; }
    seen.add(id);
    out.push({ id, level, text });
  }
  return out;
}
function briefReadMinutes(words: number): number { return Math.max(1, Math.round(words / 220)); }

function DayBriefCard({ day, brief, active, onOpen }: { day: string; brief: BriefState; active: boolean; onOpen: () => void }) {
  if (brief.status !== 'ready' || !brief.content) return null;
  const content = brief.content;
  const words = React.useMemo(() => briefWordCount(content), [content]);
  const teaser = React.useMemo(() => briefTeaser(content), [content]);
  const sections = React.useMemo(() => briefSections(content), [content]);
  const sectionCount = sections.filter(s => s.level === 2).length;
  const readMin = briefReadMinutes(words);

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={active}
      aria-expanded={active}
      aria-label={`Read day story for ${prettyDay(day)}`}
      className={cn(
        'group relative flex-none w-full overflow-hidden rounded-xl border text-left transition-all cursor-pointer',
        'bg-gradient-to-br from-primary/[0.06] via-card/40 to-card/20 backdrop-blur-sm',
        active
          ? 'border-primary/60 ring-1 ring-primary/30 shadow-[0_8px_28px_-12px_hsl(var(--primary)/0.45)]'
          : 'border-border/40 hover:border-primary/50 hover:bg-card/60 hover:shadow-[0_10px_30px_-18px_hsl(var(--primary)/0.55)] hover:-translate-y-px active:translate-y-0',
      )}
    >
      <span aria-hidden className="pointer-events-none absolute -right-8 -top-10 size-28 rounded-full bg-primary/15 blur-2xl opacity-70 transition-opacity group-hover:opacity-100" />
      <div className="relative flex items-start gap-3 px-3.5 pt-3.5">
        <span className={cn('grid size-9 place-items-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/20', active && 'bg-primary/25')}>
          <BookOpen className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary/80">Day story</span>
            {active && <span className="rounded-full bg-primary/15 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-primary">Reading</span>}
          </div>
          <div className="mt-1 text-sm font-semibold text-foreground leading-snug">
            What happened on {prettyDay(day)}
          </div>
        </div>
      </div>
      {teaser && (
        <p className="relative mt-2 px-3.5 line-clamp-3 text-[12.5px] leading-relaxed text-muted-foreground/90">
          {teaser}
        </p>
      )}
      <div className="relative mt-3 flex items-center justify-between gap-2 border-t border-border/30 bg-background/30 px-3.5 py-1.5 text-[10.5px] font-medium tabular-nums text-muted-foreground/80">
        <span className="inline-flex items-center gap-1"><Clock className="size-3" />{readMin} min read</span>
        <span className="inline-flex items-center gap-1"><List className="size-3" />{sectionCount || 1} section{sectionCount === 1 ? '' : 's'}</span>
        <span className="tabular-nums">{words.toLocaleString()} words</span>
      </div>
      <div
        className={cn(
          'relative flex items-center justify-between gap-2 border-t px-3.5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors',
          active
            ? 'border-primary/40 bg-primary/15 text-primary'
            : 'border-primary/25 bg-primary/[0.08] text-primary/90 group-hover:bg-primary/15 group-hover:text-primary',
        )}
      >
        <span className="inline-flex items-center gap-1.5">
          <BookOpen className="size-3.5" />
          {active ? 'Reading full story' : 'Read full story'}
        </span>
        <ChevronRight className={cn('size-4 transition-transform', active ? 'translate-x-0.5' : 'group-hover:translate-x-1')} />
      </div>
    </button>
  );
}

function DayBriefReader({ day, brief, onClose }: { day: string; brief: BriefState; onClose: () => void }) {
  const content = brief.content;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const sections = React.useMemo(() => content ? briefSections(content) : [], [content]);
  const [activeId, setActiveId] = React.useState<string | null>(null);

  const sectionedContent = React.useMemo(() => {
    if (!content) return null;
    return splitBriefForReader(content, sections);
  }, [content, sections]);

  React.useEffect(() => { setActiveId(sections[0]?.id ?? null); }, [day, sections.length]);

  const onJump = React.useCallback((id: string) => {
    const root = scrollRef.current; if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-brief-section="${id}"]`); if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveId(id);
  }, []);

  React.useEffect(() => {
    const root = scrollRef.current; if (!root || !sections.length) return;
    const viewport = root.closest('[data-radix-scroll-area-viewport]') as HTMLElement | null;
    const scroller = viewport ?? root;
    const handler = () => {
      const top = scroller.getBoundingClientRect().top + 80;
      let current = sections[0]?.id ?? null;
      for (const s of sections) {
        const el = root.querySelector<HTMLElement>(`[data-brief-section="${s.id}"]`);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= top) current = s.id; else break;
      }
      setActiveId(current);
    };
    scroller.addEventListener('scroll', handler, { passive: true });
    handler();
    return () => { scroller.removeEventListener('scroll', handler); };
  }, [sections]);

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden rounded-2xl border border-border/40 bg-card/60 backdrop-blur-sm shadow-[0_1px_0_0_hsl(var(--border)/0.4)_inset,0_30px_80px_-50px_rgba(0,0,0,0.6)]">
      <div className="flex items-center justify-between gap-3 border-b border-border/40 px-6 py-4">
        <div className="flex items-center gap-3 min-w-0">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/20"><BookOpen className="size-4" /></span>
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-primary/80">Day story</div>
            <div className="text-base font-semibold leading-tight text-foreground truncate" style={{ fontFamily: 'var(--font-sans)' }}>{prettyDay(day)}</div>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} className="gap-1.5 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />Close
        </Button>
      </div>

      {!content && brief.status === 'loading' ? (
        <div className="flex-1 grid place-items-center text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
      ) : !content ? (
        <div className="flex-1 grid place-items-center text-center text-sm text-muted-foreground px-8">
          <div className="flex flex-col items-center gap-3"><Compass className="size-8 opacity-40" /><p className="max-w-sm leading-relaxed">No story for {prettyDay(day)} yet. Capture some activity or wait for the next indexing pass.</p></div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex">
          {sections.length > 1 && (
            <nav aria-label="Sections" className="hidden xl:flex w-52 shrink-0 flex-col gap-1 border-r border-border/30 px-3 py-6 overflow-y-auto">
              <div className="px-2 pb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground/70">In this story</div>
              {sections.map(s => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onJump(s.id)}
                  className={cn(
                    'group relative flex items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12px] leading-snug transition-colors',
                    s.level === 3 && 'pl-5 text-[11.5px]',
                    activeId === s.id ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                  )}
                >
                  <span className={cn('mt-1.5 inline-block size-1 shrink-0 rounded-full', activeId === s.id ? 'bg-primary' : 'bg-muted-foreground/40')} />
                  <span className="line-clamp-2">{s.text}</span>
                </button>
              ))}
            </nav>
          )}

          <ScrollArea className="flex-1 min-h-0">
            <article ref={scrollRef} className="mx-auto w-full max-w-5xl px-10 lg:px-14 py-10">
              <header className="mb-8 border-b border-border/40 pb-6">
                <div className="text-[10px] font-bold uppercase tracking-[0.24em] text-muted-foreground/70">Captured story</div>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-sans)' }}>
                  Your day on {prettyDay(day)}
                </h1>
                <p className="mt-2 text-[12.5px] text-muted-foreground/80">
                  {briefReadMinutes(briefWordCount(content))} min read · {briefWordCount(content).toLocaleString()} words
                </p>
              </header>

              <div className="prose prose-base lg:prose-lg dark:prose-invert max-w-none prose-headings:scroll-mt-6 prose-headings:font-semibold prose-h2:text-2xl prose-h2:mt-10 prose-h2:mb-4 prose-h2:tracking-tight prose-h2:border-b prose-h2:border-border/40 prose-h2:pb-3 prose-h3:text-lg prose-h3:mt-8 prose-h3:mb-2 prose-p:leading-[1.8] prose-p:text-foreground/90 prose-li:leading-relaxed prose-li:my-1.5 prose-pre:bg-muted/40 prose-pre:border prose-pre:border-border/40 prose-img:rounded-xl prose-img:border prose-img:border-border/40 prose-a:text-primary prose-a:no-underline hover:prose-a:underline prose-blockquote:border-l-primary/50 prose-blockquote:text-muted-foreground">
                {sectionedContent ?? <Markdown content={content} />}
              </div>
            </article>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

function stripLeadingH1AndMeta(md: string): string {
  const lines = md.split('\n');
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  if (start < lines.length && /^#\s+/.test(lines[start])) {
    start++;
    while (start < lines.length && (lines[start].trim() === '' || /^_.*_$/.test(lines[start].trim()))) start++;
  }
  return lines.slice(start).join('\n');
}

function splitBriefForReader(md: string, sections: BriefSection[]) {
  const body = stripLeadingH1AndMeta(md);
  if (!sections.length) return <Markdown content={body} />;
  const lines = body.split('\n');
  const blocks: Array<{ id: string | null; lines: string[] }> = [];
  let current: { id: string | null; lines: string[] } = { id: null, lines: [] };
  const sectionByText = new Map(sections.map(s => [s.text.toLowerCase(), s] as const));
  let inFence = false;
  for (const raw of lines) {
    if (/^```/.test(raw)) inFence = !inFence;
    const m = !inFence ? raw.match(/^(##{1,2})\s+(.+?)\s*$/) : null;
    if (m) {
      const text = m[2].replace(/[*_`]/g, '').trim().toLowerCase();
      const hit = sectionByText.get(text);
      if (hit) {
        if (current.lines.length) blocks.push(current);
        current = { id: hit.id, lines: [raw] };
        continue;
      }
    }
    current.lines.push(raw);
  }
  if (current.lines.length) blocks.push(current);
  return (
    <>
      {blocks.map((b, i) => (
        <section key={`${b.id ?? 'lede'}-${i}`} data-brief-section={b.id ?? undefined}>
          <Markdown content={b.lines.join('\n').trim()} />
        </section>
      ))}
    </>
  );
}

// ─── Agenda list ───────────────────────────────────────────────────

function AgendaList({ buckets, now, isToday, nowIdx, selectedId, onSelect, meetingsById }: { buckets: Array<{ id: Bucket; events: DayEvent[] }>; now: Date; isToday: boolean; nowIdx: number; selectedId: string | null; onSelect: (id: string) => void; meetingsById: Map<string, Meeting>; }) {
  let counter = 0;
  return (
    <div className="flex flex-col gap-4">
      {buckets.map((b, bi) => {
        const Icon = BUCKET_META[b.id].icon;
        return (
          <section key={b.id} className="flex flex-col">
            <div className={cn('flex items-center gap-2 px-1.5', bi === 0 ? 'mb-1.5' : 'mb-1.5 mt-1')}>
              <Icon className="size-3 text-muted-foreground/60" />
              <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground/80">{BUCKET_META[b.id].label}</span>
              <span className="text-[10px] tabular-nums text-muted-foreground/40">·</span>
              <span className="text-[10px] tabular-nums text-muted-foreground/60">{b.events.length}</span>
              <div className="ml-1 h-px flex-1 bg-gradient-to-r from-border/50 to-transparent" />
            </div>
            <ul className="flex flex-col">
              {b.events.map((e) => {
                const showNow = isToday && counter === nowIdx;
                counter++;
                return (
                  <React.Fragment key={e.id}>
                    {showNow && <NowIndicator now={now} />}
                    <li><EventRow event={e} active={e.id === selectedId} onClick={() => onSelect(e.id)} meeting={meetingForEvent(e, meetingsById)} /></li>
                  </React.Fragment>
                );
              })}
            </ul>
          </section>
        );
      })}
      {isToday && nowIdx >= counter && <NowIndicator now={now} />}
    </div>
  );
}

// ─── Empty bucket state ────────────────────────────────────────────

function DayEmptyState({ day, loading, onScan, scanning }: any) {
  if (loading) return <div className="flex items-center gap-2 py-16 px-3 text-muted-foreground text-sm font-medium justify-center"><Loader2 className="size-4 animate-spin text-primary" />Loading {prettyDay(day)}…</div>;
  return (
    <div className="flex flex-col items-center text-center gap-3 py-14 px-4 text-muted-foreground">
      <CalendarClock className="size-8 opacity-25" />
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">No events on {prettyDay(day)}</p>
        <p className="text-xs max-w-[16rem] leading-relaxed">The extractor runs every 15 min — scan to pick up anything new.</p>
      </div>
      <Button variant="outline" size="sm" onClick={onScan} disabled={scanning} className="gap-1.5 mt-1 rounded-full px-3.5 h-7 text-[11px]">
        {scanning ? <Loader2 className="size-3 animate-spin" /> : <ScanLine className="size-3" />}Scan now
      </Button>
    </div>
  );
}

// ─── Now indicator (inline hairline) ───────────────────────────────

function NowIndicator({ now }: { now: Date }) {
  return (
    <div className="relative my-2 flex items-center gap-2 px-1.5" role="separator" aria-label="Current time">
      <span className="relative flex size-1.5 items-center justify-center">
        <span className="absolute inline-flex size-3 animate-ping rounded-full bg-primary/60 opacity-60" />
        <span className="relative inline-flex size-1.5 rounded-full bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.18)]" />
      </span>
      <span className="h-px flex-1 bg-gradient-to-r from-primary/60 via-primary/30 to-transparent" />
      <span className="text-[9px] font-bold uppercase tracking-[0.24em] text-primary tabular-nums whitespace-nowrap">Now · {formatLocalTime(now.toISOString())}</span>
    </div>
  );
}

// ─── Event row ─────────────────────────────────────────────────────

function EventRow({ event, active, onClick, meeting }: { event: DayEvent; active: boolean; onClick: () => void; meeting: Meeting | null }) {
  const dur = eventDuration(event);
  const ht = (meeting?.transcript_chars ?? 0) > 0;
  const tone = kindTone(event.kind);
  const allDay = isAllDayEvent(event);
  const preview = event.kind !== 'meeting'
    ? event.context_md
    : meeting?.summary_json?.tldr && !event.context_md
      ? meeting.summary_json.tldr
      : ht && !meeting?.summary_json?.tldr
        ? 'Summary pending.'
        : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative w-full text-left rounded-lg px-2.5 py-2.5 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        active ? 'bg-card shadow-[0_1px_0_0_hsl(var(--border)/0.5)_inset,0_8px_24px_-12px_rgba(0,0,0,0.5)]' : 'hover:bg-muted/30'
      )}
    >
      <span aria-hidden className={cn('absolute left-0 top-2.5 bottom-2.5 w-[2px] rounded-full transition-colors', active ? tone.tick : 'bg-transparent group-hover:bg-border')} />
      <div className="flex items-start gap-2.5 pl-2">
        <div className="flex flex-col items-start min-w-[2.6rem] pt-0.5">
          {allDay ? (
            <span className={cn('text-[9px] font-bold uppercase tracking-[0.14em]', active ? 'text-foreground/90' : 'text-muted-foreground/70')}>All day</span>
          ) : (
            <>
              <span className={cn('text-[11px] font-semibold tabular-nums tracking-tight uppercase leading-none', active ? 'text-foreground' : 'text-foreground/80')}>{formatDayEventTime(event)}</span>
              {dur != null && <span className="mt-1 text-[9px] tabular-nums font-medium text-muted-foreground/60">{formatDuration(dur)}</span>}
            </>
          )}
        </div>
        <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded-md', tone.chip)} aria-hidden>
          <KindIcon kind={event.kind} className={cn('size-3', tone.icon)} />
        </span>
        <div className="min-w-0 flex-1">
          <div className={cn('text-[13px] font-medium leading-snug line-clamp-2', active ? 'text-foreground' : 'text-foreground/90')}>{event.title}</div>
          {active && preview && (
            <p className={cn('mt-1 text-[11.5px] line-clamp-2 leading-relaxed', preview === 'Summary pending.' ? 'text-muted-foreground/55 italic' : 'text-muted-foreground/80')}>{preview}</p>
          )}
          {active && event.attendees.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {event.attendees.slice(0, 3).map(a => <span key={a} className="inline-flex rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{a}</span>)}
              {event.attendees.length > 3 && <span className="inline-flex items-center text-[10px] text-muted-foreground/60">+{event.attendees.length - 3}</span>}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

// ─── Landing (right side when nothing selected) ────────────────────

function JournalLanding({ events, meetingsById, selectedDay, today, now, loading, onSelectEvent, onScan, scanning }: { events: DayEvent[]; meetingsById: Map<string, Meeting>; selectedDay: string; today: string; now: Date; loading: boolean; onSelectEvent: (id: string) => void; onScan: () => void; scanning: boolean; }) {
  const nMs = now.getTime();
  const upcoming = selectedDay === today
    ? events.find((e: DayEvent) => eventStartsAfterNow(e, nMs)) ?? null
    : null;
  const upcomingMeeting = upcoming ? meetingForEvent(upcoming, meetingsById) : null;

  const allMeetings: Meeting[] = events.map((e: DayEvent) => meetingForEvent(e, meetingsById)).filter((m): m is Meeting => !!m);
  const sigs = collectMeetingSummarySignals(allMeetings);
  const followups = sigs.actionItems.slice(0, 8);
  const decisions = sigs.decisions.slice(0, 3);
  const openQs = sigs.openQuestions.slice(0, 3);

  const meetingIdForAction = (task: string): { evId: string; title: string } | null => {
    for (const m of allMeetings) {
      if (m.summary_json?.action_items?.some((a: any) => a.task === task)) {
        const ev = events.find((e: DayEvent) => e.meeting_id === m.id);
        if (ev) return { evId: ev.id, title: m.summary_json?.title ?? m.title ?? 'Meeting' };
      }
    }
    return null;
  };

  if (!events.length) {
    return (
      <div className="flex-1 grid place-items-center rounded-2xl border border-dashed border-border/40 bg-card/20 backdrop-blur-sm">
        <div className="flex flex-col items-center gap-4 text-center px-8 py-16 text-muted-foreground">
          <div className="relative">
            <div className="absolute -inset-6 rounded-full bg-primary/10 blur-2xl" />
            <CalendarDays className="relative size-12 opacity-40 text-foreground" />
          </div>
          <div className="space-y-1.5">
            <p className="text-xl font-semibold text-foreground" style={{ fontFamily: 'var(--font-sans)' }}>A quiet day on {prettyDay(selectedDay)}.</p>
            <p className="text-sm max-w-sm leading-relaxed">Nothing pinned to your calendar yet. The event extractor runs every 15 minutes — scan manually to refresh.</p>
          </div>
          <Button variant="outline" size="sm" onClick={onScan} disabled={scanning || loading} className="gap-1.5 mt-2 rounded-full px-4">
            {scanning ? <Loader2 className="size-3.5 animate-spin" /> : <ScanLine className="size-3.5" />}Scan now
          </Button>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1 min-h-0 -mr-2 pr-2">
      <div className="flex flex-col gap-5 pb-4">
        {upcoming
          ? <NextUpHero event={upcoming} meeting={upcomingMeeting} now={now} onOpen={() => onSelectEvent(upcoming.id)} />
          : <DayQuietBanner selectedDay={selectedDay} today={today} />
        }

        {followups.length > 0 && (
          <FollowUpsBoard items={followups} totalCount={sigs.actionItems.length} meetingIdForAction={meetingIdForAction} onSelectEvent={onSelectEvent} />
        )}

        {(decisions.length > 0 || openQs.length > 0) && (
          <div className={cn('grid gap-4', decisions.length > 0 && openQs.length > 0 ? 'md:grid-cols-2' : 'grid-cols-1')}>
            {decisions.length > 0 && <SignalRail items={decisions.map((d: any) => d.text)} title="Decisions" subtitle="Settled today" accent="violet" />}
            {openQs.length > 0 && <SignalRail items={openQs.map((q: any) => q.text)} title="Open questions" subtitle="Still unresolved" accent="amber" />}
          </div>
        )}

        <SelectACue />
      </div>
    </ScrollArea>
  );
}

function NextUpHero({ event, meeting, now, onOpen }: { event: DayEvent; meeting: Meeting | null; now: Date; onOpen: () => void }) {
  const tone = kindTone(event.kind);
  const tu = timeUntil(event.starts_at, now);
  const attendees = event.attendees.slice(0, 5);
  const blurb = meeting?.summary_json?.tldr ?? event.context_md;

  return (
    <article className="relative overflow-hidden rounded-2xl border border-border/50 bg-card/70 backdrop-blur-sm shadow-[0_30px_80px_-50px_rgba(0,0,0,0.7)]">
      <div aria-hidden className={cn('pointer-events-none absolute -top-32 -right-24 size-64 rounded-full blur-3xl opacity-25', tone.halo)} />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-border/60 to-transparent" />

      <div className="relative flex flex-col gap-5 p-7">
        <div className="flex items-center gap-3">
          <span className={cn('grid size-7 place-items-center rounded-md', tone.chip)}><KindIcon kind={event.kind} className={cn('size-3.5', tone.icon)} /></span>
          <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Next up</span>
          {tu && (
            <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/70" />
                <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
              </span>
              {tu}
            </span>
          )}
        </div>

        <h2 className="text-3xl font-semibold leading-[1.15] tracking-tight text-foreground" style={{ fontFamily: 'var(--font-sans)' }}>{event.title}</h2>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 font-medium tabular-nums text-foreground/85"><Clock className="size-3.5 opacity-60" />{formatDayEventTimeRange(event)}</span>
          {event.source_app && <><span className="text-border/60" aria-hidden>·</span><span className="inline-flex items-center gap-1.5"><Inbox className="size-3.5 opacity-60" />{event.source_app}</span></>}
          {meeting && <><span className="text-border/60" aria-hidden>·</span><span className="inline-flex items-center gap-1.5"><Video className="size-3.5 opacity-60" />{platformLabel(meeting.platform)}</span></>}
        </div>

        {attendees.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Users className="size-3.5 text-muted-foreground/60 mr-1" />
            {attendees.map(a => <span key={a} className="inline-flex rounded-full bg-muted/60 px-2.5 py-0.5 text-[11px] font-medium text-foreground/80">{a}</span>)}
            {event.attendees.length > attendees.length && <span className="text-[11px] text-muted-foreground">+{event.attendees.length - attendees.length}</span>}
          </div>
        )}

        {blurb && <p className="text-sm leading-relaxed text-foreground/75 line-clamp-3 border-l-2 border-border/60 pl-3 italic">{blurb}</p>}

        <div className="flex items-center justify-between pt-1">
          <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60">{prettyDay(event.day)}</span>
          <Button onClick={onOpen} className="group gap-2 rounded-full px-4">Open<ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" /></Button>
        </div>
      </div>
    </article>
  );
}

function DayQuietBanner({ selectedDay, today }: { selectedDay: string; today: string }) {
  const isPast = compareDays(selectedDay, today) < 0;
  return (
    <div className="rounded-2xl border border-border/40 bg-card/40 backdrop-blur-sm px-6 py-5">
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-lg bg-muted/60"><CalendarClock className="size-4 text-muted-foreground" /></span>
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground/80">{isPast ? 'Looking back' : 'Looking ahead'}</div>
          <div className="text-base font-semibold text-foreground mt-1" style={{ fontFamily: 'var(--font-sans)' }}>{isPast ? `${prettyDay(selectedDay)} is in the past.` : 'No upcoming items on the books.'}</div>
        </div>
      </div>
    </div>
  );
}

function FollowUpsBoard({ items, totalCount, meetingIdForAction, onSelectEvent }: { items: any[]; totalCount: number; meetingIdForAction: (t: string) => { evId: string; title: string } | null; onSelectEvent: (id: string) => void; }) {
  return (
    <section className="rounded-2xl border border-border/40 bg-card/40 backdrop-blur-sm overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-6 pt-5 pb-3 border-b border-border/30">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-md bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/25"><CheckSquare className="size-3.5" /></span>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground/80">Follow-ups</div>
            <div className="text-sm font-semibold text-foreground">Promises on the day</div>
          </div>
        </div>
        <Badge variant="outline" className="rounded-full border-emerald-400/30 bg-emerald-500/10 text-emerald-300 px-2.5 py-0.5 text-[10px] font-bold tabular-nums">{totalCount}</Badge>
      </header>
      <ol className="px-2">
        {items.map((item: any, idx: number) => {
          const ref = meetingIdForAction(item.task);
          const inner = (
            <>
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground/40 tabular-nums pt-1 shrink-0 w-7">{String(idx + 1).padStart(2, '0')}</span>
              <span className="min-w-0 flex-1 flex flex-col gap-1.5 pr-4">
                <span className="text-sm leading-relaxed text-foreground/95">{item.task}</span>
                {(item.owner || ref) && (
                  <span className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    {item.owner && <span className="inline-flex rounded-md bg-muted/60 px-1.5 py-0.5 font-medium text-muted-foreground">{item.owner}</span>}
                    {ref && <span className="inline-flex items-center gap-1 text-muted-foreground/70">from <span className="text-foreground/80 font-medium">{ref.title}</span></span>}
                  </span>
                )}
              </span>
              {ref && <ArrowRight className="size-3.5 mt-1.5 shrink-0 text-muted-foreground/40 group-hover:text-foreground transition-colors" />}
            </>
          );
          return ref ? (
            <li key={idx} className="border-b border-border/20 last:border-b-0">
              <button type="button" onClick={() => onSelectEvent(ref.evId)} className="group flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/25">
                {inner}
              </button>
            </li>
          ) : (
            <li key={idx} className="flex items-start gap-3 px-4 py-3.5 border-b border-border/20 last:border-b-0">{inner}</li>
          );
        })}
      </ol>
    </section>
  );
}

function SignalRail({ items, title, subtitle, accent }: { items: string[]; title: string; subtitle: string; accent: 'violet' | 'amber' }) {
  const cls = accent === 'violet'
    ? { chip: 'bg-violet-500/15 text-violet-300 ring-1 ring-violet-400/25', dot: 'bg-violet-400/80' }
    : { chip: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/25', dot: 'bg-amber-400/80' };
  return (
    <section className="rounded-2xl border border-border/40 bg-card/40 backdrop-blur-sm px-5 py-4">
      <div className="flex items-center gap-2.5 mb-3">
        <span className={cn('grid size-7 place-items-center rounded-md', cls.chip)}><Sparkles className="size-3.5" /></span>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground/80">{title}</div>
          <div className="text-sm font-semibold text-foreground">{subtitle}</div>
        </div>
      </div>
      <ul className="flex flex-col gap-2">
        {items.map((t, i) => (
          <li key={i} className="flex items-start gap-2.5 text-[13px] text-foreground/85 leading-relaxed">
            <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', cls.dot)} />
            <span className="line-clamp-3">{t}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SelectACue() {
  return (
    <div className="flex items-center justify-center gap-3 pt-1 pb-2 text-[10px] uppercase tracking-[0.24em] text-muted-foreground/40">
      <span className="h-px w-10 bg-border/40" />
      <span>Pick an item to read its full story</span>
      <span className="h-px w-10 bg-border/40" />
    </div>
  );
}

// ─── Event detail (unchanged below) ────────────────────────────────

function EventDetailHeader({ event, meeting }: { event: DayEvent; meeting: Meeting | null }) {
  const dur = eventDuration(event), sl = SOURCE_LABELS[event.source] ?? event.source;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <h1 className="text-[1.65rem] font-semibold tracking-tight leading-tight text-foreground" style={{ fontFamily: 'var(--font-sans)' }}>{event.title}</h1>
        <div className="flex items-center gap-2 mt-1">
          <Badge variant="secondary" className={cn('text-xs gap-1.5 px-2.5 py-0.5', KIND_COLOR[event.kind])}><KindIcon kind={event.kind} className="size-3.5" />{KIND_LABELS[event.kind]}</Badge>
          {meeting && <Badge variant="outline" className="text-xs px-2.5 py-0.5 font-medium">{platformLabel(meeting.platform)}</Badge>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
        <div className="flex items-center gap-1.5"><Calendar className="size-3.5 opacity-70" /><span className="font-medium">{prettyDay(event.day)}</span></div>
        <span className="text-border" aria-hidden="true">·</span>
        <div className="flex items-center gap-1.5"><Clock className="size-3.5 opacity-70" /><span className="font-medium tabular-nums">{formatDayEventTimeRange(event)}</span>{dur != null && <span className="text-muted-foreground/60 font-normal tabular-nums">({formatDuration(dur)})</span>}</div>
        {event.source_app && <><span className="text-border" aria-hidden="true">·</span><div className="flex items-center gap-1.5"><Inbox className="size-3.5 opacity-70" /><span className="font-medium">{event.source_app}</span></div></>}
        <span className="ml-auto text-[10px] uppercase tracking-[0.16em] font-bold text-muted-foreground/70">{sl}</span>
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
