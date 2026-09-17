// The orientation sensor listener (plan D116, D118) against an injected target: jsdom 30 has
// `DeviceOrientationEvent` but neither `ondeviceorientationabsolute` nor `screen.orientation`, so
// the fake carries them; the WebKit fields are added to the event instances.

import type { OrientationEventType, OrientationSample, OrientationSensorTarget } from './sensors';
import { startOrientationSensors } from './sensors';

type Listener = (event: DeviceOrientationEvent) => void;

interface FakeTarget extends OrientationSensorTarget {
  dispatch(event: DeviceOrientationEvent): void;
  count(type: OrientationEventType): number;
}

function fakeTarget(options: {
  absolute: boolean;
  screen?: OrientationSensorTarget['screen'];
}): FakeTarget {
  const listeners = new Map<OrientationEventType, Set<Listener>>();
  const setOf = (type: OrientationEventType): Set<Listener> => {
    let set = listeners.get(type);
    if (set === undefined) {
      set = new Set();
      listeners.set(type, set);
    }
    return set;
  };
  const target: FakeTarget = {
    addEventListener(type, listener) {
      setOf(type).add(listener);
    },
    removeEventListener(type, listener) {
      setOf(type).delete(listener);
    },
    dispatch(event) {
      for (const listener of setOf(event.type as OrientationEventType)) {
        listener(event);
      }
    },
    count(type) {
      return setOf(type).size;
    },
    ...(options.screen === undefined ? {} : { screen: options.screen }),
  };
  if (options.absolute) {
    Object.defineProperty(target, 'ondeviceorientationabsolute', { value: null, enumerable: true });
  }
  return target;
}

function orientationEvent(
  type: OrientationEventType,
  init: DeviceOrientationEventInit,
  webkit?: { heading?: number | null; accuracy?: number | null },
): DeviceOrientationEvent {
  const event = new DeviceOrientationEvent(type, init);
  if (webkit !== undefined) {
    Object.defineProperty(event, 'webkitCompassHeading', { value: webkit.heading });
    Object.defineProperty(event, 'webkitCompassAccuracy', { value: webkit.accuracy });
  }
  return event;
}

interface Collector {
  /** Copies taken at each call (the module reuses one object). */
  samples: OrientationSample[];
  /** The references handed over, to prove the reuse. */
  refs: OrientationSample[];
  onSample: (sample: Readonly<OrientationSample>) => void;
}

function collector(): Collector {
  const samples: OrientationSample[] = [];
  const refs: OrientationSample[] = [];
  return {
    samples,
    refs,
    onSample: (sample) => {
      refs.push(sample);
      samples.push({ ...sample });
    },
  };
}

