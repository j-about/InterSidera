// Nominatim place search (OBS-4, brief l.193, l.318, l.554; plan D97). Deliberately apart from
// `api/client.ts`: the typed client retries 429s, which the Nominatim usage policy forbids, so
// this module does one `fetch`, no retry, no cache. The request carries the typed text alone
// (OBS-7: never the observer's coordinates), `format=jsonv2`, `limit=5`, the UI language as the
// documented `accept-language` parameter, the contact `email` when `/meta.geocoder.email` gives
// one, and identifies the caller by its Referer (`referrerPolicy` here, the `<meta name="referrer">`
// in index.html). The caller (the panel) enforces submit-only, one request in flight and the
// policy's one-second interval; this module turns the answers into `GeocoderResult`s and the
// failures into the three error classes the panel translates.

import { serializeQuery } from './client';
import type { Lang } from '../state/types';
import type { GeocoderError, GeocoderResult } from '../state/types';

/** The policy's absolute maximum of one request per second (OSMF Nominatim usage policy). */
export const GEOCODER_POLICY_MIN_INTERVAL_MS = 1000;
/** Results per query (the panel lists five). */
export const GEOCODER_LIMIT = 5;

/** `/meta.geocoder.min_interval_ms`, never below the policy's own second (a misconfiguration guard). */
export function geocoderMinIntervalMs(minIntervalMs: number): number {
  return Math.max(minIntervalMs, GEOCODER_POLICY_MIN_INTERVAL_MS);
}

/** 403 or 429: the service refuses us; no automatic retry, the user is told. */
export class GeocoderBlockedError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`geocoder blocked (${String(status)})`);
    this.name = 'GeocoderBlockedError';
    this.status = status;
  }
}

/** Another failure status or a network error. */
export class GeocoderUnavailableError extends Error {
  readonly status: number | null;
  constructor(status: number | null, cause?: unknown) {
    super(status === null ? 'geocoder unreachable' : `geocoder failed (${String(status)})`, {
      cause,
    });
    this.name = 'GeocoderUnavailableError';
    this.status = status;
  }
}

/** A body that is not the documented jsonv2 array. */
export class GeocoderInvalidError extends Error {
  constructor(message = 'geocoder answered an unexpected body') {
    super(message);
    this.name = 'GeocoderInvalidError';
  }
}

/** The panel's error code for a thrown value (anything unexpected reads as unavailable). */
export function geocoderErrorOf(error: unknown): GeocoderError {
  if (error instanceof GeocoderBlockedError) {
    return 'blocked';
  }
  if (error instanceof GeocoderInvalidError) {
    return 'invalid';
  }
  return 'unavailable';
}

export interface GeocoderUrlOptions {
  /** `/meta.geocoder.url`, without a trailing slash. */
  baseUrl: string;
  /** `/meta.geocoder.email` when configured (a `null` from the contract is passed as absent). */
  email?: string;
  lang: Lang;
}

export interface SearchPlacesOptions extends GeocoderUrlOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * `${baseUrl}/search?accept-language=<lang>&email=<email>&format=jsonv2&limit=5&q=<text>`: sorted
 * keys through the client's serializer, `email` only when defined.
 */
export function geocoderSearchUrl(q: string, options: GeocoderUrlOptions): string {
  const base = options.baseUrl.replace(/\/+$/, '');
  const query = serializeQuery({
    'accept-language': options.lang,
    email: options.email,
    format: 'jsonv2',
    limit: GEOCODER_LIMIT,
    q,
  });
  return `${base}/search?${query}`;
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value);
  }
  return null;
}

function stringOf(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** One jsonv2 row (`lat`/`lon` are strings there) to a result; `null` when the row is not one. */
function parseRow(row: unknown): GeocoderResult | null {
  if (typeof row !== 'object' || row === null) {
    return null;
  }
  const record = row as Record<string, unknown>;
  const placeId = numberOf(record.place_id);
  const lat = numberOf(record.lat);
  const lon = numberOf(record.lon);
  const displayName = record.display_name;
  if (placeId === null || lat === null || lon === null || typeof displayName !== 'string') {
    return null;
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  return {
    placeId,
    displayName,
    lat,
    lon,
    category: stringOf(record.category),
    type: stringOf(record.type),
  };
}

/** The jsonv2 array as results; throws `GeocoderInvalidError` on anything else. */
export function parseNominatimResults(body: unknown): GeocoderResult[] {
  if (!Array.isArray(body)) {
    throw new GeocoderInvalidError();
  }
  const results: GeocoderResult[] = [];
  for (const row of body) {
    const parsed = parseRow(row);
    if (parsed === null) {
      throw new GeocoderInvalidError('geocoder row is not a jsonv2 place');
    }
    results.push(parsed);
  }
  return results;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * One search request. Resolves with the results (possibly empty: the caller reads `no_results`);
 * rejects with `GeocoderBlockedError` (403, 429), `GeocoderUnavailableError` (other statuses,
 * network) or `GeocoderInvalidError` (malformed body). An abort rethrows the `AbortError`.
 */
export async function searchPlaces(
  q: string,
  options: SearchPlacesOptions,
): Promise<GeocoderResult[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = geocoderSearchUrl(q, options);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      referrerPolicy: 'strict-origin-when-cross-origin',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error: unknown) {
    if (isAbort(error)) {
      throw error;
    }
    throw new GeocoderUnavailableError(null, error);
  }
  if (response.status === 403 || response.status === 429) {
    throw new GeocoderBlockedError(response.status);
  }
  if (!response.ok) {
    throw new GeocoderUnavailableError(response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error: unknown) {
    throw new GeocoderInvalidError(error instanceof Error ? error.message : 'unreadable body');
  }
  return parseNominatimResults(body);
}
