// @vitest-environment node
// URL codec (plan D79): parsing never throws, invalid values vanish, serialization is stable and
// rounded. This file must keep `url.ts` at 100 % on every coverage metric (plan D88).

import { DSO_TYPES, LAYER_IDS } from './types';
import type { UrlState } from './types';
import {
  URL_KEYS,
  parseUrlState,
  roundUrlValue,
  serializeUrlState,
  urlStatesEqual,
  wrapLongitudeDeg,
} from './url';

const FULL_QUERY =
  '?body=mars&lat=18.44&lon=77.45&elev=-2500&t=2460409.25&speed=3600&az=270.5&alt=45&fov=60' +
  '&layers=horizon,stars,stars,bogus&ground=off&atm=0&refr=true&maglim=6.5' +
  '&dso=nebula,galaxy,unknown&minor=a:1,c:1P,a:1,c:C/2023_A3,bad&labels=3&lang=fr&night=1' +
  '&sel=hip:32349&unknown=ignored';

describe('URL_KEYS', () => {
  it('lists the twenty UX-2 parameters in the serialization order', () => {
    expect(URL_KEYS).toEqual([
      'body',
      'lat',
      'lon',
      'elev',
      't',
      'speed',
      'az',
      'alt',
      'fov',
      'layers',
      'ground',
      'atm',
      'refr',
      'maglim',
      'dso',
      'minor',
      'labels',
      'lang',
      'night',
      'sel',
    ]);
  });
});

describe('wrapLongitudeDeg', () => {
  it('wraps into [-180, 180) without -0', () => {
    expect(wrapLongitudeDeg(180)).toBe(-180);
    expect(wrapLongitudeDeg(-180)).toBe(-180);
    expect(wrapLongitudeDeg(540)).toBe(-180);
    expect(wrapLongitudeDeg(-190)).toBe(170);
    expect(wrapLongitudeDeg(2.35)).toBe(2.35);
    expect(Object.is(wrapLongitudeDeg(-0), 0)).toBe(true);
    expect(Object.is(wrapLongitudeDeg(360), 0)).toBe(true);
    expect(Object.is(wrapLongitudeDeg(-360), 0)).toBe(true);
    // One ulp below the bound stays exact instead of rounding past -180.
    expect(wrapLongitudeDeg(179.99999999999997)).toBe(179.99999999999997);
    expect(wrapLongitudeDeg(-180.00000000000003)).toBe(179.99999999999997);
    // Absurd but finite inputs still land in range.
    const huge = wrapLongitudeDeg(1e300);
    expect(huge).toBeGreaterThanOrEqual(-180);
    expect(huge).toBeLessThan(180);
  });
});

