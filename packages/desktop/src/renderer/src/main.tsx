import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import type { ActivitySession, DoctorCheck, Frame, JournalDay, LoadedConfig, ModelBootstrapProgress, RuntimeOverview } from './global';

type Screen = 'home' | 'setup' | 'journals' | 'search' | 'connections' | 'settings' | 'help';
const THUMBNAIL_CACHE_LIMIT = 80;
const thumbnailCache = new Map<string, string>();

function cacheThumbnail(assetPath: string, url: string): void {
  const existing = thumbnailCache.get(assetPath);
  if (existing) URL.revokeObjectURL(existing);
  thumbnailCache.set(assetPath, url);
  while (thumbnailCache.size > THUMBNAIL_CACHE_LIMIT) {
    const oldest = thumbnailCache.keys().next().value as string | undefined;
    if (!oldest) break;
    const oldestUrl = thumbnailCache.get(oldest);
    if (oldestUrl) URL.revokeObjectURL(oldestUrl);
    thumbnailCache.delete(oldest);
  }
}

window.addEventListener('beforeunload', () => {
  for (const url of thumbnailCache.values()) URL.revokeObjectURL(url);
  thumbnailCache.clear();
});

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

function Pill({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return <span className={`pill ${tone ?? ''}`}>{children}</span>;
}

const NavIcons: Record<Screen, React.ReactNode> = {
  home: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
  setup: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>,
  journals: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>,
  search: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>,
  connections: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
  settings: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  help: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>,
};

function Header({ title, subtitle, children }: { title: string; subtitle: string; children?: React.ReactNode }) {
  return (
    <header>
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className="actions">{children}</div>
    </header>
  );
}

function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [overview, setOverview] = useState<RuntimeOverview | null>(null);
  const [doctor, setDoctor] = useState<DoctorCheck[] | null>(null);
  const [days, setDays] = useState<string[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [journal, setJournal] = useState<JournalDay | null>(null);
  const [config, setConfig] = useState<LoadedConfig | null>(null);
  const [logs, setLogs] = useState('');
  const [bootstrapEvents, setBootstrapEvents] = useState<ModelBootstrapProgress[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.cofounderos?.onDesktopLogs?.((nextLogs) => setLogs(nextLogs || ''));
    window.cofounderos?.onBootstrapProgress?.((progress) => {
      setBootstrapEvents((events) => [...events.slice(-40), progress]);
    });
  }, []);

  useEffect(() => {
    void loadScreen(screen);
  }, [screen]);

  async function loadScreen(next: Screen) {
    try {
      if (!window.cofounderos) {
        throw new Error('Desktop preload bridge is unavailable.');
      }
      if (next === 'home') setOverview(await window.cofounderos.getOverview());
      if (next === 'setup') setDoctor(await window.cofounderos.runDoctor());
      if (next === 'journals') {
        const nextDays = await window.cofounderos.listJournalDays();
        setDays(nextDays);
        const day = selectedDay ?? nextDays[nextDays.length - 1] ?? null;
        setSelectedDay(day);
        setJournal(day ? await window.cofounderos.getJournalDay(day) : null);
      }
      if (next === 'search') {
        setDays(await window.cofounderos.listJournalDays());
      }
      if (next === 'connections') {
        setOverview(await window.cofounderos.getOverview());
        setConfig(await window.cofounderos.readConfig());
      }
      if (next === 'settings') setConfig(await window.cofounderos.readConfig());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function chooseDay(day: string) {
    setSelectedDay(day);
    setJournal(null);
    setJournal(await window.cofounderos.getJournalDay(day));
  }

  async function startRuntime() {
    setOverview(await window.cofounderos.startRuntime());
  }

  async function stopRuntime() {
    await window.cofounderos.stopRuntime();
    setOverview(await window.cofounderos.getOverview().catch(() => null));
  }

  async function pauseCapture() {
    setOverview(await window.cofounderos.pauseCapture());
  }

  async function resumeCapture() {
    setOverview(await window.cofounderos.resumeCapture());
  }

  const nav: Array<[Screen, string]> = [
    ['home', 'Home'],
    ['setup', 'Setup'],
    ['journals', 'Journals'],
    ['search', 'Search'],
    ['connections', 'Connections'],
    ['settings', 'Settings'],
    ['help', 'Help'],
  ];

  return (
    <div className="shell">
      <nav>
        <div className="brand">
          <div className="brand-logo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
          </div>
          CofounderOS
        </div>
        <div className="nav-links">
          {nav.map(([id, label]) => (
            <button key={id} className={`nav-btn ${screen === id ? 'active' : ''}`} onClick={() => setScreen(id)}>
              {NavIcons[id]}
              {label}
            </button>
          ))}
        </div>
      </nav>
      <main>
        {error ? (
          <NeedsAttention error={error} />
        ) : screen === 'home' ? (
          <Home
            overview={overview}
            onRefresh={() => loadScreen('home')}
            onStart={startRuntime}
            onStop={stopRuntime}
            onPauseCapture={pauseCapture}
            onResumeCapture={resumeCapture}
          />
        ) : screen === 'setup' ? (
          <Setup checks={doctor} bootstrapEvents={bootstrapEvents} onRefresh={() => loadScreen('setup')} onBootstrap={async () => {
            setBootstrapEvents([]);
            await window.cofounderos.bootstrapModel();
            setDoctor(await window.cofounderos.runDoctor());
          }} />
        ) : screen === 'journals' ? (
          <Journals days={days} selectedDay={selectedDay} journal={journal} onRefresh={() => loadScreen('journals')} onChooseDay={chooseDay} />
        ) : screen === 'search' ? (
          <Search days={days} />
        ) : screen === 'connections' ? (
          <Connections overview={overview} config={config} onRefresh={() => loadScreen('connections')} />
        ) : screen === 'settings' ? (
          <Settings config={config} onSaved={setConfig} />
        ) : (
          <Help logs={logs} />
        )}
      </main>
    </div>
  );
}

function NeedsAttention({ error }: { error: string }) {
  return (
    <>
      <Header title="Needs Attention" subtitle="Something went wrong." />
      <div className="card">
        <Pill tone="fail">error</Pill>
        <pre>{error}</pre>
      </div>
    </>
  );
}

function Home({
  overview,
  onRefresh,
  onStart,
  onStop,
  onPauseCapture,
  onResumeCapture,
}: {
  overview: RuntimeOverview | null;
  onRefresh: () => void;
  onStart: () => void;
  onStop: () => void;
  onPauseCapture: () => void;
  onResumeCapture: () => void;
}) {
  if (!overview) {
    return (
      <>
        <Header title="Home" subtitle="Checking runtime status..." />
        <div className="empty">Loading status...</div>
      </>
    );
  }
  const running = overview.status === 'running';
  return (
    <>
      <Header title="Home" subtitle="Your local memory system at a glance.">
        <button className="btn primary" onClick={onStart}>{running ? 'Restart runtime' : 'Start runtime'}</button>
        {running ? <button className="btn" onClick={onStop}>Stop runtime</button> : null}
        {running && overview.capture.running ? (
          overview.capture.paused
            ? <button className="btn" onClick={onResumeCapture}>Resume capture</button>
            : <button className="btn" onClick={onPauseCapture}>Pause capture</button>
        ) : null}
        <button className="btn" onClick={onRefresh}>Refresh</button>
      </Header>
      <div className="grid">
        <Stat title="Memory Capture" value={overview.capture.running ? overview.capture.paused ? 'Paused' : 'Running' : 'Stopped'} detail={`${overview.capture.eventsToday} events today`} />
        <Stat title="Local AI Model" value={overview.model.ready ? 'Ready' : 'Needs setup'} detail={overview.model.name} />
        <Stat title="Storage" value={formatBytes(overview.storage.totalAssetBytes)} detail={`${overview.storage.totalEvents.toLocaleString()} events saved`} />
      </div>
      <h2>Memory Organization</h2>
      <div className="grid two">
        <Stat title="Index Pages" value={overview.index.pageCount.toLocaleString()} detail={`${overview.index.eventsCovered.toLocaleString()} events covered`} />
        <div className="card">
          <h3>Exports</h3>
          <div className="list">
            {overview.exports.map((exp) => (
              <div className="row" key={exp.name}>
                <div>{exp.name}</div>
                <Pill tone={exp.running ? 'ok' : undefined}>{exp.running ? 'running' : 'stopped'}</Pill>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="value">{value}</div>
      <p>{detail}</p>
    </div>
  );
}

function Setup({
  checks,
  bootstrapEvents,
  onRefresh,
  onBootstrap,
}: {
  checks: DoctorCheck[] | null;
  bootstrapEvents: ModelBootstrapProgress[];
  onRefresh: () => void;
  onBootstrap: () => Promise<void>;
}) {
  const [bootstrapping, setBootstrapping] = useState(false);
  async function runBootstrap() {
    setBootstrapping(true);
    try {
      await onBootstrap();
    } finally {
      setBootstrapping(false);
    }
  }

  if (!checks) {
    return (
      <>
        <Header title="Setup" subtitle="Checking your machine..." />
        <div className="empty">Running setup checks...</div>
      </>
    );
  }
  const failures = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  return (
    <>
      <Header
        title="Setup"
        subtitle={failures ? 'Some setup steps need attention.' : warnings ? 'CofounderOS can run, with a few warnings.' : 'Everything looks ready.'}
      >
        <button className="btn primary" onClick={() => void runBootstrap()} disabled={bootstrapping}>{bootstrapping ? 'Preparing...' : 'Prepare local AI model'}</button>
        <button className="btn" onClick={onRefresh}>Run checks again</button>
      </Header>
      {bootstrapEvents.length ? (
        <>
          <h2>Model Setup Progress</h2>
          <div className="card progress-card">
            {bootstrapEvents.slice(-10).map((event, index) => (
              <div className="progress-row" key={`${event.kind}-${index}`}>
                <Pill tone={event.kind.includes('failed') ? 'fail' : event.kind === 'ready' || event.kind.includes('done') ? 'ok' : undefined}>{event.kind}</Pill>
                <span>{bootstrapMessage(event)}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
      <div className="list">
        {checks.map((check, index) => (
          <div className="card" key={`${check.area}-${index}`}>
            <div className="row">
              <div>
                <strong>{check.area}</strong>
                <p>{check.message}</p>
                {check.detail ? <p className="muted">{check.detail}</p> : null}
                {check.action ? <p>Next: {check.action}</p> : null}
              </div>
              <Pill tone={check.status === 'ok' ? 'ok' : check.status === 'fail' ? 'fail' : check.status === 'warn' ? 'warn' : undefined}>{check.status}</Pill>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function bootstrapMessage(event: ModelBootstrapProgress): string {
  if (event.message) return event.message;
  if (event.line) return event.line;
  if (event.reason) return event.reason;
  if (event.status && typeof event.completed === 'number' && typeof event.total === 'number' && event.total > 0) {
    return `${event.model ?? 'model'} ${event.status} ${Math.round((event.completed / event.total) * 100)}%`;
  }
  return event.model ?? event.tool ?? event.host ?? '';
}

function Journals({
  days,
  selectedDay,
  journal,
  onRefresh,
  onChooseDay,
}: {
  days: string[];
  selectedDay: string | null;
  journal: JournalDay | null;
  onRefresh: () => void;
  onChooseDay: (day: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedApp, setSelectedApp] = useState('');
  const [searchResults, setSearchResults] = useState<Frame[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const sessions = journal?.sessions ?? [];
  const frames = journal?.frames ?? [];
  const appOptions = Array.from(new Set(frames.map((frame) => frame.app).filter(Boolean) as string[])).sort();
  const sessionFrames = selectedSessionId
    ? frames.filter((frame) => frame.activity_session_id === selectedSessionId)
    : [];
  const filteredFrames = frames.filter((frame) => {
    if (selectedApp && frame.app !== selectedApp) return false;
    return true;
  });
  const visibleFrames = searchResults ?? filteredFrames;

  async function runSearch() {
    if (!query.trim()) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      setSearchResults(await window.cofounderos.searchFrames({
        text: query.trim(),
        day: selectedDay ?? undefined,
        apps: selectedApp ? [selectedApp] : undefined,
        limit: 50,
      }));
    } finally {
      setSearching(false);
    }
  }

  function clearSearch() {
    setQuery('');
    setSearchResults(null);
  }

  return (
    <>
      <Header title="Journals" subtitle="Explore saved work sessions and captured moments.">
        <button className="btn" onClick={() => void window.cofounderos.openPath('markdown')}>Open Markdown Export</button>
        <button className="btn" onClick={onRefresh}>Refresh</button>
      </Header>
      <div className="card toolbar">
        <input placeholder="Search captured moments..." value={query} onChange={(e) => setQuery(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }} />
        <select value={selectedApp} onChange={(e) => { setSelectedApp(e.currentTarget.value); setSearchResults(null); }}>
          <option value="">All apps</option>
          {appOptions.map((app) => <option key={app} value={app}>{app}</option>)}
        </select>
        <button className="btn primary" onClick={() => void runSearch()} disabled={searching}>{searching ? 'Searching...' : 'Search'}</button>
        <button className="btn" onClick={clearSearch}>Clear</button>
      </div>
      {days.length ? (
        <div className="days">
          {days.map((day) => (
            <button key={day} className={`day ${day === selectedDay ? 'active' : ''}`} onClick={() => onChooseDay(day)}>{day}</button>
          ))}
        </div>
      ) : (
        <div className="empty">No journal days found yet.</div>
      )}
      {journal ? (
        <>
          <div className="grid two">
            <Stat title="Selected Day" value={journal.day} detail={`${frames.length} moments captured`} />
            <Stat title="Work Sessions" value={sessions.length.toString()} detail="Grouped by focus and idle gaps" />
          </div>
          <h2>Sessions</h2>
          <SessionList sessions={sessions} selectedSessionId={selectedSessionId} onSelect={setSelectedSessionId} />
          {selectedSessionId ? (
            <>
              <h2>Selected Session</h2>
              <FrameList frames={sessionFrames} />
            </>
          ) : null}
          <h2>{searchResults ? 'Search Results' : selectedApp ? `${selectedApp} Moments` : 'Recent Moments'}</h2>
          <FrameList frames={visibleFrames} />
        </>
      ) : null}
    </>
  );
}

function SessionList({
  sessions,
  selectedSessionId,
  onSelect,
}: {
  sessions: ActivitySession[];
  selectedSessionId: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (!sessions.length) return <div className="empty">No sessions for this day yet.</div>;
  return (
    <div className="list">
      {sessions.slice(0, 20).map((session, index) => (
        <button
          className={`card session-card ${selectedSessionId === session.id ? 'selected' : ''}`}
          key={`${session.started_at}-${index}`}
          onClick={() => onSelect(selectedSessionId === session.id ? null : session.id ?? null)}
        >
          <strong>{(session.started_at || '').slice(11, 16)} - {(session.ended_at || '').slice(11, 16)}</strong>
          <p>{session.primary_entity_path || session.primary_app || 'Unresolved activity'}</p>
          <p className="muted">{Math.round((session.active_ms || 0) / 60000)} active min · {session.frame_count} moments</p>
        </button>
      ))}
    </div>
  );
}

function FrameList({ frames }: { frames: Frame[] }) {
  if (!frames.length) return <div className="empty">No moments for this day.</div>;
  return (
    <div className="list">
      {frames.slice(0, 30).map((frame, index) => (
        <FrameCard frame={frame} key={`${frame.id ?? frame.timestamp}-${index}`} />
      ))}
    </div>
  );
}

function FrameCard({ frame }: { frame: Frame }) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadThumb() {
      if (!frame.asset_path) {
        setThumbUrl(null);
        return;
      }
      const cached = thumbnailCache.get(frame.asset_path);
      if (cached) {
        setThumbUrl(cached);
        return;
      }
      try {
        const bytes = await window.cofounderos.readAsset(frame.asset_path);
        if (cancelled) return;
        const type = frame.asset_path.endsWith('.jpg') || frame.asset_path.endsWith('.jpeg')
          ? 'image/jpeg'
          : frame.asset_path.endsWith('.png')
            ? 'image/png'
            : 'image/webp';
        const url = URL.createObjectURL(new Blob([bytes], { type }));
        cacheThumbnail(frame.asset_path, url);
        setThumbUrl(url);
      } catch {
        setThumbUrl(null);
      }
    }
    void loadThumb();
    return () => {
      cancelled = true;
    };
  }, [frame.asset_path]);

  return (
    <div className="card frame-card">
      {thumbUrl ? <img src={thumbUrl} alt="" /> : <div className="thumb-placeholder">No screenshot</div>}
      <div>
        <strong>{(frame.timestamp || '').slice(11, 19)} · {frame.app || 'Unknown app'}</strong>
        <p>{frame.window_title || '(no title)'}</p>
        {frame.entity_path ? <p className="muted">{frame.entity_path}</p> : null}
        {frame.url ? <p className="muted">{frame.url}</p> : null}
        {frame.text ? <p className="muted">{String(frame.text).replace(/\s+/g, ' ').slice(0, 220)}</p> : null}
      </div>
    </div>
  );
}

function Search({ days }: { days: string[] }) {
  const [query, setQuery] = useState('');
  const [day, setDay] = useState('');
  const [appFilter, setAppFilter] = useState('');
  const [results, setResults] = useState<Frame[] | null>(null);
  const [searching, setSearching] = useState(false);
  const appOptions = Array.from(new Set((results ?? []).map((frame) => frame.app).filter(Boolean) as string[])).sort();
  const visibleResults = (results ?? []).filter((frame) => !appFilter || frame.app === appFilter);

  async function runSearch() {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      setResults(await window.cofounderos.searchFrames({
        text: query.trim(),
        day: day || undefined,
        limit: 100,
      }));
      setAppFilter('');
    } finally {
      setSearching(false);
    }
  }

  return (
    <>
      <Header title="Search" subtitle="Find something you saw across captured moments.">
        <button className="btn primary" disabled={searching} onClick={() => void runSearch()}>{searching ? 'Searching...' : 'Search'}</button>
      </Header>
      <div className="card toolbar">
        <input placeholder="Search text, app names, window titles..." value={query} onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); }} />
        <select value={day} onChange={(event) => setDay(event.currentTarget.value)}>
          <option value="">All days</option>
          {days.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={appFilter} onChange={(event) => setAppFilter(event.currentTarget.value)} disabled={!results?.length}>
          <option value="">All result apps</option>
          {appOptions.map((app) => <option key={app} value={app}>{app}</option>)}
        </select>
        <button className="btn" onClick={() => { setQuery(''); setResults(null); setAppFilter(''); }}>Clear</button>
      </div>
      {results == null ? (
        <div className="empty">Enter a query to search captured moments.</div>
      ) : visibleResults.length ? (
        <>
          <h2>{visibleResults.length} Result{visibleResults.length === 1 ? '' : 's'}</h2>
          <FrameList frames={visibleResults} />
        </>
      ) : (
        <div className="empty">No matching moments found.</div>
      )}
    </>
  );
}

function Connections({
  overview,
  config,
  onRefresh,
}: {
  overview: RuntimeOverview | null;
  config: LoadedConfig | null;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  if (!overview || !config) {
    return (
      <>
        <Header title="Connections" subtitle="Loading connection status..." />
        <div className="empty">Checking exports and AI app connection...</div>
      </>
    );
  }
  const mcpConfig = config.config.export.plugins.find((plugin) => plugin.name === 'mcp');
  const markdownConfig = config.config.export.plugins.find((plugin) => plugin.name === 'markdown');
  const mcpStatus = overview.exports.find((exp) => exp.name === 'mcp');
  const markdownStatus = overview.exports.find((exp) => exp.name === 'markdown');
  const host = typeof mcpConfig?.host === 'string' ? mcpConfig.host : '127.0.0.1';
  const port = typeof mcpConfig?.port === 'number' ? mcpConfig.port : 3456;
  const url = `http://${host}:${port}`;
  const snippet = JSON.stringify({
    mcpServers: {
      cofounderos: { url },
    },
  }, null, 2);

  async function copySnippet() {
    await window.cofounderos.copyText(snippet);
    setCopied('Copied MCP config snippet.');
  }

  return (
    <>
      <Header title="Connections" subtitle="Connect CofounderOS memory to AI apps and local exports.">
        <button className="btn" onClick={onRefresh}>Refresh</button>
      </Header>
      {copied ? <div className="card"><p>{copied}</p></div> : null}
      <div className="grid two">
        <div className="card">
          <div className="row">
            <div>
              <h3>AI App Connection</h3>
              <p>{url}</p>
            </div>
            <Pill tone={mcpStatus?.running ? 'ok' : undefined}>{mcpStatus?.running ? 'running' : 'configured'}</Pill>
          </div>
          <p className="muted">Use this local URL from Cursor, Claude, or any MCP-compatible app.</p>
          <div className="actions inline-action">
            <button className="btn primary" onClick={() => void copySnippet()}>Copy config snippet</button>
            <button className="btn" onClick={() => void window.cofounderos.startRuntime()}>Start connection</button>
          </div>
          <pre>{snippet}</pre>
        </div>
        <div className="card">
          <div className="row">
            <div>
              <h3>Markdown Export</h3>
              <p>{typeof markdownConfig?.path === 'string' ? markdownConfig.path : '~/.cofounderOS/export/markdown'}</p>
            </div>
            <Pill tone={markdownStatus?.running ? 'ok' : undefined}>{markdownStatus?.running ? 'running' : 'configured'}</Pill>
          </div>
          <p className="muted">A readable folder of exported pages and daily journals.</p>
          <button className="btn inline-action" onClick={() => void window.cofounderos.openPath('markdown')}>Open Markdown export</button>
        </div>
      </div>
    </>
  );
}

function Settings({ config, onSaved }: { config: LoadedConfig | null; onSaved: (config: LoadedConfig) => void }) {
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [startAtLogin, setStartAtLogin] = useState<boolean | null>(null);

  useEffect(() => {
    if (config) setDraft(settingsDraftFromConfig(config));
  }, [config]);

  useEffect(() => {
    void window.cofounderos.getStartAtLogin()
      .then(setStartAtLogin)
      .catch(() => setStartAtLogin(false));
  }, []);

  if (!config) {
    return (
      <>
        <Header title="Settings" subtitle="Loading configuration..." />
        <div className="empty">Reading config...</div>
      </>
    );
  }
  if (!draft) {
    return (
      <>
        <Header title="Settings" subtitle="Preparing settings..." />
        <div className="empty">Loading controls...</div>
      </>
    );
  }

  const set = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => {
    setDraft({ ...draft, [key]: value });
    setMessage(null);
  };

  async function save() {
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    try {
      const next = await window.cofounderos.saveConfigPatch(configPatchFromDraft(draft));
      onSaved(next);
      setMessage('Saved. Runtime was stopped so changes apply on next start.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleStartAtLogin(enabled: boolean) {
    setStartAtLogin(enabled);
    const actual = await window.cofounderos.setStartAtLogin(enabled);
    setStartAtLogin(actual);
  }

  return (
    <>
      <Header title="Settings" subtitle="Update common configuration without editing YAML.">
        <button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save settings'}</button>
      </Header>
      {message ? <div className="card"><p>{message}</p></div> : null}
      <div className="grid two">
        <div className="card">
          <h3>Config File</h3>
          <p>{config.sourcePath}</p>
          <button className="btn inline-action" onClick={() => void window.cofounderos.openPath('config')}>Open config</button>
        </div>
        <div className="card">
          <h3>Data Folder</h3>
          <p>{config.dataDir}</p>
          <button className="btn inline-action" onClick={() => void window.cofounderos.openPath('data')}>Open data folder</button>
        </div>
      </div>
      <h2>Desktop App</h2>
      <div className="card">
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(startAtLogin)}
            onChange={(e) => void toggleStartAtLogin(e.currentTarget.checked)}
          />
          Start CofounderOS when I sign in
        </label>
        <p className="muted">The app opens in the background and keeps memory capture available from the tray.</p>
      </div>
      <h2>Privacy</h2>
      <div className="grid two">
        <div className="card">
          <label className="check"><input type="checkbox" checked={draft.blurPasswordFields} onChange={(e) => set('blurPasswordFields', e.currentTarget.checked)} /> Blur password fields</label>
          <label className="check"><input type="checkbox" checked={draft.pauseOnScreenLock} onChange={(e) => set('pauseOnScreenLock', e.currentTarget.checked)} /> Pause when screen locks</label>
        </div>
        <div className="card">
          <Field label="Sensitive keywords" hint="One per line. Lines containing these words are redacted.">
            <textarea value={draft.sensitiveKeywords} onChange={(e) => set('sensitiveKeywords', e.currentTarget.value)} />
          </Field>
        </div>
      </div>
      <h2>Capture Filters</h2>
      <div className="grid two">
        <Field label="Excluded apps" hint="One app name per line.">
          <textarea value={draft.excludedApps} onChange={(e) => set('excludedApps', e.currentTarget.value)} />
        </Field>
        <Field label="Excluded URL patterns" hint="One pattern per line.">
          <textarea value={draft.excludedUrlPatterns} onChange={(e) => set('excludedUrlPatterns', e.currentTarget.value)} />
        </Field>
      </div>
      <h2>Storage</h2>
      <div className="grid two">
        <Field label="Max storage size (GB)">
          <input type="number" min="1" value={draft.maxSizeGb} onChange={(e) => set('maxSizeGb', Number(e.currentTarget.value))} />
        </Field>
        <Field label="Retention days">
          <input type="number" min="0" value={draft.retentionDays} onChange={(e) => set('retentionDays', Number(e.currentTarget.value))} />
        </Field>
        <Field label="Compress screenshots after days">
          <input type="number" min="0" value={draft.compressAfterDays} onChange={(e) => set('compressAfterDays', Number(e.currentTarget.value))} />
        </Field>
        <Field label="Delete screenshot assets after days" hint="Metadata and extracted text remain searchable. 0 disables deletion.">
          <input type="number" min="0" value={draft.deleteAfterDays} onChange={(e) => set('deleteAfterDays', Number(e.currentTarget.value))} />
        </Field>
      </div>
      <h2>Local AI Model</h2>
      <div className="grid two">
        <Field label="Ollama model">
          <input value={draft.ollamaModel} onChange={(e) => set('ollamaModel', e.currentTarget.value)} />
        </Field>
        <Field label="Ollama host">
          <input value={draft.ollamaHost} onChange={(e) => set('ollamaHost', e.currentTarget.value)} />
        </Field>
        <div className="card">
          <label className="check"><input type="checkbox" checked={draft.ollamaAutoInstall} onChange={(e) => set('ollamaAutoInstall', e.currentTarget.checked)} /> Auto-install local model tools when needed</label>
        </div>
      </div>
      <h2>Exports And AI Connection</h2>
      <div className="grid two">
        <Field label="Markdown export path">
          <input value={draft.markdownPath} onChange={(e) => set('markdownPath', e.currentTarget.value)} />
        </Field>
        <Field label="AI connection port">
          <input type="number" min="1" value={draft.mcpPort} onChange={(e) => set('mcpPort', Number(e.currentTarget.value))} />
        </Field>
      </div>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field card">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

interface SettingsDraft {
  blurPasswordFields: boolean;
  pauseOnScreenLock: boolean;
  sensitiveKeywords: string;
  excludedApps: string;
  excludedUrlPatterns: string;
  maxSizeGb: number;
  retentionDays: number;
  compressAfterDays: number;
  deleteAfterDays: number;
  ollamaModel: string;
  ollamaHost: string;
  ollamaAutoInstall: boolean;
  markdownPath: string;
  mcpPort: number;
}

function settingsDraftFromConfig(loaded: LoadedConfig): SettingsDraft {
  const cfg = loaded.config;
  const markdown = cfg.export.plugins.find((plugin) => plugin.name === 'markdown');
  const mcp = cfg.export.plugins.find((plugin) => plugin.name === 'mcp');
  return {
    blurPasswordFields: cfg.capture.privacy.blur_password_fields,
    pauseOnScreenLock: cfg.capture.privacy.pause_on_screen_lock,
    sensitiveKeywords: cfg.capture.privacy.sensitive_keywords.join('\n'),
    excludedApps: cfg.capture.excluded_apps.join('\n'),
    excludedUrlPatterns: cfg.capture.excluded_url_patterns.join('\n'),
    maxSizeGb: cfg.storage.local.max_size_gb,
    retentionDays: cfg.storage.local.retention_days,
    compressAfterDays: cfg.storage.local.vacuum.compress_after_days,
    deleteAfterDays: cfg.storage.local.vacuum.delete_after_days,
    ollamaModel: cfg.index.model.ollama?.model ?? '',
    ollamaHost: cfg.index.model.ollama?.host ?? '',
    ollamaAutoInstall: cfg.index.model.ollama?.auto_install ?? true,
    markdownPath: typeof markdown?.path === 'string' ? markdown.path : '',
    mcpPort: typeof mcp?.port === 'number' ? mcp.port : 3456,
  };
}

function configPatchFromDraft(draft: SettingsDraft) {
  return {
    capture: {
      excluded_apps: lines(draft.excludedApps),
      excluded_url_patterns: lines(draft.excludedUrlPatterns),
      privacy: {
        blur_password_fields: draft.blurPasswordFields,
        pause_on_screen_lock: draft.pauseOnScreenLock,
        sensitive_keywords: lines(draft.sensitiveKeywords),
      },
    },
    storage: {
      local: {
        max_size_gb: draft.maxSizeGb,
        retention_days: draft.retentionDays,
        vacuum: {
          compress_after_days: draft.compressAfterDays,
          delete_after_days: draft.deleteAfterDays,
        },
      },
    },
    index: {
      model: {
        plugin: 'ollama',
        ollama: {
          model: draft.ollamaModel.trim(),
          host: draft.ollamaHost.trim(),
          auto_install: draft.ollamaAutoInstall,
        },
      },
    },
    export: {
      plugins: [
        { name: 'markdown', path: draft.markdownPath.trim() },
        { name: 'mcp', host: '127.0.0.1', port: draft.mcpPort },
      ],
    },
  };
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function Help({ logs }: { logs: string }) {
  const [message, setMessage] = useState<string | null>(null);

  async function copyDiagnostics() {
    const [overview, checks, config] = await Promise.all([
      window.cofounderos.getOverview(),
      window.cofounderos.runDoctor(),
      window.cofounderos.readConfig(),
    ]);
    const text = [
      '# CofounderOS Diagnostics',
      '',
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Runtime',
      `status: ${overview.status}`,
      `config: ${overview.configPath}`,
      `data: ${overview.dataDir}`,
      `storage: ${overview.storageRoot}`,
      '',
      '## Capture',
      `running: ${overview.capture.running}`,
      `paused: ${overview.capture.paused}`,
      `eventsToday: ${overview.capture.eventsToday}`,
      '',
      '## Model',
      `name: ${overview.model.name}`,
      `ready: ${overview.model.ready}`,
      '',
      '## Exports',
      ...overview.exports.map((exp) => `- ${exp.name}: ${exp.running ? 'running' : 'stopped'}`),
      '',
      '## Doctor Checks',
      ...checks.map((check) => `- [${check.status}] ${check.area}: ${check.message}${check.detail ? ` (${check.detail})` : ''}`),
      '',
      '## Config Paths',
      `sourcePath: ${config.sourcePath}`,
      `dataDir: ${config.dataDir}`,
      '',
      '## Desktop Logs',
      logs || '(no desktop logs)',
      '',
    ].join('\n');
    await window.cofounderos.copyText(text);
    setMessage('Diagnostics copied to clipboard.');
  }

  return (
    <>
      <Header title="Help" subtitle="Diagnostics and local paths." />
      {message ? <div className="card"><p>{message}</p></div> : null}
      <div className="grid two">
        <div className="card"><h3>Runtime Logs</h3><pre>{logs || '(no desktop logs yet)'}</pre></div>
        <div className="card">
          <h3>Quick Actions</h3>
          <div className="actions vertical">
            <button className="btn primary" onClick={() => void copyDiagnostics()}>Copy diagnostics</button>
            <button className="btn" onClick={() => void window.cofounderos.openPath('config')}>Open config</button>
            <button className="btn" onClick={() => void window.cofounderos.openPath('data')}>Open data folder</button>
            <button className="btn" onClick={() => void window.cofounderos.openPath('markdown')}>Open Markdown export</button>
          </div>
          <p>Use Setup when something needs attention. Use Journals to browse captured work sessions.</p>
        </div>
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
