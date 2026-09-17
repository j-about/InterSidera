// Pointer, wheel and pinch input of the rotation-only camera (plan D85; VIEW-1, brief l.89,
// l.543). The controller never touches Babylon: it writes the store's `view` at pointer rate and
// the engine applies the camera through its store subscription (plan D80). Inertia after a
// release decays as exp(-dt / 0.25 s) inside the engine tick (`update`) and is skipped entirely
// under `prefers-reduced-motion` (UX-4). A single tap picks the object under the finger through
// the engine (`pick`, INFO-1) and selects it (nothing -> deselect); a double tap or click centres
// the view on the tapped sky direction through `frames.ts` `screenToDirection`. Any pointer
// contact ends follow mode (VIEW-4).
//
// Drag modes (plan D120, AR-3): in `'view'` mode (the default) the gestures above apply. The
// engine switches to `'offset'` mode while the sensor AR mode runs: the horizontal drag then
// calibrates `ar.azOffsetDeg` through `nudgeArOffset(dragDeltaDeg(dx, view.fov, height))` (the
// pose itself comes from the sensors), vertical movement is ignored, inertia is never armed, pinch
// and wheel scale the assumed diagonal camera field (`setArCameraFov`) instead of `view.fov`, a
// single tap still picks and the double tap is inert.

import type { SkyStore } from '../../state/storeTypes';
import {
  clampCameraAltDeg,
  clampFovDeg,
  dragDeltaDeg,
  screenToDirection,
  wrapAzimuthDeg,
} from '../math/frames';
import type { AltAz } from '../math/frames';

/** Inertia time constant, seconds. */
const INERTIA_TAU_S = 0.25;
/** Below this angular speed (degrees per second) the inertia stops. */
const INERTIA_STOP_DEG_S = 0.05;
/** A release within this delay after the last move keeps the drag velocity. */
const INERTIA_MAX_GAP_MS = 120;
/** Fingers or the mouse may wander this far (CSS px) and still count as a tap. */
const TAP_SLOP_PX = 8;
const TAP_MAX_MS = 300;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_DISTANCE_PX = 30;
/** Wheel deltas in lines or pages are converted to pixels before the 1.1^(dy/100) rule. */
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 400;
const WHEEL_ZOOM_BASE = 1.1;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

interface PointerPoint {
  x: number;
  y: number;
}

/** The engine's picker: canvas CSS pixels -> object id in the `sel` syntax, or `null`. */
export type PickFn = (xCss: number, yCss: number) => string | null;

/** `'view'` writes `view` (the default); `'offset'` calibrates the AR azimuth offset (plan D120). */
export type DragMode = 'view' | 'offset';

export class CameraController {
  private readonly canvas: HTMLCanvasElement;
  private readonly store: SkyStore;
  private readonly pick: PickFn;
  private readonly pointers = new Map<number, PointerPoint>();
  private readonly previousTouchAction: string;
  private readonly altAz: AltAz = { alt: 0, az: 0 };
  private readonly motionQuery: MediaQueryList | null;
  private reduced = false;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private lastMoveMs = 0;
  private downX = 0;
  private downY = 0;
  private downMs = 0;
  private moved = false;
  private velocityAz = 0;
  private velocityAlt = 0;
  private inertia = false;
  private inertiaMs = 0;
  private pinchStartDistance = 0;
  private pinchStartFov = 0;
  private lastTapMs = -Infinity;
  private lastTapX = 0;
  private lastTapY = 0;
  private dragMode: DragMode = 'view';

