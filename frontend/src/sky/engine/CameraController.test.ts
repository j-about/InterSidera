// The camera controller's drag modes (plan D85, D120) with a fake canvas under jsdom: the view
// drag, pinch, wheel, tap and double tap as at M4, and the AR `'offset'` mode in which the drag
// nudges `ar.azOffsetDeg`, pinch and wheel scale the diagonal camera field, the double tap is
// inert and inertia never arms. Babylon never runs here: the controller only writes the store.

import { createSkyStore } from '../../state/store';
import { dragDeltaDeg } from '../math/frames';
import { CameraController } from './CameraController';

const WIDTH = 400;
const HEIGHT = 600;
const T0 = 1_700_000_000_000;

function fakeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: WIDTH });
  Object.defineProperty(canvas, 'clientHeight', { value: HEIGHT });
  canvas.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: WIDTH,
    height: HEIGHT,
    right: WIDTH,
    bottom: HEIGHT,
    toJSON: () => ({}),
  });
  // jsdom has no pointer capture: `setPointerCapture` stays missing (the controller guards it),
  // the release pair is answered as "not captured".
  Object.defineProperty(canvas, 'hasPointerCapture', { value: () => false });
  Object.defineProperty(canvas, 'releasePointerCapture', { value: () => undefined });
  document.body.appendChild(canvas);
  return canvas;
}

function pointer(type: string, pointerId: number, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    pointerId,
    clientX: x,
    clientY: y,
    bubbles: true,
    pointerType: 'touch',
  });
}

function wheel(deltaY: number, deltaMode: number = WheelEvent.DOM_DELTA_PIXEL): WheelEvent {
  return new WheelEvent('wheel', { deltaY, deltaMode, cancelable: true });
}

interface Harness {
  canvas: HTMLCanvasElement;
  store: ReturnType<typeof createSkyStore>;
  controller: CameraController;
  picks: [number, number][];
}

function harness(pickResult: string | null = null): Harness {
  const canvas = fakeCanvas();
  const store = createSkyStore({ az: 100, alt: 20, fov: 60 }, T0);
  const picks: [number, number][] = [];
  const controller = new CameraController(canvas, store, (x, y) => {
    picks.push([x, y]);
    return pickResult;
  });
  return { canvas, store, controller, picks };
}

function enterSensorAr(store: Harness['store']): void {
  store.getState().actions.requestAr();
  store.getState().actions.setArMode('sensor');
  expect(store.getState().ar.mode).toBe('sensor');
}

let now = T0;

