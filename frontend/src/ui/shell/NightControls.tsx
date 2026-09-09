import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { NIGHT_LEVEL_MAX, NIGHT_LEVEL_MIN } from '../../state/store';
import type { SkyStore } from '../../state/storeTypes';
import Slider from '../components/Slider';
import Switch from '../components/Switch';

// Night mode (UX-3, plan D108): the switch writes `options.night`, the brightness slider (shown
// while night is on) writes `options.nightLevel` in `[0.3, 1]`; `state/domSync.ts` mirrors both
// onto `<html>` and the shaders read them through the store. The level reads as a percentage.

export interface NightControlsProps {
  store: SkyStore;
}

export default function NightControls({ store }: NightControlsProps) {
  const { t, i18n } = useTranslation();
  const { night, level } = useStore(
    store,
    useShallow((s) => ({ night: s.options.night, level: s.options.nightLevel })),
  );
  const { actions } = store.getState();
  const percent = new Intl.NumberFormat(i18n.language, {
    style: 'percent',
    maximumFractionDigits: 0,
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Switch
        label={t('night.toggle')}
        checked={night}
        onChange={(on) => {
          actions.setOptions({ night: on });
        }}
      />
      {night && (
        <Slider
          id="night-brightness"
          label={t('night.brightness')}
          value={level}
          min={NIGHT_LEVEL_MIN}
          max={NIGHT_LEVEL_MAX}
          step={0.01}
          format={(value) => percent.format(value)}
          onChange={(value) => {
            actions.setNightLevel(value);
          }}
        />
      )}
    </div>
  );
}
