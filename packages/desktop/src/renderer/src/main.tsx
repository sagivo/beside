import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import type { ActivitySession, DoctorCheck, Frame, JournalDay, LoadedConfig, ModelBootstrapProgress, RuntimeIndexingStatus, RuntimeOverview } from './global';

type Screen = 'home' | 'memories' | 'connect' | 'settings' | 'help';

const ONBOARDING_KEY = 'cofounderos:onboarded';

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
  shield: <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>,
  lock: <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
  cpu: <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="2" x2="9" y2="4"/><line x1="15" y1="2" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="22"/><line x1="15" y1="20" x2="15" y2="22"/><line x1="20" y1="9" x2="22" y2="9"/><line x1="20" y1="15" x2="22" y2="15"/><line x1="2" y1="9" x2="4" y2="9"/><line x1="2" y1="15" x2="4" y2="15"/></svg>,
  download: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  arrowRight: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>,
  arrowLeft: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>,
  sparkles: <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1"/></svg>,
  eye: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  layers: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>,
  bolt: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  rocket: <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>,
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
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => {
    try { return localStorage.getItem(ONBOARDING_KEY) !== '1'; } catch { return true; }
  });

  useEffect(() => {
    window.cofounderos?.onDesktopLogs?.((nextLogs) => setLogs(nextLogs || ''));
    window.cofounderos?.onBootstrapProgress?.((progress) => {
      setBootstrapEvents((events) => [...events.slice(-80), progress]);
    });
  }, []);

  useEffect(() => { if (!showOnboarding) void loadScreen(screen); }, [screen, showOnboarding]);

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

  if (showOnboarding) {
    return (
      <Onboarding
        bootstrapEvents={bootstrapEvents}
        onClearBootstrapEvents={() => setBootstrapEvents([])}
        onComplete={() => {
          try { localStorage.setItem(ONBOARDING_KEY, '1'); } catch { /* ignore */ }
          setShowOnboarding(false);
          setScreen('home');
        }}
      />
    );
  }

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
            onTriggerIndex={async () => setOverview(await window.cofounderos.triggerIndex())}
            onTriggerReorganise={async () => setOverview(await window.cofounderos.triggerReorganise())}
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
          <Help
            logs={logs}
            onRestartOnboarding={() => {
              try { localStorage.removeItem(ONBOARDING_KEY); } catch { /* ignore */ }
              setShowOnboarding(true);
            }}
          />
        )}
      </main>
    </div>
  );
}

/* ===================== ONBOARDING ===================== */
type OnboardingStep =
  | 'welcome'
  | 'how-it-works'
  | 'privacy'
  | 'choose-model'
  | 'install-model'
  | 'first-capture'
  | 'first-search'
  | 'done';

const ONBOARDING_STEPS: OnboardingStep[] = [
  'welcome',
  'how-it-works',
  'privacy',
  'choose-model',
  'install-model',
  'first-capture',
  'first-search',
  'done',
];

interface ModelChoice {
  id: string;
  name: string;
  vendor: string;
  size: string;
  bytes: number;
  description: string;
  badge?: string;
}

const MODEL_CHOICES: ModelChoice[] = [
  {
    id: 'gemma2:2b',
    name: 'Gemma 2 · 2B',
    vendor: 'Google',
    size: '~1.6 GB',
    bytes: 1.6 * 1024 ** 3,
    description: 'Fast and lightweight. Great default for everyday work.',
    badge: 'Recommended',
  },
  {
    id: 'gemma3:4b',
    name: 'Gemma 3 · 4B',
    vendor: 'Google',
    size: '~3.3 GB',
    bytes: 3.3 * 1024 ** 3,
    description: 'Smarter answers. A bit larger and slower.',
  },
  {
    id: 'gemma2:9b',
    name: 'Gemma 2 · 9B',
    vendor: 'Google',
    size: '~5.4 GB',
    bytes: 5.4 * 1024 ** 3,
    description: 'Most capable. Needs a beefier Mac/PC and more disk.',
  },
];

