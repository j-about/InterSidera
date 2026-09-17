// Engine creation (plan D81; brief l.86, l.538-541, l.551): WebGPU when the browser exposes
// `navigator.gpu` and `WebGPUEngine.IsSupportedAsync` resolves true (the engine class arrives
// through a dynamic import so WebGL2 users never download it), otherwise the WebGL2 `Engine`;
// no WebGL2 at all is the UX-6 `WebGL2UnavailableError`. Every `await` is followed by an abort
// check so a React StrictMode double effect disposes the engine it no longer wants. Neither
// `glslangOptions` nor `twgslOptions` is ever passed: every custom shader has a WGSL twin, so
// WebGPU never compiles GLSL and never downloads a wasm from a CDN (brief l.538).

import type { WebGPUEngineOptions } from '@babylonjs/core/Engines/webgpuEngine';

import type { AdapterInfo, Backend } from '../../state/types';
import { Engine, SetMissingSideEffectWarningsEnabled } from './babylon';
import type { AbstractEngine } from './babylon';
import { WebGL2UnavailableError } from './types';

export interface CreateEngineOptions {
  /** `'auto'` = WebGPU when supported, else WebGL2; `'webgl2'` skips the WebGPU probe. */
  preferBackend: Backend | 'auto';
  signal: AbortSignal;
  /** Threaded through now because WebGPU has no post-hoc XR compatibility (M5). */
  xrCompatible?: boolean | undefined;
  /** Dev and e2e builds: Babylon warns about missing side-effect imports. */
  debug?: boolean | undefined;
}

export interface CreatedEngine {
  engine: AbstractEngine;
  backend: Backend;
  /** `GPUAdapterInfo` of the WebGPU adapter; `null` under WebGL2 or when unavailable. */
  adapterInfo: AdapterInfo | null;
}

/** The rejection of an aborted creation (`signal.aborted` after an `await`). */
export function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError();
  }
}

/** Dispose an engine whose creation is being abandoned; a half-initialised engine may throw. */
function disposeQuietly(engine: AbstractEngine): void {
  try {
    engine.dispose();
  } catch {
    // The engine never finished initialising; there is nothing left to release.
  }
}

/** After an `await` with an engine in hand: release it and reject when the signal aborted. */
function disposeIfAborted(signal: AbortSignal, engine: AbstractEngine): void {
  if (signal.aborted) {
    disposeQuietly(engine);
    throw abortError();
  }
}

/** `navigator.gpu` is typed as always present by lib.dom but is absent in many browsers. */
function webGpuApi(): GPU | undefined {
  const nav: { gpu?: GPU } = navigator;
  return nav.gpu;
}

async function readAdapterInfo(gpu: GPU): Promise<AdapterInfo | null> {
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter === null) {
      return null;
    }
    const { vendor, architecture, description } = adapter.info;
    return { vendor, architecture, description };
  } catch {
    return null;
  }
}

/** `engine: null` = fall back to WebGL2; `initFailed` tells whether `initAsync` was reached. */
type WebGpuOutcome =
  | { engine: AbstractEngine; adapterInfo: AdapterInfo | null }
  | { engine: null; initFailed: boolean };

const NO_WEBGPU: WebGpuOutcome = { engine: null, initFailed: false };

