// @vitest-environment node
// Catalog loaders (plan D78): the SKYS parser is checked byte for byte against the seven fixture
// stars written with the docs/api.md layout, every format error code is hit, ETag helpers and
// `loadCatalogs` (required vs optional catalogs, degraded /meta, staleness, boundary_parts).

import { loadStarsFixture } from '../test/fixtures';
import type { StarFixture } from '../test/fixtures';
import {
  SKYS_BYTES_PER_STAR,
  SKYS_HEADER_BYTES,
  SkysFormatError,
  buildHipIndex,
  etagMatches,
  isStaleEtag,
  loadCatalogs,
  normalizeEtag,
  parseSkys,
} from './catalogs';
import type { MetaResponse, RequestOptions } from './client';
import type { components } from './schema';

type SchemaConstellation = components['schemas']['ConstellationEntry'];

interface SkysOverrides {
  magic?: string;
  version?: number;
  count?: number;
  flags?: number;
  truncate?: number;
}

/** Write the SKYS v1 layout of docs/api.md ("Binary catalog format SKYS v1"). */
function buildSkys(
  stars: readonly StarFixture[],
  epochTt: number,
  overrides: SkysOverrides = {},
): ArrayBuffer {
  const n = stars.length;
  const buffer = new ArrayBuffer(SKYS_HEADER_BYTES + SKYS_BYTES_PER_STAR * n);
  const view = new DataView(buffer);
  const magic = overrides.magic ?? 'SKYS';
  for (let i = 0; i < 4; i += 1) {
    view.setUint8(i, magic.charCodeAt(i));
  }
  view.setUint32(4, overrides.version ?? 1, true);
  view.setUint32(8, overrides.count ?? n, true);
  view.setFloat64(12, epochTt, true);
  view.setUint32(20, overrides.flags ?? 0, true);
  const dir = new Float32Array(buffer, 24, 3 * n);
  const pm = new Float32Array(buffer, 24 + 12 * n, 3 * n);
  const mag = new Int16Array(buffer, 24 + 24 * n, n);
  const bv = new Int16Array(buffer, 24 + 26 * n, n);
  const hip = new Uint32Array(buffer, 24 + 28 * n, n);
  stars.forEach((star, i) => {
    dir.set(star.skys.dir, 3 * i);
    pm.set(star.skys.pm, 3 * i);
    mag[i] = star.skys.mag_millimag;
    bv[i] = star.skys.bv_millimag;
    hip[i] = star.hip;
  });
  return overrides.truncate === undefined ? buffer : buffer.slice(0, overrides.truncate);
}

const fixture = loadStarsFixture();
const EPOCH = fixture.parameters.skys_epoch_tt;

describe('parseSkys', () => {
  it('reads the seven fixture stars back exactly as zero-copy views', () => {
    const buffer = buildSkys(fixture.stars, EPOCH);
    expect(buffer.byteLength).toBe(24 + 32 * 7);
    const columns = parseSkys(buffer);
    expect(columns.count).toBe(7);
    expect(columns.epochTt).toBe(2451545.0);
    expect(Array.from(columns.dir)).toEqual(
      fixture.stars.flatMap((s) => s.skys.dir.map(Math.fround)),
    );
    expect(Array.from(columns.pm)).toEqual(
      fixture.stars.flatMap((s) => s.skys.pm.map(Math.fround)),
    );
    expect(Array.from(columns.mag)).toEqual(fixture.stars.map((s) => s.skys.mag_millimag));
    expect(Array.from(columns.bv)).toEqual(fixture.stars.map((s) => s.skys.bv_millimag));
    expect(Array.from(columns.hip)).toEqual(fixture.stars.map((s) => s.hip));
    // Views, not copies: every column shares the response buffer at the documented offsets.
    for (const column of [columns.dir, columns.pm, columns.mag, columns.bv, columns.hip]) {
      expect(column.buffer).toBe(buffer);
    }
    expect(columns.dir.byteOffset).toBe(24);
    expect(columns.pm.byteOffset).toBe(24 + 12 * 7);
    expect(columns.mag.byteOffset).toBe(24 + 24 * 7);
    expect(columns.bv.byteOffset).toBe(24 + 26 * 7);
    expect(columns.hip.byteOffset).toBe(24 + 28 * 7);
  });

  it('parses an empty catalog', () => {
    const columns = parseSkys(buildSkys([], EPOCH));
    expect(columns.count).toBe(0);
    expect(columns.hip).toHaveLength(0);
  });

  it('throws SkysFormatError with the failing check as code', () => {
    const cases: [ArrayBuffer, SkysFormatError['code']][] = [
      [new ArrayBuffer(10), 'length'],
      [buildSkys(fixture.stars, EPOCH, { magic: 'SKYZ' }), 'magic'],
      [buildSkys(fixture.stars, EPOCH, { version: 2 }), 'version'],
      [buildSkys(fixture.stars, EPOCH, { count: 8 }), 'count'],
      [buildSkys(fixture.stars, EPOCH, { truncate: 24 + 32 * 7 - 1 }), 'count'],
      [buildSkys(fixture.stars, EPOCH, { flags: 1 }), 'flags'],
    ];
    for (const [buffer, code] of cases) {
      let caught: unknown;
      try {
        parseSkys(buffer);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SkysFormatError);
      expect(caught).toMatchObject({ name: 'SkysFormatError', code });
    }
  });
});

