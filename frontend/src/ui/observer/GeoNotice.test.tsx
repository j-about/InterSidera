import { act, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';

import { createSkyStore } from '../../state/store';
import GeoNotice from './GeoNotice';

// The geolocation notice: a hint per failure, no region of its own while prompting (the shell's
// `GeoBanner` explains the prompt), and the always present "Use my location" button re-requesting
// through an injected `Geolocation`.

function fakeGeolocation(): { geolocation: Geolocation; calls: number } {
  const state = { calls: 0 };
  const geolocation = {
    getCurrentPosition() {
      state.calls += 1;
    },
    watchPosition: () => 0,
    clearWatch: () => undefined,
  } as Geolocation;
  return {
    geolocation,
    get calls() {
      return state.calls;
    },
  };
}

describe('GeoNotice', () => {
  it('shows nothing but the button while idle or granted', () => {
    const store = createSkyStore();
    render(<GeoNotice store={store} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Use my location' })).toBeInTheDocument();
    act(() => {
      store.getState().actions.setGeo('granted');
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('holds the button while prompting, then names each failure', () => {
    const store = createSkyStore();
    render(<GeoNotice store={store} />);
    act(() => {
      store.getState().actions.setGeo('prompting');
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Use my location' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    for (const status of ['denied', 'unavailable', 'timeout', 'unsupported', 'insecure'] as const) {
      act(() => {
        store.getState().actions.setGeo(status);
      });
      expect(screen.getByRole('status', { name: 'Your location' })).toHaveTextContent(
        i18next.t(`geo.${status}`),
      );
    }
  });

  it('re-requests the position from the button and ignores clicks while prompting', () => {
    const store = createSkyStore();
    const fake = fakeGeolocation();
    render(
      <GeoNotice store={store} deps={{ geolocation: fake.geolocation, isSecureContext: true }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));
    expect(fake.calls).toBe(1);
    expect(store.getState().geo.status).toBe('prompting');
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));
    expect(fake.calls).toBe(1);
  });
});
