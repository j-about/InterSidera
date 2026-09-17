// The motion-sensor permission (brief l.546; plan D126). WebKit (iOS Safari 13+) and Chromium
// >= 152 expose the static `DeviceOrientationEvent.requestPermission()`; WebKit rejects it with
// `NotAllowedError` unless it runs inside the user gesture, and an `await` before the call ends
// the gesture, so the AR button calls this SYNCHRONOUSLY in its click handler, before
// `requestAr()`, and writes the outcome through `setArPermission`. `notRequired` when the static
// is absent (Firefox Android, older Chromium); `granted` / `denied` as resolved; `prompt`
// (Chromium's sensors permission state) and any other outcome, rejection or throw continue and
// let the events decide. Main bundle (backlog B-75): the gesture must not span a chunk download.

import type { ArPermission } from './types';

/** The constructor carries the WebKit/Chromium static (never in lib.dom, hence the guard). */
export function hasRequestPermission(
  ctor: unknown,
): ctor is { requestPermission(): Promise<unknown> } {
  return (
    (typeof ctor === 'function' || (typeof ctor === 'object' && ctor !== null)) &&
    'requestPermission' in ctor &&
    typeof ctor.requestPermission === 'function'
  );
}

/** The permission outcome; the static is invoked before this function returns (plan D126). */
export function requestOrientationPermission(
  ctor: unknown = globalThis.DeviceOrientationEvent,
): Promise<ArPermission> {
  if (!hasRequestPermission(ctor)) {
    return Promise.resolve('notRequired');
  }
  let outcome: Promise<unknown>;
  try {
    outcome = ctor.requestPermission();
  } catch {
    return Promise.resolve('prompt');
  }
  return outcome.then(
    (result) => (result === 'granted' || result === 'denied' ? result : 'prompt'),
    () => 'prompt',
  );
}
