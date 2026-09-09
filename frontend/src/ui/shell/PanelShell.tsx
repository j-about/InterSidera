import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { SkyStore } from '../../state/storeTypes';
import type { PanelId } from '../../state/types';
import Sheet from '../components/Sheet';
import Tabs from '../components/Tabs';
import type { TabItem } from '../components/Tabs';
import ObserverPanel from '../observer/ObserverPanel';
import DetailsPanel from '../panels/DetailsPanel';
import LayersPanel from '../panels/LayersPanel';
import TimePanel from '../time/TimePanel';
import TimeReadout from '../time/TimeReadout';
import TransportBar from '../time/TransportBar';
import { DESKTOP_QUERY, useMediaQuery } from './useMediaQuery';

// The control panel (VIEW-5, plan D112): the `complementary` landmark, a bottom sheet below `md`
// and a right-hand column from `md` up, holding the observer, time, layers and details tabs
// bound to `ui.panel` (`openPanel` also expands the sheet). It is focusable (`tabIndex={-1}`) as
// the skip link's target and never covers the canvas beyond its own box. The bottom safe-area
// inset is the aside's padding (not the body's), so the collapsed strip clears a phone's home
// indicator as well as the expanded body.

export interface PanelShellProps {
  store: SkyStore;
}

/** The tab shown while `ui.panel` is `null` (nothing chosen yet). */
export const DEFAULT_PANEL: PanelId = 'observer';

export default function PanelShell({ store }: PanelShellProps) {
  const { t } = useTranslation();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const { panel, sheet } = useStore(
    store,
    useShallow((s) => ({ panel: s.ui.panel, sheet: s.ui.sheet })),
  );
  const { actions } = store.getState();

  const items: readonly TabItem<PanelId>[] = [
    { id: 'observer', label: t('tabs.observer'), panel: <ObserverPanel store={store} /> },
    { id: 'time', label: t('tabs.time'), panel: <TimePanel store={store} /> },
    { id: 'layers', label: t('tabs.layers'), panel: <LayersPanel store={store} /> },
    { id: 'details', label: t('tabs.details'), panel: <DetailsPanel store={store} /> },
  ];

  return (
    <aside
      id="panel"
      tabIndex={-1}
      aria-labelledby="panel-title"
      className="absolute inset-x-0 bottom-0 z-20 flex max-h-dvh flex-col rounded-t-xl bg-panel-bg pb-safe-b text-panel-fg shadow-lg outline-offset-[-2px] md:inset-y-0 md:right-0 md:left-auto md:w-panel md:rounded-none md:pt-safe-t md:pr-safe-r md:pb-0"
    >
      <h2 id="panel-title" className="sr-only">
        {t('shell.panelTitle')}
      </h2>
      <Sheet
        id="panel-body"
        expanded={sheet === 'expanded'}
        onToggle={(expanded) => {
          actions.setUi({ sheet: expanded ? 'expanded' : 'collapsed' });
        }}
        expandLabel={t('sheet.expand')}
        collapseLabel={t('sheet.collapse')}
        escapeCollapses={!desktop}
        strip={
          desktop ? undefined : (
            <>
              <TimeReadout store={store} />
              <TransportBar store={store} />
            </>
          )
        }
      >
        <Tabs
          idBase="panel"
          label={t('shell.panelTitle')}
          items={items}
          selected={panel ?? DEFAULT_PANEL}
          onSelect={(id) => {
            actions.openPanel(id);
          }}
        />
      </Sheet>
    </aside>
  );
}
