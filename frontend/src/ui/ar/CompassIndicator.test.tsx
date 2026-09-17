import { act, render, screen } from '@testing-library/react';

import { createSkyStore } from '../../state/store';
import type { ArHeading } from '../../state/types';
import CompassIndicator from './CompassIndicator';

// The compass indicator (AR-2, plan D118, D127): one text per level, the iOS figure for the
// compass source, the magnetic-north tooltip for the headed sources; a status region named
// "Compass". The tone never carries the state alone (UX-4), so only texts are asserted.

describe('CompassIndicator', () => {
  function renderWith(heading?: ArHeading) {
    const store = createSkyStore();
    if (heading !== undefined) {
      store.getState().actions.setArHeading(heading);
    }
    render(<CompassIndicator store={store} />);
    return store;
  }

  it('waits for the sensors before the first sample, without a magnetic tooltip', () => {
    renderWith();
    const region = screen.getByRole('status', { name: 'Compass' });
    expect(region).toHaveTextContent('Waiting for the sensors');
    expect(region.querySelector('[title]')).toBeNull();
  });

  it('reads the absolute source as a compass heading with the magnetic-north tooltip', () => {
    renderWith({ source: 'absolute', accuracyDeg: null, level: 'good' });
    const region = screen.getByRole('status', { name: 'Compass' });
    expect(region).toHaveTextContent(/^Compass heading$/);
    expect(region.querySelector('[title]')).toHaveAttribute(
      'title',
      expect.stringContaining('Magnetic north'),
    );
  });

  it('appends the iOS accuracy figure for the compass source and grades it', () => {
    const store = renderWith({ source: 'compass', accuracyDeg: 12.4, level: 'good' });
    const region = screen.getByRole('status', { name: 'Compass' });
    expect(region).toHaveTextContent('Compass heading ±12°');
    act(() => {
      store.getState().actions.setArHeading({ source: 'compass', accuracyDeg: 25, level: 'fair' });
    });
    expect(region).toHaveTextContent('Compass heading (fair) ±25°');
    act(() => {
      store.getState().actions.setArHeading({ source: 'compass', accuracyDeg: 60, level: 'poor' });
    });
    expect(region).toHaveTextContent('Compass heading (poor) ±60°');
  });

  it('asks for a calibration on a negative accuracy, without a figure', () => {
    renderWith({ source: 'compass', accuracyDeg: -1, level: 'invalid' });
    expect(screen.getByRole('status', { name: 'Compass' })).toHaveTextContent(
      /^Compass needs calibration$/,
    );
  });

  it('says so when north is manual (relative source), without a magnetic tooltip', () => {
    renderWith({ source: 'relative', accuracyDeg: null, level: 'manual' });
    const region = screen.getByRole('status', { name: 'Compass' });
    expect(region).toHaveTextContent('No compass: align north by dragging');
    expect(region.querySelector('[title]')).toBeNull();
  });
});
