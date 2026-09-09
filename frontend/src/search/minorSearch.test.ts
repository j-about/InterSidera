// @vitest-environment node
import { ApiProblem } from '../api/client';
import type { MinorBodySummary } from '../api/client';
import { createRateGate } from '../api/rateGate';
import {
  IDLE_MINOR_SEARCH,
  MINOR_SEARCH_DEBOUNCE_MS,
  MINOR_SEARCH_LIMIT,
  createMinorSearch,
  minorHit,
} from './minorSearch';
import type { MinorSearchState } from './minorSearch';

const CERES: MinorBodySummary = {
  id: 'a:1',
  designation: '(1) Ceres',
  name: 'Ceres',
  kind: 'asteroid',
  h_mag: 3.34,
  elements_epoch_tt: 2461200.5,
};
const HALLEY: MinorBodySummary = {
  id: 'c:1P',
  designation: '1P/Halley',
  kind: 'comet',
  elements_epoch_tt: 2450000.5,
};

interface Timer {
  id: number;
  at: number;
  callback: () => void;
}

/** A manual clock and timer queue, so the debounce is stepped deterministically. */
function fakeClock() {
  let nowMs = 0;
  let nextId = 1;
  const timers: Timer[] = [];
  return {
    now: () => nowMs,
    setTimer: (callback: () => void, ms: number): number => {
      const id = nextId++;
      timers.push({ id, at: nowMs + ms, callback });
      return id;
    },
    clearTimer: (id: number): void => {
      const i = timers.findIndex((timer) => timer.id === id);
      if (i >= 0) {
        timers.splice(i, 1);
      }
    },
    advance(ms: number): void {
      nowMs += ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= nowMs).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) {
          return;
        }
        timers.splice(timers.indexOf(due), 1);
        due.callback();
      }
    },
    pending: () => timers.length,
  };
}

interface Call {
  q: string;
  limit: number;
  signal: AbortSignal;
  resolve: (rows: readonly MinorBodySummary[]) => void;
  reject: (error: unknown) => void;
}

