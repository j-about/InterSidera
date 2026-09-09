import { cx } from './cx';

// A native `<select>` with its `<label>` (plan D112): the platform widget is keyboard-operable,
// announced and themed by `color-scheme` for free, so no custom listbox is built for a list.

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  id: string;
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  describedBy?: string;
  /** Hide the label visually (it stays the accessible name) when the context already names it. */
  hideLabel?: boolean;
  className?: string;
}

export default function Select<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
  describedBy,
  hideLabel = false,
  className,
}: SelectProps<T>) {
  return (
    <div className={cx('flex items-center gap-2 text-sm text-panel-fg', className)}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'whitespace-nowrap'}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => {
          // No cast: the chosen option carries the typed value.
          const chosen = options.find((option) => option.value === event.currentTarget.value);
          if (chosen !== undefined) {
            onChange(chosen.value);
          }
        }}
        className="min-h-6 rounded-md border border-muted/60 bg-field-bg px-2 py-1 text-panel-fg disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
