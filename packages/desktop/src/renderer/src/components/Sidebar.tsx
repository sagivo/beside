import {
  Calendar,
  ChevronsLeft,
  ChevronsRight,
  HelpCircle,
  LayoutDashboard,
  Lightbulb,
  Plug,
  Search,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { BrandMark } from '@/components/BrandMark';
import { StatusFooter } from '@/components/StatusFooter';
import type { Screen } from '@/types';
import type { RuntimeOverview } from '@/global';
import { useSidebar } from '@/lib/sidebar-state';
import { cn } from '@/lib/utils';

const NAV: Array<{ id: Screen; label: string; icon: LucideIcon; shortcut: string }> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, shortcut: '1' },
  { id: 'timeline', label: 'Timeline', icon: Calendar, shortcut: '2' },
  { id: 'search', label: 'Search', icon: Search, shortcut: '3' },
  { id: 'insights', label: 'Insights', icon: Lightbulb, shortcut: '4' },
  { id: 'connect', label: 'Connect AI', icon: Plug, shortcut: '5' },
  { id: 'settings', label: 'Settings', icon: Settings, shortcut: '6' },
  { id: 'help', label: 'Help', icon: HelpCircle, shortcut: '7' },
];

export function Sidebar({
  screen,
  onChange,
  overview,
  onOpenCommand,
  helpHasUnread = false,
}: {
  screen: Screen;
  onChange: (next: Screen) => void;
  overview: RuntimeOverview | null;
  onOpenCommand: () => void;
  helpHasUnread?: boolean;
}) {
  const { collapsed, toggle } = useSidebar();

  return (
    <aside
      className={cn(
        'app-drag relative flex flex-col border-r border-border bg-sidebar text-sidebar-foreground transition-[width] duration-200',
        collapsed ? 'w-14' : 'w-60',
      )}
    >
      <div
        className={cn(
          'flex items-center px-3 pt-12 pb-6',
          collapsed ? 'justify-center' : 'gap-3 px-4',
        )}
      >
        <BrandMark />
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-tight truncate">CofounderOS</div>
            <div className="text-xs text-muted-foreground truncate">
              Your memory, on this device
            </div>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onOpenCommand}
        title="Search (⌘K)"
        className={cn(
          'app-no-drag mx-2 mb-3 flex h-9 items-center rounded-md border border-input bg-background text-sm text-muted-foreground shadow-xs',
          'hover:bg-accent hover:text-accent-foreground transition-colors',
          collapsed ? 'justify-center px-0' : 'gap-2 px-3',
        )}
      >
        <Search className="size-4 shrink-0" />
        {!collapsed && (
          <>
            <span>Search…</span>
            <span className="ml-auto rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
              ⌘K
            </span>
          </>
        )}
      </button>

      <nav className={cn('app-no-drag flex flex-1 flex-col gap-0.5', collapsed ? 'px-2' : 'px-2')}>
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = item.id === screen;
          const showHelpDot = item.id === 'help' && helpHasUnread;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onChange(item.id)}
              title={`${item.label} (\u2318${item.shortcut})`}
              className={cn(
                'group relative flex items-center rounded-md text-sm font-medium transition-colors',
                collapsed ? 'h-9 justify-center px-0' : 'gap-3 px-3 py-2',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" />
              {!collapsed && (
                <>
                  <span className="flex-1 text-left truncate">{item.label}</span>
                  <span
                    className={cn(
                      'rounded border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-mono leading-none text-muted-foreground/80 opacity-0 transition-opacity',
                      'group-hover:opacity-100',
                      active && 'opacity-100',
                    )}
                  >
                    {`\u2318${item.shortcut}`}
                  </span>
                </>
              )}
              {showHelpDot && (
                <span
                  className={cn(
                    'absolute size-2 rounded-full bg-primary',
                    collapsed ? 'top-1.5 right-1.5' : 'top-2.5 right-2.5',
                  )}
                />
              )}
            </button>
          );
        })}
      </nav>

      <button
        type="button"
        onClick={toggle}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className={cn(
          'app-no-drag mx-2 my-2 flex h-7 items-center rounded-md text-xs text-muted-foreground/70',
          'hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground transition-colors',
          collapsed ? 'justify-center px-0' : 'gap-2 px-3',
        )}
      >
        {collapsed ? (
          <ChevronsRight className="size-3.5" />
        ) : (
          <>
            <ChevronsLeft className="size-3.5" />
            <span>Collapse</span>
          </>
        )}
      </button>

      <div
        className={cn(
          'app-no-drag border-t border-border py-3',
          collapsed ? 'px-2 grid place-items-center' : 'px-3',
        )}
      >
        {collapsed ? (
          <CollapsedStatusDot overview={overview} />
        ) : (
          <StatusFooter overview={overview} />
        )}
      </div>
    </aside>
  );
}

function CollapsedStatusDot({ overview }: { overview: RuntimeOverview | null }) {
  const captureLive = !!overview?.capture.running && !overview.capture.paused;
  const capturePaused = !!overview?.capture.running && !!overview.capture.paused;
  const indexing = !!overview?.indexing.running;
  return (
    <span
      title={
        indexing
          ? 'Indexing'
          : captureLive
            ? 'Capturing'
            : capturePaused
              ? 'Paused'
              : 'Not capturing'
      }
      className={cn(
        'block size-2 rounded-full',
        indexing
          ? 'bg-primary animate-pulse'
          : captureLive
            ? 'bg-success animate-pulse'
            : capturePaused
              ? 'bg-warning'
              : 'bg-muted-foreground/40',
      )}
    />
  );
}
