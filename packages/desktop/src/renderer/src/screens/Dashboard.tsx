import * as React from 'react';
import {
  AlertCircle, Calendar, ChevronDown, ChevronRight, CheckSquare, CircleStop, Clock,
  ExternalLink, FileText, FolderOpen, History, Inbox, Loader2, MessageSquare, Mic,
  Pause, Play, RefreshCcw, Search as SearchIcon, Sparkles, Wand2, XCircle, Zap,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/PageHeader';
import { dayEventSourceShortLabel } from '@/lib/day-events';
import { bootstrapMessage, formatBytes, formatLocalDateTime, formatLocalTime, formatNumber, indexingStatusText, localDayKey } from '@/lib/format';
import { actionItemLabel, collectMeetingSummarySignals } from '@/lib/meeting-signals';
import { cn } from '@/lib/utils';
import type { ActivitySession, DayEvent, DoctorCheck, Frame, JournalDay, Meeting, ModelBootstrapProgress, RuntimeActionCenter, RuntimeActionCenterFollowup, RuntimeActionCenterProject, RuntimeActionCenterUrgency, RuntimeMeetingWorkBridge, RuntimeOverview } from '@/global';

const FULL_JOURNAL_FRAME_LIMIT = 600, ACTIVITY_SAMPLE_LIMIT = 500, TIMELINE_UPCOMING_LIMIT = 3, TIMELINE_RECENT_LIMIT = 6;

export function Dashboard({
  overview, doctor, bootstrapEvents, onRefresh, onStart, onStop, onPause, onResume,
  onTriggerIndex, onTriggerReorganise, onTriggerFullReindex, onBootstrap, onOpenMarkdownExport, onGoMeetings, onSearch,
}: {
  overview: RuntimeOverview | null; doctor: DoctorCheck[] | null; bootstrapEvents: ModelBootstrapProgress[];
  onRefresh: () => void; onStart: () => Promise<void>; onStop: () => Promise<void>; onPause: () => Promise<void>; onResume: () => Promise<void>;
  onTriggerIndex: () => Promise<void>; onTriggerReorganise: () => Promise<void>; onTriggerFullReindex: (fromDate: string) => Promise<void>;
  onBootstrap: () => Promise<void>; onOpenMarkdownExport: (category?: string) => Promise<void>; onGoMeetings: (target?: { eventId: string; day: string } | null) => void; onSearch: (query: string) => void;
}) {
  const [bootstrapping, setBootstrapping] = React.useState(false);
  const { journal, loading } = useTodayJournal(overview);
  const founderBrief = useFounderBrief(overview);
  const actionCenter = useActionCenter(overview);

  if (!overview) return <div className="flex flex-col gap-10 pt-6"><PageHeader title="Today" description="Getting things ready…" /><TodayHomeSkeleton /></div>;

  const captureLive = overview.capture.running && !overview.capture.paused;
  const capturePaused = overview.capture.running && overview.capture.paused;
  const failures = doctor?.filter((c) => c.status === 'fail') ?? [];
  const warnings = doctor?.filter((c) => c.status === 'warn') ?? [];

  return (
    <div className="flex flex-col gap-6 pt-4 pb-6">
      <PageHeader title="Today" eyebrow={new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} description="Search, timeline, and capture status for the day." actions={<Button variant="ghost" size="sm" onClick={onRefresh}><RefreshCcw />Refresh</Button>} />
      
      <TodayHome overview={overview} captureLive={captureLive} capturePaused={capturePaused} running={overview.status === 'running'} journal={journal} loading={loading || founderBrief.loading} actionCenter={actionCenter.center} actionLoading={actionCenter.loading} events={founderBrief.events} meetings={founderBrief.meetings} onStart={onStart} onStop={onStop} onPause={onPause} onResume={onResume} onSearch={onSearch} onGoMeetings={onGoMeetings} />

      {overview.indexing.running && <Alert><Loader2 className="animate-spin" /><AlertTitle>{indexingStatusText(overview.indexing)}</AlertTitle><AlertDescription>This runs in the background and may take a few minutes.</AlertDescription></Alert>}

      {!overview.model.ready && (
        <Alert variant="warning"><Sparkles /><AlertTitle>Set up your local AI helper</AlertTitle>
          <AlertDescription className="gap-3"><p>One quick step to download a small model for offline search and summaries.</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={bootstrapping} onClick={async () => { setBootstrapping(true); try { await onBootstrap(); } finally { setBootstrapping(false); } }}>{bootstrapping ? 'Setting up…' : 'Set up now'}</Button>
              {bootstrapEvents.length > 0 && <span className="text-xs text-muted-foreground">{bootstrapMessage(bootstrapEvents[bootstrapEvents.length - 1]!)}</span>}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {failures.length > 0 && <section className="flex flex-col gap-2">{failures.map((c, i) => <Alert key={i} variant="destructive"><XCircle /><AlertTitle>{c.area}</AlertTitle><AlertDescription><p>{c.message}</p>{c.action && <p className="text-xs opacity-80 mt-1">→ {c.action}</p>}</AlertDescription></Alert>)}</section>}

      <AdvancedSection overview={overview} warnings={warnings} onTriggerIndex={onTriggerIndex} onTriggerReorganise={onTriggerReorganise} onTriggerFullReindex={onTriggerFullReindex} onOpenMarkdownExport={onOpenMarkdownExport} />
    </div>
  );
}

function TodayHomeSkeleton() {
  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        {[1, 2, 3].map((i) => <div key={i} className="rounded-lg border bg-card/70 p-4 shadow-card"><Skeleton className="h-11 w-full rounded-lg" /></div>)}
      </div>
      <div className="flex min-w-0 flex-col gap-4"><Skeleton className="h-72 rounded-lg" /><Skeleton className="h-52 rounded-lg" /></div>
    </section>
  );
}

function useTodayJournal(overview: RuntimeOverview | null) {
  const [journal, setJournal] = React.useState<JournalDay | null>(null), [loading, setLoading] = React.useState(true);
  const events = overview?.capture.eventsToday ?? 0, running = !!overview?.capture.running;
  React.useEffect(() => {
    if (!running && events === 0) { setLoading(false); setJournal(null); return; }
    let c = false; setLoading(true);
    (async () => {
      try {
        const d = localDayKey(), res = events <= FULL_JOURNAL_FRAME_LIMIT ? await window.cofounderos.getJournalDay(d) : { day: d, frames: await window.cofounderos.searchFrames({ day: d, limit: ACTIVITY_SAMPLE_LIMIT }), sessions: [] };
        if (!c) setJournal(res);
      } catch { if (!c) setJournal(null); } finally { if (!c) setLoading(false); }
    })();
    return () => { c = true; };
  }, [events, running]);
  return { journal, loading };
}

function useFounderBrief(overview: RuntimeOverview | null) {
  const [events, setEvents] = React.useState<DayEvent[]>([]), [meetings, setMeetings] = React.useState<Meeting[]>([]), [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    if (!overview) { setEvents([]); setMeetings([]); setLoading(false); return; }
    let c = false; setLoading(true);
    (async () => {
      const d = localDayKey();
      try {
        const [evs, mtgs] = await Promise.all([window.cofounderos.listDayEvents({ day: d, limit: 200 }).catch(() => []), window.cofounderos.listMeetings({ from: `${d}T00:00:00`, to: `${d}T23:59:59.999`, limit: 100 }).catch(() => [])]);
        if (c) return;
        setEvents(evs.filter(e => e.title !== '__merged__')); setMeetings(mtgs.filter(m => m.day === d).sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at)));
      } finally { if (!c) setLoading(false); }
    })();
    return () => { c = true; };
  }, [overview?.capture.eventsToday]);
  return { events, meetings, loading };
}

