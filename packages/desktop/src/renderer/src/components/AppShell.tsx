import * as React from 'react';
import { RefreshCw } from 'lucide-react';
import { Sidebar } from '@/components/Sidebar';
import { CommandPalette } from '@/components/CommandPalette';
import { Button } from '@/components/ui/button';
import { useHasUnreadChangelog } from '@/lib/changelog';
import { useSidebarWidthVar } from '@/lib/sidebar-state';
import type { Screen } from '@/types';
import type { AppUpdateReadyInfo, RuntimeOverview } from '@/global';

export function AppShell({
  screen,
  onChange,
  overview,
  children,
  onStart,
  onStop,
  onPause,
  onResume,
  onSearch,
  onTriggerIndex,
  onTriggerReorganise,
  onBootstrap,
  onCopyMcpSnippet,
  appUpdateReady,
  onInstallAppUpdate,
}: {
  screen: Screen;
  onChange: (next: Screen) => void;
  overview: RuntimeOverview | null;
  appUpdateReady: AppUpdateReadyInfo | null;
  children: React.ReactNode;
  onStart: () => Promise<void> | void;
  onStop: () => Promise<void> | void;
  onPause: () => Promise<void> | void;
  onResume: () => Promise<void> | void;
  onSearch: (query: string) => void;
  onTriggerIndex: () => Promise<void> | void;
  onTriggerReorganise: () => Promise<void> | void;
  onBootstrap: () => Promise<void> | void;
  onCopyMcpSnippet?: () => Promise<void> | void;
  onInstallAppUpdate: () => Promise<void> | void;
}) {
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  // Keep the latest callbacks/screen state in refs so the global keydown
  // listener is stable across renders (registered once) and never sees a
  // stale closure.
  const stateRef = React.useRef({
    overview,
    onChange,
    onPause,
    onResume,
    onStart,
  });
  React.useEffect(() => {
    stateRef.current = { overview, onChange, onPause, onResume, onStart };
  }, [overview, onChange, onPause, onResume, onStart]);

  React.useEffect(() => {
    function isInsideEditableField(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    }

    const SCREEN_KEYS: Record<string, Screen> = {
      '1': 'dashboard',
      '2': 'ai',
      '3': 'meetings',
      '4': 'privacy',
      '5': 'search',
      '6': 'connect',
      '7': 'settings',
      '8': 'help',
    };

    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      // Cmd+K / Ctrl+K: command palette. Always fires, even from inputs.
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }

      // The remaining shortcuts intentionally don't fire from text fields
      // so the user can still type "1" inside Search / Settings inputs.
      if (isInsideEditableField(e.target)) return;

      // Cmd+1..7: jump screens
      if (mod && SCREEN_KEYS[e.key]) {
        e.preventDefault();
        stateRef.current.onChange(SCREEN_KEYS[e.key]!);
        return;
      }

      // Cmd+. : toggle capture pause/resume (Cmd+Period is a common
      // "interrupt" shortcut on macOS — borrowing it for capture toggle).
      if (mod && e.key === '.') {
        e.preventDefault();
        const ov = stateRef.current.overview;
        if (!ov || !ov.capture.running) {
          void stateRef.current.onStart();
        } else if (ov.capture.paused) {
          void stateRef.current.onResume();
        } else {
          void stateRef.current.onPause();
        }
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sidebarWidthVar = useSidebarWidthVar();
  const helpHasUnread = useHasUnreadChangelog();

  return (
    // The body owns the canvas (solid + gradient + grain). The shell is
    // transparent so the page gradient bleeds through, which is what makes
    // the frosted sidebar feel real.
    <div
      className="flex h-screen overflow-hidden text-foreground"
      style={sidebarWidthVar}
    >
      <Sidebar
        screen={screen}
        onChange={onChange}
        overview={overview}
        onOpenCommand={() => setPaletteOpen(true)}
        onPause={onPause}
        onResume={onResume}
        helpHasUnread={helpHasUnread}
      />

      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="app-drag h-8 shrink-0" aria-hidden />
        {appUpdateReady && (
          <UpdateReadyBanner update={appUpdateReady} onInstall={onInstallAppUpdate} />
        )}
        <div className="flex-1 overflow-y-auto">
          <div className="app-no-drag mx-auto max-w-5xl px-8 pb-12">{children}</div>
        </div>
      </main>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onJump={onChange}
        onSearch={onSearch}
        overview={overview}
        onStart={onStart}
        onStop={onStop}
        onPause={onPause}
        onResume={onResume}
        onTriggerIndex={onTriggerIndex}
        onTriggerReorganise={onTriggerReorganise}
        onBootstrap={onBootstrap}
        onCopyMcpSnippet={onCopyMcpSnippet}
      />
    </div>
  );
}

function UpdateReadyBanner({
  update,
  onInstall,
}: {
  update: AppUpdateReadyInfo;
  onInstall: () => Promise<void> | void;
}) {
  const versionLabel = update.version ? `Beside ${update.version}` : 'A new Beside version';

  return (
    <div
      role="status"
      aria-live="polite"
      className="app-no-drag border-y border-primary/15 bg-primary-soft/80 shadow-xs backdrop-blur"
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-8 py-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-md border border-primary/20 bg-background/70 text-primary">
          <RefreshCw className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-5">{versionLabel} is ready.</p>
          <p className="text-xs leading-5 text-muted-foreground">
            Restart to finish installing the update that downloaded in the background.
          </p>
        </div>
        <Button size="sm" onClick={() => void onInstall()}>
          <RefreshCw />
          Restart and Update
        </Button>
      </div>
    </div>
  );
}
