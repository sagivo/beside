import { Loader2 } from 'lucide-react';
import type { RuntimeOverview } from '@/global';
import { indexingStatusText } from '@/lib/format';
import { cn } from '@/lib/utils';

export function StatusFooter({ overview }: { overview: RuntimeOverview | null }) {
  const captureLive = !!overview?.capture.running && !overview.capture.paused;
  const capturePaused = !!overview?.capture.running && !!overview.capture.paused;
  const indexing = !!overview?.indexing.running;

  let label = 'Not capturing';
  if (indexing) label = indexingStatusText(overview!.indexing);
  else if (captureLive) label = 'Capturing now';
  else if (capturePaused) label = 'Capture paused';

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {indexing ? (
        <Loader2 className="size-3 animate-spin text-primary" />
      ) : (
        <span
          className={cn(
            'size-2 rounded-full',
            captureLive && 'bg-success animate-pulse',
            capturePaused && 'bg-warning',
            !captureLive && !capturePaused && 'bg-muted-foreground/40',
          )}
        />
      )}
      <span className="truncate">{label}</span>
    </div>
  );
}
