// A small but complete `CatalogBundle` and `/meta` answer for the unit tests of the search
// index, the details controller and the panels (test support only, never imported by
// application code). The stars are real Hipparcos entries with their catalog magnitudes so the
// ranking tests read naturally; the geometry columns are zeros (nothing here projects them).

import type { CatalogBundle, ConstellationEntry, DsoEntry, StarIndexEntry } from '../api/catalogs';
import type { MetaResponse } from '../state/storeTypes';

interface FakeStar {
  hip: number;
  con: string;
  mag: number;
  proper?: string;
  bayer?: string;
  flamsteed?: string;
}

/** Sorted by magnitude, as the SKYS file is. */
const STARS: readonly FakeStar[] = [
  { hip: 32349, con: 'CMa', mag: -1.44, proper: 'Sirius', bayer: 'α CMa', flamsteed: '9 CMa' },
  { hip: 24436, con: 'Ori', mag: 0.18, proper: 'Rigel', bayer: 'β Ori', flamsteed: '19 Ori' },
  { hip: 27989, con: 'Ori', mag: 0.45, proper: 'Betelgeuse', bayer: 'α Ori', flamsteed: '58 Ori' },
  { hip: 11767, con: 'UMi', mag: 1.97, proper: 'Polaris', bayer: 'α UMi', flamsteed: '1 UMi' },
  { hip: 26727, con: 'Ori', mag: 1.74, proper: 'Alnitak', bayer: 'ζ Ori', flamsteed: '50 Ori' },
  { hip: 5896, con: 'Scl', mag: 5.42, bayer: 'κ¹ Scl' },
  { hip: 100000, con: 'Ori', mag: 6.5, flamsteed: '99 Ori' },
];

const DSO: readonly DsoEntry[] = [
  {
    id: 'NGC224',
    type: 'galaxy',
    ra_deg: 10.68,
    dec_deg: 41.27,
    con: 'And',
    mag: 3.44,
    messier: 31,
    names: ['Andromeda Galaxy'],
    major_arcmin: 190,
  },
  {
    id: 'NGC1976',
    type: 'nebula',
    ra_deg: 83.82,
    dec_deg: -5.39,
    con: 'Ori',
    mag: 4,
    messier: 42,
    names: ['Orion Nebula', 'Great Nebula in Orion'],
  },
  {
    id: 'NGC6720',
    type: 'planetary_nebula',
    ra_deg: 283.4,
    dec_deg: 33.03,
    con: 'Lyr',
    mag: 8.8,
    messier: 57,
    names: ['Ring Nebula'],
  },
  { id: 'IC434', type: 'nebula', ra_deg: 85.25, dec_deg: -2.46, con: 'Ori', names: [] },
  {
    id: 'Mel22',
    type: 'open_cluster',
    ra_deg: 56.75,
    dec_deg: 24.12,
    con: 'Tau',
    mag: 1.2,
    messier: 45,
    names: ['Pleiades'],
  },
];

function constellation(
  abbr: string,
  latin: string,
  genitive: string,
  ra: number,
  dec: number,
): ConstellationEntry {
  return {
    abbr,
    latin,
    genitive,
    label: { ra_deg: ra, dec_deg: dec },
    boundary: [],
    lines: [],
    polygons: [],
  };
}

const CONSTELLATIONS: readonly ConstellationEntry[] = [
  constellation('Ori', 'Orion', 'Orionis', 83, 5),
  constellation('And', 'Andromeda', 'Andromedae', 10, 38),
  constellation('CMa', 'Canis Major', 'Canis Majoris', 105, -22),
  constellation('UMi', 'Ursa Minor', 'Ursae Minoris', 230, 75),
  constellation('Tau', 'Taurus', 'Tauri', 65, 15),
  constellation('Lyr', 'Lyra', 'Lyrae', 280, 36),
  constellation('Scl', 'Sculptor', 'Sculptoris', 5, -32),
];

export interface FakeBundleOptions {
  /** Leave the optional catalogs out (degraded server). */
  dso?: boolean;
  constellations?: boolean;
}

export function fakeBundle(options: FakeBundleOptions = {}): CatalogBundle {
  const n = STARS.length;
  const hip = new Uint32Array(n);
  const mag = new Int16Array(n);
  const hipIndex = new Map<number, number>();
  const index: StarIndexEntry[] = [];
  STARS.forEach((star, row) => {
    hip[row] = star.hip;
    mag[row] = Math.round(star.mag * 1000);
    hipIndex.set(star.hip, row);
    const names: StarIndexEntry['names'] = {};
    if (star.proper !== undefined) {
      names.proper = star.proper;
    }
    if (star.bayer !== undefined) {
      names.bayer = star.bayer;
    }
    if (star.flamsteed !== undefined) {
      names.flamsteed = star.flamsteed;
    }
    index.push({ hip: star.hip, con: star.con, names });
  });
  return {
    stars: {
      columns: {
        count: n,
        epochTt: 2451545,
        dir: new Float32Array(3 * n),
        pm: new Float32Array(3 * n),
        mag,
        bv: new Int16Array(n),
        hip,
      },
      hipIndex,
      magnitudeLimit: 14,
      parseMs: 0,
      fetchMs: 0,
    },
    index: { data: index, etag: null, stale: false },
    dso: options.dso === false ? null : { data: [...DSO], etag: 'dso', stale: false },
    constellations:
      options.constellations === false
        ? null
        : { data: [...CONSTELLATIONS], etag: 'con', stale: false },
    starsEtag: 'stars',
    starsStale: false,
  };
}

