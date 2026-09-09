// Geolocation (OBS-1, OBS-2, brief l.190-191; plan D95). `main.tsx` calls `requestGeolocation`
// when the URL carries no observer and the panel's "Use my location" button calls it again. The
// store keeps Greenwich while the browser prompt is up (`geo.status === 'prompting'`, during which
// `urlStateOf` withholds the observer keys); a fix replaces the observer only while that status
// holds, so a position the user typed meanwhile is never overwritten; every failure keeps
// Greenwich, records why and opens the observer panel. The elevation is the WGS84 ellipsoidal
// height the API expects, rounded to the metre and clamped to the URL bounds. Coordinates are
// stored unrounded: OBS-7 rounding happens in the query and the URL codec.

import { ELEVATION_MAX_M, ELEVATION_MIN_M } from './coords';
import type { SkyStore } from './storeTypes';
import type { GeoStatus } from './types';

export interface GeolocationDeps {
  /** The `Geolocation` to use; `null` = unsupported; default `navigator.geolocation`. */
  geolocation?: Geolocation | null;
  /** Default `window.isSecureContext` (the API is secure-context only). */
  isSecureContext?: boolean;
}

/** A coarse fix is enough for 0.01 degree rounding; a ten-minute-old one too. */
export const GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  timeout: 15_000,
  maximumAge: 600_000,
};

/** `GeolocationPositionError.code` (typed `number`) to a status; unknown codes read unavailable. */
export function statusOfErrorCode(code: number): GeoStatus {
  switch (code) {
    case 1:
      return 'denied';
    case 2:
      return 'unavailable';
    case 3:
      return 'timeout';
    default:
      return 'unavailable';
  }
}

/** Ellipsoidal height in metres, rounded, within the URL bounds; `null` or NaN reads as 0. */
export function elevationOf(altitude: number | null): number {
  if (altitude === null || !Number.isFinite(altitude)) {
    return 0;
  }
  const rounded = Math.round(altitude);
  return Math.min(ELEVATION_MAX_M, Math.max(ELEVATION_MIN_M, rounded === 0 ? 0 : rounded));
}

function defaultGeolocation(): Geolocation | null {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator
    ? navigator.geolocation
    : null;
}

export function requestGeolocation(store: SkyStore, deps: GeolocationDeps = {}): void {
  const { actions } = store.getState();
  const fail = (status: GeoStatus): void => {
    actions.setGeo(status);
    actions.openPanel('observer');
  };
  const geolocation = deps.geolocation === undefined ? defaultGeolocation() : deps.geolocation;
  if (geolocation === null) {
    fail('unsupported');
    return;
  }
  if (!(deps.isSecureContext ?? window.isSecureContext)) {
    fail('insecure');
    return;
  }
  actions.setGeo('prompting');
  geolocation.getCurrentPosition(
    (position) => {
      // A position the user set meanwhile (typed, preset, geocoder pick, Back) wins over a late fix.
      if (store.getState().geo.status !== 'prompting') {
        return;
      }
      const { latitude, longitude, altitude } = position.coords;
      actions.setObserver({
        body: 'earth',
        lat: latitude,
        lon: longitude,
        elev: elevationOf(altitude),
      });
      actions.setGeo('granted');
    },
    (error) => {
      if (store.getState().geo.status !== 'prompting') {
        return;
      }
      fail(statusOfErrorCode(error.code));
    },
    GEOLOCATION_OPTIONS,
  );
}
