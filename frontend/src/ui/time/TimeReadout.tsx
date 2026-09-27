import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { SkyStore } from '../../state/storeTypes';
import CoverageBadges from './CoverageBadges';
import {
  formatCalendar,
  formatHours,
  formatJd,
  formatOffset,
  isUtLabel,
  localCalendarOfTt,
  utcCalendarOfTt,
  zoneName,
} from '../../state/timeDisplay';

// The time readout (TIME-1, brief l.201, l.51; plan D98): the local date and time with the zone
// (the browser's offset at that instant, the IANA name when Intl knows it), the UTC line (UT
// before 1972, when the backend hands TT - UT1), the TT Julian Date to five decimals and, on
// Earth, the local apparent sidereal time of the rendered frame; under it the warnings aimed at
// the readout (`delta_t_approximate`, plan D100). It follows the store's <= 2 Hz mirror of the
// engine's clock (`publishTt`), never the animation rate.
// Markup (WCAG 1.3.1, plan D157 C1): a `dl` holds `dt`/`dd` groups either directly or each
// wrapped in exactly one `div`, never two levels (axe `definition-list` and `dlitem`, the one
// weighted Lighthouse failure at M5). Hence two sibling lists: the local group (one `dt`, its
// `dd`s) and the muted row of three one-group `div`s (UTC, TT, LAST), stacked by a plain `div`
// that keeps the M4 geometry. A `section` carries the name: `dl` maps to no role that accepts one.
// Reflow (WCAG 1.4.10, plan D157 C7): the section never exceeds its container (`max-w-full`) and
// each row wraps between its items while every value stays on one line, so the muted row
// (about 390 px) folds inside the 320 px phone strip instead of spilling past the viewport.

export interface TimeReadoutProps {
  store: SkyStore;
}

export default function TimeReadout({ store }: TimeReadoutProps) {
  const { t } = useTranslation();
  const { tt, ttMinusUtc, lstHours, mode, body } = useStore(
    store,
    useShallow((s) => ({
      tt: s.clock.tt,
      ttMinusUtc: s.clock.ttMinusUtc,
      lstHours: s.clock.lstHours,
      mode: s.clock.mode,
      body: s.observer.body,
    })),
  );
  if (!Number.isFinite(tt)) {
    return null;
  }
  const local = localCalendarOfTt(tt, ttMinusUtc);
  const zone = zoneName();
  const utc = utcCalendarOfTt(tt, ttMinusUtc);
  const showLast = body === 'earth' && Number.isFinite(lstHours);
  return (
    <section
      aria-label={t('time.readout')}
      className="flex max-w-full shrink-0 flex-col gap-1 text-xs leading-tight whitespace-nowrap text-panel-fg tabular-nums"
      data-testid="time-readout"
    >
      <div className="flex flex-col">
        <dl className="flex flex-wrap gap-x-1">
          <dt className="sr-only">{t('time.local')}</dt>
          <dd className="text-sm font-medium" data-testid="time-local">
            {formatCalendar(local.fields)}
          </dd>
          <dd className="text-muted">
            {zone === null
              ? formatOffset(local.offsetMin)
              : `${formatOffset(local.offsetMin)} ${zone}`}
          </dd>
          {mode === 'live' && <dd className="text-accent">{t('time.live')}</dd>}
        </dl>
        <dl className="flex flex-wrap gap-x-2 text-muted">
          <div className="flex gap-1">
            <dt>{isUtLabel(tt) ? t('time.ut') : t('time.utc')}</dt>
            <dd data-testid="time-utc">{formatCalendar(utc)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>{t('time.tt')}</dt>
            <dd data-testid="time-jd">{formatJd(tt)}</dd>
          </div>
          {showLast && (
            <div className="flex gap-1">
              <dt>{t('time.last')}</dt>
              <dd data-testid="time-last">{formatHours(lstHours)}</dd>
            </div>
          )}
        </dl>
      </div>
      <CoverageBadges store={store} targets={['time']} />
    </section>
  );
}
