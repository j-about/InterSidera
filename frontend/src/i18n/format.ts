// Number and date formatting of the UI (UX-1, plan D109): `Intl` with the current i18next
// language for every number, the project's own year formatter for calendar years (Intl prints
// negative years without a sign, brief l.553), the unit symbols from the resource files ("au" is
// "ua" in French). This is the only module UI components use for numbers: they never import
// `sky/math` themselves (ESLint block F), so the TT -> calendar conversion lives here.

import i18next from 'i18next';

import { calendarFromJd, formatYear, isoUtcFromTt } from '../sky/math/time';
import type { CalendarFields } from '../sky/math/time';

/** Shown for an unknown value (`NaN`, `null`): an em dash, no words to translate. */
export const UNKNOWN_VALUE = '—';

/** The astronomical unit in kilometres (IAU 2012 definition; a unit conversion, not astronomy). */
export const AU_KM = 149_597_870.7;

const formatters = new Map<string, Intl.NumberFormat>();

/** The language numbers are formatted in (`i18next.language` once initialised, else English). */
export function currentLanguage(): string {
  const lang = i18next.resolvedLanguage ?? i18next.language;
  return lang === '' ? 'en' : lang;
}

function numberFormat(lang: string, digits: number): Intl.NumberFormat {
  const key = `${lang}:${String(digits)}`;
  let format = formatters.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(lang, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      // A value rounding to zero prints without a sign (`-0.004` -> `0.00`).
      signDisplay: 'negative',
    });
    formatters.set(key, format);
  }
  return format;
}

/** A plain number with exactly `digits` decimals in the current language (`NaN` -> the dash). */
export function formatNumber(value: number, digits: number, lang = currentLanguage()): string {
  if (!Number.isFinite(value)) {
    return UNKNOWN_VALUE;
  }
  return numberFormat(lang, digits).format(value);
}

/** Degrees with a fixed number of decimals: `21.63°`. */
export function formatDegrees(deg: number, digits = 2, lang = currentLanguage()): string {
  if (!Number.isFinite(deg)) {
    return UNKNOWN_VALUE;
  }
  return `${formatNumber(deg, digits, lang)}${i18next.t('units.deg')}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Sexagesimal degrees, rounded to the arcsecond with the carry handled: `-16° 43′ 40″`. */
export function formatDms(deg: number, lang = currentLanguage()): string {
  if (!Number.isFinite(deg)) {
    return UNKNOWN_VALUE;
  }
  const total = Math.round(Math.abs(deg) * 3600);
  const d = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const sign = deg < 0 && total > 0 ? '-' : '';
  return `${sign}${formatNumber(d, 0, lang)}${i18next.t('units.deg')} ${pad2(m)}${i18next.t('units.arcmin')} ${pad2(s)}${i18next.t('units.arcsec')}`;
}

/** Right ascension in hours, minutes and seconds (one decimal) from degrees: `06h 45m 08.9s`. */
export function formatHms(raDeg: number, lang = currentLanguage()): string {
  if (!Number.isFinite(raDeg)) {
    return UNKNOWN_VALUE;
  }
  const hours = (((raDeg / 15) % 24) + 24) % 24;
  // Tenths of a second, so the carry into the next minute or hour is exact.
  const tenths = Math.round(hours * 36000) % 864000;
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const s = (tenths % 600) / 10;
  const seconds = formatNumber(s, 1, lang).padStart(4, '0');
  return `${pad2(h)}${i18next.t('units.h')} ${pad2(m)}${i18next.t('units.min')} ${seconds}${i18next.t('units.s')}`;
}

/** An angular size in the natural unit: degrees above 1°, else arcminutes above 1′, else arcseconds. */
export function formatAngularSize(deg: number, lang = currentLanguage()): string {
  if (!Number.isFinite(deg)) {
    return UNKNOWN_VALUE;
  }
  if (deg >= 1) {
    return formatDegrees(deg, 2, lang);
  }
  const arcmin = deg * 60;
  if (arcmin >= 1) {
    return `${formatNumber(arcmin, 1, lang)}${i18next.t('units.arcmin')}`;
  }
  return `${formatNumber(arcmin * 60, 1, lang)}${i18next.t('units.arcsec')}`;
}

/** A distance in au (three decimals below 100 au, one above) or in kilometres (the Moon). */
export function formatDistance(au: number, unit: 'au' | 'km', lang = currentLanguage()): string {
  if (!Number.isFinite(au)) {
    return UNKNOWN_VALUE;
  }
  if (unit === 'km') {
    return `${formatNumber(au * AU_KM, 0, lang)} ${i18next.t('units.km')}`;
  }
  return `${formatNumber(au, au >= 100 ? 1 : 3, lang)} ${i18next.t('units.au')}`;
}

/** A fraction in `[0, 1]` as a percentage without decimals. */
export function formatPercent(fraction: number, lang = currentLanguage()): string {
  if (!Number.isFinite(fraction)) {
    return UNKNOWN_VALUE;
  }
  return new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 0 }).format(
    fraction,
  );
}

/** An apparent magnitude with one decimal. */
export function formatMagnitude(mag: number, lang = currentLanguage()): string {
  return formatNumber(mag, 1, lang);
}

// Scratch calendar of the year lookups (UI cadence; kept out of the allocation path anyway).
const scratch: CalendarFields = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };

/** The signed, four-digit calendar year of a Julian Date (TT or UTC): `-0044`, `2024`. */
export function formatYearOfJd(jd: number): string {
  if (!Number.isFinite(jd)) {
    return UNKNOWN_VALUE;
  }
  return formatYear(calendarFromJd(scratch, jd).year);
}

/** `YYYY-MM-DD` in UTC of a TT instant (the elements epoch of a minor body). */
export function formatDateOfTt(tt: number, ttMinusUtc: number): string {
  if (!Number.isFinite(tt) || !Number.isFinite(ttMinusUtc)) {
    return UNKNOWN_VALUE;
  }
  return isoUtcFromTt(tt, ttMinusUtc).slice(0, 10);
}

/** `YYYY-MM-DD hh:mm:ss` in UTC of a TT instant (`ttMinusUtc` from the current frame). */
export function formatUtc(tt: number, ttMinusUtc: number): string {
  if (!Number.isFinite(tt) || !Number.isFinite(ttMinusUtc)) {
    return UNKNOWN_VALUE;
  }
  return isoUtcFromTt(tt, ttMinusUtc).replace('T', ' ').replace(/Z$/, '');
}