describe('parseUrlState', () => {
  it('parses a complete query, filtering and canonicalizing lists', () => {
    expect(parseUrlState(FULL_QUERY)).toEqual({
      body: 'mars',
      lat: 18.44,
      lon: 77.45,
      elev: -2500,
      t: 2460409.25,
      speed: 3600,
      az: 270.5,
      alt: 45,
      fov: 60,
      layers: ['stars', 'horizon'],
      ground: 'off',
      atm: false,
      refr: true,
      maglim: 6.5,
      dso: ['galaxy', 'nebula'],
      minor: ['a:1', 'c:1P', 'c:C/2023_A3'],
      labels: 3,
      lang: 'fr',
      night: true,
      sel: 'hip:32349',
    } satisfies UrlState);
  });

  it('accepts a query without the leading ? and an empty string', () => {
    expect(parseUrlState('lat=10')).toEqual({ lat: 10 });
    expect(parseUrlState('')).toEqual({});
    expect(parseUrlState('?')).toEqual({});
  });

  it('rejects malformed numbers', () => {
    for (const bad of ['abc', '1e5', 'NaN', 'Infinity', '', '1.', '.5', '+5', '0x10', '1,5']) {
      expect(parseUrlState(`lat=${bad}&elev=${bad}&t=${bad}&speed=${bad}`)).toEqual({});
    }
    // Well-formed digits that overflow to Infinity are not finite numbers either.
    const overflow = '9'.repeat(400);
    expect(
      parseUrlState(`t=${overflow}&speed=-${overflow}&lon=${overflow}&az=${overflow}`),
    ).toEqual({});
  });

  it('drops out-of-range values instead of clamping them', () => {
    expect(parseUrlState('lat=90.01&elev=100001&alt=-90.5&fov=0.9&maglim=15.1')).toEqual({});
    expect(parseUrlState('lat=-90&elev=-12000&alt=90&fov=120&maglim=-2')).toEqual({
      lat: -90,
      elev: -12000,
      alt: 90,
      fov: 120,
      maglim: -2,
    });
    expect(parseUrlState('lat=90&elev=100000&alt=-90&fov=1&maglim=15')).toEqual({
      lat: 90,
      elev: 100000,
      alt: -90,
      fov: 1,
      maglim: 15,
    });
    // `t` beyond any ephemeris (DE441 spans JD -3.10e6..8.00e6) and absurd speeds are dropped
    // rather than fed to the clock arithmetic (`speed=1e300` would overflow `tt` to Infinity).
    expect(parseUrlState('t=10000000.5&speed=1000000000.5')).toEqual({});
    expect(parseUrlState('t=-4000000.5&speed=-1000000000.5')).toEqual({});
    expect(parseUrlState('t=10000000&speed=1000000000')).toEqual({ t: 1e7, speed: 1e9 });
    expect(parseUrlState('t=-4000000&speed=-1000000000')).toEqual({ t: -4e6, speed: -1e9 });
    expect(parseUrlState('t=-3100255&speed=31557600')).toEqual({ t: -3100255, speed: 31557600 });
  });

  it('wraps longitude and azimuth', () => {
    expect(parseUrlState('lon=180&az=360')).toEqual({ lon: -180, az: 0 });
    expect(parseUrlState('lon=-190.5&az=-90')).toEqual({ lon: 169.5, az: 270 });
    expect(parseUrlState('lon=540&az=725')).toEqual({ lon: -180, az: 5 });
  });

  it('reads t as live or a Julian Date', () => {
    expect(parseUrlState('t=live')).toEqual({ t: 'live' });
    expect(parseUrlState('t=2460409.25')).toEqual({ t: 2460409.25 });
    expect(parseUrlState('t=-1000000.5')).toEqual({ t: -1000000.5 });
    expect(parseUrlState('t=now')).toEqual({});
    expect(parseUrlState('t=LIVE')).toEqual({});
  });

  it('validates the body id syntax only', () => {
    expect(parseUrlState('body=moon')).toEqual({ body: 'moon' });
    expect(parseUrlState('body=Earth')).toEqual({});
    expect(parseUrlState('body=mars1')).toEqual({});
    expect(parseUrlState('body=')).toEqual({});
  });

  it('keeps an empty layers or dso list (everything off) and ignores unknown ids', () => {
    expect(parseUrlState('layers=')).toEqual({ layers: [] });
    expect(parseUrlState('layers=nope')).toEqual({ layers: [] });
    expect(parseUrlState(`layers=${LAYER_IDS.slice().reverse().join(',')}`)).toEqual({
      layers: [...LAYER_IDS],
    });
    expect(parseUrlState('dso=')).toEqual({ dso: [] });
    expect(parseUrlState(`dso=${DSO_TYPES.slice().reverse().join(',')}`)).toEqual({
      dso: [...DSO_TYPES],
    });
  });

  it('parses enumerations and flags', () => {
    expect(parseUrlState('ground=opaque')).toEqual({ ground: 'opaque' });
    expect(parseUrlState('ground=dim')).toEqual({ ground: 'dim' });
    expect(parseUrlState('ground=solid')).toEqual({});
    expect(parseUrlState('atm=1&refr=0&night=true')).toEqual({
      atm: true,
      refr: false,
      night: true,
    });
    expect(parseUrlState('atm=false&refr=yes&night=2')).toEqual({ atm: false });
    expect(parseUrlState('lang=en')).toEqual({ lang: 'en' });
    expect(parseUrlState('lang=de')).toEqual({});
    expect(parseUrlState('labels=0')).toEqual({ labels: 0 });
    expect(parseUrlState('labels=2')).toEqual({ labels: 2 });
    expect(parseUrlState('labels=4')).toEqual({});
    expect(parseUrlState('labels=1.0')).toEqual({});
    expect(parseUrlState('labels=')).toEqual({});
  });

  it('reads night as a flag or as a brightness in [0.3, 1] (plan D108)', () => {
    expect(parseUrlState('night=1')).toEqual({ night: true });
    expect(parseUrlState('night=true')).toEqual({ night: true });
    expect(parseUrlState('night=0')).toEqual({ night: false });
    expect(parseUrlState('night=false')).toEqual({ night: false });
    expect(parseUrlState('night=0.6')).toEqual({ night: true, nightLevel: 0.6 });
    expect(parseUrlState('night=0.3')).toEqual({ night: true, nightLevel: 0.3 });
    expect(parseUrlState('night=0.456')).toEqual({ night: true, nightLevel: 0.46 });
    // Rounds up to full brightness: on, without a level (the canonical form of `night=1`).
    expect(parseUrlState('night=0.995')).toEqual({ night: true });
    expect(parseUrlState('night=0.994')).toEqual({ night: true, nightLevel: 0.99 });
    // 1 is the maximum, not out of range: a hand-written `1.0` or `1.00` is on, like `1`.
    expect(parseUrlState('night=1.0')).toEqual({ night: true });
    expect(parseUrlState('night=1.00')).toEqual({ night: true });
    // Below the dimmest level, at or above full brightness, or not a number: absent.
    expect(parseUrlState('night=0.2')).toEqual({});
    expect(parseUrlState('night=0.29')).toEqual({});
    expect(parseUrlState('night=1.01')).toEqual({});
    expect(parseUrlState('night=1.5')).toEqual({});
    expect(parseUrlState('night=-0.5')).toEqual({});
    expect(parseUrlState('night=abc')).toEqual({});
    expect(parseUrlState('night=')).toEqual({});
  });

  it('filters, deduplicates and caps the minor-body ids at 100', () => {
    expect(parseUrlState('minor=')).toEqual({ minor: [] });
    expect(parseUrlState('minor=a:433,c:1P,a:433,x:1,a:,a:K24Y01R,c:C/2023_A3')).toEqual({
      minor: ['a:433', 'c:1P', 'a:K24Y01R', 'c:C/2023_A3'],
    });
    const many = Array.from({ length: 120 }, (_, i) => `a:${String(i + 1)}`);
    const parsed = parseUrlState(`minor=${many.join(',')}`);
    expect(parsed.minor).toHaveLength(100);
    expect(parsed.minor?.[99]).toBe('a:100');
  });

  it('validates the selection syntax', () => {
    for (const ok of [
      'hip:11767',
      'dso:NGC224',
      'dso:IC80_NED01',
      'dso:ESO56-115',
      'moon',
      'a:433',
      'c:C/2023_A3',
    ]) {
      expect(parseUrlState(`sel=${ok}`)).toEqual({ sel: ok });
    }
    for (const bad of [
      '',
      'Moon',
      'hip:',
      'hip:12a',
      'dso:',
      'dso:NGC 224',
      'x:1',
      'a:',
      'a:b c',
    ]) {
      expect(parseUrlState(`sel=${encodeURIComponent(bad)}`)).toEqual({});
    }
  });

  it('never throws on garbage', () => {
    expect(() => parseUrlState('%E0%A4%A&lat=%zz&=&&&layers')).not.toThrow();
    expect(parseUrlState('layers')).toEqual({ layers: [] });
  });
});

