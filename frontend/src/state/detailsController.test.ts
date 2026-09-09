// @vitest-environment node
// The details controller (INFO-1, plan D106): a ticker pulled with the rendered `tt`, one
// `/sky/altaz` request per change of selection, observer, refraction or control block, 1 Hz
// while time flows, the error mapping of docs/api.md and the shared 429 gate.

import { ApiProblem } from '../api/client';
import type { AltAzEntry } from '../api/client';
import { createRateGate } from '../api/rateGate';
import { fakeBundle, fakeMeta } from '../test/fakeBundle';
import { DETAILS_REFRESH_MS, createDetailsController } from './detailsController';
import type { AltAzQuery } from './detailsController';
import { createSkyStore } from './store';

const T0 = 1_757_000_000_000;
const TT = 2460409.25;
const SIRIUS = 'hip:32349';

interface Call {
  query: AltAzQuery;
  signal: AbortSignal;
  resolve: (rows: AltAzEntry[]) => void;
  reject: (error: unknown) => void;
}

function entry(id: string, constellation: string | null = 'CMa'): AltAzEntry {
  return {
    id,
    alt_deg: 21.63,
    az_deg: 185.81,
    ra_icrs_deg: 101.28,
    dec_icrs_deg: -16.73,
    ra_date_deg: 101.55,
    dec_date_deg: -16.75,
    mag: -1.44,
    constellation,
  };
}

function problem(
  status: number,
  slug: string,
  extra: { retryAfterS?: number; rangeTt?: [number, number] } = {},
) {
  return new ApiProblem({
    status,
    slug: slug as ApiProblem['slug'],
    type: `https://example.test/api.md#problem-${slug}`,
    title: slug,
    ...extra,
  });
}

