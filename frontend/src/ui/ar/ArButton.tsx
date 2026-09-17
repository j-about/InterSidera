import { ScanEye } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';

import { arButtonVisible } from '../../state/arCapabilities';
import { requestOrientationPermission } from '../../state/arPermission';
import type { SkyStore } from '../../state/storeTypes';
import type { ArPermission } from '../../state/types';
import IconButton from '../components/IconButton';

// The AR button (AR-1, brief l.237, l.579; plan D125-D127), mounted in the top bar and rendered
// only while the AR-1 gate holds (`arButtonVisible`: every probed capability and an observer on
// Earth); hidden means not rendered, no message. The click handler is the one place the motion
// permission is asked (plan D126): `DeviceOrientationEvent.requestPermission()` must run
// synchronously inside the tap (WebKit refuses it after an `await`), so the handler writes
// `pending` first (a previous session's outcome is never reused), calls the helper, then enters
// AR with `requestAr()`; the outcome lands in `ar.permission` when the promise settles and the
// lazily loaded controller waits for it. Each tap owns its outcome: a slow promise from an
// earlier tap (exited meanwhile) must never overwrite the `pending` a fresh tap wrote, since the
// controller of that fresh session waits on it; a rejecting helper records `prompt` (the default
// helper never rejects, plan D126). The button lives in the eager bundle (backlog B-75): the
// gesture window must not span a chunk download. It carries `AR_BUTTON_ID` so the shell can hand
// the focus back to it when the overlay that replaced the top bar unmounts (`focusArButton`).

export const AR_BUTTON_ID = 'ar-button';

/** Move the focus back to the AR button after an AR session (plan D127); a no-op when absent. */
export function focusArButton(): void {
  document.getElementById(AR_BUTTON_ID)?.focus();
}

export interface ArButtonProps {
  store: SkyStore;
  /** Replaces `requestOrientationPermission` (tests). */
  requestPermission?: () => Promise<ArPermission>;
}

export default function ArButton({
  store,
  requestPermission = requestOrientationPermission,
}: ArButtonProps) {
  const { t } = useTranslation();
  const visible = useStore(store, arButtonVisible);
  /** The tap counter: the outcome of tap N is written only while N is still the latest tap. */
  const tapSeq = useRef(0);
  if (!visible) {
    return null;
  }
  const { actions } = store.getState();
  return (
    <IconButton
      id={AR_BUTTON_ID}
      icon={ScanEye}
      label={t('ar.button')}
      onClick={() => {
        tapSeq.current += 1;
        const seq = tapSeq.current;
        actions.setArPermission('pending');
        // Synchronous inside the gesture: no await before this call (plan D126, R75).
        const outcome = requestPermission();
        actions.requestAr();
        const settle = (permission: ArPermission): void => {
          if (seq === tapSeq.current) {
            actions.setArPermission(permission);
          }
        };
        void outcome.then(settle, () => {
          settle('prompt');
        });
      }}
    />
  );
}
