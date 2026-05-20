import * as React from 'react';
import { Camera } from 'lucide-react';
import { cn } from '@/lib/utils';
import logoUrl from '@/assets/logo.png';

export type BrandMarkActivity = 'idle' | 'busy' | 'capture' | 'audio';

/**
 * Brand mark used in the sidebar header, About card, and onboarding header.
 *
 * Activity states layer concrete metaphors on top of the idle mascot:
 *   - capture: a small camera badge sits on the mark; a flash overlay fires
 *     each time `captureTick` increments (one new screen event captured).
 *   - audio:   an equalizer bar overlay bounces to indicate live listening.
 *   - busy:    the existing thinking halo from background indexing.
 */
export function BrandMark({
  className,
  busy = false,
  activity,
  captureTick = 0,
}: {
  className?: string;
  busy?: boolean;
  activity?: BrandMarkActivity;
  /** Monotonic counter of capture events; bumps trigger the flash. */
  captureTick?: number;
}) {
  const currentActivity: BrandMarkActivity = activity ?? (busy ? 'busy' : 'idle');
  const activityLabel = currentActivity === 'audio'
    ? 'Listening to audio'
    : currentActivity === 'capture'
      ? 'Capturing screen'
      : currentActivity === 'busy'
        ? 'Working'
        : undefined;

  // When a new screenshot is captured (captureTick increments), reveal the
  // camera badge + flash overlay for ~1.4s, then hide them again. Holding the
  // badge permanently on read as "always on" rather than "just took a shot".
  const [shotKey, setShotKey] = React.useState(0);
  const [shotActive, setShotActive] = React.useState(false);
  const lastTickRef = React.useRef(captureTick);
  React.useEffect(() => {
    if (currentActivity !== 'capture') {
      lastTickRef.current = captureTick;
      setShotActive(false);
      return;
    }
    if (captureTick <= lastTickRef.current) return;
    lastTickRef.current = captureTick;
    setShotKey((k) => k + 1);
    setShotActive(true);
    const t = window.setTimeout(() => setShotActive(false), 1400);
    return () => window.clearTimeout(t);
  }, [captureTick, currentActivity]);

  return (
    <div
      className={cn(
        'brand-mark group relative grid size-9 place-items-center overflow-visible rounded-xl',
        currentActivity === 'busy' && 'brand-mark-busy',
        className,
      )}
      aria-busy={currentActivity !== 'idle' || undefined}
      aria-label={activityLabel}
      title={activityLabel}
    >
      <img
        src={logoUrl}
        alt=""
        className={cn(
          'brand-mark-img relative z-[1] size-full overflow-hidden rounded-[inherit] object-contain p-1',
          currentActivity === 'busy' && 'brand-mark-img-busy',
        )}
      />

      {currentActivity === 'capture' && shotActive && (
        <React.Fragment key={shotKey}>
          <span aria-hidden className="brand-mark-flash" />
          <span aria-hidden className="brand-mark-camera-badge">
            <Camera className="size-3" strokeWidth={2.5} />
          </span>
        </React.Fragment>
      )}

      {currentActivity === 'audio' && (
        <span aria-hidden className="brand-mark-equalizer">
          <span />
          <span />
          <span />
          <span />
        </span>
      )}
    </div>
  );
}
