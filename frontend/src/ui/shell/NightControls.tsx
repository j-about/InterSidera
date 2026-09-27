import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { formatPercent } from '../../i18n/format';
import { NIGHT_LEVEL_MAX, NIGHT_LEVEL_MIN } from '../../state/store';
import type { SkyStore } from '../../state/storeTypes';
import Slider from '../components/Slider';
import Switch from '../components/Switch';

// Night mode (UX-3, plan D108): the switch writes `options.night`, the brightness slider (shown
// while night is on) writes `options.nightLevel` in `[0.3, 1]`; `state/domSync.ts` mirrors both
// onto `<html>` and the shaders read them through the store. The level reads as a percentage
// through `format.ts::formatPercent`, the one `Intl` home of the UI (plan D159): it follows the
// resolved language, so the slider re-renders with the toggle like every other number.

export interface NightControlsProps {
  store: SkyStore;
}

export default function NightControls({ store }: NightControlsProps) {
  const { t } = useTranslation();
  const { night, level } = useStore(
    store,
    useShallow((s) => ({ night: s.options.night, level: s.options.nightLevel })),
  );
  const { actions } = store.getState();
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
          format={(value) => formatPercent(value)}
          onChange={(value) => {
            actions.setNightLevel(value);
          }}
        />
      )}
    </div>
  );
}
