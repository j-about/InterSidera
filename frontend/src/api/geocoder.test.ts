// @vitest-environment node

import {
  GeocoderBlockedError,
  GeocoderInvalidError,
  GeocoderUnavailableError,
  geocoderErrorOf,
  geocoderMinIntervalMs,
  geocoderSearchUrl,
  parseNominatimResults,
  searchPlaces,
} from './geocoder';

// The Nominatim client (OBS-4): the exact request URL, the jsonv2 parsing, one fetch and no retry,
// and the failure classes the panel translates.

const BASE = 'https://nominatim.example.test';

const PARIS = {
  place_id: 123,
  licence: 'Data (c) OpenStreetMap contributors, ODbL 1.0.',
  osm_type: 'relation',
  osm_id: 7444,
  lat: '48.8588897',
  lon: '2.3200410217200766',
  category: 'boundary',
  type: 'administrative',
  place_rank: 15,
  importance: 0.88,
  addresstype: 'city',
  name: 'Paris',
  display_name: 'Paris, Île-de-France, France métropolitaine, France',
  boundingbox: ['48.8155755', '48.9021560', '2.2241220', '2.4697602'],
};

function fetchOf(response: Response | Error): {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      init,
    });
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  };
  return { fetchImpl, calls };
}

describe('geocoderSearchUrl', () => {
  it('builds the documented query with sorted keys, the email only when defined', () => {
    expect(
      geocoderSearchUrl('Saint-Denis, Réunion', {
        baseUrl: `${BASE}/`,
        email: 'a@b.c',
        lang: 'fr',
      }),
    ).toBe(
      `${BASE}/search?accept-language=fr&email=a%40b.c&format=jsonv2&limit=5&q=Saint-Denis,%20R%C3%A9union`,
    );
    expect(geocoderSearchUrl('Paris', { baseUrl: BASE, lang: 'en' })).toBe(
      `${BASE}/search?accept-language=en&format=jsonv2&limit=5&q=Paris`,
    );
  });

  it('never carries the observer coordinates', () => {
    const url = new URL(geocoderSearchUrl('Paris', { baseUrl: BASE, lang: 'en' }));
    expect(url.searchParams.has('lat')).toBe(false);
    expect(url.searchParams.has('lon')).toBe(false);
    expect([...url.searchParams.keys()]).toEqual(['accept-language', 'format', 'limit', 'q']);
  });
});

describe('parseNominatimResults', () => {
  it('turns jsonv2 rows into results with numeric coordinates', () => {
    expect(parseNominatimResults([PARIS])).toEqual([
      {
        placeId: 123,
        displayName: PARIS.display_name,
        lat: 48.8588897,
        lon: 2.3200410217200766,
        category: 'boundary',
        type: 'administrative',
      },
    ]);
    expect(parseNominatimResults([])).toEqual([]);
    expect(
      parseNominatimResults([{ ...PARIS, lat: 48.5, lon: -2, category: undefined }])[0],
    ).toMatchObject({ lat: 48.5, lon: -2, category: '' });
  });

  it('refuses anything but an array of places', () => {
    expect(() => parseNominatimResults({})).toThrow(GeocoderInvalidError);
    expect(() => parseNominatimResults('[]')).toThrow(GeocoderInvalidError);
    expect(() => parseNominatimResults([null])).toThrow(GeocoderInvalidError);
    expect(() => parseNominatimResults([{ ...PARIS, lat: 'north' }])).toThrow(GeocoderInvalidError);
    expect(() => parseNominatimResults([{ ...PARIS, lat: '95' }])).toThrow(GeocoderInvalidError);
    expect(() => parseNominatimResults([{ ...PARIS, lon: Infinity }])).toThrow(
      GeocoderInvalidError,
    );
    expect(() => parseNominatimResults([{ ...PARIS, display_name: 7 }])).toThrow(
      GeocoderInvalidError,
    );
    expect(() => parseNominatimResults([{ ...PARIS, place_id: '12' }])).not.toThrow();
  });
});

