// @vitest-environment node
import i18next from 'i18next';

import { jdFromCalendar } from '../sky/math/time';
import {
  AU_KM,
  UNKNOWN_VALUE,
  currentLanguage,
  formatAngularSize,
  formatDateOfTt,
  formatDegrees,
  formatDistance,
  formatDms,
  formatHms,
  formatMagnitude,
  formatNumber,
  formatPercent,
  formatTimeOffset,
  formatUtc,
  formatYearOfJd,
} from './format';

// The test setup initialises i18next with the bundled resources (English by default).

describe('format', () => {
  afterEach(async () => {
    await i18next.changeLanguage('en');
  });

  it('formats numbers in the current language, with a French decimal comma', async () => {
    expect(currentLanguage()).toBe('en');
    expect(formatNumber(1234.5678, 2)).toBe('1,234.57');
    // French groups with a narrow no-break space (U+202F) and a decimal comma.
    expect(formatNumber(1234.5678, 2, 'fr')).toBe('1\u202f234,57');
    expect(formatNumber(-0, 2)).toBe('0.00');
    expect(formatNumber(NaN, 2)).toBe(UNKNOWN_VALUE);
    await i18next.changeLanguage('fr');
    expect(currentLanguage()).toBe('fr');
    expect(formatNumber(21.634, 2)).toBe('21,63');
    expect(formatDistance(1, 'au')).toBe('1,000 ua');
  });

  it('formats degrees, sexagesimal degrees and hours with the carry handled', () => {
    expect(formatDegrees(21.6312487)).toBe('21.63°');
    expect(formatDegrees(-0.004)).toBe('0.00°');
    expect(formatDms(-16.7279056)).toBe('-16° 43′ 40″');
    expect(formatDms(21.9999999)).toBe('22° 00′ 00″');
    expect(formatDms(-0.00001)).toBe('0° 00′ 00″');
    expect(formatHms(101.2824638)).toBe('06h 45m 07.8s');
    expect(formatHms(359.99999)).toBe('00h 00m 00.0s');
    expect(formatHms(-15)).toBe('23h 00m 00.0s');
    expect(formatDegrees(NaN)).toBe(UNKNOWN_VALUE);
    expect(formatDms(NaN)).toBe(UNKNOWN_VALUE);
    expect(formatHms(NaN)).toBe(UNKNOWN_VALUE);
  });

  it('picks the natural unit of an angular size', () => {
    expect(formatAngularSize(1.5)).toBe('1.50°');
    expect(formatAngularSize(0.5543674)).toBe('33.3′');
    expect(formatAngularSize(0.0125)).toBe('45.0″');
    expect(formatAngularSize(NaN)).toBe(UNKNOWN_VALUE);
  });

  it('formats distances in au or in kilometres for the Moon', () => {
    expect(formatDistance(2.628583942, 'au')).toBe('2.629 au');
    expect(formatDistance(4491.2, 'au')).toBe('4,491.2 au');
    expect(formatDistance(0.002400662, 'km')).toBe(
      `${new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(0.002400662 * AU_KM)} km`,
    );
    expect(formatDistance(NaN, 'au')).toBe(UNKNOWN_VALUE);
  });

  it('formats percentages and magnitudes', () => {
    expect(formatPercent(0.967854)).toBe('97%');
    expect(formatPercent(0.967854, 'fr')).toBe('97\u00a0%');
    expect(formatPercent(NaN)).toBe(UNKNOWN_VALUE);
    expect(formatMagnitude(-1.44)).toBe('-1.4');
    expect(formatMagnitude(8.724)).toBe('8.7');
  });

  it('writes years with an explicit sign and four digits, and UTC instants', () => {
    expect(formatYearOfJd(2460409.25)).toBe('2024');
    // 45 BC is the astronomical year -44 (brief l.526).
    expect(formatYearOfJd(jdFromCalendar(-44, 3, 15))).toBe('-0044');
    expect(formatYearOfJd(jdFromCalendar(0, 6, 1))).toBe('0000');
    expect(formatYearOfJd(NaN)).toBe(UNKNOWN_VALUE);
    // 18:00:00 TT less 69.184 s is 17:58:50.816 UTC, rounded to the second like the backend.
    expect(formatUtc(2460409.25, 69.184)).toBe('2024-04-08 17:58:51');
    expect(formatDateOfTt(2460409.25, 69.184)).toBe('2024-04-08');
    expect(formatUtc(NaN, 69.184)).toBe(UNKNOWN_VALUE);
    expect(formatDateOfTt(2460409.25, NaN)).toBe(UNKNOWN_VALUE);
  });
});

describe('formatTimeOffset (the AR time-offset badge, plan D127)', () => {
  const en = i18next.getFixedT('en');
  const fr = i18next.getFixedT('fr');

  it('joins the kept units behind a plus or a typographic minus', () => {
    expect(formatTimeOffset({ sign: 1, years: 0, days: 0, hours: 3, minutes: 12 }, en)).toBe(
      '+3\u00a0h 12\u00a0min',
    );
    expect(formatTimeOffset({ sign: -1, years: 2, days: 10, hours: 0, minutes: 0 }, en)).toBe(
      '\u22122 yr 10 d',
    );
    expect(formatTimeOffset({ sign: 1, years: 1, days: 0, hours: 5, minutes: 0 }, en)).toBe(
      '+1 yr 5\u00a0h',
    );
    expect(formatTimeOffset({ sign: -1, years: 0, days: 0, hours: 0, minutes: 1 }, en)).toBe(
      '\u22121\u00a0min',
    );
  });

  it('reads Now for a zero offset', () => {
    expect(formatTimeOffset({ sign: 0, years: 0, days: 0, hours: 0, minutes: 0 }, en)).toBe('Now');
    expect(formatTimeOffset({ sign: 0, years: 0, days: 0, hours: 0, minutes: 0 }, fr)).toBe(
      'Maintenant',
    );
  });

  it('uses the French unit symbols a, j, h, min', () => {
    expect(formatTimeOffset({ sign: 1, years: 0, days: 0, hours: 3, minutes: 12 }, fr)).toBe(
      '+3\u00a0h 12\u00a0min',
    );
    expect(formatTimeOffset({ sign: -1, years: 2, days: 10, hours: 0, minutes: 0 }, fr)).toBe(
      '\u22122 a 10 j',
    );
    expect(formatTimeOffset({ sign: 1, years: 1, days: 1, hours: 0, minutes: 0 }, fr)).toBe(
      '+1 a 1 j',
    );
  });
});
