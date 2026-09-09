import { Minus, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { observerCoverage, withinCoverage } from '../../state/coverage';
import type { SkyStore } from '../../state/storeTypes';
import type { StepUnit } from '../../state/types';
import { stepDeltaOf, stepTargetTt, stepUnitsFor } from '../../state/timeDisplay';
import IconButton from '../components/IconButton';
import Select from '../components/Select';
import type { SelectOption } from '../components/Select';

// Time steps (TIME-3, brief l.203; plan D99): one row per unit (minute, hour, day, the sidereal
// day on Earth only, the calendar year) with a back and a forward button calling `stepTime`
// (the mode is kept: paused stays paused, playing keeps its speed, live plays on at 1x), each
// disabled when the step would leave the coverage (computed with the step's own rule, the
// calendar year included); and the unit `[` / `]` step by (`ui.stepUnit`).

export interface StepButtonsProps {
  store: SkyStore;
}

export default function StepButtons({ store }: StepButtonsProps) {
  const { t } = useTranslation();
  const { tt, ttMinusUtc, body, meta, stepUnit } = useStore(
    store,
    useShallow((s) => ({
      tt: s.clock.tt,
      ttMinusUtc: s.clock.ttMinusUtc,
      body: s.observer.body,
      meta: s.meta,
      stepUnit: s.ui.stepUnit,
    })),
  );
  const { actions } = store.getState();
  const units = stepUnitsFor(body);
  const coverage = observerCoverage(meta, body);
  const options: SelectOption<StepUnit>[] = units.map((unit) => ({
    value: unit,
    label: t(`time.step.${unit}`),
  }));
  const selected: StepUnit = units.includes(stepUnit) ? stepUnit : 'hour';

  const outside = (unit: StepUnit, direction: 1 | -1): boolean => {
    if (coverage === null || !Number.isFinite(tt)) {
      return false;
    }
    return !withinCoverage(stepTargetTt(tt, stepDeltaOf(unit, direction), ttMinusUtc), coverage);
  };

  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
      <legend className="text-sm font-semibold">{t('time.stepLegend')}</legend>
      <ul className="flex flex-col gap-0.5">
        {units.map((unit) => (
          <li key={unit} className="flex items-center gap-1 text-sm">
            <span className="flex-1">{t(`time.step.${unit}`)}</span>
            <IconButton
              icon={Minus}
              label={t('time.stepBack', { unit: t(`time.step.${unit}`) })}
              size="sm"
              disabled={outside(unit, -1)}
              onClick={() => {
                actions.stepTime(stepDeltaOf(unit, -1));
              }}
            />
            <IconButton
              icon={Plus}
              label={t('time.stepForward', { unit: t(`time.step.${unit}`) })}
              size="sm"
              disabled={outside(unit, 1)}
              onClick={() => {
                actions.stepTime(stepDeltaOf(unit, 1));
              }}
            />
          </li>
        ))}
      </ul>
      <Select
        id="step-unit"
        label={t('time.stepUnit')}
        value={selected}
        options={options}
        onChange={(unit) => {
          actions.setUi({ stepUnit: unit });
        }}
      />
    </fieldset>
  );
}
