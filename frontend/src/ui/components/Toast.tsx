import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useStore } from 'zustand';

import type { SkyStore } from '../../state/storeTypes';
import type { ToastKey } from '../../state/types';

// The toast region (UX-2 "copy link", plan D110): one permanent `role="status"` live region,
// named so assistive technology can tell it from the other status regions, in which the store's
// `ui.toast` is announced for four seconds. A new `seq` restarts the timer, so the same key shown
// twice is read twice. The text is resolved here by key, so the callers (`showToast`) never touch
// i18next and every key stays a literal for `scripts/check_i18n.mjs`.

export interface ToastProps {
  store: SkyStore;
  /** How long a toast stays visible (milliseconds). */
  durationMs?: number;
}

export const TOAST_DURATION_MS = 4000;

/** The text of a toast key (a literal `t()` call per key, so the gate sees every one). */
export function toastText(t: TFunction, key: ToastKey): string {
  switch (key) {
    case 'share.copied':
      return t('share.copied');
    case 'share.failed':
      return t('share.failed');
    case 'export.failed':
      return t('export.failed');
    case 'details.unknown':
      return t('details.unknown');
    case 'search.minorCapReached':
      return t('search.minorCapReached');
  }
}

/** Complete literal class strings (brief l.550): the empty region takes no room. */
function regionClass(visible: boolean): string {
  return visible
    ? 'pointer-events-auto rounded-lg border border-accent/40 bg-panel-bg px-3 py-2 text-sm text-panel-fg shadow-lg'
    : 'sr-only';
}

export default function Toast({ store, durationMs = TOAST_DURATION_MS }: ToastProps) {
  const { t } = useTranslation();
  const toast = useStore(store, (s) => s.ui.toast);
  const seq = toast?.seq ?? 0;
  // The seq the timer has expired for: the toast is visible while it differs from the current one.
  const [expiredSeq, setExpiredSeq] = useState(0);

  useEffect(() => {
    if (seq === 0) {
      return;
    }
    const id = window.setTimeout(() => {
      setExpiredSeq(seq);
    }, durationMs);
    return () => {
      window.clearTimeout(id);
    };
  }, [seq, durationMs]);

  const visible = toast !== null && expiredSeq !== seq;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t('a11y.notifications')}
      className={regionClass(visible)}
    >
      {visible && toastText(t, toast.key)}
    </div>
  );
}
