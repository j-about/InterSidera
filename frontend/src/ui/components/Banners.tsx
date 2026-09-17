import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { formatYearOfJd } from '../../i18n/format';
import type { SkyStore } from '../../state/storeTypes';
import Banner from './Banner';
import Button from './Button';

// The degraded-state banners (UX-6, plan D111), from store fields only: the API unreachable
// after boot (`frames.failing`, an alert with the retry countdown and "retry now"), a catalog
// changed on the server (`catalogs.* === 'stale'`, a reload prompt), the clock stopped at a
// coverage bound (`frames.coverageStop`, a status with the range as signed years) and the
// renderer failed after it had started (`engine.status === 'failed'`; the WebGL2 case is the
// splash's, `engine.unsupported`) and, since M5, augmented reality stopped or refused
// (`ar.error`, AR-5, plan D127: one dismissible warning alert per failure code through the
// closed prefix `ar.error.`, typed by `ArError`; the overlay unmounts with the mode, so this is
// the one place the message survives; `requestAr` clears it on the next attempt and
// `clearArError` on dismiss). Optional data missing is not a banner: the layer switch is
// disabled with the reason (`LayersPanel`). Every status region carries a title, so it is named.

export interface BannersProps {
  store: SkyStore;
  /** Replaces `location.reload()` (tests). */
  reload?: () => void;
}

/** The whole seconds left before `atMs`, never negative, re-read every second. */
function useCountdown(atMs: number | null): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (atMs === null) {
      return;
    }
    // A timer, not derived state: the countdown is the only moving part and the store never ticks.
    const tick = (): void => {
      setSeconds(Math.max(0, Math.ceil((atMs - Date.now()) / 1000)));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [atMs]);
  return atMs === null ? 0 : seconds;
}

export default function Banners({ store, reload }: BannersProps) {
  const { t } = useTranslation();
  const { failing, coverageStop, stale, engineFailed, arError } = useStore(
    store,
    useShallow((s) => ({
      failing: s.frames.failing,
      coverageStop: s.frames.coverageStop,
      stale: Object.values(s.catalogs).includes('stale'),
      engineFailed: s.engine.status === 'failed' && s.boot.error?.kind !== 'webgl2',
      arError: s.ar.error,
    })),
  );
  const { actions } = store.getState();
  const seconds = useCountdown(failing === null ? null : failing.nextRetryMs);

  const doReload =
    reload ??
    (() => {
      location.reload();
    });

  return (
    <>
      {failing !== null && (
        <Banner
          kind="alert"
          tone="danger"
          title={t('degraded.unreachableTitle')}
          actions={
            <Button
              variant="outline"
              onClick={() => {
                actions.retryNow();
              }}
            >
              {t('degraded.retryNow')}
            </Button>
          }
        >
          {t('degraded.unreachable', { seconds })}
        </Banner>
      )}
      {stale && (
        <Banner
          kind="status"
          tone="warn"
          title={t('degraded.staleTitle')}
          actions={
            <Button variant="outline" onClick={doReload}>
              {t('degraded.reload')}
            </Button>
          }
        >
          {t('degraded.stale')}
        </Banner>
      )}
      {coverageStop !== null && (
        <Banner kind="status" tone="info" title={t('degraded.coverageStopTitle')}>
          {t('degraded.coverageStop', {
            start: formatYearOfJd(coverageStop.rangeTt[0]),
            end: formatYearOfJd(coverageStop.rangeTt[1]),
          })}
        </Banner>
      )}
      {engineFailed && (
        <Banner
          kind="alert"
          tone="danger"
          title={t('degraded.engineFailedTitle')}
          actions={
            <Button variant="outline" onClick={doReload}>
              {t('degraded.reload')}
            </Button>
          }
        >
          {t('degraded.engineFailed')}
        </Banner>
      )}
      {arError !== null && (
        <Banner
          kind="alert"
          tone="warn"
          title={t('ar.errorTitle')}
          onDismiss={() => {
            actions.clearArError();
          }}
        >
          {t(`ar.error.${arError}`)}
        </Banner>
      )}
    </>
  );
}
