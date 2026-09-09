import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SubmitEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { geocoderErrorOf, geocoderMinIntervalMs, searchPlaces } from '../../api/geocoder';
import type { SkyStore } from '../../state/storeTypes';
import Button from '../components/Button';
import Switch from '../components/Switch';
import TextField from '../components/TextField';

// Place search through Nominatim (OBS-4, brief l.193, l.318, l.554; plan D97). Submit-only: a
// form with exactly one submit button; the handler returns early while a request is in flight or
// before the policy interval (`max(min_interval_ms, 1000)`) has elapsed, and the button reads
// `aria-disabled` meanwhile (a disabled control would drop the focus). Only the typed text leaves
// the browser; a pick writes `{ earth, lat, lon, elev 0 }` (Nominatim carries no elevation; the
// field stays editable). The attribution of `/meta.geocoder.attribution` stays under the form and
// links to the OpenStreetMap copyright page; the in-memory toggle hides the form, the server's
// `enabled: false` hides the whole section.

export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

export interface PlaceSearchProps {
  store: SkyStore;
  /** Test injection of the search function (default `api/geocoder.ts::searchPlaces`). */
  geocode?: typeof searchPlaces;
  /** Test injection of the wall clock (default `Date.now`). */
  now?: () => number;
}

/** Re-renders once `untilMs` has passed so the cooldown state lifts without user input. */
function useCooldownEnd(untilMs: number, now: () => number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const remaining = untilMs - now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return;
    }
    const id = window.setTimeout(() => {
      setTick((tick) => tick + 1);
    }, remaining);
    return () => {
      window.clearTimeout(id);
    };
  }, [untilMs, now]);
}

export default function PlaceSearch({
  store,
  geocode = searchPlaces,
  now = Date.now,
}: PlaceSearchProps) {
  const { t } = useTranslation();
  const { meta, geocoder, lang } = useStore(
    store,
    useShallow((s) => ({
      meta: s.meta?.geocoder ?? null,
      geocoder: s.geocoder,
      lang: s.options.lang,
    })),
  );
  const { actions } = store.getState();
  const [query, setQuery] = useState('');
  const interval = geocoderMinIntervalMs(meta?.min_interval_ms ?? 1000);
  const nextAllowedMs = geocoder.lastRequestMs + interval;
  useCooldownEnd(nextAllowedMs, now);

  if (!meta?.enabled) {
    return null;
  }
  const blocked = geocoder.busy || now() < nextAllowedMs;

  const onSubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const q = query.trim();
    const current = store.getState().geocoder;
    const startMs = now();
    if (q === '' || current.busy || startMs < current.lastRequestMs + interval) {
      return;
    }
    actions.setGeocoder({ busy: true, lastRequestMs: startMs, error: null });
    const run = async (): Promise<void> => {
      try {
        const results = await geocode(q, {
          baseUrl: meta.url,
          lang,
          ...(typeof meta.email === 'string' && meta.email !== '' ? { email: meta.email } : {}),
        });
        actions.setGeocoder({
          busy: false,
          results,
          error: results.length === 0 ? 'no_results' : null,
        });
      } catch (error: unknown) {
        actions.setGeocoder({ busy: false, results: [], error: geocoderErrorOf(error) });
      }
    };
    void run();
  };

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t('geocoder.title')}</h3>
      <Switch
        label={t('geocoder.toggle')}
        checked={geocoder.enabled}
        onChange={(enabled) => {
          actions.setGeocoder({ enabled });
        }}
      />
      {geocoder.enabled && (
        <form className="flex flex-col gap-2" onSubmit={onSubmit}>
          <div className="flex items-end gap-2">
            <TextField
              id="geocoder-query"
              label={t('geocoder.query')}
              value={query}
              autoComplete="off"
              className="flex-1"
              onValueChange={setQuery}
            />
            <Button type="submit" variant="primary" aria-disabled={blocked ? true : undefined}>
              <Search size={16} aria-hidden="true" />
              {t('geocoder.submit')}
            </Button>
          </div>
          {geocoder.error !== null && (
            <p role="alert" className="text-xs text-danger">
              {t(`geocoder.${geocoder.error}`)}
            </p>
          )}
          {geocoder.results.length > 0 && (
            <ul aria-label={t('geocoder.results')} className="flex flex-col gap-1">
              {geocoder.results.map((result) => (
                <li key={result.placeId}>
                  <Button
                    variant="outline"
                    className="w-full justify-start text-left whitespace-normal"
                    onClick={() => {
                      actions.setObserver({
                        body: 'earth',
                        lat: result.lat,
                        lon: result.lon,
                        elev: 0,
                      });
                    }}
                  >
                    {result.displayName}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </form>
      )}
      <p className="text-xs text-muted">
        {meta.attribution}{' '}
        <a
          href={OSM_COPYRIGHT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-panel-fg"
        >
          {t('geocoder.attributionLink')}
        </a>
      </p>
    </div>
  );
}
