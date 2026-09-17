// @vitest-environment node
// The AR camera field model (plan D123): the diagonal clamp, the visible vertical field under
// `object-fit: cover` on both crop branches and the worked examples, and the crop rectangle.

import { createArState } from '../../state/types';
import type { CropRect } from './cameraFov';
import {
  DEFAULT_CAMERA_DIAGONAL_FOV_DEG,
  MAX_CAMERA_DIAGONAL_FOV_DEG,
  MIN_CAMERA_DIAGONAL_FOV_DEG,
  clampCameraDiagonalFovDeg,
  coverCropRect,
  visibleVerticalFovDeg,
} from './cameraFov';
import { DEG, RAD } from './frames';

/** The model spelled out for one branch, so the kernel is checked against the formula itself. */
function expectedVerticalDeg(d: number, w: number, h: number, wBox: number, hBox: number): number {
  const rows = Math.min(h, (w * hBox) / wBox);
  return 2 * Math.atan((Math.tan((d / 2) * DEG) * rows) / Math.hypot(w, h)) * RAD;
}

describe('constants and the clamp', () => {
  it('default 73 in [50, 110], shared with the store leaf', () => {
    expect(DEFAULT_CAMERA_DIAGONAL_FOV_DEG).toBe(73);
    expect(MIN_CAMERA_DIAGONAL_FOV_DEG).toBe(50);
    expect(MAX_CAMERA_DIAGONAL_FOV_DEG).toBe(110);
    // `state/types.ts` cannot import this module (tsconfig.node.json, nodenext): the literal is
    // restated there and pinned here.
    expect(createArState().cameraFovDeg).toBe(DEFAULT_CAMERA_DIAGONAL_FOV_DEG);
  });

  it('clamps to [50, 110] and maps NaN to the default', () => {
    expect(clampCameraDiagonalFovDeg(20)).toBe(50);
    expect(clampCameraDiagonalFovDeg(50)).toBe(50);
    expect(clampCameraDiagonalFovDeg(73.5)).toBe(73.5);
    expect(clampCameraDiagonalFovDeg(110)).toBe(110);
    expect(clampCameraDiagonalFovDeg(180)).toBe(110);
    expect(clampCameraDiagonalFovDeg(Infinity)).toBe(110);
    expect(clampCameraDiagonalFovDeg(-Infinity)).toBe(50);
    expect(clampCameraDiagonalFovDeg(NaN)).toBe(73);
  });
});

describe('visibleVerticalFovDeg', () => {
  it('reproduces the worked examples of plan D123 at a 77 degree diagonal', () => {
    // A 720x1280 portrait stream in a 412x839 box: the full height is visible.
    expect(visibleVerticalFovDeg(77, 720, 1280, 412, 839, 60)).toBeCloseTo(69.5, 1);
    // A 1280x720 landscape stream in an 839x412 box: the box is wider, rows are cropped.
    expect(visibleVerticalFovDeg(77, 1280, 720, 839, 412, 60)).toBeCloseTo(37.6, 1);
  });

  it('follows the formula on both crop branches and at equal aspect', () => {
    // Frame taller than the box (rows fully visible): min(h, w H / W) = h.
    expect(visibleVerticalFovDeg(73, 720, 1280, 412, 839, 60)).toBeCloseTo(
      expectedVerticalDeg(73, 720, 1280, 412, 839),
      12,
    );
    // Frame wider than the box: rows cropped to w H / W.
    expect(visibleVerticalFovDeg(73, 1280, 720, 839, 412, 60)).toBeCloseTo(
      expectedVerticalDeg(73, 1280, 720, 839, 412),
      12,
    );
    // Equal aspect: every row visible, both branches agree, V from the diagonal alone.
    const square = 2 * Math.atan(Math.tan(36.5 * DEG) * (720 / Math.hypot(1280, 720))) * RAD;
    expect(visibleVerticalFovDeg(73, 1280, 720, 1280, 720, 60)).toBeCloseTo(square, 12);
    expect(visibleVerticalFovDeg(73, 1280, 720, 640, 360, 60)).toBeCloseTo(square, 12);
  });

  it('is monotonic in the diagonal and clamped to [1, 120]', () => {
    let previous = 0;
    for (let d = 50; d <= 110; d += 5) {
      const v = visibleVerticalFovDeg(d, 1280, 720, 839, 412, 60);
      expect(v).toBeGreaterThan(previous);
      previous = v;
    }
    // A tiny diagonal on a wide frame in a wider box falls below one degree: clamped up.
    expect(visibleVerticalFovDeg(0.5, 4000, 100, 4000, 1, 60)).toBe(1);
    // A near-180 degree diagonal exceeds the camera range: clamped down.
    expect(visibleVerticalFovDeg(179.9, 720, 1280, 412, 839, 60)).toBe(120);
  });

  it('returns the fallback for a zero, negative or non-finite argument', () => {
    expect(visibleVerticalFovDeg(73, 0, 720, 839, 412, 61)).toBe(61);
    expect(visibleVerticalFovDeg(73, 1280, 0, 839, 412, 62)).toBe(62);
    expect(visibleVerticalFovDeg(73, 1280, 720, 0, 412, 63)).toBe(63);
    expect(visibleVerticalFovDeg(73, 1280, 720, 839, 0, 64)).toBe(64);
    expect(visibleVerticalFovDeg(73, NaN, 720, 839, 412, 65)).toBe(65);
    expect(visibleVerticalFovDeg(73, 1280, Infinity, 839, 412, 66)).toBe(66);
    expect(visibleVerticalFovDeg(73, 1280, 720, -839, 412, 67)).toBe(67);
    expect(visibleVerticalFovDeg(NaN, 1280, 720, 839, 412, 68)).toBe(68);
    expect(visibleVerticalFovDeg(0, 1280, 720, 839, 412, 69)).toBe(69);
  });
});

describe('coverCropRect', () => {
  const out: CropRect = { sx: NaN, sy: NaN, sw: NaN, sh: NaN };

  it('crops the sides of a frame wider than the box, centred', () => {
    expect(coverCropRect(out, 1280, 720, 412, 839)).toBe(out);
    expect(out.sh).toBe(720);
    expect(out.sy).toBe(0);
    expect(out.sw).toBeCloseTo((720 * 412) / 839, 12);
    expect(out.sx + out.sw / 2).toBeCloseTo(1280 / 2, 12);
    expect(out.sx).toBeGreaterThan(0);
  });

  it('crops the top and bottom of a frame taller than the box, centred', () => {
    coverCropRect(out, 720, 1280, 839, 412);
    expect(out.sw).toBe(720);
    expect(out.sx).toBe(0);
    expect(out.sh).toBeCloseTo((720 * 412) / 839, 12);
    expect(out.sy + out.sh / 2).toBeCloseTo(1280 / 2, 12);
    expect(out.sy).toBeGreaterThan(0);
  });

  it('shows the whole frame at equal aspect and with an unusable dimension', () => {
    coverCropRect(out, 1280, 720, 640, 360);
    expect(out).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 720 });
    coverCropRect(out, 1280, 720, 0, 360);
    expect(out).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 720 });
    coverCropRect(out, 0, 720, 640, 360);
    expect(out).toEqual({ sx: 0, sy: 0, sw: 0, sh: 720 });
    coverCropRect(out, 1280, NaN, 640, 360);
    expect(out.sx).toBe(0);
    expect(out.sy).toBe(0);
    expect(out.sw).toBe(1280);
    expect(out.sh).toBeNaN();
    coverCropRect(out, 1280, 720, 640, -1);
    expect(out).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 720 });
  });
});
