import { Crosshair } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { CatalogBundle, DsoEntry } from '../../api/catalogs';
import {
  UNKNOWN_VALUE,
  formatAngularSize,
  formatDateOfTt,
  formatDegrees,
  formatDistance,
  formatDms,
  formatHms,
  formatMagnitude,
  formatNumber,
  formatPercent,
  formatUtc,
  formatYearOfJd,
} from '../../i18n/format';
import { bodyKindKey, bodyName, constellationName } from '../../i18n/keys';
import type { KindKey } from '../../i18n/keys';
import { spacedDsoId } from '../../search/normalize';
import type {
  DetailsState,
  MetaResponse,
  MinorBodySummary,
  SkyStore,
} from '../../state/storeTypes';
import type { MinorStatus, SelectionReadout } from '../../state/types';
import Button from '../components/Button';
import Switch from '../components/Switch';

// The details panel (INFO-1, plan D106): names and designations of the selection from the
// catalogs, its type and constellation (the catalog's at once, the authoritative one from
// `/sky/altaz` afterwards), the engine's interpolated readout (altitude, azimuth, distance,
// magnitude, phase, angular size, refreshed at 2 Hz) with the authoritative equatorial
// coordinates of the last server answer, the elements epoch and extrapolation of a minor body,
// a "centre" button and the follow switch (VIEW-4). Every number goes through `i18n/format.ts`;
// no astronomy is computed here.

export interface DetailsPanelProps {
  store: SkyStore;
}

const HIP_RE = /^hip:(\d+)$/;
const DSO_RE = /^dso:(.+)$/;
const SEPARATOR = ' · ';

/** What the catalogs say about a selected id: how to name it and what it is. */
export interface SelectionNames {
  title: string;
  designations: readonly string[];
  kindKey: KindKey | null;
  /** The DSO row, when the selection is a deep-sky object (its type is shown instead of `kinds.dso`). */
  dso: DsoEntry | null;
}

function findDso(bundle: CatalogBundle | null, ref: string): DsoEntry | null {
  const entries = bundle?.dso?.data;
  if (entries === undefined) {
    return null;
  }
  const upper = ref.toUpperCase();
  const messier = /^M0*(\d+)$/i.exec(ref);
  const number = messier === null ? null : Number(messier[1]);
  return (
    entries.find(
      (entry) =>
        entry.id.toUpperCase() === upper ||
        (number !== null && entry.messier !== undefined && entry.messier === number),
    ) ?? null
  );
}

/** The names of a selection from the star index, the DSO catalog, `/meta.bodies` or the minor lists. */
export function selectionNames(
  id: string,
  bundle: CatalogBundle | null,
  meta: MetaResponse | null,
  minor: MinorStatus | null,
  summary: MinorBodySummary | null,
  t: TFunction,
): SelectionNames {
  const hip = HIP_RE.exec(id);
  if (hip !== null) {
    const n = Number(hip[1]);
    const star = bundle?.index.data.find((entry) => entry.hip === n) ?? null;
    const hipText = t('details.hip', { n });
    const designations: string[] = [];
    const proper = star?.names.proper ?? null;
    if (typeof star?.names.bayer === 'string' && star.names.bayer !== '') {
      designations.push(star.names.bayer);
    }
    if (typeof star?.names.flamsteed === 'string' && star.names.flamsteed !== '') {
      designations.push(star.names.flamsteed);
    }
    designations.push(hipText);
    const title = proper !== null && proper !== '' ? proper : (designations.shift() ?? hipText);
    return { title, designations, kindKey: 'star', dso: null };
  }
  const dsoRef = DSO_RE.exec(id);
  if (dsoRef !== null) {
    const dso = findDso(bundle, dsoRef[1] ?? '');
    if (dso === null) {
      return { title: spacedDsoId(dsoRef[1] ?? ''), designations: [], kindKey: 'dso', dso: null };
    }
    const names = dso.names.filter((name) => name !== '');
    const designations: string[] = [];
    if (dso.messier !== undefined && dso.messier !== null) {
      designations.push(t('details.messier', { n: dso.messier }));
    }
    designations.push(spacedDsoId(dso.id));
    designations.push(...names.slice(1));
    const title = names[0] ?? designations.shift() ?? dso.id;
    return { title, designations, kindKey: 'dso', dso };
  }
  if (id.startsWith('a:') || id.startsWith('c:')) {
    const name = minor?.name ?? summary?.name ?? null;
    const designation = summary?.designation ?? null;
    const kind = minor?.kind ?? summary?.kind ?? (id.startsWith('a:') ? 'asteroid' : 'comet');
    const designations: string[] = [];
    if (designation !== null && designation !== name) {
      designations.push(designation);
    }
    designations.push(id);
    const title = name ?? designations.shift() ?? id;
    return {
      title,
      designations,
      kindKey: kind === 'comet' ? 'comet' : 'asteroid',
      dso: null,
    };
  }
  const body = meta?.bodies.find((entry) => entry.id === id) ?? null;
  return {
    title: bodyName(id, t),
    designations: [],
    kindKey: body === null ? null : bodyKindKey(body),
    dso: null,
  };
}

/** The message of a failed `/sky/altaz` request (docs/api.md problem types). */
export function errorText(t: TFunction, error: NonNullable<DetailsState['error']>): string {
  switch (error.status) {
    case 400:
      return t('details.invalid');
    case 404:
      return t('details.unknown');
    case 422:
      return t('details.outsideCoverage', {
        start: error.rangeTt === undefined ? UNKNOWN_VALUE : formatYearOfJd(error.rangeTt[0]),
        end: error.rangeTt === undefined ? UNKNOWN_VALUE : formatYearOfJd(error.rangeTt[1]),
      });
    case 503:
      return t('details.dataMissing');
    default:
      return t('details.unreachable');
  }
}

