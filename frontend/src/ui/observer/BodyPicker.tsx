import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { coverageYears, observerCoverage } from '../../state/coverage';
import { isObserverId } from '../../state/presets';
import type { ObserverId } from '../../state/presets';
import type { SkyStore } from '../../state/storeTypes';
import Select from '../components/Select';
import type { SelectOption } from '../components/Select';

// The observer body (OBS-5, brief l.194; plan D96): a native select over `/meta.observers`
// (labels through `t(\`bodies.${id}\`)`, the contract's `name_key`), switching keeps the
// latitude, longitude and elevation; under it the latitude convention, the coverage as signed
// years and the approximation note of the body when the contract marks one.

export interface BodyPickerProps {
  store: SkyStore;
}

export default function BodyPicker({ store }: BodyPickerProps) {
  const { t } = useTranslation();
  const { observer, meta } = useStore(
    store,
    useShallow((s) => ({ observer: s.observer, meta: s.meta })),
  );
  const { actions } = store.getState();

  // Before `/meta` the current body is the only option (its label when the id is a known one).
  const ids: readonly ObserverId[] =
    meta === null
      ? isObserverId(observer.body)
        ? [observer.body]
        : []
      : meta.observers.map((o) => o.id);
  const options: SelectOption<string>[] = ids.map((id) => ({
    value: id,
    label: t(`bodies.${id}`),
  }));
  if (!ids.some((id) => id === observer.body)) {
    options.push({ value: observer.body, label: observer.body });
  }
  const entry = meta?.observers.find((o) => o.id === observer.body);
  const coverage = observerCoverage(meta, observer.body);
  const years = coverage === null ? null : coverageYears(coverage);
  const approximation = entry?.approximation_code ?? null;

  return (
    <div className="flex flex-col gap-1">
      <Select
        id="observer-body"
        label={t('observer.body')}
        value={observer.body}
        options={options}
        onChange={(body) => {
          actions.setObserver({ ...observer, body });
        }}
      />
      {entry !== undefined && (
        <p className="text-xs text-muted">{t(`observer.latitudeKind.${entry.latitude_kind}`)}</p>
      )}
      {years !== null && (
        <p className="text-xs text-muted" data-testid="observer-coverage">
          {t('observer.coverage', years)}
        </p>
      )}
      {approximation !== null && (
        <p className="text-xs text-warn">{t(`warnings.${approximation}`)}</p>
      )}
    </div>
  );
}