function harness(gate = createRateGate()) {
  const clock = fakeClock();
  const calls: Call[] = [];
  const states: MinorSearchState[] = [];
  const search = createMinorSearch((state) => states.push(state), {
    search: (q, limit, signal) =>
      new Promise<readonly MinorBodySummary[]>((resolve, reject) => {
        calls.push({ q, limit, signal, resolve, reject });
      }),
    rateGate: gate,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, calls, states, search, gate };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('createMinorSearch', () => {
  it('debounces 400 ms, asks for 8 rows and publishes the hits', async () => {
    const h = harness();
    h.search.setEnabled(true);
    h.search.query('ce');
    h.search.query('cer');
    expect(h.states.at(-1)).toMatchObject({ status: 'pending', query: 'cer' });
    h.clock.advance(MINOR_SEARCH_DEBOUNCE_MS - 1);
    expect(h.calls).toHaveLength(0);
    h.clock.advance(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ q: 'cer', limit: MINOR_SEARCH_LIMIT });
    expect(h.states.at(-1)?.status).toBe('searching');
    h.calls[0]?.resolve([CERES, HALLEY]);
    await flush();
    const last = h.states.at(-1);
    expect(last?.status).toBe('ready');
    expect(last?.query).toBe('cer');
    expect(last?.hits.map((hit) => hit.id)).toEqual(['a:1', 'c:1P']);
    expect(h.search.state).toBe(last);
  });

  it('aborts the superseded request and keeps only the latest answer', async () => {
    const h = harness();
    h.search.setEnabled(true);
    h.search.query('ceres');
    h.clock.advance(MINOR_SEARCH_DEBOUNCE_MS);
    const first = h.calls[0];
    if (first === undefined) {
      throw new Error('no request');
    }
    h.search.query('halley');
    expect(first.signal.aborted).toBe(true);
    h.clock.advance(MINOR_SEARCH_DEBOUNCE_MS);
    expect(h.calls).toHaveLength(2);
    first.resolve([CERES]);
    h.calls[1]?.resolve([HALLEY]);
    await flush();
    expect(h.states.at(-1)?.hits.map((hit) => hit.id)).toEqual(['c:1P']);
    expect(h.states.some((state) => state.hits.some((hit) => hit.id === 'a:1'))).toBe(false);
  });

  it('needs two characters and clears the results below that', () => {
    const h = harness();
    h.search.setEnabled(true);
    h.search.query('c');
    h.clock.advance(1000);
    expect(h.calls).toHaveLength(0);
    expect(h.states).toEqual([]);
    h.search.query('ce');
    expect(h.states.at(-1)?.status).toBe('pending');
    h.search.query('');
    expect(h.states.at(-1)).toBe(IDLE_MINOR_SEARCH);
    h.clock.advance(1000);
    expect(h.calls).toHaveLength(0);
  });

  it('reports the search as unavailable while the server has no MPC tables', () => {
    const h = harness();
    h.search.query('ceres');
    h.clock.advance(1000);
    expect(h.calls).toHaveLength(0);
    expect(h.states.at(-1)).toMatchObject({ status: 'unavailable', query: 'ceres', hits: [] });
    // The tables appear (a later /meta): the pending text is searched.
    h.search.setEnabled(true);
    h.clock.advance(MINOR_SEARCH_DEBOUNCE_MS);
    expect(h.calls).toHaveLength(1);
  });

  it('honours the shared 429 gate before and after a request', async () => {
    const gate = createRateGate();
    const h = harness(gate);
    h.search.setEnabled(true);
    gate.block(2, h.clock.now());
    h.search.query('ceres');
    h.clock.advance(MINOR_SEARCH_DEBOUNCE_MS);
    expect(h.calls).toHaveLength(0);
    expect(h.states.at(-1)?.status).toBe('pending');
    h.clock.advance(2000 - MINOR_SEARCH_DEBOUNCE_MS);
    expect(h.calls).toHaveLength(1);
    h.calls[0]?.reject(
      new ApiProblem({
        status: 429,
        slug: 'rate-limited',
        type: 'x#problem-rate-limited',
        title: 'Rate limited',
        retryAfterS: 5,
      }),
    );
    await flush();
    expect(gate.allowed(h.clock.now())).toBe(false);
    expect(h.states.at(-1)?.status).toBe('pending');
    h.clock.advance(5000);
    expect(h.calls).toHaveLength(2);
  });

  it('maps a 503 to unavailable and any other failure to an error', async () => {
    const h = harness();
    h.search.setEnabled(true);
    h.search.query('ceres');
    h.clock.advance(MINOR_SEARCH_DEBOUNCE_MS);
    h.calls[0]?.reject(
      new ApiProblem({
        status: 503,
        slug: 'data-not-ready',
        type: 'x#problem-data-not-ready',
        title: 'Data not ready',
      }),
    );
    await flush();
    expect(h.states.at(-1)?.status).toBe('unavailable');
    h.search.query('halley');
    h.clock.advance(MINOR_SEARCH_DEBOUNCE_MS);
    h.calls[1]?.reject(new Error('offline'));
    await flush();
    expect(h.states.at(-1)?.status).toBe('error');
  });

  it('stops everything on dispose', () => {
    const h = harness();
    h.search.setEnabled(true);
    h.search.query('ceres');
    h.clock.advance(MINOR_SEARCH_DEBOUNCE_MS);
    h.search.dispose();
    expect(h.calls[0]?.signal.aborted).toBe(true);
    h.search.query('halley');
    h.clock.advance(1000);
    expect(h.calls).toHaveLength(1);
    expect(h.clock.pending()).toBe(0);
  });
});

describe('minorHit', () => {
  it('shows the name with the designation, or the designation alone', () => {
    expect(minorHit(CERES)).toEqual({
      id: 'a:1',
      kind: 'minor',
      kindKey: 'asteroid',
      label: 'Ceres',
      sub: '(1) Ceres',
      score: 0,
      mag: 3.34,
    });
    expect(minorHit(HALLEY)).toMatchObject({
      id: 'c:1P',
      kindKey: 'comet',
      label: '1P/Halley',
      sub: '',
      mag: 99,
    });
  });
});
