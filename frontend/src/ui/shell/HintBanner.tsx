import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';

import type { SkyStore } from '../../state/storeTypes';
import Banner from '../components/Banner';
import Button from '../components/Button';

// The first-visit hint (UX-5 [S], plan D112): shown on every load (nothing is persisted, OBS-8)
// until the user dismisses it or first touches the sky. The dismissal lives in `ui.hintDismissed`
// for the session only.

export interface HintBannerProps {
  store: SkyStore;
  /** Id of the element whose first `pointerdown` dismisses the hint (default `sky-stage`). */
  stageId?: string;
}

export default function HintBanner({ store, stageId = 'sky-stage' }: HintBannerProps) {
  const { t } = useTranslation();
  const dismissed = useStore(store, (s) => s.ui.hintDismissed);
  const { actions } = store.getState();

  useEffect(() => {
    if (dismissed) {
      return;
    }
    const stage = document.getElementById(stageId);
    if (stage === null) {
      return;
    }
    const onPointerDown = (): void => {
      actions.dismissHint();
    };
    stage.addEventListener('pointerdown', onPointerDown, { once: true, passive: true });
    return () => {
      stage.removeEventListener('pointerdown', onPointerDown);
    };
  }, [dismissed, stageId, actions]);

  if (dismissed) {
    return null;
  }
  return (
    <Banner
      kind="status"
      title={t('hint.title')}
      actions={
        <Button
          variant="outline"
          onClick={() => {
            actions.dismissHint();
          }}
        >
          {t('hint.dismiss')}
        </Button>
      }
    >
      {t('hint.text')}
    </Banner>
  );
}
