import * as React from 'react';
import {
  Calendar,
  HelpCircle,
  LayoutDashboard,
  Plug,
  Search,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { BrandMark } from '@/components/BrandMark';
import { StatusFooter } from '@/components/StatusFooter';
import type { Screen } from '@/types';
import type { RuntimeOverview } from '@/global';
import { cn } from '@/lib/utils';

const NAV: Array<{ id: Screen; label: string; icon: LucideIcon }> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'timeline', label: 'Timeline', icon: Calendar },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'connect', label: 'Connect AI', icon: Plug },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'help', label: 'Help', icon: HelpCircle },
];

export function Sidebar({
  screen,
  onChange,
  overview,
  onOpenCommand,
}: {
  screen: Screen;
  onChange: (next: Screen) => void;
  overview: RuntimeOverview | null;
  onOpenCommand: () => void;
}) {
  return (
    <aside className="app-drag flex w-60 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-3 px-4 pt-12 pb-6">
        <BrandMark />
        <div>
          <div className="text-sm font-semibold leading-tight">CofounderOS</div>
          <div className="text-xs text-muted-foreground">Your memory, on this device</div>
        </div>
      </div>

      <button
        type="button"
        onClick={onOpenCommand}
        className={cn(
          'app-no-drag mx-3 mb-3 flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground shadow-xs',
          'hover:bg-accent hover:text-accent-foreground transition-colors',
        )}
      >
        <Search className="size-4" />
        <span>Search…</span>
        <span className="ml-auto rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
          ⌘K
        </span>
      </button>

      <nav className="app-no-drag flex flex-1 flex-col gap-0.5 px-2">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = item.id === screen;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onChange(item.id)}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
              )}
            >
              <Icon className="size-4" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="app-no-drag border-t border-border px-3 py-3">
        <StatusFooter overview={overview} />
      </div>
    </aside>
  );
}