beforeEach(() => {
  now = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('view mode (default)', () => {
  it('drags the view by one field per canvas height and arms inertia on a quick release', () => {
    const { canvas, store, controller } = harness();
    canvas.dispatchEvent(pointer('pointerdown', 1, 100, 300));
    now += 16;
    canvas.dispatchEvent(pointer('pointermove', 1, 160, 330));
    const { view } = store.getState();
    expect(view.az).toBeCloseTo(100 + dragDeltaDeg(60, 60, HEIGHT), 12);
    expect(view.alt).toBeCloseTo(20 + (30 * 60) / HEIGHT, 12);
    expect(store.getState().ar.azOffsetDeg).toBe(0);
    now += 4;
    canvas.dispatchEvent(pointer('pointerup', 1, 160, 330));
    now += 100;
    controller.update(now);
    expect(store.getState().view.az).not.toBeCloseTo(view.az, 6);
    controller.dispose();
  });

  it('pinches and wheels view.fov, picks on a tap and centres on a double tap', () => {
    const { canvas, store, controller, picks } = harness('hip:11767');
    canvas.dispatchEvent(pointer('pointerdown', 1, 100, 300));
    canvas.dispatchEvent(pointer('pointerdown', 2, 100, 500));
    canvas.dispatchEvent(pointer('pointermove', 2, 100, 450));
    expect(store.getState().view.fov).toBeCloseTo((60 * 200) / 150, 12);
    expect(store.getState().ar.cameraFovDeg).toBe(73);
    canvas.dispatchEvent(pointer('pointerup', 2, 100, 450));
    canvas.dispatchEvent(pointer('pointerup', 1, 100, 300));
    canvas.dispatchEvent(wheel(100));
    expect(store.getState().view.fov).toBeCloseTo(((60 * 200) / 150) * 1.1, 12);

    const before = store.getState().view;
    canvas.dispatchEvent(pointer('pointerdown', 3, 200, 100));
    canvas.dispatchEvent(pointer('pointerup', 3, 200, 100));
    expect(picks).toEqual([[200, 100]]);
    expect(store.getState().selection).toBe('hip:11767');
    expect(store.getState().view).toBe(before);
    now += 100;
    canvas.dispatchEvent(pointer('pointerdown', 4, 202, 101));
    canvas.dispatchEvent(pointer('pointerup', 4, 202, 101));
    expect(picks).toHaveLength(1);
    // The double tap centres the view on the tapped direction (above the centre: alt grows).
    expect(store.getState().view.alt).toBeGreaterThan(before.alt);
    controller.dispose();
  });
});

describe('offset mode (AR-3 calibration, plan D120)', () => {
  it('nudges ar.azOffsetDeg by dragDeltaDeg, ignores vertical movement and never glides', () => {
    const { canvas, store, controller } = harness();
    enterSensorAr(store);
    controller.setDragMode('offset');
    controller.setDragMode('offset');
    const viewBefore = store.getState().view;
    canvas.dispatchEvent(pointer('pointerdown', 1, 100, 300));
    now += 16;
    canvas.dispatchEvent(pointer('pointermove', 1, 160, 300));
    expect(store.getState().ar.azOffsetDeg).toBeCloseTo(dragDeltaDeg(60, 60, HEIGHT), 12);
    expect(store.getState().view).toBe(viewBefore);
    const arAfterHorizontal = store.getState().ar;
    now += 16;
    canvas.dispatchEvent(pointer('pointermove', 1, 160, 420));
    // A purely vertical move writes nothing at all.
    expect(store.getState().ar).toBe(arAfterHorizontal);
    now += 4;
    canvas.dispatchEvent(pointer('pointerup', 1, 160, 420));
    now += 100;
    controller.update(now);
    expect(store.getState().view).toBe(viewBefore);
    expect(store.getState().ar.azOffsetDeg).toBeCloseTo(dragDeltaDeg(60, 60, HEIGHT), 12);
    controller.dispose();
  });

  it('scales the diagonal camera field with a pinch and the wheel, leaving view.fov', () => {
    const { canvas, store, controller } = harness();
    enterSensorAr(store);
    controller.setDragMode('offset');
    canvas.dispatchEvent(pointer('pointerdown', 1, 100, 300));
    canvas.dispatchEvent(pointer('pointerdown', 2, 100, 500));
    canvas.dispatchEvent(pointer('pointermove', 2, 100, 550));
    expect(store.getState().ar.cameraFovDeg).toBeCloseTo((73 * 200) / 250, 12);
    expect(store.getState().view.fov).toBe(60);
    // A pinch out past the range is clamped by the store ([50, 110]).
    canvas.dispatchEvent(pointer('pointermove', 2, 100, 400));
    expect(store.getState().ar.cameraFovDeg).toBe(110);
    canvas.dispatchEvent(pointer('pointerup', 2, 100, 400));
    canvas.dispatchEvent(pointer('pointerup', 1, 100, 300));
    store.getState().actions.setArCameraFov(73);
    canvas.dispatchEvent(wheel(100));
    expect(store.getState().ar.cameraFovDeg).toBeCloseTo(73 * 1.1, 12);
    canvas.dispatchEvent(wheel(-1, WheelEvent.DOM_DELTA_LINE));
    expect(store.getState().ar.cameraFovDeg).toBeCloseTo(73 * 1.1 * Math.pow(1.1, -0.16), 12);
    expect(store.getState().view.fov).toBe(60);
    controller.dispose();
  });

  it('still picks on a tap while the double tap is inert', () => {
    const { canvas, store, controller, picks } = harness('planet:mars');
    enterSensorAr(store);
    controller.setDragMode('offset');
    const before = store.getState().view;
    canvas.dispatchEvent(pointer('pointerdown', 1, 200, 100));
    canvas.dispatchEvent(pointer('pointerup', 1, 200, 100));
    expect(store.getState().selection).toBe('planet:mars');
    now += 100;
    canvas.dispatchEvent(pointer('pointerdown', 2, 202, 101));
    canvas.dispatchEvent(pointer('pointerup', 2, 202, 101));
    expect(picks).toHaveLength(2);
    expect(store.getState().view).toBe(before);
    controller.dispose();
  });

  it('stops a glide in progress when the mode changes', () => {
    const { canvas, store, controller } = harness();
    // A quick release in view mode arms the inertia (as the view-mode case proves)...
    canvas.dispatchEvent(pointer('pointerdown', 1, 100, 300));
    now += 16;
    canvas.dispatchEvent(pointer('pointermove', 1, 160, 330));
    now += 4;
    canvas.dispatchEvent(pointer('pointerup', 1, 160, 330));
    const released = store.getState().view;
    // ...and the switch to offset mode drops it: the next ticks write nothing.
    enterSensorAr(store);
    controller.setDragMode('offset');
    now += 100;
    controller.update(now);
    now += 100;
    controller.update(now);
    expect(store.getState().view).toBe(released);
    expect(store.getState().ar.azOffsetDeg).toBe(0);
    controller.dispose();
  });

  it('returns to the view drag when the mode is switched back', () => {
    const { canvas, store, controller } = harness();
    enterSensorAr(store);
    controller.setDragMode('offset');
    controller.setDragMode('view');
    canvas.dispatchEvent(pointer('pointerdown', 1, 100, 300));
    canvas.dispatchEvent(pointer('pointermove', 1, 130, 300));
    expect(store.getState().view.az).toBeCloseTo(100 + dragDeltaDeg(30, 60, HEIGHT), 12);
    expect(store.getState().ar.azOffsetDeg).toBe(0);
    controller.dispose();
  });
});
