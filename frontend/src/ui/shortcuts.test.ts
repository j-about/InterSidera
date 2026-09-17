import { createSkyStore } from '../state/store';
import type { SkyStore } from '../state/storeTypes';
import { installShortcuts, isInteractiveTarget } from './shortcuts';

// The keyboard shortcuts (TIME-5, plan D99) against the real store under jsdom: every key, the
// ignore rules (interactive targets, modifiers, repeat, composition, an open dialog, the switch
// off), the augmented-reality rules (view keys inert, Escape exits; plan D124, D127) and the
// uninstall.

const T0 = 1_757_000_000_000;
const TT = 2460409.25;

function setup(url: Parameters<typeof createSkyStore>[0] = { t: TT, speed: 0 }): {
  store: SkyStore;
  uninstall: () => void;
} {
  const store = createSkyStore(url, T0);
  const uninstall = installShortcuts(store);
  return { store, uninstall };
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('installShortcuts', () => {
  let uninstall: () => void = () => undefined;
  afterEach(() => {
    uninstall();
    document.body.innerHTML = '';
  });

  it('plays and pauses with Space, resuming the speed it interrupted', () => {
    const s = setup();
    uninstall = s.uninstall;
    expect(press(' ')).toBe(true);
    expect(s.store.getState().clock).toMatchObject({ mode: 'playing', speed: 1 });
    s.store.getState().actions.play(600, T0);
    press(' ');
    expect(s.store.getState().clock.mode).toBe('paused');
    press(' ');
    expect(s.store.getState().clock).toMatchObject({ mode: 'playing', speed: 600 });
    s.store.getState().actions.live(T0);
    press(' ');
    expect(s.store.getState().clock.mode).toBe('paused');
  });

  it('moves one index in the signed speed list with , and .', () => {
    const s = setup();
    uninstall = s.uninstall;
    press('.');
    expect(s.store.getState().clock).toMatchObject({ mode: 'playing', speed: 1 });
    press('.');
    expect(s.store.getState().clock.speed).toBe(10);
    press(',');
    press(',');
    expect(s.store.getState().clock.speed).toBe(-1);
    s.store.getState().actions.pause(T0);
    press(',');
    expect(s.store.getState().clock.speed).toBe(-1);
    s.store.getState().actions.live(T0);
    press('.');
    expect(s.store.getState().clock.speed).toBe(10);
  });

  it('steps by the chosen unit with [ and ]', () => {
    const s = setup();
    uninstall = s.uninstall;
    press(']');
    expect(s.store.getState().clock.ttAnchor).toBeCloseTo(TT + 1 / 24, 9);
    s.store.getState().actions.setUi({ stepUnit: 'day' });
    press('[');
    expect(s.store.getState().clock.ttAnchor).toBeCloseTo(TT + 1 / 24 - 1, 9);
    expect(s.store.getState().clock.mode).toBe('paused');
  });

  it('goes live with n and opens the editor with t', () => {
    const s = setup();
    uninstall = s.uninstall;
    press('n');
    expect(s.store.getState().clock.mode).toBe('live');
    press('t');
    expect(s.store.getState().ui.dialog).toBe('timeEditor');
    // With the dialog open every shortcut is ignored (the dialog owns the keys).
    expect(press(' ')).toBe(false);
    expect(s.store.getState().clock.mode).toBe('live');
  });

  it('pans with the arrows by a tenth of the field and zooms with + = -', () => {
    const s = setup();
    uninstall = s.uninstall;
    press('ArrowRight');
    expect(s.store.getState().view.az).toBe(6);
    press('ArrowLeft');
    press('ArrowLeft');
    expect(s.store.getState().view.az).toBe(354);
    press('ArrowUp');
    expect(s.store.getState().view.alt).toBe(26);
    press('ArrowDown');
    expect(s.store.getState().view.alt).toBe(20);
    press('+');
    expect(s.store.getState().view.fov).toBe(48);
    press('=');
    expect(s.store.getState().view.fov).toBeCloseTo(38.4, 9);
    press('-');
    expect(s.store.getState().view.fov).toBe(48);
  });

  it('collapses the sheet with Escape, keeps the tab, and leaves the event alone when collapsed', () => {
    const s = setup();
    uninstall = s.uninstall;
    expect(press('Escape')).toBe(false);
    s.store.getState().actions.openPanel('time');
    expect(press('Escape')).toBe(true);
    // The chosen tab stays (the desktop column would otherwise jump back to the default tab).
    expect(s.store.getState().ui).toMatchObject({ panel: 'time', sheet: 'collapsed' });
    expect(press('Escape')).toBe(false);
  });

  it('ignores modifiers, repeats, composition, handled events and unknown keys', () => {
    const s = setup();
    uninstall = s.uninstall;
    expect(press(' ', { ctrlKey: true })).toBe(false);
    expect(press(' ', { metaKey: true })).toBe(false);
    expect(press(' ', { altKey: true })).toBe(false);
    expect(press(' ', { repeat: true })).toBe(false);
    expect(press(' ', { isComposing: true })).toBe(false);
    const handled = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(press('x')).toBe(false);
    expect(s.store.getState().clock.mode).toBe('paused');
  });

  it('ignores keys typed into controls but not on the canvas, and honours the switch', () => {
    const s = setup();
    uninstall = s.uninstall;
    const input = document.createElement('input');
    const button = document.createElement('button');
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    const div = document.createElement('div');
    const link = document.createElement('a');
    div.setAttribute('role', 'tabpanel');
    div.append(link);
    document.body.append(input, button, canvas, div);
    expect(press(' ', {}, input)).toBe(false);
    expect(press(' ', {}, button)).toBe(false);
    expect(press(' ', {}, link)).toBe(false);
    expect(s.store.getState().clock.mode).toBe('paused');
    expect(press(' ', {}, canvas)).toBe(true);
    expect(s.store.getState().clock.mode).toBe('playing');
    expect(press(' ', {}, document.body)).toBe(true);
    expect(s.store.getState().clock.mode).toBe('paused');

    s.store.getState().actions.setUi({ shortcuts: false });
    expect(press(' ')).toBe(false);
    expect(s.store.getState().clock.mode).toBe('paused');
    expect(isInteractiveTarget(null)).toBe(false);
    expect(isInteractiveTarget(input)).toBe(true);
    expect(isInteractiveTarget(canvas)).toBe(false);
  });

  it('leaves the view keys alone while augmented reality runs and keeps the time keys', () => {
    const s = setup();
    uninstall = s.uninstall;
    const { actions } = s.store.getState();
    actions.requestAr();
    actions.setArMode('sensor');
    const before = s.store.getState().view;
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-']) {
      expect(press(key)).toBe(false);
    }
    expect(s.store.getState().view).toBe(before);
    expect(press(' ')).toBe(true);
    expect(s.store.getState().clock.mode).toBe('playing');
  });

  it('exits augmented reality with Escape once the sheet is collapsed', () => {
    const s = setup();
    uninstall = s.uninstall;
    const { actions } = s.store.getState();
    actions.requestAr();
    actions.setArMode('sensor');
    // requestAr collapses the sheet; an expanded sheet is collapsed first and AR stays.
    actions.setUi({ sheet: 'expanded' });
    expect(press('Escape')).toBe(true);
    expect(s.store.getState().ui.sheet).toBe('collapsed');
    expect(s.store.getState().ar.mode).toBe('sensor');
    expect(press('Escape')).toBe(true);
    expect(s.store.getState().ar.mode).toBe('off');
    expect(press('Escape')).toBe(false);
    // A dialog owns Escape even in AR.
    actions.requestAr();
    actions.setArMode('sensor');
    actions.openDialog('about');
    expect(press('Escape')).toBe(false);
    expect(s.store.getState().ar.mode).toBe('sensor');
  });

  it('removes the listener on uninstall', () => {
    const s = setup();
    s.uninstall();
    expect(press(' ')).toBe(false);
    expect(s.store.getState().clock.mode).toBe('paused');
  });
});
