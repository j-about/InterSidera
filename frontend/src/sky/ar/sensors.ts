// Device orientation events -> one reusable sample (AR-2, brief l.546; plan D116, D118). DOM only:
// no Babylon, no store, no React, no i18n, and no timer (staleness is the AR controller's job on
// the engine clock, `STALE_SAMPLE_MS` of `sky/math/orientation.ts`). Lives in the lazy AR chunk
// (`sky/ar/**`, reached through the dynamic import in `SkyEngine`, brief l.257).
//
// Event selection: `deviceorientationabsolute` is attached when the target exposes the handler
// property (`'ondeviceorientationabsolute' in target`, Chromium and Firefox Android; desktop
// Chromium has it too and fires one null event), and `deviceorientation` always (iOS Safari has
// only it, Android's relative stream is the fallback). Every sample carries `absolute =
// event.absolute === true` (iOS leaves the property undefined, not false) and the controller
// arbitrates the source per sample. A null angle (the sensorless desktop's single event, a
// browser without hardware) is no sample.

/** One orientation reading; the object is reused across events, copy what must outlive the call. */
export interface OrientationSample {
  /** W3C `alpha`, degrees about the device z axis, `[0, 360)`. */
  alpha: number;
  /** W3C `beta`, degrees about the device x axis, `[-180, 180)`. */
  beta: number;
  /** W3C `gamma`, degrees about the device y axis, `[-90, 90)`. */
  gamma: number;
  /** `event.absolute === true`: the heading is magnetic north (Android), not an arbitrary yaw. */
  absolute: boolean;
  /** iOS `webkitCompassHeading` in degrees clockwise from magnetic north; `NaN` when absent. */
  compassHeading: number;
  /** iOS `webkitCompassAccuracy` in degrees (negative = invalid); `NaN` when absent. */
  compassAccuracy: number;
  /** `screen.orientation.angle` at the event, degrees counter-clockwise from natural; 0 without the API. */
  screenAngle: number;
  /** `now()` at receipt (`Date.now()` by default; the controller compares it with the engine clock). */
  atMs: number;
}

export type OrientationEventType = 'deviceorientation' | 'deviceorientationabsolute';

/**
 * The event target and `screen` owner, structurally: `window` satisfies it and tests pass a plain
 * object carrying `ondeviceorientationabsolute` and `screen.orientation` (jsdom 30 has neither).
 */
export interface OrientationSensorTarget {
  addEventListener(
    type: OrientationEventType,
    listener: (event: DeviceOrientationEvent) => void,
  ): void;
  removeEventListener(
    type: OrientationEventType,
    listener: (event: DeviceOrientationEvent) => void,
  ): void;
  readonly screen?: { readonly orientation?: { readonly angle: number } };
}

export interface OrientationSensorOptions {
  /** Called once per usable event with the reusable sample. */
  onSample(sample: Readonly<OrientationSample>): void;
  /** Defaults to `window`. */
  target?: OrientationSensorTarget;
  /** Defaults to `target.screen.orientation.angle` when the API exists, else 0. */
  screenAngle?: () => number;
  /** Defaults to `Date.now`. */
  now?: () => number;
}

export interface OrientationSensorHandle {
  /** Removes both listeners; idempotent. */
  stop(): void;
}

/** The screen angle of the target, 0 when the Screen Orientation API is missing (jsdom, old WebKit). */
function screenAngleOf(target: OrientationSensorTarget): number {
  const orientation = target.screen?.orientation;
  return orientation === undefined ? 0 : orientation.angle;
}

export function startOrientationSensors(
  options: OrientationSensorOptions,
): OrientationSensorHandle {
  const target = options.target ?? window;
  const now = options.now ?? Date.now;
  const screenAngle = options.screenAngle ?? ((): number => screenAngleOf(target));
  const sample: OrientationSample = {
    alpha: NaN,
    beta: NaN,
    gamma: NaN,
    absolute: false,
    compassHeading: NaN,
    compassAccuracy: NaN,
    screenAngle: 0,
    atMs: NaN,
  };
  const onEvent = (event: DeviceOrientationEvent): void => {
    const { alpha, beta, gamma } = event;
    if (alpha === null || beta === null || gamma === null) {
      return;
    }
    sample.alpha = alpha;
    sample.beta = beta;
    sample.gamma = gamma;
    // lib.dom types `absolute` as a boolean; iOS Safari omits it (undefined), hence the widening.
    const absolute: unknown = event.absolute;
    sample.absolute = absolute === true;
    const heading = event.webkitCompassHeading;
    sample.compassHeading = typeof heading === 'number' ? heading : NaN;
    const accuracy = event.webkitCompassAccuracy;
    sample.compassAccuracy = typeof accuracy === 'number' ? accuracy : NaN;
    sample.screenAngle = screenAngle();
    sample.atMs = now();
    options.onSample(sample);
  };
  const withAbsolute = 'ondeviceorientationabsolute' in target;
  if (withAbsolute) {
    target.addEventListener('deviceorientationabsolute', onEvent);
  }
  target.addEventListener('deviceorientation', onEvent);
  let stopped = false;
  return {
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      if (withAbsolute) {
        target.removeEventListener('deviceorientationabsolute', onEvent);
      }
      target.removeEventListener('deviceorientation', onEvent);
    },
  };
}
