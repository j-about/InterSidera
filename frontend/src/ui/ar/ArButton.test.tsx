import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { createSkyStore } from '../../state/store';
import type { ArCapabilities, ArPermission } from '../../state/types';
import ArButton, { AR_BUTTON_ID, focusArButton } from './ArButton';

// The AR button (AR-1, plan D125-D127): rendered only where the gate holds, and the one place
// the motion permission is asked, synchronously inside the click and before `requestAr()`.

const CAPABLE: ArCapabilities = {
  secure: true,
  camera: true,
  orientation: true,
  touch: true,
  videoInput: true,
};

describe('ArButton', () => {
  it('is absent before the probe, on a desktop, without a camera and off Earth', () => {
    const store = createSkyStore();
    const { actions } = store.getState();
    const { rerender } = render(<ArButton store={store} />);
    expect(screen.queryByRole('button')).toBeNull();
    actions.setArCapabilities({ ...CAPABLE, touch: false });
    rerender(<ArButton store={store} />);
    expect(screen.queryByRole('button')).toBeNull();
    actions.setArCapabilities({ ...CAPABLE, videoInput: false });
    rerender(<ArButton store={store} />);
    expect(screen.queryByRole('button')).toBeNull();
    actions.setArCapabilities(CAPABLE);
    actions.setObserver({ body: 'mars', lat: 18.44, lon: 77.45, elev: 0 });
    rerender(<ArButton store={store} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is present on Earth with every capability, named and carrying its id', () => {
    const store = createSkyStore();
    store.getState().actions.setArCapabilities(CAPABLE);
    render(<ArButton store={store} />);
    const button = screen.getByRole('button', { name: 'Augmented reality' });
    expect(button).toHaveAttribute('id', AR_BUTTON_ID);
    focusArButton();
    expect(button).toHaveFocus();
  });

  it('writes pending, asks the permission synchronously, enters AR, then records the outcome', async () => {
    const store = createSkyStore();
    store.getState().actions.setArCapabilities(CAPABLE);
    const log: string[] = [];
    store.subscribe((s) => {
      log.push(`${s.ar.mode}/${s.ar.permission}`);
    });
    let settle: (permission: ArPermission) => void = () => undefined;
    const requestPermission = vi.fn(
      () =>
        new Promise<ArPermission>((resolve) => {
          log.push('requestPermission');
          settle = resolve;
        }),
    );
    render(<ArButton store={store} requestPermission={requestPermission} />);
    fireEvent.click(screen.getByRole('button', { name: 'Augmented reality' }));
    // The helper ran inside the click, after `pending` and before `requestAr` (plan D126).
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['off/pending', 'requestPermission', 'requesting/pending']);
    expect(store.getState().ar.mode).toBe('requesting');
    settle('granted');
    await waitFor(() => {
      expect(store.getState().ar.permission).toBe('granted');
    });
    expect(store.getState().ar.mode).toBe('requesting');
  });

  it('never reuses a previous outcome: a second tap starts from pending again', async () => {
    const store = createSkyStore();
    const { actions } = store.getState();
    actions.setArCapabilities(CAPABLE);
    const requestPermission = vi.fn(() => Promise.resolve<ArPermission>('denied'));
    render(<ArButton store={store} requestPermission={requestPermission} />);
    fireEvent.click(screen.getByRole('button', { name: 'Augmented reality' }));
    await waitFor(() => {
      expect(store.getState().ar.permission).toBe('denied');
    });
    actions.exitAr();
    fireEvent.click(screen.getByRole('button', { name: 'Augmented reality' }));
    expect(store.getState().ar.permission).toBe('pending');
    expect(requestPermission).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(store.getState().ar.permission).toBe('denied');
    });
  });

  it('ignores the late outcome of an earlier tap once a new tap has written pending', async () => {
    const store = createSkyStore();
    const { actions } = store.getState();
    actions.setArCapabilities(CAPABLE);
    const settlers: ((permission: ArPermission) => void)[] = [];
    const requestPermission = vi.fn(
      () =>
        new Promise<ArPermission>((resolve) => {
          settlers.push(resolve);
        }),
    );
    render(<ArButton store={store} requestPermission={requestPermission} />);
    fireEvent.click(screen.getByRole('button', { name: 'Augmented reality' }));
    actions.exitAr();
    fireEvent.click(screen.getByRole('button', { name: 'Augmented reality' }));
    expect(settlers).toHaveLength(2);
    expect(store.getState().ar.permission).toBe('pending');
    // The first tap's promise settles late: the second tap's `pending` stands (its controller
    // waits on it).
    settlers[0]?.('denied');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(store.getState().ar.permission).toBe('pending');
    settlers[1]?.('granted');
    await waitFor(() => {
      expect(store.getState().ar.permission).toBe('granted');
    });
  });

  it('records prompt when an injected helper rejects', async () => {
    const store = createSkyStore();
    store.getState().actions.setArCapabilities(CAPABLE);
    const requestPermission = vi.fn(() => Promise.reject<ArPermission>(new Error('no static')));
    render(<ArButton store={store} requestPermission={requestPermission} />);
    fireEvent.click(screen.getByRole('button', { name: 'Augmented reality' }));
    await waitFor(() => {
      expect(store.getState().ar.permission).toBe('prompt');
    });
    expect(store.getState().ar.mode).toBe('requesting');
  });
});
