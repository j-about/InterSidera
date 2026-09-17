// The AR-1 gate (brief l.237, l.579; plan D125). Main bundle, a few hundred bytes: the AR button
// must exist before any AR code loads (backlog B-75). What can be known before any permission:
// a secure context, `navigator.mediaDevices` (secure contexts only; every browser that also has
// `DeviceOrientationEvent` ships `getUserMedia` on it, and the literal name itself is reserved to
// the lazy camera chunk by the D131 gate, which fails an eager chunk containing it), the
// `DeviceOrientationEvent` constructor (present on desktop Chromium too, so never a discriminator
// on its own), a touch or coarse pointer (the one signal that filters desktops; both hold under
// Playwright's Pixel 7 emulation), and, only once those hold, `enumerateDevices()` for a
// `videoinput` (before a capture it exposes two bits and prompts nothing; a desktop never calls
// it). The rear facing is unknowable before a capture
// (`MediaDeviceInfo` never carries it) and is verified at entry by `sky/ar/cameraVideo.ts`
// (backlog B-76). `arButtonVisible` adds the Earth condition as a store selector, so switching the
// observer to Mars hides the button at once; hidden means not rendered, no message (l.579).

import type { SkyState, SkyStore } from './storeTypes';
import type { ArCapabilities } from './types';

/** What the probe reads from the browser (tests inject fakes). */
export interface ArProbeEnv {
  isSecureContext: boolean;
  mediaDevices:
    | Pick<
        MediaDevices,
        'getUserMedia' | 'enumerateDevices' | 'addEventListener' | 'removeEventListener'
      >
    | undefined;
  /** `'DeviceOrientationEvent' in window`. */
  hasDeviceOrientation: boolean;
  /** `navigator.maxTouchPoints`. */
  maxTouchPoints: number;
  /** `matchMedia('(pointer: coarse)').matches`. */
  coarsePointer: boolean;
}

/** The synchronous signals plus the device list (`null` = not enumerated or refused). */
export function evaluateArCapabilities(
  env: ArProbeEnv,
  devices: readonly { kind: string }[] | null,
): ArCapabilities {
  return {
    secure: env.isSecureContext,
    camera: env.mediaDevices !== undefined,
    orientation: env.hasDeviceOrientation,
    touch: env.maxTouchPoints > 0 || env.coarsePointer,
    videoInput: devices?.some((device) => device.kind === 'videoinput') ?? false,
  };
}

/**
 * The full probe: `enumerateDevices()` runs only when every synchronous signal holds (a desktop
 * never enumerates anything); a rejection counts as no camera device. Never rejects.
 */
export async function probeArCapabilities(env: ArProbeEnv): Promise<ArCapabilities> {
  const sync = evaluateArCapabilities(env, null);
  if (
    !(sync.secure && sync.camera && sync.orientation && sync.touch) ||
    env.mediaDevices === undefined
  ) {
    return sync;
  }
  let devices: readonly MediaDeviceInfo[] | null;
  try {
    devices = await env.mediaDevices.enumerateDevices();
  } catch {
    devices = null;
  }
  return evaluateArCapabilities(env, devices);
}

/** The browser as `main.tsx` sees it (every read guarded: jsdom lacks most of these). */
export function envFromWindow(): ArProbeEnv {
  // Widened by annotation, never by assertion: lib.dom types these as always present.
  const win: { isSecureContext?: boolean; matchMedia?: Window['matchMedia'] } = window;
  const nav: { mediaDevices?: MediaDevices; maxTouchPoints?: number } = navigator;
  return {
    isSecureContext: win.isSecureContext ?? false,
    mediaDevices: nav.mediaDevices,
    hasDeviceOrientation: 'DeviceOrientationEvent' in window,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    coarsePointer:
      typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches,
  };
}

/**
 * Run the probe once (`main.tsx`, after the store exists) and again on every `devicechange`;
 * the result lands in `ar.capabilities`. Returns the stop function (unused by `main.tsx`).
 */
export function startArCapabilityProbe(
  store: SkyStore,
  env: ArProbeEnv = envFromWindow(),
): () => void {
  let stopped = false;
  const run = (): void => {
    void probeArCapabilities(env)
      .then((capabilities) => {
        if (!stopped) {
          store.getState().actions.setArCapabilities(capabilities);
        }
      })
      .catch(() => undefined);
  };
  run();
  env.mediaDevices?.addEventListener('devicechange', run);
  return () => {
    stopped = true;
    env.mediaDevices?.removeEventListener('devicechange', run);
  };
}

/** AR-1: every capability true and the observer on Earth (a selector for the button). */
export function arButtonVisible(s: Pick<SkyState, 'ar' | 'observer'>): boolean {
  const c = s.ar.capabilities;
  return (
    c !== null &&
    c.secure &&
    c.camera &&
    c.orientation &&
    c.touch &&
    c.videoInput &&
    s.observer.body === 'earth'
  );
}
