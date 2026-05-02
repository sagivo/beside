import * as React from 'react';
import { Sidebar } from '@/components/Sidebar';
import { CommandPalette } from '@/components/CommandPalette';
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
  onTriggerIndex: () => Promise<void> | void;
  onTriggerReorganise: () => Promise<void> | void;
  onBootstrap: () => Promise<void> | void;
  onCopyMcpSnippet?: () => Promise<void> | void;
}) {
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar
        screen={screen}
        onChange={onChange}
        overview={overview}
        onOpenCommand={() => setPaletteOpen(true)}
      />

      <main className="flex-1 overflow-y-auto">
        <div className="app-drag h-8" aria-hidden />
        <div className="app-no-drag mx-auto max-w-5xl px-8 pb-12">{children}</div>
      </main>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onJump={onChange}
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
