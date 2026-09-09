import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { SkyStore } from '../state/storeTypes';
import type { BootPhase, BootState } from '../state/types';

// The splash shown while the sky boots (plan D87; brief l.65-66, l.80): one line per phase, the
// current one carrying its detail (download progress, the bootstrap's fatal reason, the retry
// countdown while the API is unreachable) and, when the boot cannot continue, the reason
// (UX-6 text for a browser without WebGL2). Everything is read from the store; the component
// renders nothing once the first frame is on screen. The M4 banners take over the error cases.

export interface BootStatusProps {
  store: SkyStore;
}

/** The phases shown as lines, in boot order (`ready` hides the splash, `error` keeps the last). */
const PHASES: readonly BootPhase[] = ['health', 'meta', 'catalogs', 'frame'];

const BYTES_PER_MB = 1_000_000;

/** Complete literal class strings (brief l.550: Tailwind generates no concatenated names). */
function lineClass(done: boolean, active: boolean): string {
  if (done) {
    return 'opacity-60 line-through';
  }
  return active ? 'font-medium' : 'opacity-40';
}

function phaseIndex(phase: BootPhase): number {
  const index = PHASES.indexOf(phase);
  // `error` keeps the last phase reached (the boot writes the error without a phase rewind).
  return index < 0 ? PHASES.length : index;
}

export default function BootStatus({ store }: BootStatusProps) {
  const { t } = useTranslation();
  const { boot, healthStatus } = useStore(
    store,
    useShallow((s) => ({ boot: s.boot, healthStatus: s.health?.status ?? null })),
  );
  const retryAtMs = boot.error?.kind === 'unreachable' ? boot.retryAtMs : null;
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (retryAtMs === null) {
      return;
    }
    // A timer, not derived state: the countdown is the only thing on the page that moves while
    // the API is unreachable, and the store does not tick (plan D80).
    const tick = (): void => {
      setSecondsLeft(Math.max(0, Math.ceil((retryAtMs - Date.now()) / 1000)));
    };
    const first = window.setTimeout(tick, 0);
    const interval = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [retryAtMs]);

  if (boot.phase === 'ready') {
    return null;
  }

  /** The `/health` line: connecting, starting with progress, or the reason it stalls. */
  function healthLine(): string {
    const { error, progress } = boot;
    if (error?.kind === 'unreachable') {
      return t('boot.unreachable', { seconds: secondsLeft });
    }
    if (error?.kind === 'fatal') {
      return t('boot.failed', { detail: error.detail });
    }
    if (progress !== null) {
      return progress.totalBytes > 0
        ? t('boot.downloading', {
            file: progress.file,
            percent: Math.floor((100 * progress.downloadedBytes) / progress.totalBytes),
          })
        : t('boot.downloadingBytes', {
            file: progress.file,
            mb: (progress.downloadedBytes / BYTES_PER_MB).toFixed(1),
          });
    }
    return healthStatus === null ? t('boot.connecting') : t('boot.starting');
  }

  /** The line of one phase; only the active line carries the moving detail. */
  function lineFor(phase: BootPhase, active: boolean): string {
    switch (phase) {
      case 'health':
        return active ? healthLine() : t('boot.connecting');
      case 'meta':
        return t('boot.meta');
      case 'catalogs':
        return t('boot.catalogs');
      default:
        return t('boot.frame');
    }
  }

  /** The reason a boot in the `error` phase stopped; `null` while it is still running. */
  function errorLine(error: BootState['error']): string | null {
    if (boot.phase !== 'error' || error === null) {
      return null;
    }
    switch (error.kind) {
      case 'webgl2':
        return t('engine.unsupported');
      case 'http':
        return t('boot.failed', { detail: `HTTP ${String(error.status)}` });
      case 'fatal':
        return t('boot.failed', { detail: error.detail });
      default:
        return t('boot.unreachable', { seconds: secondsLeft });
    }
  }

  const current = phaseIndex(boot.phase);
  const failure = errorLine(boot.error);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t('boot.label')}
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-8 bg-sky-bg/90 px-6 text-center text-sky-fg"
    >
      <div>
        <p className="text-4xl font-semibold tracking-wide">{t('app.title')}</p>
        <p className="mt-3 text-lg opacity-80">{t('app.tagline')}</p>
      </div>
      <ol className="flex flex-col gap-1 text-sm">
        {PHASES.map((phase, index) => {
          const done = index < current;
          const active = index === current && failure === null;
          return (
            <li
              key={phase}
              aria-current={active ? 'step' : undefined}
              className={lineClass(done, active)}
            >
              {lineFor(phase, active)}
            </li>
          );
        })}
      </ol>
      {failure !== null && <p className="max-w-prose text-sky-warn">{failure}</p>}
    </div>
  );
}