function Onboarding({
  bootstrapEvents,
  onClearBootstrapEvents,
  onComplete,
}: {
  bootstrapEvents: ModelBootstrapProgress[];
  onClearBootstrapEvents: () => void;
  onComplete: () => void;
}) {
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [chosenModel, setChosenModel] = useState<string>(MODEL_CHOICES[0]!.id);
  const [overview, setOverview] = useState<RuntimeOverview | null>(null);

  // Pause capture during onboarding so we don't record anything before the
  // user explicitly opts in. We resume on the "first capture" step.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const initial = await window.cofounderos?.getOverview();
        if (cancelled || !initial) return;
        setOverview(initial);
        if (initial.capture.running && !initial.capture.paused) {
          try { await window.cofounderos.pauseCapture(); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Live overview polling while onboarding is active.
  useEffect(() => {
    const timer = window.setInterval(async () => {
      try {
        const next = await window.cofounderos?.getOverview();
        if (next) setOverview(next);
      } catch { /* ignore */ }
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

  const stepIndex = ONBOARDING_STEPS.indexOf(step);
  const progressPct = Math.round(((stepIndex + 1) / ONBOARDING_STEPS.length) * 100);

  function go(next: OnboardingStep) {
    setStep(next);
  }
  function goNext() {
    const idx = ONBOARDING_STEPS.indexOf(step);
    if (idx >= 0 && idx < ONBOARDING_STEPS.length - 1) go(ONBOARDING_STEPS[idx + 1]!);
  }
  function goBack() {
    const idx = ONBOARDING_STEPS.indexOf(step);
    if (idx > 0) go(ONBOARDING_STEPS[idx - 1]!);
  }

  async function finish() {
    // Resume capture if it isn't already running, then close onboarding.
    try {
      const final = await window.cofounderos?.getOverview();
      if (final?.capture.running && final.capture.paused) {
        await window.cofounderos.resumeCapture();
      }
    } catch { /* ignore */ }
    onComplete();
  }

  return (
    <div className="onboarding">
      <header className="onboarding-header">
        <div className="onboarding-brand">
          <div className="brand-mark">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>
          </div>
          <span>CofounderOS</span>
        </div>
        <div className="onboarding-progress" aria-hidden>
          <div className="onboarding-progress-bar" style={{ width: `${progressPct}%` }} />
        </div>
        {step !== 'done' && (
          <button className="onboarding-skip" onClick={onComplete}>Skip setup</button>
        )}
      </header>

      <div className="onboarding-body">
        {step === 'welcome' && <WelcomeStep onContinue={goNext} />}
        {step === 'how-it-works' && <HowItWorksStep onContinue={goNext} onBack={goBack} />}
        {step === 'privacy' && <PrivacyStep onContinue={goNext} onBack={goBack} />}
        {step === 'choose-model' && (
          <ChooseModelStep
            chosenModel={chosenModel}
            onChoose={setChosenModel}
            onContinue={goNext}
            onBack={goBack}
          />
        )}
        {step === 'install-model' && (
          <InstallModelStep
            chosenModel={chosenModel}
            bootstrapEvents={bootstrapEvents}
            modelReady={overview?.model.ready ?? false}
            onClearEvents={onClearBootstrapEvents}
            onContinue={goNext}
            onBack={goBack}
          />
        )}
        {step === 'first-capture' && (
          <FirstCaptureStep
            overview={overview}
            onContinue={goNext}
            onBack={goBack}
          />
        )}
        {step === 'first-search' && (
          <FirstSearchStep
            onContinue={goNext}
            onBack={goBack}
          />
        )}
        {step === 'done' && <DoneStep onFinish={finish} />}
      </div>
    </div>
  );
}

function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="onb-card onb-card-hero">
      <div className="onb-hero-icon">{Icon.brain}</div>
      <h1 className="onb-title">Meet your second brain</h1>
      <p className="onb-lede">
        CofounderOS quietly remembers what you do on your computer — apps, docs, browsers — and turns
        it into a private, searchable memory you can ask anything.
      </p>
      <div className="onb-pill-row">
        <span className="onb-pill"><span className="onb-pill-icon">{Icon.lock}</span>100% local</span>
        <span className="onb-pill"><span className="onb-pill-icon">{Icon.shield}</span>No cloud</span>
        <span className="onb-pill"><span className="onb-pill-icon">{Icon.bolt}</span>No subscription</span>
      </div>
      <div className="onb-actions">
        <button className="btn accent lg" onClick={onContinue}>Get started{Icon.arrowRight}</button>
      </div>
      <p className="onb-fineprint">Takes about 2 minutes. We'll set up a small AI helper that runs on your Mac.</p>
    </div>
  );
}

function HowItWorksStep({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }) {
  const items: Array<{ icon: React.ReactNode; title: string; body: string }> = [
    {
      icon: Icon.eye,
      title: 'It watches what you work on',
      body: 'Every few seconds, CofounderOS notes the active app, window title, URL, and takes a small screenshot — only when something actually changed.',
    },
    {
      icon: Icon.layers,
      title: 'It organizes everything for you',
      body: 'A local AI builds a tidy wiki of your work — projects, people, decisions — that updates itself in the background.',
    },
    {
      icon: Icon.search,
      title: 'You can ask anything',
      body: 'Search "what was I doing yesterday afternoon?" or hand the memory to your favorite AI app (Cursor, Claude, ChatGPT) and let it answer for you.',
    },
  ];
  return (
    <div className="onb-card">
      <div className="onb-step-eyebrow">How it works</div>
      <h1 className="onb-title">Three quiet superpowers</h1>
      <div className="onb-list">
        {items.map((it, i) => (
          <div className="onb-list-item" key={i}>
            <div className="onb-list-icon">{it.icon}</div>
            <div>
              <h3>{it.title}</h3>
              <p>{it.body}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="onb-actions">
        <button className="btn ghost" onClick={onBack}>{Icon.arrowLeft}Back</button>
        <button className="btn accent lg" onClick={onContinue}>Continue{Icon.arrowRight}</button>
      </div>
    </div>
  );
}

function PrivacyStep({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }) {
  const promises: Array<{ icon: React.ReactNode; title: string; body: string }> = [
    {
      icon: Icon.lock,
      title: 'Stays on your computer — always',
      body: 'Screenshots, notes, and the search index are stored only on this Mac. Nothing is uploaded, ever.',
    },
    {
      icon: Icon.cpu,
      title: 'The AI runs locally too',
      body: 'We use a small open-source model (Google Gemma) that runs on your hardware. Your prompts never reach OpenAI, Google, Anthropic, or anyone else.',
    },
    {
      icon: Icon.shield,
      title: 'No telemetry, no accounts, no cost',
      body: 'No analytics. No usage tracking. No sign-up. CofounderOS is open source — you can read every line.',
    },
    {
      icon: Icon.eye,
      title: 'You\'re always in control',
      body: 'Pause capture anytime from the menu bar. Tell us which apps to ignore. Set sensitive keywords to skip. Delete everything in one click.',
    },
  ];
  return (
    <div className="onb-card">
      <div className="onb-step-eyebrow">Your privacy</div>
      <h1 className="onb-title">Your memory never leaves this device</h1>
      <p className="onb-lede">
        Privacy isn't a setting we added later — it's the whole reason CofounderOS exists. Read this carefully:
      </p>
      <div className="onb-promises">
        {promises.map((p, i) => (
          <div className="onb-promise" key={i}>
            <div className="onb-promise-icon">{p.icon}</div>
            <div>
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="onb-actions">
        <button className="btn ghost" onClick={onBack}>{Icon.arrowLeft}Back</button>
        <button className="btn accent lg" onClick={onContinue}>Sounds good{Icon.arrowRight}</button>
      </div>
    </div>
  );
}

function ChooseModelStep({
  chosenModel, onChoose, onContinue, onBack,
}: {
  chosenModel: string;
  onChoose: (id: string) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  return (
    <div className="onb-card">
      <div className="onb-step-eyebrow">Choose your local AI</div>
      <h1 className="onb-title">Pick a model to run on your computer</h1>
      <p className="onb-lede">
        We'll use <strong>Ollama</strong> (a free, open-source tool) to run the model offline. The smaller the model, the
        faster it runs and the less disk it uses.
      </p>
      <div className="onb-model-list">
        {MODEL_CHOICES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`onb-model ${chosenModel === m.id ? 'selected' : ''}`}
            onClick={() => onChoose(m.id)}
          >
            <div className="onb-model-radio">
              <span className="onb-radio">{chosenModel === m.id && <span className="onb-radio-dot" />}</span>
            </div>
            <div className="onb-model-content">
              <div className="onb-model-head">
                <span className="onb-model-name">{m.name}</span>
                {m.badge && <span className="onb-badge">{m.badge}</span>}
                <span className="onb-model-vendor">{m.vendor}</span>
              </div>
              <p className="onb-model-desc">{m.description}</p>
              <div className="onb-model-meta">
                <span>{Icon.download}{m.size} download</span>
                <span>{Icon.lock}Runs locally</span>
                <span>{Icon.bolt}Free, no cloud</span>
              </div>
            </div>
          </button>
        ))}
      </div>
      <div className="onb-info-line">
        You can switch models later in Settings. If a download fails, CofounderOS falls back to a simple offline indexer so
        you can keep working.
      </div>
      <div className="onb-actions">
        <button className="btn ghost" onClick={onBack}>{Icon.arrowLeft}Back</button>
        <button className="btn accent lg" onClick={onContinue}>Continue{Icon.arrowRight}</button>
      </div>
    </div>
  );
}

function InstallModelStep({
  chosenModel,
  bootstrapEvents,
  modelReady,
  onClearEvents,
  onContinue,
  onBack,
}: {
  chosenModel: string;
  bootstrapEvents: ModelBootstrapProgress[];
  modelReady: boolean;
  onClearEvents: () => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [autoStarted, setAutoStarted] = useState(false);

  const choice = MODEL_CHOICES.find((m) => m.id === chosenModel) ?? MODEL_CHOICES[0]!;

  // Auto-start the install once we hit this step.
  useEffect(() => {
    if (autoStarted) return;
    setAutoStarted(true);
    void runInstall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror server "ready" reports into our local phase, in case events
  // arrive but `modelReady` lags behind the runtime overview poll.
  useEffect(() => {
    if (modelReady && phase === 'running') setPhase('done');
  }, [modelReady, phase]);

  // If we see a terminal failure event, surface it.
  useEffect(() => {
    for (let i = bootstrapEvents.length - 1; i >= 0; i--) {
      const ev = bootstrapEvents[i]!;
      if (ev.kind === 'install_failed' || ev.kind === 'pull_failed' || ev.kind === 'server_failed') {
        if (phase !== 'error') {
          setPhase('error');
          setErrorMessage(ev.reason || `${ev.kind} failed`);
        }
        return;
      }
      if (ev.kind === 'ready') {
        if (phase !== 'done') setPhase('done');
        return;
      }
    }
  }, [bootstrapEvents, phase]);

  async function runInstall(): Promise<void> {
    if (phase === 'running') return;
    setErrorMessage(null);
    onClearEvents();
    setPhase('running');
    try {
      // Persist the chosen model so bootstrap pulls the right weights.
      await window.cofounderos.saveConfigPatch({
        index: {
          model: {
            plugin: 'ollama',
            ollama: {
              model: choice.id,
              auto_install: true,
            },
          },
        },
      });
      await window.cofounderos.bootstrapModel();
      setPhase('done');
    } catch (err) {
      setPhase('error');
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  // Render the most recent download progress event for a live bar.
  const lastPullProgress = useMemo(() => {
    for (let i = bootstrapEvents.length - 1; i >= 0; i--) {
      const ev = bootstrapEvents[i]!;
      if (ev.kind === 'pull_progress' && typeof ev.completed === 'number' && typeof ev.total === 'number') {
        return ev;
      }
    }
    return null;
  }, [bootstrapEvents]);

  const phasesShown = useMemo(() => buildInstallPhases(bootstrapEvents), [bootstrapEvents]);

  return (
    <div className="onb-card">
      <div className="onb-step-eyebrow">Setting up your local AI</div>
      <h1 className="onb-title">
        {phase === 'done' ? 'Your AI is ready'
          : phase === 'error' ? 'Setup ran into a snag'
          : `Installing ${choice.name}`}
      </h1>
      <p className="onb-lede">
        {phase === 'done'
          ? 'Everything is installed and running on your computer. Time to capture your first moment.'
          : phase === 'error'
            ? "We couldn't finish the install. You can retry, or skip the AI and use the simple offline indexer for now."
            : "This is a one-time install. Nothing is uploaded — we're downloading the model directly to your computer."}
      </p>

      <div className="onb-install">
        {phasesShown.map((p) => (
          <div className={`onb-install-row ${p.state}`} key={p.id}>
            <div className="onb-install-icon">
              {p.state === 'done'
                ? <span className="onb-check">{Icon.check}</span>
                : p.state === 'active'
                  ? <span className="onb-spin"><span className="spinner" /></span>
                  : p.state === 'error'
                    ? <span className="onb-cross">{Icon.cross}</span>
                    : <span className="onb-pending" />}
            </div>
            <div className="onb-install-content">
              <div className="onb-install-title">{p.title}</div>
              {p.detail && <div className="onb-install-detail">{p.detail}</div>}
              {p.id === 'pull' && p.state === 'active' && lastPullProgress && (
                <div className="onb-bar">
                  <div className="onb-bar-track">
                    <div
                      className="onb-bar-fill"
                      style={{ width: `${pullPercent(lastPullProgress)}%` }}
                    />
                  </div>
                  <div className="onb-bar-meta">
                    <span>{lastPullProgress.status || 'downloading'}</span>
                    <span>
                      {formatBytes((lastPullProgress.completed as number) || 0)}
                      {' / '}
                      {formatBytes((lastPullProgress.total as number) || 0)}
                      {' · '}
                      {pullPercent(lastPullProgress)}%
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {errorMessage && (
        <div className="toast error" style={{ marginTop: 18 }}>
          {Icon.alert}<span>{errorMessage}</span>
        </div>
      )}

      <details className="onb-log-details">
        <summary>Show technical log</summary>
        <pre className="code onb-log">
          {bootstrapEvents.length === 0
            ? '(waiting for bootstrap to begin…)'
            : bootstrapEvents.slice(-25).map(formatBootstrapLine).join('\n')}
        </pre>
      </details>

      <div className="onb-actions">
        <button className="btn ghost" onClick={onBack} disabled={phase === 'running'}>{Icon.arrowLeft}Back</button>
        {phase === 'error' && <button className="btn" onClick={() => void runInstall()}>{Icon.refresh}Try again</button>}
        {phase === 'error' && (
          <button className="btn ghost" onClick={onContinue} title="Skip the AI; we'll use the simple offline indexer">
            Skip and continue{Icon.arrowRight}
          </button>
        )}
        {phase !== 'error' && (
          <button
            className="btn accent lg"
            onClick={onContinue}
            disabled={phase !== 'done'}
          >
            {phase === 'done' ? 'Continue' : 'Working…'}
            {phase === 'done' && Icon.arrowRight}
          </button>
        )}
      </div>
    </div>
  );
}

function pullPercent(ev: ModelBootstrapProgress): number {
  const total = (ev.total as number | undefined) ?? 0;
  const completed = (ev.completed as number | undefined) ?? 0;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((completed / total) * 100)));
}

function formatBootstrapLine(ev: ModelBootstrapProgress): string {
  switch (ev.kind) {
    case 'check': return `· ${ev.message ?? 'check'}`;
    case 'install_started': return `▸ Installing ${ev.tool ?? ''}…`;
    case 'install_log': return `  ${ev.line ?? ''}`;
    case 'install_done': return `✓ ${ev.tool ?? ''} installed`;
    case 'install_failed': return `✗ install failed: ${ev.reason ?? ''}`;
    case 'server_starting': return `▸ Starting Ollama at ${ev.host ?? ''}…`;
    case 'server_ready': return `✓ Ollama ready at ${ev.host ?? ''}`;
    case 'server_failed': return `✗ Ollama failed: ${ev.reason ?? ''}`;
    case 'pull_started': return `▸ Downloading ${ev.model ?? ''}…`;
    case 'pull_progress': {
      const pct = pullPercent(ev);
      return `  ${ev.status ?? 'progress'} ${pct}%`;
    }
    case 'pull_done': return `✓ ${ev.model ?? ''} downloaded`;
    case 'pull_failed': return `✗ ${ev.model ?? ''} failed: ${ev.reason ?? ''}`;
    case 'ready': return `✓ ${ev.model ?? ''} ready`;
    default: return ev.kind ?? '·';
  }
}

interface InstallPhase {
  id: 'check' | 'install' | 'server' | 'pull' | 'ready';
  title: string;
  state: 'pending' | 'active' | 'done' | 'error';
  detail?: string;
}

function buildInstallPhases(events: ModelBootstrapProgress[]): InstallPhase[] {
  const phases: InstallPhase[] = [
    { id: 'check', title: 'Checking your setup', state: 'pending' },
    { id: 'install', title: 'Installing Ollama', state: 'pending', detail: 'A free, open-source tool to run AI locally' },
    { id: 'server', title: 'Starting the local AI service', state: 'pending' },
    { id: 'pull', title: 'Downloading the model', state: 'pending', detail: 'Direct from the model author to your computer' },
    { id: 'ready', title: 'Ready to go', state: 'pending' },
  ];
  const set = (id: InstallPhase['id'], state: InstallPhase['state'], detail?: string) => {
    const p = phases.find((x) => x.id === id);
    if (p) {
      p.state = state;
      if (detail) p.detail = detail;
    }
  };
  let sawAny = false;
  for (const ev of events) {
    sawAny = true;
    switch (ev.kind) {
      case 'check': set('check', 'active', ev.message); break;
      case 'install_started': set('check', 'done'); set('install', 'active', `Running the official Ollama installer (${ev.tool ?? 'ollama'}). You may see a system prompt for permission.`); break;
      case 'install_log': set('install', 'active', ev.line); break;
      case 'install_done': set('install', 'done'); break;
      case 'install_failed': set('install', 'error', ev.reason); break;
      case 'server_starting': set('check', 'done'); set('install', 'done'); set('server', 'active', `Starting at ${ev.host ?? 'localhost'}…`); break;
      case 'server_ready': set('server', 'done'); break;
      case 'server_failed': set('server', 'error', ev.reason); break;
      case 'pull_started': set('check', 'done'); set('install', 'done'); set('server', 'done'); set('pull', 'active', `Fetching ${ev.model ?? 'model'}…`); break;
      case 'pull_progress': set('pull', 'active', ev.status); break;
      case 'pull_done': set('pull', 'done'); break;
      case 'pull_failed': set('pull', 'error', ev.reason); break;
      case 'ready':
        set('check', 'done'); set('install', 'done'); set('server', 'done'); set('pull', 'done');
        set('ready', 'done', 'All set');
        break;
    }
  }
  if (!sawAny) {
    phases[0]!.state = 'active';
    phases[0]!.detail = 'Looking for an existing Ollama install…';
  }
  return phases;
}

function FirstCaptureStep({
  overview, onContinue, onBack,
}: {
  overview: RuntimeOverview | null;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [didAttemptStart, setDidAttemptStart] = useState(false);
  const initialTotalRef = React.useRef<number | null>(null);

  // Remember the total at arrival so we can detect growth — but show the
  // user the actual today/total count (a 0-delta with pre-existing data is
  // confusing). We use the delta only to celebrate "your first NEW moment".
  useEffect(() => {
    if (!overview) return;
    if (initialTotalRef.current == null) {
      initialTotalRef.current = overview.storage.totalEvents;
    }
  }, [overview]);

  const eventsToday = overview?.capture.eventsToday ?? 0;
  const totalEvents = overview?.storage.totalEvents ?? 0;
  const displayCount = eventsToday > 0 ? eventsToday : totalEvents;
  const baseline = initialTotalRef.current ?? totalEvents;
  const newSinceArrival = Math.max(0, totalEvents - baseline);
  const captureLive = !!overview?.capture.running && !overview.capture.paused;
  const capturePaused = !!overview?.capture.running && !!overview.capture.paused;
  // Allow continue when capture is live AND either: a brand new moment
  // arrived since arrival, OR the user already has events (returning user).
  const hasFirst = captureLive && (newSinceArrival >= 1 || displayCount >= 1);

  async function startCapturing(): Promise<void> {
    setStarting(true);
    setStartError(null);
    setDidAttemptStart(true);
    try {
      // Always send a start — runtime.start is idempotent and this also
      // recovers from the runtime having been stopped (e.g. by an earlier
      // saveConfigPatch in the install step).
      await window.cofounderos.startRuntime();
      // Capture may still be paused from when we entered onboarding — or
      // newly initialised by start(). Either way, resume to ensure it's live.
      try { await window.cofounderos.resumeCapture(); } catch { /* may already be live */ }
      // Briefly poll the overview so the user sees state catch up.
      for (let i = 0; i < 6; i++) {
        const next = await window.cofounderos.getOverview();
        if (next.capture.running && !next.capture.paused) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  const showAdvance = captureLive || didAttemptStart;

  return (
    <div className="onb-card">
      <div className="onb-step-eyebrow">Your first capture</div>
      <h1 className="onb-title">Let's record your first moment</h1>
      <p className="onb-lede">
        When you click Start, CofounderOS will quietly note the active app and take a small screenshot
        every few seconds — only when something changed. Try switching to another app or scrolling a doc.
      </p>

      <div className="onb-capture-stage">
        <div className={`onb-capture-pulse ${captureLive ? 'live' : ''}`}>
          <div className="onb-capture-icon">{Icon.eye}</div>
        </div>
        <div className="onb-capture-counter">
          <div className="onb-capture-count">{formatNumber(displayCount)}</div>
          <div className="onb-capture-count-label">
            {eventsToday > 0
              ? (displayCount === 1 ? 'moment captured today' : 'moments captured today')
              : (displayCount === 1 ? 'moment captured' : 'moments captured')}
            {newSinceArrival > 0 && (
              <span className="onb-new-pill"> +{newSinceArrival} new</span>
            )}
          </div>
        </div>
        <div className={`onb-capture-status ${captureLive ? 'live' : capturePaused ? 'paused' : ''}`}>
          {captureLive ? 'Capturing — try doing something on your computer'
            : capturePaused ? 'Capture is paused'
            : starting ? 'Waking the capture engine…'
            : 'Not capturing yet'}
        </div>
      </div>

      {startError && <div className="toast error">{Icon.alert}<span>{startError}</span></div>}

      {didAttemptStart && !captureLive && !starting && (
        <div className="toast" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}>
          {Icon.alert}
          <span>
            Capture isn't running yet. On macOS this usually means CofounderOS needs <strong>Screen Recording</strong> and
            <strong> Accessibility</strong> permission. Open <em>System Settings → Privacy &amp; Security</em>, grant access to the
            CofounderOS app (or your terminal in dev mode), then try again.
          </span>
        </div>
      )}

      <div className="onb-tip">
        <span className="onb-tip-icon">{Icon.info}</span>
        <span>You can pause anytime from the menu bar. Sensitive apps and URLs can be excluded in Settings.</span>
      </div>

      <div className="onb-actions">
        <button className="btn ghost" onClick={onBack}>{Icon.arrowLeft}Back</button>
        {!captureLive && (
          <button className="btn accent lg" onClick={() => void startCapturing()} disabled={starting}>
            {starting ? 'Starting…' : didAttemptStart ? 'Try again' : 'Start capturing'}
            {!starting && (didAttemptStart ? Icon.refresh : Icon.play)}
          </button>
        )}
        {captureLive ? (
          <button className="btn accent lg" onClick={onContinue} disabled={!hasFirst}>
            {hasFirst ? 'Continue' : 'Waiting for first moment…'}
            {hasFirst && Icon.arrowRight}
          </button>
        ) : showAdvance || displayCount > 0 ? (
          <button className="btn ghost" onClick={onContinue} title="Skip ahead — you can fix capture later from Home">
            Continue anyway{Icon.arrowRight}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FirstSearchStep({
  onContinue, onBack,
}: {
  onContinue: () => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Frame[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  async function runSearch(): Promise<void> {
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const found = await window.cofounderos.searchFrames({ text: query.trim(), limit: 6 });
      setResults(found);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="onb-card">
      <div className="onb-step-eyebrow">Try a search</div>
      <h1 className="onb-title">Ask your memory anything</h1>
      <p className="onb-lede">
        Type a word from something you just saw — an app name, a webpage title, or text on screen. CofounderOS
        searches everything you've captured so far. (No worries if there's nothing yet — give it a few minutes.)
      </p>

      <div className="onb-search-bar">
        <span className="search-icon">{Icon.search}</span>
        <input
          autoFocus
          placeholder="e.g. Cursor, GitHub, slack, design doc…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
        />
        <button className="btn primary" onClick={() => void runSearch()} disabled={loading || !query.trim()}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </div>

      {searched && (
        <div className="onb-search-results">
          {results && results.length > 0 ? (
            results.map((f, i) => (
              <div className="onb-search-item" key={i}>
                <div className="onb-search-time">{(f.timestamp || '').slice(11, 16) || '—'}</div>
                <div className="onb-search-body">
                  <div className="onb-search-app">{f.app || 'Unknown app'}</div>
                  <div className="onb-search-text">{f.window_title || f.url || (f.text ? String(f.text).replace(/\s+/g, ' ').slice(0, 140) : '—')}</div>
                </div>
              </div>
            ))
          ) : (
            <div className="onb-empty">
              <p>No matches yet. That's normal — capture only just started.</p>
              <p className="onb-fineprint">Try searching for an app you have open, like the one you're reading this in.</p>
            </div>
          )}
        </div>
      )}

      <div className="onb-actions">
        <button className="btn ghost" onClick={onBack}>{Icon.arrowLeft}Back</button>
        <button className="btn accent lg" onClick={onContinue}>{searched ? 'Looks good' : 'Skip for now'}{Icon.arrowRight}</button>
      </div>
    </div>
  );
}

function DoneStep({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="onb-card onb-card-hero">
      <div className="onb-hero-icon onb-hero-rocket">{Icon.rocket}</div>
      <h1 className="onb-title">You're all set</h1>
      <p className="onb-lede">
        CofounderOS is now remembering quietly in the background. Whenever you want to revisit something,
        open the menu bar icon — your memory will be waiting.
      </p>
      <div className="onb-next-list">
        <div className="onb-next">
          <div className="onb-next-icon">{Icon.memories}</div>
          <div>
            <h3>Browse your memories</h3>
            <p>See what you worked on, by day or session.</p>
          </div>
        </div>
        <div className="onb-next">
          <div className="onb-next-icon">{Icon.connect}</div>
          <div>
            <h3>Connect Cursor or Claude</h3>
            <p>Copy a tiny snippet so your AI app can ask your memory directly.</p>
          </div>
        </div>
        <div className="onb-next">
          <div className="onb-next-icon">{Icon.settings}</div>
          <div>
            <h3>Tune privacy &amp; storage</h3>
            <p>Exclude apps, set retention, change models. Everything's a click away.</p>
          </div>
        </div>
      </div>
      <div className="onb-actions">
        <button className="btn accent lg" onClick={onFinish}>Open CofounderOS{Icon.arrowRight}</button>
      </div>
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
  overview, doctor, bootstrapEvents, onRefresh, onStart, onStop, onPause, onResume, onTriggerIndex, onTriggerReorganise, onBootstrap, onGoMemories,
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
  onBootstrap: () => Promise<void>;
  onGoMemories: () => void;
}) {
  const [bootstrapping, setBootstrapping] = useState(false);
  const [organizing, setOrganizing] = useState<'index' | 'reorg' | null>(null);

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

      <div className="section">
        <h3 className="section-title">Memory organization</h3>
        <div className="card">
          <div className="card-row">
            <div className="card-row-content">
              <h4>Refresh the memory index</h4>
              <p>Run this if recent captures are not showing up in search or journals yet.</p>
            </div>
            <button
              className="btn primary"
              disabled={organizing !== null || overview.indexing.running}
              onClick={async () => {
                setOrganizing('index');
                try { await onTriggerIndex(); } finally { setOrganizing(null); }
              }}
            >
              {organizing === 'index' ? 'Organizing…' : 'Organize now'}
            </button>
          </div>
          <div className="card-row" style={{ borderTop: '1px solid var(--line)', marginTop: 18, paddingTop: 18 }}>
            <div className="card-row-content">
              <h4>Rebuild summaries</h4>
              <p>Ask the indexer to reorganize pages and summaries after larger capture sessions.</p>
            </div>
            <button
              className="btn"
              disabled={organizing !== null || overview.indexing.running}
              onClick={async () => {
                setOrganizing('reorg');
                try { await onTriggerReorganise(); } finally { setOrganizing(null); }
              }}
            >
              {organizing === 'reorg' ? 'Rebuilding…' : 'Rebuild summaries'}
            </button>
          </div>
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
  const [copiedSummary, setCopiedSummary] = useState(false);

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

  async function copyDaySummary() {
    if (!journal) return;
    const summary = renderDaySummary(journal, selectedApp);
    await window.cofounderos.copyText(summary);
    setCopiedSummary(true);
    window.setTimeout(() => setCopiedSummary(false), 2200);
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

          {journal && (
            <div className="card day-summary">
              <div>
                <h3>{prettyDay(journal.day)} at a glance</h3>
                <p>
                  {frames.length} moments · {sessions.length} work sessions
                  {selectedApp ? ` · filtered to ${selectedApp}` : ''}
                </p>
              </div>
              <button className="btn ghost" onClick={() => void copyDaySummary()}>
                {Icon.copy}{copiedSummary ? 'Copied summary' : 'Copy summary'}
              </button>
            </div>
          )}

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

function renderDaySummary(journal: JournalDay, appFilter: string): string {
  const frames = appFilter
    ? journal.frames.filter((frame) => frame.app === appFilter)
    : journal.frames;
  const sessions = journal.sessions;
  const apps = Array.from(new Set(frames.map((frame) => frame.app).filter(Boolean) as string[]));
  const lines = [
    `# CofounderOS Journal — ${journal.day}`,
    '',
    `${frames.length} moment${frames.length === 1 ? '' : 's'} captured.`,
    `${sessions.length} work session${sessions.length === 1 ? '' : 's'} found.`,
  ];
  if (appFilter) lines.push(`Filtered app: ${appFilter}.`);
  if (apps.length > 0) lines.push(`Apps: ${apps.slice(0, 8).join(', ')}${apps.length > 8 ? ', …' : ''}.`);
  lines.push('', '## Work sessions');
  if (sessions.length === 0) {
    lines.push('- No work sessions found yet.');
  } else {
    for (const session of sessions.slice(0, 12)) {
      const start = (session.started_at || '').slice(11, 16);
      const end = (session.ended_at || '').slice(11, 16);
      const label = session.primary_entity_path || session.primary_app || 'Mixed work';
      lines.push(`- ${start}-${end}: ${label} (${Math.round((session.active_ms || 0) / 60000)} active min, ${session.frame_count} moments)`);
    }
  }
  lines.push('', '## Recent moments');
  for (const frame of frames.slice(0, 12)) {
    const time = (frame.timestamp || '').slice(11, 16);
    const title = frame.window_title || frame.entity_path || frame.url || 'Untitled';
    lines.push(`- ${time} · ${frame.app || 'Unknown app'} · ${title}`);
  }
  return `${lines.join('\n')}\n`;
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
  const baseline = settingsDraftFromConfig(config);
  const hasUnsavedChanges = JSON.stringify(draft) !== JSON.stringify(baseline);

  async function save() {
    if (!draft || !hasUnsavedChanges) return;
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

  function resetDraft() {
    setDraft(settingsDraftFromConfig(config));
    setMessage(null);
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
        <button className="btn accent lg" disabled={saving || !hasUnsavedChanges} onClick={save}>{saving ? 'Saving…' : hasUnsavedChanges ? 'Save settings' : 'No changes to save'}</button>
        {hasUnsavedChanges ? <button className="btn ghost" onClick={resetDraft}>Reset changes</button> : null}
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
function Help({ logs, onRestartOnboarding }: { logs: string; onRestartOnboarding: () => void }) {
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
          <div className="card-row">
            <div className="card-row-content">
              <h4>Replay onboarding</h4>
              <p>Walk through the welcome tour again.</p>
            </div>
            <button className="btn" onClick={onRestartOnboarding}>{Icon.refresh}Replay</button>
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
