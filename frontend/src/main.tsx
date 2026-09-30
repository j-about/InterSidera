import i18next from 'i18next';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './i18n';
import { detectLanguage } from './i18n/detect';
import { createSkyEngine } from './sky/engine/SkyEngine';
import type { EngineTicker } from './sky/engine/types';
import { startArCapabilityProbe } from './state/arCapabilities';
import { createDetailsController } from './state/detailsController';
import { startDomSync } from './state/domSync';
import { createFrameController } from './state/frameController';
import type { FrameControllerDeps } from './state/frameController';
import { requestGeolocation } from './state/geolocation';
import { createSkyStore } from './state/store';
import { LANGS } from './state/types';
import { parseUrlState } from './state/url';
import { startUrlSync } from './state/urlSync';
import './styles/app.css';

// Application wiring (plan D87, D95, D109): the URL is the only per-user state (OBS-8, UX-2), so
// the store is created from it before anything renders; the language is the URL's, else the
// browser's first supported one (always written back to the URL: its default is the browser's); the
// document mirror applies language and night mode before the first paint; the synchroniser
// writes every later change back at <= 2 Hz; a URL without an observer starts the geolocation
// request on the same tick as the boot; the AR-1 capability probe (plan D125, main bundle, a
// re-run on `devicechange`) starts here too, so the AR button exists before any AR chunk loads.
// The frame controller, the details ticker and the engine factory are handed to the shell as
// props so tests can inject fakes.

// Guard instead of a `!` non-null assertion: strictTypeChecked forbids it (plan D19), and a missing
// mount point should fail loudly rather than as a null dereference deep inside React.
const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root missing');
}

const initial = parseUrlState(location.search);
initial.lang ??= detectLanguage(navigator.languages, LANGS);
const store = createSkyStore(initial);
startDomSync(store);
startUrlSync(store);
startArCapabilityProbe(store);
if (
  initial.body === undefined &&
  initial.lat === undefined &&
  initial.lon === undefined &&
  initial.elev === undefined
) {
  requestGeolocation(store);
}

const frameDeps: FrameControllerDeps = { store };
if (import.meta.env.DEV) {
  // Failures are already handled (backoff, extrapolation); the line is for the developer only.
  frameDeps.onError = (error: unknown) => {
    console.warn('frame request failed', error);
  };
}
const frames = createFrameController(frameDeps);
// A stable array: `SkyCanvas` hands it to the engine once, at construction (plan D93).
const tickers: readonly EngineTicker[] = [createDetailsController({ store })];

const root = createRoot(rootEl);
// The resources are bundled, so `changeLanguage` cannot fail (the mirror above already asked for
// the same language); rendering after it keeps the very first paint in that language instead of
// re-rendering from English.
void i18next.changeLanguage(store.getState().options.lang).then(() => {
  root.render(
    <StrictMode>
      <App store={store} frames={frames} createEngine={createSkyEngine} tickers={tickers} />
    </StrictMode>,
  );
});
