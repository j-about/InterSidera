// Field of view of the AR camera video (AR-2 "approximate, adjustable", plan D123). Pure,
// dependency-free, allocation-free.
//
// The user (slider, pinch) sets the DIAGONAL field `D` of the rear camera: the figure makers
// quote for the 4:3 sensor is about 77-82 degrees and the 16:9 stream is a width-preserving crop
// of it, hence the 73 degree default. The video of `w x h` pixels is shown in a `W x H` box with
// `object-fit: cover`, so only `min(h, w H / W)` of its rows are visible; the vertical field the
// sky camera must render (`view.fov`, the shaders' single input) follows from the pinhole model:
// `tan(V / 2) = tan(D / 2) * min(h, w H / W) / sqrt(w^2 + h^2)`. Worked examples at D = 77: a
// 720x1280 portrait stream in a 412x839 box -> 69.5 degrees; 1280x720 in 839x412 -> 37.6.

import { DEG, RAD, clampFovDeg } from './frames';

/** Default assumed diagonal field of the 16:9 rear-camera stream, degrees (plan D123, Q56). */
export const DEFAULT_CAMERA_DIAGONAL_FOV_DEG = 73;
export const MIN_CAMERA_DIAGONAL_FOV_DEG = 50;
export const MAX_CAMERA_DIAGONAL_FOV_DEG = 110;

/** The part of a video frame that `object-fit: cover` shows, in frame pixels (`drawImage` source). */
export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Clamp the diagonal field to `[50, 110]` degrees; `NaN` falls back to the default. */
export function clampCameraDiagonalFovDeg(deg: number): number {
  if (Number.isNaN(deg)) {
    return DEFAULT_CAMERA_DIAGONAL_FOV_DEG;
  }
  return Math.max(MIN_CAMERA_DIAGONAL_FOV_DEG, Math.min(MAX_CAMERA_DIAGONAL_FOV_DEG, deg));
}

/** A frame or box dimension the model can use: finite and positive. */
function usable(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * The vertical field of view in degrees the sky camera must render so that the stars overlay a
 * `frameW x frameH` video shown in a `boxW x boxH` box with `object-fit: cover`, for a camera of
 * diagonal field `diagonalDeg`; through `clampFovDeg` ([1, 120]). Any non-positive or non-finite
 * argument (no metadata yet, a hidden canvas) yields `fallbackDeg` untouched.
 */
export function visibleVerticalFovDeg(
  diagonalDeg: number,
  frameW: number,
  frameH: number,
  boxW: number,
  boxH: number,
  fallbackDeg: number,
): number {
  if (
    !usable(diagonalDeg) ||
    !usable(frameW) ||
    !usable(frameH) ||
    !usable(boxW) ||
    !usable(boxH)
  ) {
    return fallbackDeg;
  }
  const visibleRows = Math.min(frameH, (frameW * boxH) / boxW);
  const tanHalf = (Math.tan((diagonalDeg / 2) * DEG) * visibleRows) / Math.hypot(frameW, frameH);
  return clampFovDeg(2 * Math.atan(tanHalf) * RAD);
}

/**
 * The source rectangle of the frame that `object-fit: cover` shows in the box, centred, written
 * into `out` (the PNG export draws the video with it). With an unusable dimension the whole
 * frame is returned (`sx = sy = 0`, `sw = frameW`, `sh = frameH`).
 */
export function coverCropRect(
  out: CropRect,
  frameW: number,
  frameH: number,
  boxW: number,
  boxH: number,
): CropRect {
  out.sx = 0;
  out.sy = 0;
  out.sw = frameW;
  out.sh = frameH;
  if (!usable(frameW) || !usable(frameH) || !usable(boxW) || !usable(boxH)) {
    return out;
  }
  if (frameW * boxH > frameH * boxW) {
    // The frame is wider than the box: full height, the sides cropped.
    out.sw = (frameH * boxW) / boxH;
    out.sx = (frameW - out.sw) / 2;
  } else {
    // The frame is taller than (or as tall as) the box: full width, top and bottom cropped.
    out.sh = (frameW * boxH) / boxW;
    out.sy = (frameH - out.sh) / 2;
  }
  return out;
}