function useActionCenter(overview: RuntimeOverview | null) {
  const [center, setCenter] = React.useState<RuntimeActionCenter | null>(null), [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    if (!overview) { setCenter(null); setLoading(false); return; }
    let c = false; setLoading(true);
    (async () => {
      try { const res = await window.cofounderos.getActionCenter({ day: localDayKey() }); if (!c) setCenter(res); }
      catch { if (!c) setCenter(null); } finally { if (!c) setLoading(false); }
    })();
    return () => { c = true; };
  }, [Math.floor((overview?.capture.eventsToday ?? 0) / 5)]);
  return { center, loading };
}

function buildFounderCards(journal: JournalDay | null, events: DayEvent[], meetings: Meeting[]) {
  const chron = events.slice().sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)), now = Date.now();
  const sigs = collectMeetingSummarySignals(meetings);
  const acts = sigs.actionItems.map(i => ({ title: actionItemLabel(i), meta: i.due ? `Due ${i.due}` : 'From meeting' }));
  const open = sigs.openQuestions.map(q => ({ title: q.text, meta: 'Open question' })), decs = sigs.decisions.map(d => ({ title: d.text, meta: 'Decision' }));
  const rep = chron.filter(e => isRelevantSignalEvent(e) && ['communication', 'email_screen', 'slack_screen'].includes(e.kind || e.source)).map(e => ({ title: signalTitleForEvent(e), meta: eventMeta(e), eventId: e.id, day: e.day }));
  const tsk = chron.filter(e => e.kind === 'task' && isRelevantSignalEvent(e)).map(e => ({ title: signalTitleForEvent(e), meta: eventMeta(e), eventId: e.id, day: e.day }));
  const chg = chron.filter(e => e.kind !== 'meeting' && Date.parse(e.starts_at) <= now && isRelevantSignalEvent(e)).slice(-4).reverse().map(e => ({ title: signalTitleForEvent(e), meta: eventMeta(e), eventId: e.id, day: e.day }));
  const top = (journal?.frames?.length ?? 0) > 0 ? countByApp(journal!.frames).slice(0, 3).map(r => ({ title: r.app, meta: `${r.count} moment${r.count === 1 ? '' : 's'}` })) : [];

  return [
    { title: 'What changed', label: String(chg.length || top.length), icon: Zap, accent: 'text-primary', empty: 'Nothing notable.', items: chg.length ? chg : top },
    { title: 'Replies', label: String(rep.length), icon: Inbox, accent: 'text-blue-500 dark:text-blue-300', empty: 'No replies.', items: rep },
    { title: 'Promises', label: String(acts.length + tsk.length), icon: CheckSquare, accent: 'text-emerald-500 dark:text-emerald-300', empty: 'No tasks.', items: [...acts, ...tsk] },
    { title: 'Follow up', label: String(open.length + decs.length), icon: AlertCircle, accent: 'text-amber-500 dark:text-amber-300', empty: 'No follow ups.', items: [...open, ...decs] }
  ];
}

