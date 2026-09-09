// Observer presets on other bodies (OBS-6 [S], brief l.195; plan D96, backlog B-57): landing
// sites and landmarks with their coordinates cited from the USGS Gazetteer of Planetary
// Nomenclature (https://planetarynames.wr.usgs.gov/Feature/<id>, read on 2026-09-09; public
// domain, credited through the `gazetteer` registry entry). Stored as the backend expects them:
// planetocentric latitude, east longitude in [-180, 180), elevation 0 (the Gazetteer carries
// none). Pure: a constant table and two conversions.

import type { Observer } from './types';
import { wrapLongitudeDeg } from './url';

/** The `/meta.observers[].id` union, hand-written so the leaf `types.ts` stays import-free. */
export type ObserverId =
  | 'mercury'
  | 'venus'
  | 'earth'
  | 'moon'
  | 'mars'
  | 'jupiter'
  | 'saturn'
  | 'uranus'
  | 'neptune'
  | 'pluto';

export const OBSERVER_IDS: readonly ObserverId[] = [
  'mercury',
  'venus',
  'earth',
  'moon',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'pluto',
];

export function isObserverId(id: string): id is ObserverId {
  return (OBSERVER_IDS as readonly string[]).includes(id);
}

/** Translation key suffixes (`presets.<key>`), a closed union so the typed `t` accepts them. */
export type PresetKey =
  | 'moon.tranquility'
  | 'moon.tycho'
  | 'moon.shackleton'
  | 'mars.jezero'
  | 'mars.gale'
  | 'mars.olympus'
  | 'mercury.caloris'
  | 'venus.maxwell'
  | 'equatorMeridian';

export interface PlanetarySite {
  /** Stable id (the body and the site). */
  id: string;
  body: ObserverId;
  key: PresetKey;
  /** Planetocentric latitude, degrees. */
  lat: number;
  /** East longitude, degrees in [-180, 180). */
  lon: number;
  /** Gazetteer feature id; absent for the IAU prime-meridian definitions. */
  featureId?: number;
}

/**
 * Planetocentric latitude of a planetographic one on an ellipsoid of equatorial radius `a` and
 * polar radius `c`: `tan(phi_c) = (c / a)^2 tan(phi_g)` (degrees in, degrees out).
 */
export function planetocentricLatDeg(latGraphicDeg: number, aKm: number, cKm: number): number {
  const rad = (latGraphicDeg * Math.PI) / 180;
  const ratio = (cKm / aKm) ** 2;
  return (Math.atan(ratio * Math.tan(rad)) * 180) / Math.PI;
}

/** `360 - lon` of a "+West, 0-360" Gazetteer longitude, wrapped to `[-180, 180)`. */
export function eastLongitudeOfWest(lonWestDeg: number): number {
  return wrapLongitudeDeg(360 - lonWestDeg);
}

/**
 * The twelve sites. Coordinates are the Gazetteer "Center Latitude" / "Center Longitude" values
 * in that body's stated system, converted where needed:
 *
 * - Moon (a sphere in pck00011, planetographic = planetocentric; +East, -180..180):
 *   Statio Tranquillitatis 5684 (0.67, 23.47), Tycho 6163 (-43.30, -11.22), Shackleton 5450
 *   (-89.67, 129.78).
 * - Mars (planetocentric, +East, 0-360): Jezero 14300 (18.41, 77.69), Gale 2071 (-5.44, 137.70),
 *   Olympus Mons 4453 (18.40, 226.00 -> -134.00).
 * - Mercury (planetographic, +West, 0-360): Caloris Planitia 979 (31.65, 198.02): longitude
 *   360 - 198.02 = 161.98 E; latitude `atan((2438.26 / 2440.53)^2 tan 31.65)` = 31.602 with the
 *   pck00011 radii (2440.53, 2440.53, 2438.26), stored rounded to 31.60.
 * - Venus (planetocentric, +East, 0-360): Maxwell Montes 3766 (65.20, 3.30).
 * - Jupiter, Saturn, Uranus, Neptune: the equator on the IAU prime meridian (`W0`), 0 / 0.
 */
export const PLANETARY_SITES: readonly PlanetarySite[] = [
  {
    id: 'moon:tranquility',
    body: 'moon',
    key: 'moon.tranquility',
    lat: 0.67,
    lon: 23.47,
    featureId: 5684,
  },
  { id: 'moon:tycho', body: 'moon', key: 'moon.tycho', lat: -43.3, lon: -11.22, featureId: 6163 },
  {
    id: 'moon:shackleton',
    body: 'moon',
    key: 'moon.shackleton',
    lat: -89.67,
    lon: 129.78,
    featureId: 5450,
  },
  { id: 'mars:jezero', body: 'mars', key: 'mars.jezero', lat: 18.41, lon: 77.69, featureId: 14300 },
  { id: 'mars:gale', body: 'mars', key: 'mars.gale', lat: -5.44, lon: 137.7, featureId: 2071 },
  { id: 'mars:olympus', body: 'mars', key: 'mars.olympus', lat: 18.4, lon: -134, featureId: 4453 },
  {
    id: 'mercury:caloris',
    body: 'mercury',
    key: 'mercury.caloris',
    lat: 31.6,
    lon: 161.98,
    featureId: 979,
  },
  {
    id: 'venus:maxwell',
    body: 'venus',
    key: 'venus.maxwell',
    lat: 65.2,
    lon: 3.3,
    featureId: 3766,
  },
  { id: 'jupiter:equator', body: 'jupiter', key: 'equatorMeridian', lat: 0, lon: 0 },
  { id: 'saturn:equator', body: 'saturn', key: 'equatorMeridian', lat: 0, lon: 0 },
  { id: 'uranus:equator', body: 'uranus', key: 'equatorMeridian', lat: 0, lon: 0 },
  { id: 'neptune:equator', body: 'neptune', key: 'equatorMeridian', lat: 0, lon: 0 },
];

/** The presets of one body, in table order (Earth has none: the geocoder serves it). */
export function presetsFor(body: string): PlanetarySite[] {
  return PLANETARY_SITES.filter((site) => site.body === body);
}

/** The observer a preset writes: its body and coordinates, elevation 0. */
export function presetObserver(site: PlanetarySite): Observer {
  return { body: site.body, lat: site.lat, lon: site.lon, elev: 0 };
}
