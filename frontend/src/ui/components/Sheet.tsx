import { ChevronDown, ChevronUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect } from 'react';

// The responsive panel body (VIEW-5, plan D112). Below `md` (48 rem) it is a bottom sheet: a
// tap-to-expand handle (`aria-expanded` / `aria-controls`), a strip of at least 4 rem that stays
// visible while collapsed (time and transport; it wraps rather than scrolling sideways, so a
// 320 px viewport never scrolls in two dimensions: WCAG 1.4.10, plan D157 C7) and a scrollable
// body. The parent caps the whole sheet (handle, strip and body together) at 70 dvh, so the body
// is the one part that shrinks (`min-h-0`, the handle and the strip `shrink-0`) and scrolls: a
// cap on the body alone let the wrapped strip push the sheet over the top bar's bottom row at
// 412x839 (WCAG 2.5.8, 2.4.11; plan D157 C7). Escape collapses
// it while `escapeCollapses` holds (the parent clears it on the desktop layout, where the same
// `expanded` flag only records the skip link's or `openPanel`'s intent). At `md` and above the
// handle and the strip disappear and the body always shows: the same DOM serves the side panel,
// so nothing is mounted twice. The parent positions it and owns the bottom safe-area inset (it
// must clear the strip too, not only the body).

export interface SheetProps {
  /** Id of the body, referenced by the handle's `aria-controls`. */
  id: string;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  expandLabel: string;
  collapseLabel: string;
  /** Shown in the collapsed strip on the phone only. */
  strip?: ReactNode;
  /** Whether Escape collapses the expanded sheet (default true; false on the desktop layout). */
  escapeCollapses?: boolean;
  children: ReactNode;
}

/** Controls whose own Escape handling (clear, cancel an edit) must not collapse the sheet. */
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** Complete literal class strings (brief l.550): hidden below `md` while collapsed. */
function bodyClass(expanded: boolean): string {
  return expanded
    ? 'block min-h-0 overflow-y-auto px-3 overscroll-contain touch-pan-y md:flex-1 md:pb-3'
    : 'hidden min-h-0 overflow-y-auto px-3 overscroll-contain touch-pan-y md:block md:flex-1 md:pb-3';
}

export default function Sheet({
  id,
  expanded,
  onToggle,
  expandLabel,
  collapseLabel,
  strip,
  escapeCollapses = true,
  children,
}: SheetProps) {
  useEffect(() => {
    if (!expanded || !escapeCollapses) {
      return;
    }
    // Escape collapses the sheet wherever the focus is inside it, including on its own handle
    // (the global shortcuts ignore focused controls), except while a modal dialog is up (the
    // dialog's own close watcher owns that key) or inside an editable control (Escape there
    // belongs to the field).
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      if (
        event.target instanceof Element &&
        (event.target.closest('dialog') !== null || event.target.closest(EDITABLE) !== null)
      ) {
        return;
      }
      onToggle(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded, escapeCollapses, onToggle]);

  const Chevron = expanded ? ChevronDown : ChevronUp;
  return (
    <>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={id}
        aria-label={expanded ? collapseLabel : expandLabel}
        onClick={() => {
          onToggle(!expanded);
        }}
        className="flex min-h-6 w-full shrink-0 items-center justify-center py-1 text-muted select-none hover:text-panel-fg md:hidden pointer-coarse:min-h-8"
      >
        <Chevron size={20} />
      </button>
      {strip !== undefined && (
        <div className="flex min-h-strip shrink-0 flex-wrap items-center gap-2 px-3 md:hidden">
          {strip}
        </div>
      )}
      <div id={id} className={bodyClass(expanded)}>
        {children}
      </div>
    </>
  );
}
