// URL synchroniser (plan D79): <= 2 Hz `replaceState` with a trailing write, `popstate` applied
// without echo, hash preserved, dispose cancels. Fake timers make the throttle deterministic.

import { createSkyStore } from './store';
import { startUrlSync } from './urlSync';
import type { UrlLocation } from './urlSync';

const T0 = 1_757_000_000_000;

function fakeEnvironment(search = '', hash = '') {
  const location: UrlLocation = { pathname: '/', search, hash };
  const replaceState = vi.fn<History['replaceState']>();
  return { location, history: { replaceState }, replaceState };
}

function lastUrl(replaceState: ReturnType<typeof vi.fn<History['replaceState']>>): string {
  const call = replaceState.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error('replaceState was never called');
  }
  return String(call[2]);
}

describe('startUrlSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes at most twice per second with the last state landing', () => {
    const store = createSkyStore({}, T0);
    const env = fakeEnvironment();
    const stop = startUrlSync(store, { history: env.history, location: env.location });

    // Ten changes 100 ms apart, the first one at t = 0 (az = 0 is already the state).
    for (let i = 1; i <= 10; i += 1) {
      store.getState().actions.setView({ az: i * 10 });
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(600);

    // Exactly three writes: the leading one at t = 0, the trailing ones at t = 500 and 1000 ms.
    expect(env.replaceState).toHaveBeenCalledTimes(3);
    expect(lastUrl(env.replaceState)).toBe(
      '/?body=earth&lat=51.48&lon=0&elev=0&t=live&az=100&alt=20&fov=60',
    );
    expect(env.replaceState).toHaveBeenCalledWith(null, '', expect.any(String));
    stop();
  });

  it('honours a custom interval', () => {
    const store = createSkyStore({}, T0);
    const env = fakeEnvironment();
    const stop = startUrlSync(store, {
      history: env.history,
      location: env.location,
      minIntervalMs: 2000,
    });
    for (let i = 1; i <= 10; i += 1) {
      store.getState().actions.setView({ az: i * 10 });
      vi.advanceTimersByTime(100);
    }
    expect(env.replaceState).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    expect(env.replaceState).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(env.replaceState).toHaveBeenCalledTimes(2);
    expect(lastUrl(env.replaceState)).toContain('az=100');
    stop();
  });

  it('skips a write whose string equals the last one', () => {
    const store = createSkyStore({}, T0);
    const env = fakeEnvironment();
    const stop = startUrlSync(store, { history: env.history, location: env.location });
    store.getState().actions.setView({ alt: 30 });
    vi.advanceTimersByTime(600);
    expect(env.replaceState).toHaveBeenCalledTimes(1);
    // Below the URL rounding: same string, no call.
    store.getState().actions.setView({ alt: 30.001 });
    vi.advanceTimersByTime(600);
    expect(env.replaceState).toHaveBeenCalledTimes(1);
    // A store change that leaves the URL view untouched never reaches the writer.
    store.getState().actions.setBoot({ phase: 'meta' });
    vi.advanceTimersByTime(600);
    expect(env.replaceState).toHaveBeenCalledTimes(1);
    stop();
  });

  it('preserves the hash, never leaves a dangling ? and uses the current pathname', () => {
    const store = createSkyStore({}, T0);
    const env = fakeEnvironment('', '#engine=webgl2');
    env.location.pathname = '/sky/';
    const stop = startUrlSync(store, { history: env.history, location: env.location });
    store.getState().actions.setView({ fov: 45 });
    const url = lastUrl(env.replaceState);
    expect(url).toBe(
      '/sky/?body=earth&lat=51.48&lon=0&elev=0&t=live&az=0&alt=20&fov=45#engine=webgl2',
    );
    expect(url.split('?')).toHaveLength(2);
    stop();
  });

  it('does not rewrite the URL it started from when the state serializes identically', () => {
    const search = '?body=earth&lat=51.48&lon=0&elev=0&t=2460409.25&az=0&alt=20&fov=60';
    const store = createSkyStore({ t: 2460409.25 }, T0);
    const env = fakeEnvironment(search);
    const stop = startUrlSync(store, { history: env.history, location: env.location });
    store.getState().actions.publishTt(2460409.25 + 1e-7);
    store.getState().actions.setBoot({ phase: 'ready' });
    vi.advanceTimersByTime(1000);
    expect(env.replaceState).not.toHaveBeenCalled();
    stop();
  });

  it('applies popstate to the store without writing back and drops a pending write', () => {
    const store = createSkyStore({}, T0);
    const env = fakeEnvironment();
    const stop = startUrlSync(store, {
      history: env.history,
      location: env.location,
      target: window,
    });

    store.getState().actions.setView({ az: 10 });
    expect(env.replaceState).toHaveBeenCalledTimes(1);
    store.getState().actions.setView({ az: 20 }); // pending behind the cooldown

    env.location.search =
      '?body=mars&lat=18.44&lon=77.45&elev=-2500&t=2460409.25&az=90&alt=45&fov=30&layers=stars';
    window.dispatchEvent(new Event('popstate'));

    const state = store.getState();
    expect(state.observer).toEqual({ body: 'mars', lat: 18.44, lon: 77.45, elev: -2500 });
    expect(state.clock).toMatchObject({ mode: 'paused', tt: 2460409.25 });
    expect(state.view).toEqual({ az: 90, alt: 45, fov: 30 });
    expect(state.layers.planets).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(env.replaceState).toHaveBeenCalledTimes(1);

    // The next real change writes the new state on top of the restored entry.
    store.getState().actions.setView({ az: 91 });
    expect(env.replaceState).toHaveBeenCalledTimes(2);
    expect(lastUrl(env.replaceState)).toBe(
      '/?body=mars&lat=18.44&lon=77.45&elev=-2500&t=2460409.25&az=91&alt=45&fov=30&layers=stars',
    );
    stop();
  });

  it('ignores a popstate whose query it wrote or started from (hash-only navigation)', () => {
    const search = '?body=earth&lat=51.48&lon=0&elev=0&t=2460409.25&speed=3600&az=0&alt=20&fov=60';
    const store = createSkyStore({ t: 2460409.25, speed: 3600 }, T0);
    const env = fakeEnvironment(search);
    const stop = startUrlSync(store, {
      history: env.history,
      location: env.location,
      target: window,
    });

    // Editing the hash fires popstate with the initial query: the playing clock is not re-anchored.
    const initialClock = store.getState().clock;
    env.location.hash = '#engine=webgl2';
    window.dispatchEvent(new Event('popstate'));
    expect(store.getState().clock).toBe(initialClock);

    // The same holds for a query this synchroniser wrote, and a pending write survives it.
    store.getState().actions.setView({ az: 10 });
    expect(env.replaceState).toHaveBeenCalledTimes(1);
    const written = new URL(lastUrl(env.replaceState), 'http://127.0.0.1');
    expect(written.hash).toBe('#engine=webgl2');
    env.location.search = written.search;
    store.getState().actions.setView({ az: 20 }); // pending behind the cooldown
    env.location.hash = '#engine=webgpu';
    window.dispatchEvent(new Event('popstate'));
    expect(store.getState().clock).toBe(initialClock);
    expect(store.getState().view.az).toBe(20);
    vi.advanceTimersByTime(500);
    expect(env.replaceState).toHaveBeenCalledTimes(2);
    expect(lastUrl(env.replaceState)).toContain('az=20');
    stop();
  });

  it('dispose cancels the trailing write and stops listening', () => {
    const store = createSkyStore({}, T0);
    const env = fakeEnvironment();
    const stop = startUrlSync(store, {
      history: env.history,
      location: env.location,
      target: window,
    });
    store.getState().actions.setView({ az: 10 });
    store.getState().actions.setView({ az: 20 });
    expect(env.replaceState).toHaveBeenCalledTimes(1);
    stop();
    vi.advanceTimersByTime(2000);
    expect(env.replaceState).toHaveBeenCalledTimes(1);

    store.getState().actions.setView({ az: 30 });
    vi.advanceTimersByTime(2000);
    expect(env.replaceState).toHaveBeenCalledTimes(1);

    env.location.search = '?body=moon';
    window.dispatchEvent(new Event('popstate'));
    expect(store.getState().observer.body).toBe('earth');
    // Disposing twice is harmless.
    stop();
  });

  it('falls back to window.history, window.location and window when no options are given', () => {
    const store = createSkyStore({}, T0);
    const spy = vi.spyOn(window.history, 'replaceState');
    const stop = startUrlSync(store);
    store.getState().actions.setView({ az: 33 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[2])).toContain('az=33');
    stop();
    spy.mockRestore();
  });
});
