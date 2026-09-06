// Catalog loaders (plan D78, brief l.65-66, l.463): the SKYS v1 star catalog parsed into
// zero-copy typed-array views, the star name index, the deep-sky objects and the constellations,
// with the ETag handling that lets the M4 UI offer a reload when `/meta` announces newer data.
//
// Every load uses `cache: 'no-cache'` (plan Q27): the browser revalidates with `If-None-Match`
// on each page load and serves the cached body itself on 304, so the acceptance check "catalogs
// cached by the browser" (brief l.573) is deterministic while `stale-while-revalidate` still
// covers a mid-session refresh.

import type { StarCatalogInput } from '../sky/engine/types';
import type { CatalogName, LoadStatus, StarColumns } from '../state/types';
import { getBytes, getJson } from './client';
import type { MetaResponse, RequestOptions } from './client';
import type { components } from './schema';

export type StarIndexEntry = components['schemas']['StarIndexEntry'];
export type DsoEntry = components['schemas']['DsoEntry'];
export type ConstellationsResponse = components['schemas']['ConstellationsResponse'];
/** One closed ring of `[ra_deg, dec_deg]` vertices, ICRS J2000. */
export type BoundaryRing = readonly (readonly [number, number])[];
/**
 * The schema entry plus `polygons`: every boundary ring (`boundary_parts ?? [boundary]`, docs
 * api.md "Catalog JSON shapes", deviation B-33 for Serpens), so drawing code never looks at
 * `boundary` and `boundary_parts` separately.
 */
export type ConstellationEntry = components['schemas']['ConstellationEntry'] & {
  polygons: readonly BoundaryRing[];
};

export type SkysFormatErrorCode = 'length' | 'magic' | 'version' | 'count' | 'flags';

/** The bytes are not a SKYS v1 file; `code` says which header check failed. */
export class SkysFormatError extends Error {
  readonly code: SkysFormatErrorCode;

  constructor(code: SkysFormatErrorCode, message: string) {
    super(message);
    this.name = 'SkysFormatError';
    this.code = code;
  }
}

/** Header size of SKYS v1 (docs/api.md "Binary catalog format SKYS v1"). */
export const SKYS_HEADER_BYTES = 24;
/** Bytes per star: 12 (dir) + 12 (pm) + 2 (mag) + 2 (bv) + 4 (hip). */
export const SKYS_BYTES_PER_STAR = 32;
const SKYS_VERSION = 1;
/** `SKYS` as bytes. */
const SKYS_MAGIC: readonly number[] = [0x53, 0x4b, 0x59, 0x53];

/**
 * Parse a SKYS v1 buffer into column views without copying (plan D78). Little-endian header:
 * magic `SKYS`, u32 version 1, u32 count, f64 epoch_tt, u32 flags 0; then the packed columns.
 *
 * Alignment: a typed-array view needs its byte offset to be a multiple of its element size.
 * `dir` starts at 24 and `pm` at 24 + 12 n (both multiples of 4), `mag` at 24 + 24 n and `bv`
 * at 24 + 26 n (multiples of 2), `hip` at 24 + 28 n (a multiple of 4): the layout guarantees
 * alignment for every `n`, so the views are always valid and no copy is ever needed.
 */
export function parseSkys(buffer: ArrayBuffer): StarColumns {
  if (buffer.byteLength < SKYS_HEADER_BYTES) {
    throw new SkysFormatError(
      'length',
      `SKYS buffer of ${String(buffer.byteLength)} bytes is shorter than the 24-byte header`,
    );
  }
  const view = new DataView(buffer);
  for (const [i, expected] of SKYS_MAGIC.entries()) {
    if (view.getUint8(i) !== expected) {
      throw new SkysFormatError('magic', 'SKYS magic bytes missing');
    }
  }
  const version = view.getUint32(4, true);
  if (version !== SKYS_VERSION) {
    throw new SkysFormatError('version', `unsupported SKYS version ${String(version)}`);
  }
  const count = view.getUint32(8, true);
  const epochTt = view.getFloat64(12, true);
  const flags = view.getUint32(20, true);
  if (flags !== 0) {
    throw new SkysFormatError('flags', `reserved SKYS flags are ${String(flags)}, expected 0`);
  }
  const expectedLength = SKYS_HEADER_BYTES + SKYS_BYTES_PER_STAR * count;
  if (buffer.byteLength !== expectedLength) {
    throw new SkysFormatError(
      'count',
      `SKYS count ${String(count)} needs ${String(expectedLength)} bytes, got ${String(buffer.byteLength)}`,
    );
  }
  return {
    count,
    epochTt,
    dir: new Float32Array(buffer, SKYS_HEADER_BYTES, 3 * count),
    pm: new Float32Array(buffer, SKYS_HEADER_BYTES + 12 * count, 3 * count),
    mag: new Int16Array(buffer, SKYS_HEADER_BYTES + 24 * count, count),
    bv: new Int16Array(buffer, SKYS_HEADER_BYTES + 26 * count, count),
    hip: new Uint32Array(buffer, SKYS_HEADER_BYTES + 28 * count, count),
  };
}

