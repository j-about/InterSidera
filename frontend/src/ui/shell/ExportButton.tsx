import { Download } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { snapshotIsoUtc } from '../../state/snapshotTime';
import type { SkyStore } from '../../state/storeTypes';
import IconButton from '../components/IconButton';
import { useEngine } from './EngineContext';

// PNG export (VIEW-6 [S], simplified, plan D112, backlog B-67): `engine.snapshot()` composites
// the rendering canvas and the label overlay into a PNG; the blob is offered as a download
// named after the rendered (simulated) UTC instant through an object URL revoked afterwards. A
// failure (no engine yet, a disposed or failed engine, the 2 s timeout) shows a toast and an
// inline alert. No astronomy here: `state/snapshotTime.ts` hands over the ISO string and the
// file name helper only formats it.

export interface ExportButtonProps {
  store: SkyStore;
}

/** `intersidera-<UTC ISO without colons or milliseconds>.png`: `:` is illegal in file names. */
export function snapshotFilename(isoUtc: string): string {
  return `intersidera-${isoUtc.replace(/\.\d+(?=Z$)/, '').replace(/:/g, '')}.png`;
}

/** How long the object URL outlives the click: the browser reads it as the download starts. */
const REVOKE_DELAY_MS = 1000;

export function downloadBlob(blob: Blob, filename: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.hidden = true;
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, REVOKE_DELAY_MS);
}

export default function ExportButton({ store }: ExportButtonProps) {
  const { t } = useTranslation();
  const engine = useEngine();
  const [busy, setBusy] = useState(false);
  const { actions } = store.getState();

  const onClick = (): void => {
    if (engine === null) {
      actions.showToast('export.failed');
      return;
    }
    setBusy(true);
    engine
      .snapshot()
      .then((blob) => {
        const { clock } = store.getState();
        downloadBlob(blob, snapshotFilename(snapshotIsoUtc(clock, Date.now())));
      })
      .catch(() => {
        actions.showToast('export.failed');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <IconButton icon={Download} label={t('export.button')} disabled={busy} onClick={onClick} />
  );
}
