import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { SkyStore } from '../../state/storeTypes';

// The skip link (UX-4, plan D112): the first focusable element of the page, visually hidden until
// focused, moving the focus into the control panel (`#panel`, which carries `tabIndex={-1}` for
// that purpose). The click is handled in script so the URL hash stays untouched: the hash carries
// the dev/e2e engine override and the URL synchroniser preserves it verbatim (plan D79). On the
// phone the sheet is expanded first, so the panel the focus lands in is visible.

export interface SkipLinkProps {
  store: SkyStore;
  /** Id of the panel element (default `panel`). */
  target?: string;
}

export default function SkipLink({ store, target = 'panel' }: SkipLinkProps) {
  const { t } = useTranslation();
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    store.getState().actions.setUi({ sheet: 'expanded' });
    document.getElementById(target)?.focus();
  };
  return (
    <a
      href={`#${target}`}
      onClick={onClick}
      className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-panel-bg focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-panel-fg"
    >
      {t('shell.skipToPanel')}
    </a>
  );
}
