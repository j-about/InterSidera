// @vitest-environment node
// Minor-body rules (SKY-4, plan D102): the antisolar tangent and its degenerate cases, the disc
// radius clamp and the request composition (dedup, sort, cap with pins first, empty inputs).

import {
  COMET_TAIL_PX,
  MINOR_RADIUS_MAX_PX,
  MINOR_RADIUS_MIN_PX,
  antisolarTangent,
  composeMinorRequest,
  minorPixelRadius,
} from './minorBodies';
import { vec3 } from './typed';
import type { Vec3 } from './typed';
import { dot3, length3 } from './vec3';

describe('antisolarTangent', () => {
  it('points away from the Sun in the tangent plane of the body', () => {
    const out = vec3();
    // Body at the zenith, Sun on the east horizon: the tail points west.
    expect(antisolarTangent(out, [0, 0, 1], [1, 0, 0])).toBe(true);
    expect(out[0]).toBeCloseTo(-1, 12);
    expect(out[1]).toBeCloseTo(0, 12);
    expect(out[2]).toBeCloseTo(0, 12);
    // A general configuration: unit length, perpendicular to the body, facing away from the Sun.
    const d: Vec3 = [0.6, 0, 0.8];
    const s: Vec3 = [0, 0.6, 0.8];
    expect(antisolarTangent(out, d, s)).toBe(true);
    expect(length3(out)).toBeCloseTo(1, 12);
    expect(dot3(out, d)).toBeCloseTo(0, 12);
    expect(dot3(out, s)).toBeLessThan(0);
  });

  it('is undefined for a body at or opposite the Sun and leaves out untouched', () => {
    const out: Vec3 = [7, 8, 9];
    expect(antisolarTangent(out, [1, 0, 0], [1, 0, 0])).toBe(false);
    expect(antisolarTangent(out, [1, 0, 0], [-1, 0, 0])).toBe(false);
    expect(out).toEqual([7, 8, 9]);
  });
});

describe('minorPixelRadius', () => {
  it('follows clamp(1 + 0.5 (9 - mag), 1.5, 4) and draws an unknown magnitude at the minimum', () => {
    expect(MINOR_RADIUS_MIN_PX).toBe(1.5);
    expect(MINOR_RADIUS_MAX_PX).toBe(4);
    expect(COMET_TAIL_PX).toBe(30);
    // The formula gives 1 at magnitude 9; the floor lifts it to 1.5.
    expect(minorPixelRadius(9)).toBe(1.5);
    expect(minorPixelRadius(8)).toBe(1.5);
    expect(minorPixelRadius(7)).toBe(2);
    expect(minorPixelRadius(3)).toBe(4);
    expect(minorPixelRadius(-5)).toBe(4);
    expect(minorPixelRadius(15)).toBe(1.5);
    expect(minorPixelRadius(NaN)).toBe(1.5);
    expect(minorPixelRadius(Infinity)).toBe(1.5);
  });
});

describe('composeMinorRequest', () => {
  it('unions the pins and the first shown defaults, de-duplicated and sorted', () => {
    expect(
      composeMinorRequest(['c:1P', 'a:433', 'a:433'], ['a:1', 'a:2', 'c:1P', 'a:3'], 3, 100),
    ).toEqual(['a:1', 'a:2', 'a:433', 'c:1P']);
    expect(composeMinorRequest([], ['a:1', 'a:2'], 1, 100)).toEqual(['a:1']);
    expect(composeMinorRequest([], ['a:1', 'a:2'], 0, 100)).toEqual([]);
    expect(composeMinorRequest([], ['a:1', 'a:2'], -5, 100)).toEqual([]);
  });

  it('contributes nothing from an absent defaults list and returns [] when everything is empty', () => {
    expect(composeMinorRequest(['a:2', 'a:1'], null, 20, 100)).toEqual(['a:1', 'a:2']);
    expect(composeMinorRequest([], null, 20, 100)).toEqual([]);
    expect(composeMinorRequest([], [], 20, 100)).toEqual([]);
  });

  it('keeps the pins first at the cap and fills with defaults, skipping pinned ones', () => {
    const defaults = ['a:10', 'a:20', 'a:30', 'a:40', 'a:50'];
    // Two pins, cap 4: both pins plus the two first defaults, then sorted.
    expect(composeMinorRequest(['a:99', 'a:98'], defaults, 5, 4)).toEqual([
      'a:10',
      'a:20',
      'a:98',
      'a:99',
    ]);
    // A default that is also pinned does not consume a second slot, wherever it sits in the list.
    expect(composeMinorRequest(['a:20', 'a:99'], defaults, 5, 3)).toEqual(['a:10', 'a:20', 'a:99']);
    expect(composeMinorRequest(['a:10', 'a:99'], defaults, 5, 3)).toEqual(['a:10', 'a:20', 'a:99']);
    // More pins than the cap: the sorted pins alone, cut at the cap.
    expect(composeMinorRequest(['a:5', 'a:4', 'a:3'], defaults, 5, 2)).toEqual(['a:3', 'a:4']);
    // Exactly at the cap: nothing dropped.
    expect(composeMinorRequest(['a:5'], ['a:1'], 1, 2)).toEqual(['a:1', 'a:5']);
  });
});
