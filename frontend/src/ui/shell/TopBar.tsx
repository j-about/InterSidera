import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SkyStore } from '../../state/storeTypes';
import IconButton from '../components/IconButton';
import LanguageToggle from '../controls/LanguageToggle';
import SearchBox from '../controls/SearchBox';
import ShareButton from '../controls/ShareButton';
import AboutDialog from '../panels/AboutDialog';
import TimeReadout from '../time/TimeReadout';
import TransportBar from '../time/TransportBar';
import ExportButton from './ExportButton';
import FovPresets from './FovPresets';
import NightControls from './NightControls';
import { DESKTOP_QUERY, useMediaQuery } from './useMediaQuery';

// The top bar (VIEW-5, plan D112): the `banner` landmark holding search, the time readout and
// the transport (desktop only: the phone shows them in the sheet strip), the field-of-view
// presets, night mode, share, language, export and About. It wraps on narrow screens and floats
// over the sky; the empty space around it lets gestures through (the parent is
// `pointer-events-none`, the bar itself `pointer-events-auto`).

export interface TopBarProps {
  store: SkyStore;
}

export default function TopBar({ store }: TopBarProps) {
  const { t } = useTranslation();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const { actions } = store.getState();
  return (
    <header className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-lg bg-panel-bg p-1.5 text-panel-fg shadow-lg">
      <SearchBox store={store} />
      {desktop && (
        <>
          <TimeReadout store={store} />
          <TransportBar store={store} />
        </>
      )}
      <FovPresets store={store} />
      <NightControls store={store} />
      <ShareButton store={store} />
      <LanguageToggle store={store} />
      <ExportButton store={store} />
      <IconButton
        icon={Info}
        label={t('about.title')}
        onClick={() => {
          actions.openDialog('about');
        }}
      />
      <AboutDialog store={store} />
    </header>
  );
}