async function tryWebGpu(
  canvas: HTMLCanvasElement,
  options: CreateEngineOptions,
): Promise<WebGpuOutcome> {
  const gpu = webGpuApi();
  if (gpu === undefined) {
    return NO_WEBGPU;
  }
  // The lazy chunk (plan D90): Babylon's WebGPU engine and the WGSL colour shader of LinesMesh.
  const { WebGPUEngine } = await import('./webgpu');
  throwIfAborted(options.signal);
  let supported: boolean;
  try {
    // A static getter, not a method (verified against @babylonjs/core 9.25.0).
    supported = await WebGPUEngine.IsSupportedAsync;
  } catch {
    supported = false;
  }
  throwIfAborted(options.signal);
  if (!supported) {
    return NO_WEBGPU;
  }
  const engineOptions: WebGPUEngineOptions = {
    antialias: true,
    powerPreference: 'high-performance',
    // Babylon's default (`premultipliedAlpha ?? true` -> canvas `alphaMode: "premultiplied"`),
    // written down because the AR mode relies on it (plan D122): the scene clears to alpha 0 and
    // the stars composite over the camera video behind the canvas.
    premultipliedAlpha: true,
    // Babylon's default tab index is 1: a positive value that would jump ahead of the skip link
    // and every control in the Tab order (UX-4). 0 keeps the canvas focusable in DOM order.
    canvasTabIndex: 0,
  };
  if (options.xrCompatible !== undefined) {
    engineOptions.xrCompatible = options.xrCompatible;
  }
  const engine = new WebGPUEngine(canvas, engineOptions);
  try {
    await engine.initAsync();
  } catch (error: unknown) {
    // Babylon rejects with a plain string when no adapter or device can be obtained; any
    // failure here falls back to WebGL2 (brief l.86). Known limit: `initAsync` calls
    // `canvas.getContext("webgpu")` only in its last step (after the device exists), and a
    // failure past that point leaves a WebGPU context on the canvas, so `getContext("webgl2")`
    // would return null. Only a new canvas element could undo that and React owns this one,
    // so `createEngine` reports the situation instead of hiding it (debug builds).
    if (options.debug === true) {
      console.warn('WebGPU initialisation failed, falling back to WebGL2', error);
    }
    disposeQuietly(engine);
    return { engine: null, initFailed: true };
  }
  disposeIfAborted(options.signal, engine);
  const adapterInfo = await readAdapterInfo(gpu);
  disposeIfAborted(options.signal, engine);
  return { engine, adapterInfo };
}

function createWebGl2(canvas: HTMLCanvasElement): AbstractEngine {
  let engine: Engine;
  try {
    engine = new Engine(canvas, true, {
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      loseContextOnDispose: true,
      // The WebGL defaults (`alpha: true`, `premultipliedAlpha: true`), written down because the
      // AR mode relies on them (plan D122): a transparent clear shows the camera video behind the
      // canvas and the premultiplied star pixels composite over it by definition.
      alpha: true,
      premultipliedAlpha: true,
      // Same reason as the WebGPU options: the canvas joins the Tab order in DOM position.
      canvasTabIndex: 0,
    });
  } catch (error: unknown) {
    // Babylon throws "WebGL not supported" when no context of any version can be created.
    throw new WebGL2UnavailableError(error instanceof Error ? error.message : undefined);
  }
  if (engine.webGLVersion < 2) {
    // Babylon silently fell back to WebGL1, which cannot run the GLSL ES 3.00 star shader.
    disposeQuietly(engine);
    throw new WebGL2UnavailableError();
  }
  return engine;
}

/**
 * Create the rendering engine on `canvas`. Resolves with the engine and the backend that won;
 * rejects with `AbortError` when `signal` aborts, with `WebGL2UnavailableError` when neither
 * backend exists.
 */
export async function createEngine(
  canvas: HTMLCanvasElement,
  options: CreateEngineOptions,
): Promise<CreatedEngine> {
  throwIfAborted(options.signal);
  if (options.debug === true) {
    SetMissingSideEffectWarningsEnabled(true);
  }
  let webGpuInitFailed = false;
  if (options.preferBackend !== 'webgl2') {
    const outcome = await tryWebGpu(canvas, options);
    if (outcome.engine !== null) {
      return { engine: outcome.engine, backend: 'webgpu', adapterInfo: outcome.adapterInfo };
    }
    webGpuInitFailed = outcome.initFailed;
  }
  throwIfAborted(options.signal);
  let engine: AbstractEngine;
  try {
    engine = createWebGl2(canvas);
  } catch (error: unknown) {
    if (webGpuInitFailed && options.debug === true) {
      // See `tryWebGpu`: the canvas may already own the WebGPU context of the failed attempt.
      console.warn(
        'WebGL2 fallback failed after a WebGPU attempt: the canvas may already hold a WebGPU context',
      );
    }
    throw error;
  }
  disposeIfAborted(options.signal, engine);
  return { engine, backend: 'webgl2', adapterInfo: null };
}
