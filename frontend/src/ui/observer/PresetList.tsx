import { MapPin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';

import { presetObserver, presetsFor } from '../../state/presets';
import type { SkyStore } from '../../state/storeTypes';
import Button from '../components/Button';

// Presets on other bodies (OBS-6 [S], brief l.195; plan D96): the landing sites and landmarks of
// the current body, each a button writing the four observer fields (elevation 0); labelled
// approximate. Earth has none: the geocoder serves it.

export interface PresetListProps {
  store: SkyStore;
}

export default function PresetList({ store }: PresetListProps) {
  const { t } = useTranslation();
  const body = useStore(store, (s) => s.observer.body);
  const { actions } = store.getState();
  const sites = presetsFor(body);
  if (sites.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold">{t('presets.title')}</h3>
      <p className="text-xs text-muted">{t('presets.note')}</p>
      <ul className="flex flex-col gap-1">
        {sites.map((site) => (
          <li key={site.id}>
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => {
                actions.setObserver(presetObserver(site));
              }}
            >
              <MapPin size={14} aria-hidden="true" />
              <span className="truncate">{t(`presets.${site.key}`)}</span>
              <span className="ml-auto text-xs text-muted tabular-nums">
                {`${String(site.lat)}°, ${String(site.lon)}°`}
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
