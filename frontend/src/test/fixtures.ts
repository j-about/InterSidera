// Loader for the shared conformance fixtures in backend/tests/fixtures/ (brief l.177-181,
// plan D88). Test support only: never imported by application code. Files are read with node:fs
// and validated with structural guards, so a regenerated fixture with a different shape fails
// loudly instead of producing NaN comparisons.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Quat, Vec3 } from '../sky/math/typed';

const FIXTURES_DIR = new URL('../../../backend/tests/fixtures/', import.meta.url);

export interface StarSampleFixture {
  tt: number;
  years_since_epoch: number;
  calendar_tt: string;
  barycentric_dir: Vec3;
  apparent_dir: Vec3;
  earth_velocity_au_d: Vec3;
}

export interface StarFixture {
  hip: number;
  name: string;
  catalog: {
    ra_degrees: number;
    dec_degrees: number;
    ra_mas_per_year: number;
    dec_mas_per_year: number;
    parallax_mas: number;
    epoch_year: number;
    magnitude: number;
    bv_millimag: number;
  };
  skys: { dir: Vec3; pm: Vec3; mag_millimag: number; bv_millimag: number };
  samples: StarSampleFixture[];
}

export interface StarsFixture {
  parameters: { skys_epoch_tt: number };
  stars: StarFixture[];
}

export interface BodySeriesFixture {
  dir: Vec3[];
  dist_au: number[];
  mag: number[];
  phase: number[];
  diam_deg: number[];
}

export interface FrameWindowFixture {
  id: string;
  observer: string;
  site: {
    id: string;
    lat_deg: number;
    lon_deg: number;
    elev_m: number;
    frame_name: string;
    latitude_kind: string;
  };
  tt0: number;
  calendar_tt0: string;
  step_s: number;
  n: number;
  tt: number[];
  horizon_q: Quat[];
  equinox_q: Quat[];
  observer_velocity_au_d: Vec3[];
  sun_dir: Vec3[];
  bodies: Record<string, BodySeriesFixture>;
}

export interface FramesFixture {
  windows: FrameWindowFixture[];
}

export interface RefractionTableFixture {
  elevation_m: number;
  pressure_mbar: number;
  rows: [number, number][];
}

export interface RefractionFixture {
  tables: RefractionTableFixture[];
}

export interface HorizonsCaseFixture {
  observer: string;
  target: string;
  tt: number;
  az_deg: number | null;
  el_deg: number | null;
}

/** One of the TT epochs of `horizons_cases.json`: a TT Julian Date and its TT calendar string. */
export interface HorizonsEpochFixture {
  calendar_tt: string;
  jd_tt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown, length?: number): value is number[] {
  return (
    Array.isArray(value) &&
    (length === undefined || value.length === length) &&
    value.every((x) => typeof x === 'number')
  );
}

function isTupleArray(value: unknown, width: number): boolean {
  return Array.isArray(value) && value.every((row) => isNumberArray(row, width));
}

function isStarsFixture(value: unknown): value is StarsFixture {
  if (!isRecord(value) || !isRecord(value.parameters) || !Array.isArray(value.stars)) {
    return false;
  }
  return value.stars.every(
    (star: unknown) =>
      isRecord(star) &&
      typeof star.hip === 'number' &&
      isRecord(star.skys) &&
      isNumberArray(star.skys.dir, 3) &&
      isNumberArray(star.skys.pm, 3) &&
      Array.isArray(star.samples) &&
      star.samples.every(
        (sample: unknown) =>
          isRecord(sample) &&
          typeof sample.tt === 'number' &&
          typeof sample.years_since_epoch === 'number' &&
          typeof sample.calendar_tt === 'string' &&
          isNumberArray(sample.barycentric_dir, 3) &&
          isNumberArray(sample.apparent_dir, 3) &&
          isNumberArray(sample.earth_velocity_au_d, 3),
      ),
  );
}

function isBodySeriesFixture(value: unknown, n: number): value is BodySeriesFixture {
  return (
    isRecord(value) &&
    isTupleArray(value.dir, 3) &&
    isNumberArray(value.dist_au, n) &&
    isNumberArray(value.mag, n) &&
    isNumberArray(value.phase, n) &&
    isNumberArray(value.diam_deg, n)
  );
}

