// @vitest-environment node

import { hasRequestPermission, requestOrientationPermission } from './arPermission';

// The motion-permission helper of plan D126: `notRequired` without the static, the three
// resolved outcomes, a rejection or a throw reading `prompt`, and the invariant that matters on
// WebKit: the static runs synchronously, inside the caller's gesture, before the promise exists.

/** A constructor-like function carrying the static (a class would trip `no-extraneous-class`). */
function ctorWith(requestPermission: () => Promise<unknown>): unknown {
  return Object.assign(() => undefined, { requestPermission });
}

/** A constructor-like function without the static (Firefox Android, older Chromium). */
function plainCtor(): unknown {
  return () => undefined;
}

describe('hasRequestPermission', () => {
  it('accepts a constructor or an object carrying the static and nothing else', () => {
    expect(hasRequestPermission(ctorWith(() => Promise.resolve('granted')))).toBe(true);
    expect(hasRequestPermission({ requestPermission: () => Promise.resolve('denied') })).toBe(true);
    expect(hasRequestPermission(plainCtor())).toBe(false);
    expect(hasRequestPermission({})).toBe(false);
    expect(hasRequestPermission({ requestPermission: 'granted' })).toBe(false);
    expect(hasRequestPermission(undefined)).toBe(false);
    expect(hasRequestPermission(null)).toBe(false);
    expect(hasRequestPermission(42)).toBe(false);
  });
});

describe('requestOrientationPermission', () => {
  it('resolves notRequired when the static is absent (also for the default argument under node)', async () => {
    await expect(requestOrientationPermission(undefined)).resolves.toBe('notRequired');
    await expect(requestOrientationPermission(plainCtor())).resolves.toBe('notRequired');
    await expect(requestOrientationPermission()).resolves.toBe('notRequired');
  });

  it('invokes the static synchronously and maps granted, denied and prompt', async () => {
    for (const outcome of ['granted', 'denied', 'prompt'] as const) {
      const spy = vi.fn(() => Promise.resolve<unknown>(outcome));
      const promise = requestOrientationPermission(ctorWith(spy));
      // Before any await: the call happened inside the caller's gesture (brief l.546).
      expect(spy).toHaveBeenCalledTimes(1);
      await expect(promise).resolves.toBe(outcome);
    }
  });

  it('reads any other outcome, a rejection and a throw as prompt', async () => {
    await expect(
      requestOrientationPermission(ctorWith(() => Promise.resolve('whatever'))),
    ).resolves.toBe('prompt');
    await expect(
      requestOrientationPermission(ctorWith(() => Promise.resolve(undefined))),
    ).resolves.toBe('prompt');
    await expect(
      requestOrientationPermission(
        ctorWith(() => Promise.reject(new DOMException('gesture', 'NotAllowedError'))),
      ),
    ).resolves.toBe('prompt');
    await expect(
      requestOrientationPermission(
        ctorWith(() => {
          throw new TypeError('illegal invocation');
        }),
      ),
    ).resolves.toBe('prompt');
  });
});
