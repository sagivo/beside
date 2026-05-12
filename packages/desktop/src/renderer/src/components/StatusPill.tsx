import * as React from 'react';
import { cn } from '@/lib/utils';

export function StatusPill({
  tone,
  pulse = false,
  size = 'default',
  children,
}: {
  tone: 'success' | 'warning' | 'muted';
  pulse?: boolean;
  size?: 'default' | 'compact';
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full text-[11px] font-medium',
        size === 'default' ? 'gap-1.5 px-2.5 py-1' : 'gap-1 px-2 py-0.5',
        tone === 'success' && 'bg-success/15 text-success',
        tone === 'warning' && 'bg-warning/15 text-warning',
        tone === 'muted' && 'bg-muted text-muted-foreground',
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          tone === 'success' && 'bg-success',
          tone === 'warning' && 'bg-warning',
          tone === 'muted' && 'bg-muted-foreground/60',
          pulse && 'animate-pulse',
        )}
      />
      {children}
    </span>
  );
}