describe('buildHipIndex', () => {
  it('maps every Hipparcos id to its row', () => {
    const columns = parseSkys(buildSkys(fixture.stars, EPOCH));
    const index = buildHipIndex(columns.hip);
    expect(index.size).toBe(7);
    expect(index.get(11767)).toBe(0);
    expect(index.get(65474)).toBe(6);
    expect(index.get(1)).toBeUndefined();
  });
});

describe('ETag helpers', () => {
  it('normalizes quotes and weak prefixes', () => {
    expect(normalizeEtag(null)).toBeNull();
    expect(normalizeEtag('"abc"')).toBe('abc');
    expect(normalizeEtag('W/"abc"')).toBe('abc');
    expect(normalizeEtag(' abc ')).toBe('abc');
    expect(normalizeEtag('""')).toBeNull();
    expect(normalizeEtag('"')).toBe('"');
  });

  it('matches only a known header against a known meta value', () => {
    expect(etagMatches('"abc"', 'abc')).toBe(true);
    expect(etagMatches('W/"abc"', 'abc')).toBe(true);
    expect(etagMatches('"abd"', 'abc')).toBe(false);
    expect(etagMatches(null, 'abc')).toBe(false);
    expect(etagMatches('"abc"', undefined)).toBe(false);
  });

  it('reports stale only when both ETags are known and differ', () => {
    expect(isStaleEtag('"abd"', 'abc')).toBe(true);
    expect(isStaleEtag('W/"abd"', 'abc')).toBe(true);
    expect(isStaleEtag('"abc"', 'abc')).toBe(false);
    expect(isStaleEtag('W/"abc"', 'abc')).toBe(false);
    // Unknown is not stale: a stripped header or a /meta entry without an ETag cannot be compared,
    // and a reload prompt could never clear it.
    expect(isStaleEtag(null, 'abc')).toBe(false);
    expect(isStaleEtag('""', 'abc')).toBe(false);
    expect(isStaleEtag('"abc"', undefined)).toBe(false);
  });
});