function eventMeta(event: DayEvent) { return [formatLocalTime(event.starts_at), event.source_app || dayEventSourceShortLabel(event.source)].filter(Boolean).join(' · '); }
function signalTitleForEvent(event: DayEvent) { const t = event.title.trim(), c = cleanSignalContext(event.context_md); return !isLowSignalText(t) ? t : c || event.source_app || dayEventSourceShortLabel(event.source); }
function isRelevantSignalEvent(event: DayEvent) { return event.title !== '__merged__' && (!isLowSignalText(event.title) || cleanSignalContext(event.context_md).length > 0); }
function cleanSignalContext(value?: string | null) { const c = stripMarkdown(value).trim(); return isLowSignalText(c) || /^visible in .+ accessibility text\.?$/i.test(c) ? '' : c; }
function isLowSignalText(value?: string | null) { const c = stripMarkdown(value).trim().toLowerCase(); return !c || ['n/a', 'na', 'none', 'unknown', 'untitled', '__merged__'].includes(c) || /^no (summary|context|title) available/.test(c); }

function TodayHome({ overview, captureLive, capturePaused, running, journal, loading, actionCenter, actionLoading, events, meetings, onStart, onStop, onPause, onResume, onSearch, onGoMeetings }: any) {
  const fCards = React.useMemo(() => buildFounderCards(journal, events, meetings), [journal, events, meetings]);
  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        <QuickSearchPanel onSearch={onSearch} />
        <ActionCenterPanel center={actionCenter} loading={actionLoading} onSearch={onSearch} />
        <InsightsPanel items={React.useMemo(() => buildInsights(meetings, fCards), [meetings, fCards])} onOpenItem={(i: any) => i.eventId && i.day && onGoMeetings({ eventId: i.eventId, day: i.day })} />
        <ActivityTimeline items={React.useMemo(() => buildTimelineItems(journal, events), [journal, events])} loading={loading} onOpenEvent={(e: any) => onGoMeetings({ eventId: e.id, day: e.day })} />
      </div>
      <aside className="flex min-w-0 flex-col gap-4">
        <CapturePanel overview={overview} captureLive={captureLive} capturePaused={capturePaused} running={running} journal={journal} onStart={onStart} onStop={onStop} onPause={onPause} onResume={onResume} />
        <MemorySnapshot overview={overview} journal={journal} loading={loading} />
      </aside>
    </section>
  );
}

function QuickSearchPanel({ onSearch }: { onSearch: (q: string) => void }) {
  const [q, setQ] = React.useState('');
  const submit = (v = q) => v.trim() && onSearch(v.trim());
  return (
    <section className="rounded-lg border bg-card/70 p-4 shadow-card">
      <form className="flex flex-col gap-3 sm:flex-row" onSubmit={e => { e.preventDefault(); submit(); }}>
        <div className="relative min-w-0 flex-1"><SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search memory..." className="h-11 rounded-lg pl-9 text-base" /></div>
        <Button type="submit" className="h-11 sm:w-28"><SearchIcon />Search</Button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">{['what changed today', 'open loops today', 'meetings today', 'what was I doing this morning'].map(s => <button key={s} type="button" onClick={() => submit(s)} className="rounded-md border bg-background/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/35 hover:text-foreground">{s}</button>)}</div>
    </section>
  );
}

