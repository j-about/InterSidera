import i18next from 'i18next';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './i18n';
import { createSkyEngine } from './sky/engine/SkyEngine';
import { createFrameController } from './state/frameController';
import type { FrameControllerDeps } from './state/frameController';
import { createSkyStore } from './state/store';
import { parseUrlState } from './state/url';
import { startUrlSync } from './state/urlSync';
import './styles/app.css';

// Application wiring (plan D87): the URL is the only per-user state (OBS-8, UX-2), so the store
// is created from it before anything renders, the language it names is applied before the first
// paint, and the synchroniser writes every later change back at <= 2 Hz. The frame controller
// and the engine factory are handed to the shell as props so tests can inject fakes.

// Guard instead of a `!` non-null assertion: strictTypeChecked forbids it (plan D19), and a missing
// mount point should fail loudly rather than as a null dereference deep inside React.
const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root missing');
}

const store = createSkyStore(parseUrlState(location.search));
const { lang } = store.getState().options;
document.documentElement.lang = lang;
startUrlSync(store);

const frameDeps: FrameControllerDeps = { store };
if (import.meta.env.DEV) {
  // Failures are already handled (backoff, extrapolation); the line is for the developer only.
  frameDeps.onError = (error: unknown) => {
    console.warn('frame request failed', error);
  };
}
const frames = createFrameController(frameDeps);

const root = createRoot(rootEl);
// The resources are bundled, so `changeLanguage` cannot fail; rendering after it keeps the very
// first paint in the URL's language instead of re-rendering from English.
void i18next.changeLanguage(lang).then(() => {
  root.render(
    <StrictMode>
      <App store={store} frames={frames} createEngine={createSkyEngine} />
    </StrictMode>,
  );
});
