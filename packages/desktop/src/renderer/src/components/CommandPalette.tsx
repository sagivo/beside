import * as React from 'react';
import {
  Calendar,
  CircleStop,
  FolderOpen,
  HelpCircle,
  LayoutDashboard,
  Pause,
  Play,
  Plug,
  RefreshCcw,
  Search,
  Settings,
  Sparkles,
  Wand2,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import type { Screen } from '@/types';
import type { RuntimeOverview } from '@/global';

export function CommandPalette({
  open,
  onOpenChange,
  onJump,
  onSearch,
  overview,
  onStart,
  onStop,
  onPause,
  onResume,
  onTriggerIndex,
  onTriggerReorganise,
  onBootstrap,
  onCopyMcpSnippet,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onJump: (screen: Screen) => void;
  onSearch: (query: string) => void;
  overview: RuntimeOverview | null;
  onStart: () => Promise<void> | void;
  onStop: () => Promise<void> | void;
  onPause: () => Promise<void> | void;
  onResume: () => Promise<void> | void;
  onTriggerIndex: () => Promise<void> | void;
  onTriggerReorganise: () => Promise<void> | void;
  onBootstrap: () => Promise<void> | void;
  onCopyMcpSnippet?: () => Promise<void> | void;
}) {
  const [query, setQuery] = React.useState('');
  const running = overview?.status === 'running';
  const captureLive = !!overview?.capture.running && !overview.capture.paused;
  const capturePaused = !!overview?.capture.running && !!overview.capture.paused;
  const trimmedQuery = query.trim();

  React.useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  function run(fn: () => unknown) {
    onOpenChange(false);
    queueMicrotask(() => {
      void fn();
    });
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder="Type a command or search…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Jump to">
          <CommandItem onSelect={() => run(() => onJump('dashboard'))}>
            <LayoutDashboard /> Dashboard
          </CommandItem>
          <CommandItem onSelect={() => run(() => onJump('timeline'))}>
            <Calendar /> Timeline
          </CommandItem>
          <CommandItem onSelect={() => run(() => onJump('search'))}>
            <Search /> Search
          </CommandItem>
          <CommandItem onSelect={() => run(() => onJump('connect'))}>
            <Plug /> Connect AI
          </CommandItem>
          <CommandItem onSelect={() => run(() => onJump('settings'))}>
            <Settings /> Settings
          </CommandItem>
          <CommandItem onSelect={() => run(() => onJump('help'))}>
            <HelpCircle /> Help
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          {!running && (
            <CommandItem onSelect={() => run(onStart)}>
              <Play /> Start capture
            </CommandItem>
          )}
          {captureLive && (
            <CommandItem onSelect={() => run(onPause)}>
              <Pause /> Pause capture
            </CommandItem>
          )}
          {capturePaused && (
            <CommandItem onSelect={() => run(onResume)}>
              <Play /> Resume capture
            </CommandItem>
          )}
          {running && (
            <CommandItem onSelect={() => run(onStop)}>
              <CircleStop /> Stop capture
            </CommandItem>
          )}
          <CommandItem onSelect={() => run(onTriggerIndex)}>
            <RefreshCcw /> Organize memories now
          </CommandItem>
          <CommandItem onSelect={() => run(onTriggerReorganise)}>
            <Wand2 /> Rebuild summaries
          </CommandItem>
          {!overview?.model.ready && (
            <CommandItem onSelect={() => run(onBootstrap)}>
              <Sparkles /> Set up local AI
            </CommandItem>
          )}
          {onCopyMcpSnippet && (
            <CommandItem onSelect={() => run(onCopyMcpSnippet)}>
              <Plug /> Copy MCP snippet
            </CommandItem>
          )}
          <CommandItem onSelect={() => run(() => window.cofounderos.openPath('markdown'))}>
            <FolderOpen /> Open Markdown folder
          </CommandItem>
          <CommandItem onSelect={() => run(() => window.cofounderos.openPath('data'))}>
            <FolderOpen /> Open data folder
          </CommandItem>
        </CommandGroup>
        {trimmedQuery && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Search memory">
              <CommandItem
                value={`search memory ${trimmedQuery}`}
                onSelect={() => run(() => onSearch(trimmedQuery))}
              >
                <Search /> Search for "{trimmedQuery}"
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