function ActionCenterPanel({ center, loading, onSearch }: { center: RuntimeActionCenter | null; loading: boolean; onSearch: (q: string) => void }) {
  if (loading && !center) return <section className="rounded-lg border bg-card p-4 shadow-card"><div className="flex items-center gap-3"><Loader2 className="size-4 animate-spin text-primary" /><div className="text-sm text-muted-foreground">Loading action center...</div></div></section>;
  if (!center) return null;
  const fols = [...center.followups].sort((a, b) => urgencyWeight(b.urgency) - urgencyWeight(a.urgency)).slice(0, 5);
  const brdgs = center.meetingBridges.slice(0, 4);
  if (!fols.length && !brdgs.length) return null;

  return (
    <section className="rounded-lg border bg-card p-5 shadow-card">
      <div className="mb-5 flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Wand2 className="size-4 text-primary" /><h3 className="text-base font-semibold">Action center</h3></div><span className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase', center.source === 'llm' ? 'bg-primary/10 text-primary' : 'bg-amber-500/10 text-amber-700')}>{center.source}</span></div>
      <div className={cn('grid gap-5', (fols.length && brdgs.length) ? 'lg:grid-cols-2' : '')}>
        {fols.length > 0 && <ActionColumn title="Follow-ups" icon={Inbox} accent="text-emerald-500" count={fols.length}>{fols.map((i, idx) => <FollowupRow key={idx} item={i} onOpen={() => onSearch(i.title)} />)}</ActionColumn>}
        {brdgs.length > 0 && <ActionColumn title="Meeting → work" icon={MessageSquare} accent="text-amber-500" count={brdgs.length}>{brdgs.map(b => <BridgeRow key={b.meetingId} bridge={b} onOpen={() => onSearch(b.title)} />)}</ActionColumn>}
      </div>
    </section>
  );
}

function urgencyWeight(u: RuntimeActionCenterUrgency) { return u === 'high' ? 3 : u === 'medium' ? 2 : u === 'low' ? 1 : 0; }

function ActionColumn({ title, icon: Icon, accent, count, children }: any) {
  return <div className="min-w-0"><div className="mb-2.5 flex items-center gap-2"><Icon className={cn('size-3.5 shrink-0', accent)} /><div className="text-xs font-semibold uppercase text-muted-foreground">{title}</div><span className="ml-auto rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium">{count}</span></div><div className="flex flex-col gap-2">{children}</div></div>;
}

function ActionRowChrome({ children, onOpen, active }: any) {
  return <button type="button" onClick={onOpen} className={cn('group relative w-full rounded-md border px-3 py-2.5 text-left transition-colors', active ? 'border-primary/40 bg-primary/5 hover:bg-primary/10' : 'border-border/70 bg-background/55 hover:border-border hover:bg-accent/30')}>{children}<ChevronRight className="absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" /></button>;
}

function FollowupRow({ item, onOpen }: any) {
  return <ActionRowChrome onOpen={onOpen}><div className="flex items-start gap-2 pr-5"><span className={cn('mt-1.5 size-2 shrink-0 rounded-full', item.urgency === 'high' ? 'bg-red-500' : item.urgency === 'medium' ? 'bg-amber-500' : 'bg-muted-foreground/40')} /><div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-2"><span className="text-sm font-medium">{cleanActionText(item.title) || item.category}</span><span className="shrink-0 mt-0.5 text-[10px] uppercase text-muted-foreground">{item.app || item.category}</span></div>{item.body && <p className="mt-1 text-xs text-muted-foreground">{cleanActionText(item.body)}</p>}</div></div></ActionRowChrome>;
}

function BridgeRow({ bridge, onOpen }: any) {
  const f = bridge.followups[0] ? `Follow-up: ${cleanActionText(bridge.followups[0])}` : bridge.workAfter[0] ? `After: ${cleanActionText(bridge.workAfter[0])}` : null;
  return <ActionRowChrome onOpen={onOpen}><div className="pr-5"><div className="flex justify-between gap-2"><span className="line-clamp-1 text-sm font-medium">{cleanActionText(bridge.title) || 'Meeting'}</span><span className="text-[11px] text-muted-foreground">{formatLocalTime(bridge.startedAt)}</span></div>{bridge.summary && <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{cleanActionText(bridge.summary)}</p>}{f && <p className="mt-1 line-clamp-1 text-xs">{f}</p>}</div></ActionRowChrome>;
}