describe('roundUrlValue', () => {
  it('rounds each numeric key to its precision and leaves the others alone', () => {
    expect(roundUrlValue('lat', 51.4779)).toBe(51.48);
    expect(roundUrlValue('lon', -0.0012)).toBe(0);
    expect(Object.is(roundUrlValue('lon', -0.0012), 0)).toBe(true);
    expect(roundUrlValue('alt', 19.999)).toBe(20);
    expect(roundUrlValue('az', 359.996)).toBe(360);
    expect(roundUrlValue('elev', 45.6)).toBe(46);
    expect(roundUrlValue('fov', 60.04)).toBe(60);
    expect(roundUrlValue('fov', 60.05)).toBe(60.1);
    expect(roundUrlValue('t', 2460409.1234567)).toBe(2460409.123457);
    expect(roundUrlValue('speed', 0.26)).toBe(0.3);
    expect(roundUrlValue('speed', 0.1 * 3)).toBe(0.3);
    expect(roundUrlValue('maglim', 6.55)).toBe(6.6);
    expect(roundUrlValue('nightLevel', 0.456)).toBe(0.46);
    expect(roundUrlValue('nightLevel', 0.7)).toBe(0.7);
    expect(roundUrlValue('labels', 2.5)).toBe(2.5);
    expect(roundUrlValue('layers', 1.23456)).toBe(1.23456);
  });
});

