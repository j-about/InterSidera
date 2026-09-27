import { FastForward, Pause, Play, Radio, Rewind } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { SkyStore } from '../../state/storeTypes';
import { DEFAULT_SPEEDS, nextSpeed, speedList } from '../../state/timeDisplay';
import IconButton from '../components/IconButton';
import DateTimeEditor from './DateTimeEditor';
import SpeedSelect from './SpeedSelect';

// The transport (TIME-3, brief l.203; plan D99): play/pause, slower/faster (one index in the
// signed speed list), the speed select and "Now" (live). Mounted once by the shell (the top bar on
// the desktop, the sheet strip on the phone), so it also hosts the date-and-time dialog: a
// `<dialog>` inside a hidden tab panel could not be shown, and the `t` shortcut opens the editor
// from anywhere. Play from a pause resumes the last running speed of this session (`ui.lastSpeed`,
// recorded by the store and shared with the Space shortcut; 1x at first).

export interface TransportBarProps {
  store: SkyStore;
}

/** The speed the transport reads: 0 paused, 1 live, else the playing speed. */
export function effectiveSpeed(mode: 'live' | 'paused' | 'playing', speed: number): number {
  switch (mode) {
    case 'live':
      return 1;
    case 'paused':
      return 0;
    case 'playing':
      return speed;
  }
}

export default function TransportBar({ store }: TransportBarProps) {
  const { t } = useTranslation();
  const { mode, speed, speeds, lastSpeed } = useStore(
    store,
    useShallow((s) => ({
      mode: s.clock.mode,
      speed: s.clock.speed,
      speeds: s.meta?.limits.speeds ?? DEFAULT_SPEEDS,
      lastSpeed: s.ui.lastSpeed,
    })),
  );
  const { actions } = store.getState();
  const list = speedList(speeds);
  const current = effectiveSpeed(mode, speed);
  const running = mode !== 'paused';

  return (
    <div
      role="group"
      aria-label={t('time.speed')}
      className="flex max-w-full flex-wrap items-center gap-0.5"
    >
      <IconButton
        icon={Rewind}
        label={t('time.slower')}
        size="sm"
        onClick={() => {
          actions.play(nextSpeed(list, current, -1));
        }}
      />
      <IconButton
        icon={running ? Pause : Play}
        label={running ? t('time.pause') : t('time.play')}
        aria-keyshortcuts="Space"
        aria-pressed={running}
        size="sm"
        onClick={() => {
          if (running) {
            actions.pause();
          } else {
            actions.play(lastSpeed);
          }
        }}
      />
      <IconButton
        icon={FastForward}
        label={t('time.faster')}
        size="sm"
        onClick={() => {
          actions.play(nextSpeed(list, current, 1));
        }}
      />
      <SpeedSelect
        id="transport-speed"
        speeds={list}
        value={current}
        onChange={(next) => {
          actions.play(next);
        }}
      />
      <IconButton
        icon={Radio}
        label={t('time.now')}
        aria-keyshortcuts="n"
        aria-pressed={mode === 'live'}
        size="sm"
        onClick={() => {
          actions.live();
        }}
      />
      <DateTimeEditor store={store} />
    </div>
  );
}
