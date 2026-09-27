import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { cx } from './cx';

// A toggle (plan D112): a `<button role="switch">` carrying `aria-checked`, named by its visible
// label, with the state also written as text ("On"/"Off") and shown by the thumb position, so
// nothing depends on colour alone (UX-4). The native button gives Space/Enter for free. WCAG 2.5.3
// label in name (plan D157 C4): the accessible name is the label alone, the state reaches
// assistive technology through `aria-checked`, and a voice-control user says the visible label
// without "On" or "Off". The state text therefore sits OUTSIDE the button, as an `aria-hidden`
// sibling in the wrapping `span`: axe's `label-content-name-mismatch` compares the name with the
// text visible on screen inside the control, and `aria-hidden` text is still visible on screen,
// so a state word inside the button would read as a label the name lacks (verified against
// axe-core 4.13: `visibleVirtual(node, screenReader = false)`). The wrapper takes the callers'
// layout classes (`w-full justify-between`); the button grows to the wrapper's width.

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

/** The state word beside the button: dimmed with a disabled switch, like the button itself. */
function stateClass(disabled: boolean): string {
  return disabled
    ? 'w-6 text-left text-xs text-muted opacity-50'
    : 'w-6 text-left text-xs text-muted';
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
    <span className={cx('inline-flex items-center gap-2', className)}>
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
        className="inline-flex min-h-6 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1 text-sm text-panel-fg select-none hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11"
      >
        <span id={labelId}>{label}</span>
        <span aria-hidden="true" className={trackClass(checked)}>
          <span className={thumbClass(checked)} />
        </span>
      </button>
      <span aria-hidden="true" className={stateClass(disabled)}>
        {checked ? t('common.on') : t('common.off')}
      </span>
    </span>
  );
}
