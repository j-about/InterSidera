import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';

import type { SkyStore } from '../../state/storeTypes';
import Button from '../components/Button';

// Field-of-view presets (VIEW-2 [S], plan D112): naked eye 60 degrees, binoculars 7 degrees,
// telescope 1 degree, as `aria-pressed` buttons in a `<fieldset>`. The visible text is the
// angle, the accessible name spells the instrument and repeats the angle (WCAG 2.5.3). The
// selector returns the index of the pressed preset, so the camera's `view` writes at animation
// rate re-render nothing until the pressed state actually changes.

export interface FovPresetsProps {
  store: SkyStore;
}

const PRESETS_DEG = [60, 7, 1] as const;
/** A preset reads as pressed within this distance of its angle, degrees. */
const TOLERANCE_DEG = 0.05;

export function pressedPreset(fov: number): number {
  return PRESETS_DEG.findIndex((preset) => Math.abs(fov - preset) < TOLERANCE_DEG);
}

export default function FovPresets({ store }: FovPresetsProps) {
  const { t } = useTranslation();
  const pressed = useStore(store, (s) => pressedPreset(s.view.fov));
  const { actions } = store.getState();
  // Literal keys so `scripts/check_i18n.mjs` sees every one (rules/frontend.md).
  const labels = [t('fov.naked'), t('fov.binoculars'), t('fov.telescope')] as const;
  return (
    <fieldset className="m-0 flex items-center gap-0.5 border-0 p-0">
      <legend className="sr-only">{t('fov.legend')}</legend>
      {PRESETS_DEG.map((fov, index) => (
        <Button
          key={fov}
          variant="outline"
          aria-pressed={pressed === index}
          aria-label={labels[index]}
          title={labels[index]}
          className="px-2 tabular-nums"
          onClick={() => {
            actions.setView({ fov });
          }}
        >
          {`${String(fov)}°`}
        </Button>
      ))}
    </fieldset>
  );
}
