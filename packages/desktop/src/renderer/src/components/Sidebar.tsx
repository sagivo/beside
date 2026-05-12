import {
  ChevronsLeft,
  ChevronsRight,
  HelpCircle,
  LayoutDashboard,
  Plug,
  Search,
  Settings,
  ShieldCheck,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { BrandMark } from '@/components/BrandMark';
import { StatusFooter } from '@/components/StatusFooter';
import type { Screen } from '@/types';
import type { RuntimeOverview } from '@/global';
import { useSidebar } from '@/lib/sidebar-state';
import { cn } from '@/lib/utils';

interface NavItem {
  id: Screen;
  label: string;
  icon: LucideIcon;
  shortcut: string;
}

/**
 * Two-group nav. The redesign separates the things a non-technical user
 * touches every day ("Memory") from the configuration / plumbing tabs
 * ("System"). Both share the same chip styling but System sits below a
 * subtle label so the eye doesn't treat them as equally weighted.
 */
const NAV_PRIMARY: NavItem[] = [
  { id: 'dashboard', label: 'Today', icon: LayoutDashboard, shortcut: '1' },
  { id: 'meetings', label: 'Agenda', icon: Video, shortcut: '2' },
  { id: 'privacy', label: 'Privacy', icon: ShieldCheck, shortcut: '3' },
  { id: 'search', label: 'Search', icon: Search, shortcut: '4' },
];

const NAV_SECONDARY: NavItem[] = [
  { id: 'connect', label: 'Connect', icon: Plug, shortcut: '5' },
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
        'app-drag glass-pane relative flex flex-col border-r border-sidebar-border text-sidebar-foreground transition-[width] duration-200 z-10',
        collapsed ? 'w-14' : 'w-[15rem]',
      )}
    >
      {/* Brand */}
      <div
        className={cn(
          'flex items-center pt-12 pb-5',
          collapsed ? 'justify-center px-2' : 'gap-3 px-4',
        )}
      >
        <BrandMark />
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-[15px] font-semibold leading-tight tracking-tight truncate">
              Beside
            </div>
            <div className="text-[11px] text-muted-foreground truncate mt-0.5">
              Your memory, on this device
            </div>
          </div>
        )}
      </div>

      {/* Search trigger — leaner than the old full-width chip; reads as a tool, not a section */}
      <button
        type="button"
        onClick={onOpenCommand}
        title="Search (⌘K)"
        className={cn(
          'app-no-drag mx-2 mb-4 flex h-8 items-center rounded-lg border border-sidebar-border bg-background/60 text-[13px] text-muted-foreground transition-all',
          'hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground hover:border-sidebar-accent',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          collapsed ? 'justify-center px-0' : 'gap-2 px-2.5',
        )}
      >
        <Search className="size-3.5 shrink-0" />
        {!collapsed && (
          <>
            <span className="flex-1 text-left">Quick find…</span>
            <span className="rounded bg-muted px-1.5 py-px text-[10px] font-mono leading-none text-muted-foreground/70">
              ⌘K
            </span>
          </>
        )}
      </button>

      {/* Primary nav — the daily-use chunk */}
      <nav className="app-no-drag flex flex-col gap-0.5 px-2">
        {NAV_PRIMARY.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={item.id === screen}
            collapsed={collapsed}
            onClick={() => onChange(item.id)}
          />
        ))}
      </nav>

      {/* Section divider with label, only when expanded */}
      {!collapsed && (
        <div className="px-4 pt-5 pb-1.5">
          <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground/70">
            System
          </span>
        </div>
      )}
      {collapsed && <div className="my-3 mx-3 border-t border-sidebar-border" />}

      {/* Secondary nav — the settings/plumbing chunk */}
      <nav className="app-no-drag flex flex-col gap-0.5 px-2 mb-2">
        {NAV_SECONDARY.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={item.id === screen}
            collapsed={collapsed}
            onClick={() => onChange(item.id)}
            badgeDot={item.id === 'help' && helpHasUnread}
          />
        ))}
      </nav>

      {/* Spacer so footer + collapse-button anchor to the bottom */}
      <div className="flex-1" />

      {/* Collapse toggle */}
      <button
        type="button"
        onClick={toggle}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className={cn(
          'app-no-drag mx-2 mb-1 flex h-7 items-center rounded-md text-[11px] text-muted-foreground/70 transition-colors',
          'hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
          collapsed ? 'justify-center px-0' : 'gap-2 px-2.5',
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

      {/* Status footer — the persistent "what is the runtime doing?" line */}
      <div
        className={cn(
          'app-no-drag border-t border-sidebar-border py-3',
          collapsed ? 'px-2 grid place-items-center' : 'px-4',
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

function NavButton({
  item,
  active,
  collapsed,
  onClick,
  badgeDot,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
  badgeDot?: boolean;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${item.label} (⌘${item.shortcut})`}
      className={cn(
        'group relative flex items-center rounded-lg text-[13px] font-medium transition-all duration-150',
        collapsed ? 'h-9 justify-center px-0' : 'gap-2.5 px-2.5 py-2',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground shadow-xs'
          : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
      )}
    >
      {/* Left accent bar when active — gives the active state weight without recolouring everything */}
      {active && !collapsed && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full"
          style={{ backgroundImage: 'var(--gradient-brand)' }}
        />
      )}
      <Icon
        className={cn(
          'size-[15px] shrink-0 transition-colors',
          active && 'text-foreground',
        )}
      />
      {!collapsed && (
        <>
          <span className="flex-1 text-left truncate">{item.label}</span>
          <span
            className={cn(
              'rounded border border-sidebar-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-mono leading-none text-muted-foreground/70 transition-opacity',
              active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            )}
          >
            {`⌘${item.shortcut}`}
          </span>
        </>
      )}
      {badgeDot && (
        <span
          className={cn(
            'absolute size-2 rounded-full bg-primary',
            collapsed ? 'top-1.5 right-1.5' : 'top-2 right-2',
          )}
        />
      )}
    </button>
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
