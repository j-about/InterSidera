import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { bodyName, constellationName } from '../../i18n/keys';
import { buildSearchIndex, searchIndex } from '../../search/index';
import type { SearchHit } from '../../search/index';
import { IDLE_MINOR_SEARCH, createMinorSearch } from '../../search/minorSearch';
import type { MinorSearch, MinorSearchState } from '../../search/minorSearch';
import type { SkyStore } from '../../state/storeTypes';

// The unified search (INFO-2, plan D107): a combobox over the local index (stars, deep-sky
// objects, planets, constellations from the catalogs in the browser, rebuilt when the language
// or the observer body changes) plus the minor bodies through `/minor-bodies/search` (debounced,
// gated, only when the server serves the MPC tables). Choosing a hit centres the view through
// the store (`requestCentre`, served by the engine) and selects it; a constellation only centres
// (no `sel` syntax exists for it, backlog B-62); a minor body is pinned first. WAI-ARIA combobox
// pattern: the input is the combobox, the list a listbox of options, arrows/Enter/Escape on the
// input; options are chosen on pointer down so the input keeps the focus.

export interface SearchBoxProps {
  store: SkyStore;
}

export const SEARCH_LIMIT = 8;

/** Complete literal class strings (brief l.550). */
function optionClass(active: boolean): string {
  return active
    ? 'flex cursor-pointer items-baseline gap-2 rounded-md bg-accent/30 px-2 py-1'
    : 'flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1 hover:bg-accent/15';
}

