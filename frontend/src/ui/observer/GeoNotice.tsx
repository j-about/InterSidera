import { LocateFixed } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';

import { requestGeolocation } from '../../state/geolocation';
import type { GeolocationDeps } from '../../state/geolocation';
import type { SkyStore } from '../../state/storeTypes';
import type { GeoStatus } from '../../state/types';
import Banner from '../components/Banner';
import Button from '../components/Button';

// The geolocation notice (OBS-1, OBS-2; plan D95): a hint per failure status (Greenwich stays)
// and a "Use my location" button that is always present so the gesture path exists whatever the
// browser did with the automatic prompt. The one-line explanation shown while the prompt is up is
// `GeoBanner`, mounted in the shell's banner stack (visible on a collapsed phone sheet too); it is
// not repeated here. The statuses are narrowed so the typed `t` accepts the template key.

type GeoFailure = Exclude<GeoStatus, 'idle' | 'granted' | 'prompting'>;

function failureOf(status: GeoStatus): GeoFailure | null {
  switch (status) {
    case 'denied':
    case 'unavailable':
    case 'timeout':
    case 'unsupported':
    case 'insecure':
      return status;
    default:
      return null;
  }
}

export interface GeoNoticeProps {
  store: SkyStore;
  /** Test injection of the `Geolocation` and the secure-context flag. */
  deps?: GeolocationDeps;
}

export default function GeoNotice({ store, deps }: GeoNoticeProps) {
  const { t } = useTranslation();
  const status = useStore(store, (s) => s.geo.status);
  const failure = failureOf(status);
  const prompting = status === 'prompting';
  return (
    <div className="flex flex-col gap-2">
      {failure !== null && (
        <Banner kind="status" tone="warn" title={t('geo.title')}>
          {t(`geo.${failure}`)}
        </Banner>
      )}
      <Button
        variant="outline"
        aria-disabled={prompting ? true : undefined}
        className="self-start"
        onClick={() => {
          if (!prompting) {
            requestGeolocation(store, deps);
          }
        }}
      >
        <LocateFixed size={16} aria-hidden="true" />
        {t('geo.useMyLocation')}
      </Button>
    </div>
  );
}
