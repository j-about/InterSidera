import { useEffect, useRef } from 'react';
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
// Focus not obscured and target size (WCAG 2.2 SC 2.4.11, 2.5.8; plan D157 C7): the expanded
// phone sheet is capped at 70 dvh as a whole (`max-h-[70dvh]`: handle, strip and body; the body
// is the part that shrinks and scrolls), which leaves the top 30 % of the viewport to the top
// bar: at 412x839 (Playwright's Pixel 7) the bar's three rows end at 160 px and the sheet starts
// at 252 px, so no control is covered (a cap on the body alone put the sheet at 133 px once the
// strip wrapped, and axe reported the last row's buttons as partially obscured). On a 320 px
// phone the top bar wraps to about 300 px and the sheet, from 170 px, still hides controls
// entirely: there, a keyboard focus landing on a top-bar control that the sheet covers collapses
// the sheet (the mirror of `SkipLink`, which expands it when the focus goes the other way). The
// collapse is conditioned on `:focus-visible` and on the two boxes intersecting: a tap focuses a
// button too on Chromium and Android, and a bare `focusin` would close the sheet on every tap of
// the night switch at a width where nothing is obscured.

export interface PanelShellProps {
  store: SkyStore;
  /** Test injection of the keyboard-focus test (default `:focus-visible`, which jsdom never matches). */
  focusVisible?: (element: Element) => boolean;
}

/** The tab shown while `ui.panel` is `null` (nothing chosen yet). */
export const DEFAULT_PANEL: PanelId = 'observer';

/** `:focus-visible` as the browser sees it (`false` where the selector is unknown). */
export function matchesFocusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return false;
  }
}

/**
 * Whether a focus that just landed on `target` should collapse the expanded sheet `sheet`: the
 * target is a top-bar control (inside a `header`, outside the sheet), it shows the keyboard focus
 * ring, and its box intersects the sheet's box. One layout read per focus event, never per frame.
 */
export function focusObscuredBySheet(
  target: Element,
  sheet: Element,
  focusVisible: (element: Element) => boolean = matchesFocusVisible,
): boolean {
  if (target.closest('header') === null || sheet.contains(target) || !focusVisible(target)) {
    return false;
  }
  const a = target.getBoundingClientRect();
  const b = sheet.getBoundingClientRect();
  return (
    a.width > 0 &&
    a.height > 0 &&
    a.left < b.right &&
    a.right > b.left &&
    a.top < b.bottom &&
    a.bottom > b.top
  );
}

export default function PanelShell({ store, focusVisible = matchesFocusVisible }: PanelShellProps) {
  const { t } = useTranslation();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const { panel, sheet, xrSession } = useStore(
    store,
    useShallow((s) => ({ panel: s.ui.panel, sheet: s.ui.sheet, xrSession: s.ar.mode === 'xr' })),
  );
  const { actions } = store.getState();
  const asideRef = useRef<HTMLElement>(null);
  const phoneExpanded = !desktop && sheet === 'expanded';

  useEffect(() => {
    if (!phoneExpanded) {
      return;
    }
    const aside = asideRef.current;
    if (aside === null) {
      return;
    }
    const onFocusIn = (event: FocusEvent): void => {
      if (
        event.target instanceof Element &&
        focusObscuredBySheet(event.target, aside, focusVisible)
      ) {
        actions.setUi({ sheet: 'collapsed' });
      }
    };
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [phoneExpanded, focusVisible, actions]);

  const items: readonly TabItem<PanelId>[] = [
    { id: 'observer', label: t('tabs.observer'), panel: <ObserverPanel store={store} /> },
    { id: 'time', label: t('tabs.time'), panel: <TimePanel store={store} /> },
    { id: 'layers', label: t('tabs.layers'), panel: <LayersPanel store={store} /> },
    { id: 'details', label: t('tabs.details'), panel: <DetailsPanel store={store} /> },
  ];

  return (
    <aside
      id="panel"
      ref={asideRef}
      tabIndex={-1}
      aria-labelledby="panel-title"
      className="absolute inset-x-0 bottom-0 z-20 flex max-h-[70dvh] flex-col rounded-t-xl bg-panel-bg pb-safe-b text-panel-fg shadow-lg outline-offset-[-2px] md:inset-y-0 md:right-0 md:left-auto md:max-h-none md:w-panel md:rounded-none md:pt-safe-t md:pr-safe-r md:pb-0"
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
              {/* Inside a WebXR session the AR overlay owns the transport (plan D127), so the
                  document holds one `SpeedSelect#transport-speed` and one time-editor dialog. */}
              {!xrSession && <TransportBar store={store} />}
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