describe('serializeUrlState', () => {
  const defaults: UrlState = {
    body: 'earth',
    lat: 51.48,
    lon: 0,
    elev: 0,
    t: 'live',
    az: 0,
    alt: 20,
    fov: 60,
    layers: ['stars', 'planets', 'horizon'],
    ground: 'dim',
    atm: true,
    refr: true,
    minor: [],
    labels: 2,
    lang: 'en',
    night: false,
  };

  it('always writes the observer, t and the view, and omits other default-valued keys', () => {
    expect(serializeUrlState(defaults, defaults)).toBe(
      'body=earth&lat=51.48&lon=0&elev=0&t=live&az=0&alt=20&fov=60',
    );
  });

  it('writes an empty state as an empty string (no leading ?)', () => {
    expect(serializeUrlState({}, defaults)).toBe('');
  });

  it('serializes every key in the fixed order with rounding and readable separators', () => {
    const state: UrlState = {
      sel: 'c:C/2023_A3',
      night: true,
      lang: 'fr',
      labels: 0,
      minor: ['a:433', 'c:C/2023_A3'],
      dso: ['galaxy', 'nebula'],
      maglim: 6.55,
      refr: false,
      atm: false,
      ground: 'off',
      layers: ['stars', 'eqgrid'],
      fov: 30.04,
      alt: 45.006,
      az: 12.344,
      speed: -3600,
      t: 2460409.12345678,
      elev: 35.4,
      lon: 2.3522,
      lat: 48.8566,
      body: 'earth',
    };
    expect(serializeUrlState(state, defaults)).toBe(
      'body=earth&lat=48.86&lon=2.35&elev=35&t=2460409.123457&speed=-3600&az=12.34&alt=45.01' +
        '&fov=30&layers=stars,eqgrid&ground=off&atm=0&refr=0&maglim=6.6&dso=galaxy,nebula' +
        '&minor=a:433,c:C/2023_A3&labels=0&lang=fr&night=1&sel=c:C/2023_A3',
    );
  });

  it('wraps azimuth and longitude after rounding', () => {
    expect(serializeUrlState({ az: 359.996, lon: 179.996 }, defaults)).toBe('lon=-180&az=0');
    expect(serializeUrlState({ az: -0.001, lon: -0.001 }, defaults)).toBe('lon=0&az=0');
  });

  it('treats a list equal to the defaults as omitted, and a differently ordered one as different', () => {
    expect(serializeUrlState({ layers: ['stars', 'planets', 'horizon'] }, defaults)).toBe('');
    expect(serializeUrlState({ layers: ['stars', 'planets'] }, defaults)).toBe(
      'layers=stars,planets',
    );
    expect(serializeUrlState({ layers: ['planets', 'stars', 'horizon'] }, defaults)).toBe(
      'layers=planets,stars,horizon',
    );
    expect(serializeUrlState({ minor: [] }, defaults)).toBe('');
    expect(serializeUrlState({ dso: [] }, defaults)).toBe('dso=');
  });

  it('percent-encodes what is not readable', () => {
    expect(serializeUrlState({ sel: 'a b&c' }, defaults)).toBe('sel=a%20b%26c');
  });

  it('writes night as its brightness below 1 and as 1 otherwise, never while off', () => {
    expect(serializeUrlState({ night: true }, defaults)).toBe('night=1');
    expect(serializeUrlState({ night: true, nightLevel: 1 }, defaults)).toBe('night=1');
    expect(serializeUrlState({ night: true, nightLevel: 0.6 }, defaults)).toBe('night=0.6');
    expect(serializeUrlState({ night: true, nightLevel: 0.456 }, defaults)).toBe('night=0.46');
    expect(serializeUrlState({ night: true, nightLevel: 0.999 }, defaults)).toBe('night=1');
    // Off is the default and the level is not written while off (plan D108).
    expect(serializeUrlState({ night: false, nightLevel: 0.6 }, defaults)).toBe('');
    expect(serializeUrlState({ nightLevel: 0.6 }, defaults)).toBe('');
    // Against defaults that have night on, off is written as the plain flag.
    expect(serializeUrlState({ night: false }, { ...defaults, night: true })).toBe('night=0');
    // The other flags keep the plain `1`/`0` form.
    expect(serializeUrlState({ atm: true, refr: false }, { ...defaults, atm: false })).toBe(
      'atm=1&refr=0',
    );
  });

  it('round-trips through parseUrlState', () => {
    const state: UrlState = {
      body: 'moon',
      lat: 0.67,
      lon: 23.47,
      elev: 0,
      t: 2460409.123457,
      speed: 60,
      az: 123.45,
      alt: -5.5,
      fov: 12.3,
      layers: ['stars', 'planets', 'azgrid'],
      ground: 'opaque',
      atm: false,
      refr: false,
      maglim: 8.1,
      dso: ['globular_cluster'],
      minor: ['a:1'],
      labels: 1,
      lang: 'fr',
      night: true,
      sel: 'dso:NGC224',
    };
    expect(parseUrlState(serializeUrlState(state, defaults))).toEqual(state);
    const dimmed: UrlState = { ...state, nightLevel: 0.45 };
    expect(parseUrlState(serializeUrlState(dimmed, defaults))).toEqual(dimmed);
  });
});

