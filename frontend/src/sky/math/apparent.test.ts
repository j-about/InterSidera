// @vitest-environment node
// The CPU direction twin (plan D94): parity of `apparentStarEnuAt` with Skyfield's apparent
// directions rotated by a fixture horizon quaternion (<= 1 arcsec, both refraction branches), the
// DSO path against the same rule, and the billboard basis with its degenerate branch.

import { loadFramesFixture, loadStarsFixture } from '../../test/fixtures';
import {
  BILLBOARD_EPSILON,
  apparentCatalogEnu,
  apparentStarEnuAt,
  billboardBasis,
  enuFromApparentIcrf,
  screenAngle,
} from './apparent';
import { altAzToEnu, enuToAltAz } from './frames';
import type { AltAz } from './frames';
import { aberrate } from './properMotion';
import { normalizeQ, rotate } from './quaternion';
import { apparentAltitudeDeg, refractionFactor } from './refraction';
import { quat, vec3 } from './typed';
import type { Quat, ReadonlyVec3, Vec3 } from './typed';
import { arcsecBetween3, dot3, length3 } from './vec3';

const stars = loadStarsFixture();
const frames = loadFramesFixture();

/** The horizon quaternion of the first sample of the Greenwich window. */
function greenwichQ(): Quat {
  const window = frames.windows.find((w) => w.observer === 'earth') ?? frames.windows[0];
  const q = window?.horizon_q[0];
  if (q === undefined) {
    throw new Error('frames fixture without a horizon quaternion');
  }
  return normalizeQ(quat(), q);
}

/** The SKYS columns of the fixture stars, row `k` = star `k`. */
function columns(): { dir: Float32Array; pm: Float32Array } {
  const dir = new Float32Array(3 * stars.stars.length);
  const pm = new Float32Array(3 * stars.stars.length);
  stars.stars.forEach((star, k) => {
    dir.set(star.skys.dir, 3 * k);
    pm.set(star.skys.pm, 3 * k);
  });
  return { dir, pm };
}

/** The reference: the fixture apparent direction rotated, then refracted like the shader. */
function reference(apparentIcrf: ReadonlyVec3, q: Quat, refraction: boolean, factor: number): Vec3 {
  const enu = rotate(vec3(), q, apparentIcrf);
  if (!refraction) {
    return enu;
  }
  const altAz: AltAz = { alt: 0, az: 0 };
  enuToAltAz(altAz, enu[0], enu[1], enu[2]);
  return altAzToEnu(vec3(), apparentAltitudeDeg(altAz.alt, factor), altAz.az);
}

describe('apparentStarEnuAt', () => {
  const q = greenwichQ();
  const factor = refractionFactor(0);

  it.each([false, true])(
    'matches Skyfield apparent directions within 1 arcsec (refraction %s)',
    (refraction) => {
      const cols = columns();
      let worst = 0;
      stars.stars.forEach((star, k) => {
        for (const sample of star.samples) {
          const enu = apparentStarEnuAt(
            vec3(),
            cols,
            k,
            sample.years_since_epoch,
            sample.earth_velocity_au_d,
            q,
            refraction,
            factor,
          );
          expect(length3(enu)).toBeCloseTo(1, 12);
          const ref = reference(sample.apparent_dir, q, refraction, factor);
          worst = Math.max(worst, arcsecBetween3(enu, ref));
        }
      });
      expect(worst).toBeLessThanOrEqual(1);
    },
  );

  it('keeps the azimuth and lifts the altitude when refraction is on', () => {
    const cols = columns();
    const off = apparentStarEnuAt(vec3(), cols, 0, 0, [0, 0, 0], q, false, factor);
    const on = apparentStarEnuAt(vec3(), cols, 0, 0, [0, 0, 0], q, true, factor);
    const a: AltAz = { alt: 0, az: 0 };
    const b: AltAz = { alt: 0, az: 0 };
    enuToAltAz(a, off[0], off[1], off[2]);
    enuToAltAz(b, on[0], on[1], on[2]);
    expect(b.az).toBeCloseTo(a.az, 9);
    if (a.alt > -1 && a.alt < 89.9) {
      expect(b.alt).toBeGreaterThan(a.alt);
    } else {
      expect(b.alt).toBeCloseTo(a.alt, 12);
    }
  });
});

