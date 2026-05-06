import * as React from 'react';
import { AppShell } from '@/components/AppShell';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ErrorView } from '@/components/ErrorView';
import { FrameDetailProvider } from '@/components/FrameDetailDialog';
import { Toaster, toast } from '@/components/ui/sonner';
import { chatStore } from '@/lib/chat-store';
import { SidebarStateProvider } from '@/lib/sidebar-state';
import { ThemeProvider } from '@/lib/theme';
import { ONBOARDING_KEY, type Screen } from '@/types';

const Connect = React.lazy(() =>
  import('@/screens/Connect').then((mod) => ({ default: mod.Connect })),
);
const Dashboard = React.lazy(() =>
  import('@/screens/Dashboard').then((mod) => ({ default: mod.Dashboard })),
);
const Help = React.lazy(() => import('@/screens/Help').then((mod) => ({ default: mod.Help })));
const Search = React.lazy(() =>
  import('@/screens/Search').then((mod) => ({ default: mod.Search })),
);
const Settings = React.lazy(() =>
  import('@/screens/Settings').then((mod) => ({ default: mod.Settings })),
);
const Timeline = React.lazy(() =>
  import('@/screens/Timeline').then((mod) => ({ default: mod.Timeline })),
);
const Chat = React.lazy(() => import('@/screens/Chat').then((mod) => ({ default: mod.Chat })));

// Onboarding is a sizeable flow (~33KB source, ~6 step components)
// that 99% of the time only runs once per install. Lazy-loading it keeps
// it out of the main bundle so the dashboard paints faster on every
// subsequent launch — Vite emits it as its own chunk.
const Onboarding = React.lazy(() =>
  import('@/onboarding/Onboarding').then((mod) => ({ default: mod.Onboarding })),
);
import type {
  DoctorCheck,
  JournalDay,
  LoadedConfig,
  ModelBootstrapProgress,
  RuntimeOverview,
} from '@/global';

import '@/lib/thumbnail-cache';

export function App() {
  return (
    <ThemeProvider>
      <SidebarStateProvider>
        <FrameDetailProvider>
          <AppInner />
          <Toaster />
        </FrameDetailProvider>
      </SidebarStateProvider>
    </ThemeProvider>
  );
}

