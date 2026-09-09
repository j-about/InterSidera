// @vitest-environment node

import { observerQuery } from '../api/client';
import {
  formatDegrees,
  formatElevation,
  parseElevation,
  parseLatitude,
  parseLongitude,
  roundedObserverPreview,
} from './coords';

// The coordinate grammar of the observer panel (OBS-3): decimal and DMS forms, hemisphere
// letters, comma decimals, the typographic minus, the range and syntax errors, and the OBS-7
// preview against the fetch layer's own rounding.

function deg(text: string, parse: typeof parseLatitude): number {
  const parsed = parse(text);
  if (!parsed.ok) {
    throw new Error(`expected ${text} to parse, got ${parsed.error}`);
  }
  return parsed.deg;
}

function error(text: string, parse: typeof parseLatitude): string {
  const parsed = parse(text);
  if (parsed.ok) {
    throw new Error(`expected ${text} to fail, got ${String(parsed.deg)}`);
  }
  return parsed.error;
}

describe('parseLatitude', () => {
  it('reads decimal degrees, signs, the typographic minus and a comma decimal', () => {
    expect(deg('48.8566', parseLatitude)).toBe(48.8566);
    expect(deg('+48.8566', parseLatitude)).toBe(48.8566);
    expect(deg('-33.9', parseLatitude)).toBe(-33.9);
    expect(deg('−12.5', parseLatitude)).toBe(-12.5);
    expect(deg('2,3522', parseLatitude)).toBe(2.3522);
    expect(deg('  90  ', parseLatitude)).toBe(90);
    expect(Object.is(deg('-0', parseLatitude), 0)).toBe(true);
    expect(Object.is(deg('S 0', parseLatitude), 0)).toBe(true);
  });

  it('reads degrees, minutes and seconds with symbols, spaces or colons', () => {
    const expected = 48 + 51 / 60 + 24 / 3600;
    expect(deg('48 51 24N', parseLatitude)).toBeCloseTo(expected, 12);
    expect(deg('48°51\'24"N', parseLatitude)).toBeCloseTo(expected, 12);
    expect(deg('48° 51′ 24″ N', parseLatitude)).toBeCloseTo(expected, 12);
    expect(deg('48º51’24”', parseLatitude)).toBeCloseTo(expected, 12);
    expect(deg('48:51:24', parseLatitude)).toBeCloseTo(expected, 12);
    expect(deg('48d51\'24"', parseLatitude)).toBeCloseTo(expected, 12);
    expect(deg("48°51'24''N", parseLatitude)).toBeCloseTo(expected, 12);
    expect(deg("48° 51.4'", parseLatitude)).toBeCloseTo(48 + 51.4 / 60, 12);
    expect(deg('48.5°', parseLatitude)).toBe(48.5);
    expect(deg('N48 51', parseLatitude)).toBeCloseTo(48.85, 12);
    expect(deg('s 48 51', parseLatitude)).toBeCloseTo(-48.85, 12);
  });

  it('reports empty, syntax, range and hemisphere errors', () => {
    expect(error('', parseLatitude)).toBe('empty');
    expect(error('   ', parseLatitude)).toBe('empty');
    expect(error('abc', parseLatitude)).toBe('syntax');
    expect(error('N', parseLatitude)).toBe('syntax');
    expect(error('48 61 0', parseLatitude)).toBe('syntax');
    expect(error('48 51 60', parseLatitude)).toBe('syntax');
    expect(error('48.5 30', parseLatitude)).toBe('syntax');
    expect(error('48 51 24 10', parseLatitude)).toBe('syntax');
    expect(error('1,2,3', parseLatitude)).toBe('syntax');
    expect(error('1e3', parseLatitude)).toBe('syntax');
    expect(error('91', parseLatitude)).toBe('range');
    expect(error('-90.01', parseLatitude)).toBe('range');
    expect(error('48 E', parseLatitude)).toBe('hemisphere');
    expect(error('W 48', parseLatitude)).toBe('hemisphere');
    expect(error('N 48 S', parseLatitude)).toBe('hemisphere');
    expect(error('-48 N', parseLatitude)).toBe('hemisphere');
    expect(error('+48 S', parseLatitude)).toBe('hemisphere');
  });
});