/** A readout channel when the engine has it, else the server's value, else `NaN`. */
function channel(
  readout: SelectionReadout | null,
  value: number | null | undefined,
  pick: (r: SelectionReadout) => number,
): number {
  if (readout !== null) {
    const live = pick(readout);
    if (Number.isFinite(live)) {
      return live;
    }
  }
  return value ?? NaN;
}

interface RowProps {
  label: string;
  value: string;
}

function Row({ label, value }: RowProps) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </div>
  );
}

export default function DetailsPanel({ store }: DetailsPanelProps) {
  const { t } = useTranslation();
  const { selection, details, readout, bundle, meta, minorStatuses, defaults, follow, ttMinusUtc } =
    useStore(
      store,
      useShallow((s) => ({
        selection: s.selection,
        details: s.details,
        readout: s.readout,
        bundle: s.bundle,
        meta: s.meta,
        minorStatuses: s.frames.minor,
        defaults: s.minorBodies.defaults,
        follow: s.follow,
        ttMinusUtc: s.clock.ttMinusUtc,
      })),
    );
  const { actions } = store.getState();

  const minor = useMemo(
    () => minorStatuses.find((status) => status.id === selection) ?? null,
    [minorStatuses, selection],
  );
  const summary = useMemo(
    () => defaults?.find((entry) => entry.id === selection) ?? null,
    [defaults, selection],
  );
  const names = useMemo(
    () => (selection === null ? null : selectionNames(selection, bundle, meta, minor, summary, t)),
    [selection, bundle, meta, minor, summary, t],
  );

  if (selection === null || names === null) {
    return <p className="text-sm text-muted">{t('details.none')}</p>;
  }

  const entry = details.id === selection ? details.entry : null;
  const live = readout !== null && readout.valid && readout.id === selection ? readout : null;
  const alt = channel(live, entry?.alt_deg, (r) => r.alt);
  const az = channel(live, entry?.az_deg, (r) => r.az);
  const dist = channel(live, entry?.dist_au, (r) => r.distAu);
  const mag = channel(live, entry?.mag, (r) => r.mag);
  const phase = channel(live, entry?.phase, (r) => r.phase);
  const diam = channel(live, entry?.diam_deg, (r) => r.diamDeg);
  const con = details.id === selection ? details.con : null;
  const constellation =
    con === null ? null : (bundle?.constellations?.data.find((c) => c.abbr === con) ?? null);
  const conName = con === null ? null : constellationName(con, t);
  const conText =
    con === null
      ? UNKNOWN_VALUE
      : constellation === null
        ? (conName ?? con)
        : conName === constellation.latin
          ? `${constellation.latin} (${constellation.genitive})`
          : `${conName ?? con} (${constellation.latin}, ${constellation.genitive})`;
  const typeText =
    names.dso !== null
      ? t(`dsoTypes.${names.dso.type}`)
      : names.kindKey === null
        ? UNKNOWN_VALUE
        : t(`kinds.${names.kindKey}`);
  const error = details.id === selection ? details.error : null;
  const loading = details.id === selection && details.status === 'loading' && entry === null;

  return (
    <div className="flex flex-col gap-3 text-sm text-panel-fg">
      <div>
        <h3 className="text-base font-semibold">{names.title}</h3>
        {names.designations.length > 0 && (
          <p className="text-muted">
            <span className="sr-only">{t('details.designations')}: </span>
            {names.designations.join(SEPARATOR)}
          </p>
        )}
      </div>
      <dl className="flex flex-col gap-1">
        <Row label={t('details.type')} value={typeText} />
        <Row label={t('details.constellation')} value={conText} />
        <Row label={t('details.altitude')} value={formatDegrees(alt)} />
        <Row label={t('details.azimuth')} value={formatDegrees(az)} />
        <Row label={t('details.raIcrs')} value={formatHms(entry?.ra_icrs_deg ?? NaN)} />
        <Row label={t('details.decIcrs')} value={formatDms(entry?.dec_icrs_deg ?? NaN)} />
        <Row label={t('details.raDate')} value={formatHms(entry?.ra_date_deg ?? NaN)} />
        <Row label={t('details.decDate')} value={formatDms(entry?.dec_date_deg ?? NaN)} />
        {Number.isFinite(dist) && (
          <Row
            label={t('details.distance')}
            value={formatDistance(dist, selection === 'moon' ? 'km' : 'au')}
          />
        )}
        <Row label={t('details.magnitude')} value={formatMagnitude(mag)} />
        {Number.isFinite(phase) && <Row label={t('details.phase')} value={formatPercent(phase)} />}
        {Number.isFinite(diam) && (
          <Row label={t('details.angularSize')} value={formatAngularSize(diam)} />
        )}
        {minor !== null && (
          <Row
            label={t('details.elementsEpoch')}
            value={formatDateOfTt(minor.elementsEpochTt, ttMinusUtc)}
          />
        )}
      </dl>
      {minor !== null && minor.extrapolationYears > 0 && (
        <p className="text-xs text-warn">
          {t('details.extrapolation', { years: formatNumber(minor.extrapolationYears, 1) })}
        </p>
      )}
      <p className="text-xs text-muted" aria-live="polite">
        {error !== null
          ? errorText(t, error)
          : loading
            ? t('details.loading')
            : entry !== null
              ? t('details.authoritative', { time: formatUtc(details.tt, ttMinusUtc) })
              : ''}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={() => {
            actions.requestCentre(selection);
          }}
        >
          <Crosshair size={16} />
          {t('details.centre')}
        </Button>
        <Switch
          label={t('details.follow')}
          checked={follow}
          onChange={(on) => {
            actions.setFollow(on);
          }}
        />
      </div>
    </div>
  );
}