function cleanActionText(v?: string | null) { return stripMarkdown(v).replace(/\s+/g, ' ').trim(); }

function InsightsPanel({ items, onOpenItem }: any) {
  if (!items.length) return null;
  return (
    <section className="rounded-lg border bg-card/70 p-4 shadow-card">
      <div className="mb-3 flex justify-between gap-3"><div><h3 className="text-sm font-semibold">Insights</h3><p className="text-xs text-muted-foreground">Actionable context.</p></div><Sparkles className="size-4 text-primary" /></div>
      <div className="grid gap-3 md:grid-cols-2">{items.map((i: any) => { const Icon = i.icon; return <button key={i.id} onClick={() => i.eventId && onOpenItem(i)} className={cn('min-w-0 rounded-lg border bg-background/55 p-3 text-left transition-colors', i.eventId ? 'hover:border-primary/35 hover:bg-accent/35' : 'cursor-default')}><div className="flex items-start gap-3"><span className={cn('grid size-8 place-items-center rounded-md bg-muted', i.accent)}><Icon className="size-4" /></span><div className="min-w-0"><div className="line-clamp-1 text-sm font-medium">{i.title}</div><p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{i.body}</p><div className="mt-2 truncate text-[11px] text-muted-foreground">{i.meta}</div></div></div></button>; })}</div>
    </section>
  );
}

function CapturePanel({ overview, captureLive, capturePaused, running, journal, onStart, onStop, onPause, onResume }: any) {
  const am = journal?.sessions.reduce((acc: number, s: any) => acc + (s.active_ms || 0), 0) || 0;
  return (
    <section className="rounded-lg border bg-card/70 p-4 shadow-card">
      <div className="flex justify-between gap-3">
        <div><StatusBadge tone={captureLive ? 'live' : capturePaused ? 'paused' : 'idle'}>{captureLive ? 'Live' : capturePaused ? 'Paused' : 'Stopped'}</StatusBadge><h3 className="mt-3 text-lg font-semibold">{captureLive ? 'Capturing today' : capturePaused ? 'Capture paused' : 'Capture ready'}</h3></div>
        <div className="flex gap-1.5">{!running ? <Button size="icon" onClick={onStart}><Play /></Button> : captureLive ? <Button size="icon" variant="secondary" onClick={onPause}><Pause /></Button> : capturePaused ? <Button size="icon" onClick={onResume}><Play /></Button> : <Button size="icon" variant="ghost" onClick={onStop}><CircleStop /></Button>}</div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3"><MiniStat label="Moments" value={formatNumber(overview.capture.eventsToday)} /><MiniStat label="Last hour" value={overview.capture.eventsLastHour != null ? formatNumber(overview.capture.eventsLastHour) : '-'} /><MiniStat label="Active" value={am > 0 ? (am < 60000 ? `${Math.round(am / 60000)}m` : `${Math.floor(am / 3600000)}h ${Math.round((am % 3600000) / 60000)}m`) : '—'} /></div>
      <ActivityBars frames={journal?.frames ?? []} loading={false} accent={captureLive} />
    </section>
  );
}

function MemorySnapshot({ overview, journal, loading }: any) {
  const apps = journal ? countByApp(journal.frames).slice(0, 3) : [], tot = Math.max(1, journal?.frames.length ?? overview.capture.eventsToday);
  return (
    <section className="rounded-lg border bg-card/70 p-4 shadow-card">
      <div className="mb-3 flex justify-between"><h3 className="text-sm font-semibold">Memory snapshot</h3>{overview.indexing.running ? <span className="flex items-center gap-1 text-xs text-primary"><Loader2 className="size-3 animate-spin" />Indexing</span> : <FileText className="size-4 text-muted-foreground" />}</div>
      <div className="grid grid-cols-2 gap-3"><BigStat value={formatNumber(overview.index.pageCount)} label="pages" /><BigStat value={formatNumber(overview.storage.totalEvents)} label="memories" muted /></div>
      <Separator className="my-4" />
      {loading && !journal ? <div className="flex flex-col gap-3">{[1, 2, 3].map(i => <div key={i} className="flex gap-3"><Skeleton className="h-4 w-24" /><Skeleton className="h-2.5 flex-1" /><Skeleton className="h-4 w-12" /></div>)}</div> : !apps.length ? <p className="text-sm text-muted-foreground">Top apps will appear soon.</p> : <div className="flex flex-col gap-2">{apps.map((a, i) => <div key={a.app} className="flex items-center gap-3"><div className="w-32 truncate text-sm">{a.app}</div><div className="flex-1 h-2.5 rounded-full bg-muted overflow-hidden"><div className={cn('h-full rounded-full transition-all duration-700', i === 0 ? 'bg-gradient-brand' : 'bg-foreground/30')} style={{ width: `${Math.max(2, (a.count / tot) * 100)}%` }} /></div><div className="w-20 text-right text-xs text-muted-foreground">{a.count} <span className="opacity-50">· {((a.count / tot) * 100).toFixed(0)}%</span></div></div>)}</div>}
    </section>
  );
}

