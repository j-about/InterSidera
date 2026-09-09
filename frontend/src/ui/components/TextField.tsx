import type { InputHTMLAttributes } from 'react';

import { cx } from './cx';

// A labelled text input (plan D112): the hint and the error are tied to the input through
// `aria-describedby`, an error also sets `aria-invalid` and is announced through `role="alert"`
// (WCAG 3.3.1), and nothing but text signals the state.

export interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'aria-describedby' | 'aria-invalid' | 'onChange' | 'className'
> {
  id: string;
  label: string;
  /** Always-visible help under the field. */
  hint?: string;
  /** The current validation error, `null` or `undefined` when the value is valid. */
  error?: string | null;
  onValueChange?: (value: string) => void;
  /** Hide the label visually (it stays the accessible name). */
  hideLabel?: boolean;
  className?: string;
  inputClassName?: string;
}

/** Complete literal class strings (brief l.550). */
function inputClass(invalid: boolean): string {
  return invalid
    ? 'min-h-6 w-full rounded-md border border-danger bg-field-bg px-2 py-1 text-sm text-panel-fg pointer-coarse:min-h-11 disabled:cursor-not-allowed disabled:opacity-50'
    : 'min-h-6 w-full rounded-md border border-muted/60 bg-field-bg px-2 py-1 text-sm text-panel-fg pointer-coarse:min-h-11 disabled:cursor-not-allowed disabled:opacity-50';
}

export default function TextField({
  id,
  label,
  hint,
  error,
  onValueChange,
  hideLabel = false,
  className,
  inputClassName,
  ...rest
}: TextFieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const invalid = typeof error === 'string' && error !== '';
  const describedBy =
    [hint !== undefined ? hintId : null, invalid ? errorId : null]
      .filter((part) => part !== null)
      .join(' ') || undefined;
  return (
    <div className={cx('flex flex-col gap-1 text-sm text-panel-fg', className)}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'font-medium'}>
        {label}
      </label>
      <input
        id={id}
        aria-describedby={describedBy}
        aria-invalid={invalid ? true : undefined}
        onChange={(event) => {
          onValueChange?.(event.currentTarget.value);
        }}
        className={cx(inputClass(invalid), inputClassName)}
        {...rest}
      />
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {invalid && (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