  constructor(canvas: HTMLCanvasElement, store: SkyStore, pick: PickFn) {
    this.canvas = canvas;
    this.store = store;
    this.pick = pick;
    // Pointer events need the browser's own touch gestures out of the way.
    this.previousTouchAction = canvas.style.touchAction;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    // `prefers-reduced-motion` (UX-4): no inertia glide; followed live through `change`.
    this.motionQuery =
      typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION_QUERY) : null;
    this.reduced = this.motionQuery?.matches ?? false;
    this.motionQuery?.addEventListener('change', this.onMotionChange);
  }

  /** `prefers-reduced-motion: reduce` as the page sees it (the debug hook reports it). */
  get reducedMotion(): boolean {
    return this.reduced;
  }

  /**
   * Switch between the view drag and the AR calibration drag (plan D120); the engine calls it
   * from its `ar.mode` subscription (`'sensor'` -> `'offset'`, else `'view'`). A glide in progress
   * stops: an offset has no inertia and a returning view starts still.
   */
  setDragMode(mode: DragMode): void {
    if (mode === this.dragMode) {
      return;
    }
    this.dragMode = mode;
    this.inertia = false;
  }

  /** Inertia step, called once per engine tick with the wall clock. */
  update(nowMs: number): void {
    if (!this.inertia) {
      return;
    }
    const dt = (nowMs - this.inertiaMs) / 1000;
    this.inertiaMs = nowMs;
    if (dt <= 0) {
      return;
    }
    // Exact integral of an exponentially decaying velocity over the step.
    const decay = Math.exp(-dt / INERTIA_TAU_S);
    const travel = INERTIA_TAU_S * (1 - decay);
    const view = this.store.getState().view;
    this.store.getState().actions.setView({
      az: wrapAzimuthDeg(view.az + this.velocityAz * travel),
      alt: clampCameraAltDeg(view.alt + this.velocityAlt * travel),
    });
    this.velocityAz *= decay;
    this.velocityAlt *= decay;
    if (Math.hypot(this.velocityAz, this.velocityAlt) < INERTIA_STOP_DEG_S) {
      this.inertia = false;
    }
  }

  dispose(): void {
    const { canvas } = this;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerUp);
    canvas.removeEventListener('wheel', this.onWheel);
    this.motionQuery?.removeEventListener('change', this.onMotionChange);
    canvas.style.touchAction = this.previousTouchAction;
    this.pointers.clear();
    this.inertia = false;
  }

  private readonly onMotionChange = (event: MediaQueryListEvent): void => {
    this.reduced = event.matches;
    if (this.reduced) {
      this.inertia = false;
    }
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    const nowMs = Date.now();
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // `NotFoundError` for a pointer that is no longer active (a synthetic event, a pointer
      // released between events) or `InvalidStateError` for a detached canvas: the drag still
      // works through the canvas listeners, capture only keeps it alive outside the canvas.
    }
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.inertia = false;
    if (this.pointers.size === 1) {
      this.dragging = true;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      this.lastMoveMs = nowMs;
      this.downX = event.clientX;
      this.downY = event.clientY;
      this.downMs = nowMs;
      this.moved = false;
      this.velocityAz = 0;
      this.velocityAlt = 0;
    } else if (this.pointers.size === 2) {
      this.dragging = false;
      this.moved = true;
      this.endFollow();
      this.pinchStartDistance = this.pointerDistance();
      const state = this.store.getState();
      // In offset mode the pinch scales the assumed diagonal camera field (AR-2), not `view.fov`.
      this.pinchStartFov = this.dragMode === 'offset' ? state.ar.cameraFovDeg : state.view.fov;
    }
    event.preventDefault();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const point = this.pointers.get(event.pointerId);
    if (point === undefined) {
      return;
    }
    point.x = event.clientX;
    point.y = event.clientY;
    if (this.pointers.size >= 2) {
      const distance = this.pointerDistance();
      if (distance > 0 && this.pinchStartDistance > 0) {
        const scaled = (this.pinchStartFov * this.pinchStartDistance) / distance;
        const { actions } = this.store.getState();
        if (this.dragMode === 'offset') {
          actions.setArCameraFov(scaled);
        } else {
          actions.setView({ fov: clampFovDeg(scaled) });
        }
      }
      return;
    }
    if (!this.dragging) {
      return;
    }
    const nowMs = Date.now();
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    if (
      !this.moved &&
      (Math.abs(event.clientX - this.downX) > TAP_SLOP_PX ||
        Math.abs(event.clientY - this.downY) > TAP_SLOP_PX)
    ) {
      // A drag takes the camera back from follow mode (VIEW-4, plan D106); a tap keeps it, so
      // tapping another object follows that one instead.
      this.moved = true;
      this.endFollow();
    }
    const height = this.canvas.clientHeight > 0 ? this.canvas.clientHeight : 1;
    const state = this.store.getState();
    const { view } = state;
    if (this.dragMode === 'offset') {
      // AR-3 calibration: the horizontal drag turns the sky against the camera video by the same
      // rule as the view drag; vertical movement is ignored and no velocity is kept (no inertia).
      if (dx !== 0) {
        state.actions.nudgeArOffset(dragDeltaDeg(dx, view.fov, height));
      }
      return;
    }
    // Drag: one full height of the canvas pans the vertical field of view (VIEW-1).
    const dAz = (-dx * view.fov) / height;
    const dAlt = (dy * view.fov) / height;
    state.actions.setView({
      az: wrapAzimuthDeg(view.az + dAz),
      alt: clampCameraAltDeg(view.alt + dAlt),
    });
    const dt = (nowMs - this.lastMoveMs) / 1000;
    if (dt > 0) {
      // Light smoothing so a jittery last event does not decide the whole glide.
      this.velocityAz = 0.5 * this.velocityAz + 0.5 * (dAz / dt);
      this.velocityAlt = 0.5 * this.velocityAlt + 0.5 * (dAlt / dt);
      this.lastMoveMs = nowMs;
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const nowMs = Date.now();
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    const known = this.pointers.delete(event.pointerId);
    if (!known) {
      return;
    }
    if (this.pointers.size === 1) {
      // Back from a pinch to a one-finger drag: continue from the remaining pointer.
      for (const point of this.pointers.values()) {
        this.lastX = point.x;
        this.lastY = point.y;
      }
      this.lastMoveMs = nowMs;
      this.dragging = true;
      this.moved = true;
      return;
    }
    if (this.pointers.size > 0) {
      return;
    }
    const wasDragging = this.dragging;
    this.dragging = false;
    if (!wasDragging) {
      return;
    }
    if (!this.moved && nowMs - this.downMs <= TAP_MAX_MS && event.type === 'pointerup') {
      this.onTap(event.clientX, event.clientY, nowMs);
      return;
    }
    if (
      this.dragMode === 'view' &&
      !this.reduced &&
      this.moved &&
      nowMs - this.lastMoveMs <= INERTIA_MAX_GAP_MS &&
      Math.hypot(this.velocityAz, this.velocityAlt) >= INERTIA_STOP_DEG_S
    ) {
      this.inertia = true;
      this.inertiaMs = nowMs;
    }
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    let deltaPx = event.deltaY;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      deltaPx *= WHEEL_LINE_PX;
    } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      deltaPx *= WHEEL_PAGE_PX;
    }
    const state = this.store.getState();
    const factor = Math.pow(WHEEL_ZOOM_BASE, deltaPx / 100);
    if (this.dragMode === 'offset') {
      state.actions.setArCameraFov(state.ar.cameraFovDeg * factor);
      return;
    }
    state.actions.setView({ fov: clampFovDeg(state.view.fov * factor) });
  };

  /**
   * A single tap picks and selects the object under it (INFO-1); a second tap within 350 ms and
   * 30 px centres the view on the tapped direction (the first tap's selection stands). In offset
   * mode every tap is a single tap: the sensors own the view (plan D120).
   */
  private onTap(clientX: number, clientY: number, nowMs: number): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const isDouble =
      this.dragMode === 'view' &&
      nowMs - this.lastTapMs <= DOUBLE_TAP_MS &&
      Math.hypot(clientX - this.lastTapX, clientY - this.lastTapY) <= DOUBLE_TAP_DISTANCE_PX;
    const state = this.store.getState();
    if (!isDouble) {
      this.lastTapMs = nowMs;
      this.lastTapX = clientX;
      this.lastTapY = clientY;
      const id = this.pick(clientX - rect.left, clientY - rect.top);
      if (id !== state.selection) {
        state.actions.select(id);
      }
      return;
    }
    this.lastTapMs = -Infinity;
    // A deliberate camera move: the follow would undo it at the next overlay tick.
    this.endFollow();
    const { view } = state;
    screenToDirection(
      this.altAz,
      clientX - rect.left,
      clientY - rect.top,
      rect.width,
      rect.height,
      view.fov,
      view.az,
      view.alt,
      state.ar.roll,
    );
    state.actions.setView({ az: this.altAz.az, alt: clampCameraAltDeg(this.altAz.alt) });
  }

  /** Drag, pinch and double tap end follow mode (VIEW-4, plan D106); a single tap keeps it. */
  private endFollow(): void {
    const state = this.store.getState();
    if (state.follow) {
      state.actions.setFollow(false);
    }
  }

  private pointerDistance(): number {
    let first: PointerPoint | null = null;
    for (const point of this.pointers.values()) {
      if (first === null) {
        first = point;
      } else {
        return Math.hypot(point.x - first.x, point.y - first.y);
      }
    }
    return 0;
  }
}