function isFrameWindowFixture(value: unknown): value is FrameWindowFixture {
  if (!isRecord(value)) {
    return false;
  }
  const n = value.n;
  if (
    typeof n !== 'number' ||
    typeof value.tt0 !== 'number' ||
    typeof value.step_s !== 'number' ||
    typeof value.calendar_tt0 !== 'string'
  ) {
    return false;
  }
  return (
    isNumberArray(value.tt, n) &&
    isTupleArray(value.horizon_q, 4) &&
    isTupleArray(value.equinox_q, 4) &&
    isTupleArray(value.observer_velocity_au_d, 3) &&
    isTupleArray(value.sun_dir, 3) &&
    isRecord(value.site) &&
    isRecord(value.bodies) &&
    Object.values(value.bodies).every((b: unknown) => isBodySeriesFixture(b, n))
  );
}

function isFramesFixture(value: unknown): value is FramesFixture {
  return (
    isRecord(value) && Array.isArray(value.windows) && value.windows.every(isFrameWindowFixture)
  );
}

function isRefractionFixture(value: unknown): value is RefractionFixture {
  if (!isRecord(value) || !Array.isArray(value.tables)) {
    return false;
  }
  return value.tables.every(
    (t: unknown) =>
      isRecord(t) &&
      typeof t.elevation_m === 'number' &&
      typeof t.pressure_mbar === 'number' &&
      isTupleArray(t.rows, 2),
  );
}

