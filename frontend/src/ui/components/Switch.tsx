import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { cx } from './cx';

// A toggle (plan D112): a `<button role="switch">` carrying `aria-checked`, named by its visible
// label, with the state also written as text ("On"/"Off") and shown by the thumb position, so
// nothing depends on colour alone (UX-4). The native button gives Space/Enter for free.

export interface SwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Id of the element explaining a disabled switch (UX-6 "layer disabled with a reason"). */
  describedBy?: string;
  className?: string;
}

/** Complete literal class strings (brief l.550). */
function trackClass(checked: boolean): string {
  return checked
    ? 'relative inline-block h-4 w-7 shrink-0 rounded-full bg-accent'
    : 'relative inline-block h-4 w-7 shrink-0 rounded-full bg-muted/60';
}

function thumbClass(checked: boolean): string {
  return checked
    ? 'absolute top-0.5 left-0.5 size-3 translate-x-3 rounded-full bg-on-accent transition-transform motion-reduce:transition-none'
    : 'absolute top-0.5 left-0.5 size-3 translate-x-0 rounded-full bg-panel-fg transition-transform motion-reduce:transition-none';
}

export default function Switch({
  label,
  checked,
  onChange,
  disabled = false,
  describedBy,
  className,
}: SwitchProps) {
  const { t } = useTranslation();
  const labelId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => {
        onChange(!checked);
      }}
      className={cx(
        'inline-flex min-h-6 items-center gap-2 rounded-md px-2 py-1 text-sm text-panel-fg select-none hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11',
        className,
      )}
    >
      <span id={labelId}>{label}</span>
      <span aria-hidden="true" className={trackClass(checked)}>
        <span className={thumbClass(checked)} />
      </span>
      <span className="w-6 text-left text-xs text-muted">
        {checked ? t('common.on') : t('common.off')}
      </span>
    </button>
  );
}