/** The store paused at `TT` (a live clock would refresh at 1 Hz on its own). */
function harness(selection: string | null = SIRIUS) {
  const store = createSkyStore({ t: TT }, T0);
  const { actions } = store.getState();
  actions.setMeta(fakeMeta());
  actions.setBundle(fakeBundle());
  actions.setBoot({ phase: 'ready' });
  actions.select(selection);
  const calls: Call[] = [];
  const gate = createRateGate();
  let nowMs = T0;
  const controller = createDetailsController({
    store,
    fetchAltAz: (query, signal) =>
      new Promise<AltAzEntry[]>((resolve, reject) => {
        calls.push({ query, signal, resolve, reject });
      }),
    rateGate: gate,
    now: () => nowMs,
  });
  const tick = (dtMs = 0, tt = TT): void => {
    nowMs += dtMs;
    controller.update(tt, nowMs);
  };
  const last = (): Call => {
    const call = calls.at(-1);
    if (call === undefined) {
      throw new Error('no request was issued');
    }
    return call;
  };
  return { store, actions, calls, gate, controller, tick, last, now: () => nowMs };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('createDetailsController', () => {
  it('requests the selection at once with the rounded observer and the catalog constellation', async () => {
    const h = harness();
    h.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.last().query).toEqual({
      body: 'earth',
      lat: 51.48,
      lon: 0,
      elev: 0,
      tt: TT,
      targets: SIRIUS,
      refraction: true,
    });
    // Before the answer: loading, with the constellation the star index knows.
    expect(h.store.getState().details).toMatchObject({
      id: SIRIUS,
      status: 'loading',
      con: 'CMa',
      entry: null,
    });
    h.last().resolve([entry(SIRIUS, 'CMa')]);
    await flush();
    const details = h.store.getState().details;
    expect(details.status).toBe('ready');
    expect(details.entry?.id).toBe(SIRIUS);
    expect(details.tt).toBe(TT);
    expect(details.refraction).toBe(true);
    expect(details.con).toBe('CMa');
    expect(details.error).toBeNull();
  });

  it('waits for the boot to be ready before asking anything', () => {
    const store = createSkyStore({ sel: SIRIUS }, T0);
    const calls: Call[] = [];
    const controller = createDetailsController({
      store,
      fetchAltAz: (query, signal) =>
        new Promise<AltAzEntry[]>((resolve, reject) => {
          calls.push({ query, signal, resolve, reject });
        }),
    });
    controller.update(TT, T0);
    expect(calls).toHaveLength(0);
    // `/meta` alone is not enough: the engine ticks behind the splash from its construction.
    store.getState().actions.setMeta(fakeMeta());
    store.getState().actions.setBoot({ phase: 'frame' });
    controller.update(TT, T0 + 16);
    expect(calls).toHaveLength(0);
    store.getState().actions.setBoot({ phase: 'ready' });
    controller.update(TT, T0 + 32);
    expect(calls).toHaveLength(1);
  });

  it('refreshes at most once per second while time flows and not at all while paused', async () => {
    const h = harness();
    h.tick();
    h.last().resolve([entry(SIRIUS)]);
    await flush();
    // Paused: nothing else.
    h.tick(2000);
    h.tick(2000);
    expect(h.calls).toHaveLength(1);
    // Playing: the control block changed -> one request now, then 1 Hz.
    h.actions.play(3600, h.now());
    h.tick(16);
    expect(h.calls).toHaveLength(2);
    h.last().resolve([entry(SIRIUS)]);
    await flush();
    h.tick(DETAILS_REFRESH_MS - 100);
    expect(h.calls).toHaveLength(2);
    h.tick(100);
    expect(h.calls).toHaveLength(3);
    // One in flight: no second request even after a second.
    h.tick(DETAILS_REFRESH_MS);
    expect(h.calls).toHaveLength(3);
    h.last().resolve([entry(SIRIUS)]);
    await flush();
    h.tick(DETAILS_REFRESH_MS);
    expect(h.calls).toHaveLength(4);
    // Live counts as flowing.
    h.actions.live(h.now());
    h.tick(16);
    expect(h.calls).toHaveLength(5);
  });

  it('refetches on a time change while paused, on an observer change and on the refraction toggle', async () => {
    const h = harness();
    h.tick();
    h.last().resolve([entry(SIRIUS)]);
    await flush();
    h.actions.setTime(TT + 1, h.now());
    h.tick(16, TT + 1);
    expect(h.calls).toHaveLength(2);
    expect(h.last().query.tt).toBe(TT + 1);
    h.last().resolve([entry(SIRIUS)]);
    await flush();
    h.actions.setObserver({ body: 'earth', lat: 48.8566, lon: 2.3522, elev: 35 });
    h.tick(16, TT + 1);
    expect(h.calls).toHaveLength(3);
    expect(h.last().query).toMatchObject({ lat: 48.86, lon: 2.35, elev: 35 });
    h.last().resolve([entry(SIRIUS)]);
    await flush();
    h.actions.setOptions({ refr: false });
    h.tick(16, TT + 1);
    expect(h.calls).toHaveLength(4);
    expect(h.last().query.refraction).toBe(false);
  });

  it('never asks for refraction off Earth, and a refr toggle there changes nothing', async () => {
    const h = harness('jupiter');
    h.actions.setObserver({ body: 'mars', lat: 18.41, lon: 77.69, elev: 0 });
    h.tick();
    expect(h.last().query).toMatchObject({ body: 'mars', targets: 'jupiter', refraction: false });
    expect(h.store.getState().options.refr).toBe(true);
    h.last().resolve([entry('jupiter', null)]);
    await flush();
    // The effective flag stays `false` off Earth: the same request is not issued twice.
    h.actions.setOptions({ refr: false });
    h.tick(16);
    expect(h.calls).toHaveLength(1);
  });

  it('aborts the request in flight when the selection changes and knows the DSO constellation', () => {
    const h = harness();
    h.tick();
    const first = h.last();
    h.actions.select('dso:M31');
    h.tick(16);
    expect(first.signal.aborted).toBe(true);
    expect(h.calls).toHaveLength(2);
    expect(h.last().query.targets).toBe('dso:M31');
    expect(h.store.getState().details).toMatchObject({
      id: 'dso:M31',
      status: 'loading',
      con: 'And',
    });
  });

  it('takes the authoritative constellation of the answer over the catalog one', async () => {
    const h = harness('mars');
    h.tick();
    expect(h.store.getState().details.con).toBeNull();
    h.last().resolve([entry('mars', 'Tau')]);
    await flush();
    expect(h.store.getState().details.con).toBe('Tau');
  });

  it('clears the selection with a toast on a 404 (unknown object)', async () => {
    const h = harness('hip:99999999');
    h.tick();
    h.last().reject(problem(404, 'unknown-object'));
    await flush();
    const s = h.store.getState();
    expect(s.selection).toBeNull();
    expect(s.ui.toast?.key).toBe('details.unknown');
    h.tick(16);
    expect(h.store.getState().details).toMatchObject({
      id: null,
      status: 'idle',
      entry: null,
      con: null,
    });
    expect(h.calls).toHaveLength(1);
  });

  it('keeps the selection on a 400 and on a 422 (with the valid range)', async () => {
    const h = harness();
    h.tick();
    h.last().reject(problem(400, 'invalid-parameter'));
    await flush();
    expect(h.store.getState().selection).toBe(SIRIUS);
    expect(h.store.getState().details).toMatchObject({
      status: 'error',
      error: { status: 400, slug: 'invalid-parameter' },
    });
    // No retry while nothing changes (paused).
    h.tick(5000);
    expect(h.calls).toHaveLength(1);
    h.actions.setTime(TT + 10, h.now());
    h.tick(16, TT + 10);
    h.last().reject(problem(422, 'outside-coverage', { rangeTt: [2396758.5, 2506000.5] }));
    await flush();
    expect(h.store.getState().selection).toBe(SIRIUS);
    expect(h.store.getState().details.error).toEqual({
      status: 422,
      slug: 'outside-coverage',
      rangeTt: [2396758.5, 2506000.5],
    });
  });

  it('reports a 503 as data missing and keeps the selection', async () => {
    const h = harness('a:1');
    h.tick();
    h.last().reject(problem(503, 'data-not-ready', { retryAfterS: 60 }));
    await flush();
    expect(h.store.getState().selection).toBe('a:1');
    expect(h.store.getState().details.error).toEqual({ status: 503, slug: 'data-not-ready' });
  });

  it('honours a 429 through the shared gate and resumes when it opens', async () => {
    const h = harness();
    h.actions.play(1, h.now());
    h.tick();
    h.last().reject(problem(429, 'rate-limited', { retryAfterS: 5 }));
    await flush();
    expect(h.gate.allowed(h.now())).toBe(false);
    h.tick(1000);
    h.tick(1000);
    expect(h.calls).toHaveLength(1);
    h.tick(3000);
    expect(h.calls).toHaveLength(2);
    // A block raised by another caller holds the controller back as well.
    h.last().resolve([entry(SIRIUS)]);
    await flush();
    h.gate.block(10, h.now());
    h.tick(2000);
    expect(h.calls).toHaveLength(2);
  });

  it('retries a 429 once the gate opens even while paused, without inflating the backoff', async () => {
    const h = harness();
    h.tick();
    h.last().reject(problem(429, 'rate-limited', { retryAfterS: 5 }));
    await flush();
    expect(h.store.getState().details).toMatchObject({
      status: 'error',
      error: { status: 429, slug: 'rate-limited' },
    });
    // Paused: no cadence, but the request is owed again when `Retry-After` has passed.
    h.tick(2000);
    h.tick(2000);
    expect(h.calls).toHaveLength(1);
    h.tick(1000);
    expect(h.calls).toHaveLength(2);
    expect(h.last().query.targets).toBe(SIRIUS);
    // The 429 did not count as a failure: a network error now backs off 2 s, not 4 s.
    h.last().reject(new Error('offline'));
    await flush();
    h.tick(DETAILS_REFRESH_MS);
    expect(h.calls).toHaveLength(2);
    h.tick(DETAILS_REFRESH_MS);
    expect(h.calls).toHaveLength(3);
    h.last().resolve([entry(SIRIUS)]);
    await flush();
    expect(h.store.getState().details.status).toBe('ready');
    // Recovered and still paused: silence again.
    h.tick(10 * DETAILS_REFRESH_MS);
    expect(h.calls).toHaveLength(3);
  });

  it('keeps the last entry and backs off after a network error', async () => {
    const h = harness();
    h.actions.play(1, h.now());
    h.tick();
    h.last().resolve([entry(SIRIUS)]);
    await flush();
    h.tick(DETAILS_REFRESH_MS);
    h.last().reject(new Error('offline'));
    await flush();
    const details = h.store.getState().details;
    expect(details.status).toBe('error');
    expect(details.entry?.id).toBe(SIRIUS);
    expect(details.error).toEqual({ status: 0, slug: 'unknown' });
    // The backoff (2 s after the first failure) holds the 1 Hz cadence back once.
    h.tick(DETAILS_REFRESH_MS);
    expect(h.calls).toHaveLength(2);
    h.tick(DETAILS_REFRESH_MS);
    expect(h.calls).toHaveLength(3);
    // A change (the user moved) ignores the backoff.
    h.last().reject(new Error('offline'));
    await flush();
    h.actions.setObserver({ body: 'earth', lat: 48.8566, lon: 2.3522, elev: 35 });
    h.tick(16);
    expect(h.calls).toHaveLength(4);
  });

  it('retries a failed request after its backoff even while paused', async () => {
    const h = harness();
    h.tick();
    h.last().reject(new Error('offline'));
    await flush();
    expect(h.store.getState().details).toMatchObject({
      status: 'error',
      error: { status: 0, slug: 'unknown' },
    });
    // Paused: no cadence refresh, but the retry comes once the 2 s backoff has passed.
    h.tick(DETAILS_REFRESH_MS);
    expect(h.calls).toHaveLength(1);
    h.tick(DETAILS_REFRESH_MS);
    expect(h.calls).toHaveLength(2);
    h.last().resolve([entry(SIRIUS)]);
    await flush();
    expect(h.store.getState().details.status).toBe('ready');
    // Recovered and still paused: silence again.
    h.tick(10 * DETAILS_REFRESH_MS);
    expect(h.calls).toHaveLength(2);
  });

  it('resets the details when the selection is cleared and aborts on dispose', () => {
    const h = harness();
    h.tick();
    const call = h.last();
    h.actions.select(null);
    h.tick(16);
    expect(call.signal.aborted).toBe(true);
    expect(h.store.getState().details).toMatchObject({ id: null, status: 'idle' });
    h.actions.select(SIRIUS);
    h.tick(16);
    expect(h.calls).toHaveLength(2);
    h.controller.dispose();
    expect(h.last().signal.aborted).toBe(true);
    h.actions.select('mars');
    h.tick(16);
    expect(h.calls).toHaveLength(2);
  });
});