/** Read and validate one fixture file. */
export function readFixture<T>(name: string, guard: (value: unknown) => value is T): T {
  const text = readFileSync(fileURLToPath(new URL(name, FIXTURES_DIR)), 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (!guard(parsed)) {
    throw new Error(`fixture ${name} does not have the expected shape`);
  }
  return parsed;
}

export function loadStarsFixture(): StarsFixture {
  return readFixture('skyfield_stars.json', isStarsFixture);
}

export function loadFramesFixture(): FramesFixture {
  return readFixture('skyfield_frames.json', isFramesFixture);
}

export function loadRefractionFixture(): RefractionFixture {
  return readFixture('skyfield_refraction.json', isRefractionFixture);
}

/**
 * The Horizons rows for one observer and target (airless alt/az reference, D37). Only the fields
 * the frontend tests compare are typed.
 */
export function loadHorizonsCases(observer: string, target: string): HorizonsCaseFixture[] {
  const doc: unknown = JSON.parse(
    readFileSync(fileURLToPath(new URL('horizons_cases.json', FIXTURES_DIR)), 'utf8'),
  );
  if (!isRecord(doc) || !Array.isArray(doc.cases)) {
    throw new Error('horizons_cases.json does not have the expected shape');
  }
  const rows: HorizonsCaseFixture[] = [];
  for (const c of doc.cases as unknown[]) {
    if (
      isRecord(c) &&
      c.observer === observer &&
      c.target === target &&
      typeof c.tt === 'number' &&
      (typeof c.az_deg === 'number' || c.az_deg === null) &&
      (typeof c.el_deg === 'number' || c.el_deg === null)
    ) {
      rows.push({ observer, target, tt: c.tt, az_deg: c.az_deg, el_deg: c.el_deg });
    }
  }
  if (rows.length === 0) {
    throw new Error(`no Horizons case for ${observer}/${target}`);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Device orientation (plan D133): `device_orientation_cases.json` from
// `scripts/generate_fixtures.py orientation`, an independent Python implementation of the W3C
// matrix; frontend-only, no Skyfield.

/** A W3C triple (degrees) with a screen angle and the camera pose it must produce. */
export interface OrientationPoseFixture {
  alpha: number;
  beta: number;
  gamma: number;
  screen_angle: number;
  az: number;
  alt: number;
  roll: number;
  tolerance_deg: number;
}

/** A closed-form pose: the spec's worked examples and the geometric constructions. */
export interface OrientationCaseFixture extends OrientationPoseFixture {
  id: string;
  forward_enu: Vec3;
  up_enu: Vec3;
  note: string;
}

/** A true pose seen through an arbitrary yaw, with the compass heading of two device axes. */
export interface OrientationCompassFixture {
  alpha_rel: number;
  beta: number;
  gamma: number;
  screen_angle: number;
  yaw_offset_deg: number;
  compass_heading_top: number;
  compass_heading_back: number;
  az: number;
  alt: number;
  roll: number;
  tolerance_deg: number;
}

/** One step of an approach to the nadir or the zenith (`in_band`: the gimbal rule applies). */
export interface OrientationGimbalRowFixture extends OrientationPoseFixture {
  region: 'nadir' | 'zenith';
  in_band: boolean;
}

export interface OrientationCasesFixture {
  parameters: {
    seed: number;
    round_trips: number;
    compass_cases: number;
    gimbal_alt_deg: number;
    closed_form_tolerance_deg: number;
    round_trip_tolerance_deg: number;
  };
  cases: OrientationCaseFixture[];
  round_trips: OrientationPoseFixture[];
  compass_cases: OrientationCompassFixture[];
  gimbal_rows: OrientationGimbalRowFixture[];
}

function hasNumbers(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === 'number');
}

const POSE_KEYS = ['alpha', 'beta', 'gamma', 'screen_angle', 'az', 'alt', 'roll', 'tolerance_deg'];

function isOrientationPose(value: unknown): value is OrientationPoseFixture {
  return isRecord(value) && hasNumbers(value, POSE_KEYS);
}

function isOrientationCase(value: unknown): value is OrientationCaseFixture {
  return (
    isOrientationPose(value) &&
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.note === 'string' &&
    isNumberArray(value.forward_enu, 3) &&
    isNumberArray(value.up_enu, 3)
  );
}

function isOrientationCompassCase(value: unknown): value is OrientationCompassFixture {
  return (
    isRecord(value) &&
    hasNumbers(value, [
      'alpha_rel',
      'beta',
      'gamma',
      'screen_angle',
      'yaw_offset_deg',
      'compass_heading_top',
      'compass_heading_back',
      'az',
      'alt',
      'roll',
      'tolerance_deg',
    ])
  );
}

function isOrientationGimbalRow(value: unknown): value is OrientationGimbalRowFixture {
  return (
    isOrientationPose(value) &&
    isRecord(value) &&
    (value.region === 'nadir' || value.region === 'zenith') &&
    typeof value.in_band === 'boolean'
  );
}

function isOrientationCasesFixture(value: unknown): value is OrientationCasesFixture {
  if (!isRecord(value) || !isRecord(value.parameters)) {
    return false;
  }
  return (
    hasNumbers(value.parameters, [
      'seed',
      'round_trips',
      'compass_cases',
      'gimbal_alt_deg',
      'closed_form_tolerance_deg',
      'round_trip_tolerance_deg',
    ]) &&
    Array.isArray(value.cases) &&
    value.cases.every(isOrientationCase) &&
    Array.isArray(value.round_trips) &&
    value.round_trips.every(isOrientationPose) &&
    Array.isArray(value.compass_cases) &&
    value.compass_cases.every(isOrientationCompassCase) &&
    Array.isArray(value.gimbal_rows) &&
    value.gimbal_rows.every(isOrientationGimbalRow)
  );
}

export function loadOrientationCases(): OrientationCasesFixture {
  return readFixture('device_orientation_cases.json', isOrientationCasesFixture);
}

/** The TT epochs of the Horizons cases (`epochs_tt`), calendar strings on the TT scale. */
export function loadHorizonsEpochs(): HorizonsEpochFixture[] {
  const doc: unknown = JSON.parse(
    readFileSync(fileURLToPath(new URL('horizons_cases.json', FIXTURES_DIR)), 'utf8'),
  );
  if (!isRecord(doc) || !Array.isArray(doc.epochs_tt)) {
    throw new Error('horizons_cases.json has no epochs_tt list');
  }
  const epochs: HorizonsEpochFixture[] = [];
  for (const e of doc.epochs_tt as unknown[]) {
    if (!isRecord(e) || typeof e.calendar_tt !== 'string' || typeof e.jd_tt !== 'number') {
      throw new Error('horizons_cases.json epochs_tt entry does not have the expected shape');
    }
    epochs.push({ calendar_tt: e.calendar_tt, jd_tt: e.jd_tt });
  }
  return epochs;
}