describe('urlStatesEqual', () => {
  it('compares every key, lists element-wise', () => {
    expect(urlStatesEqual({}, {})).toBe(true);
    expect(urlStatesEqual({ lat: 1, layers: ['stars'] }, { layers: ['stars'], lat: 1 })).toBe(true);
    expect(urlStatesEqual({ lat: 1 }, { lat: 1.0000001 })).toBe(false);
    expect(urlStatesEqual({ layers: ['stars'] }, { layers: ['stars', 'planets'] })).toBe(false);
    expect(urlStatesEqual({ layers: ['stars'] }, { layers: ['planets'] })).toBe(false);
    expect(urlStatesEqual({ layers: ['stars'] }, {})).toBe(false);
    expect(urlStatesEqual({ t: 'live' }, { t: 2460409.5 })).toBe(false);
    expect(urlStatesEqual({ atm: true }, { atm: false })).toBe(false);
    // `nightLevel` travels inside `night` but still tells two states apart.
    expect(urlStatesEqual({ night: true, nightLevel: 0.6 }, { night: true, nightLevel: 0.6 })).toBe(
      true,
    );
    expect(urlStatesEqual({ night: true, nightLevel: 0.6 }, { night: true, nightLevel: 0.7 })).toBe(
      false,
    );
    expect(urlStatesEqual({ night: true, nightLevel: 0.6 }, { night: true })).toBe(false);
  });
});
