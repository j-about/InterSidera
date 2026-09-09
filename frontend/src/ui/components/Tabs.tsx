import type { KeyboardEvent, ReactNode } from 'react';
import { useRef } from 'react';

import { cx } from './cx';

// The WAI-ARIA tabs pattern (plan D112): a `tablist` of `tab` buttons with a roving `tabIndex`
// (only the selected tab is in the Tab order; Arrow keys, Home and End move selection and focus,
// automatic activation), each `tabpanel` labelled by its tab and focusable so keyboard users can
// scroll it. Every panel stays mounted (hidden with the `hidden` attribute) so `aria-controls`
// always points at an existing element.

export interface TabItem<T extends string> {
  id: T;
  label: string;
  panel: ReactNode;
}

export interface TabsProps<T extends string> {
  /** Prefix of the generated element ids (`<idBase>-tab-<id>`, `<idBase>-panel-<id>`). */
  idBase: string;
  /** Accessible name of the tab list. */
  label: string;
  items: readonly TabItem<T>[];
  selected: T;
  onSelect: (id: T) => void;
  className?: string;
}

/** Complete literal class strings (brief l.550). */
function tabClass(selected: boolean): string {
  return selected
    ? 'min-h-6 flex-1 rounded-md border-b-2 border-accent px-2 py-1.5 text-sm font-medium whitespace-nowrap text-panel-fg select-none pointer-coarse:min-h-11'
    : 'min-h-6 flex-1 rounded-md border-b-2 border-transparent px-2 py-1.5 text-sm font-medium whitespace-nowrap text-muted select-none pointer-coarse:min-h-11 hover:text-panel-fg';
}

export default function Tabs<T extends string>({
  idBase,
  label,
  items,
  selected,
  onSelect,
  className,
}: TabsProps<T>) {
  // Lazily created: `useRef(new Map())` would allocate a discarded Map on every render.
  const buttonsRef = useRef<Map<T, HTMLButtonElement> | null>(null);
  const buttons = (): Map<T, HTMLButtonElement> => {
    buttonsRef.current ??= new Map<T, HTMLButtonElement>();
    return buttonsRef.current;
  };

  const activate = (index: number): void => {
    const item = items.at(((index % items.length) + items.length) % items.length);
    if (item === undefined) {
      return;
    }
    onSelect(item.id);
    buttons().get(item.id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        activate(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        activate(index - 1);
        break;
      case 'Home':
        activate(0);
        break;
      case 'End':
        activate(items.length - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div className={cx('flex flex-col', className)}>
      <div role="tablist" aria-label={label} className="flex gap-1 border-b border-muted/30">
        {items.map((item, index) => {
          const isSelected = item.id === selected;
          return (
            <button
              key={item.id}
              ref={(el) => {
                if (el === null) {
                  buttons().delete(item.id);
                } else {
                  buttons().set(item.id, el);
                }
              }}
              type="button"
              role="tab"
              id={`${idBase}-tab-${item.id}`}
              aria-selected={isSelected}
              aria-controls={`${idBase}-panel-${item.id}`}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => {
                onSelect(item.id);
              }}
              onKeyDown={(event) => {
                onKeyDown(event, index);
              }}
              className={tabClass(isSelected)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          role="tabpanel"
          id={`${idBase}-panel-${item.id}`}
          aria-labelledby={`${idBase}-tab-${item.id}`}
          tabIndex={0}
          hidden={item.id !== selected}
          className="flex flex-col gap-3 py-3"
        >
          {item.panel}
        </div>
      ))}
    </div>
  );
}
