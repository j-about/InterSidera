import { Hourglass } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';

import { formatTimeOffset } from '../../i18n/format';
import type { SkyStore } from '../../state/storeTypes';
import { timeOffsetParts } from '../../state/timeDisplay';
import Badge from '../components/Badge';

// The time-offset badge of the AR overlay (AR-1 "time travel allowed with a visible badge",
// brief l.237; plan D127): shown while the clock is paused or time-lapsed (`clock.mode !==
// 'live'`), it reads `+3 h 12 min` or `−2 yr 10 d` from `timeDisplay.ts::timeOffsetParts` on the
// 2 Hz `clock.tt` mirror. "Now" moves even while the mirror stands still (a paused sky drifts
// away from the wall clock), so the badge keeps its own second timer for the wall time instead of
// reading `Date.now()` during render; it is a `role="status"` region named "Time offset from
// now", so the change is announced politely and the e2e spec can scope on it.

export interface TimeOffsetBadgeProps {
  store: SkyStore;
}

/** The wall clock in milliseconds, refreshed every second while `active`; `null` before the first read. */
function useWallClockMs(active: boolean): number | null {
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    if (!active) {
      return;
    }
    // A timer, not derived state: the wall clock is the one moving part the store never mirrors.
    const tick = (): void => {
      setNowMs(Date.now());
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(id);
      // Forget the reading: the next activation must not show it for a frame before its first tick.
      setNowMs(null);
    };
  }, [active]);
  return active ? nowMs : null;
}

export default function TimeOffsetBadge({ store }: TimeOffsetBadgeProps) {
  const { t } = useTranslation();
  const clock = useStore(store, (s) => s.clock);
  const nowMs = useWallClockMs(clock.mode !== 'live');
  if (nowMs === null) {
    return null;
  }
  const label = t('ar.offset.label');
  return (
    <span role="status" aria-label={label}>
      <Badge icon={Hourglass} tone="accent" title={label}>
        {formatTimeOffset(timeOffsetParts(clock, nowMs), t)}
      </Badge>
    </span>
  );
}
