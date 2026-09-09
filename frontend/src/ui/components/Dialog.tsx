import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { cx } from './cx';
import IconButton from './IconButton';

// A modal on the native `<dialog>` (plan D112): `showModal()` runs from an effect keyed on the
// `open` prop, so the browser provides the top layer, the inert background, Escape (the close
// watcher) and the focus return to the opener; the `close` event syncs the store through
// `onClose`. No click handler on the element itself (jsx-a11y allows only key handlers there):
// the close button calls `close()`, which fires the same event. jsdom has no `showModal`; the
// test setup polyfills it (backlog B-65).

export interface DialogProps {
  open: boolean;
  title: string;
  /** Called when the dialog has closed (Escape, the close button, a `close()` call). */
  onClose: () => void;
  children?: ReactNode;
  className?: string;
}

export default function Dialog({ open, title, onClose, children, className }: DialogProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className={cx(
        'm-auto max-h-[90dvh] w-[min(90vw,36rem)] overflow-y-auto overscroll-contain rounded-lg bg-panel-bg p-4 text-panel-fg shadow-lg',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        <IconButton
          icon={X}
          label={t('common.close')}
          onClick={() => {
            ref.current?.close();
          }}
        />
      </div>
      {children}
    </dialog>
  );
}
