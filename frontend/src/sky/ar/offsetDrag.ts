// The AR-3 calibration drag on the WebXR DOM-overlay root (plan D120): in an immersive session the
// canvas receives no pointer events, so the overlay root takes the one-finger horizontal drag and
// nudges `ar.azOffsetDeg` by the rule the camera controller shares (`frames.ts::dragDeltaDeg`:
// one canvas height of drag pans one vertical field of view). Vertical movement is ignored, there
// is no inertia and no tap semantics; the engine applies the offset through its yaw composition
// (plan D130). Babylon-free, store and DOM only (`sky/ar/**`, the lazy AR chunk).

import type { SkyStore } from '../../state/storeTypes';
import { dragDeltaDeg } from '../math/frames';

/**
 * A pointer that goes down on one of the overlay's controls belongs to that control (the exit
 * button, the field slider, the reset button): the drag starts only on the root's own surface.
 */
const INTERACTIVE_SELECTOR =
  'button, input, select, textarea, a[href], [role="slider"], [role="button"]';

/** Attach the drag to `target`; the returned function detaches it (idempotent). */
export function attachOffsetDrag(target: HTMLElement, store: SkyStore): () => void {
  let activeId: number | null = null;
  let lastX = 0;
  const previousTouchAction = target.style.touchAction;
  // Pointer events need the browser's own touch gestures out of the way (as the canvas does).
  target.style.touchAction = 'none';

  const onPointerDown = (event: PointerEvent): void => {
    if (activeId !== null) {
      return;
    }
    if (
      event.target instanceof Element &&
      event.target !== target &&
      event.target.closest(INTERACTIVE_SELECTOR) !== null
    ) {
      return;
    }
    activeId = event.pointerId;
    lastX = event.clientX;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // `NotFoundError` for an inactive pointer, `InvalidStateError` for a detached root, or no
      // capture API at all (jsdom): the drag still works through the root's own listeners.
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== activeId) {
      return;
    }
    const dx = event.clientX - lastX;
    lastX = event.clientX;
    if (dx === 0) {
      return;
    }
    const state = store.getState();
    const height = target.clientHeight || 1;
    state.actions.nudgeArOffset(dragDeltaDeg(dx, state.view.fov, height));
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== activeId) {
      return;
    }
    activeId = null;
    try {
      target.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer is gone or was never captured: nothing to release.
    }
  };

  target.addEventListener('pointerdown', onPointerDown);
  target.addEventListener('pointermove', onPointerMove);
  target.addEventListener('pointerup', onPointerUp);
  target.addEventListener('pointercancel', onPointerUp);
  let detached = false;
  return (): void => {
    if (detached) {
      return;
    }
    detached = true;
    target.removeEventListener('pointerdown', onPointerDown);
    target.removeEventListener('pointermove', onPointerMove);
    target.removeEventListener('pointerup', onPointerUp);
    target.removeEventListener('pointercancel', onPointerUp);
    target.style.touchAction = previousTouchAction;
    activeId = null;
  };
}
