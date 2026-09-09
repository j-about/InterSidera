import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';

import type { SkyStore } from '../../state/storeTypes';
import { LANGS } from '../../state/types';
import Button from '../components/Button';

// The manual language toggle (UX-1, plan D109): one pressed button per supported language in a
// named group; the choice is written to `options.lang` (and so to the URL), `state/domSync.ts`
// applies it to i18next and `<html lang>`. Each button carries its own `lang` attribute so a
// screen reader pronounces "Français" in French whatever the page language.

export interface LanguageToggleProps {
  store: SkyStore;
}

export default function LanguageToggle({ store }: LanguageToggleProps) {
  const { t } = useTranslation();
  const lang = useStore(store, (s) => s.options.lang);
  const { actions } = store.getState();
  return (
    <div role="group" aria-label={t('lang.label')} className="flex items-center gap-0.5">
      {LANGS.map((candidate) => (
        <Button
          key={candidate}
          variant="ghost"
          lang={candidate}
          aria-pressed={candidate === lang}
          onClick={() => {
            if (candidate !== lang) {
              actions.setOptions({ lang: candidate });
            }
          }}
        >
          {t(`lang.${candidate}`)}
        </Button>
      ))}
    </div>
  );
}
