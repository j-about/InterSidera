import { act, render, screen } from '@testing-library/react';
import i18next from 'i18next';

import { createSkyStore } from '../state/store';
import type { SkyStore } from '../state/storeTypes';
import type { HealthResponse } from '../state/storeTypes';
import BootStatus from './BootStatus';

// The splash renders every boot phase from the store alone (plan D87): the lines, the progress
// variants, the fatal detail, the unreachable countdown, the UX-6 WebGL2 text, and nothing once
// the boot is `ready`.

const STARTING: HealthResponse = { status: 'starting', version: '0.1.0' };

function setup(): { store: SkyStore } {
  const store = createSkyStore();
  render(<BootStatus store={store} />);
  return { store };
}

describe('BootStatus', () => {
  it('shows the title, the tagline and the connecting line before /health answers', () => {
    setup();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(i18next.t('app.title'));
    expect(status).toHaveTextContent(i18next.t('app.tagline'));
    expect(screen.getByText(i18next.t('boot.connecting'))).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText(i18next.t('boot.meta'))).not.toHaveAttribute('aria-current');
  });

  it('shows the starting line, then the download progress in percent or megabytes', () => {
    const { store } = setup();
    act(() => {
      store.getState().actions.setHealth(STARTING);
    });
    expect(screen.getByText(i18next.t('boot.starting'))).toBeInTheDocument();

    act(() => {
      store.getState().actions.setBoot({
        progress: { file: 'de440s.bsp', downloadedBytes: 16_363_008, totalBytes: 32_726_016 },
      });
    });
    expect(
      screen.getByText(i18next.t('boot.downloading', { file: 'de440s.bsp', percent: 50 })),
    ).toBeInTheDocument();

    act(() => {
      store.getState().actions.setBoot({
        progress: { file: 'MPCORB.DAT', downloadedBytes: 12_345_678, totalBytes: 0 },
      });
    });
    expect(
      screen.getByText(i18next.t('boot.downloadingBytes', { file: 'MPCORB.DAT', mb: '12.3' })),
    ).toBeInTheDocument();
  });

  it('shows the fatal detail reported by /health', () => {
    const { store } = setup();
    act(() => {
      store.getState().actions.setBoot({ error: { kind: 'fatal', detail: 'de440s.bsp missing' } });
    });
    expect(
      screen.getByText(i18next.t('boot.failed', { detail: 'de440s.bsp missing' })),
    ).toBeInTheDocument();
  });

  it('counts down to the next /health attempt while the API is unreachable', () => {
    vi.useFakeTimers();
    try {
      const { store } = setup();
      act(() => {
        store.getState().actions.setBoot({
          attempt: 2,
          retryAtMs: Date.now() + 4000,
          error: { kind: 'unreachable' },
        });
      });
      act(() => {
        vi.advanceTimersByTime(0);
      });
      expect(screen.getByText(i18next.t('boot.unreachable', { seconds: 4 }))).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByText(i18next.t('boot.unreachable', { seconds: 2 }))).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the passed phases and the current one', () => {
    const { store } = setup();
    act(() => {
      store.getState().actions.setBoot({ phase: 'catalogs' });
    });
    expect(screen.getByText(i18next.t('boot.connecting'))).toHaveClass('line-through');
    expect(screen.getByText(i18next.t('boot.meta'))).toHaveClass('line-through');
    expect(screen.getByText(i18next.t('boot.catalogs'))).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText(i18next.t('boot.frame'))).not.toHaveAttribute('aria-current');

    act(() => {
      store.getState().actions.setBoot({ phase: 'frame' });
    });
    expect(screen.getByText(i18next.t('boot.frame'))).toHaveAttribute('aria-current', 'step');
  });

  it('explains a browser without WebGL2 and an HTTP failure', () => {
    const { store } = setup();
    act(() => {
      store.getState().actions.setBoot({ phase: 'error', error: { kind: 'webgl2' } });
    });
    expect(screen.getByText(i18next.t('engine.unsupported'))).toBeInTheDocument();

    act(() => {
      store.getState().actions.setBoot({ phase: 'error', error: { kind: 'http', status: 404 } });
    });
    expect(screen.getByText(i18next.t('boot.failed', { detail: 'HTTP 404' }))).toBeInTheDocument();
  });

  it('renders nothing once the boot is ready', () => {
    const { store } = setup();
    act(() => {
      store.getState().actions.setBoot({ phase: 'ready' });
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
