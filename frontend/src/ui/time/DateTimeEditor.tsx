import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { coverageYears, observerCoverage, withinCoverage } from '../../state/coverage';
import type { SkyStore } from '../../state/storeTypes';
import {
  gregorianNoticeForTt,
  localCalendarOfTt,
  ttFromLocalCalendar,
  ttFromUtcCalendar,
  utcCalendarOfTt,
  validateFields,
  wholeSeconds,
} from '../../state/timeDisplay';
import type { CalendarFields, OffsetAt } from '../../state/timeDisplay';
import Button from '../components/Button';
import Dialog from '../components/Dialog';
import Switch from '../components/Switch';
import TextField from '../components/TextField';

// The date and time editor (TIME-2, brief l.202, l.526, l.553; plan D98): a modal with the six
// calendar fields (an integer year with its sign, astronomical numbering), a local/UTC switch,
// the valid range as signed years (ephemeris coverage intersected with the observer's), the
// proleptic Gregorian notice for dates before 1582-10-15, and Apply. An impossible date or a
// date outside the range is refused with a message (the URL is untouched); a valid one pauses
// the clock there. The draft is (re)built from the clock every time the dialog opens.
// Errors (WCAG 3.3.1, plan D157 C6): an impossible date marks the offending field
// (`validateFields` names it) through the field's own `error`, so it carries `aria-invalid`, is
// described by the message and announces it; a date outside the coverage is a property of the
// whole date, so it stays on the form-level alert under the fields (`apply` sets `range` only
// with a coverage, so `years` is non-null there). Any keystroke clears both.

export interface DateTimeEditorProps {
  store: SkyStore;
  /** Test injection of the zone (default the browser's). */
  offsetAt?: OffsetAt;
}

type Draft = Record<keyof CalendarFields, string>;

const FIELD_ORDER: readonly (keyof CalendarFields)[] = [
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
];

function draftOf(calendar: CalendarFields): Draft {
  const fields = wholeSeconds(calendar);
  return {
    year: String(fields.year),
    month: String(fields.month),
    day: String(fields.day),
    hour: String(fields.hour),
    minute: String(fields.minute),
    second: String(fields.second),
  };
}

/**
 * The draft as numbers (`NaN` for anything that is not a plain integer, so validation fails); the
 * typographic minus (U+2212) counts as a sign, as in the coordinate fields.
 */
function fieldsOf(draft: Draft): CalendarFields {
  const int = (text: string): number => {
    const plain = text.trim().replace(/\u2212/g, '-');
    return /^[-+]?\d+$/.test(plain) ? Number(plain) : NaN;
  };
  return {
    year: int(draft.year),
    month: int(draft.month),
    day: int(draft.day),
    hour: int(draft.hour),
    minute: int(draft.minute),
    second: int(draft.second),
  };
}

export default function DateTimeEditor({ store, offsetAt }: DateTimeEditorProps) {
  const { t } = useTranslation();
  const { open, tt, ttMinusUtc, meta, body } = useStore(
    store,
    useShallow((s) => ({
      open: s.ui.dialog === 'timeEditor',
      tt: s.clock.tt,
      ttMinusUtc: s.clock.ttMinusUtc,
      meta: s.meta,
      body: s.observer.body,
    })),
  );
  const { actions } = store.getState();
  const [local, setLocal] = useState(true);
  const [draft, setDraft] = useState<Draft>(() => draftOf(utcCalendarOfTt(tt, ttMinusUtc)));
  const [wasOpen, setWasOpen] = useState(false);
  const [error, setError] = useState<'range' | 'invalidDate' | null>(null);

  const calendarOf = (instant: number, useLocal: boolean): CalendarFields =>
    useLocal
      ? localCalendarOfTt(instant, ttMinusUtc, offsetAt).fields
      : utcCalendarOfTt(instant, ttMinusUtc);
  const ttOf = (fields: CalendarFields, useLocal: boolean): number =>
    useLocal
      ? ttFromLocalCalendar(fields, ttMinusUtc, offsetAt)
      : ttFromUtcCalendar(fields, ttMinusUtc);

  // Adjusting state on a prop change: the draft is rebuilt from the clock when the dialog opens.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDraft(draftOf(calendarOf(tt, local)));
      setError(null);
    }
  }

  const coverage = observerCoverage(meta, body);
  const years = coverage === null ? null : coverageYears(coverage);
  const fields = fieldsOf(draft);
  const invalid = validateFields(fields);
  const draftTt = invalid === null ? ttOf(fields, local) : NaN;
  const gregorianNotice = invalid === null && gregorianNoticeForTt(draftTt, ttMinusUtc);

  const apply = (): void => {
    if (invalid !== null) {
      setError('invalidDate');
      return;
    }
    if (coverage !== null && !withinCoverage(draftTt, coverage)) {
      setError('range');
      return;
    }
    actions.setTime(draftTt);
    actions.closeDialog();
  };

  const fieldError = (field: keyof CalendarFields): string | null =>
    error === 'invalidDate' && invalid === field ? t('time.error.invalidDate') : null;

  const labels: Record<keyof CalendarFields, string> = {
    year: t('time.year'),
    month: t('time.month'),
    day: t('time.day'),
    hour: t('time.hour'),
    minute: t('time.minute'),
    second: t('time.second'),
  };

  return (
    <Dialog
      open={open}
      title={t('time.editor')}
      onClose={() => {
        actions.closeDialog();
      }}
    >
      <form
        className="flex flex-col gap-3 pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <div className="grid grid-cols-3 gap-2">
          {FIELD_ORDER.map((field) => (
            <TextField
              key={field}
              id={`time-editor-${field}`}
              label={labels[field]}
              value={draft[field]}
              // The year takes a sign (astronomical years, brief l.575) and phone numeric keypads
              // have no minus key: a text keyboard there, like the coordinate fields.
              inputMode={field === 'year' ? 'text' : 'numeric'}
              autoComplete="off"
              spellCheck={false}
              error={fieldError(field)}
              onValueChange={(text) => {
                setDraft({ ...draft, [field]: text });
                setError(null);
              }}
            />
          ))}
        </div>
        <Switch
          label={t('time.useLocal')}
          checked={local}
          onChange={(useLocal) => {
            setLocal(useLocal);
            // A valid draft keeps its instant and shows it in the other scale.
            if (invalid === null) {
              setDraft(draftOf(calendarOf(draftTt, useLocal)));
            }
          }}
        />
        {years !== null && (
          <p className="text-xs text-muted" data-testid="time-editor-range">
            {t('time.range', years)}
          </p>
        )}
        {gregorianNotice && <p className="text-xs text-muted">{t('time.gregorianNotice')}</p>}
        {error === 'range' && years !== null && (
          <p role="alert" className="text-sm text-danger" data-testid="time-editor-error">
            {t('time.error.range', years)}
          </p>
        )}
        <div className="flex justify-end">
          <Button type="submit" variant="primary">
            {t('time.apply')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
