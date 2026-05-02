import * as React from 'react';
import { AppShell } from '@/components/AppShell';
import { ErrorView } from '@/components/ErrorView';
import { Connect } from '@/screens/Connect';
import { Dashboard } from '@/screens/Dashboard';
import { Help } from '@/screens/Help';
import { Search } from '@/screens/Search';
import { Settings } from '@/screens/Settings';
import { Timeline } from '@/screens/Timeline';
import { Onboarding } from '@/onboarding/Onboarding';
import { ONBOARDING_KEY, type Screen } from '@/types';
import type {
  DoctorCheck,
  JournalDay,
  LoadedConfig,
  ModelBootstrapProgress,
  RuntimeOverview,
} from '@/global';

import '@/lib/thumbnail-cache';

export function App() {
  const [screen, setScreen] = React.useState<Screen>('dashboard');
  const [overview, setOverview] = React.useState<RuntimeOverview | null>(null);
  const [doctor, setDoctor] = React.useState<DoctorCheck[] | null>(null);
  const [days, setDays] = React.useState<string[]>([]);
  const [selectedDay, setSelectedDay] = React.useState<string | null>(null);
  const [journal, setJournal] = React.useState<JournalDay | null>(null);
  const [config, setConfig] = React.useState<LoadedConfig | null>(null);
  const [logs, setLogs] = React.useState('');
  const [bootstrapEvents, setBootstrapEvents] = React.useState<ModelBootstrapProgress[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = React.useState<boolean>(() => {
    try {
      return localStorage.getItem(ONBOARDING_KEY) !== '1';
    } catch {
      return true;
    }
  });

  React.useEffect(() => {
    window.cofounderos?.onDesktopLogs?.((nextLogs) => setLogs(nextLogs || ''));
    window.cofounderos?.onBootstrapProgress?.((progress) => {
      setBootstrapEvents((events) => [...events.slice(-80), progress]);
    });
  }, []);

  React.useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (matches: boolean) => {
      document.documentElement.classList.toggle('dark', matches);
    };
    apply(mq.matches);
    const listener = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener('change', listener);
    return () => mq.removeEventListener('change', listener);
  }, []);

  React.useEffect(() => {
    if (!showOnboarding) void loadScreen(screen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, showOnboarding]);

  React.useEffect(() => {
    const intervalMs = overview?.indexing.running ? 2000 : 5000;
    const timer = window.setInterval(() => {
      if (!window.cofounderos) return;
      void window.cofounderos.getOverview().then(setOverview).catch(() => undefined);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [overview?.indexing.running]);

  async function loadScreen(next: Screen) {
    try {
      if (!window.cofounderos) throw new Error('Desktop preload bridge is unavailable.');
      if (next === 'dashboard') {
        setOverview(await window.cofounderos.getOverview());
        setDoctor(await window.cofounderos.runDoctor());
      }
      if (next === 'timeline') {
        const nextDays = await window.cofounderos.listJournalDays();
        setDays(nextDays);
        const day = selectedDay ?? nextDays[nextDays.length - 1] ?? null;
        setSelectedDay(day);
        setJournal(day ? await window.cofounderos.getJournalDay(day) : null);
      }
      if (next === 'search') {
        const nextDays = await window.cofounderos.listJournalDays();
        setDays(nextDays);
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

  async function copyMcpSnippet() {
    const cfg = config ?? (await window.cofounderos.readConfig());
    if (!config) setConfig(cfg);
    const mcp = cfg.config.export.plugins.find((p) => p.name === 'mcp');
    const host = typeof mcp?.host === 'string' ? mcp.host : '127.0.0.1';
    const port = typeof mcp?.port === 'number' ? mcp.port : 3456;
    const url = `http://${host}:${port}`;
    const snippet = JSON.stringify({ mcpServers: { cofounderos: { url } } }, null, 2);
    await window.cofounderos.copyText(snippet);
  }

  if (showOnboarding) {
    return (
      <Onboarding
        bootstrapEvents={bootstrapEvents}
        onClearBootstrapEvents={() => setBootstrapEvents([])}
        onComplete={() => {
          try {
            localStorage.setItem(ONBOARDING_KEY, '1');
          } catch {
            /* ignore */
          }
          setShowOnboarding(false);
          setScreen('dashboard');
        }}
      />
    );
  }

  return (
    <AppShell
      screen={screen}
      onChange={setScreen}
      overview={overview}
      onStart={async () => setOverview(await window.cofounderos.startRuntime())}
      onStop={async () => {
        await window.cofounderos.stopRuntime();
        setOverview(await window.cofounderos.getOverview().catch(() => null));
      }}
      onPause={async () => setOverview(await window.cofounderos.pauseCapture())}
      onResume={async () => setOverview(await window.cofounderos.resumeCapture())}
      onTriggerIndex={async () => setOverview(await window.cofounderos.triggerIndex())}
      onTriggerReorganise={async () =>
        setOverview(await window.cofounderos.triggerReorganise())
      }
      onBootstrap={async () => {
        setBootstrapEvents([]);
        await window.cofounderos.bootstrapModel();
        setDoctor(await window.cofounderos.runDoctor());
      }}
      onCopyMcpSnippet={copyMcpSnippet}
    >
      {error ? (
        <div className="pt-6">
          <ErrorView error={error} onRetry={() => loadScreen(screen)} />
        </div>
      ) : screen === 'dashboard' ? (
        <Dashboard
          overview={overview}
          doctor={doctor}
          bootstrapEvents={bootstrapEvents}
          onRefresh={() => loadScreen('dashboard')}
          onStart={async () => setOverview(await window.cofounderos.startRuntime())}
          onStop={async () => {
            await window.cofounderos.stopRuntime();
            setOverview(await window.cofounderos.getOverview().catch(() => null));
          }}
          onPause={async () => setOverview(await window.cofounderos.pauseCapture())}
          onResume={async () => setOverview(await window.cofounderos.resumeCapture())}
          onTriggerIndex={async () => setOverview(await window.cofounderos.triggerIndex())}
          onTriggerReorganise={async () =>
            setOverview(await window.cofounderos.triggerReorganise())
          }
          onBootstrap={async () => {
            setBootstrapEvents([]);
            await window.cofounderos.bootstrapModel();
            setDoctor(await window.cofounderos.runDoctor());
          }}
          onGoTimeline={() => setScreen('timeline')}
        />
      ) : screen === 'timeline' ? (
        <Timeline
          days={days}
          selectedDay={selectedDay}
          journal={journal}
          onChooseDay={chooseDay}
          onRefresh={() => loadScreen('timeline')}
        />
      ) : screen === 'search' ? (
        <Search days={days} />
      ) : screen === 'connect' ? (
        <Connect
          overview={overview}
          config={config}
          onRefresh={() => loadScreen('connect')}
        />
      ) : screen === 'settings' ? (
        <Settings config={config} onSaved={setConfig} />
      ) : (
        <Help
          logs={logs}
          onRestartOnboarding={() => {
            try {
              localStorage.removeItem(ONBOARDING_KEY);
            } catch {
              /* ignore */
            }
            setShowOnboarding(true);
          }}
        />
      )}
    </AppShell>
  );
}
