// @vitest-environment node
// The WebXR probe and the failure map of plan D128/D129 with structural fakes: every backend,
// every `isSessionSupported` outcome (true, false, a rejection, a synchronous throw) and every
// rejection shape an entry can produce (DOMException names, Babylon's string, the bridge's
// `XrUnavailableError`, plain and unknown values).

import type { XrSystemLike } from './webxr';
import {
  BABYLON_XR_UNSUPPORTED_MESSAGE,
  XrUnavailableError,
  classifyXrFailure,
  probeXr,
  xrSystemOf,
} from './webxr';

function xrAnswering(answer: () => Promise<boolean>): XrSystemLike {
  return { isSessionSupported: answer };
}

describe('probeXr (plan D129)', () => {
  it('is unsupported without navigator.xr', async () => {
    await expect(probeXr(undefined, 'webgl2')).resolves.toBe('unsupported');
  });

  it('is supported only on the WebGL2 backend', async () => {
    const yes = vi.fn(() => Promise.resolve(true));
    const xr = xrAnswering(yes);
    await expect(probeXr(xr, 'webgl2')).resolves.toBe('supported');
    expect(yes).toHaveBeenCalledWith('immersive-ar');
    await expect(probeXr(xr, 'webgpu')).resolves.toBe('unsupported');
    await expect(probeXr(xr, null)).resolves.toBe('unsupported');
    // The WebGPU and unknown backends never ask the browser.
    expect(yes).toHaveBeenCalledTimes(1);
  });

  it('is unsupported when the browser answers false, rejects or throws', async () => {
    await expect(
      probeXr(
        xrAnswering(() => Promise.resolve(false)),
        'webgl2',
      ),
    ).resolves.toBe('unsupported');
    await expect(
      probeXr(
        xrAnswering(() => Promise.reject(new DOMException('policy', 'SecurityError'))),
        'webgl2',
      ),
    ).resolves.toBe('unsupported');
    const throwing: XrSystemLike = {
      isSessionSupported() {
        throw new TypeError('not a function');
      },
    };
    await expect(probeXr(throwing, 'webgl2')).resolves.toBe('unsupported');
  });
});

describe('xrSystemOf', () => {
  it('accepts an object with isSessionSupported and refuses everything else', () => {
    const xr = xrAnswering(() => Promise.resolve(true));
    expect(xrSystemOf(xr)).toBe(xr);
    expect(xrSystemOf(undefined)).toBeUndefined();
    expect(xrSystemOf(null)).toBeUndefined();
    expect(xrSystemOf('xr')).toBeUndefined();
    expect(xrSystemOf({})).toBeUndefined();
    expect(xrSystemOf({ isSessionSupported: true })).toBeUndefined();
  });
});

describe('classifyXrFailure (plan D128)', () => {
  it('maps the DOMException names of requestSession', () => {
    expect(classifyXrFailure(new DOMException('no ARCore', 'NotSupportedError'))).toBe(
      'xrUnsupported',
    );
    expect(classifyXrFailure(new DOMException('activation', 'SecurityError'))).toBe('xrDenied');
    expect(classifyXrFailure(new DOMException('consent', 'NotAllowedError'))).toBe('xrDenied');
    expect(classifyXrFailure(new DOMException('pending', 'InvalidStateError'))).toBe('xrBusy');
    expect(classifyXrFailure(new DOMException('gone', 'AbortError'))).toBeNull();
    expect(classifyXrFailure(new DOMException('other', 'NetworkError'))).toBe('xrFailed');
  });

  it("maps Babylon's thrown string and the bridge's XrUnavailableError to xrUnsupported", () => {
    expect(classifyXrFailure(BABYLON_XR_UNSUPPORTED_MESSAGE)).toBe('xrUnsupported');
    expect(classifyXrFailure('WebXR not supported on this browser')).toBe('xrUnsupported');
    expect(classifyXrFailure('something else')).toBe('xrFailed');
    const unavailable = new XrUnavailableError();
    expect(unavailable.name).toBe('XrUnavailableError');
    expect(unavailable.message).toBe('WebXR is not available on this device');
    expect(new XrUnavailableError('custom').message).toBe('custom');
    expect(classifyXrFailure(unavailable)).toBe('xrUnsupported');
  });

  it('reads the name of plain error-like objects and falls back to xrFailed', () => {
    expect(classifyXrFailure({ name: 'InvalidStateError' })).toBe('xrBusy');
    expect(classifyXrFailure(new Error('boom'))).toBe('xrFailed');
    // The bridge wraps Babylon's thrown string in an Error: the message keeps the meaning.
    expect(classifyXrFailure(new Error(BABYLON_XR_UNSUPPORTED_MESSAGE))).toBe('xrUnsupported');
    expect(classifyXrFailure({ name: 42 })).toBe('xrFailed');
    expect(classifyXrFailure({})).toBe('xrFailed');
    expect(classifyXrFailure(null)).toBe('xrFailed');
    expect(classifyXrFailure(undefined)).toBe('xrFailed');
    expect(classifyXrFailure(7)).toBe('xrFailed');
  });
});
