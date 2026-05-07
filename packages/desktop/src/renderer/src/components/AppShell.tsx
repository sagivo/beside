import * as React from 'react';
import { Sidebar } from '@/components/Sidebar';
import { CommandPalette } from '@/components/CommandPalette';
import { useHasUnreadChangelog } from '@/lib/changelog';
import { useSidebarWidthVar } from '@/lib/sidebar-state';
import type { Screen } from '@/types';
import type { RuntimeOverview } from '@/global';

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
}: {
  screen: Screen;
  onChange: (next: Screen) => void;
  overview: RuntimeOverview | null;
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
      '2': 'timeline',
      '3': 'meetings',
      '4': 'search',
      '5': 'chat',
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

      // Cmd+1..6: jump screens
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
    <div
      className="flex h-screen overflow-hidden bg-background text-foreground"
      style={sidebarWidthVar}
    >
      <Sidebar
        screen={screen}
        onChange={onChange}
        overview={overview}
        onOpenCommand={() => setPaletteOpen(true)}
        helpHasUnread={helpHasUnread}
      />

      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="app-drag h-8 shrink-0" aria-hidden />
        {screen === 'chat' ? (
          <div className="app-no-drag flex-1 min-h-0 overflow-hidden">{children}</div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <div className="app-no-drag mx-auto max-w-5xl px-8 pb-12">{children}</div>
          </div>
        )}
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
