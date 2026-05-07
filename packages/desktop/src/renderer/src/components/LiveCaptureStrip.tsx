import * as React from 'react';
import { ImageOff, Mic, Radio } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useFrameDetail } from '@/components/FrameDetailDialog';
import { cacheThumbnail, resolveAssetUrl, thumbnailCache } from '@/lib/thumbnail-cache';
import { formatLocalTime, localDayKey } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Frame, RuntimeOverview } from '@/global';

const MAX_FRAMES = 5;

/**
 * Horizontal strip showing the most recently captured frames.
 *
 * Refreshes piggyback-style on the existing `overview` polling: we re-fetch
 * today's journal whenever `eventsToday` increments, instead of running a
 * second timer. Only renders when capture is live and we have frames; in all
 * other states we render nothing so the dashboard stays compact.
 */
export function LiveCaptureStrip({
  overview,
  onGoTimeline,
}: {
  overview: RuntimeOverview;
  onGoTimeline: () => void;
}) {
  const captureLive = overview.capture.running && !overview.capture.paused;
  const eventsToday = overview.capture.eventsToday;
  const [frames, setFrames] = React.useState<Frame[] | null>(null);
  const lastSeenCountRef = React.useRef<number>(-1);

  React.useEffect(() => {
    if (!captureLive) {
      lastSeenCountRef.current = -1;
      return;
    }
    if (eventsToday === lastSeenCountRef.current) return;
    lastSeenCountRef.current = eventsToday;

    let cancelled = false;
    (async () => {
      try {
        const today = localDayKey();
        const recent = await window.cofounderos.searchFrames({
          day: today,
          limit: MAX_FRAMES,
        });
        if (cancelled) return;
        setFrames(recent);
      } catch {
        if (!cancelled) setFrames([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [captureLive, eventsToday]);

  if (!captureLive) return null;
  if (frames === null) {
    return (
      <Card>
        <CardContent>
          <Header />
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-3">
            {Array.from({ length: MAX_FRAMES }).map((_, i) => (
              <Skeleton key={i} className="aspect-video rounded-md" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }
  if (frames.length === 0) return null;

  return (
    <Card>
      <CardContent>
        <Header onJump={onGoTimeline} />
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-3">
          {frames.map((frame, i) => (
            <LiveFrame key={frame.id ?? i} frame={frame} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Header({ onJump }: { onJump?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <span className="relative grid place-items-center size-6 rounded-full bg-success/15 text-success">
          <Radio className="size-3.5" />
          <span className="absolute inset-0 rounded-full bg-success/30 animate-ping" />
        </span>
        <h3 className="text-sm font-medium">Just captured</h3>
      </div>
      {onJump ? (
        <button
          type="button"
          onClick={onJump}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          See all →
        </button>
      ) : null}
    </div>
  );
}

function LiveFrame({ frame }: { frame: Frame }) {
  const [thumbUrl, setThumbUrl] = React.useState<string | null>(null);
  const detail = useFrameDetail();
  const isAudio = frame.text_source === 'audio' || frame.app === 'Audio';

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!frame.asset_path) {
        setThumbUrl(null);
        return;
      }
      const cached = thumbnailCache.get(frame.asset_path);
      if (cached) {
        setThumbUrl(cached);
        return;
      }
      try {
        const url = await resolveAssetUrl(frame.asset_path);
        if (cancelled) return;
        cacheThumbnail(frame.asset_path, url);
        setThumbUrl(url);
      } catch {
        setThumbUrl(null);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [frame.asset_path]);

  const time = formatLocalTime(frame.timestamp);

  return (
    <button
      type="button"
      onClick={() => detail.open(frame)}
      className={cn(
        'group relative aspect-video rounded-md overflow-hidden border bg-muted/40 transition-all',
        'hover:border-primary/40 hover:shadow-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
      )}
    >
      {thumbUrl ? (
        <img
          src={thumbUrl}
          alt=""
          className="size-full object-cover transition-transform group-hover:scale-[1.04]"
        />
      ) : (
        <div className="size-full grid place-items-center text-muted-foreground">
          {isAudio ? <Mic className="size-5" /> : <ImageOff className="size-5" />}
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1 text-[10px] text-white flex items-center justify-between">
        <span className="font-mono">{time || '—'}</span>
        <span className="truncate ml-2 text-white/90">{frame.app || ''}</span>
      </div>
    </button>
  );
}
