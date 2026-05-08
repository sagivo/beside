import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Page header — the leading row of every screen.
 *
 * - Title is large and tight; supporting text is one calm line.
 * - Actions sit on the right and never crowd the title (wrap on narrow widths).
 * - An optional `eyebrow` slot lets a screen badge a small label above the
 *   title (e.g. "Today", "Live"). The big visual change vs. the old version
 *   is more breathing room and a slightly larger, weightier title to give
 *   each screen a clearer identity.
 */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'flex flex-wrap items-end justify-between gap-4 pb-1',
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <div className="mb-1 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="text-[28px] leading-[1.1] font-semibold tracking-tight">
          {title}
        </h1>
        {description ? (
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground leading-relaxed">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="app-no-drag flex flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
