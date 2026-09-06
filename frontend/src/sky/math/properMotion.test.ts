// @vitest-environment node
// Parity of the client-side star rule with Skyfield (brief l.41, l.181, l.263; plan D88):
// `propagateStar` <= 0.1 arcsec against the barycentric direction, `apparentStar` (first-order
// aberration with the Earth velocity) <= 1 arcsec against `.apparent()`, for every star and epoch
// of `skyfield_stars.json`.

import { loadStarsFixture } from '../../test/fixtures';
import {
  C_AU_PER_DAY,
  aberrate,
  apparentStar,
  apparentStarAt,
  propagateStar,
  propagateStarAt,
} from './properMotion';
import { vec3 } from './typed';
import { arcsecBetween3, length3 } from './vec3';

const stars = loadStarsFixture();

/** The SKYS columns of the fixture stars, row `k` = star `k` (the layout of `StarColumns`). */
function columns(): { dir: Float32Array; pm: Float32Array } {
  const dir = new Float32Array(3 * stars.stars.length);
  const pm = new Float32Array(3 * stars.stars.length);
  stars.stars.forEach((star, k) => {
    dir.set(star.skys.dir, 3 * k);
    pm.set(star.skys.pm, 3 * k);
  });
  return { dir, pm };
}

describe('properMotion', () => {
  it('uses the IAU speed of light in au/day', () => {
    expect(C_AU_PER_DAY).toBe(173.1446);
    expect(stars.stars).toHaveLength(7);
    for (const star of stars.stars) {
      expect(star.samples).toHaveLength(6);
    }
  });

  it('propagateStar reproduces the barycentric direction within 0.1 arcsec', () => {
    // Measured 2026-09-06: 0.007 arcsec (Barnard's Star at -100 years).
    let worst = 0;
    for (const star of stars.stars) {
      for (const sample of star.samples) {
        const p = propagateStar(vec3(), star.skys.dir, star.skys.pm, sample.years_since_epoch);
        expect(length3(p)).toBeCloseTo(1, 15);
        worst = Math.max(worst, arcsecBetween3(p, sample.barycentric_dir));
      }
    }
    expect(worst).toBeLessThanOrEqual(0.1);
  });

  it('apparentStar with the Earth velocity reproduces Skyfield apparent() within 1 arcsec', () => {
    // Measured 2026-09-06: 0.655 arcsec (Proxima Centauri; parallax is ignored by design).
    let worst = 0;
    for (const star of stars.stars) {
      for (const sample of star.samples) {
        const p = apparentStar(
          vec3(),
          star.skys.dir,
          star.skys.pm,
          sample.years_since_epoch,
          sample.earth_velocity_au_d,
        );
        expect(length3(p)).toBeCloseTo(1, 15);
        worst = Math.max(worst, arcsecBetween3(p, sample.apparent_dir));
      }
    }
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('aberrate alone moves the barycentric direction by up to about 20 arcsec toward apparent', () => {
    for (const star of stars.stars) {
      for (const sample of star.samples) {
        const shift = arcsecBetween3(sample.barycentric_dir, sample.apparent_dir);
        const a = aberrate(vec3(), sample.barycentric_dir, sample.earth_velocity_au_d);
        expect(arcsecBetween3(a, sample.apparent_dir)).toBeLessThanOrEqual(1);
        expect(shift).toBeLessThan(21);
      }
    }
  });

  it('the column readers give the tuple results for every row', () => {
    const { dir, pm } = columns();
    stars.stars.forEach((star, k) => {
      for (const sample of star.samples) {
        const years = sample.years_since_epoch;
        const fromColumns = propagateStarAt(vec3(), dir, pm, k, years);
        // The columns are float32 like the real catalog: compare at float32 precision.
        const expected = propagateStar(
          vec3(),
          [dir[3 * k] ?? NaN, dir[3 * k + 1] ?? NaN, dir[3 * k + 2] ?? NaN],
          [pm[3 * k] ?? NaN, pm[3 * k + 1] ?? NaN, pm[3 * k + 2] ?? NaN],
          years,
        );
        expect(fromColumns).toEqual(expected);
        const apparent = apparentStarAt(vec3(), dir, pm, k, years, sample.earth_velocity_au_d);
        expect(arcsecBetween3(apparent, sample.apparent_dir)).toBeLessThanOrEqual(1);
      }
    });
    expect(() => propagateStarAt(vec3(), dir, pm, stars.stars.length, 0)).toThrow(RangeError);
  });
});
