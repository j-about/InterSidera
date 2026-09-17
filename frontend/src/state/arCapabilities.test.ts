import type { Mock } from 'vitest';

import {
  arButtonVisible,
  envFromWindow,
  evaluateArCapabilities,
  probeArCapabilities,
  startArCapabilityProbe,
} from './arCapabilities';
import type { ArProbeEnv } from './arCapabilities';
import { createSkyStore } from './store';

// The AR-1 gate of plan D125: the truth table of the synchronous signals, `enumerateDevices`
// gated behind them (a desktop never enumerates), the `devicechange` re-probe, the Earth-only
// button selector, and the browser reader under jsdom.

interface FakeMedia {
  mediaDevices: NonNullable<ArProbeEnv['mediaDevices']>;
  enumerateDevices: Mock<() => Promise<MediaDeviceInfo[]>>;
  deviceChange(): void;
  listeners(): number;
}

function fakeMedia(kinds: readonly string[] = ['videoinput'], reject = false): FakeMedia {
  const target = new EventTarget();
  let count = 0;
  const enumerateDevices = vi.fn(() =>
    reject
      ? Promise.reject(new DOMException('blocked', 'SecurityError'))
      : Promise.resolve(kinds.map((kind) => ({ kind }) as MediaDeviceInfo)),
  );
  const mediaDevices = {
    getUserMedia: () => Promise.reject(new Error('not in this test')),
    enumerateDevices,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject | null) => {
      count += 1;
      target.addEventListener(type, listener);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject | null) => {
      count -= 1;
      target.removeEventListener(type, listener);
    },
  } as unknown as NonNullable<ArProbeEnv['mediaDevices']>;
  return {
    mediaDevices,
    enumerateDevices,
    deviceChange() {
      target.dispatchEvent(new Event('devicechange'));
    },
    listeners: () => count,
  };
}

function phoneEnv(media: FakeMedia | null = fakeMedia()): ArProbeEnv {
  return {
    isSecureContext: true,
    mediaDevices: media?.mediaDevices,
    hasDeviceOrientation: true,
    maxTouchPoints: 1,
    coarsePointer: true,
  };
}

const VIDEO = [{ kind: 'videoinput' }];

describe('evaluateArCapabilities', () => {
  it('maps every signal independently', () => {
    const all = evaluateArCapabilities(phoneEnv(), VIDEO);
    expect(all).toEqual({
      secure: true,
      camera: true,
      orientation: true,
      touch: true,
      videoInput: true,
    });
    expect(evaluateArCapabilities({ ...phoneEnv(), isSecureContext: false }, VIDEO).secure).toBe(
      false,
    );
    expect(evaluateArCapabilities({ ...phoneEnv(), mediaDevices: undefined }, VIDEO).camera).toBe(
      false,
    );
    // The eager module never spells the method's name (the D131 gate reserves it to the lazy
    // camera chunk): `mediaDevices` present is the camera signal.
    expect(evaluateArCapabilities(phoneEnv(fakeMedia([])), null).camera).toBe(true);
    expect(
      evaluateArCapabilities({ ...phoneEnv(), hasDeviceOrientation: false }, VIDEO).orientation,
    ).toBe(false);
  });

  it('reads touch from maxTouchPoints or the coarse pointer', () => {
    const base = phoneEnv();
    expect(
      evaluateArCapabilities({ ...base, maxTouchPoints: 0, coarsePointer: false }, VIDEO).touch,
    ).toBe(false);
    expect(
      evaluateArCapabilities({ ...base, maxTouchPoints: 5, coarsePointer: false }, VIDEO).touch,
    ).toBe(true);
    expect(
      evaluateArCapabilities({ ...base, maxTouchPoints: 0, coarsePointer: true }, VIDEO).touch,
    ).toBe(true);
  });

  it('reads the video input from the device list', () => {
    const env = phoneEnv();
    expect(evaluateArCapabilities(env, null).videoInput).toBe(false);
    expect(evaluateArCapabilities(env, []).videoInput).toBe(false);
    expect(evaluateArCapabilities(env, [{ kind: 'audioinput' }]).videoInput).toBe(false);
    expect(
      evaluateArCapabilities(env, [{ kind: 'audioinput' }, { kind: 'videoinput' }]).videoInput,
    ).toBe(true);
  });
});

