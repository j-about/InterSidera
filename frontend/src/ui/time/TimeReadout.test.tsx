import { act, render, screen } from '@testing-library/react';

import { createSkyStore } from '../../state/store';
import {
  browserOffsetAt,
  formatCalendar,
  formatOffset,
  localCalendarOfTt,
} from '../../state/timeDisplay';
import TimeReadout from './TimeReadout';

// The readout: local time and zone, the UTC (or UT) line, the Julian Date, the LAST row on Earth
// only, the live marker, and nothing before the first mirror.

const T0 = 1_757_000_000_000;
const TT = 2460409.25;

describe('TimeReadout', () => {
  it('shows the fixture instant in local time, UTC and JD, and LAST on Earth', () => {
    const store = createSkyStore({ t: TT, speed: 0 }, T0);
    render(<TimeReadout store={store} />);
    const local = localCalendarOfTt(TT, 69.184);
    expect(screen.getByTestId('time-local')).toHaveTextContent(formatCalendar(local.fields));
    expect(screen.getByTestId('time-readout')).toHaveTextContent(formatOffset(local.offsetMin));
    expect(screen.getByTestId('time-utc')).toHaveTextContent('2024-04-08 17:58:50');
    expect(screen.getByText('UTC')).toBeInTheDocument();
    expect(screen.getByTestId('time-jd')).toHaveTextContent('2460409.25000');
    expect(screen.queryByTestId('time-last')).toBeNull();
    expect(screen.queryByText('Live')).toBeNull();

    act(() => {
      store.getState().actions.publishTt(TT, 13.5);
    });
    expect(screen.getByTestId('time-last')).toHaveTextContent('13:30:00');
    expect(screen.getByText('LAST')).toBeInTheDocument();

    act(() => {
      store.getState().actions.setObserver({ body: 'mars', lat: 0, lon: 0, elev: 0 });
      store.getState().actions.publishTt(TT, NaN);
    });
    expect(screen.queryByTestId('time-last')).toBeNull();
    expect(browserOffsetAt(0)).toBe(-new Date(0).getTimezoneOffset());
  });

  it('labels UT before 1972 and marks live mode', () => {
    const store = createSkyStore({ t: 2441317.4, speed: 0 }, T0);
    render(<TimeReadout store={store} />);
    expect(screen.getByText('UT')).toBeInTheDocument();
    act(() => {
      store.getState().actions.live(T0);
      store.getState().actions.publishTt(TT, NaN);
    });
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText('UTC')).toBeInTheDocument();
  });

  it('renders nothing while the mirror is NaN', () => {
    const store = createSkyStore({ t: TT, speed: 0 }, T0);
    act(() => {
      store.getState().actions.publishTt(NaN, NaN);
    });
    const { container } = render(<TimeReadout store={store} />);
    expect(container).toBeEmptyDOMElement();
  });
});