describe('parseLongitude', () => {
  it('reads E, W and O (Ouest) and wraps values up to 360 degrees', () => {
    expect(deg("2°21'E", parseLongitude)).toBeCloseTo(2.35, 12);
    expect(deg('2°21\'03"E', parseLongitude)).toBeCloseTo(2 + 21 / 60 + 3 / 3600, 12);
    expect(deg('O 5', parseLongitude)).toBe(-5);
    expect(deg('5 W', parseLongitude)).toBe(-5);
    expect(deg('5 o', parseLongitude)).toBe(-5);
    expect(deg('226 E', parseLongitude)).toBe(-134);
    expect(deg('226', parseLongitude)).toBe(-134);
    expect(deg('-190', parseLongitude)).toBe(170);
    expect(deg('180', parseLongitude)).toBe(-180);
    expect(deg('W 200', parseLongitude)).toBe(160);
    expect(deg('360', parseLongitude)).toBe(0);
    expect(Object.is(deg('-360', parseLongitude), 0)).toBe(true);
  });

  it('reports range, hemisphere and syntax errors', () => {
    expect(error('361', parseLongitude)).toBe('range');
    expect(error('-360.5', parseLongitude)).toBe('range');
    expect(error('12 N', parseLongitude)).toBe('hemisphere');
    expect(error('-73.98 W', parseLongitude)).toBe('hemisphere');
    expect(error('', parseLongitude)).toBe('empty');
    expect(error('east', parseLongitude)).toBe('syntax');
  });
});

describe('parseElevation', () => {
  it('reads metres with an optional unit and the URL bounds', () => {
    expect(parseElevation('35')).toEqual({ ok: true, metres: 35 });
    expect(parseElevation('35 m')).toEqual({ ok: true, metres: 35 });
    expect(parseElevation('35M')).toEqual({ ok: true, metres: 35 });
    expect(parseElevation('-10.5')).toEqual({ ok: true, metres: -10.5 });
    expect(parseElevation('1 234')).toEqual({ ok: false, error: 'syntax' });
    expect(parseElevation('12,5')).toEqual({ ok: true, metres: 12.5 });
    expect(parseElevation('−12000')).toEqual({ ok: true, metres: -12000 });
    expect(parseElevation('100000')).toEqual({ ok: true, metres: 100000 });
    const zero = parseElevation('-0');
    expect(zero.ok && Object.is(zero.metres, 0)).toBe(true);
  });

  it('reports empty, syntax and range errors', () => {
    expect(parseElevation('')).toEqual({ ok: false, error: 'empty' });
    expect(parseElevation(' m ')).toEqual({ ok: false, error: 'empty' });
    expect(parseElevation('1e3')).toEqual({ ok: false, error: 'syntax' });
    expect(parseElevation('high')).toEqual({ ok: false, error: 'syntax' });
    expect(parseElevation('100001')).toEqual({ ok: false, error: 'range' });
    expect(parseElevation('-12001')).toEqual({ ok: false, error: 'range' });
  });
});

describe('formatting', () => {
  it('formats degrees to four decimals without trailing zeros or a minus zero', () => {
    expect(formatDegrees(48.85666667)).toBe('48.8567');
    expect(formatDegrees(2.35)).toBe('2.35');
    expect(formatDegrees(-0.00001)).toBe('0');
    expect(formatDegrees(-134)).toBe('-134');
    expect(formatDegrees(51.48, 2)).toBe('51.48');
  });

  it('formats the elevation to the metre', () => {
    expect(formatElevation(35.6)).toBe('36');
    expect(formatElevation(0)).toBe('0');
    expect(formatElevation(-0.4)).toBe('0');
  });
});

describe('roundedObserverPreview', () => {
  it('agrees with the fetch layer on the OBS-7 rounding', () => {
    const cases = [
      { body: 'earth', lat: 48.8566, lon: 2.3522, elev: 35.4 },
      { body: 'earth', lat: -0.004, lon: 179.996, elev: -0.4 },
      { body: 'mars', lat: 18.41, lon: -134.005, elev: 0 },
      { body: 'moon', lat: -89.674, lon: 129.7849, elev: 12.5 },
    ];
    for (const observer of cases) {
      const query = observerQuery(observer);
      expect(roundedObserverPreview(observer)).toEqual({
        lat: query.lat,
        lon: query.lon,
        elev: query.elev,
      });
    }
    expect(roundedObserverPreview(cases[0] ?? { body: 'earth', lat: 0, lon: 0, elev: 0 })).toEqual({
      lat: 48.86,
      lon: 2.35,
      elev: 35,
    });
    expect(roundedObserverPreview({ body: 'earth', lat: 0, lon: 179.996, elev: 0 }).lon).toBe(-180);
  });
});
