import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import type { ActivitySession, DoctorCheck, Frame, JournalDay, LoadedConfig, ModelBootstrapProgress, RuntimeIndexingStatus, RuntimeOverview } from './global';

type Screen = 'home' | 'memories' | 'connect' | 'settings' | 'help';

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
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

/* ===================== ICONS ===================== */
const Icon = {
  home: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12 12 3l9 9"/><path d="M5 10v10a1 1 0 0 0 1 1h3v-6h6v6h3a1 1 0 0 0 1-1V10"/></svg>,
  memories: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.5-3.5L9 20"/></svg>,
  connect: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 7H6a4 4 0 0 0 0 8h3"/><path d="M15 7h3a4 4 0 0 1 0 8h-3"/><line x1="8" y1="11" x2="16" y2="11"/></svg>,
  settings: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  help: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  search: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>,
  brain: <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>,
  check: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
  alert: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
  info: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>,
  cross: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  emptyBox: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="100%" height="100%"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
  copy: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
  folder: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>,
  refresh: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>,
  play: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
  pause: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>,
  stop: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>,
};

/* ===================== APP ===================== */
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

  useEffect(() => { void loadScreen(screen); }, [screen]);

  useEffect(() => {
    const intervalMs = overview?.indexing.running ? 2000 : 5000;
    const timer = window.setInterval(() => {
      if (!window.cofounderos) return;
      void window.cofounderos.getOverview()
        .then(setOverview)
        .catch(() => undefined);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [overview?.indexing.running]);

  async function loadScreen(next: Screen) {
    try {
      if (!window.cofounderos) throw new Error('Desktop preload bridge is unavailable.');
      if (next === 'home') {
        setOverview(await window.cofounderos.getOverview());
        setDoctor(await window.cofounderos.runDoctor());
      }
      if (next === 'memories') {
        const nextDays = await window.cofounderos.listJournalDays();
        setDays(nextDays);
        const day = selectedDay ?? nextDays[nextDays.length - 1] ?? null;
        setSelectedDay(day);
        setJournal(day ? await window.cofounderos.getJournalDay(day) : null);
      }
      if (next === 'connect') {
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

  const captureLive = overview?.capture.running && !overview.capture.paused;
  const capturePaused = overview?.capture.running && overview.capture.paused;
  const footerText = overview?.indexing.running
    ? indexingStatusText(overview.indexing)
    : captureLive ? 'Capturing now' : capturePaused ? 'Capture paused' : 'Not capturing';

  const nav: Array<[Screen, string, React.ReactNode]> = [
    ['home', 'Home', Icon.home],
    ['memories', 'Memories', Icon.memories],
    ['connect', 'Connect AI', Icon.connect],
    ['settings', 'Settings', Icon.settings],
    ['help', 'Help', Icon.help],
  ];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>
          </div>
          <div>
            <div className="brand-name">CofounderOS</div>
            <div className="brand-sub">Your memory, on this device</div>
          </div>
        </div>
        {nav.map(([id, label, icon]) => (
          <button key={id} className={`nav-item ${screen === id ? 'active' : ''}`} onClick={() => setScreen(id)}>
            {icon}
            <span>{label}</span>
          </button>
        ))}
        <div className="sidebar-footer">
          <span className={`dot ${overview?.indexing.running ? 'indexing' : captureLive ? 'live' : capturePaused ? 'paused' : ''}`} />
          <span>{footerText}</span>
        </div>
      </aside>

      <main className="main">
        {error ? (
          <ErrorView error={error} onRetry={() => loadScreen(screen)} />
        ) : screen === 'home' ? (
          <Home
            overview={overview}
            doctor={doctor}
            bootstrapEvents={bootstrapEvents}
            onRefresh={() => loadScreen('home')}
            onStart={async () => setOverview(await window.cofounderos.startRuntime())}
            onStop={async () => { await window.cofounderos.stopRuntime(); setOverview(await window.cofounderos.getOverview().catch(() => null)); }}
            onPause={async () => setOverview(await window.cofounderos.pauseCapture())}
            onResume={async () => setOverview(await window.cofounderos.resumeCapture())}
            onBootstrap={async () => { setBootstrapEvents([]); await window.cofounderos.bootstrapModel(); setDoctor(await window.cofounderos.runDoctor()); }}
            onGoMemories={() => setScreen('memories')}
          />
        ) : screen === 'memories' ? (
          <Memories days={days} selectedDay={selectedDay} journal={journal} onChooseDay={chooseDay} onRefresh={() => loadScreen('memories')} />
        ) : screen === 'connect' ? (
          <Connect overview={overview} config={config} onRefresh={() => loadScreen('connect')} />
        ) : screen === 'settings' ? (
          <Settings config={config} onSaved={setConfig} />
        ) : (
          <Help logs={logs} />
        )}
      </main>
    </div>
  );
}

/* ===================== ERROR ===================== */
function ErrorView({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Something went wrong</h1>
        <p className="page-sub">Don't worry, your memory is safe. Try again or open Help.</p>
      </div>
      <div className="card">
        <div className="toast error">{Icon.alert}<span>{error}</span></div>
        <button className="btn primary" onClick={onRetry}>{Icon.refresh}Try again</button>
      </div>
    </>
  );
}

/* ===================== HOME ===================== */
function Home({
  overview, doctor, bootstrapEvents, onRefresh, onStart, onStop, onPause, onResume, onBootstrap, onGoMemories,
}: {
  overview: RuntimeOverview | null;
  doctor: DoctorCheck[] | null;
  bootstrapEvents: ModelBootstrapProgress[];
  onRefresh: () => void;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onBootstrap: () => Promise<void>;
  onGoMemories: () => void;
}) {
  const [bootstrapping, setBootstrapping] = useState(false);

  if (!overview) {
    return (
      <>
        <div className="page-header">
          <h1 className="page-title">Hello 👋</h1>
          <p className="page-sub">Getting things ready…</p>
        </div>
      </>
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
  let heroIconClass = 'off';

  if (captureLive) {
    heroTitle = "I'm remembering for you";
    heroText = `${formatNumber(overview.capture.eventsToday)} moments captured today. Everything stays on this device.`;
    heroIconClass = '';
  } else if (capturePaused) {
    heroTitle = 'Capture is paused';
    heroText = 'Resume whenever you want to start remembering again.';
  } else if (running) {
    heroTitle = 'Almost ready';
    heroText = 'Press Start to begin capturing your work.';
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Home</h1>
        <p className="page-sub">A simple view of your second brain.</p>
      </div>

      <div className="hero">
        <div className={`hero-icon ${heroIconClass}`}>{Icon.brain}</div>
        <div>
          <h2 className="hero-title">{heroTitle}</h2>
          <p className="hero-text">{heroText}</p>
        </div>
        <div className="hero-actions">
          {!running && <button className="btn accent lg" onClick={() => void onStart()}>{Icon.play}Start</button>}
          {running && captureLive && <button className="btn lg" onClick={() => void onPause()}>{Icon.pause}Pause</button>}
          {running && capturePaused && <button className="btn accent lg" onClick={() => void onResume()}>{Icon.play}Resume</button>}
          {running && <button className="btn ghost" onClick={() => void onStop()}>{Icon.stop}Stop</button>}
        </div>
      </div>

      {overview.indexing.running && (
        <div className="toast indexing">
          <span className="spinner" />
          <span>{indexingStatusText(overview.indexing)}</span>
        </div>
      )}

      {needsModelSetup && (
        <div className="card" style={{ borderColor: 'var(--warn)', background: 'var(--warn-soft)', marginBottom: 32 }}>
          <div className="card-row">
            <div className="card-row-content">
              <h4 style={{ color: 'var(--warn)' }}>Set up your local AI helper</h4>
              <p>One quick step. We'll download a small model so search and summaries work — fully offline.</p>
            </div>
            <button className="btn primary" disabled={bootstrapping} onClick={async () => { setBootstrapping(true); try { await onBootstrap(); } finally { setBootstrapping(false); } }}>
              {bootstrapping ? 'Setting up…' : 'Set up now'}
            </button>
          </div>
          {bootstrapEvents.length > 0 && (
            <div className="progress-list" style={{ marginTop: 16 }}>
              {bootstrapEvents.slice(-5).map((event, i) => (
                <div className="progress-item" key={i}>
                  <span>{bootstrapMessage(event)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="tiles">
        <button className="tile" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={onGoMemories}>
          <div className="tile-label">Captured today</div>
          <div className="tile-value">{formatNumber(overview.capture.eventsToday)}</div>
          <div className="tile-detail">moments saved</div>
        </button>
        <div className="tile">
          <div className="tile-label">Total memories</div>
          <div className="tile-value">{formatNumber(overview.storage.totalEvents)}</div>
          <div className="tile-detail">{formatBytes(overview.storage.totalAssetBytes)} stored locally</div>
        </div>
        <div className="tile">
          <div className="tile-label">
            Organized pages
            {overview.indexing.running ? <span className="status indexing">Indexing</span> : null}
          </div>
          <div className="tile-value">{formatNumber(overview.index.pageCount)}</div>
          <div className="tile-detail">{formatNumber(overview.index.eventsCovered)} memories grouped</div>
        </div>
      </div>

      {(failures.length > 0 || warnings.length > 0) && (
        <div className="section">
          <h3 className="section-title">Things to look at</h3>
          <div className="card">
            {[...failures, ...warnings].slice(0, 5).map((check, i) => (
              <div className="check-item" key={i}>
                <div className={`check-icon ${check.status === 'fail' ? 'bad' : 'warn'}`}>{check.status === 'fail' ? Icon.cross : Icon.alert}</div>
                <div className="check-body">
                  <h4>{check.area}</h4>
                  <p>{check.message}</p>
                  {check.action ? <p className="next">→ {check.action}</p> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="row-actions">
        <button className="btn ghost" onClick={onRefresh}>{Icon.refresh}Refresh</button>
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
  return event.model ?? event.tool ?? event.host ?? event.kind;
}

function indexingStatusText(indexing: RuntimeIndexingStatus): string {
  if (indexing.currentJob === 'index-reorganise') return 'Reorganizing memory index';
  return 'Indexing new memories';
}

/* ===================== MEMORIES ===================== */
function Memories({
  days, selectedDay, journal, onChooseDay, onRefresh,
}: {
  days: string[];
  selectedDay: string | null;
  journal: JournalDay | null;
  onChooseDay: (day: string) => void;
  onRefresh: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedApp, setSelectedApp] = useState('');
  const [searchResults, setSearchResults] = useState<Frame[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const sessions = journal?.sessions ?? [];
  const frames = journal?.frames ?? [];
  const appOptions = useMemo(() => Array.from(new Set(frames.map((f) => f.app).filter(Boolean) as string[])).sort(), [frames]);
  const sessionFrames = selectedSessionId ? frames.filter((f) => f.activity_session_id === selectedSessionId) : [];
  const filteredFrames = frames.filter((f) => !selectedApp || f.app === selectedApp);
  const visibleFrames = searchResults ?? (selectedSessionId ? sessionFrames : filteredFrames);

  async function runSearch() {
    if (!query.trim()) { setSearchResults(null); return; }
    setSearching(true);
    try {
      setSearchResults(await window.cofounderos.searchFrames({
        text: query.trim(),
        day: selectedDay ?? undefined,
        apps: selectedApp ? [selectedApp] : undefined,
        limit: 100,
      }));
    } finally { setSearching(false); }
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Memories</h1>
        <p className="page-sub">Browse and search what you've worked on.</p>
      </div>

      <div className="search-bar">
        <span className="search-icon">{Icon.search}</span>
        <input
          placeholder="Search anything you've seen…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
        />
        {appOptions.length > 0 && (
          <select value={selectedApp} onChange={(e) => { setSelectedApp(e.currentTarget.value); setSearchResults(null); }}>
            <option value="">All apps</option>
            {appOptions.map((app) => <option key={app} value={app}>{app}</option>)}
          </select>
        )}
        <button className="btn primary" onClick={() => void runSearch()} disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
        {(searchResults || query) && (
          <button className="btn ghost" onClick={() => { setQuery(''); setSearchResults(null); }}>Clear</button>
        )}
      </div>

      {days.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">{Icon.emptyBox}</div>
          <h3>No memories yet</h3>
          <p>Start capturing on the Home screen and they'll show up here.</p>
        </div>
      ) : (
        <>
          <div className="day-chips">
            {days.slice(-14).reverse().map((day) => (
              <button key={day} className={`chip ${day === selectedDay ? 'active' : ''}`} onClick={() => { setSelectedSessionId(null); setSearchResults(null); onChooseDay(day); }}>
                {prettyDay(day)}
              </button>
            ))}
          </div>

          {!searchResults && sessions.length > 0 && (
            <div className="section">
              <h3 className="section-title">Work sessions</h3>
              <div className="sessions">
                {sessions.slice(0, 10).map((s, i) => (
                  <SessionCard key={i} session={s} selected={selectedSessionId === s.id} onClick={() => setSelectedSessionId(selectedSessionId === s.id ? null : s.id ?? null)} />
                ))}
              </div>
            </div>
          )}

          <div className="section">
            <h3 className="section-title">{searchResults ? `${searchResults.length} results` : selectedSessionId ? 'In this session' : 'Moments'}</h3>
            {visibleFrames.length === 0 ? (
              <div className="empty">
                <div className="empty-icon">{Icon.search}</div>
                <h3>{searchResults ? 'No matches' : 'Nothing here yet'}</h3>
                <p>{searchResults ? 'Try a different word or pick another day.' : 'Pick a day above to see what you worked on.'}</p>
              </div>
            ) : (
              <div className="moments-grid">
                {visibleFrames.slice(0, 60).map((frame, i) => <MomentCard key={i} frame={frame} />)}
              </div>
            )}
          </div>
        </>
      )}

      <div className="row-actions">
        <button className="btn ghost" onClick={onRefresh}>{Icon.refresh}Refresh</button>
        <button className="btn ghost" onClick={() => void window.cofounderos.openPath('markdown')}>{Icon.folder}Open folder</button>
      </div>
    </>
  );
}

function prettyDay(day: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  try {
    const d = new Date(day + 'T12:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return day;
  }
}

function SessionCard({ session, selected, onClick }: { session: ActivitySession; selected: boolean; onClick: () => void }) {
  const start = (session.started_at || '').slice(11, 16);
  const end = (session.ended_at || '').slice(11, 16);
  return (
    <button className={`session ${selected ? 'selected' : ''}`} onClick={onClick}>
      <div className="session-time">{start}–{end}</div>
      <div className="session-info">
        <h4>{session.primary_entity_path || session.primary_app || 'Mixed work'}</h4>
        <p>{Math.round((session.active_ms || 0) / 60000)} active min · {session.frame_count} moments</p>
      </div>
    </button>
  );
}

function MomentCard({ frame }: { frame: Frame }) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!frame.asset_path) { setThumbUrl(null); return; }
      const cached = thumbnailCache.get(frame.asset_path);
      if (cached) { setThumbUrl(cached); return; }
      try {
        const bytes = await window.cofounderos.readAsset(frame.asset_path);
        if (cancelled) return;
        const type = frame.asset_path.endsWith('.png') ? 'image/png' : frame.asset_path.match(/\.jpe?g$/) ? 'image/jpeg' : 'image/webp';
        const url = URL.createObjectURL(new Blob([bytes], { type }));
        cacheThumbnail(frame.asset_path, url);
        setThumbUrl(url);
      } catch { setThumbUrl(null); }
    }
    void load();
    return () => { cancelled = true; };
  }, [frame.asset_path]);

  return (
    <div className="moment">
      {thumbUrl ? <img className="moment-thumb" src={thumbUrl} alt="" /> : <div className="moment-thumb moment-thumb-empty">No screenshot</div>}
      <div className="moment-body">
        <div className="moment-time">{(frame.timestamp || '').slice(11, 16)}</div>
        <div className="moment-app">{frame.app || 'Unknown app'}</div>
        <div className="moment-text">{frame.window_title || frame.entity_path || frame.url || (frame.text ? String(frame.text).replace(/\s+/g, ' ').slice(0, 120) : 'No details')}</div>
      </div>
    </div>
  );
}

/* ===================== CONNECT ===================== */
function Connect({ overview, config, onRefresh }: { overview: RuntimeOverview | null; config: LoadedConfig | null; onRefresh: () => void }) {
  const [copied, setCopied] = useState(false);

  if (!overview || !config) {
    return (
      <>
        <div className="page-header">
          <h1 className="page-title">Connect AI</h1>
          <p className="page-sub">Loading…</p>
        </div>
      </>
    );
  }

  const mcpConfig = config.config.export.plugins.find((p) => p.name === 'mcp');
  const markdownConfig = config.config.export.plugins.find((p) => p.name === 'markdown');
  const mcpStatus = overview.exports.find((e) => e.name === 'mcp');
  const markdownStatus = overview.exports.find((e) => e.name === 'markdown');
  const host = typeof mcpConfig?.host === 'string' ? mcpConfig.host : '127.0.0.1';
  const port = typeof mcpConfig?.port === 'number' ? mcpConfig.port : 3456;
  const url = `http://${host}:${port}`;
  const snippet = JSON.stringify({ mcpServers: { cofounderos: { url } } }, null, 2);

  async function copySnippet() {
    await window.cofounderos.copyText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Connect AI</h1>
        <p className="page-sub">Let your favorite AI app use your memory.</p>
      </div>

      {copied && <div className="toast">{Icon.check}Copied! Now paste it into your AI app's settings.</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-row">
          <div className="card-row-content">
            <h4>For Cursor, Claude & other AI apps</h4>
            <p>Copy this little snippet and paste it into the app's MCP settings. Your AI can then ask about anything you've worked on.</p>
          </div>
          <span className={`status ${mcpStatus?.running ? 'ok' : ''}`}>{mcpStatus?.running ? 'Running' : 'Ready'}</span>
        </div>
        <div className="code">{snippet}</div>
        <div className="row-actions">
          <button className="btn accent" onClick={() => void copySnippet()}>{Icon.copy}Copy snippet</button>
        </div>
      </div>

      <div className="card">
        <div className="card-row">
          <div className="card-row-content">
            <h4>Read your memory as files</h4>
            <p>A friendly folder of daily journals you can open in Notion, Obsidian, or just Finder.</p>
          </div>
          <span className={`status ${markdownStatus?.running ? 'ok' : ''}`}>{markdownStatus?.running ? 'Running' : 'Ready'}</span>
        </div>
        <p style={{ fontSize: 13, marginTop: 10, color: 'var(--ink-muted)' }}>
          {typeof markdownConfig?.path === 'string' ? markdownConfig.path : '~/.cofounderOS/export/markdown'}
        </p>
        <div className="row-actions">
          <button className="btn" onClick={() => void window.cofounderos.openPath('markdown')}>{Icon.folder}Open folder</button>
        </div>
      </div>

      <div className="row-actions" style={{ marginTop: 24 }}>
        <button className="btn ghost" onClick={onRefresh}>{Icon.refresh}Refresh</button>
      </div>
    </>
  );
}

/* ===================== SETTINGS ===================== */
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

function Settings({ config, onSaved }: { config: LoadedConfig | null; onSaved: (config: LoadedConfig) => void }) {
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [startAtLogin, setStartAtLogin] = useState<boolean | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => { if (config) setDraft(settingsDraftFromConfig(config)); }, [config]);
  useEffect(() => { void window.cofounderos.getStartAtLogin().then(setStartAtLogin).catch(() => setStartAtLogin(false)); }, []);

  if (!config || !draft) {
    return (
      <>
        <div className="page-header">
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">Loading…</p>
        </div>
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
      setMessage({ kind: 'ok', text: 'Saved! Changes apply next time you start.' });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally { setSaving(false); }
  }

  async function toggleStartAtLogin(enabled: boolean) {
    setStartAtLogin(enabled);
    const actual = await window.cofounderos.setStartAtLogin(enabled);
    setStartAtLogin(actual);
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-sub">Make CofounderOS work the way you like.</p>
      </div>

      {message && <div className={`toast ${message.kind === 'error' ? 'error' : ''}`}>{message.kind === 'ok' ? Icon.check : Icon.alert}{message.text}</div>}

      <div className="section">
        <h3 className="section-title">General</h3>
        <div className="card">
          <ToggleRow
            title="Open at startup"
            description="CofounderOS opens quietly in the background when you sign in."
            checked={Boolean(startAtLogin)}
            onChange={(v) => void toggleStartAtLogin(v)}
          />
        </div>
      </div>

      <div className="section">
        <h3 className="section-title">Privacy</h3>
        <div className="card">
          <ToggleRow
            title="Blur password fields"
            description="Skip password boxes so they're never captured."
            checked={draft.blurPasswordFields}
            onChange={(v) => set('blurPasswordFields', v)}
          />
          <ToggleRow
            title="Pause when screen is locked"
            description="Stop capturing when you step away from your computer."
            checked={draft.pauseOnScreenLock}
            onChange={(v) => set('pauseOnScreenLock', v)}
          />
          <div style={{ paddingTop: 18, borderTop: '1px solid var(--line)' }}>
            <div className="field-label">Words to skip</div>
            <textarea className="textarea" value={draft.sensitiveKeywords} onChange={(e) => set('sensitiveKeywords', e.currentTarget.value)} placeholder="One per line — e.g. salary, passport" />
            <div className="field-hint">Anything containing these words won't be saved.</div>
          </div>
        </div>
      </div>

      <div className="section">
        <h3 className="section-title">Storage</h3>
        <div className="card">
          <div className="grid-2">
            <div className="field">
              <div className="field-label">Maximum space (GB)</div>
              <input className="input" type="number" min="1" value={draft.maxSizeGb} onChange={(e) => set('maxSizeGb', Number(e.currentTarget.value))} />
            </div>
            <div className="field">
              <div className="field-label">Keep memories for (days)</div>
              <input className="input" type="number" min="0" value={draft.retentionDays} onChange={(e) => set('retentionDays', Number(e.currentTarget.value))} />
            </div>
          </div>
        </div>
      </div>

      <button className="btn ghost" onClick={() => setShowAdvanced((s) => !s)} style={{ marginBottom: 16 }}>
        {showAdvanced ? '↑ Hide advanced' : '↓ Show advanced settings'}
      </button>

      {showAdvanced && (
        <>
          <div className="section">
            <h3 className="section-title">Apps & URLs to skip</h3>
            <div className="card">
              <div className="grid-2">
                <div className="field">
                  <div className="field-label">Apps to ignore</div>
                  <textarea className="textarea" value={draft.excludedApps} onChange={(e) => set('excludedApps', e.currentTarget.value)} placeholder="One app name per line" />
                </div>
                <div className="field">
                  <div className="field-label">URLs to ignore</div>
                  <textarea className="textarea" value={draft.excludedUrlPatterns} onChange={(e) => set('excludedUrlPatterns', e.currentTarget.value)} placeholder="One pattern per line" />
                </div>
              </div>
            </div>
          </div>

          <div className="section">
            <h3 className="section-title">AI model</h3>
            <div className="card">
              <ToggleRow
                title="Auto-install AI tools when needed"
                description="Lets us set up the local model for you."
                checked={draft.ollamaAutoInstall}
                onChange={(v) => set('ollamaAutoInstall', v)}
              />
              <div className="grid-2" style={{ paddingTop: 18, borderTop: '1px solid var(--line)' }}>
                <div className="field">
                  <div className="field-label">Model</div>
                  <input className="input" value={draft.ollamaModel} onChange={(e) => set('ollamaModel', e.currentTarget.value)} />
                </div>
                <div className="field">
                  <div className="field-label">Host</div>
                  <input className="input" value={draft.ollamaHost} onChange={(e) => set('ollamaHost', e.currentTarget.value)} />
                </div>
              </div>
            </div>
          </div>

          <div className="section">
            <h3 className="section-title">Files & connections</h3>
            <div className="card">
              <div className="grid-2">
                <div className="field">
                  <div className="field-label">Folder for daily journals</div>
                  <input className="input" value={draft.markdownPath} onChange={(e) => set('markdownPath', e.currentTarget.value)} />
                </div>
                <div className="field">
                  <div className="field-label">AI connection port</div>
                  <input className="input" type="number" min="1" value={draft.mcpPort} onChange={(e) => set('mcpPort', Number(e.currentTarget.value))} />
                </div>
              </div>
              <div className="grid-2" style={{ paddingTop: 18, borderTop: '1px solid var(--line)' }}>
                <div className="field">
                  <div className="field-label">Compress old screenshots after (days)</div>
                  <input className="input" type="number" min="0" value={draft.compressAfterDays} onChange={(e) => set('compressAfterDays', Number(e.currentTarget.value))} />
                </div>
                <div className="field">
                  <div className="field-label">Delete old screenshots after (days)</div>
                  <input className="input" type="number" min="0" value={draft.deleteAfterDays} onChange={(e) => set('deleteAfterDays', Number(e.currentTarget.value))} />
                  <div className="field-hint">0 means never delete. Text stays searchable.</div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="row-actions">
        <button className="btn accent lg" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save settings'}</button>
        <button className="btn ghost" onClick={() => void window.cofounderos.openPath('config')}>{Icon.folder}Open config file</button>
        <button className="btn ghost" onClick={() => void window.cofounderos.openPath('data')}>{Icon.folder}Open data folder</button>
      </div>
    </>
  );
}

function ToggleRow({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="toggle-row">
      <div className="toggle-row-label">
        <h4>{title}</h4>
        <p>{description}</p>
      </div>
      <button type="button" className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)} aria-pressed={checked} />
    </div>
  );
}

function settingsDraftFromConfig(loaded: LoadedConfig): SettingsDraft {
  const cfg = loaded.config;
  const markdown = cfg.export.plugins.find((p) => p.name === 'markdown');
  const mcp = cfg.export.plugins.find((p) => p.name === 'mcp');
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
  const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
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

/* ===================== HELP ===================== */
function Help({ logs }: { logs: string }) {
  const [copied, setCopied] = useState(false);

  async function copyDiagnostics() {
    const [overview, checks, config] = await Promise.all([
      window.cofounderos.getOverview(),
      window.cofounderos.runDoctor(),
      window.cofounderos.readConfig(),
    ]);
    const text = [
      '# CofounderOS Diagnostics',
      `Generated: ${new Date().toISOString()}`,
      '',
      `Status: ${overview.status}`,
      `Capture: ${overview.capture.running ? (overview.capture.paused ? 'paused' : 'running') : 'stopped'}`,
      `Today: ${overview.capture.eventsToday} events`,
      `Model: ${overview.model.name} (${overview.model.ready ? 'ready' : 'not ready'})`,
      '',
      '## Checks',
      ...checks.map((c) => `- [${c.status}] ${c.area}: ${c.message}`),
      '',
      '## Logs',
      logs || '(none)',
    ].join('\n');
    await window.cofounderos.copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Help</h1>
        <p className="page-sub">Need a hand? You're in the right place.</p>
      </div>

      {copied && <div className="toast">{Icon.check}Diagnostics copied to clipboard.</div>}

      <div className="section">
        <h3 className="section-title">Quick actions</h3>
        <div className="card">
          <div className="card-row">
            <div className="card-row-content">
              <h4>Copy diagnostics</h4>
              <p>Send this to support and we'll figure things out together.</p>
            </div>
            <button className="btn primary" onClick={() => void copyDiagnostics()}>{Icon.copy}Copy</button>
          </div>
          <div className="card-row">
            <div className="card-row-content">
              <h4>Open data folder</h4>
              <p>See all your memories on disk.</p>
            </div>
            <button className="btn" onClick={() => void window.cofounderos.openPath('data')}>{Icon.folder}Open</button>
          </div>
          <div className="card-row">
            <div className="card-row-content">
              <h4>Open config file</h4>
              <p>For advanced tweaking.</p>
            </div>
            <button className="btn" onClick={() => void window.cofounderos.openPath('config')}>{Icon.folder}Open</button>
          </div>
        </div>
      </div>

      <div className="section">
        <h3 className="section-title">Recent activity</h3>
        <div className="card">
          <pre className="code" style={{ marginTop: 0, maxHeight: 320, overflow: 'auto' }}>{logs || '(no recent activity)'}</pre>
        </div>
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
