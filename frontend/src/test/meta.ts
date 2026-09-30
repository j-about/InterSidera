// A complete `/meta` answer for the component tests (test support only, never imported by
// application code): the de440s coverage (1849..2150), the ten observers with the contract's
// conventions, the reference speed list and an enabled geocoder. `makeMeta` deep-merges overrides
// one level down so a test can narrow one body's coverage or disable the geocoder.

import type { MetaResponse } from '../state/storeTypes';

type ObserverMeta = MetaResponse['observers'][number];

/** de440s: 1849-12-26 .. 2150-01-22 (TT), as the local API reports them. */
export const EPHEMERIS_TT: [number, number] = [2396753.5, 2506351.5];

function observer(
  id: ObserverMeta['id'],
  radii: [number, number, number],
  patch: Partial<ObserverMeta> = {},
): ObserverMeta {
  return {
    id,
    name_key: `bodies.${id}`,
    frame:
      id === 'earth' ? 'ITRS' : id === 'moon' ? 'MOON_ME_DE440_ME421' : `IAU_${id.toUpperCase()}`,
    radii_km: radii,
    latitude_kind: id === 'earth' ? 'geodetic' : 'planetocentric',
    coverage_tt: EPHEMERIS_TT,
    ...patch,
  };
}

export const OBSERVERS: readonly ObserverMeta[] = [
  observer('earth', [6378.1366, 6378.1366, 6356.7519]),
  observer('moon', [1737.4, 1737.4, 1737.4]),
  observer('mercury', [2440.53, 2440.53, 2438.26]),
  observer('venus', [6051.8, 6051.8, 6051.8]),
  observer('mars', [3396.19, 3396.19, 3376.2]),
  observer('jupiter', [71492, 71492, 66854]),
  observer('saturn', [60268, 60268, 54364]),
  observer('uranus', [25559, 25559, 24973]),
  observer('neptune', [24764, 24764, 24341]),
  observer('pluto', [1188.3, 1188.3, 1188.3], { approximation_code: 'pluto_barycenter' }),
];

export function makeMeta(overrides: Partial<MetaResponse> = {}): MetaResponse {
  return {
    api_version: '1.1.0',
    server_time: { tt: 2461285.5, utc: '2026-09-02T00:00:00Z', tt_minus_utc_seconds: 69.184 },
    ephemeris: { name: 'de440s.bsp', coverage_tt: EPHEMERIS_TT },
    observers: [...OBSERVERS],
    coverage: {
      ephemeris_tt: EPHEMERIS_TT,
      delta_t: { observed_tt: [1458085.5, 2461063.5], predicted_until_tt: 2461428.5 },
      iau_rotation_reliable_tt: [2378496.5, 2524593.5],
      proper_motion_warning_years: 10000,
      mpc_elements: { warn_years: 2, error_years: 50 },
    },
    bodies: [],
    catalogs: {
      stars: {
        count: 117955,
        version: '1-abc',
        etag: 'stars-etag',
        epoch_tt: 2451545,
        magnitude_limit: 13.9,
        license: 'CC BY-SA 2.5',
        attribution: 'ESA Hipparcos; HYG',
      },
    },
    geocoder: {
      enabled: true,
      url: 'https://nominatim.example.test',
      attribution: 'Geocoding: © OpenStreetMap contributors, via Nominatim',
      min_interval_ms: 1000,
    },
    limits: {
      max_samples: 64,
      max_minor_bodies: 100,
      max_targets: 200,
      speeds: [1, 10, 60, 600, 3600, 86400, 604800, 2629800, 31557600],
      max_step_s: { moon: 3600, inner_planets: 21600, sun_and_outer: 86400, minor: 86400 },
    },
    ...overrides,
  };
}
