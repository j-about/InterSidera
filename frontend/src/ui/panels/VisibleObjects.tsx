import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { SkyStore } from '../../state/storeTypes';

// The visible objects as text (UX-4 l.248, plan D105): the labels the engine currently draws
// (`labels.visible`, published at <= 1 Hz on change), with the selection marked in words. The
// heading carries the count; the list is plain text, so a screen reader can walk the sky.

export interface VisibleObjectsProps {
  store: SkyStore;
}

export default function VisibleObjects({ store }: VisibleObjectsProps) {
  const { t } = useTranslation();
  const { visible, selection } = useStore(
    store,
    useShallow((s) => ({ visible: s.labels.visible, selection: s.selection })),
  );
  const headingId = 'visible-objects-title';
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h4 id={headingId} className="text-sm font-semibold">
        {visible.length === 0
          ? t('a11y.visibleNone')
          : t('a11y.visibleObjects', { count: visible.length })}
      </h4>
      {visible.length > 0 && (
        <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
          {visible.map((label) => {
            const selected = label.kind === 'selected' || label.id === selection;
            return (
              <li key={`${label.kind}:${label.id}`} className={selected ? 'text-panel-fg' : ''}>
                {label.text}
                {selected && ` (${t('a11y.selected')})`}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
