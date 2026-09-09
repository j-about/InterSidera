import { PinOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { formatNumber } from '../../i18n/format';
import type { SkyStore } from '../../state/storeTypes';
import { DSO_TYPES, LAYER_IDS } from '../../state/types';
import type { DsoType, Ground, LabelDensity, LayerId } from '../../state/types';
import Button from '../components/Button';
import IconButton from '../components/IconButton';
import Select from '../components/Select';
import Slider from '../components/Slider';
import Switch from '../components/Switch';
import CoverageBadges from '../time/CoverageBadges';
import VisibleObjects from './VisibleObjects';

// The layers panel (SKY-1..SKY-7, VIEW-3, UX-6; plan D102, D111): one switch per layer of the
// URL `layers` list, disabled with a readable reason (`aria-describedby`) when its data group is
// missing on the server, with the coverage warnings aimed at a layer beside it (TIME-4, plan
// D100: `proper_motion_extrapolated` under the switches, the `mpc_*` codes with the objects they
// concern in the minor-body section); the pinned minor bodies and "show more"; the manual magnitude limit
// (`maglim`, `null` = automatic); the deep-sky type filter (`dso`, every type = `null`); the
// ground, the atmosphere and the refraction (Earth only); the label density and the visible
// objects as text (UX-4). Every control writes the store; the engine reads it.

export interface LayersPanelProps {
  store: SkyStore;
}

/** The magnitude the manual limit starts at when switched on (a dark suburban naked-eye sky). */
export const MANUAL_MAGLIM_DEFAULT = 6.5;
export const MAGLIM_MIN = -2;
export const MAGLIM_MAX = 15;

const DSO_LAYERS: readonly LayerId[] = ['dso'];
const CONSTELLATION_LAYERS: readonly LayerId[] = ['clines', 'cnames', 'cbounds'];

const DENSITIES: readonly LabelDensity[] = [0, 1, 2, 3];

function isLabelDensity(value: number): value is LabelDensity {
  return (DENSITIES as readonly number[]).includes(value);
}

export default function LayersPanel({ store }: LayersPanelProps) {
  const { t } = useTranslation();
  const {
    layers,
    options,
    dsoTypes,
    catalogs,
    minorAvailable,
    onEarth,
    pins,
    defaults,
    shown,
    minorStatuses,
  } = useStore(
    store,
    useShallow((s) => ({
      layers: s.layers,
      options: s.options,
      dsoTypes: s.dsoTypes,
      catalogs: s.catalogs,
      // `null` until `/meta` answers: the switch waits, without announcing the data as missing.
      minorAvailable:
        s.meta === null
          ? null
          : s.meta.catalogs.minor_bodies !== undefined && s.meta.catalogs.minor_bodies !== null,
      onEarth: s.observer.body === 'earth',
      pins: s.minor,
      defaults: s.minorBodies.defaults,
      shown: s.minorBodies.shown,
      minorStatuses: s.frames.minor,
    })),
  );
  const { actions } = store.getState();

  const dsoMissing = catalogs.dso === 'missing';
  const constellationsMissing = catalogs.constellations === 'missing';

  /** The reason element a disabled layer switch points at, when there is one. */
  const reasonId = (id: LayerId): string | undefined => {
    if (DSO_LAYERS.includes(id) && dsoMissing) {
      return 'layers-reason-dso';
    }
    if (CONSTELLATION_LAYERS.includes(id) && constellationsMissing) {
      return 'layers-reason-constellations';
    }
    if (id === 'minor' && minorAvailable === false) {
      return 'layers-reason-minor';
    }
    return undefined;
  };
  const layerDisabled = (id: LayerId): boolean =>
    reasonId(id) !== undefined || (id === 'minor' && minorAvailable === null);

  const selectedDso: readonly DsoType[] = dsoTypes ?? DSO_TYPES;
  const toggleDso = (type: DsoType, on: boolean): void => {
    const next = new Set<DsoType>(selectedDso);
    if (on) {
      next.add(type);
    } else {
      next.delete(type);
    }
    actions.setDsoTypes(
      next.size === DSO_TYPES.length ? null : DSO_TYPES.filter((x) => next.has(x)),
    );
  };

  const densityText = (value: number): string => {
    switch (value) {
      case 0:
        return t('layers.density0');
      case 1:
        return t('layers.density1');
      case 2:
        return t('layers.density2');
      default:
        return t('layers.density3');
    }
  };

  const minorName = (id: string): string =>
    defaults?.find((entry) => entry.id === id)?.name ??
    minorStatuses.find((status) => status.id === id)?.name ??
    defaults?.find((entry) => entry.id === id)?.designation ??
    id;

  const groundOptions: readonly { value: Ground; label: string }[] = [
    { value: 'opaque', label: t('layers.groundOpaque') },
    { value: 'dim', label: t('layers.groundDim') },
    { value: 'off', label: t('layers.groundOff') },
  ];

  return (
    <div className="flex flex-col gap-4 text-sm text-panel-fg">
      <section aria-labelledby="layers-title" className="flex flex-col gap-1">
        <h3 id="layers-title" className="text-sm font-semibold">
          {t('layers.sectionLayers')}
        </h3>
        <ul className="flex flex-col">
          {LAYER_IDS.map((id) => {
            const describedBy = reasonId(id);
            return (
              <li key={id}>
                <Switch
                  label={t(`layers.${id}`)}
                  checked={layers[id]}
                  disabled={layerDisabled(id)}
                  {...(describedBy === undefined ? {} : { describedBy })}
                  className="w-full justify-between"
                  onChange={(on) => {
                    actions.setLayer(id, on);
                  }}
                />
              </li>
            );
          })}
        </ul>
        {dsoMissing && (
          <p id="layers-reason-dso" className="text-xs text-warn">
            {t('degraded.dsoMissing')}
          </p>
        )}
        {constellationsMissing && (
          <p id="layers-reason-constellations" className="text-xs text-warn">
            {t('degraded.constellationsMissing')}
          </p>
        )}
        {minorAvailable === false && (
          <p id="layers-reason-minor" className="text-xs text-warn">
            {t('degraded.mpcMissing')}
          </p>
        )}
        <CoverageBadges store={store} targets={['stars']} />
      </section>

      {minorAvailable === true && layers.minor && (
        <section aria-labelledby="layers-minor-title" className="flex flex-col gap-2">
          <h3 id="layers-minor-title" className="text-sm font-semibold">
            {t('layers.sectionMinor')}
          </h3>
          <CoverageBadges store={store} targets={['minor']} />
          <Button
            variant="outline"
            disabled={defaults === null || shown >= defaults.length}
            onClick={() => {
              actions.showMoreMinor();
            }}
          >
            {t('layers.showMore')}
          </Button>
          <h4 className="text-xs font-medium text-muted">{t('layers.pinned')}</h4>
          {pins.length === 0 ? (
            <p className="text-xs text-muted">{t('layers.noPins')}</p>
          ) : (
            <ul className="flex flex-col">
              {pins.map((id) => {
                const name = minorName(id);
                return (
                  <li key={id} className="flex items-center justify-between gap-2">
                    <span>{name}</span>
                    <IconButton
                      icon={PinOff}
                      size="sm"
                      label={t('layers.unpin', { name })}
                      onClick={() => {
                        actions.unpinMinor(id);
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section aria-labelledby="layers-maglim-title" className="flex flex-col gap-1">
        <h3 id="layers-maglim-title" className="text-sm font-semibold">
          {t('layers.sectionMagnitude')}
        </h3>
        <Switch
          label={t('layers.manualMaglim')}
          checked={options.maglim !== null}
          className="w-full justify-between"
          onChange={(on) => {
            actions.setOptions({ maglim: on ? MANUAL_MAGLIM_DEFAULT : null });
          }}
        />
        {options.maglim === null ? (
          <p className="text-xs text-muted">{t('layers.maglimAuto')}</p>
        ) : (
          <Slider
            id="layers-maglim"
            label={t('layers.maglim')}
            value={options.maglim}
            min={MAGLIM_MIN}
            max={MAGLIM_MAX}
            step={0.1}
            format={(value) => formatNumber(value, 1)}
            onChange={(value) => {
              actions.setOptions({ maglim: value });
            }}
          />
        )}
      </section>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-semibold">{t('layers.sectionDso')}</legend>
        {DSO_TYPES.map((type) => (
          <label key={type} className="flex min-h-6 items-center gap-2 pointer-coarse:min-h-11">
            <input
              type="checkbox"
              checked={selectedDso.includes(type)}
              disabled={dsoMissing}
              onChange={(event) => {
                toggleDso(type, event.currentTarget.checked);
              }}
              className="accent-accent"
            />
            {t(`dsoTypes.${type}`)}
          </label>
        ))}
      </fieldset>

      <section aria-labelledby="layers-sky-title" className="flex flex-col gap-1">
        <h3 id="layers-sky-title" className="text-sm font-semibold">
          {t('layers.sectionSky')}
        </h3>
        <Select
          id="layers-ground"
          label={t('layers.ground')}
          value={options.ground}
          options={groundOptions}
          onChange={(value) => {
            actions.setOptions({ ground: value });
          }}
        />
        <Switch
          label={t('layers.atmosphere')}
          checked={options.atm}
          disabled={!onEarth}
          {...(onEarth ? {} : { describedBy: 'layers-reason-earth' })}
          className="w-full justify-between"
          onChange={(on) => {
            actions.setOptions({ atm: on });
          }}
        />
        <Switch
          label={t('layers.refraction')}
          checked={options.refr}
          disabled={!onEarth}
          {...(onEarth ? {} : { describedBy: 'layers-reason-earth' })}
          className="w-full justify-between"
          onChange={(on) => {
            actions.setOptions({ refr: on });
          }}
        />
        {!onEarth && (
          <p id="layers-reason-earth" className="text-xs text-warn">
            {t('layers.offEarth')}
          </p>
        )}
      </section>

      <section aria-labelledby="layers-labels-title" className="flex flex-col gap-2">
        <h3 id="layers-labels-title" className="text-sm font-semibold">
          {t('layers.sectionLabels')}
        </h3>
        <Slider
          id="layers-density"
          label={t('layers.labelsDensity')}
          value={options.labels}
          min={0}
          max={3}
          step={1}
          format={densityText}
          onChange={(value) => {
            if (isLabelDensity(value)) {
              actions.setOptions({ labels: value });
            }
          }}
        />
        <VisibleObjects store={store} />
      </section>
    </div>
  );
}