function ActivityTimeline({ items, loading, onOpenEvent }: any) {
  return (
    <section className="rounded-lg border bg-card/70 p-4 shadow-card">
      <div className="mb-4 flex justify-between gap-3"><div><h3 className="text-sm font-semibold">Activity timeline</h3><p className="text-xs text-muted-foreground">Soonest upcoming, then recent history.</p></div><History className="size-4 text-muted-foreground" /></div>
      {loading && !items.length ? <div className="flex flex-col gap-3">{[1, 2, 3, 4].map(i => <div key={i} className="flex gap-3"><Skeleton className="size-8 rounded-md" /><div className="flex-1"><Skeleton className="h-4 w-48" /><Skeleton className="mt-2 h-3 w-full" /></div></div>)}</div> : !items.length ? <p className="text-sm text-muted-foreground">No recent activity.</p> : <div className="relative flex flex-col gap-1"><div className="absolute bottom-3 left-[15px] top-3 w-px bg-border" />{items.map((i: any, idx: number) => { const Icon = i.icon; return <React.Fragment key={i.id}>{idx === 0 || items[idx - 1]?.bucket !== i.bucket ? <div className="z-10 ml-11 mt-2 text-[10px] font-medium uppercase text-muted-foreground">{i.bucket === 'upcoming' ? 'Up next' : 'Recent history'}</div> : null}<button type="button" onClick={() => i.event && onOpenEvent(i.event)} className={cn('relative flex min-w-0 gap-3 rounded-md px-1 py-2 text-left transition-colors', i.event ? 'hover:bg-accent/35' : 'cursor-default')}><span className={cn('z-10 grid size-8 shrink-0 place-items-center rounded-md bg-muted', i.accent)}><Icon className="size-4" /></span><span className="min-w-0 flex-1"><span className="flex justify-between gap-3"><span className="line-clamp-1 text-sm font-medium">{i.title}</span><span className="text-[11px] text-muted-foreground">{formatLocalTime(i.at)}</span></span><span className="mt-0.5 truncate text-xs text-muted-foreground">{i.meta}</span>{i.description && <span className="mt-1 line-clamp-2 text-sm text-muted-foreground">{i.description}</span>}</span></button></React.Fragment>; })}</div>}
    </section>
  );
}

function buildInsights(meetings: Meeting[], cards: any[]) {
  const rm = meetings.filter(m => m.summary_status === 'ready').sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0];
  const prm = cards.find(c => c.title === 'Promises'), fup = cards.find(c => c.title === 'Follow up'), rep = cards.find(c => c.title === 'Replies');
  const res = [];
  if (rm) res.push({ id: `mtg-${rm.id}`, title: 'Meeting summary ready', body: rm.summary_json?.tldr || rm.title || rm.platform, meta: `${formatLocalTime(rm.started_at)} · ${rm.platform}`, icon: MessageSquare, accent: 'text-blue-500' });
  if (prm?.items.length) res.push({ id: 'prm', title: `${prm.items.length} promises`, body: prm.items[0].title, meta: prm.items[0].meta, icon: CheckSquare, accent: 'text-emerald-500', eventId: prm.items[0].eventId, day: prm.items[0].day });
  if (fup?.items.length) res.push({ id: 'fup', title: `${fup.items.length} follow-ups`, body: fup.items[0].title, meta: fup.items[0].meta, icon: AlertCircle, accent: 'text-amber-500', eventId: fup.items[0].eventId, day: fup.items[0].day });
  if (rep?.items.length) res.push({ id: 'rep', title: `${rep.items.length} replies`, body: rep.items[0].title, meta: rep.items[0].meta, icon: Inbox, accent: 'text-blue-500', eventId: rep.items[0].eventId, day: rep.items[0].day });
  return res.slice(0, 4);
}

