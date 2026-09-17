import type { SkyStore } from '../state/storeTypes';
import { DEFAULT_SPEEDS, nextSpeed, speedList, stepDeltaOf } from '../state/timeDisplay';

// Keyboard shortcuts (TIME-5, brief l.205, l.89; plan D99): one `keydown` listener installed by
// `App`. Time: Space plays or pauses (resuming `ui.lastSpeed`, the speed the store saw running
// last, the same memory the Play button uses), `,` and `.` move one index in the signed speed
// list (from a pause: the first backward or forward speed), `[` and `]` step by `ui.stepUnit`,
// `n` goes live, `t` opens the date-and-time editor. View: the arrows pan by a tenth of the
// field of view, `+`/`=` and `-` zoom by 1.25 (the store clamps the field); while augmented
// reality runs (plan D124) the view keys are inert: the sensors own the direction and the camera
// model owns the field. Escape collapses the sheet and keeps the chosen tab (on the desktop
// layout the column stays: `closePanel` would send the tabs back to the default one), and with
// the sheet collapsed leaves augmented reality (plan D127: one home for the key; the dialog and
// the sheet own it first); while a dialog is open the listener bails and the
// native `<dialog>` cancel handles Escape (`Dialog.tsx` `onClose` -> `closeDialog`), so the
// dialog is closed exactly once. Ignored while the event is already
// handled or carries a modifier, during IME composition, on key repeat, while a dialog is open,
// while the user turned the shortcuts off (WCAG 2.2 SC 2.1.4) and whenever the focus sits on an
// interactive element, the canvas excepted, so typing in a field never moves the clock.

/** Focused ancestors that own their keys; the canvas is the one interactive target that does not. */
const INTERACTIVE = 'button, a, [role], input, select, textarea, [contenteditable], [tabindex]';

/** What the listener needs from `window` (tests pass a fake). */
export type ShortcutTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/** `true` when the event target (or an ancestor) is an interactive control other than the canvas. */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || target instanceof HTMLCanvasElement) {
    return false;
  }
  const hit = target.closest(INTERACTIVE);
  return hit !== null && !(hit instanceof HTMLCanvasElement);
}

export function installShortcuts(store: SkyStore, target: ShortcutTarget = window): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.isComposing ||
      event.repeat ||
      isInteractiveTarget(event.target)
    ) {
      return;
    }
    const state = store.getState();
    const { actions, clock, view, ui, ar } = state;
    if (ui.dialog !== null || !ui.shortcuts) {
      return;
    }
    const list = speedList(state.meta?.limits.speeds ?? DEFAULT_SPEEDS);
    const current = clock.mode === 'live' ? 1 : clock.mode === 'paused' ? 0 : clock.speed;
    const pan = view.fov / 10;
    const inAr = ar.mode !== 'off';
    switch (event.key) {
      case ' ':
        if (clock.mode === 'paused') {
          actions.play(ui.lastSpeed);
        } else {
          actions.pause();
        }
        break;
      case ',':
        actions.play(nextSpeed(list, current, -1));
        break;
      case '.':
        actions.play(nextSpeed(list, current, 1));
        break;
      case '[':
        actions.stepTime(stepDeltaOf(ui.stepUnit, -1));
        break;
      case ']':
        actions.stepTime(stepDeltaOf(ui.stepUnit, 1));
        break;
      case 'n':
        actions.live();
        break;
      case 't':
        actions.openDialog('timeEditor');
        break;
      case 'ArrowLeft':
        if (inAr) {
          return;
        }
        actions.setView({ az: view.az - pan });
        break;
      case 'ArrowRight':
        if (inAr) {
          return;
        }
        actions.setView({ az: view.az + pan });
        break;
      case 'ArrowUp':
        if (inAr) {
          return;
        }
        actions.setView({ alt: view.alt + pan });
        break;
      case 'ArrowDown':
        if (inAr) {
          return;
        }
        actions.setView({ alt: view.alt - pan });
        break;
      case '+':
      case '=':
        if (inAr) {
          return;
        }
        actions.setView({ fov: view.fov / 1.25 });
        break;
      case '-':
        if (inAr) {
          return;
        }
        actions.setView({ fov: view.fov * 1.25 });
        break;
      case 'Escape':
        if (ui.sheet !== 'collapsed') {
          actions.setUi({ sheet: 'collapsed' });
          break;
        }
        if (inAr) {
          actions.exitAr();
          break;
        }
        return;
      default:
        return;
    }
    event.preventDefault();
  };

  target.addEventListener('keydown', onKeyDown);
  return () => {
    target.removeEventListener('keydown', onKeyDown);
  };
}
