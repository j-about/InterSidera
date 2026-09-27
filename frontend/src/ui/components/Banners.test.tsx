import { act, fireEvent, render, screen } from '@testing-library/react';

import { createSkyStore } from '../../state/store';
import Banners from './Banners';

describe('Banners', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_757_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing while everything is fine', () => {
    const store = createSkyStore();
    const { container } = render(<Banners store={store} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('alerts when the frames fail, counts down and retries now', () => {
    const store = createSkyStore();
    const { actions } = store.getState();
    render(<Banners store={store} />);
    act(() => {
      actions.setBoot({ phase: 'ready' });
      actions.setFrames({ failing: { status: 0, attempts: 2, nextRetryMs: Date.now() + 4200 } });
    });
    const alert = screen.getByRole('alert', { name: 'Sky service unreachable' });
    expect(alert).toHaveTextContent('retrying in 5 s');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(alert).toHaveTextContent('retrying in 3 s');
    const before = store.getState().boot.retrySeq;
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(store.getState().boot.retrySeq).toBe(before + 1);
    act(() => {
      actions.setFrames({ failing: null });
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('leaves a failing first frame to the splash: the alert is a post-boot signal', () => {
    // The frame controller publishes `failing` from the first retry (plan R70), during the boot
    // too; while the splash is up (`boot.phase !== 'ready'`) it owns the message.
    const store = createSkyStore();
    const { actions } = store.getState();
    render(<Banners store={store} />);
    const failing = { status: 0, attempts: 1, nextRetryMs: Date.now() + 1000 };
    act(() => {
      actions.setBoot({ phase: 'frame' });
      actions.setFrames({ failing });
    });
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => {
      actions.setBoot({ phase: 'ready' });
    });
    expect(screen.getByRole('alert', { name: 'Sky service unreachable' })).toHaveTextContent(
      'retrying in 1 s',
    );
  });

  it('offers a reload when a catalog is stale', () => {
    const store = createSkyStore();
    const reload = vi.fn();
    render(<Banners store={store} reload={reload} />);
    act(() => {
      store.getState().actions.setCatalogStatus('stars', 'stale');
    });
    const status = screen.getByRole('status', { name: 'Catalogs updated' });
    expect(status).toHaveTextContent('newer catalogs');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('tells the coverage stop with the range as signed years', () => {
    const store = createSkyStore();
    render(<Banners store={store} />);
    act(() => {
      // 1850-01-01 .. 2149-01-25 TT.
      store.getState().actions.stopAtBound([2396758.5, 2506000.5]);
    });
    const status = screen.getByRole('status', { name: 'Edge of the data' });
    expect(status).toHaveTextContent('1850 to 2149');
    act(() => {
      store.getState().actions.live();
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('reports a renderer failure after start, but leaves the WebGL2 case to the splash', () => {
    const store = createSkyStore();
    const { actions } = store.getState();
    render(<Banners store={store} />);
    act(() => {
      actions.setEngine({ status: 'failed' });
    });
    expect(screen.getByRole('alert', { name: 'Rendering stopped' })).toHaveTextContent(
      'reload the page',
    );
    act(() => {
      actions.setBoot({ phase: 'error', error: { kind: 'webgl2' } });
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('warns when augmented reality stopped or was refused (AR-5) and clears on dismiss', () => {
    const store = createSkyStore();
    const { actions } = store.getState();
    render(<Banners store={store} />);
    act(() => {
      actions.failAr('cameraDenied');
    });
    const alert = screen.getByRole('alert', { name: 'Augmented reality unavailable' });
    expect(alert).toHaveTextContent('Camera access was denied');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(store.getState().ar.error).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // An XR failure keeps the sensor mode and shows the same home's message.
    act(() => {
      actions.setArCapabilities({
        secure: true,
        camera: true,
        orientation: true,
        touch: true,
        videoInput: true,
      });
      actions.requestAr();
      actions.setArMode('sensor');
      actions.failAr('xrUnsupported');
    });
    expect(store.getState().ar.mode).toBe('sensor');
    expect(screen.getByRole('alert', { name: 'Augmented reality unavailable' })).toHaveTextContent(
      'Google Play Services for AR',
    );
  });
});