describe('startOrientationSensors', () => {
  it('attaches both events when the target has ondeviceorientationabsolute, one otherwise', () => {
    const both = fakeTarget({ absolute: true });
    const handle = startOrientationSensors({ onSample: () => undefined, target: both });
    expect(both.count('deviceorientationabsolute')).toBe(1);
    expect(both.count('deviceorientation')).toBe(1);
    handle.stop();
    expect(both.count('deviceorientationabsolute')).toBe(0);
    expect(both.count('deviceorientation')).toBe(0);

    const relativeOnly = fakeTarget({ absolute: false });
    const second = startOrientationSensors({ onSample: () => undefined, target: relativeOnly });
    expect(relativeOnly.count('deviceorientationabsolute')).toBe(0);
    expect(relativeOnly.count('deviceorientation')).toBe(1);
    second.stop();
    expect(relativeOnly.count('deviceorientation')).toBe(0);
  });

  it('builds one reusable sample per event: angles, absolute, screen angle, clock', () => {
    const target = fakeTarget({ absolute: true, screen: { orientation: { angle: 90 } } });
    const seen = collector();
    let nowMs = 1000;
    startOrientationSensors({ onSample: seen.onSample, target, now: () => nowMs });
    target.dispatch(
      orientationEvent('deviceorientationabsolute', {
        alpha: 270,
        beta: 90,
        gamma: 0,
        absolute: true,
      }),
    );
    nowMs = 1016;
    target.dispatch(
      orientationEvent('deviceorientation', { alpha: 12.5, beta: 80, gamma: -3, absolute: false }),
    );
    expect(seen.samples).toEqual([
      {
        alpha: 270,
        beta: 90,
        gamma: 0,
        absolute: true,
        compassHeading: NaN,
        compassAccuracy: NaN,
        screenAngle: 90,
        atMs: 1000,
      },
      {
        alpha: 12.5,
        beta: 80,
        gamma: -3,
        absolute: false,
        compassHeading: NaN,
        compassAccuracy: NaN,
        screenAngle: 90,
        atMs: 1016,
      },
    ]);
    // The same object both times (no allocation per event).
    expect(seen.refs).toHaveLength(2);
    expect(seen.refs[0]).toBe(seen.refs[1]);
  });

  it('reads the WebKit compass fields when they are numbers, NaN otherwise', () => {
    const target = fakeTarget({ absolute: false });
    const seen = collector();
    startOrientationSensors({ onSample: seen.onSample, target, now: () => 5 });
    target.dispatch(
      orientationEvent(
        'deviceorientation',
        { alpha: 100, beta: 45, gamma: 10 },
        { heading: 123.4, accuracy: 25 },
      ),
    );
    target.dispatch(
      orientationEvent(
        'deviceorientation',
        { alpha: 100, beta: 45, gamma: 10 },
        { heading: null, accuracy: -1 },
      ),
    );
    expect(seen.samples[0]?.compassHeading).toBe(123.4);
    expect(seen.samples[0]?.compassAccuracy).toBe(25);
    expect(seen.samples[1]?.compassHeading).toBeNaN();
    expect(seen.samples[1]?.compassAccuracy).toBe(-1);
  });

  it('treats a missing `absolute` (iOS Safari) as false', () => {
    const target = fakeTarget({ absolute: false });
    const seen = collector();
    startOrientationSensors({ onSample: seen.onSample, target, now: () => 5 });
    const event = orientationEvent('deviceorientation', { alpha: 1, beta: 2, gamma: 3 });
    Object.defineProperty(event, 'absolute', { value: undefined });
    target.dispatch(event);
    expect(seen.samples).toHaveLength(1);
    expect(seen.samples[0]?.absolute).toBe(false);
  });

  it('ignores an event with a null angle (the sensorless desktop, no hardware)', () => {
    const target = fakeTarget({ absolute: true });
    const seen = collector();
    startOrientationSensors({ onSample: seen.onSample, target, now: () => 5 });
    target.dispatch(orientationEvent('deviceorientationabsolute', { absolute: true }));
    target.dispatch(orientationEvent('deviceorientation', { alpha: null, beta: 1, gamma: 2 }));
    target.dispatch(orientationEvent('deviceorientation', { alpha: 1, beta: null, gamma: 2 }));
    target.dispatch(orientationEvent('deviceorientation', { alpha: 1, beta: 2, gamma: null }));
    expect(seen.samples).toHaveLength(0);
    target.dispatch(orientationEvent('deviceorientation', { alpha: 1, beta: 2, gamma: 3 }));
    expect(seen.samples).toHaveLength(1);
  });

  it('reads the screen angle per event and falls back to 0 without the API', () => {
    const screen = { orientation: { angle: 0 } };
    const rotating = fakeTarget({ absolute: false, screen });
    const seen = collector();
    startOrientationSensors({ onSample: seen.onSample, target: rotating, now: () => 5 });
    rotating.dispatch(orientationEvent('deviceorientation', { alpha: 1, beta: 2, gamma: 3 }));
    screen.orientation.angle = 270;
    rotating.dispatch(orientationEvent('deviceorientation', { alpha: 1, beta: 2, gamma: 3 }));
    expect(seen.samples.map((s) => s.screenAngle)).toEqual([0, 270]);

    const noOrientation = fakeTarget({ absolute: false, screen: {} });
    const seenNoOrientation = collector();
    startOrientationSensors({
      onSample: seenNoOrientation.onSample,
      target: noOrientation,
      now: () => 5,
    });
    noOrientation.dispatch(orientationEvent('deviceorientation', { alpha: 1, beta: 2, gamma: 3 }));
    expect(seenNoOrientation.samples[0]?.screenAngle).toBe(0);

    const noScreen = fakeTarget({ absolute: false });
    const seenNoScreen = collector();
    startOrientationSensors({ onSample: seenNoScreen.onSample, target: noScreen, now: () => 5 });
    noScreen.dispatch(orientationEvent('deviceorientation', { alpha: 1, beta: 2, gamma: 3 }));
    expect(seenNoScreen.samples[0]?.screenAngle).toBe(0);

    const injected = fakeTarget({ absolute: false, screen: { orientation: { angle: 90 } } });
    const seenInjected = collector();
    startOrientationSensors({
      onSample: seenInjected.onSample,
      target: injected,
      screenAngle: () => 180,
      now: () => 5,
    });
    injected.dispatch(orientationEvent('deviceorientation', { alpha: 1, beta: 2, gamma: 3 }));
    expect(seenInjected.samples[0]?.screenAngle).toBe(180);
  });

  it('stops idempotently and ignores events afterwards', () => {
    const target = fakeTarget({ absolute: true });
    const seen = collector();
    const handle = startOrientationSensors({ onSample: seen.onSample, target, now: () => 5 });
    handle.stop();
    handle.stop();
    expect(target.count('deviceorientationabsolute')).toBe(0);
    expect(target.count('deviceorientation')).toBe(0);
    target.dispatch(
      orientationEvent('deviceorientationabsolute', {
        alpha: 1,
        beta: 2,
        gamma: 3,
        absolute: true,
      }),
    );
    expect(seen.samples).toHaveLength(0);
  });

  it('defaults to window and Date.now (jsdom: relative event only, no screen.orientation)', () => {
    const seen = collector();
    const before = Date.now();
    const handle = startOrientationSensors({ onSample: seen.onSample });
    window.dispatchEvent(
      new DeviceOrientationEvent('deviceorientation', { alpha: 30, beta: 60, gamma: -10 }),
    );
    // jsdom has no handler property for the absolute event: that listener is never attached.
    window.dispatchEvent(
      new DeviceOrientationEvent('deviceorientationabsolute', { alpha: 1, beta: 2, gamma: 3 }),
    );
    expect(seen.samples).toHaveLength(1);
    expect(seen.samples[0]?.alpha).toBe(30);
    expect(seen.samples[0]?.screenAngle).toBe(0);
    expect(seen.samples[0]?.atMs).toBeGreaterThanOrEqual(before);
    expect(seen.samples[0]?.atMs).toBeLessThanOrEqual(Date.now());
    handle.stop();
    window.dispatchEvent(
      new DeviceOrientationEvent('deviceorientation', { alpha: 31, beta: 60, gamma: -10 }),
    );
    expect(seen.samples).toHaveLength(1);
  });
});