function AppInner() {
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
  const [searchRequest, setSearchRequest] = React.useState<{ id: number; query: string } | null>(
    null,
  );
  const searchRequestId = React.useRef(0);
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
    // Real-time overview push from the runtime service. Replaces what
    // used to be a 2-5s setInterval — main.ts forwards every overview
    // snapshot the runtime emits (heartbeat + after each mutation).
    window.cofounderos?.onOverview?.((next) => setOverview(next));
  }, []);

  React.useEffect(() => {
    if (!showOnboarding) void loadScreen(screen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, showOnboarding]);

  // Sparse safety-net poll. We trust the push channel for normal
  // operation, but if the runtime service ever wedges or the IPC
  // listener drops updates, this guarantees we recover within 30s.
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      if (!window.cofounderos) return;
      void window.cofounderos.getOverview().then(setOverview).catch(() => undefined);
    }, 30000);
    return () => window.clearInterval(timer);
  }, []);

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
        // If the previously-selected day no longer exists (e.g. deleted),
        // fall back to the most recent day so the panel doesn't render
        // empty pointing at a missing key.
        const stillThere = selectedDay && nextDays.includes(selectedDay) ? selectedDay : null;
        const day = stillThere ?? nextDays[nextDays.length - 1] ?? null;
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
    toast.success('MCP snippet copied', { description: 'Paste it into your AI app settings.' });
  }

  function runPaletteSearch(query: string) {
    const q = query.trim();
    if (!q) return;
    searchRequestId.current += 1;
    setSearchRequest({ id: searchRequestId.current, query: q });
    setScreen('search');
  }

  // Navigating into the AI Chat tab from another screen should drop the
  // user into a fresh conversation rather than re-opening whichever chat
  // happened to be active last. Clicking the tab while already on chat
  // is a no-op so we don't churn through empty "New chat" entries.
  const navigateToScreen = React.useCallback(
    (next: Screen) => {
      setScreen((current) => {
        if (next === 'chat' && current !== 'chat') {
          const conv = chatStore.create();
          chatStore.setActiveId(conv.id);
        }
        return next;
      });
    },
    [],
  );

  // Capture / index actions with toast feedback. Centralised here so the
  // Dashboard, AppShell command palette, and any future surface all get the
  // same UX without duplicating the toast wiring.
  const actions = React.useMemo(
    () => ({
      onStart: async () => {
        try {
          setOverview(await window.cofounderos.startRuntime());
          toast.success('Capture started');
        } catch (err) {
          toast.error('Could not start capture', {
            description: err instanceof Error ? err.message : String(err),
          });
        }
      },
      onStop: async () => {
        try {
          await window.cofounderos.stopRuntime();
          setOverview(await window.cofounderos.getOverview().catch(() => null));
          toast.info('Capture stopped');
        } catch (err) {
          toast.error('Could not stop capture', {
            description: err instanceof Error ? err.message : String(err),
          });
        }
      },
      onPause: async () => {
        try {
          setOverview(await window.cofounderos.pauseCapture());
          toast.info('Capture paused');
        } catch (err) {
          toast.error('Could not pause capture', {
            description: err instanceof Error ? err.message : String(err),
          });
        }
      },
      onResume: async () => {
        try {
          setOverview(await window.cofounderos.resumeCapture());
          toast.success('Capture resumed');
        } catch (err) {
          toast.error('Could not resume capture', {
            description: err instanceof Error ? err.message : String(err),
          });
        }
      },
      onTriggerIndex: async () => {
        try {
          setOverview(await window.cofounderos.triggerIndex());
          toast.success('Organizing memories…', {
            description: 'This runs in the background.',
          });
        } catch (err) {
          toast.error('Could not start indexer', {
            description: err instanceof Error ? err.message : String(err),
          });
        }
      },
      onTriggerReorganise: async () => {
        try {
          setOverview(await window.cofounderos.triggerReorganise());
          toast.success('Rebuilding summaries…', {
            description: 'This runs in the background.',
          });
        } catch (err) {
          toast.error('Could not rebuild summaries', {
            description: err instanceof Error ? err.message : String(err),
          });
        }
      },
      onTriggerFullReindex: async (fromDate: string) => {
        const from = normaliseDateStart(fromDate);
        if (!from) {
          toast.error('Choose a date to re-index from');
          return;
        }
        toast.info('Re-indexing memory…', {
          description: `Rebuilding generated pages from ${fromDate}.`,
        });
        try {
          setOverview(await window.cofounderos.triggerFullReindex({ from }));
          toast.success('Re-index complete', {
            description: 'Generated pages and summaries were rebuilt from raw captures.',
          });
        } catch (err) {
          toast.error('Could not re-index memory', {
            description: err instanceof Error ? err.message : String(err),
          });
        }
      },
      onBootstrap: async () => {
        setBootstrapEvents([]);
        try {
          await window.cofounderos.bootstrapModel();
          setDoctor(await window.cofounderos.runDoctor());
          toast.success('Local AI is ready');
        } catch (err) {
          toast.error('AI setup failed', {
            description: err instanceof Error ? err.message : String(err),
          });
        }
      },
      onOpenMarkdownExport: async (category?: string) => {
        try {
          await window.cofounderos.openPath(
            category ? { target: 'markdown', category } : 'markdown',
          );
        } catch (err) {
          toast.error('Could not open Markdown export', {
            description: err instanceof Error ? err.message : String(err),
          });
        }
      },
    }),
    [],
  );

  if (showOnboarding) {
    return (
      <React.Suspense fallback={<OnboardingLoadingScrim />}>
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
      </React.Suspense>
    );
  }

  const screenContent = error ? (
    <div className="pt-6">
      <ErrorView error={error} onRetry={() => loadScreen(screen)} />
    </div>
  ) : screen === 'dashboard' ? (
    <Dashboard
      overview={overview}
      doctor={doctor}
      bootstrapEvents={bootstrapEvents}
      onRefresh={() => loadScreen('dashboard')}
      onStart={actions.onStart}
      onStop={actions.onStop}
      onPause={actions.onPause}
      onResume={actions.onResume}
      onTriggerIndex={actions.onTriggerIndex}
      onTriggerReorganise={actions.onTriggerReorganise}
      onTriggerFullReindex={actions.onTriggerFullReindex}
      onBootstrap={actions.onBootstrap}
      onOpenMarkdownExport={actions.onOpenMarkdownExport}
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
    <Search days={days} searchRequest={searchRequest} />
  ) : screen === 'chat' ? (
    <Chat />
  ) : screen === 'connect' ? (
    <Connect overview={overview} config={config} onRefresh={() => loadScreen('connect')} />
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
  );

  return (
    <AppShell
      screen={screen}
      onChange={navigateToScreen}
      overview={overview}
      onStart={actions.onStart}
      onStop={actions.onStop}
      onPause={actions.onPause}
      onResume={actions.onResume}
      onSearch={runPaletteSearch}
      onTriggerIndex={actions.onTriggerIndex}
      onTriggerReorganise={actions.onTriggerReorganise}
      onBootstrap={actions.onBootstrap}
      onCopyMcpSnippet={copyMcpSnippet}
    >
      <ErrorBoundary resetKey={screen}>
        <React.Suspense fallback={<ScreenLoading />}>{screenContent}</React.Suspense>
      </ErrorBoundary>
    </AppShell>
  );
}

function normaliseDateStart(date: string): string | undefined {
  const trimmed = date.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return undefined;
  return `${trimmed}T00:00:00.000`;
}

function ScreenLoading() {
  return (
    <div className="grid min-h-[50vh] place-items-center text-muted-foreground text-sm">
      Loading…
    </div>
  );
}

/**
 * Briefly visible scrim while the lazy-loaded Onboarding chunk fetches.
 * In practice this is a couple hundred ms on first install, then never
 * again — but we still need a fallback so React.Suspense doesn't throw.
 */
function OnboardingLoadingScrim() {
  return (
    <div className="grid h-screen place-items-center bg-background text-muted-foreground text-sm">
      Preparing welcome…
    </div>
  );
}