describe('probeArCapabilities', () => {
  it('enumerates the devices only when every synchronous signal holds', async () => {
    const media = fakeMedia();
    const phone = await probeArCapabilities(phoneEnv(media));
    expect(media.enumerateDevices).toHaveBeenCalledTimes(1);
    expect(phone.videoInput).toBe(true);

    const desktop = fakeMedia();
    const result = await probeArCapabilities({
      ...phoneEnv(desktop),
      maxTouchPoints: 0,
      coarsePointer: false,
    });
    expect(desktop.enumerateDevices).not.toHaveBeenCalled();
    expect(result).toEqual({
      secure: true,
      camera: true,
      orientation: true,
      touch: false,
      videoInput: false,
    });

    const insecure = fakeMedia();
    await probeArCapabilities({ ...phoneEnv(insecure), isSecureContext: false });
    expect(insecure.enumerateDevices).not.toHaveBeenCalled();
    const noOrientation = fakeMedia();
    await probeArCapabilities({ ...phoneEnv(noOrientation), hasDeviceOrientation: false });
    expect(noOrientation.enumerateDevices).not.toHaveBeenCalled();
    expect((await probeArCapabilities(phoneEnv(null))).camera).toBe(false);
  });

  it('counts a rejected enumeration as no camera device', async () => {
    const media = fakeMedia(['videoinput'], true);
    const result = await probeArCapabilities(phoneEnv(media));
    expect(result).toEqual({
      secure: true,
      camera: true,
      orientation: true,
      touch: true,
      videoInput: false,
    });
  });
});

describe('startArCapabilityProbe', () => {
  it('writes the probe once, re-runs it on devicechange and stops cleanly', async () => {
    const store = createSkyStore({}, 0);
    const media = fakeMedia([]);
    const stop = startArCapabilityProbe(store, phoneEnv(media));
    expect(store.getState().ar.capabilities).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().ar.capabilities).toMatchObject({ touch: true, videoInput: false });
    expect(media.listeners()).toBe(1);

    media.enumerateDevices.mockImplementation(() =>
      Promise.resolve([{ kind: 'videoinput' } as MediaDeviceInfo]),
    );
    media.deviceChange();
    expect(media.enumerateDevices).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().ar.capabilities?.videoInput).toBe(true);

    stop();
    expect(media.listeners()).toBe(0);
    media.deviceChange();
    expect(media.enumerateDevices).toHaveBeenCalledTimes(2);
  });

  it('ignores a result arriving after stop and works without mediaDevices', async () => {
    const store = createSkyStore({}, 0);
    const media = fakeMedia();
    const stop = startArCapabilityProbe(store, phoneEnv(media));
    stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().ar.capabilities).toBeNull();

    const stopNone = startArCapabilityProbe(store, phoneEnv(null));
    await Promise.resolve();
    expect(store.getState().ar.capabilities).toMatchObject({ camera: false, videoInput: false });
    stopNone();
  });
});

describe('arButtonVisible', () => {
  const caps = { secure: true, camera: true, orientation: true, touch: true, videoInput: true };

  it('needs every capability and an observer on Earth', () => {
    const store = createSkyStore({}, 0);
    expect(arButtonVisible(store.getState())).toBe(false);
    store.getState().actions.setArCapabilities(caps);
    expect(arButtonVisible(store.getState())).toBe(true);
    store.getState().actions.setObserver({ body: 'mars', lat: 0, lon: 0, elev: 0 });
    expect(arButtonVisible(store.getState())).toBe(false);
    store.getState().actions.setObserver({ body: 'earth', lat: 0, lon: 0, elev: 0 });
    expect(arButtonVisible(store.getState())).toBe(true);
    for (const key of Object.keys(caps) as (keyof typeof caps)[]) {
      store.getState().actions.setArCapabilities({ ...caps, [key]: false });
      expect(arButtonVisible(store.getState())).toBe(false);
    }
  });
});

describe('envFromWindow', () => {
  it('reads the browser with every access guarded (jsdom lacks most of them)', () => {
    const env = envFromWindow();
    expect(env.isSecureContext).toBe(false);
    expect(env.mediaDevices).toBeUndefined();
    expect(env.hasDeviceOrientation).toBe('DeviceOrientationEvent' in window);
    expect(env.maxTouchPoints).toBe(0);
    // setup.ts stubs matchMedia to "no match".
    expect(env.coarsePointer).toBe(false);
  });

  it('follows the coarse-pointer query and survives a missing matchMedia', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    try {
      Object.defineProperty(window, 'matchMedia', {
        value: (query: string) => ({ matches: query === '(pointer: coarse)' }),
        configurable: true,
        writable: true,
      });
      expect(envFromWindow().coarsePointer).toBe(true);
      Object.defineProperty(window, 'matchMedia', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      expect(envFromWindow().coarsePointer).toBe(false);
    } finally {
      if (original !== undefined) {
        Object.defineProperty(window, 'matchMedia', original);
      }
    }
  });
});
