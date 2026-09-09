// @vitest-environment node

import {
  GEOLOCATION_OPTIONS,
  elevationOf,
  requestGeolocation,
  statusOfErrorCode,
} from './geolocation';
import { GREENWICH, createSkyStore } from './store';

// The OBS-1/OBS-2 flow against a fake `Geolocation`: unsupported and insecure contexts, a fix
// (with and without an altitude), every error code, and the race with a position the user set
// while the prompt was up.

interface FakeGeolocation {
  geolocation: Geolocation;
  calls: PositionOptions[];
  succeed(coords: Partial<GeolocationCoordinates>): void;
  fail(code: number): void;
}

function fakeGeolocation(): FakeGeolocation {
  const calls: PositionOptions[] = [];
  let onSuccess: PositionCallback | null = null;
  let onError: PositionErrorCallback | null = null;
  const geolocation = {
    getCurrentPosition(
      success: PositionCallback,
      error?: PositionErrorCallback | null,
      options?: PositionOptions,
    ) {
      onSuccess = success;
      onError = error ?? null;
      calls.push(options ?? {});
    },
    watchPosition: () => 0,
    clearWatch: () => undefined,
  } as Geolocation;
  return {
    geolocation,
    calls,
    succeed(coords) {
      if (onSuccess === null) {
        throw new Error('no request pending');
      }
      const full = {
        latitude: 48.8566,
        longitude: 2.3522,
        altitude: null,
        accuracy: 20,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
        toJSON: () => ({}),
        ...coords,
      };
      onSuccess({ coords: full, timestamp: 0, toJSON: () => ({}) });
    },
    fail(code) {
      if (onError === null) {
        throw new Error('no request pending');
      }
      onError({
        code,
        message: '',
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      });
    },
  };
}

describe('requestGeolocation', () => {
  it('reports an unsupported browser and opens the observer panel', () => {
    const store = createSkyStore();
    requestGeolocation(store, { geolocation: null, isSecureContext: true });
    expect(store.getState().geo.status).toBe('unsupported');
    expect(store.getState().ui.panel).toBe('observer');
    expect(store.getState().observer).toEqual(GREENWICH);
  });

  it('reports an insecure context without asking the browser', () => {
    const store = createSkyStore();
    const fake = fakeGeolocation();
    requestGeolocation(store, { geolocation: fake.geolocation, isSecureContext: false });
    expect(store.getState().geo.status).toBe('insecure');
    expect(store.getState().ui.panel).toBe('observer');
    expect(fake.calls).toEqual([]);
  });

  it('prompts with coarse options, then applies the fix with elevation 0 for a null altitude', () => {
    const store = createSkyStore();
    const fake = fakeGeolocation();
    requestGeolocation(store, { geolocation: fake.geolocation, isSecureContext: true });
    expect(store.getState().geo.status).toBe('prompting');
    expect(fake.calls).toEqual([GEOLOCATION_OPTIONS]);
    expect(GEOLOCATION_OPTIONS).toEqual({
      enableHighAccuracy: false,
      timeout: 15_000,
      maximumAge: 600_000,
    });
    fake.succeed({ altitude: null });
    expect(store.getState().observer).toEqual({
      body: 'earth',
      lat: 48.8566,
      lon: 2.3522,
      elev: 0,
    });
    expect(store.getState().geo.status).toBe('granted');
    expect(store.getState().ui.panel).toBeNull();
  });

  it('rounds and clamps the ellipsoidal altitude', () => {
    const store = createSkyStore();
    const fake = fakeGeolocation();
    requestGeolocation(store, { geolocation: fake.geolocation, isSecureContext: true });
    fake.succeed({ altitude: 35.6 });
    expect(store.getState().observer.elev).toBe(36);
    expect(elevationOf(200_000)).toBe(100_000);
    expect(elevationOf(-20_000)).toBe(-12_000);
    expect(elevationOf(NaN)).toBe(0);
    expect(elevationOf(null)).toBe(0);
    expect(Object.is(elevationOf(-0.4), 0)).toBe(true);
  });

  it.each([
    [1, 'denied'],
    [2, 'unavailable'],
    [3, 'timeout'],
    [99, 'unavailable'],
  ])('maps error code %i to %s, keeps Greenwich and opens the panel', (code, status) => {
    const store = createSkyStore();
    const fake = fakeGeolocation();
    requestGeolocation(store, { geolocation: fake.geolocation, isSecureContext: true });
    fake.fail(code);
    expect(store.getState().geo.status).toBe(status);
    expect(statusOfErrorCode(code)).toBe(status);
    expect(store.getState().observer).toEqual(GREENWICH);
    expect(store.getState().ui.panel).toBe('observer');
  });

  it('ignores a late fix or a late error after the user set the observer', () => {
    const store = createSkyStore();
    const fake = fakeGeolocation();
    requestGeolocation(store, { geolocation: fake.geolocation, isSecureContext: true });
    const manual = { body: 'mars', lat: 18.41, lon: 77.69, elev: 0 };
    store.getState().actions.setObserver(manual);
    expect(store.getState().geo.status).toBe('idle');
    fake.succeed({ latitude: 1, longitude: 2, altitude: 3 });
    expect(store.getState().observer).toEqual(manual);
    expect(store.getState().geo.status).toBe('idle');

    requestGeolocation(store, { geolocation: fake.geolocation, isSecureContext: true });
    store.getState().actions.setObserver(manual);
    fake.fail(1);
    expect(store.getState().geo.status).toBe('idle');
    expect(store.getState().ui.panel).toBeNull();
  });

  it('can be asked again after a denial', () => {
    const store = createSkyStore();
    const fake = fakeGeolocation();
    requestGeolocation(store, { geolocation: fake.geolocation, isSecureContext: true });
    fake.fail(1);
    requestGeolocation(store, { geolocation: fake.geolocation, isSecureContext: true });
    expect(store.getState().geo.status).toBe('prompting');
    fake.succeed({});
    expect(store.getState().geo.status).toBe('granted');
    expect(fake.calls).toHaveLength(2);
  });
});
