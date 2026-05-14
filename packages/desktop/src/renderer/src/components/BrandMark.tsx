import { cn } from '@/lib/utils';
import logoUrl from '@/assets/logo.png';

/**
 * Brand mark used in the sidebar header, About card, and onboarding header.
 *
 * When `busy` is true (e.g. background indexing is running) the logo gently
 * floats and a soft violet halo breathes behind it — a quiet "thinking"
 * cue that mirrors the AI-presence pulse on the marketing site, without
 * ever becoming distracting in the sidebar.
 */
export function BrandMark({
  className,
  busy = false,
}: {
  className?: string;
  busy?: boolean;
}) {
  return (
    <div
      className={cn(
        'relative grid size-9 place-items-center overflow-hidden rounded-xl',
        busy && 'brand-mark-busy',
        className,
      )}
      aria-busy={busy || undefined}
    >
      <img
        src={logoUrl}
        alt=""
        className={cn(
          'size-full object-contain p-1',
          busy && 'brand-mark-img-busy',
        )}
      />
    </div>
  );
}