function buildTimelineItems(journal: JournalDay | null, events: DayEvent[]) {
  const now = Date.now(), upc = [], his = [];
  for (const e of events) {
    if (!isRelevantSignalEvent(e) || !Number.isFinite(Date.parse(e.starts_at))) continue;
    const b = Date.parse(e.starts_at) >= now ? 'upcoming' : 'history';
    const item = { id: `evt-${e.id}`, at: e.starts_at, title: signalTitleForEvent(e), meta: [e.kind, eventMeta(e)].filter(Boolean).join(' · '), description: cleanSignalContext(e.context_md).slice(0, 180), bucket: b, icon: e.kind === 'meeting' ? Calendar : e.kind === 'communication' ? MessageSquare : e.kind === 'task' ? CheckSquare : Zap, accent: e.kind === 'meeting' ? 'text-amber-500' : e.kind === 'communication' ? 'text-blue-500' : e.kind === 'task' ? 'text-emerald-500' : 'text-primary', event: e };
    b === 'upcoming' ? upc.push(item) : his.push(item);
  }
  for (const s of journal?.sessions ?? []) if (s.started_at && Date.parse(s.started_at) <= now) his.push({ id: `ses-${s.id || s.started_at}`, at: s.started_at, title: s.primary_entity_path ? s.primary_entity_path.split('/').pop()?.replace(/[-_]+/g, ' ') || s.primary_entity_path : s.primary_app || 'Focus', meta: `${Math.round((s.active_ms || 0)/60000)}m · ${s.frame_count || 0} frames`, bucket: 'history', icon: Clock, accent: 'text-primary' });
  return [...upc.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(0, 3), ...his.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 6)];
}

