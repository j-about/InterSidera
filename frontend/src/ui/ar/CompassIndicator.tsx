import { Compass } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';

import { formatDegrees } from '../../i18n/format';
import type { SkyStore } from '../../state/storeTypes';
import type { CompassLevel } from '../../state/types';
import Badge from '../components/Badge';
import type { BadgeTone } from '../components/Badge';

// The compass-accuracy indicator (AR-2, brief l.238; plan D118, D127): one text per
// `ar.heading.level` (`ar.compass.*`, a closed dynamic prefix typed by `CompassLevel`), the raw
// iOS accuracy figure appended for the `compass` source, and "magnetic north" as the tooltip of
// the two headed sources (both platforms report magnetic north, backlog B-74). The level is
// computed by the controller (`ui/**` imports no `sky/math`); the tone only underlines a state
// the text already carries (UX-4). A `role="status"` region named "Compass".

export interface CompassIndicatorProps {
  store: SkyStore;
}

/** Complete literal tone per level (brief l.550): accent good, warn when the user must act, muted none. */
function toneOf(level: CompassLevel): BadgeTone {
  switch (level) {
    case 'good':
      return 'accent';
    case 'none':
      return 'muted';
    default:
      return 'warn';
  }
}

export default function CompassIndicator({ store }: CompassIndicatorProps) {
  const { t } = useTranslation();
  // Written by the controller on change only, so the object identity is a fine selector.
  const heading = useStore(store, (s) => s.ar.heading);
  const { source, accuracyDeg, level } = heading;
  const figure =
    source === 'compass' && accuracyDeg !== null && accuracyDeg >= 0
      ? ` ${t('ar.compass.accuracy', { deg: formatDegrees(accuracyDeg, 0) })}`
      : '';
  const magnetic = source === 'absolute' || source === 'compass';
  return (
    <span role="status" aria-label={t('ar.compass.label')}>
      <Badge
        icon={Compass}
        tone={toneOf(level)}
        {...(magnetic ? { title: t('ar.compass.magnetic') } : {})}
      >
        {t(`ar.compass.${level}`)}
        {figure}
      </Badge>
    </span>
  );
}
