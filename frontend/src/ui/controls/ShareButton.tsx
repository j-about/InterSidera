import { Share2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { defaultsUrlState, urlStateOf } from '../../state/store';
import type { SkyState, SkyStore } from '../../state/storeTypes';
import { serializeUrlState } from '../../state/url';
import IconButton from '../components/IconButton';

// The "copy link" button (UX-2 l.246, plan D110): the shareable URL is built from the serialised
// store, never from `location.href` (the dev/e2e `#engine` hash and any un-flushed query must not
// leak), written to the clipboard when the browser allows it, otherwise shown in a read-only,
// pre-selected field so the user copies it by hand; the outcome is announced through the toast.

export interface ShareButtonProps {
  store: SkyStore;
}

/** `origin + pathname + '?' + <canonical query>` of a state: the hash is dropped by construction. */
export function shareUrl(
  state: SkyState,
  loc: Pick<Location, 'origin' | 'pathname'> = location,
): string {
  const query = serializeUrlState(urlStateOf(state), defaultsUrlState());
  return `${loc.origin}${loc.pathname}${query === '' ? '' : `?${query}`}`;
}

export default function ShareButton({ store }: ShareButtonProps) {
  const { t } = useTranslation();
  const [fallback, setFallback] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { actions } = store.getState();

  useEffect(() => {
    if (fallback !== null) {
      const input = inputRef.current;
      input?.focus();
      input?.select();
    }
  }, [fallback]);

  const onClick = (): void => {
    const url = shareUrl(store.getState());
    // `navigator.clipboard` is absent outside secure contexts (the type says otherwise).
    const clipboard: Clipboard | undefined =
      'clipboard' in navigator ? navigator.clipboard : undefined;
    if (clipboard === undefined) {
      setFallback(url);
      actions.showToast('share.failed');
      return;
    }
    clipboard.writeText(url).then(
      () => {
        setFallback(null);
        actions.showToast('share.copied');
      },
      () => {
        setFallback(url);
        actions.showToast('share.failed');
      },
    );
  };

  return (
    <>
      <IconButton icon={Share2} label={t('share.button')} onClick={onClick} />
      {fallback !== null && (
        <input
          ref={inputRef}
          type="text"
          readOnly
          value={fallback}
          aria-label={t('share.urlLabel')}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          className="min-h-6 w-64 max-w-full rounded-md border border-muted/60 bg-field-bg px-2 py-1 text-xs text-panel-fg"
        />
      )}
    </>
  );
}
