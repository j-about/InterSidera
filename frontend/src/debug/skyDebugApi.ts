// Shape of `window.__sky`, the debug hook of dev and e2e builds (brief l.410, plan D86).
// Types only. This file is a leaf reached from the Playwright specs (tsconfig.node.json), so it
// imports nothing but the leaf `state/types.ts`, with an explicit extension.

import type {
  AdapterInfo,
  Backend,
  ClockMode,
  FrameWindowInfo,
  Observer,
  ViewState,
} from '../state/types.ts';

export interface SkyDebugState {
  tt: number;
  mode: ClockMode;
  speed: number;
  observer: Observer;
  view: ViewState;
  frame: FrameWindowInfo | null;
  /** Client-side refraction toggle (Earth only). */
  refr: boolean;
  catalogs: { stars: number; index: number; dso: number; constellations: number };
  /** SKYS fetch, parse and HIP-index time in milliseconds (`StarCatalogInput.parseMs`), `null` before the catalog arrived. */
  parseMs: number | null;
}

/** Degrees. `alt` is what the engine renders (refracted when refraction applies), `altTrue` the geometric altitude. */
export interface SkyDebugAltAz {
  alt: number;
  altTrue: number;
  az: number;
}

/** Result of `selfTest()`: the numbers docs/testing.md records for a real-browser run (plan step 5). */
export interface SkyDebugReport {
  backend: Backend;
  adapterInfo: AdapterInfo | null;
  userAgent: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  tt: number;
  observer: Observer;
  refr: boolean;
  stars: number;
  parseMs: number | null;
  /** Rendering time the frame-rate figure covers, seconds. */
  seconds: number;
  fps: number;
  frameMs: number;
  /** Polaris (HIP 11767) altitude against the latitude, within 1 degree when `ok`. */
  polaris: { alt: number; lat: number; ok: boolean } | null;
  /** Rendered direction of every body against `/sky/altaz` at the same instant and refraction. */
  bodies: { id: string; sepArcmin: number }[];
  maxSepArcmin: number | null;
}

export interface SkyDebugApi {
  readonly backend: Backend;
  /** `true` once the catalog and the first frame window are rendered. */
  readonly isReady: boolean;
  /** Resolves when `isReady` becomes true. */
  readonly ready: Promise<void>;
  readonly adapterInfo: AdapterInfo | null;
  /** Frames per second over the last ten seconds of rendering. */
  fps(): number;
  state(): SkyDebugState;
  /**
   * The direction the engine currently renders for a body id (`mars`, `moon`, ...) or a star
   * (`hip:11767`), computed on the CPU with the same rules as the shaders; `null` when unknown.
   */
  altAzOf(id: string): SkyDebugAltAz | null;
  /** Screen position in CSS pixels of the same target, `null` when behind the camera. */
  screenOf(id: string): { x: number; y: number } | null;
  /** Pause at a TT Julian Date. */
  setTime(tt: number): void;
  pause(): void;
  play(speed: number): void;
  live(): void;
  setView(az: number, alt: number, fov?: number): void;
  setRefraction(on: boolean): void;
  /** Resolves once a frame window covering the current time has been rendered. */
  waitForFrame(): Promise<void>;
  stats(): { stars: number; frameMs: number };
  /**
   * The M3 sanity checks run inside the page (for real-browser runs, docs/testing.md): waits
   * `seconds` (default 10) of rendering after `ready`, then reports the frame rate, Polaris and
   * every body against `/sky/altaz`. A `selftest` key in the URL hash runs it after `ready` and
   * shows the JSON in an overlay; `report=<url>` also POSTs it there (dev and e2e builds only).
   */
  selfTest(seconds?: number): Promise<SkyDebugReport>;
}

declare global {
  interface Window {
    __sky?: SkyDebugApi;
  }
}
