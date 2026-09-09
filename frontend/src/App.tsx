import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { EngineTicker, SkyEngineApi, SkyEngineFactory } from './sky/engine/types';
import type { FrameController } from './state/frameController';
import type { SkyStore } from './state/storeTypes';
import BootStatus from './ui/BootStatus';
import SkyCanvas from './ui/SkyCanvas';
import Banners from './ui/components/Banners';
import Toast from './ui/components/Toast';
import GeoBanner from './ui/observer/GeoBanner';
import { EngineProvider } from './ui/shell/EngineContext';
import HintBanner from './ui/shell/HintBanner';
import PanelShell from './ui/shell/PanelShell';
import SkipLink from './ui/shell/SkipLink';
import TopBar from './ui/shell/TopBar';
import { installShortcuts } from './ui/shortcuts';

// The application shell (VIEW-5, plan D112): the skip link first, then the sky stage (`main`,
// the canvas and its label overlay filling the viewport), the floating chrome column (the
// `banner` top bar and the live regions beneath it: degraded-state banners, toasts, the
// first-visit hint) that lets gestures through outside its boxes (the column is
// `pointer-events-none`, each child `pointer-events-auto`), the control panel (`aside`,
// a bottom sheet on phones and a right column from `md` up) and the boot splash. The store,
// the frame controller and the engine factory are injected by `main.tsx`; tests pass fakes, so
// Babylon never runs under jsdom. The engine API reaches event handlers through `EngineProvider`.

export interface AppProps {
  store: SkyStore;
  frames: FrameController;
  createEngine: SkyEngineFactory;
  /** Pulled by the engine on every frame (plan D93). */
  tickers?: readonly EngineTicker[];
  /** The engine API for event handlers (snapshot), `null` when torn down. */
  onEngine?: (api: SkyEngineApi | null) => void;
}

export default function App({ store, frames, createEngine, tickers, onEngine }: AppProps) {
  const { t } = useTranslation();
  const [engine, setEngine] = useState<SkyEngineApi | null>(null);
  const handleEngine = useCallback(
    (api: SkyEngineApi | null) => {
      setEngine(api);
      onEngine?.(api);
    },
    [onEngine],
  );
  useEffect(() => installShortcuts(store), [store]);

  return (
    <EngineProvider engine={engine}>
      <SkipLink store={store} />
      <div className="relative h-dvh w-full overflow-hidden bg-sky-bg text-sky-fg">
        <main className="absolute inset-0">
          <h1 className="sr-only">{t('app.title')}</h1>
          <div id="sky-stage" className="absolute inset-0">
            <SkyCanvas
              store={store}
              frames={frames}
              createEngine={createEngine}
              tickers={tickers}
              onEngine={handleEngine}
            />
          </div>
        </main>
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 pt-safe-t pr-safe-r pl-safe-l md:right-panel">
          {/* Every direct child of the column takes pointer events back (`*:`), so a banner, a
              toast or the hint is clickable whatever classes it carries; the sky between them
              keeps receiving the gestures. */}
          <div className="flex flex-col gap-2 p-2 *:pointer-events-auto">
            <TopBar store={store} />
            <GeoBanner store={store} />
            <Banners store={store} />
            <Toast store={store} />
            <HintBanner store={store} />
          </div>
        </div>
        <PanelShell store={store} />
        <BootStatus store={store} />
      </div>
    </EngineProvider>
  );
}
