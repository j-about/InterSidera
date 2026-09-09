import { CircleAlert, Info, TriangleAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { cx } from './cx';
import IconButton from './IconButton';

// A live message (UX-6, plan D111, D112): `role="status"` (polite) or `role="alert"` (assertive),
// an icon plus text so the tone never rests on colour alone, an optional title that names the
// region (so tests and assistive technology can tell the banners apart), optional actions and a
// dismiss button. It takes pointer events itself: the chrome column it usually floats in lets
// gestures through to the sky (`pointer-events-none`), and its buttons must stay clickable.

export type BannerTone = 'info' | 'warn' | 'danger';

export interface BannerProps {
  /** `status` for information, `alert` for a failure the user must know about now. */
  kind: 'status' | 'alert';
  tone?: BannerTone;
  /** Short heading; becomes the accessible name of the region. */
  title?: string;
  children: ReactNode;
  /** Buttons rendered after the text (retry, reload, ...). */
  actions?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}

/** Complete literal class strings (brief l.550). */
function toneClass(tone: BannerTone): string {
  switch (tone) {
    case 'warn':
      return 'border-warn/60';
    case 'danger':
      return 'border-danger/60';
    default:
      return 'border-accent/40';
  }
}

/** The icon of a tone, as an element (no component chosen at render time). */
function toneIcon(tone: BannerTone): ReactNode {
  switch (tone) {
    case 'warn':
      return <TriangleAlert size={18} className="mt-0.5 shrink-0 text-warn" />;
    case 'danger':
      return <CircleAlert size={18} className="mt-0.5 shrink-0 text-danger" />;
    default:
      return <Info size={18} className="mt-0.5 shrink-0 text-accent" />;
  }
}

export default function Banner({
  kind,
  tone = 'info',
  title,
  children,
  actions,
  onDismiss,
  className,
}: BannerProps) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <div
      role={kind}
      aria-labelledby={title !== undefined ? titleId : undefined}
      className={cx(
        'pointer-events-auto flex items-start gap-2 rounded-lg border bg-panel-bg p-3 text-sm text-panel-fg shadow-lg',
        toneClass(tone),
        className,
      )}
    >
      {toneIcon(tone)}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title !== undefined && (
          <p id={titleId} className="font-semibold">
            {title}
          </p>
        )}
        <div>{children}</div>
        {actions !== undefined && <div className="flex flex-wrap gap-2 pt-1">{actions}</div>}
      </div>
      {onDismiss !== undefined && (
        <IconButton icon={X} label={t('banner.dismiss')} size="sm" onClick={onDismiss} />
      )}
    </div>
  );
}