/** Hipparcos identifier -> row index (the `hip:<n>` target syntax, constellation lines). */
export function buildHipIndex(hip: Uint32Array): Map<number, number> {
  const index = new Map<number, number>();
  for (const [row, id] of hip.entries()) {
    index.set(id, row);
  }
  return index;
}

/** The opaque value of an `ETag` header: `W/` prefix and quotes stripped; `null` when empty. */
export function normalizeEtag(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  let text = value.trim();
  if (text.startsWith('W/')) {
    text = text.slice(2);
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1);
  }
  return text === '' ? null : text;
}

/** `true` when the response `ETag` names the artifact `/meta.catalogs.<x>.etag` announces (bare). */
export function etagMatches(header: string | null, metaEtag: string | undefined): boolean {
  const etag = normalizeEtag(header);
  return etag !== null && metaEtag !== undefined && etag === metaEtag;
}

/**
 * `true` when both the response `ETag` and `/meta.catalogs.<x>.etag` are known and differ: the
 * served artifact is not the one the API announces (brief l.281 "a catalog ETag change triggers
 * a reload prompt"). Unknown is not stale: a proxy that strips `ETag`, or a `/meta` entry without
 * one (the star index), must not raise an M4 reload prompt that no reload could ever satisfy.
 */
export function isStaleEtag(header: string | null, metaEtag: string | undefined): boolean {
  const etag = normalizeEtag(header);
  return etag !== null && metaEtag !== undefined && etag !== metaEtag;
}

export interface Loaded<T> {
  data: T;
  /** Normalized response ETag, `null` when the response carried none. */
  etag: string | null;
  /** Both ETags known and different: the served artifact is not the announced one (M4 reload prompt). */
  stale: boolean;
}

export interface CatalogBundle {
  stars: StarCatalogInput;
  index: Loaded<StarIndexEntry[]>;
  /** `null` when `/meta.catalogs.dso` is absent (degraded, B-42) or the optional load failed. */
  dso: Loaded<DsoEntry[]> | null;
  /** `null` when `/meta.catalogs.constellations` is absent or the optional load failed. */
  constellations: Loaded<ConstellationEntry[]> | null;
  starsEtag: string | null;
  starsStale: boolean;
}

export type CatalogStatusListener = (name: CatalogName, status: LoadStatus) => void;

export interface LoadCatalogsOptions extends RequestOptions {
  onStatus?: CatalogStatusListener;
}

function withPolygons(entry: components['schemas']['ConstellationEntry']): ConstellationEntry {
  return { ...entry, polygons: entry.boundary_parts ?? [entry.boundary] };
}

async function loadStars(
  meta: MetaResponse,
  options: RequestOptions,
  onStatus: CatalogStatusListener | undefined,
): Promise<{ stars: StarCatalogInput; etag: string | null; stale: boolean }> {
  onStatus?.('stars', 'loading');
  try {
    const started = performance.now();
    const { buffer, response } = await getBytes('/api/v1/catalogs/stars', options);
    const columns = parseSkys(buffer);
    const hipIndex = buildHipIndex(columns.hip);
    const parseMs = performance.now() - started;
    const etagHeader = response.headers.get('ETag');
    const stale = isStaleEtag(etagHeader, meta.catalogs.stars.etag);
    onStatus?.('stars', stale ? 'stale' : 'ready');
    return {
      stars: {
        columns,
        hipIndex,
        magnitudeLimit: meta.catalogs.stars.magnitude_limit,
        parseMs,
      },
      etag: normalizeEtag(etagHeader),
      stale,
    };
  } catch (error) {
    onStatus?.('stars', 'error');
    throw error;
  }
}