describe('apparentCatalogEnu and enuFromApparentIcrf', () => {
  const q = greenwichQ();

  it('applies aberration then the rotation, exactly like the star rule without proper motion', () => {
    for (const star of stars.stars) {
      for (const sample of star.samples) {
        const viaCatalog = apparentCatalogEnu(
          vec3(),
          sample.barycentric_dir,
          sample.earth_velocity_au_d,
          q,
          false,
          1,
        );
        const expected = rotate(
          vec3(),
          q,
          aberrate(vec3(), sample.barycentric_dir, sample.earth_velocity_au_d),
        );
        expect(arcsecBetween3(viaCatalog, expected)).toBeLessThan(1e-6);
        // And within 1 arcsec of Skyfield's apparent direction rotated.
        expect(
          arcsecBetween3(viaCatalog, rotate(vec3(), q, sample.apparent_dir)),
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('enuFromApparentIcrf aliases out with its input and refracts on demand', () => {
    const d: Vec3 = [0.3, 0.4, Math.sqrt(1 - 0.25)];
    const plain = enuFromApparentIcrf(vec3(), d, q, false, 1);
    const aliased: Vec3 = [d[0], d[1], d[2]];
    expect(enuFromApparentIcrf(aliased, aliased, q, false, 1)).toBe(aliased);
    expect(aliased).toEqual(plain);
    const refracted = enuFromApparentIcrf(vec3(), d, q, true, refractionFactor(0));
    const a: AltAz = { alt: 0, az: 0 };
    const b: AltAz = { alt: 0, az: 0 };
    enuToAltAz(a, plain[0], plain[1], plain[2]);
    enuToAltAz(b, refracted[0], refracted[1], refracted[2]);
    expect(b.az).toBeCloseTo(a.az, 9);
    expect(b.alt).toBeCloseTo(apparentAltitudeDeg(a.alt, refractionFactor(0)), 9);
  });
});

describe('billboardBasis', () => {
  it('is orthonormal with right x up toward the viewer for an off-axis object', () => {
    const dir: Vec3 = [0.3, 0.8, 0.5];
    const len = length3(dir);
    const unit: Vec3 = [dir[0] / len, dir[1] / len, dir[2] / len];
    // Camera looking north: right = east.
    const cameraRight: Vec3 = [1, 0, 0];
    const right = vec3();
    const up = vec3();
    billboardBasis(right, up, unit, cameraRight);
    expect(length3(right)).toBeCloseTo(1, 12);
    expect(length3(up)).toBeCloseTo(1, 12);
    expect(dot3(right, up)).toBeCloseTo(0, 12);
    expect(dot3(right, unit)).toBeCloseTo(0, 12);
    expect(dot3(up, unit)).toBeCloseTo(0, 12);
    // right x up = -dir (toward the viewer at the origin).
    const cx = right[1] * up[2] - right[2] * up[1];
    const cy = right[2] * up[0] - right[0] * up[2];
    const cz = right[0] * up[1] - right[1] * up[0];
    expect(cx).toBeCloseTo(-unit[0], 12);
    expect(cy).toBeCloseTo(-unit[1], 12);
    expect(cz).toBeCloseTo(-unit[2], 12);
    // Screen right stays the camera's right when the object is on the optical axis.
    billboardBasis(right, up, [0, 1, 0], cameraRight);
    expect(right).toEqual([1, 0, 0]);
    expect(up[2]).toBeCloseTo(1, 12);
  });

  it('falls back to the horizontal direction when the object lies on the camera right axis', () => {
    const right = vec3();
    const up = vec3();
    expect(BILLBOARD_EPSILON).toBe(1e-12);
    billboardBasis(right, up, [1, 0, 0], [1, 0, 0]);
    // dir x Up = (1,0,0) x (0,0,1) = (0,-1,0)
    expect(right[0]).toBeCloseTo(0, 12);
    expect(right[1]).toBeCloseTo(-1, 12);
    expect(right[2]).toBeCloseTo(0, 12);
    expect(length3(up)).toBeCloseTo(1, 12);
    expect(dot3(up, right)).toBeCloseTo(0, 12);
  });
});

describe('screenAngle', () => {
  it('measures counter-clockwise from screen right', () => {
    const right: Vec3 = [1, 0, 0];
    const up: Vec3 = [0, 0, 1];
    expect(screenAngle(right, right, up)).toBe(0);
    expect(screenAngle(up, right, up)).toBeCloseTo(Math.PI / 2, 12);
    expect(screenAngle([-1, 0, 0], right, up)).toBeCloseTo(Math.PI, 12);
    expect(screenAngle([0, 0, -1], right, up)).toBeCloseTo(-Math.PI / 2, 12);
  });
});
