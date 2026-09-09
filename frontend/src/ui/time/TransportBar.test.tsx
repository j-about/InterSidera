import { act, fireEvent, render, screen } from '@testing-library/react';

import { createSkyStore } from '../../state/store';
import { makeMeta } from '../../test/meta';
import TransportBar, { effectiveSpeed } from './TransportBar';

// The transport: play/pause resuming the last speed, slower/faster along the signed list, the
// speed select, "Now", and the hosted date-and-time dialog.

const T0 = 1_757_000_000_000;
const TT = 2460409.25;

describe('TransportBar', () => {
  it('plays, pauses and resumes the interrupted speed', () => {
    const store = createSkyStore({ t: TT, speed: 0 }, T0);
    store.getState().actions.setMeta(makeMeta());
    render(<TransportBar store={store} />);
    const play = screen.getByRole('button', { name: 'Play' });
    expect(play).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(play);
    expect(store.getState().clock).toMatchObject({ mode: 'playing', speed: 1 });
    const pause = screen.getByRole('button', { name: 'Pause' });
    expect(pause).toHaveAttribute('aria-pressed', 'true');

    fireEvent.change(screen.getByRole('combobox', { name: 'Speed' }), {
      target: { value: '3600' },
    });
    expect(store.getState().clock.speed).toBe(3600);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(store.getState().clock.mode).toBe('paused');
    expect(screen.getByRole('combobox', { name: 'Speed' })).toHaveValue('0');
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(store.getState().clock).toMatchObject({ mode: 'playing', speed: 3600 });
  });

  it('moves along the signed list and goes live', () => {
    const store = createSkyStore({ t: TT, speed: 0 }, T0);
    store.getState().actions.setMeta(makeMeta());
    render(<TransportBar store={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'Faster' }));
    expect(store.getState().clock.speed).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Faster' }));
    expect(store.getState().clock.speed).toBe(10);
    fireEvent.click(screen.getByRole('button', { name: 'Slower' }));
    fireEvent.click(screen.getByRole('button', { name: 'Slower' }));
    expect(store.getState().clock.speed).toBe(-1);
    fireEvent.click(screen.getByRole('button', { name: 'Now' }));
    expect(store.getState().clock.mode).toBe('live');
    expect(screen.getByRole('button', { name: 'Now' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('combobox', { name: 'Speed' })).toHaveValue('1');
  });

  it('hosts the date-and-time editor and works before /meta with the default speeds', () => {
    const store = createSkyStore({ t: TT, speed: 0 }, T0);
    render(<TransportBar store={store} />);
    expect(screen.getAllByRole('option')).toHaveLength(19);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => {
      store.getState().actions.openDialog('timeEditor');
    });
    expect(screen.getByRole('dialog', { name: 'Set date and time' })).toBeInTheDocument();
  });

  it('reads the effective speed of each mode', () => {
    expect(effectiveSpeed('live', 0)).toBe(1);
    expect(effectiveSpeed('paused', 600)).toBe(0);
    expect(effectiveSpeed('playing', 600)).toBe(600);
  });
});
