import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';

import type { SkyStore } from '../../state/storeTypes';
import Banner from '../components/Banner';

// The geolocation explanation (OBS-1, brief l.190; plan D95): the one-line reason the browser
// is asking for the position, shown in the shell's banner stack while `geo.status` is
// `'prompting'`, so it is visible on a phone whose sheet starts collapsed as well as next to the
// desktop panel, and the sky stays in view (no panel is opened for the prompt). The failure
// hints and the "Use my location" button live in the observer panel (`GeoNotice`).

export interface GeoBannerProps {
  store: SkyStore;
}

export default function GeoBanner({ store }: GeoBannerProps) {
  const { t } = useTranslation();
  const prompting = useStore(store, (s) => s.geo.status === 'prompting');
  if (!prompting) {
    return null;
  }
  return (
    <Banner kind="status" title={t('geo.title')}>
      {t('geo.explain')}
    </Banner>
  );
}
