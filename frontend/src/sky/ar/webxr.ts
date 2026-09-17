// WebXR support and failure classification (AR-4, AR-5; brief l.240-241; plan D128, D129).
// Babylon-free, part of the lazy AR chunks: the sensor controller (`arController.ts`) probes the
// support with `probeXr` once the sensor mode runs, and the XR flow of the engine
// (`sky/engine/xr/xrFlow.ts`) maps every entry rejection to one `ArError` with
// `classifyXrFailure`. Nothing here touches Babylon, the DOM or the store: the caller hands in
// `navigator.xr` (structurally typed, so the unit tests and the Playwright stub never mention
// `XRSystem`) and the engine backend.

import type { ArError, Backend, XrSupport } from '../../state/types';

/** The part of `navigator.xr` the probe reads (an `XRSystem`, structurally). */
export interface XrSystemLike {
  isSessionSupported(mode: 'immersive-ar'): Promise<boolean>;
}

/**
 * Babylon's rejection when `navigator.xr` is absent at entry: `enterXRAsync` throws this string
 * (not an `Error`) when the experience helper found no XR system.
 */
export const BABYLON_XR_UNSUPPORTED_MESSAGE = 'WebXR not supported in this browser or environment';

/**
 * Thrown by the bridge when `WebXRDefaultExperience.CreateAsync` produced no experience helper
 * (Babylon swallows its own error, logs it and returns a result whose `baseExperience` is
 * undefined): the device has no WebXR runtime. Classified `xrUnsupported`.
 */
export class XrUnavailableError extends Error {
  constructor(message = 'WebXR is not available on this device') {
    super(message);
    this.name = 'XrUnavailableError';
  }
}

/** `navigator.xr` as an `XrSystemLike` when it carries `isSessionSupported`, else undefined. */
export function xrSystemOf(candidate: unknown): XrSystemLike | undefined {
  if (typeof candidate !== 'object' || candidate === null) {
    return undefined;
  }
  const record: { isSessionSupported?: unknown } = candidate;
  return typeof record.isSessionSupported === 'function' ? (candidate as XrSystemLike) : undefined;
}

/**
 * Whether an `immersive-ar` session can be offered (plan D129): `supported` only when
 * `isSessionSupported('immersive-ar')` resolves `true` AND the engine runs on WebGL2 (Babylon's
 * WebGPU path needs `XRGPUBinding` and the Layers feature, which browsers ship behind flags;
 * backlog B-79). Own `try/catch`: Babylon's `IsSessionSupportedAsync` converts a synchronous
 * throw only, a rejected promise would propagate. Never rejects.
 */
export async function probeXr(
  xr: XrSystemLike | undefined,
  backend: Backend | null,
): Promise<XrSupport> {
  if (xr === undefined || backend !== 'webgl2') {
    return 'unsupported';
  }
  try {
    return (await xr.isSessionSupported('immersive-ar')) ? 'supported' : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

/**
 * The AR-5 code of a WebXR entry failure (plan D128), or `null` for a silent one:
 * - `NotSupportedError` (the mode or a required feature such as `dom-overlay` is unsupported, or
 *   the user declined the consent or the Google Play Services for AR install), Babylon's own
 *   "WebXR not supported" string (raw, or wrapped in an `Error` by the bridge) and the bridge's
 *   `XrUnavailableError` -> `xrUnsupported`;
 * - `SecurityError` (no transient activation, a permissions policy) and `NotAllowedError`
 *   (Chromium's denial) -> `xrDenied`;
 * - `InvalidStateError` (another immersive session is pending or active) -> `xrBusy`;
 * - `AbortError` (the engine or the session went away during the entry) -> `null`, no banner;
 * - anything else -> `xrFailed`.
 */
export function classifyXrFailure(error: unknown): ArError | null {
  if (typeof error === 'string') {
    return error.includes('WebXR not supported') ? 'xrUnsupported' : 'xrFailed';
  }
  if (error instanceof Error && error.message.includes('WebXR not supported')) {
    return 'xrUnsupported';
  }
  const name = errorName(error);
  switch (name) {
    case 'NotSupportedError':
    case 'XrUnavailableError':
      return 'xrUnsupported';
    case 'SecurityError':
    case 'NotAllowedError':
      return 'xrDenied';
    case 'InvalidStateError':
      return 'xrBusy';
    case 'AbortError':
      return null;
    default:
      return 'xrFailed';
  }
}

/** The `name` of a thrown object when it carries a string one (`Error`, `DOMException`). */
function errorName(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const record: { name?: unknown } = error;
  return typeof record.name === 'string' ? record.name : null;
}
