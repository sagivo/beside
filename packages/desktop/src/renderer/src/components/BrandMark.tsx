import { cn } from '@/lib/utils';
import logoUrl from '@/assets/logo.png';

export type BrandMarkActivity = 'idle' | 'busy' | 'capture' | 'audio';

/**
 * Brand mark used in the sidebar header, About card, and onboarding header.
 *
 * Activity modes let the mascot act as an ambient status cue without adding
 * more chrome to the sidebar: thinking, screen capture, or audio listening.
 */
export function BrandMark({
  className,
  busy = false,
  activity,
}: {
  className?: string;
  busy?: boolean;
  activity?: BrandMarkActivity;
}) {
  const currentActivity: BrandMarkActivity = activity ?? (busy ? 'busy' : 'idle');
  const activityLabel = currentActivity === 'audio'
    ? 'Listening to audio'
    : currentActivity === 'capture'
      ? 'Capturing screen'
      : currentActivity === 'busy'
        ? 'Working'
        : undefined;

  return (
    <div
      className={cn(
        'brand-mark group relative grid size-9 place-items-center overflow-hidden rounded-xl',
        currentActivity !== 'idle' && `brand-mark-${currentActivity}`,
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
          'brand-mark-img size-full object-contain p-1',
          currentActivity !== 'idle' && `brand-mark-img-${currentActivity}`,
        )}
      />
    </div>
  );
}
