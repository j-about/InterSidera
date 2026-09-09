import type { searchPlaces } from '../../api/geocoder';
import type { GeolocationDeps } from '../../state/geolocation';
import type { SkyStore } from '../../state/storeTypes';
import CoverageBadges from '../time/CoverageBadges';
import BodyPicker from './BodyPicker';
import CoordinateForm from './CoordinateForm';
import GeoNotice from './GeoNotice';
import PlaceSearch from './PlaceSearch';
import PresetList from './PresetList';

// The observer panel (OBS-1..OBS-6, brief l.190-195; plan D95-D97): the geolocation notice and
// button, the body picker with its coverage line and the observer warnings of the current window
// (`iau_rotation_approximate`, `pluto_barycenter`; plan D100), the manual coordinates, the
// presets of the current body and the Nominatim place search. Every section reads the store itself; the two
// optional props inject fakes for the tests (the geolocation object, the geocoder function).

export interface ObserverPanelProps {
  store: SkyStore;
  geolocation?: GeolocationDeps;
  geocode?: typeof searchPlaces;
}

export default function ObserverPanel({ store, geolocation, geocode }: ObserverPanelProps) {
  return (
    <div className="flex flex-col gap-4">
      <GeoNotice store={store} {...(geolocation === undefined ? {} : { deps: geolocation })} />
      <BodyPicker store={store} />
      <CoverageBadges store={store} targets={['observer']} />
      <CoordinateForm store={store} />
      <PresetList store={store} />
      <PlaceSearch store={store} {...(geocode === undefined ? {} : { geocode })} />
    </div>
  );
}
