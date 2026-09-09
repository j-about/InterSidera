import { cx } from './cx';

// A labelled range input (plan D112): `<label htmlFor>` names it, the current value is shown in
// an `<output>` bound to it and read through `aria-valuetext` (the formatted text, not the raw
// number), so a percentage or a magnitude reads as such.

export interface SliderProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  /** Text of the value for the output and `aria-valuetext` (default: the plain number). */
  format?: (value: number) => string;
  disabled?: boolean;
  className?: string;
}

export default function Slider({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
  format = String,
  disabled = false,
  className,
}: SliderProps) {
  const text = format(value);
  return (
    <div className={cx('flex items-center gap-2 text-sm text-panel-fg', className)}>
      <label htmlFor={id} className="whitespace-nowrap">
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={text}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          if (Number.isFinite(next)) {
            onChange(next);
          }
        }}
        className="min-h-6 w-28 accent-accent disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11"
      />
      <output htmlFor={id} className="min-w-10 text-right text-xs text-muted tabular-nums">
        {text}
      </output>
    </div>
  );
}