async function loadJsonCatalog<T>(
  name: CatalogName,
  fetchData: () => Promise<{ data: T; response: Response }>,
  metaEtag: string | undefined,
  onStatus: CatalogStatusListener | undefined,
): Promise<Loaded<T>> {
  onStatus?.(name, 'loading');
  try {
    const { data, response } = await fetchData();
    const etagHeader = response.headers.get('ETag');
    // `/meta` announces no ETag for the star index: `isStaleEtag` never reports it stale.
    const stale = isStaleEtag(etagHeader, metaEtag);
    onStatus?.(name, stale ? 'stale' : 'ready');
    return { data, etag: normalizeEtag(etagHeader), stale };
  } catch (error) {
    onStatus?.(name, 'error');
    throw error;
  }
}

/** An optional catalog fails soft (`null`): its layer is simply absent (degraded mode, B-42). */
async function optional<T>(load: Promise<Loaded<T>>): Promise<Loaded<T> | null> {
  try {
    return await load;
  } catch {
    return null;
  }
}

/**
 * Attempts for an optional catalog. Its failure only hides a layer (degraded mode, B-42), so boot
 * must not wait for the full policy (up to four `Retry-After` waits of 60 s during a degraded
 * race) before failing soft: one retry absorbs a transient proxy error and nothing more. A
 * stricter policy from the caller is kept.
 */
const OPTIONAL_MAX_ATTEMPTS = 2;

function optionalRequestOptions(options: RequestOptions): RequestOptions {
  const callerMax = options.retry?.maxAttempts ?? OPTIONAL_MAX_ATTEMPTS;
  return {
    ...options,
    retry: { ...options.retry, maxAttempts: Math.min(callerMax, OPTIONAL_MAX_ATTEMPTS) },
  };
}

/**
 * Load every catalog `/meta` announces, in parallel. Stars and the index are required and
 * retried through the client policy; `dso` and `constellations` are fetched only when their
 * `/meta.catalogs` entry is present and not `null` (absent = degraded, status `missing`), with at
 * most `OPTIONAL_MAX_ATTEMPTS` attempts before they fail soft.
 */
export async function loadCatalogs(
  meta: MetaResponse,
  options: LoadCatalogsOptions = {},
): Promise<CatalogBundle> {
  const { onStatus, ...requestOptions } = options;
  const fetchOptions: RequestOptions = { ...requestOptions, cache: 'no-cache' };
  const optionalOptions = optionalRequestOptions(fetchOptions);
  const { dso: dsoMeta, constellations: constellationsMeta } = meta.catalogs;

  const starsPromise = loadStars(meta, fetchOptions, onStatus);
  const indexPromise = loadJsonCatalog(
    'index',
    () => getJson('/api/v1/catalogs/stars/index', undefined, fetchOptions),
    undefined,
    onStatus,
  );
  let dsoPromise: Promise<Loaded<DsoEntry[]> | null>;
  if (dsoMeta === undefined || dsoMeta === null) {
    onStatus?.('dso', 'missing');
    dsoPromise = Promise.resolve(null);
  } else {
    dsoPromise = optional(
      loadJsonCatalog(
        'dso',
        () => getJson('/api/v1/catalogs/dso', undefined, optionalOptions),
        dsoMeta.etag,
        onStatus,
      ),
    );
  }
  let constellationsPromise: Promise<Loaded<ConstellationEntry[]> | null>;
  if (constellationsMeta === undefined || constellationsMeta === null) {
    onStatus?.('constellations', 'missing');
    constellationsPromise = Promise.resolve(null);
  } else {
    constellationsPromise = optional(
      loadJsonCatalog(
        'constellations',
        async () => {
          const { data, response } = await getJson(
            '/api/v1/catalogs/constellations',
            undefined,
            optionalOptions,
          );
          return { data: data.constellations.map(withPolygons), response };
        },
        constellationsMeta.etag,
        onStatus,
      ),
    );
  }

  const [stars, index, dso, constellations] = await Promise.all([
    starsPromise,
    indexPromise,
    dsoPromise,
    constellationsPromise,
  ]);
  return {
    stars: stars.stars,
    index,
    dso,
    constellations,
    starsEtag: stars.etag,
    starsStale: stars.stale,
  };
}
