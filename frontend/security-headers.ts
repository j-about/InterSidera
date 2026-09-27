// The security headers and the Content-Security-Policy of the web tier, defined once (plan D147;
// the ADR arrives with the M6 documentation area). Node side only: `vite.config.ts` hands the
// map to `vite preview` (`preview.headers`, what Playwright and CI run against) and to `vite dev`
// (`server.headers`, with a per-process nonce on `script-src` and `style-src` for the inline
// Fast Refresh preamble and the dev client's injected `<style>` elements); at M7 the nginx
// template applies the same values through `add_header ... always` at server level, and a check
// script diffs the template against `cspHeader()`. Never a `<meta http-equiv>` tag: it cannot
// carry `frame-ancestors`, cannot know the geocoder origin of the deployment, would conflict with
// the dev nonce and only covers the HTML document; headers cover every response. No report
// endpoint (the brief forbids storing requests, l.275), no COEP (nothing needs cross-origin
// isolation), no HSTS and no `Cache-Control` here (the TLS-terminating nginx owns them at M7).
//
// The one variable is `SKY_GEOCODER_ORIGIN` (plan D148): an origin, never a URL, equal to the
// origin of `SKYAPI_GEOCODER_URL`, read by `vite.config.ts` through `loadEnv` (prefix-filtered, no
// `SKYAPI_*` value is touched, never `VITE_*`: nothing here reaches the client bundle).

/** The default Nominatim origin (`SKYAPI_GEOCODER_URL`'s default, backend `settings.py`). */
export const CSP_GEOCODER_ORIGIN_DEFAULT = 'https://nominatim.openstreetmap.org';

export interface SecurityHeaderOptions {
  /** The origin the place search may reach (`connect-src 'self' <origin>`). */
  geocoderOrigin: string;
  /** Dev server only: the nonce stamped on Vite's inline tags (`html.cspNonce`). */
  nonce?: string;
}

/**
 * `SKY_GEOCODER_ORIGIN` from `env`, or the default when unset. A path, a trailing slash, a query,
 * a fragment, credentials, a non-http(s) scheme or an explicit default port are configuration
 * errors: the value must equal its own `new URL(v).origin` so that the header names exactly the
 * origin the browser compares against.
 */
export function geocoderOriginFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  const value = env.SKY_GEOCODER_ORIGIN;
  if (value === undefined) {
    return CSP_GEOCODER_ORIGIN_DEFAULT;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `SKY_GEOCODER_ORIGIN=${JSON.stringify(value)} is not a URL; an origin such as ${CSP_GEOCODER_ORIGIN_DEFAULT} is expected`,
    );
  }
  // `ftp:` is a special scheme whose origin equals itself: the scheme check is explicit.
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) {
    throw new Error(
      `SKY_GEOCODER_ORIGIN=${JSON.stringify(value)} must be an origin (http(s)://host[:port], no path, slash or query); ${JSON.stringify(url.origin)} would be its origin`,
    );
  }
  return value;
}

/** The base64 alphabet of `randomBytes(n).toString('base64')`: a nonce never breaks the header. */
const NONCE_PATTERN = /^[A-Za-z0-9+/]+=*$/;

/**
 * The `Content-Security-Policy` value: `default-src 'none'` and one explicit source list per
 * fetch directive the application needs (the module scripts and the built stylesheet from
 * `/assets/`, `/favicon.svg`, the same-origin `/api/v1/*` plus the geocoder, the web manifest),
 * `'none'` on what it never uses (workers, media fetches: the camera `<video>` takes a
 * `MediaStream` through `srcObject`, plug-ins) and the navigation directives closed (`base-uri`,
 * `form-action`: every form submit is intercepted, `frame-ancestors`). With `nonce` (the dev
 * server only), `script-src` and `style-src` gain `'nonce-<n>'`, `worker-src` opens to `blob:` for
 * Vite's HMR client, and nothing else changes.
 */
export function cspHeader({ geocoderOrigin, nonce }: SecurityHeaderOptions): string {
  if (nonce !== undefined && !NONCE_PATTERN.test(nonce)) {
    throw new Error('the CSP nonce must be base64');
  }
  const nonceSource = nonce === undefined ? '' : ` 'nonce-${nonce}'`;
  return [
    "default-src 'none'",
    `script-src 'self'${nonceSource}`,
    `style-src 'self'${nonceSource}`,
    "img-src 'self'",
    `connect-src 'self' ${geocoderOrigin}`,
    "manifest-src 'self'",
    // dev only: Vite's client polls for a server restart from a `SharedWorker` built on a `blob:`
    // URL (client.mjs `waitForSuccessfulPing`, Vite 8.3.0 l.1084-1104); `'none'` blocks it and the
    // tab never reconnects (measured 2026-09-23). Production keeps `'none'`: no HMR client there.
    nonce === undefined ? "worker-src 'none'" : 'worker-src blob:',
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * `Permissions-Policy`: `(self)` on exactly the features the application uses (geolocation for
 * OBS-1, the camera for AR-1/AR-2, the orientation sensors, which Chromium answers
 * `requestPermission()` from, and WebXR); `()` (disabled everywhere, the top-level document
 * included) on the rest. `bluetooth` is not listed: Chromium warns on the name. `clipboard-write`
 * (the share button) and `fullscreen` keep their defaults.
 */
const PERMISSIONS_POLICY = [
  'camera=(self)',
  'geolocation=(self)',
  'gyroscope=(self)',
  'magnetometer=(self)',
  'accelerometer=(self)',
  'xr-spatial-tracking=(self)',
  'microphone=()',
  'payment=()',
  'usb=()',
  'serial=()',
  'hid=()',
  'midi=()',
  'display-capture=()',
  'picture-in-picture=()',
  'publickey-credentials-get=()',
  'idle-detection=()',
].join(', ');

/**
 * Every header of the web tier, as served on the document, the assets, the manifest and the
 * favicon. `Referrer-Policy` doubles the `<meta name="referrer">` of `index.html` with the same
 * value (the header covers non-HTML responses, the meta survives a header-stripping proxy);
 * `X-Frame-Options` is the legacy twin of `frame-ancestors 'none'`; COOP and CORP keep the
 * documents and the catalogs to this origin (CORS requests are unaffected, so the dev
 * `CORS_ORIGINS` path keeps working).
 */
export function securityHeaders(options: SecurityHeaderOptions): Record<string, string> {
  return {
    'Content-Security-Policy': cspHeader(options),
    'Permissions-Policy': PERMISSIONS_POLICY,
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}
