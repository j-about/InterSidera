// @vitest-environment node
// Refraction parity with Skyfield (brief l.90, l.263; plan D73, D88): the shared forward formula
// against both `skyfield_refraction.json` tables within 1 arcmin contractual and 0.1 arcmin
// regression (measured 0.057), the UI inverse, the exact -1/89.9 degree cut, the test oracle
// `skyfieldRefractDeg`, and the reason Sæmundsson alone is not enough at 2850 m.

import { loadRefractionFixture } from '../../test/fixtures';
import {
  MAX_REFRACTED_ALT_DEG,
  MIN_REFRACTED_ALT_DEG,
  PRESSURE_SCALE_HEIGHT_M,
  STANDARD_PRESSURE_MBAR,
  STANDARD_TEMPERATURE_C,
  apparentAltitudeDeg,
  bennettRefractionDeg,
  refractionFactor,
  saemundssonRefractionDeg,
  skyfieldRefractDeg,
  standardPressureMbar,
  trueAltitudeDeg,
} from './refraction';

const fixture = loadRefractionFixture();
const ARCMIN = 1 / 60;

describe('constants and the standard atmosphere', () => {
  it('match Skyfield', () => {
    expect(STANDARD_TEMPERATURE_C).toBe(10);
    expect(STANDARD_PRESSURE_MBAR).toBe(1010);
    expect(PRESSURE_SCALE_HEIGHT_M).toBe(9100);
    expect(MIN_REFRACTED_ALT_DEG).toBe(-1);
    expect(MAX_REFRACTED_ALT_DEG).toBe(89.9);
    expect(standardPressureMbar(0)).toBe(1010);
    for (const table of fixture.tables) {
      expect(standardPressureMbar(table.elevation_m)).toBeCloseTo(table.pressure_mbar, 9);
    }
  });

  it('refractionFactor is (P / 1010) (283 / (273 + T)), 1 at sea level and 10 C', () => {
    expect(refractionFactor(0)).toBe(1);
    expect(refractionFactor(0, 10)).toBe(1);
    expect(refractionFactor(0, 20)).toBeCloseTo(283 / 293, 15);
    expect(refractionFactor(2850)).toBeCloseTo(Math.exp(-2850 / 9100), 15);
  });
});

describe('apparentAltitudeDeg against both fixture tables', () => {
  it('is within 1 arcmin (contract) and 0.1 arcmin (regression) at every row', () => {
    // Measured 2026-09-06: 0.057 arcmin (2850 m, -1 degree row).
    let worst = 0;
    for (const table of fixture.tables) {
      const factor = refractionFactor(table.elevation_m);
      expect(table.rows).toHaveLength(183);
      for (const [hTrue, hApparent] of table.rows) {
        const ours = apparentAltitudeDeg(hTrue, factor);
        worst = Math.max(worst, Math.abs(ours - hApparent) / ARCMIN);
      }
    }
    expect(worst).toBeLessThanOrEqual(1);
    expect(worst).toBeLessThanOrEqual(0.1);
  });

  it('never lowers an object and vanishes at the zenith rows', () => {
    for (const table of fixture.tables) {
      const factor = refractionFactor(table.elevation_m);
      for (const [hTrue] of table.rows) {
        expect(apparentAltitudeDeg(hTrue, factor)).toBeGreaterThanOrEqual(hTrue);
      }
      expect(apparentAltitudeDeg(90, factor)).toBe(90);
    }
  });
});

describe('trueAltitudeDeg (the UI inverse)', () => {
  it('inverts the fixture apparent altitudes within 0.03 arcmin and our own forward within 0.1', () => {
    // Skyfield's Bennett factor is 0.28 P / (T + 273) = 0.99929 of ours: at the horizon (39' of
    // refraction) that is 0.028 arcmin, which is why the fixture bound is 0.03 and not the 0.01
    // hoped for. The round trip through our own forward formula is bounded by how far the two
    // Bennett corrections are from their fixed point at -1 degree. Measured 2026-09-06: 0.027
    // arcmin vs the tables, 0.089 arcmin for the round trip (both at 2850 m, -1 degree).
    let worstTable = 0;
    let worstRoundTrip = 0;
    for (const table of fixture.tables) {
      const factor = refractionFactor(table.elevation_m);
      for (const [hTrue, hApparent] of table.rows) {
        worstTable = Math.max(
          worstTable,
          Math.abs(trueAltitudeDeg(hApparent, factor) - hTrue) / ARCMIN,
        );
        const back = trueAltitudeDeg(apparentAltitudeDeg(hTrue, factor), factor);
        worstRoundTrip = Math.max(worstRoundTrip, Math.abs(back - hTrue) / ARCMIN);
      }
    }
    expect(worstTable).toBeLessThanOrEqual(0.03);
    expect(worstRoundTrip).toBeLessThanOrEqual(0.1);
  });
});

