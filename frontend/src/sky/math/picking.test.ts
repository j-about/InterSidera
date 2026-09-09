// @vitest-environment node
// Picking helpers (INFO-1, plan D106): the field-of-view tolerance, the cone pre-filter on
// propagated and unit directions, the magnitude-sorted row limit and the nearest-candidate
// accumulator with its tie-break order.

import { DEG } from './frames';
import {
  PICK_CONE_MARGIN_DEG,
  PICK_TIE_PX,
  PICK_TOLERANCE_PX,
  coneCosine,
  createPickBest,
  inCone,
  nearestWithin,
  pickPriority,
  pickToleranceDeg,
  resetPickBest,
  starInCone,
  starRowLimit,
} from './picking';

describe('pickToleranceDeg and coneCosine', () => {
  it('scales 24 css px by the field of view over the height and widens the cone by 0.6 degrees', () => {
    expect(PICK_TOLERANCE_PX).toBe(24);
    expect(PICK_CONE_MARGIN_DEG).toBe(0.6);
    expect(pickToleranceDeg(24, 60, 600)).toBeCloseTo(2.4, 12);
    expect(pickToleranceDeg(24, 1, 1200)).toBeCloseTo(0.02, 12);
    expect(pickToleranceDeg(24, 60, 600)).toBe(2 * pickToleranceDeg(24, 60, 1200));
    expect(coneCosine(0)).toBeCloseTo(Math.cos(0.6 * DEG), 15);
    expect(coneCosine(2.4)).toBeCloseTo(Math.cos(3 * DEG), 15);
  });
});

describe('starRowLimit', () => {
  it('finds the first row fainter than the limit in a magnitude-sorted column', () => {
    const mags = Int16Array.from([-1460, 0, 1000, 2500, 2500, 6500, 9000]);
    expect(starRowLimit(mags, mags.length, 6.5)).toBe(6);
    expect(starRowLimit(mags, mags.length, 2.5)).toBe(5);
    expect(starRowLimit(mags, mags.length, 2.4)).toBe(3);
    expect(starRowLimit(mags, mags.length, -2)).toBe(0);
    expect(starRowLimit(mags, mags.length, 20)).toBe(7);
    // A shorter logical count and an empty column.
    expect(starRowLimit(mags, 3, 20)).toBe(3);
    expect(starRowLimit(new Int16Array(0), 0, 6.5)).toBe(0);
  });
});

describe('starInCone and inCone', () => {
  it('tests the propagated direction against the cone without normalising it', () => {
    const dirs = Float32Array.from([1, 0, 0, 0, 1, 0]);
    const pms = Float32Array.from([0, 0.001, 0, 0, 0, 0]);
    const cos1 = Math.cos(1 * DEG);
    expect(starInCone(dirs, pms, 0, 0, [1, 0, 0], cos1)).toBe(true);
    expect(starInCone(dirs, pms, 1, 0, [1, 0, 0], cos1)).toBe(false);
    // 1000 years of proper motion move star 0 by about 45 degrees toward +Y.
    expect(starInCone(dirs, pms, 0, 1000, [1, 0, 0], cos1)).toBe(false);
    const diagonal = Math.SQRT1_2;
    expect(starInCone(dirs, pms, 0, 1000, [diagonal, diagonal, 0], cos1)).toBe(true);
    expect(() => starInCone(dirs, pms, 2, 0, [1, 0, 0], cos1)).toThrow(RangeError);
    expect(inCone([1, 0, 0], [1, 0, 0], cos1)).toBe(true);
    expect(inCone([0, 1, 0], [1, 0, 0], cos1)).toBe(false);
  });
});

describe('nearestWithin', () => {
  it('orders the kinds body > minor > dso > star', () => {
    expect(pickPriority('body')).toBeLessThan(pickPriority('minor'));
    expect(pickPriority('minor')).toBeLessThan(pickPriority('dso'));
    expect(pickPriority('dso')).toBeLessThan(pickPriority('star'));
  });

  it('keeps the nearest candidate within the tolerance', () => {
    const best = createPickBest();
    expect(best).toEqual({ id: null, kind: 'star', distPx: Infinity, tolPx: 24 });
    resetPickBest(best, 10);
    expect(best.tolPx).toBe(10);
    expect(nearestWithin(best, 'far', 'body', 10.5)).toBe(false);
    expect(best.id).toBeNull();
    expect(nearestWithin(best, 'hip:1', 'star', 8)).toBe(true);
    expect(best).toMatchObject({ id: 'hip:1', kind: 'star', distPx: 8 });
    // Clearly nearer: replaces regardless of kind.
    expect(nearestWithin(best, 'hip:2', 'star', 2)).toBe(true);
    expect(best.id).toBe('hip:2');
    // Clearly farther: ignored even for a body.
    expect(nearestWithin(best, 'moon', 'body', 6)).toBe(false);
    expect(best.id).toBe('hip:2');
    // NaN never lands.
    expect(nearestWithin(best, 'nan', 'body', NaN)).toBe(false);
    // Exactly at the tolerance is still inside.
    resetPickBest(best, 10);
    expect(nearestWithin(best, 'edge', 'dso', 10)).toBe(true);
  });

  it('lets the kind priority decide a tie within 3 px, and nothing else', () => {
    expect(PICK_TIE_PX).toBe(3);
    const best = createPickBest();
    resetPickBest(best, 24);
    expect(nearestWithin(best, 'hip:1', 'star', 5)).toBe(true);
    // A body 2 px farther ties and wins; a star 2 px nearer ties and loses (same priority).
    expect(nearestWithin(best, 'mars', 'body', 7)).toBe(true);
    expect(best.id).toBe('mars');
    expect(nearestWithin(best, 'hip:2', 'star', 5)).toBe(false);
    expect(best.id).toBe('mars');
    // A minor body or a DSO tying with a body loses; a star 3.5 px nearer wins outright.
    expect(nearestWithin(best, 'a:1', 'minor', 6)).toBe(false);
    expect(nearestWithin(best, 'dso:NGC1', 'dso', 6)).toBe(false);
    expect(nearestWithin(best, 'hip:3', 'star', 3.4)).toBe(true);
    expect(best.id).toBe('hip:3');
    // Within the tie window again: minor beats dso beats star, body beats all.
    expect(nearestWithin(best, 'dso:NGC2', 'dso', 4)).toBe(true);
    expect(nearestWithin(best, 'a:2', 'minor', 5)).toBe(true);
    expect(nearestWithin(best, 'dso:NGC3', 'dso', 5)).toBe(false);
    expect(nearestWithin(best, 'sun', 'body', 6)).toBe(true);
    expect(best).toMatchObject({ id: 'sun', kind: 'body', distPx: 6 });
  });
});
