import { CalendarClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';

import type { SkyStore } from '../../state/storeTypes';
import Button from '../components/Button';
import Switch from '../components/Switch';
import CoverageBadges from './CoverageBadges';
import StepButtons from './StepButtons';

// The time panel (TIME-2..TIME-5, brief l.202-205; plan D98-D100): the button opening the date
// and time editor (the dialog itself is mounted by the transport bar, which the shell shows at
// all times), the step buttons, the coverage badges and the bound-stop banner, and the keyboard
// shortcut list with the WCAG 2.2 SC 2.1.4 switch that turns the single-key shortcuts off. The
// readout and the transport live in the top bar (desktop) or the sheet strip (phone).

export interface TimePanelProps {
  store: SkyStore;
}

export default function TimePanel({ store }: TimePanelProps) {
  const { t } = useTranslation();
  const shortcuts = useStore(store, (s) => s.ui.shortcuts);
  const { actions } = store.getState();
  // Literal keys so `scripts/check_i18n.mjs` sees every one (rules/frontend.md).
  const shortcutLines = [
    t('shortcuts.space'),
    t('shortcuts.slower'),
    t('shortcuts.faster'),
    t('shortcuts.stepBack'),
    t('shortcuts.stepForward'),
    t('shortcuts.now'),
    t('shortcuts.editor'),
    t('shortcuts.view'),
    t('shortcuts.escape'),
  ];
  return (
    <div className="flex flex-col gap-4">
      <Button
        variant="outline"
        aria-keyshortcuts="t"
        className="self-start"
        onClick={() => {
          actions.openDialog('timeEditor');
        }}
      >
        <CalendarClock size={16} aria-hidden="true" />
        {t('time.editor')}
      </Button>
      <StepButtons store={store} />
      <CoverageBadges store={store} />
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">{t('shortcuts.title')}</h3>
        <Switch
          label={t('shortcuts.toggle')}
          checked={shortcuts}
          onChange={(on) => {
            actions.setUi({ shortcuts: on });
          }}
        />
        <ul className="list-inside list-disc text-xs text-muted">
          {shortcutLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