describe('the -1 / 89.9 degree cut (Skyfield earthlib)', () => {
  it('is exact: no refraction at true -1.001 and 90.0, refraction at -1.0', () => {
    expect(apparentAltitudeDeg(-1.001, 1)).toBe(-1.001);
    expect(apparentAltitudeDeg(90, 1)).toBe(90);
    expect(apparentAltitudeDeg(89.95, 1)).toBe(89.95);
    expect(apparentAltitudeDeg(-1, 1)).toBeGreaterThan(-0.4);
    expect(apparentAltitudeDeg(89.89, 1)).toBeGreaterThan(89.89);
    // At exactly 89.9 the first Bennett step lands above the cut, so the second one is zero and
    // the result is the true altitude; Skyfield stops one step earlier (89.9000065, 0.0004').
    expect(apparentAltitudeDeg(89.9, 1)).toBe(89.9);
    expect(skyfieldRefractDeg(89.9, 10, 1010) - 89.9).toBeLessThan(1e-5);
    expect(saemundssonRefractionDeg(-1.001, 1)).toBe(0);
    expect(saemundssonRefractionDeg(89.91, 1)).toBe(0);
    expect(saemundssonRefractionDeg(0, 1)).toBeCloseTo(
      1.02 / Math.tan(((0 + 10.3 / 5.11) * Math.PI) / 180) / 60,
      12,
    );
    expect(bennettRefractionDeg(-1.5, 1)).toBe(0);
    expect(bennettRefractionDeg(89.95, 1)).toBe(0);
    expect(bennettRefractionDeg(0, 1)).toBeCloseTo(
      1 / Math.tan(((0 + 7.31 / 4.4) * Math.PI) / 180) / 60,
      12,
    );
    expect(bennettRefractionDeg(0, 0.5)).toBeCloseTo(bennettRefractionDeg(0, 1) / 2, 15);
  });
});

describe('skyfieldRefractDeg (test oracle)', () => {
  it('reproduces both tables to 1e-6 degrees', () => {
    for (const table of fixture.tables) {
      for (const [hTrue, hApparent] of table.rows) {
        expect(
          Math.abs(skyfieldRefractDeg(hTrue, 10, table.pressure_mbar) - hApparent),
        ).toBeLessThanOrEqual(1e-6);
      }
    }
    expect(skyfieldRefractDeg(-1.001, 10, 1010)).toBe(-1.001);
    expect(skyfieldRefractDeg(90, 10, 1010)).toBe(90);
  });

  it('stops after 20 iterations when the fixed point never converges', () => {
    // An absurd pressure pushes the refracted altitude above 89.9 (refraction 0 there), so the
    // iteration oscillates between -1 and a huge value forever without the cap.
    const alt = skyfieldRefractDeg(-1, 10, 1e6);
    expect(Number.isFinite(alt)).toBe(true);
    expect(alt === -1 || alt > 89.9).toBe(true);
  });
});

describe('why the seed is not enough (backlog B-50)', () => {
  it('Sæmundsson alone misses the 2850 m table by about 2 arcmin near -1 degree', () => {
    const table = fixture.tables.find((t) => t.elevation_m === 2850);
    if (table === undefined) {
      throw new Error('no 2850 m table');
    }
    const factor = refractionFactor(2850);
    const row = table.rows.find(([hTrue]) => hTrue === -1);
    if (row === undefined) {
      throw new Error('no -1 degree row');
    }
    const seedOnly = row[0] + saemundssonRefractionDeg(row[0], factor);
    const errorArcmin = Math.abs(seedOnly - row[1]) / ARCMIN;
    // Measured 2026-09-06: 2.02 arcmin (0.48 at sea level); the chained Bennett corrections
    // bring it to 0.057.
    expect(errorArcmin).toBeGreaterThan(1);
    expect(errorArcmin).toBeGreaterThan(1.5);
    expect(errorArcmin).toBeLessThan(2.5);
  });
});