function makeMeta(catalogs: Partial<MetaResponse['catalogs']> = {}): MetaResponse {
  return {
    api_version: '1.0.0',
    server_time: { tt: 2461285.5, utc: '2026-09-02T00:00:00Z', tt_minus_utc_seconds: 69.184 },
    ephemeris: { name: 'de440s.bsp', coverage_tt: [2396758.5, 2506000.5] },
    observers: [
      {
        id: 'earth',
        name_key: 'bodies.earth',
        frame: 'ITRS',
        radii_km: [6378.137, 6378.137, 6356.752],
        latitude_kind: 'geodetic',
        coverage_tt: [2396758.5, 2506000.5],
      },
    ],
    coverage: {
      ephemeris_tt: [2396758.5, 2506000.5],
      delta_t: { observed_tt: [2441317.5, 2461349.5], predicted_until_tt: 2461714.5 },
      iau_rotation_reliable_tt: [2378496.5, 2524593.5],
      proper_motion_warning_years: 10000,
      mpc_elements: { warn_years: 2, error_years: 50 },
    },
    bodies: [
      {
        id: 'sun',
        kind: 'star',
        name_key: 'bodies.sun',
        radius_km: 695700,
        step_class: 'sun_and_outer',
      },
    ],
    catalogs: {
      stars: {
        count: 7,
        version: '1-abc',
        etag: 'stars-etag',
        epoch_tt: EPOCH,
        magnitude_limit: 13.9,
        license: 'CC BY-SA 2.5',
        attribution: 'ESA Hipparcos; HYG',
      },
      dso: {
        count: 2,
        version: '1-def',
        etag: 'dso-etag',
        license: 'CC BY-SA 4.0',
        attribution: 'OpenNGC',
      },
      constellations: {
        count: 2,
        culture: 'modern',
        etag: 'con-etag',
        license: 'GPL-2.0',
        attribution: 'Stellarium; d3-celestial',
      },
      ...catalogs,
    },
    geocoder: { enabled: false, url: '', attribution: '', min_interval_ms: 1000 },
    limits: {
      max_samples: 64,
      max_minor_bodies: 100,
      max_targets: 200,
      speeds: [1, 10, 60],
      max_step_s: { moon: 3600, inner_planets: 21600, sun_and_outer: 86400, minor: 86400 },
    },
  };
}

const ORION: SchemaConstellation = {
  abbr: 'Ori',
  latin: 'Orion',
  genitive: 'Orionis',
  lines: [[27989, 26727]],
  boundary: [
    [70, 0],
    [80, 0],
    [80, 10],
    [70, 0],
  ],
  label: { ra_deg: 83, dec_deg: 5 },
};

const SERPENS: SchemaConstellation = {
  abbr: 'Ser',
  latin: 'Serpens',
  genitive: 'Serpentis',
  lines: [],
  boundary: [
    [230, 0],
    [240, 0],
    [230, 0],
  ],
  boundary_parts: [
    [
      [230, 0],
      [240, 0],
      [230, 0],
    ],
    [
      [270, -10],
      [280, -10],
      [270, -10],
    ],
  ],
  label: { ra_deg: 236, dec_deg: 6 },
};

const INDEX = [{ hip: 11767, names: { proper: 'Polaris', bayer: 'α UMi' }, con: 'UMi' }];
const DSO = [
  {
    id: 'NGC224',
    names: ['Andromeda Galaxy'],
    messier: 31,
    type: 'galaxy',
    ra_deg: 10.68,
    dec_deg: 41.27,
    con: 'And',
  },
];

