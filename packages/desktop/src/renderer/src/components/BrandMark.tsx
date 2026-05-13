import { cn } from '@/lib/utils';
import logoUrl from '@/assets/logo.png';

/**
 * Brand mark used in the sidebar header, About card, and onboarding header.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'relative grid size-9 place-items-center overflow-hidden rounded-xl bg-white/80 shadow-raised ring-1 ring-border/50',
        className,
      )}
    >
      <img src={logoUrl} alt="" className="size-full object-contain p-1" />
    </div>
  );
}
