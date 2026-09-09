import { Camera, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { coverageYears } from '../../state/coverage';
import type { SkyStore } from '../../state/storeTypes';
import { badgesOf } from '../../state/warnings';
import type { BadgeTarget } from '../../state/warnings';
import Badge from '../components/Badge';

// Coverage warnings (TIME-4, brief l.204, l.168; plan D100): one badge per warning code of the
// current frame window (icon and text, never colour alone), its valid range as signed years in a
// visible line under the badge (a tooltip alone is unreachable on touch), and the snapshot-mode
// badge. `targets` narrows the list to the part of the interface it qualifies (the observer
// header, the time readout, the stars switch and the minor-body section of the layers panel; the
// time panel shows every target). The coverage-stop banner (`frames.coverageStop`) is the shell's
// (`ui/components/Banners.tsx`, plan D111), so the stop is announced once.

export interface CoverageBadgesProps {
  store: SkyStore;
  targets?: readonly BadgeTarget[];
}

export default function CoverageBadges({ store, targets }: CoverageBadgesProps) {
  const { t } = useTranslation();
  const { frames } = useStore(
    store,
    useShallow((s) => ({ frames: s.frames })),
  );
  const badges = badgesOf(frames).filter(
    (badge) => targets === undefined || targets.includes(badge.target),
  );
  if (badges.length === 0 && !frames.snapshot) {
    return null;
  }
  return (
    <ul className="flex flex-wrap gap-1" data-testid="coverage-badges">
      {frames.snapshot && (
        <li>
          <Badge icon={Camera} tone="accent">
            {t('time.snapshot')}
          </Badge>
        </li>
      )}
      {badges.map((badge) => {
        const text = t(`warnings.${badge.code}`, badge.params ?? {});
        const range =
          badge.rangeTt === undefined
            ? undefined
            : t('warnings.validRange', coverageYears(badge.rangeTt));
        const objects = badge.ids.length === 0 ? '' : ` (${badge.ids.join(', ')})`;
        return (
          <li key={badge.code} className="flex flex-col gap-0.5">
            <Badge icon={TriangleAlert} tone={badge.code === 'mpc_unreliable' ? 'danger' : 'warn'}>
              {`${text}${objects}`}
            </Badge>
            {range !== undefined && <span className="text-xs text-muted">{range}</span>}
          </li>
        );
      })}
    </ul>
  );
}