function jsonResponse(body: unknown, etag: string | null, status = 200): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (etag !== null) {
    headers.ETag = etag;
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function router(routes: Record<string, () => Response>) {
  return vi.fn<typeof fetch>((input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes[url];
    return Promise.resolve(
      route === undefined ? new Response('not found', { status: 404 }) : route(),
    );
  });
}

const STARS_URL = '/api/v1/catalogs/stars';
const INDEX_URL = '/api/v1/catalogs/stars/index';
const DSO_URL = '/api/v1/catalogs/dso';
const CON_URL = '/api/v1/catalogs/constellations';

function starsResponse(etag = '"stars-etag"'): Response {
  return new Response(buildSkys(fixture.stars, EPOCH), {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream', ETag: etag },
  });
}

describe('loadCatalogs', () => {
  it('loads the four catalogs in parallel with cache no-cache and reports statuses', async () => {
    const fetchImpl = router({
      [STARS_URL]: () => starsResponse(),
      [INDEX_URL]: () => jsonResponse(INDEX, '"index-etag"'),
      [DSO_URL]: () => jsonResponse(DSO, '"dso-etag"'),
      [CON_URL]: () =>
        jsonResponse({ culture: 'modern', constellations: [ORION, SERPENS] }, '"con-etag"'),
    });
    const onStatus = vi.fn();
    const bundle = await loadCatalogs(makeMeta(), { fetchImpl, onStatus });

    expect(bundle.stars.columns.count).toBe(7);
    expect(bundle.stars.hipIndex.get(32349)).toBe(1);
    expect(bundle.stars.magnitudeLimit).toBe(13.9);
    expect(bundle.stars.parseMs).toBeGreaterThanOrEqual(0);
    expect(bundle.stars.fetchMs).toBeGreaterThanOrEqual(0);
    expect(bundle.starsEtag).toBe('stars-etag');
    expect(bundle.starsStale).toBe(false);

    expect(bundle.index).toEqual({ data: INDEX, etag: 'index-etag', stale: false });
    expect(bundle.dso).toEqual({ data: DSO, etag: 'dso-etag', stale: false });

    expect(bundle.constellations?.etag).toBe('con-etag');
    expect(bundle.constellations?.stale).toBe(false);
    const [orion, serpens] = bundle.constellations?.data ?? [];
    expect(orion?.abbr).toBe('Ori');
    expect(orion?.polygons).toEqual([ORION.boundary]);
    expect(serpens?.polygons).toEqual(SERPENS.boundary_parts);
    expect(serpens?.polygons).toHaveLength(2);
    expect(serpens?.boundary).toEqual(SERPENS.boundary);

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const call of fetchImpl.mock.calls) {
      expect(call[1]?.cache).toBe('no-cache');
    }
    const statusOf = (name: string): unknown[] =>
      onStatus.mock.calls.filter((call) => call[0] === name).map((call): unknown => call[1]);
    expect(statusOf('stars')).toEqual(['loading', 'ready']);
    expect(statusOf('index')).toEqual(['loading', 'ready']);
    expect(statusOf('dso')).toEqual(['loading', 'ready']);
    expect(statusOf('constellations')).toEqual(['loading', 'ready']);
  });

  it('splits the star timing into the download and the CPU parse (plan D141)', async () => {
    // `performance.now` reads: the request start, the last byte, the end of the HIP index.
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(1000).mockReturnValueOnce(1250).mockReturnValueOnce(1262);
    try {
      const fetchImpl = router({
        [STARS_URL]: () => starsResponse(),
        [INDEX_URL]: () => jsonResponse(INDEX, '"index-etag"'),
      });
      const bundle = await loadCatalogs(makeMeta({ dso: null, constellations: null }), {
        fetchImpl,
      });
      expect(bundle.stars.fetchMs).toBe(250);
      expect(bundle.stars.parseMs).toBe(12);
    } finally {
      now.mockRestore();
    }
  });

  it('skips dso and constellations when /meta omits them or carries null (degraded, B-42)', async () => {
    const fetchImpl = router({
      [STARS_URL]: () => starsResponse(),
      [INDEX_URL]: () => jsonResponse(INDEX, '"index-etag"'),
      [DSO_URL]: () => jsonResponse(DSO, '"dso-etag"'),
      [CON_URL]: () => jsonResponse({ culture: 'modern', constellations: [] }, '"con-etag"'),
    });
    const onStatus = vi.fn();
    const meta = makeMeta({ dso: null });
    delete meta.catalogs.constellations;
    const bundle = await loadCatalogs(meta, { fetchImpl, onStatus });
    expect(bundle.dso).toBeNull();
    expect(bundle.constellations).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenCalledWith('dso', 'missing');
    expect(onStatus).toHaveBeenCalledWith('constellations', 'missing');
  });

  it('flags stale artifacts only when the ETag is known and differs from /meta', async () => {
    const fetchImpl = router({
      [STARS_URL]: () => starsResponse('"older-stars"'),
      [INDEX_URL]: () => jsonResponse(INDEX, '"index-etag"'),
      [DSO_URL]: () => jsonResponse(DSO, 'W/"newer-dso"'),
      [CON_URL]: () => jsonResponse({ culture: 'modern', constellations: [ORION] }, null),
    });
    const onStatus = vi.fn();
    const bundle = await loadCatalogs(makeMeta(), { fetchImpl, onStatus });
    expect(bundle.starsStale).toBe(true);
    expect(bundle.starsEtag).toBe('older-stars');
    expect(onStatus).toHaveBeenCalledWith('stars', 'stale');
    // /meta announces no ETag for the index: never stale, whatever the header says.
    expect(bundle.index.stale).toBe(false);
    expect(bundle.index.etag).toBe('index-etag');
    expect(bundle.dso?.stale).toBe(true);
    expect(bundle.dso?.etag).toBe('newer-dso');
    expect(onStatus).toHaveBeenCalledWith('dso', 'stale');
    // A stripped ETag header cannot be compared: unknown is not stale (no unsatisfiable prompt).
    expect(bundle.constellations?.stale).toBe(false);
    expect(bundle.constellations?.etag).toBeNull();
    expect(onStatus).toHaveBeenCalledWith('constellations', 'ready');
  });

  it('caps the optional catalogs at two attempts so a degraded race cannot stall boot', async () => {
    let dsoCalls = 0;
    const fetchImpl = router({
      [STARS_URL]: () => starsResponse(),
      [INDEX_URL]: () => jsonResponse(INDEX, '"index-etag"'),
      [DSO_URL]: () => {
        dsoCalls += 1;
        return new Response('', { status: 503, headers: { 'Retry-After': '60' } });
      },
      [CON_URL]: () => jsonResponse({ culture: 'modern', constellations: [ORION] }, '"con-etag"'),
    });
    const sleep = vi.fn<NonNullable<RequestOptions['sleep']>>(() => Promise.resolve());
    const onStatus = vi.fn();
    const bundle = await loadCatalogs(makeMeta(), { fetchImpl, onStatus, sleep });
    expect(bundle.dso).toBeNull();
    expect(onStatus).toHaveBeenCalledWith('dso', 'error');
    // One retry after the announced 60 s (the client policy alone would wait four times).
    expect(dsoCalls).toBe(2);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([60_000]);
    expect(bundle.constellations?.data).toHaveLength(1);
    expect(bundle.stars.columns.count).toBe(7);
  });

  it('fails soft on an optional catalog and reports error', async () => {
    const fetchImpl = router({
      [STARS_URL]: () => starsResponse(),
      [INDEX_URL]: () => jsonResponse(INDEX, '"index-etag"'),
      [DSO_URL]: () => new Response('', { status: 503, headers: { 'Retry-After': '60' } }),
      [CON_URL]: () => jsonResponse({ culture: 'modern', constellations: [ORION] }, '"con-etag"'),
    });
    const onStatus = vi.fn();
    const bundle = await loadCatalogs(makeMeta(), {
      fetchImpl,
      onStatus,
      retry: { maxAttempts: 1 },
    });
    expect(bundle.dso).toBeNull();
    expect(bundle.constellations?.data).toHaveLength(1);
    expect(bundle.stars.columns.count).toBe(7);
    expect(onStatus).toHaveBeenCalledWith('dso', 'error');
  });

  it('rejects when a required catalog fails, after reporting error', async () => {
    const fetchImpl = router({
      [STARS_URL]: () => new Response('', { status: 503 }),
      [INDEX_URL]: () => jsonResponse(INDEX, '"index-etag"'),
      [DSO_URL]: () => jsonResponse(DSO, '"dso-etag"'),
      [CON_URL]: () => jsonResponse({ culture: 'modern', constellations: [] }, '"con-etag"'),
    });
    const onStatus = vi.fn();
    await expect(
      loadCatalogs(makeMeta(), { fetchImpl, onStatus, retry: { maxAttempts: 1 } }),
    ).rejects.toMatchObject({ status: 503 });
    expect(onStatus).toHaveBeenCalledWith('stars', 'error');

    const badBytes = router({
      [STARS_URL]: () => new Response(new Uint8Array(10), { status: 200 }),
      [INDEX_URL]: () => jsonResponse(INDEX, '"index-etag"'),
    });
    await expect(
      loadCatalogs(makeMeta({ dso: null, constellations: null }), { fetchImpl: badBytes }),
    ).rejects.toBeInstanceOf(SkysFormatError);

    const badIndex = router({
      [STARS_URL]: () => starsResponse(),
      [INDEX_URL]: () => new Response('', { status: 404 }),
    });
    const indexStatus = vi.fn();
    await expect(
      loadCatalogs(makeMeta({ dso: null, constellations: null }), {
        fetchImpl: badIndex,
        onStatus: indexStatus,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(indexStatus).toHaveBeenCalledWith('index', 'error');
  });
});
