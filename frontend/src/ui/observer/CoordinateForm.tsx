import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';

import {
  formatDegrees,
  formatElevation,
  parseElevation,
  parseLatitude,
  parseLongitude,
  roundedObserverPreview,
} from '../../state/coords';
import type { CoordParse, ElevationParse } from '../../state/coords';
import type { SkyStore } from '../../state/storeTypes';
import type { Observer } from '../../state/types';
import TextField from '../components/TextField';

// Manual coordinates (OBS-3, brief l.192; plan D96): three text fields whose drafts are parsed
// on every keystroke (decimal or DMS, hemisphere letters, comma decimals), the errors announced
// through the field's `role="alert"`, and the valid triple written to the store after a 250 ms
// debounce (the frame controller compares the OBS-7-rounded query, so keystrokes beyond the
// second decimal cost no request). A preview line shows the rounded values that leave the
// browser. The drafts follow the store when something else moves the observer (a preset, the
// geocoder, geolocation, Back) and keep the typed text otherwise.

/** Keystrokes settle for this long before the store is written. */
export const COORDINATE_DEBOUNCE_MS = 250;

export interface CoordinateFormProps {
  store: SkyStore;
}

interface Drafts {
  lat: string;
  lon: string;
  elev: string;
}

function draftsOf(observer: Observer): Drafts {
  return {
    lat: formatDegrees(observer.lat),
    lon: formatDegrees(observer.lon),
    elev: formatElevation(observer.elev),
  };
}

interface Parsed {
  lat: CoordParse;
  lon: CoordParse;
  elev: ElevationParse;
  /** The observer the drafts describe when all three are valid. */
  observer: Observer | null;
}

function parseDrafts(drafts: Drafts, body: string): Parsed {
  const lat = parseLatitude(drafts.lat);
  const lon = parseLongitude(drafts.lon);
  const elev = parseElevation(drafts.elev);
  const observer =
    lat.ok && lon.ok && elev.ok ? { body, lat: lat.deg, lon: lon.deg, elev: elev.metres } : null;
  return { lat, lon, elev, observer };
}

function sameObserver(a: Observer, b: Observer): boolean {
  return a.body === b.body && a.lat === b.lat && a.lon === b.lon && a.elev === b.elev;
}

export default function CoordinateForm({ store }: CoordinateFormProps) {
  const { t } = useTranslation();
  const observer = useStore(store, (s) => s.observer);
  const { actions } = store.getState();
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(observer));
  const [seen, setSeen] = useState<Observer>(observer);
  const timer = useRef<number | null>(null);

  // Adjusting state on a prop change (no effect): a store observer this form did not write
  // (its parsed drafts differ from it) replaces the drafts; its own debounced write does not.
  if (observer !== seen) {
    setSeen(observer);
    const current = parseDrafts(drafts, observer.body).observer;
    if (current === null || !sameObserver(current, observer)) {
      setDrafts(draftsOf(observer));
    }
  }

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    },
    [],
  );

  const parsed = parseDrafts(drafts, observer.body);
  const preview = roundedObserverPreview(parsed.observer ?? observer);

  const update = (patch: Partial<Drafts>): void => {
    const next = { ...drafts, ...patch };
    setDrafts(next);
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const target = parseDrafts(next, observer.body).observer;
    if (target === null || sameObserver(target, store.getState().observer)) {
      return;
    }
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const body = store.getState().observer.body;
      actions.setObserver({ ...target, body });
    }, COORDINATE_DEBOUNCE_MS);
  };

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t('observer.coordinates')}</h3>
      <TextField
        id="observer-lat"
        label={t('observer.latitude')}
        hint={t('observer.latitudeHint')}
        value={drafts.lat}
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        error={parsed.lat.ok ? null : t(`coords.error.${parsed.lat.error}`)}
        onValueChange={(lat) => {
          update({ lat });
        }}
      />
      <TextField
        id="observer-lon"
        label={t('observer.longitude')}
        hint={t('observer.longitudeHint')}
        value={drafts.lon}
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        error={parsed.lon.ok ? null : t(`coords.error.${parsed.lon.error}`)}
        onValueChange={(lon) => {
          update({ lon });
        }}
      />
      <TextField
        id="observer-elev"
        label={t('observer.elevation')}
        value={drafts.elev}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        error={parsed.elev.ok ? null : t(`coords.error.${parsed.elev.error}`)}
        onValueChange={(elev) => {
          update({ elev });
        }}
      />
      <p className="text-xs text-muted" data-testid="coords-preview">
        {t('coords.preview', {
          lat: String(preview.lat),
          lon: String(preview.lon),
          elev: String(preview.elev),
        })}
      </p>
    </div>
  );
}
