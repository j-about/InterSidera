import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { speedParts } from '../../state/timeDisplay';
import Select from '../components/Select';
import type { SelectOption } from '../components/Select';

// The time-lapse speed (TIME-3, brief l.203; plan D99): a native select over the signed speed
// list of `/meta.limits.speeds` (mirrored to negatives), each entry labelled by the unit it
// advances per real second (`1 h/s`, `1 day/s, backward`), plus "Paused" for 0 and the current
// speed when it is not in the list (a URL `speed=100`). Choosing a speed plays at it.

export interface SpeedSelectProps {
  id: string;
  /** The signed list, ascending (`timeDisplay.ts::speedList`). */
  speeds: readonly number[];
  /** The current speed: 0 while paused, 1 while live. */
  value: number;
  onChange: (speed: number) => void;
  className?: string;
}

/** `1 h/s`, `10 min/s, backward`, `Paused`: the option label of a speed. */
export function speedLabel(t: TFunction, speed: number): string {
  if (speed === 0) {
    return t('time.paused');
  }
  const { unit, count, backward } = speedParts(speed);
  const forward = t(`time.speedUnit.${unit}`, { count });
  return backward ? t('time.backward', { speed: forward }) : forward;
}

export default function SpeedSelect({ id, speeds, value, onChange, className }: SpeedSelectProps) {
  const { t } = useTranslation();
  const values = speeds.includes(value) ? [...speeds] : [...speeds, value].sort((a, b) => a - b);
  // The "Paused" entry sits between backward and forward speeds when the clock is paused.
  if (value === 0 && !values.includes(0)) {
    const firstForward = values.findIndex((s) => s > 0);
    values.splice(firstForward === -1 ? values.length : firstForward, 0, 0);
  }
  const options: SelectOption<string>[] = values.map((speed) => ({
    value: String(speed),
    label: speedLabel(t, speed),
  }));
  return (
    <Select
      id={id}
      label={t('time.speed')}
      hideLabel
      value={String(value)}
      options={options}
      onChange={(text) => {
        onChange(Number(text));
      }}
      {...(className === undefined ? {} : { className })}
    />
  );
}
