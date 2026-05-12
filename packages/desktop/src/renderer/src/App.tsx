import * as React from 'react';
import { AppShell } from '@/components/AppShell';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ErrorView } from '@/components/ErrorView';
import { FrameDetailProvider } from '@/components/FrameDetailDialog';
import { Toaster, toast } from '@/components/ui/sonner';
import { SidebarStateProvider } from '@/lib/sidebar-state';
import { ThemeProvider } from '@/lib/theme';
import { ONBOARDING_KEY, ONBOARDING_MODEL_KEY, ONBOARDING_STEP_KEY, type Screen } from '@/types';
import type { DayEvent, DoctorCheck, LoadedConfig, Meeting, ModelBootstrapProgress, RuntimeOverview } from '@/global';
import '@/lib/thumbnail-cache';

const Connect = React.lazy(() => import('@/screens/Connect').then(m => ({ default: m.Connect })));
const Dashboard = React.lazy(() => import('@/screens/Dashboard').then(m => ({ default: m.Dashboard })));
const Help = React.lazy(() => import('@/screens/Help').then(m => ({ default: m.Help })));
const Search = React.lazy(() => import('@/screens/Search').then(m => ({ default: m.Search })));
const Settings = React.lazy(() => import('@/screens/Settings').then(m => ({ default: m.Settings })));
const Meetings = React.lazy(() => import('@/screens/Meetings').then(m => ({ default: m.Meetings })));
const Privacy = React.lazy(() => import('@/screens/Privacy').then(m => ({ default: m.Privacy })));
const Onboarding = React.lazy(() => import('@/onboarding/Onboarding').then(m => ({ default: m.Onboarding })));

export function App() {
  return <ThemeProvider><SidebarStateProvider><FrameDetailProvider><AppInner /><Toaster /></FrameDetailProvider></SidebarStateProvider></ThemeProvider>;
}

