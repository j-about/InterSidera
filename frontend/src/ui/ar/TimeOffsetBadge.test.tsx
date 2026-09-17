import { act, render, screen } from '@testing-library/react';

import { liveControl, ttAt } from '../../state/clock';
import { createSkyStore } from '../../state/store';
import TimeOffsetBadge from './TimeOffsetBadge';

// The time-offset badge (AR-1, plan D127): a named status region while the clock is not live,
// following the mirror and the wall clock, hidden in live mode.

const TT_MINUS_UTC = 69.184;
/** 2026-09-17T12:00Z as the wall clock. */
const NOW_MS = Date.UTC(2026, 8, 17, 12);
const MINUTE_D = 1 / 1440;

describe('TimeOffsetBadge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function pausedStore(offsetDays: number) {
    const store = createSkyStore();
    store.setState((s) => ({ clock: { ...s.clock, ttMinusUtc: TT_MINUS_UTC } }));
    const liveNow = ttAt(liveControl(NOW_MS), NOW_MS, TT_MINUS_UTC);
    const { actions } = store.getState();
    actions.setTime(liveNow + offsetDays, NOW_MS);
    actions.publishTt(liveNow + offsetDays, NaN);
    return store;
  }

  it('shows the offset behind now and follows the wall clock while the mirror stands still', () => {
    const store = pausedStore(-(3 * 60 + 12) * MINUTE_D - 20 / 86400);
    render(<TimeOffsetBadge store={store} />);
    const region = screen.getByRole('status', { name: 'Time offset from now' });
    expect(region).toHaveTextContent('−3 h 12 min');
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(region).toHaveTextContent('−3 h 13 min');
  });

  it('shows years and days ahead of now and follows the 2 Hz mirror', () => {
    const store = pausedStore(2 * 365.25 + 10);
    render(<TimeOffsetBadge store={store} />);
    const region = screen.getByRole('status', { name: 'Time offset from now' });
    expect(region).toHaveTextContent('+2 yr 10 d');
    act(() => {
      store.getState().actions.publishTt(store.getState().clock.tt + 5, NaN);
    });
    expect(region).toHaveTextContent('+2 yr 15 d');
  });

  it('is absent in live mode and returns when the clock pauses', () => {
    const store = pausedStore(1);
    render(<TimeOffsetBadge store={store} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => {
      store.getState().actions.live(NOW_MS);
    });
    expect(screen.queryByRole('status')).toBeNull();
    act(() => {
      store.getState().actions.pause(NOW_MS);
    });
    expect(screen.getByRole('status', { name: 'Time offset from now' })).toHaveTextContent('Now');
  });
});
