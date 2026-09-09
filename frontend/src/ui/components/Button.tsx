import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cx } from './cx';

// The text button (plan D112): always `type="button"` (never a form submit by accident), a
// target of at least 24 x 24 CSS pixels (WCAG 2.2 SC 2.5.8) that grows to 44 px on coarse
// pointers, visible focus from the base `:focus-visible` rule.

export type ButtonVariant = 'ghost' | 'primary' | 'outline';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  /** A `type="submit"` button belongs to a form (the geocoder); every other button is plain. */
  type?: 'button' | 'submit';
  children: ReactNode;
}

const BASE =
  'inline-flex min-h-6 min-w-6 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap select-none pointer-coarse:min-h-11 disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 motion-reduce:transition-none transition-colors';

/** Complete literal class strings per variant (brief l.550). */
function variantClass(variant: ButtonVariant): string {
  switch (variant) {
    case 'primary':
      return 'bg-accent text-on-accent hover:bg-accent/85 aria-pressed:bg-accent';
    case 'outline':
      return 'border border-muted/60 text-panel-fg hover:bg-accent/15 aria-pressed:border-accent aria-pressed:bg-accent/30';
    default:
      return 'text-panel-fg hover:bg-accent/15 aria-pressed:bg-accent/30';
  }
}

export default function Button({
  variant = 'ghost',
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button type={type} className={cx(BASE, variantClass(variant), className)} {...rest}>
      {children}
    </button>
  );
}