function AppInner() {
  const [screen, setScreen] = React.useState<Screen>('dashboard'), [overview, setOverview] = React.useState<RuntimeOverview | null>(null), [doctor, setDoctor] = React.useState<DoctorCheck[] | null>(null), [days, setDays] = React.useState<string[]>([]), [config, setConfig] = React.useState<LoadedConfig | null>(null), [logs, setLogs] = React.useState(''), [bootstrapEvents, setBootstrapEvents] = React.useState<ModelBootstrapProgress[]>([]), [meetings, setMeetings] = React.useState<Meeting[]>([]), [dayEvents, setDayEvents] = React.useState<DayEvent[]>([]), [meetingsLoading, setMeetingsLoading] = React.useState(false), [meetingFocusRequest, setMeetingFocusRequest] = React.useState<{ id: number; target: { eventId: string; day: string } | null } | null>(null), [error, setError] = React.useState<string | null>(null), [searchRequest, setSearchRequest] = React.useState<{ id: number; query: string } | null>(null);
  const searchRequestId = React.useRef(0), meetingFocusRequestId = React.useRef(0), agendaRefreshKeyRef = React.useRef('');
  const [showOnboarding, setShowOnboarding] = React.useState<boolean>(() => { try { return localStorage.getItem(ONBOARDING_KEY) !== '1'; } catch { return true; } });

  React.useEffect(() => {
    window.cofounderos?.onDesktopLogs?.(l => setLogs(l || ''));
    window.cofounderos?.onBootstrapProgress?.(p => setBootstrapEvents(e => [...e.slice(-80), p]));
    window.cofounderos?.onOverview?.(setOverview);
  }, []);

  React.useEffect(() => { if (!showOnboarding) loadScreen(screen); }, [screen, showOnboarding]);
  React.useEffect(() => { const t = window.setInterval(() => window.cofounderos?.getOverview().then(setOverview).catch(() => {}), 60000); return () => window.clearInterval(t); }, []);

  React.useEffect(() => {
    if (screen !== 'meetings' || !overview) return;
    const k = (overview.backgroundJobs ?? []).filter(j => ['audio-transcript-worker', 'meeting-builder', 'meeting-summarizer', 'event-extractor'].includes(j.name)).map(j => `${j.name}:${j.lastCompletedAt ?? ''}:${j.runCount}`).join('|');
    if (!k || k === agendaRefreshKeyRef.current) return;
    agendaRefreshKeyRef.current = k; loadScreen('meetings');
  }, [screen, overview?.system?.overviewGeneratedAt]);

  const loadScreen = async (n: Screen) => {
    try {
      if (!window.cofounderos) throw new Error('Desktop preload bridge is unavailable.');
      if (n === 'dashboard') { setOverview(await window.cofounderos.getOverview()); setDoctor(await window.cofounderos.runDoctor()); }
      if (n === 'search') setDays(await window.cofounderos.listJournalDays());
      if (n === 'connect') { setOverview(await window.cofounderos.getOverview()); setConfig(await window.cofounderos.readConfig()); }
      if (n === 'meetings') {
        setMeetingsLoading(true);
        try { const [e, m] = await Promise.all([window.cofounderos.listDayEvents().catch(() => []), window.cofounderos.listMeetings().catch(() => [])]); setDayEvents(e); setMeetings(m); }
        finally { setMeetingsLoading(false); }
      }
      if (n === 'privacy') { const [o, c] = await Promise.all([window.cofounderos.getOverview(), window.cofounderos.readConfig()]); setOverview(o); setConfig(c); }
      if (n === 'settings') setConfig(await window.cofounderos.readConfig());
      setError(null);
    } catch (err: any) { setError(err.message || String(err)); }
  };

  const copyMcpSnippet = async () => {
    const c = config ?? (await window.cofounderos.readConfig()); if (!config) setConfig(c);
    const m = c.config.export.plugins.find((p: any) => p.name === 'mcp'), h = typeof m?.host === 'string' ? m.host : '127.0.0.1', pt = typeof m?.port === 'number' ? m.port : 3456;
    await window.cofounderos.copyText(JSON.stringify({ mcpServers: { cofounderos: { url: `http://${h}:${pt}` } } }, null, 2));
    toast.success('MCP snippet copied', { description: 'Paste it into your AI app settings.' });
  };

  const runPaletteSearch = (q: string) => { const t = q.trim(); if (t) { searchRequestId.current++; setSearchRequest({ id: searchRequestId.current, query: t }); setScreen('search'); } };
  const openMeetings = (t: any = null) => { meetingFocusRequestId.current++; setMeetingFocusRequest({ id: meetingFocusRequestId.current, target: t }); setScreen('meetings'); };
  const navigateToScreen = React.useCallback((n: Screen) => setScreen(n), []);

  const wrapAction = (fn: any, successMsg: string, desc?: string) => async (...args: any[]) => { try { const r = await fn(...args); if (r) setOverview(r); toast.success(successMsg, { description: desc }); } catch (e: any) { toast.error(`Could not ${successMsg.toLowerCase()}`, { description: e.message || String(e) }); } };

  const actions = React.useMemo(() => ({
    onStart: wrapAction(window.cofounderos.startRuntime, 'Capture started'),
    onStop: async () => { try { await window.cofounderos.stopRuntime(); setOverview(await window.cofounderos.getOverview().catch(() => null)); toast.info('Capture stopped'); } catch (e: any) { toast.error('Could not stop capture', { description: e.message }); } },
    onPause: async () => { try { setOverview(await window.cofounderos.pauseCapture()); toast.info('Capture paused'); } catch (e: any) { toast.error('Could not pause capture', { description: e.message }); } },
    onResume: wrapAction(window.cofounderos.resumeCapture, 'Capture resumed'),
    onTriggerIndex: wrapAction(window.cofounderos.triggerIndex, 'Organizing memories…', 'This runs in the background.'),
    onTriggerReorganise: wrapAction(window.cofounderos.triggerReorganise, 'Rebuilding summaries…', 'This runs in the background.'),
    onTriggerFullReindex: async (d: string) => { const f = d.trim() ? `${d.trim()}T00:00:00.000` : undefined; if (!f) { toast.error('Choose a date'); return; } toast.info('Re-indexing memory…', { description: `Rebuilding from ${d}.` }); try { setOverview(await window.cofounderos.triggerFullReindex({ from: f })); toast.success('Re-index complete'); } catch (e: any) { toast.error('Could not re-index', { description: e.message }); } },
    onBootstrap: async () => { setBootstrapEvents([]); try { await window.cofounderos.bootstrapModel(); const [o, d] = await Promise.all([window.cofounderos.getOverview(), window.cofounderos.runDoctor()]); setOverview(o); setDoctor(d); toast.success('Local AI is ready'); } catch (e: any) { toast.error('AI setup failed', { description: e.message }); } },
    onOpenMarkdownExport: async (c?: string) => { try { await window.cofounderos.openPath(c ? { target: 'markdown', category: c } : 'markdown'); } catch (e: any) { toast.error('Could not open export', { description: e.message }); } }
  }), []);

  if (showOnboarding) return <React.Suspense fallback={<div className="grid h-screen place-items-center text-sm text-muted-foreground">Preparing welcome…</div>}><Onboarding bootstrapEvents={bootstrapEvents} onClearBootstrapEvents={() => setBootstrapEvents([])} onComplete={() => { try { localStorage.setItem(ONBOARDING_KEY, '1'); localStorage.removeItem(ONBOARDING_STEP_KEY); localStorage.removeItem(ONBOARDING_MODEL_KEY); } catch {} setShowOnboarding(false); setScreen('dashboard'); }} /></React.Suspense>;

  const c = error ? <div className="pt-6"><ErrorView error={error} onRetry={() => loadScreen(screen)} /></div> : screen === 'dashboard' ? <Dashboard overview={overview} doctor={doctor} bootstrapEvents={bootstrapEvents} onRefresh={() => loadScreen('dashboard')} onStart={actions.onStart} onStop={actions.onStop} onPause={actions.onPause} onResume={actions.onResume} onTriggerIndex={actions.onTriggerIndex} onTriggerReorganise={actions.onTriggerReorganise} onTriggerFullReindex={actions.onTriggerFullReindex} onBootstrap={actions.onBootstrap} onOpenMarkdownExport={actions.onOpenMarkdownExport} onGoMeetings={openMeetings} onSearch={runPaletteSearch} /> : screen === 'meetings' ? <Meetings events={dayEvents} meetings={meetings} loading={meetingsLoading} focusRequest={meetingFocusRequest} onRefresh={() => loadScreen('meetings')} /> : screen === 'privacy' ? <Privacy config={config} overview={overview} onRefresh={() => loadScreen('privacy')} onSaved={setConfig} onOverview={setOverview} onStart={actions.onStart} onPause={actions.onPause} onResume={actions.onResume} /> : screen === 'search' ? <Search days={days} searchRequest={searchRequest} /> : screen === 'connect' ? <Connect overview={overview} config={config} onRefresh={() => loadScreen('connect')} /> : screen === 'settings' ? <Settings config={config} overview={overview} bootstrapEvents={bootstrapEvents} onClearBootstrapEvents={() => setBootstrapEvents([])} onSaved={setConfig} /> : <Help logs={logs} onRestartOnboarding={() => { try { localStorage.removeItem(ONBOARDING_KEY); localStorage.removeItem(ONBOARDING_STEP_KEY); localStorage.removeItem(ONBOARDING_MODEL_KEY); } catch {} setShowOnboarding(true); }} />;

  return <AppShell screen={screen} onChange={navigateToScreen} overview={overview} onStart={actions.onStart} onStop={actions.onStop} onPause={actions.onPause} onResume={actions.onResume} onSearch={runPaletteSearch} onTriggerIndex={actions.onTriggerIndex} onTriggerReorganise={actions.onTriggerReorganise} onBootstrap={actions.onBootstrap} onCopyMcpSnippet={copyMcpSnippet}><ErrorBoundary resetKey={screen}><React.Suspense fallback={<div className="grid min-h-[50vh] place-items-center text-sm text-muted-foreground">Loading…</div>}>{c}</React.Suspense></ErrorBoundary></AppShell>;
}
