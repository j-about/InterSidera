import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cx } from './cx';

// A small inline marker (TIME-4 warning badges, snapshot mode, ...): an icon and a text, never a
// colour alone (UX-4). Purely presentational; the parent decides whether it is live.

export type BadgeTone = 'muted' | 'accent' | 'warn' | 'danger';

export interface BadgeProps {
  icon: LucideIcon;
  children: ReactNode;
  tone?: BadgeTone;
  /** Longer explanation shown as a tooltip. */
  title?: string;
  className?: string;
}

/** Complete literal class strings (brief l.550). */
function toneClass(tone: BadgeTone): string {
  switch (tone) {
    case 'accent':
      return 'border-accent/60 text-accent';
    case 'warn':
      return 'border-warn/60 text-warn';
    case 'danger':
      return 'border-danger/60 text-danger';
    default:
      return 'border-muted/60 text-muted';
  }
}

export default function Badge({
  icon: Icon,
  children,
  tone = 'muted',
  title,
  className,
}: BadgeProps) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs whitespace-nowrap',
        toneClass(tone),
        className,
      )}
    >
      <Icon size={12} />
      {children}
    </span>
  );
}
