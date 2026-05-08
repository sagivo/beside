import { cn } from '@/lib/utils';

/**
 * Brand mark — an indigo-violet gradient tile with a stylized "infinity / second
 * brain" glyph. Replaces the previous flat-primary square. Used in the sidebar
 * header, in the About card, and as a decorative anchor in hero panels.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'relative grid size-9 place-items-center rounded-xl text-white shadow-raised overflow-hidden',
        className,
      )}
      style={{ backgroundImage: 'var(--gradient-brand)' }}
    >
      {/* Subtle inner highlight for depth */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-xl"
        style={{
          background:
            'linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 60%)',
        }}
      />
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="relative drop-shadow-sm"
      >
        {/* Two interlocked petals → memory / second brain */}
        <path d="M12 4c-3 0-5 2-5 4.5S9 13 12 13s5-2 5-4.5S15 4 12 4Z" />
        <path d="M12 11c-3 0-5 2-5 4.5S9 20 12 20s5-2 5-4.5S15 11 12 11Z" />
        <circle cx="12" cy="12" r="0.9" fill="currentColor" />
      </svg>
    </div>
  );
}
