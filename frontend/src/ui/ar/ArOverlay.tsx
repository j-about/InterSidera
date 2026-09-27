import { ChevronLeft, ChevronRight, MoveHorizontal, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { formatDegrees } from '../../i18n/format';
import type { SkyStore } from '../../state/storeTypes';
import Badge from '../components/Badge';
import Banner from '../components/Banner';
import Button from '../components/Button';
import IconButton from '../components/IconButton';
import Slider from '../components/Slider';
import Switch from '../components/Switch';
import { useEngine } from '../shell/EngineContext';
import TransportBar from '../time/TransportBar';
import CompassIndicator from './CompassIndicator';
import TimeOffsetBadge from './TimeOffsetBadge';

// The AR chrome (AR-1..AR-5, brief l.237-241; plan D127): loaded lazily by `App`
// (`lazy(() => import('./ui/ar/ArOverlay'))`, the `ArOverlay` chunk, so nothing here reaches
// the eager bundle) and rendered in place of the top bar while `ar.mode !== 'off'`, as the same
// `banner` landmark. Its root, `header#ar-overlay`, is also the WebXR DOM-overlay element the
// exit button's neighbour hands to `engine.enterXr(root)` (plan D128), so it must stay meaningful
// when the UA stylesheet stretches it to the whole screen inside a session: a column aligned to
// the start, no background of its own, the panel surface on the inner row. Contents: the exit
// control (focused on entry through an effect, never `autoFocus`; the AR button regains the focus
// when the top bar returns, see `App`), the time-offset badge, the compass indicator, the AR-3
// azimuth offset between two 1° nudges with its reset (the nudges are the non-drag twin of the
// calibration drag, WCAG 2.2 SC 2.5.7, plan D157 C5: "turn the sky right" moves the drawn sky to
// the right on screen exactly as a rightward drag does, which by `frames.ts::dragDeltaDeg` turns
// the view left, so the offset decreases by one degree; "left" adds one), the camera-field
// slider (the diagonal of plan D123, through
// `formatDegrees`), the existing atmosphere switch (plan Q58, the UX-2 control relocated), the
// WebXR switch when the probe said `supported` (an event-time engine call, plan D93; the engine
// writes the outcome to the store) and, in a session only, the transport (AR-1 time travel; the
// sheet strip has it in the sensor mode). While `requesting`, a status banner explains the
// browser prompts with a cancel button; with an absent heading (`none`, before the first sample)
// a dismissible status banner says the sensors are awaited and what to do if no compass answers,
// and with a relative one (`manual`) it carries the manual-north text (AR-3 "the app says so"),
// so the banner never contradicts the compass badge beside it. Failures are not rendered here:
// `ui/components/Banners.tsx` is the single home of `ar.error` and this overlay unmounts with
// the mode. Escape lives in `ui/shortcuts.ts`.

/** The DOM-overlay root of a WebXR session (plan D128). */
export const AR_OVERLAY_ID = 'ar-overlay';
const EXIT_BUTTON_ID = 'ar-exit';

export interface ArOverlayProps {
  store: SkyStore;
}

export default function ArOverlay({ store }: ArOverlayProps) {
  const { t } = useTranslation();
  const engine = useEngine();
  const { mode, level, azOffsetDeg, cameraFovDeg, hintDismissed, xrSupport, xrPhase, atm } =
    useStore(
      store,
      useShallow((s) => ({
        mode: s.ar.mode,
        level: s.ar.heading.level,
        azOffsetDeg: s.ar.azOffsetDeg,
        cameraFovDeg: s.ar.cameraFovDeg,
        hintDismissed: s.ar.hintDismissed,
        xrSupport: s.ar.xr.support,
        xrPhase: s.ar.xr.phase,
        atm: s.options.atm,
      })),
    );
  const { actions } = store.getState();
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // The focus moves to the exit control on entry (UX-4): the top bar the focused AR button
    // lived in has just unmounted. `autoFocus` is refused by jsx-a11y and would fire on remounts.
    rootRef.current?.querySelector<HTMLElement>(`#${EXIT_BUTTON_ID}`)?.focus();
  }, []);

  const exit = (): void => {
    if (mode === 'xr' && engine !== null) {
      // The session ends first (the engine returns to the sensor mode), then AR as a whole.
      const done = (): void => {
        actions.exitAr();
      };
      void engine.exitXr().then(done, done);
      return;
    }
    actions.exitAr();
  };
  const enterXr = (): void => {
    const root = rootRef.current;
    if (engine === null || root === null) {
      return;
    }
    // Event-time call (plan D93, D128): the engine writes `setArMode('xr')` or `failAr(code)`;
    // the rejection carries nothing the store does not already hold.
    void engine.enterXr(root).catch(() => undefined);
  };
  const leaveXr = (): void => {
    if (engine !== null) {
      void engine.exitXr().catch(() => undefined);
    }
  };

  const requesting = mode === 'requesting';
  const showHint = !requesting && !hintDismissed && (level === 'manual' || level === 'none');

  return (
    <header
      id={AR_OVERLAY_ID}
      ref={rootRef}
      className="pointer-events-auto flex flex-col items-start gap-2"
    >
      <div className="flex flex-wrap items-center gap-1 rounded-lg bg-panel-bg p-1.5 text-panel-fg shadow-lg">
        <IconButton id={EXIT_BUTTON_ID} icon={X} label={t('ar.exit')} onClick={exit} />
        {!requesting && (
          <>
            <div role="status" aria-label={t('ar.mode.label')} className="sr-only">
              {mode === 'xr' ? t('ar.mode.xr') : t('ar.mode.sensor')}
            </div>
            <TimeOffsetBadge store={store} />
            <CompassIndicator store={store} />
            <IconButton
              icon={ChevronLeft}
              label={t('ar.offset.left')}
              size="sm"
              onClick={() => {
                actions.nudgeArOffset(1);
              }}
            />
            <Badge icon={MoveHorizontal}>
              {t('ar.offset.value', { deg: formatDegrees(azOffsetDeg, 0) })}
            </Badge>
            <IconButton
              icon={ChevronRight}
              label={t('ar.offset.right')}
              size="sm"
              onClick={() => {
                actions.nudgeArOffset(-1);
              }}
            />
            <IconButton
              icon={RotateCcw}
              label={t('ar.offset.reset')}
              size="sm"
              onClick={() => {
                actions.setArOffset(0);
              }}
            />
            <Slider
              id="ar-fov"
              label={t('ar.fov')}
              min={50}
              max={110}
              step={1}
              value={cameraFovDeg}
              format={(value) => formatDegrees(value, 0)}
              onChange={(value) => {
                actions.setArCameraFov(value);
              }}
            />
            <Switch
              label={t('layers.atmosphere')}
              checked={atm}
              onChange={(on) => {
                actions.setOptions({ atm: on });
              }}
            />
            {xrSupport === 'supported' && mode === 'sensor' && (
              <Button variant="outline" disabled={xrPhase !== 'idle'} onClick={enterXr}>
                {t('ar.enterXr')}
              </Button>
            )}
            {mode === 'xr' && (
              <>
                <Button variant="outline" onClick={leaveXr}>
                  {t('ar.leaveXr')}
                </Button>
                <TransportBar store={store} />
              </>
            )}
          </>
        )}
      </div>
      {requesting && (
        <Banner
          kind="status"
          title={t('ar.requestingTitle')}
          actions={
            <Button
              variant="outline"
              onClick={() => {
                actions.exitAr();
              }}
            >
              {t('ar.cancel')}
            </Button>
          }
        >
          {t('ar.requesting')}
        </Banner>
      )}
      {showHint && (
        <Banner
          kind="status"
          title={t('ar.hint.title')}
          onDismiss={() => {
            actions.dismissArHint();
          }}
        >
          {level === 'none' ? t('ar.hint.waiting') : t('ar.hint.manualNorth')}
        </Banner>
      )}
    </header>
  );
}
