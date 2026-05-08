import { Loader2 } from 'lucide-react';
import type { RuntimeOverview } from '@/global';
import { indexingStatusText } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Persistent status pill at the bottom of the sidebar. Reads as a single
 * line: "● Capturing now" / "○ Not capturing" / spinner + index task.
 *
 * Switched from raw text to a slightly more refined pill — the dot has a
 * matching halo when capture is live so the status reads at a glance even
 * out of the corner of your eye.
 */
export function StatusFooter({ overview }: { overview: RuntimeOverview | null }) {
  const captureLive = !!overview?.capture.running && !overview.capture.paused;
  const capturePaused = !!overview?.capture.running && !!overview.capture.paused;
  const indexing = !!overview?.indexing.running;

  let label = 'Not capturing';
  if (indexing) label = indexingStatusText(overview!.indexing);
  else if (captureLive) label = 'Capturing now';
  else if (capturePaused) label = 'Capture paused';

  return (
    <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
      {indexing ? (
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
      )}
      <span className="truncate">{label}</span>
    </div>
  );
}