describe('searchPlaces', () => {
  it('fetches once with the referrer policy and parses the answer', async () => {
    const { fetchImpl, calls } = fetchOf(Response.json([PARIS]));
    const controller = new AbortController();
    const results = await searchPlaces('Paris', {
      baseUrl: BASE,
      lang: 'en',
      fetchImpl,
      signal: controller.signal,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.lat).toBe(48.8588897);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/search?accept-language=en&format=jsonv2&limit=5&q=Paris`);
    expect(calls[0]?.init).toMatchObject({
      method: 'GET',
      referrerPolicy: 'strict-origin-when-cross-origin',
      signal: controller.signal,
    });
  });

  it('omits the signal when none is given and resolves an empty list', async () => {
    const { fetchImpl, calls } = fetchOf(Response.json([]));
    await expect(
      searchPlaces('Nowhere', { baseUrl: BASE, lang: 'fr', fetchImpl }),
    ).resolves.toEqual([]);
    expect(calls[0]?.init).not.toHaveProperty('signal');
  });

  it.each([403, 429])('maps %i to GeocoderBlockedError without retrying', async (status) => {
    const { fetchImpl, calls } = fetchOf(new Response('nope', { status }));
    const attempt = searchPlaces('Paris', { baseUrl: BASE, lang: 'en', fetchImpl });
    await expect(attempt).rejects.toBeInstanceOf(GeocoderBlockedError);
    await expect(attempt).rejects.toMatchObject({ status });
    expect(calls).toHaveLength(1);
  });

  it('maps other statuses and network failures to GeocoderUnavailableError', async () => {
    const server = fetchOf(new Response('boom', { status: 500 }));
    const failed = searchPlaces('Paris', {
      baseUrl: BASE,
      lang: 'en',
      fetchImpl: server.fetchImpl,
    });
    await expect(failed).rejects.toBeInstanceOf(GeocoderUnavailableError);
    await expect(failed).rejects.toMatchObject({ status: 500 });
    expect(server.calls).toHaveLength(1);

    const network = fetchOf(new TypeError('Failed to fetch'));
    const offline = searchPlaces('Paris', {
      baseUrl: BASE,
      lang: 'en',
      fetchImpl: network.fetchImpl,
    });
    await expect(offline).rejects.toBeInstanceOf(GeocoderUnavailableError);
    await expect(offline).rejects.toMatchObject({ status: null });
    expect(network.calls).toHaveLength(1);
  });

  it('maps a malformed or unreadable body to GeocoderInvalidError', async () => {
    const object = fetchOf(Response.json({ error: 'x' }));
    await expect(
      searchPlaces('Paris', { baseUrl: BASE, lang: 'en', fetchImpl: object.fetchImpl }),
    ).rejects.toBeInstanceOf(GeocoderInvalidError);
    const html = fetchOf(new Response('<html>', { status: 200 }));
    await expect(
      searchPlaces('Paris', { baseUrl: BASE, lang: 'en', fetchImpl: html.fetchImpl }),
    ).rejects.toBeInstanceOf(GeocoderInvalidError);
  });

  it('rethrows an abort untouched', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const { fetchImpl } = fetchOf(abort);
    await expect(searchPlaces('Paris', { baseUrl: BASE, lang: 'en', fetchImpl })).rejects.toBe(
      abort,
    );
  });
});

describe('error codes and interval', () => {
  it('maps the error classes to the panel codes', () => {
    expect(geocoderErrorOf(new GeocoderBlockedError(429))).toBe('blocked');
    expect(geocoderErrorOf(new GeocoderInvalidError())).toBe('invalid');
    expect(geocoderErrorOf(new GeocoderUnavailableError(500))).toBe('unavailable');
    expect(geocoderErrorOf(new Error('x'))).toBe('unavailable');
    expect(geocoderErrorOf('x')).toBe('unavailable');
  });

  it('never goes below the policy interval', () => {
    expect(geocoderMinIntervalMs(500)).toBe(1000);
    expect(geocoderMinIntervalMs(1000)).toBe(1000);
    expect(geocoderMinIntervalMs(2500)).toBe(2500);
  });
});
