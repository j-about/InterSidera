import type { LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

import { cx } from './cx';

// An icon-only button (plan D91, D112): the `label` is required and becomes the button's
// `aria-label` (and its tooltip); the icon stays `aria-hidden`, which lucide applies by default
// when no `aria-*`, `role` or `title` prop reaches it, so the name is never doubled.

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'aria-label' | 'children'
> {
  label: string;
  icon: LucideIcon;
  size?: 'sm' | 'md';
}

const BASE =
  'inline-flex shrink-0 items-center justify-center rounded-md text-panel-fg select-none hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:bg-accent/30 aria-expanded:bg-accent/15 motion-reduce:transition-none transition-colors';

/** 24 px targets minimum (WCAG 2.2 SC 2.5.8), 44 px on coarse pointers. */
function sizeClass(size: 'sm' | 'md'): string {
  return size === 'sm' ? 'size-7 pointer-coarse:size-11' : 'size-9 pointer-coarse:size-11';
}

export default function IconButton({
  label,
  icon: Icon,
  size = 'md',
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(BASE, sizeClass(size), className)}
      {...rest}
    >
      <Icon size={size === 'sm' ? 16 : 20} />
    </button>
  );
}