function normalizedQuery(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export default function SearchBox({ store }: SearchBoxProps) {
  const { t } = useTranslation();
  const { bundle, observerBody, bodies, minorAvailable } = useStore(
    store,
    useShallow((s) => ({
      bundle: s.bundle,
      observerBody: s.observer.body,
      bodies: s.meta?.bodies ?? null,
      // `null` until `/meta` answers: unknown, neither searched nor announced as missing.
      minorAvailable:
        s.meta === null
          ? null
          : s.meta.catalogs.minor_bodies !== undefined && s.meta.catalogs.minor_bodies !== null,
    })),
  );
  const { actions } = store.getState();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  /** Index of the highlighted option, -1 for none (the input itself). */
  const [active, setActive] = useState(-1);
  const [minor, setMinor] = useState<MinorSearchState>(IDLE_MINOR_SEARCH);
  const searcherRef = useRef<MinorSearch | null>(null);

  useEffect(() => {
    const searcher = createMinorSearch(setMinor);
    searcherRef.current = searcher;
    return () => {
      searcher.dispose();
      searcherRef.current = null;
    };
  }, []);
  useEffect(() => {
    searcherRef.current?.setEnabled(minorAvailable === true);
  }, [minorAvailable]);

  // Rebuilt when the catalogs, the bodies, the observer body or the language change (plan D107):
  // react-i18next hands out a new `t` on every language change, so it stands for the language.
  const index = useMemo(() => {
    if (bundle === null || bodies === null) {
      return null;
    }
    return buildSearchIndex(bundle, bodies, observerBody, {
      constellation: (abbr) => constellationName(abbr, t),
      body: (id) => bodyName(id, t),
    });
  }, [bundle, bodies, observerBody, t]);

  const localHits = useMemo(
    () => (index === null ? [] : searchIndex(index, query, SEARCH_LIMIT)),
    [index, query],
  );
  const trimmed = normalizedQuery(query);
  const minorHits = minor.status === 'ready' && minor.query === trimmed ? minor.hits : [];
  const options: readonly SearchHit[] = [...localHits, ...minorHits];
  const listOpen = open && trimmed !== '';
  const activeId =
    listOpen && active >= 0 && active < options.length ? `${listId}-${String(active)}` : undefined;

  const choose = (hit: SearchHit): void => {
    switch (hit.kind) {
      case 'constellation':
        // Centring only: the `sel` syntax has no constellation form (backlog B-62).
        actions.requestCentre(hit.id);
        break;
      case 'minor':
        if (!actions.pinMinor(hit.id)) {
          actions.showToast('search.minorCapReached');
        }
        // A pin only reaches `/sky/frame` (and so the sky, the marker and the details name)
        // while the minor-body layer is on (plan D102): choosing one switches the layer on.
        if (!store.getState().layers.minor) {
          actions.setLayer('minor', true);
        }
        actions.requestCentre(hit.id);
        actions.select(hit.id);
        actions.setUi({ panel: 'details' });
        break;
      default:
        actions.requestCentre(hit.id);
        actions.select(hit.id);
        actions.setUi({ panel: 'details' });
    }
    setQuery(hit.label);
    setOpen(false);
    setActive(-1);
    // The label was never searched: the minor half goes idle and is asked again on re-focus.
    searcherRef.current?.query('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setOpen(true);
        setActive((current) => Math.min(current + 1, options.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((current) => Math.max(current - 1, -1));
        break;
      case 'Enter': {
        const hit = options[active >= 0 ? active : 0];
        if (listOpen && hit !== undefined) {
          event.preventDefault();
          choose(hit);
        }
        break;
      }
      case 'Escape':
        if (listOpen) {
          event.preventDefault();
          setOpen(false);
        } else if (query !== '') {
          event.preventDefault();
          setQuery('');
          searcherRef.current?.query('');
        }
        break;
      default:
    }
  };

  /** The minor-body line under the options (the only asynchronous half of the search). */
  const minorLine = (): string | null => {
    if (trimmed.length < 2 || minorAvailable === null) {
      return null;
    }
    if (!minorAvailable) {
      return t('search.minorUnavailable');
    }
    switch (minor.status) {
      case 'pending':
      case 'searching':
        return t('search.minorSearching');
      case 'error':
        return t('search.minorError');
      case 'unavailable':
        return t('search.minorUnavailable');
      case 'ready':
        return minor.hits.length === 0 ? t('search.minorNoResults') : null;
      default:
        return null;
    }
  };
  const minorText = listOpen ? minorLine() : null;

  return (
    <div
      className="relative"
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node && event.currentTarget.contains(next))) {
          setOpen(false);
        }
      }}
    >
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={t('search.label')}
        placeholder={t('search.placeholder')}
        aria-expanded={listOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setQuery(value);
          setOpen(true);
          setActive(-1);
          searcherRef.current?.query(value);
        }}
        onFocus={() => {
          setOpen(true);
          // Re-issue the minor search for a text that stands (deduplicated by the searcher).
          searcherRef.current?.query(query);
        }}
        onKeyDown={onKeyDown}
        className="min-h-6 w-44 rounded-md border border-muted/60 bg-field-bg px-2 py-1 text-sm text-panel-fg placeholder:text-muted md:w-64 pointer-coarse:min-h-11"
      />
      <p className="sr-only" aria-live="polite">
        {listOpen ? t('search.resultsCount', { count: options.length }) : ''}
      </p>
      <div
        hidden={!listOpen}
        className="absolute top-full left-0 z-30 mt-1 w-[min(24rem,90vw)] rounded-lg border border-muted/40 bg-panel-bg p-1 text-sm text-panel-fg shadow-lg"
      >
        <ul id={listId} role="listbox" aria-label={t('search.results')} className="flex flex-col">
          {options.map((hit, i) => (
            <li
              key={hit.id}
              id={`${listId}-${String(i)}`}
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              data-hit-id={hit.id}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(hit);
              }}
              onMouseEnter={() => {
                setActive(i);
              }}
              className={optionClass(i === active)}
            >
              <span className="font-medium">{hit.label}</span>
              {hit.sub !== '' && <span className="truncate text-xs text-muted">{hit.sub}</span>}
              <span className="ml-auto shrink-0 text-xs text-muted">
                {t(`kinds.${hit.kindKey}`)}
              </span>
            </li>
          ))}
        </ul>
        {listOpen && options.length === 0 && minorText === null && (
          <p className="px-2 py-1 text-xs text-muted">{t('search.noResults')}</p>
        )}
        {minorText !== null && (
          <p className="px-2 py-1 text-xs text-muted">
            <span className="font-medium">{t('search.minorSection')}: </span>
            {minorText}
          </p>
        )}
      </div>
    </div>
  );
}
