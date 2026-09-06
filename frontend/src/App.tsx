import { useTranslation } from 'react-i18next';

import type { SkyEngineFactory } from './sky/engine/types';
import type { FrameController } from './state/frameController';
import type { SkyStore } from './state/storeTypes';
import BootStatus from './ui/BootStatus';
import SkyCanvas from './ui/SkyCanvas';

// The M3 shell (plan D87): the sky canvas under a splash that disappears at the first frame, and
// an `sr-only` level-1 heading so the page has a name for assistive technology (UX-4). The store,
// the frame controller and the engine factory are injected by `main.tsx`; tests pass fakes, so
// Babylon never runs under jsdom. The panels, labels and controls arrive at M4.

export interface AppProps {
  store: SkyStore;
  frames: FrameController;
  createEngine: SkyEngineFactory;
}

export default function App({ store, frames, createEngine }: AppProps) {
  const { t } = useTranslation();

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-sky-bg text-sky-fg">
      <h1 className="sr-only">{t('app.title')}</h1>
      <SkyCanvas store={store} frames={frames} createEngine={createEngine} />
      <BootStatus store={store} />
    </main>
  );
}