export const FAKE_BODIES: MetaResponse['bodies'] = [
  {
    id: 'sun',
    kind: 'star',
    name_key: 'bodies.sun',
    radius_km: 695700,
    step_class: 'sun_and_outer',
  },
  {
    id: 'mercury',
    kind: 'planet',
    name_key: 'bodies.mercury',
    radius_km: 2440,
    step_class: 'inner_planets',
  },
  {
    id: 'venus',
    kind: 'planet',
    name_key: 'bodies.venus',
    radius_km: 6052,
    step_class: 'inner_planets',
  },
  {
    id: 'earth',
    kind: 'planet',
    name_key: 'bodies.earth',
    radius_km: 6378,
    step_class: 'inner_planets',
  },
  { id: 'moon', kind: 'moon', name_key: 'bodies.moon', radius_km: 1738, step_class: 'moon' },
  {
    id: 'mars',
    kind: 'planet',
    name_key: 'bodies.mars',
    radius_km: 3396,
    step_class: 'inner_planets',
  },
  {
    id: 'jupiter',
    kind: 'planet',
    name_key: 'bodies.jupiter',
    radius_km: 71492,
    step_class: 'sun_and_outer',
  },
  {
    id: 'saturn',
    kind: 'planet',
    name_key: 'bodies.saturn',
    radius_km: 60268,
    step_class: 'sun_and_outer',
  },
  {
    id: 'uranus',
    kind: 'planet',
    name_key: 'bodies.uranus',
    radius_km: 25559,
    step_class: 'sun_and_outer',
  },
  {
    id: 'neptune',
    kind: 'planet',
    name_key: 'bodies.neptune',
    radius_km: 24764,
    step_class: 'sun_and_outer',
  },
  {
    id: 'pluto',
    kind: 'dwarf_planet',
    name_key: 'bodies.pluto',
    radius_km: 1188,
    step_class: 'sun_and_outer',
  },
];

export interface FakeMetaOptions {
  /** Serve the MPC tables (`catalogs.minor_bodies` present). */
  minor?: boolean;
  dso?: boolean;
  constellations?: boolean;
}

/** A `/meta` answer with the fields the panels read (versions, catalogs, geocoder, limits). */
export function fakeMeta(options: FakeMetaOptions = {}): MetaResponse {
  const meta: MetaResponse = {
    api_version: '1.1.0',
    server_time: { tt: 2461285.5, utc: '2026-09-02T00:00:00Z', tt_minus_utc_seconds: 69.184 },
    ephemeris: { name: 'de440s.bsp', coverage_tt: [2396758.5, 2506000.5] },
    observers: [],
    bodies: FAKE_BODIES,
    coverage: {
      ephemeris_tt: [2396758.5, 2506000.5],
      delta_t: { observed_tt: [2441317.5, 2461349.5], predicted_until_tt: 2461714.5 },
      iau_rotation_reliable_tt: [2378496.5, 2524593.5],
      proper_motion_warning_years: 10000,
      mpc_elements: { warn_years: 2, error_years: 50 },
    },
    catalogs: {
      stars: {
        count: 117955,
        version: '1-test',
        epoch_tt: 2451545,
        magnitude_limit: 14.08,
        etag: 'stars',
        license: 'CC-BY-SA-4.0',
        attribution: 'The Hipparcos and Tycho Catalogues, ESA SP-1200 (1997); HYG database v4.4',
      },
    },
    geocoder: {
      enabled: true,
      url: 'https://nominatim.openstreetmap.org',
      attribution: 'Geocoding: (c) OpenStreetMap contributors, via Nominatim',
      min_interval_ms: 1000,
    },
    limits: {
      max_samples: 64,
      max_minor_bodies: 100,
      max_targets: 200,
      speeds: [1, 10, 60, 600, 3600, 86400],
      max_step_s: { moon: 3600, inner_planets: 21600, sun_and_outer: 86400, minor: 86400 },
    },
  };
  if (options.dso !== false) {
    meta.catalogs.dso = {
      count: 5229,
      version: '1-test',
      etag: 'dso',
      license: 'CC-BY-SA-4.0',
      attribution: 'OpenNGC, Mattia Verga, CC BY-SA 4.0',
    };
  }
  if (options.constellations !== false) {
    meta.catalogs.constellations = {
      count: 88,
      culture: 'modern',
      etag: 'con',
      license: 'CC BY-SA 4.0',
      attribution: "Constellation figures: Stellarium 'modern' sky culture, CC BY-SA 4.0",
    };
  }
  if (options.minor === true) {
    meta.catalogs.minor_bodies = {
      asteroids: 1562091,
      comets: 957,
      elements_epoch_range_tt: [2430611.5, 2461285.5],
      license: 'Free, attribution requested (IAU Minor Planet Center)',
      attribution: 'Orbital elements: IAU Minor Planet Center',
    };
  }
  return meta;
}
