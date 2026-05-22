import { Loader2, Pause, Play } from 'lucide-react';
import type { RuntimeOverview } from '@/global';
import { indexingStatusText } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Persistent status row at the bottom of the sidebar. Shows what the
 * runtime is doing and — when capture is running — doubles as the
 * pause/resume control so the user always has it at the bottom-left of
 * the window without having to navigate to Today.
 */
export function StatusFooter({
  overview,
  onPause,
  onResume,
}: {
  overview: RuntimeOverview | null;
  onPause?: () => Promise<void> | void;
  onResume?: () => Promise<void> | void;
}) {
  const captureLive = !!overview?.capture.running && !overview.capture.paused;
  const capturePaused = !!overview?.capture.running && !!overview.capture.paused;
  const indexing = !!overview?.indexing.running;

  let label = 'Not capturing';
  if (indexing) label = indexingStatusText(overview!.indexing);
  else if (captureLive) label = 'Capturing now';
  else if (capturePaused) label = 'Capture paused';

  const handleClick = () => {
    if (captureLive) void onPause?.();
    else if (capturePaused) void onResume?.();
  };
  const actionable = captureLive || capturePaused;
  const actionLabel = captureLive ? 'Pause capture' : 'Resume capture';

  const dot = indexing ? (
    <Loader2 className="size-3 animate-spin text-primary" />
  ) : (
    <span className="relative grid place-items-center size-2.5">
      <span
        className={cn(
          'size-2 rounded-full',
          captureLive && 'bg-success',
          capturePaused && 'bg-warning',
          !captureLive && !capturePaused && 'bg-muted-foreground/40',
        )}
      />
      {captureLive && (
        <span className="absolute inset-0 rounded-full bg-success/40 animate-ping" />
      )}
    </span>
  );

  if (!actionable) {
    return (
      <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
        {dot}
        <span className="truncate">{label}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={`${actionLabel} (⌘.)`}
      aria-label={actionLabel}
      className={cn(
        'group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[11px] font-medium text-muted-foreground transition-colors',
        'hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
      )}
    >
      {dot}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span
        className={cn(
          'grid size-5 shrink-0 place-items-center rounded-md border text-foreground/80 transition-all',
          captureLive
            ? 'border-success/35 bg-success/10 group-hover:bg-success/20'
            : 'border-warning/40 bg-warning/15 group-hover:bg-warning/25',
        )}
      >
        {captureLive ? <Pause className="size-2.5" /> : <Play className="size-2.5" />}
      </span>
    </button>
  );
}
