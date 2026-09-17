// The calibration drag on the XR overlay root (plan D120) with a real store and jsdom pointer
// events: horizontal movement nudges `ar.azOffsetDeg` by `dragDeltaDeg`, vertical movement and
// the controls' own pointers do nothing, no inertia, the detach function removes everything.

import { createSkyStore } from '../../state/store';
import { dragDeltaDeg } from '../math/frames';
import { attachOffsetDrag } from './offsetDrag';

function pointer(type: string, pointerId: number, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    pointerId,
    clientX: x,
    clientY: y,
    bubbles: true,
    pointerType: 'touch',
  });
}

function overlay(height: number): HTMLElement {
  const root = document.createElement('div');
  Object.defineProperty(root, 'clientHeight', { value: height, configurable: true });
  document.body.appendChild(root);
  return root;
}

function arStore(): ReturnType<typeof createSkyStore> {
  const store = createSkyStore();
  store.getState().actions.requestAr();
  store.getState().actions.setArMode('sensor');
  return store;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('attachOffsetDrag', () => {
  it('nudges the offset by dragDeltaDeg per horizontal move and ignores vertical movement', () => {
    const root = overlay(600);
    const store = arStore();
    const detach = attachOffsetDrag(root, store);
    const { fov } = store.getState().view;
    const viewBefore = store.getState().view;
    root.dispatchEvent(pointer('pointerdown', 1, 100, 300));
    root.dispatchEvent(pointer('pointermove', 1, 160, 300));
    expect(store.getState().ar.azOffsetDeg).toBeCloseTo(dragDeltaDeg(60, fov, 600), 12);
    root.dispatchEvent(pointer('pointermove', 1, 160, 420));
    expect(store.getState().ar.azOffsetDeg).toBeCloseTo(dragDeltaDeg(60, fov, 600), 12);
    root.dispatchEvent(pointer('pointermove', 1, 130, 420));
    expect(store.getState().ar.azOffsetDeg).toBeCloseTo(dragDeltaDeg(30, fov, 600), 12);
    root.dispatchEvent(pointer('pointerup', 1, 130, 420));
    // No inertia, no view write: the view is the store's business through setArPose.
    expect(store.getState().view).toBe(viewBefore);
    expect(root.style.touchAction).toBe('none');
    detach();
    expect(root.style.touchAction).toBe('');
    root.dispatchEvent(pointer('pointerdown', 2, 100, 300));
    root.dispatchEvent(pointer('pointermove', 2, 200, 300));
    expect(store.getState().ar.azOffsetDeg).toBeCloseTo(dragDeltaDeg(30, fov, 600), 12);
    detach();
  });

  it('tracks one pointer at a time and treats pointercancel as a release', () => {
    const root = overlay(400);
    const store = arStore();
    attachOffsetDrag(root, store);
    const { fov } = store.getState().view;
    root.dispatchEvent(pointer('pointerdown', 1, 0, 0));
    root.dispatchEvent(pointer('pointerdown', 2, 500, 0));
    root.dispatchEvent(pointer('pointermove', 2, 700, 0));
    expect(store.getState().ar.azOffsetDeg).toBe(0);
    root.dispatchEvent(pointer('pointermove', 1, 40, 0));
    expect(store.getState().ar.azOffsetDeg).toBeCloseTo(dragDeltaDeg(40, fov, 400), 12);
    root.dispatchEvent(pointer('pointercancel', 1, 40, 0));
    root.dispatchEvent(pointer('pointermove', 1, 80, 0));
    expect(store.getState().ar.azOffsetDeg).toBeCloseTo(dragDeltaDeg(40, fov, 400), 12);
    // A stray release of an unknown pointer changes nothing.
    root.dispatchEvent(pointer('pointerup', 7, 0, 0));
    root.dispatchEvent(pointer('pointerdown', 3, 0, 0));
    root.dispatchEvent(pointer('pointermove', 3, -40, 0));
    expect(store.getState().ar.azOffsetDeg).toBeCloseTo(0, 12);
  });

  it('leaves a pointer that starts on a control to that control', () => {
    const root = overlay(400);
    const button = document.createElement('button');
    const slider = document.createElement('input');
    slider.type = 'range';
    const label = document.createElement('span');
    root.append(button, slider, label);
    const store = arStore();
    attachOffsetDrag(root, store);
    const { fov } = store.getState().view;
    for (const control of [button, slider]) {
      control.dispatchEvent(pointer('pointerdown', 1, 0, 0));
      root.dispatchEvent(pointer('pointermove', 1, 50, 0));
      root.dispatchEvent(pointer('pointerup', 1, 50, 0));
      expect(store.getState().ar.azOffsetDeg).toBe(0);
    }
    // Plain text inside the root is part of the drag surface.
    label.dispatchEvent(pointer('pointerdown', 1, 0, 0));
    root.dispatchEvent(pointer('pointermove', 1, 50, 0));
    expect(store.getState().ar.azOffsetDeg).toBeCloseTo(dragDeltaDeg(50, fov, 400), 12);
  });

  it('uses one pixel for an unknown height and wraps through the store', () => {
    const root = overlay(0);
    const store = arStore();
    attachOffsetDrag(root, store);
    const { fov } = store.getState().view;
    root.dispatchEvent(pointer('pointerdown', 1, 0, 0));
    root.dispatchEvent(pointer('pointermove', 1, 1, 0));
    // One pixel over a one-pixel height is one field of view, wrapped into [-180, 180).
    expect(store.getState().ar.azOffsetDeg).toBeCloseTo(dragDeltaDeg(1, fov, 1), 12);
    root.dispatchEvent(pointer('pointermove', 1, -5, 0));
    expect(store.getState().ar.azOffsetDeg).toBeGreaterThanOrEqual(-180);
    expect(store.getState().ar.azOffsetDeg).toBeLessThan(180);
  });
});