function stripMarkdown(v?: string | null) { return (v || '').replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[#>_\-]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function StatusBadge({ tone, children }: any) { return <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium uppercase', tone === 'live' ? 'bg-success/15 text-success' : tone === 'paused' ? 'bg-warning/15 text-warning' : 'bg-muted text-muted-foreground')}><span className="relative grid place-items-center size-2"><span className={cn('size-1.5 rounded-full', tone === 'live' ? 'bg-success' : tone === 'paused' ? 'bg-warning' : 'bg-muted-foreground/60')} />{tone === 'live' && <span className="absolute inset-0 rounded-full bg-success/50 animate-ping" />}</span>{children}</span>; }
function MiniStat({ label, value }: any) { return <div className="min-w-0"><div className="text-[10px] uppercase text-muted-foreground">{label}</div><div className="text-2xl font-semibold tabular">{value}</div></div>; }

function ActivityBars({ frames, loading, accent }: any) {
  const hr = new Array(24).fill(0); frames.forEach((f: any) => { if (f.timestamp && !Number.isNaN(Date.parse(f.timestamp))) hr[new Date(f.timestamp).getHours()]++; });
  const max = Math.max(1, ...hr), curr = new Date().getHours(), emp = !frames.length;
  if (loading && emp) return <div className="mt-3 h-10 w-full max-w-md rounded-md bg-muted animate-pulse" />;
  return (
    <div className="mt-4 max-w-md">
      <div className="flex items-end gap-[3px] h-10">{hr.map((c, h) => <div key={h} className={cn('flex-1 rounded-sm transition-all', h === curr ? (accent ? 'shadow-glow bg-gradient-brand' : 'ring-1 ring-primary/40 bg-foreground/70') : emp ? 'bg-muted-foreground/15' : h < curr ? 'bg-foreground/70' : 'bg-muted-foreground/20')} style={{ height: `${emp ? 6 : Math.max(8, (c / max) * 100)}%` }} />)}</div>
      <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
    </div>
  );
}

function BigStat({ value, label, muted }: any) { return <div><div className={cn('text-2xl font-semibold tabular', muted && 'text-foreground/70')}>{value}</div><div className="text-[11px] uppercase text-muted-foreground">{label}</div></div>; }
function countByApp(frames: Frame[]) { const c = new Map<string, number>(); frames.forEach(f => c.set(f.app || 'Unknown', (c.get(f.app || 'Unknown') || 0) + 1)); return Array.from(c.entries()).map(([app, count]) => ({ app, count })).sort((a, b) => b.count - a.count); }

function AdvancedSection({ overview, warnings, onTriggerIndex, onTriggerReorganise, onTriggerFullReindex, onOpenMarkdownExport }: any) {
  const [open, setOpen] = React.useState(false);
  return (
    <section>
      <button type="button" onClick={() => setOpen(!open)} className="group flex w-full items-center justify-between gap-3 rounded-xl border bg-card/40 px-4 py-3 text-left transition-colors hover:bg-accent/40">
        <div className="flex items-center gap-3"><span className="grid size-8 place-items-center rounded-lg bg-muted"><Wand2 className="size-4" /></span><div><div className="text-sm font-medium">Advanced controls</div><div className="text-xs text-muted-foreground">Re-index, browse export, watch jobs.</div></div></div>
        <ChevronDown className={cn('size-4 text-muted-foreground transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-4 flex flex-col gap-4 animate-in fade-in slide-in-from-top-1">
          <KnowledgeExport overview={overview} onOpenMarkdownExport={onOpenMarkdownExport} />
          <MemoryOrganization overview={overview} onTriggerIndex={onTriggerIndex} onTriggerReorganise={onTriggerReorganise} onTriggerFullReindex={onTriggerFullReindex} />
          {overview.backgroundJobs?.length > 0 && <BackgroundWorkCard overview={overview} />}
          {warnings.length > 0 && <div className="grid gap-2">{warnings.slice(0, 5).map((c: any, i: number) => <Alert key={i} variant="warning"><AlertCircle /><AlertTitle>{c.area}</AlertTitle><AlertDescription><p>{c.message}</p>{c.action && <p className="text-xs mt-1">→ {c.action}</p>}</AlertDescription></Alert>)}</div>}
        </div>
      )}
    </section>
  );
}

function KnowledgeExport({ overview, onOpenMarkdownExport }: any) {
  return (
    <Card><CardContent className="space-y-5">
      <div className="flex justify-between items-center"><div className="flex items-center gap-3"><FolderOpen className="size-8 text-primary" /><div><h4 className="font-semibold">Export & Index</h4><p className="text-sm text-muted-foreground">{overview.index.pageCount} pages generated.</p></div></div><Button variant="outline" onClick={() => onOpenMarkdownExport()}>Open export</Button></div>
      {overview.index.categories?.length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{overview.index.categories.map((c: any) => <button key={c.name} className="p-4 border rounded-xl text-left hover:bg-muted/40" onClick={() => onOpenMarkdownExport(c.name)}><div className="font-medium capitalize">{c.name.replace(/[-_]/g, ' ')}</div><div className="text-xs text-muted-foreground">{c.pageCount} pages</div></button>)}</div> : <div className="p-4 border border-dashed text-sm text-muted-foreground">No categories yet.</div>}
    </CardContent></Card>
  );
}

function MemoryOrganization({ overview, onTriggerIndex, onTriggerReorganise, onTriggerFullReindex }: any) {
  const [org, setOrg] = React.useState<string | null>(null), [rdx, setRdx] = React.useState(localDayKey());
  const wrap = (t: string, fn: any) => async () => { setOrg(t); try { await fn(); } finally { setOrg(null); } };
  return (
    <Card><CardContent className="flex flex-col gap-4">
      <div className="flex justify-between items-center"><div><div className="font-medium">Refresh memory index</div><div className="text-sm text-muted-foreground">Run incremental indexing.</div></div><Button disabled={!!org || overview.indexing.running} onClick={wrap('idx', onTriggerIndex)}><RefreshCcw /> {org === 'idx' ? 'Organizing...' : 'Organize now'}</Button></div>
      <Separator />
      <div className="flex justify-between items-center"><div><div className="font-medium">Rebuild summaries</div><div className="text-sm text-muted-foreground">Reorganize pages.</div></div><Button variant="outline" disabled={!!org || overview.indexing.running} onClick={wrap('reorg', onTriggerReorganise)}><Wand2 /> {org === 'reorg' ? 'Rebuilding...' : 'Rebuild'}</Button></div>
      <Separator />
      <div className="flex justify-between items-center"><div><div className="font-medium">Re-index from date</div></div><div className="flex gap-2"><Input type="date" value={rdx} onChange={e => setRdx(e.target.value)} className="w-[150px]" /><Button variant="outline" disabled={!!org || overview.indexing.running || !rdx} onClick={wrap('full', () => onTriggerFullReindex(rdx))}><RefreshCcw /> Re-index</Button></div></div>
    </CardContent></Card>
  );
}

function BackgroundWorkCard({ overview }: any) {
  return (
    <Card><CardContent>
      <div className="font-medium mb-3">Background Jobs</div>
      <div className="grid gap-2 md:grid-cols-2">{overview.backgroundJobs?.slice(0, 6).map((j: any) => <div key={j.name} className={cn('p-3 border rounded-lg', j.running && 'bg-warning/10 border-warning/40')}><div className="flex justify-between font-medium text-sm">{j.name.replace('index-', '')} {j.running && <Loader2 className="size-3 animate-spin" />}</div><div className="text-xs text-muted-foreground mt-1">last {j.lastDurationMs ? `${(j.lastDurationMs / 1000).toFixed(1)}s` : '—'}</div></div>)}</div>
    </CardContent></Card>
  );
}
