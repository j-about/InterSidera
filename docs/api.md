# API

Status: stub written at M0; the SKYS byte layout, the catalog JSON shapes and the minor-body id syntax written at M1; completed at M2 (every endpoint but `/sky/events`, canonicalization, caching headers and ETags, RFC 9457 problem types, rate limiting, warnings, rounding, degraded mode). M6 (2026-09-24): the two security headers of the API and the docs-page policy (section "Security headers and the reverse proxy"), the advertised coverage bounds on the canonical 1e-8 day grid (backlog B-52), no Swagger OAuth2 redirect route; the contract itself is unchanged (`api_version` 1.1.0, `make types` produces no diff). M7 (2026-09-28): the reverse-proxy section describes the nginx edge as deployed (two policies on `/api/*`, `Server: nginx`, 414 at the edge, the pass-through of the caching headers, the hidden docs pair, `FORWARDED_ALLOW_IPS` set by compose; ADR-0024); the contract is unchanged again. M7 acceptance fix (2026-09-30): the served geocoder attribution and its `GeocoderMeta.attribution` example read "© OpenStreetMap contributors" as the brief words it (l.193, l.318; "(c)" until then): an `examples` string only, `api_version` stays 1.1.0. The binding contract is `docs/brief.xml`, api_contract section (l.100-184); the machine-readable document is `docs/openapi.json`. Measured latencies live in `docs/testing.md` "Budgets".

## Base path and conventions (brief l.101-109)

- Base path `/api/v1`. All endpoints are GET, stateless and deterministic: the same canonical query always produces the same body.
- Query parameters are canonicalized before computing and before any cache lookup (section "Canonicalization"). The reference frontend sends coordinates rounded to 0.01 degrees (OBS-7) and aligns `tt0` to the sample grid so users watching the same sky share cache keys; the backend accepts any finite `tt`.
- JSON responses are Pydantic v2 models with complete OpenAPI metadata (descriptions, examples, bounds); the TypeScript types in `frontend/src/api/schema.d.ts` are generated from `docs/openapi.json` and committed; CI fails on drift.
- Binary responses use `application/octet-stream`, little-endian, a versioned magic header and packed columnar typed arrays (section "Binary catalog format SKYS v1").
- Caching headers: catalogs `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` with a strong content-hash `ETag` and `If-None-Match` -> 304; frames, altaz and minor-body lists `public, max-age=300`; `/meta` and `/health` `no-store` (section "Caching headers").
- GZip: `GZipMiddleware(minimum_size=1024, compresslevel=6, exclude_content_types=("application/octet-stream",))` compresses every JSON body of at least 1 KiB when the client sends `Accept-Encoding: gzip`, problem documents included. The binary SKYS catalog is served uncompressed: its float32 unit vectors shrink by 17 % only while gzip costs 100-155 ms per request at any level, which would break the 50 ms catalog budget (measured at M2, backlog B-46); nginx compresses nothing on the fly either (`gzip off`; `gzip_static` serves only files nginx owns, never a proxied response), so the SKYS reaches the browser uncompressed through the edge as well, with its strong `ETag`, `Accept-Ranges: bytes` and Range 206 intact (backlog B-99; a stored gzip would be an API-side change, plan R115).
- Errors follow RFC 9457 (`application/problem+json`) with a closed list of problem types (section "Problem types"): 400 invalid parameter, 404 unknown object, 422 outside data coverage (the response carries the valid range), 429 rate limited (`Retry-After`), 503 data not ready (`Retry-After`).
- Rate limiting: in-memory token bucket per client IP on the compute endpoints, default 20 requests/s with a burst of 40, per worker process (section "Rate limiting").
- Units: angles in degrees, distances in astronomical units, time as TT Julian Date unless the field is suffixed `_utc` or named `utc0` or `server_time.utc` (ISO 8601, `Z`, proleptic Gregorian, astronomical year numbering: year 0 exists, 45 BC prints as `-0044`), angular sizes in degrees, magnitudes as floats. Quaternions are `[x, y, z, w]` (Hamilton), sign-continuous along a window.
- Cross-origin: `CORSMiddleware` allows the origins of `SKYAPI_CORS_ORIGINS` (default `https://localhost:5173`), the GET method, the `If-None-Match` request header, and exposes `ETag`, `Server-Timing`, `Retry-After` and `X-Request-Id`; preflight answers are cached for 600 s.
- Request ids: every response carries `X-Request-Id`, echoing the request header (lower-cased) when it is UUID-shaped and generating a UUID otherwise; a 500 problem document carries it too and names it in `detail`. Starlette's server-error layer sits outside the CORS layer, so 500 responses carry no CORS headers (a cross-origin client sees a network error for them): accepted at M6 (plan D150, D166; backlog B-95) because the application calls relative URLs on its own origin only and nginx adds no CORS header; the 500 handler does add `X-Content-Type-Options` and the deny-all `Content-Security-Policy` beside `X-Request-Id` (section "Security headers and the reverse proxy"). The server's JSON access record carries the path only, never the query string (coordinates are private, brief l.275).

## Security headers and the reverse proxy (M6, M7; plan D149, D150, D166, D183, D185, D193; ADR-0018, ADR-0024)

- Every response carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'`, appended by `middleware/headers.py::SecurityHeadersMiddleware` (pure ASGI) when absent: a browser opening an API URL directly gets a document that loads, frames and re-bases nothing. The Swagger page (`app.docs_url`) alone carries `default-src 'none'; script-src https://cdn.jsdelivr.net 'unsafe-inline'; style-src https://cdn.jsdelivr.net 'unsafe-inline'; img-src https://fastapi.tiangolo.com data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'` (the swagger-ui-dist bundle and stylesheet, FastAPI's inline init script, the favicon, the `data:` images of the UI and the same-origin `/api/v1/openapi.json` fetch; never `sandbox`).
- Middleware order (outermost first): `RequestContextMiddleware` > `SecurityHeadersMiddleware` > `CORSMiddleware` > `GZipMiddleware` > app. The headers middleware sits outside CORS so that the headers land on preflights (`CORSMiddleware` answers them without calling the inner app), on problem documents and on 304s; `tests/api/test_middleware.py` proves them on 200, 400, 404, 304, 429, 503, the accepted and the refused preflight, 405, the docs page and its slash redirect, `tests/api/test_problems.py` on the 500 path (Starlette's `ServerErrorMiddleware` is outside every user middleware, so `unhandled_exception_handler` adds the two headers itself through `security_headers()`).
- The brief assigns the security headers to nginx (l.274); these two live in the API because the dev and preview servers proxy `/api` upstream headers unchanged, so nothing else can put `nosniff` on the API in those stacks (backlog B-87). Behind nginx (the container stack) every `/api/*` response carries two policies: nginx adds the full web-tier set once at http level with `always` (so 304s, problem documents and its own 504 and 502 while the api restarts carry it too: 504 after the 5 s connect timeout while the container is stopped, 502 while it is back but not listening yet) and the API's `nosniff` and deny policy ride beside them; the browser intersects the two (plan D193: +781 B per response, a catalog 304 about 1.1 kB of headers instead of 0.3; `url-state.spec.ts` is unaffected because Chromium's `transferSize` is the constant 300 for a validated response). The web-tier set itself (the CSP, `Permissions-Policy`, `Referrer-Policy`, `X-Frame-Options`, COOP, CORP, HSTS on TLS connections, the `Cache-Control` classes) is documented in `docs/architecture.md` "Security and privacy" and "Deployment".
- `HEAD` answers 405 `problem-http-error` (with `Allow`) on every route: a `head` operation would be a contract change and nothing needs it (plan D166, Q80); every probe uses GET (the api container's healthcheck is a `urllib.request` GET of `/api/v1/health`; the web container probes nginx's own `/healthz` with `wget --spider`, never a proxied path).
- Request-line and header-size bounds are nginx's defaults: a request line above 8 kB (`large_client_header_buffers 4 8k`) answers 414 at the edge before the API sees it, a request body above 16 kB (`client_max_body_size 16k`) 413; the API itself is GET-only with explicit parameter bounds (the canonicalization table) and a 100,000-byte query string already answers 400 at the query layer; the bare `fastapi run` answers 200 to a 9,035-byte and to a 17,035-byte request line (uvicorn with httptools accepts them; measured 2026-09-28, probe 18 of docs/testing.md "Delivery (M7)"), so the 414 exists at the edge only (nginx's own page, with the seven headers and `Connection: close`). `Server: uvicorn` stays on the API's own responses and never reaches a client behind nginx, which passes no upstream `Server` (`proxy_hide_header Server` states the intent) and sends `Server: nginx` without a version (`server_tokens off`; OSS nginx cannot omit the header, plan D193).
- The rate-limit key behind a proxy: uvicorn's `--forwarded-allow-ips` flag or the `FORWARDED_ALLOW_IPS` environment variable (uvicorn 0.53.0 reads the variable with the default `127.0.0.1,::1` when the flag is absent; `fastapi run` passes no flag), set by `compose.yaml` to `web`'s fixed address on the compose network, `10.213.0.3` (written once as `x-sky.web_address`, beside the subnet `x-sky.subnet`; never the whole network, whose gateway `10.213.0.1` relays the host's connections and, behind Docker Desktop's userland proxy, every published-port connection; never `*`): nginx sends `X-Forwarded-For: $proxy_add_x_forwarded_for`, uvicorn walks it from the right and stops at the first untrusted address, which is the one nginx itself appended (the real client on a Linux host, the gateway behind Docker Desktop), so a client-supplied entry is never reached and a forged header is keyed like an unforged one; an external proxy whose `X-Forwarded-For` must be honoured is appended after the web address through `compose.override.yaml`, its address as nginx sees it (section "Rate limiting"; `.env.example` keeps the variable commented for a host-run API behind a local proxy; `docs/architecture.md` "Deployment").
- Pass-through at the edge: the API's `ETag`, `Cache-Control`, `Server-Timing`, `Retry-After` and `X-Request-Id` reach the client unchanged, and so do the client's `If-None-Match` and `Range` (a catalog 304 and a Range 206 work through nginx; probes 12 and 13 of `docs/testing.md` "Delivery (M7)"); the API's gzipped JSON passes through untouched (`gzip off` at the edge, backlog B-99). The docs pair `/api/v1/docs` and `/api/v1/docs/` answers 404 at the edge (two exact-match locations, so the API's 307 for the slash form never runs) while `/api/v1/openapi.json` stays public; the page stays reachable inside the compose network (backlog B-95).
- `/meta.geocoder.email` is public by design: `/meta` advertises it and every browser forwards it to Nominatim as the `email` parameter, so it must never be a private mailbox (`.env.example`).
- GZip on JSON responses stays: BREACH needs a secret inside the compressed body and the API carries none (no session, no token, no cookie).

## OpenAPI document and generated types

- `docs/openapi.json` is produced by `backend/src/skyapi/tools/dump_openapi.py`: it builds `create_app(default_settings())`, ignoring the environment (nothing settings-dependent may enter the document, decision D27), and writes `json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False)` plus a trailing newline to the `--out` path.
- `make types` runs that tool (`--out $(CURDIR)/docs/openapi.json`) and then `npm --prefix frontend run gen:types` = `openapi-typescript ../docs/openapi.json -o src/api/schema.d.ts --alphabetize`. Tuple fields (`radii_km`, `coverage_tt`, quaternions, unit vectors) become TypeScript tuples through `prefixItems`.
- `make check-contract` (part of `make check`) runs `make types`, asserts both files are tracked (`git ls-files --error-unmatch`) and unchanged (`git diff --exit-code`). CI splits the same gate: the backend job diffs `docs/openapi.json`, the frontend job regenerates `schema.d.ts` from the committed document.
- The pytest snapshot test compares the rendered document with the committed file and prints "run `make types`" on mismatch. A contract change is therefore always deliberate: code, `openapi.json` and `schema.d.ts` move in one commit, and `api_version` in `/meta` (`1.1.0`, `skyapi.api.API_VERSION`) follows semver of the contract while `info.version` stays the package version (1.0.0 at M2; 1.1.0 at M4 for the additive `constellation` field of `/sky/altaz`; unchanged at M6, which touched no route, model or parameter: the advertised coverage bounds moved by less than 1e-8 day and response headers are not part of the document; unchanged by the M7 acceptance fix, which altered one `examples` string of `GeocoderMeta.attribution`: an example or a description regenerates the two files without a version change, ADR-0017 amendment).
- Error documentation: every route declares its problem statuses with an `application/problem+json` content block referencing `components.schemas.Problem`, plus a `default` response stating that any other error is a problem document. FastAPI's `HTTPValidationError` therefore does not appear: validation errors are 400 problems (section "Problem types").
- Interactive docs: `/api/v1/docs` (Swagger UI, its GET served under the relaxed docs policy of the section "Security headers and the reverse proxy": its bundle and stylesheet come from jsdelivr, the one third-party origin of the project, which is why production hides the page at the edge with `location = /api/v1/docs { return 404; }` and its slash twin in `frontend/nginx/sky/app.conf` rather than through a twelfth `SKYAPI_` setting; plan D150, D185, backlog B-95; the API container keeps serving it inside the compose network); `/api/v1/openapi.json` serves the same document at runtime and stays public; `/api/v1/docs/` answers a 307 to the page; ReDoc is disabled; `swagger_ui_oauth2_redirect_url=None` because no OAuth flow exists, so FastAPI's root-level `/docs/oauth2-redirect` page (an inline script the strict policy refuses) is not registered and answers 404 like any unrouted path.

## Canonicalization (D55, brief l.102)

Applied by `skyapi/api/canonical.py` to every compute request before validation of the ranges, before the cache lookup and before any Skyfield call. Every response echoes the canonical values (`observer.lat_deg`, `observer.lon_deg`, `observer.elev_m`, `time.tt0`, `time.step_s`, `time.n`), so a client can learn the cache key it actually hit.

| Parameter | Rule |
| --------- | ---- |
| `lat` | rounded to 1e-6 degrees, then validated within `[-90, 90]` |
| `lon` | rounded to 1e-6 degrees, normalised to `[-180, 180)` with `((lon + 180) % 360) - 180`, rounded again and added to `+0.0`, so `-0.0` never appears and `lon=180` becomes `-180` |
| `elev` | rounded to whole metres (`elev_m` is still serialised as a float, `35.0`), validated within `[-12000, 100000]` m |
| `tt` | rounded to 1e-8 day (about 1 ms): `round(tt, 8) + 0.0`; any finite value is accepted at the query layer (`NaN` and infinities are 400), data coverage decides the 422 |
| `step_s` | integer in `[1, 31557600]` (one Julian year), then clamped to the smallest `limits.max_step_s` class among the requested bodies (`minor` when any minor body is requested); the clamped value is echoed in `time.step_s` |
| `n` | integer in `[1, 64]` (`limits.max_samples`) |
| `bodies`, `minor`, `targets` | split on `,` only, items stripped, sorted, de-duplicated; an empty item, an empty list, `all` mixed with ids, or `+`/space separators are 400 |
| `bodies=all` (default) | expands to every body of `/meta.bodies` minus the observer's own body; naming the observer in an explicit list is a 400 |
| `minor` ids | must match `^[ac]:[A-Za-z0-9/_.-]+$` (`a:1`, `c:1P`, `c:C/2023_A3`, `c:73P-BT`), at most 100 (`limits.max_minor_bodies`) |
| `targets` | at most 200 (`limits.max_targets`) |
| frame size | `n * (len(bodies) + len(minor)) <= 4096` |

Properties guaranteed (hypothesis-tested): canonicalizing twice gives the same result; list order does not matter; two requests that differ below the rounding step share one cache key; `-0.0` never appears; the canonical `lon` is always in `[-180, 180)`. The frame cache key is the sorted `key=value&...` string of the canonical query (`FrameQuery.cache_key()`).

## GET /health

Readiness of the API and its data (D52, ADR-0008). Never cached (`Cache-Control: no-store`), never rate limited, needs no data.

| Status | HTTP | Body | Headers |
| ------ | ---- | ---- | ------- |
| `starting` | 503 | `{ status, progress?, detail?, version }` | `Retry-After: 5` |
| `ready` | 200 | `{ status, version }` | |
| `degraded` | 200 | `{ status, missing, version }` | |

- `progress` (`{ file, downloaded_bytes, total_bytes }`, `total_bytes` 0 when the origin did not say) is present only while a data file is being downloaded (`SKYAPI_AUTO_FETCH=true`).
- `missing` lists the data groups that are absent while `degraded`: `dso`, `constellations`, `mpc` (machine-readable codes, never free text; the affected endpoints answer 503, section "Degraded mode").
- `detail` is set only when the bootstrap failed for good (a required file missing with `SKYAPI_AUTO_FETCH=false`, a failed required download, an unknown `SKYAPI_EPHEMERIS`, a missing cache source or artifact, a kernel that cannot be loaded; a corrupt cache is rebuilt, not fatal): the status then stays `starting` and the process stays up so the operator can read the reason. The bootstrap runs in a background thread; the server accepts connections immediately and every data-dependent route answers 503 until it is published.
- `missing` and `detail` are additive to the brief's shape (backlog B-41); optional fields are absent, not `null`.

## GET /meta

Contract version, server time, coverage, observers, bodies, catalogs, geocoder and limits (D60). `Cache-Control: no-store`, 503 while `starting`. Everything but `server_time` is computed once at bootstrap. No `/meta` field is ever `null`: optional entries are absent (`response_model_exclude_none`).

| Field | Content |
| ----- | ------- |
| `api_version` | `"1.1.0"`, semver of the API contract (1.1.0: additive `constellation` on `/sky/altaz` rows, M4) |
| `server_time` | `{ tt, utc, tt_minus_utc_seconds }` at the time of the request |
| `ephemeris` | `{ name, coverage_tt: [start, end] }`, the file behind the server and its usable TT range (light-time margin applied); since M6 both bounds lie on the API's 1e-8 day `tt` grid (`astro/loader.py::ceil_to_grid` and `floor_to_grid`: the nearest grid point unless it lies outward, then the next one inward; never outward, inward by less than one step of 0.86 ms; de440s advertises `[2396753.50000001, 2506351.49999999]`), so a request at the advertised bound is served and one grid step beyond is a 422 (backlog B-52); the same rule applies to `observers[].coverage_tt` and `coverage.ephemeris_tt` |
| `observers[]` | `{ id, name_key, frame, radii_km: [a, b, c], latitude_kind, coverage_tt, approximation_code? }` for `mercury`, `venus`, `earth`, `moon`, `mars`, `jupiter`, `saturn`, `uranus`, `neptune`, `pluto`; `frame` is `ITRS` (Earth, geodetic WGS84 latitude), `MOON_ME_DE440_ME421` (Moon) or `IAU_<BODY>` (planetocentric latitude); the Moon's `coverage_tt` is the ephemeris range intersected with the Moon orientation kernel; `approximation_code` is `pluto_barycenter` for Pluto |
| `coverage` | `{ ephemeris_tt, delta_t: { observed_tt, predicted_until_tt }, iau_rotation_reliable_tt, proper_motion_warning_years: 10000, mpc_elements: { warn_years: 2, error_years: 50 } }`; `delta_t.observed_tt` runs from -720 (historical tables) to one year before the end of the IERS daily table, `predicted_until_tt` is the end of the Bulletin A predictions; `iau_rotation_reliable_tt` is 1800-01-01..2200-01-01 |
| `bodies[]` | `{ id, kind, name_key, radius_km, step_class }` for `sun`, `mercury`, `venus`, `earth`, `moon`, `mars`, `jupiter`, `saturn`, `uranus`, `neptune`, `pluto`; `kind` is `star`, `planet`, `dwarf_planet` or `moon`; `radius_km` is the IAU equatorial radius from the text PCK; `step_class` (additive, backlog B-43) names the `limits.max_step_s` key that bounds `step_s` when the body is requested (`moon`, `inner_planets` = Mercury, Venus, Mars, `sun_and_outer` = Sun, Earth, Jupiter to Pluto) |
| `catalogs.stars` | `{ count, version, etag, epoch_tt, magnitude_limit, license, attribution }`; `etag` is the bare SHA-256 of `/catalogs/stars` (the response header carries it quoted); `license` is the HYG license because the derived name index is share-alike, `attribution` credits Hipparcos and HYG |
| `catalogs.dso?` | `{ count, version, etag, license, attribution }` from OpenNGC; absent while the `dso` group is missing (backlog B-42) |
| `catalogs.constellations?` | `{ count, culture: "modern", etag, license, attribution }`; the license is the one declared by the Stellarium sky-culture description, the attribution credits Stellarium and d3-celestial; absent while `constellations` is missing |
| `catalogs.minor_bodies?` | `{ asteroids, comets, elements_epoch_range_tt, license, attribution }` from MPCORB and CometEls; absent while `mpc` is missing |
| `geocoder` | `{ enabled, url, email?, attribution, min_interval_ms: 1000 }`: the Nominatim instance the browser may call (the API never calls it); at least one second between two requests (OBS-4); `email` is public by design (every browser forwards it) |
| `limits` | `{ max_samples: 64, max_minor_bodies: 100, max_targets: 200, speeds: [1, 10, 60, 600, 3600, 86400, 604800, 2629800, 31557600], max_step_s: { moon: 3600, inner_planets: 21600, sun_and_outer: 86400, minor: 86400 } }`; the frontend adds the negative speeds |

## Catalog routes (D59)

The four catalog routes serve the cache files written by `sky-data build-caches` under `DATA_DIR/cache`, unchanged, with the artifact's SHA-256 from `cache/manifest.json` as a strong ETag. They are not rate limited.

| Route | Media type | Body | Cache file |
| ----- | ---------- | ---- | ---------- |
| `GET /catalogs/stars` | `application/octet-stream` | SKYS v1 (table below) | `stars.skys` |
| `GET /catalogs/stars/index` | `application/json` | `StarIndexEntry[]` | `stars_index.json` |
| `GET /catalogs/dso` | `application/json` | `DsoEntry[]` | `dso.json` |
| `GET /catalogs/constellations` | `application/json` | `ConstellationsResponse` | `constellations.json` |

- Headers on 200: `ETag: "<sha256>"` (quoted; the same value is bare in `/meta.catalogs.<name>.etag`), `Cache-Control: public, max-age=3600, stale-while-revalidate=86400`.
- Conditional GET: when `If-None-Match` names the current ETag (a comma-separated list is accepted, `W/` prefixes are compared by their opaque value, `*` always matches) the route answers `304 Not Modified` with `ETag` and `Cache-Control` and no body. Because the ETag is the content hash, a rebuilt cache with identical content keeps its ETag.
- The JSON bodies are gzip-compressed (level 6) when the client accepts it; the SKYS body is served uncompressed (see the GZip note in the conventions).
- 503 `problem-data-not-ready` when the artifact is missing: `/catalogs/dso` and `/catalogs/constellations` in degraded mode; the star artifacts are mandatory, so `/catalogs/stars` and `/catalogs/stars/index` answer 503 only while `starting`.

### Binary catalog format SKYS v1

Written by `backend/src/skyapi/catalogs/formats.py` (`write_skys`/`read_skys`, pure, 100 % covered, hypothesis round-trip) and served by `GET /catalogs/stars` as `application/octet-stream`. Little-endian throughout, no padding, `count` stars sorted by `mag` ascending so any prefix is a valid brighter-than subset (brief l.131-139).

| Offset (bytes)           | Size (bytes)  | Type          | Field      | Meaning                                                                                  |
| ------------------------ | ------------- | ------------- | ---------- | ---------------------------------------------------------------------------------------- |
| 0                        | 4             | `char[4]`     | magic      | `SKYS`                                                                                   |
| 4                        | 4             | `u32`         | version    | `1`                                                                                      |
| 8                        | 4             | `u32`         | count      | number of stars `n`                                                                      |
| 12                       | 8             | `f64`         | epoch_tt   | catalog epoch, TT Julian Date (`2451545.0` = J2000)                                      |
| 20                       | 4             | `u32`         | flags      | reserved, `0`                                                                            |
| 24                       | `12 n`        | `f32[n*3]`    | dir        | ICRF unit vector `[x, y, z]` per star at the epoch                                       |
| `24 + 12 n`              | `12 n`        | `f32[n*3]`    | pm         | tangential proper-motion velocity in ICRF, radians per Julian year (parallax ignored)    |
| `24 + 24 n`              | `2 n`         | `i16[n]`      | mag        | millimagnitudes, Johnson V (Hipparcos `Vmag`)                                            |
| `24 + 26 n`              | `2 n`         | `i16[n]`      | bv         | B-V in millimagnitudes, `32767` when unknown                                             |
| `24 + 28 n`              | `4 n`         | `u32[n]`      | hip        | Hipparcos identifier                                                                     |
| total                    | `24 + 32 n`   |               |            | about 3.8 MB for the full catalog                                                        |

Build rule (Hipparcos epoch J1991.25 propagated to J2000 by Skyfield): `p0 = SSB.at(J2000).observe(star).position`, `p1` the same one Julian year later, `dir = p0 / |p0|`, `pm = (p1 - p0) / |p0|`. Shader rule: `dir(t) = normalize(dir + pm * years_since_epoch)`, then aberration `normalize(dir(t) + observer_velocity / c)`. Parity: within 0.1 arcsec of Skyfield's barycentric direction and within 1 arcsec of `.apparent()` (gravitational deflection ignored).

### Catalog JSON shapes

- `GET /catalogs/stars/index`: `[{ hip, names: { proper?, bayer?, flamsteed? }, con }]` for the named or designated stars of HYG v4.4 (3,429 entries; the brief estimates about 4 000). `bayer` is the Greek letter with an optional superscript and the IAU abbreviation (`"α Ori"`, `"κ¹ Scl"`; the two Latin-letter Bayer designations such as `"p Eri"` pass through), `flamsteed` is `"58 Ori"`, `proper` is HYG's `proper` column verbatim (the IAU WGSN names plus a few traditional nearby-star catalog names and unofficial "B" companion names). Not translated.
- `GET /catalogs/dso`: `[{ id, names, messier?, type, ra_deg, dec_deg, mag?, major_arcmin?, minor_arcmin?, pa_deg?, con }]`. `id` is the OpenNGC name without the zero padding of its first numeric run and with spaces replaced by `_` (`NGC0224` -> `NGC224`, `IC0434` -> `IC434`, `Mel022` -> `Mel22`, `IC0080 NED01` -> `IC80_NED01`). Type map: `G`/`GPair`/`GTrpl`/`GGroup` -> `galaxy`, `OCl` -> `open_cluster`, `GCl` -> `globular_cluster`, `PN` -> `planetary_nebula`, `Neb`/`HII`/`EmN`/`RfN`/`SNR`/`Cl+N` -> `nebula`, `*`/`**`/`*Ass`/`DrkN`/`Nova`/`Other` -> `other`; `Dup` and `NonEx` rows are dropped. Messier aliases: `M31` resolves to `NGC224` through `messier`; the `M102` duplicate row follows OpenNGC's NED convention and resolves to `NGC5457` (M101), which therefore carries `"M102"` in its `names` (the catalog state rebuilds the alias map from names matching `^M\d+$`). `mag` is V else B. Subset: every Messier object plus `mag <= 14` or `major_arcmin >= 5` (configurable at build time), applied to the NGC/IC rows and to the addendum rows alike (Hyades, the Magellanic Clouds and the Horsehead pass by size). An OpenNGC type code the builder does not know fails the build instead of becoming `other`.
- `GET /catalogs/constellations`: `{ culture: "modern", constellations: [{ abbr, latin, genitive, lines: [[hip, hip], ...], boundary: [[ra_deg, dec_deg], ...], label: { ra_deg, dec_deg }, boundary_parts? }] }`. Lines come from Stellarium's `modern` sky culture, boundaries from d3-celestial (J2000, RA normalised to 0..360, closed rings). Serpens has two disjoint IAU polygons: `boundary` holds Serpens Caput and the additive optional `boundary_parts` lists both rings (deviation B-33); clients that draw boundaries must read `boundary_parts` when present.

## Minor bodies (D61)

Ids (brief l.152), used by `/minor-bodies/*`, `/sky/frame` (`minor=`) and `/sky/altaz` (`targets=`): `a:<number>` for numbered asteroids, `a:<MPC packed designation>` for unnumbered ones (`a:K24A00B`), `c:<number><orbit type>` for numbered periodic comets (`c:1P`), `c:<designation with spaces replaced by _>` otherwise (`c:C/2023_A3`). Ids are URL-safe and appear unchanged in the frontend URL (`minor`, `sel`). `(134340) Pluto` is served as the major body `pluto` and never listed among the defaults, but stays searchable.

Both routes answer `[{ id, designation, name?, kind: "asteroid" | "comet", h_mag?, elements_epoch_tt }]` (`MinorBodySummary`), `Cache-Control: public, max-age=300` (backlog B-44: the brief names no policy for them, they are treated like compute endpoints), and 503 `problem-data-not-ready` while the MPC tables are missing (`mpc` in `/health.missing`).

### GET /minor-bodies/search

| Parameter | Bounds | Default |
| --------- | ------ | ------- |
| `q` | 1 to 64 characters, whitespace collapsed | required |
| `limit` | 1 to 100 | 20 |

Ranking, from an in-memory index holding only ids, designations, names, brightness and epochs (brief l.256): (1) the exact id when `q` looks like one (`a:433`, `c:1P`; a bare number is read as `a:<number>`, a short comet form such as `1P` as `c:1P`, a packed provisional designation as `a:<packed>`); (2) designation prefix, case-insensitive (a bare number also matches the `(<number>` designation prefix); (3) case-insensitive substring of asteroid names and comet designations, ranked by brightness (H for asteroids, g for comets, unknown last). Duplicates are removed, at most `limit` rows are returned. Rate limited.

### GET /minor-bodies/defaults

No parameters. At most `limits.max_minor_bodies` (100) rows ranked by expected brightness (brief l.155): asteroids with `H <= 9` sorted by H, then comets whose elements epoch lies within `mpc_elements.warn_years` (2 years) of the server time, sorted by the proximity of their perihelion to the server time. The list is computed from the request time and cached for 300 s by clients. Not rate limited (the search route is).

## GET /sky/frame (D56, D57, brief l.157-169)

One window of `n` samples spaced `step_s` seconds apart on the TT scale: the rotations the client needs to place the sky, the observer's velocity for aberration, the Sun direction and per-sample quantities of the requested bodies and minor bodies. Plain synchronous route, rate limited, cached.

```text
GET /api/v1/sky/frame?body=earth&lat=48.8566&lon=2.3522&elev=35&tt=2461285.5&step_s=300&n=32&bodies=all&minor=a:1,c:1P
```

| Parameter | Bounds | Default |
| --------- | ------ | ------- |
| `body` | one of `/meta.observers[].id` (the Sun is never an observer) | `earth` |
| `lat` | `[-90, 90]` degrees (geodetic on Earth, planetocentric elsewhere) | required |
| `lon` | within `[-360, 360]`, east positive, wrapped to `[-180, 180)` | required |
| `elev` | `[-12000, 100000]` metres above the reference ellipsoid | `0` |
| `tt` | any finite TT Julian Date; coverage decides the 422 | required |
| `step_s` | `[1, 31557600]`, clamped per body class and echoed | `60` |
| `n` | `[1, 64]` | `32` |
| `bodies` | `all` or a `,`-separated list of `/meta.bodies[].id` without the observer | `all` |
| `minor` | `,`-separated list of at most 100 minor-body ids | none |

Response (`FrameResponse`):

```text
{
  observer: { body, lat_deg, lon_deg, elev_m, latitude_kind, warnings: [ ... ] },
  time: { tt0, step_s, n, tt_minus_utc_seconds, utc0, lst_hours?: [ n ], warnings: [ ... ] },
  horizon: { q: [ [x, y, z, w], ... n ] },
  equinox_of_date: { q: [ [x, y, z, w], ... n ] },
  observer_velocity_au_d: [ [x, y, z], ... n ],
  sun_dir: [ [x, y, z], ... n ],
  bodies: [ { id, kind, samples: { dir: [ [x, y, z], ... n ], dist_au: [ n ], mag: [ n ], phase: [ n ], diam_deg: [ n ] }, warnings: [] } ],
  minor: [ { id, name?, kind, samples: { same shape } | null, elements_epoch_tt, extrapolation_years, warnings: [ ... ] } ]
}
```

- `observer` echoes the canonical location; `latitude_kind` is `geodetic` on Earth and `planetocentric` elsewhere.
- `time.tt0` is the canonical `tt`, `time.step_s` the clamped step, `time.utc0` the first sample in UTC. `tt_minus_utc_seconds` is TT - UTC at the first sample (69.184 s in 2026); before 1972 UTC had no leap seconds, so the value is TT - UT1 (delta T) and the frontend labels the display UT; a window that straddles 1972 uses the UT1 form throughout so one frame carries one consistent label. `lst_hours` (local apparent sidereal time per sample, `[0, 24)`) exists for Earth observers only and is absent otherwise.
- `horizon.q` rotates ICRF vectors into the local East-North-Up frame, `equinox_of_date.q` into the true equator and equinox of date; both series are sign-continuous so a client may interpolate them. `observer_velocity_au_d` is the barycentric velocity in ICRF (client-side aberration), `sun_dir` the apparent ICRF unit vector towards the Sun.
- `bodies[].samples`: apparent ICRF unit vectors (light-time, aberration and deflection applied), distance in au, apparent V magnitude (display-only, `null` when unknown), illuminated fraction in `[0, 1]` (1 for the Sun) and apparent angular diameter in degrees. `bodies[].warnings` is always `[]` at API v1. `bodies[]` and `minor[]` follow the canonical (sorted) id order.
- `minor[]`: `samples` has the same shape (`diam_deg` is `0`: sizes are unknown); `elements_epoch_tt` is the epoch of the MPC elements, `extrapolation_years` the largest distance in Julian years between the window and that epoch. Beyond `mpc_elements.warn_years` (2) the object carries `mpc_extrapolation`; beyond `error_years` (50) it also carries `mpc_unreliable` and `samples` is `null` while the object stays listed. `name` is absent for unnamed objects.
- Serialisation uses `exclude_unset`: `minor[].samples: null` is written explicitly (the contract wants the object listed, l.168), whereas `time.lst_hours`, `warnings[].params`, `warnings[].range_tt` and `minor[].name` are simply absent when they do not apply. `NaN` never appears: an unknown magnitude is `null`.
- Headers: `Cache-Control: public, max-age=300`; `Server-Timing: compute;dur=<ms>, cache;desc=hit|miss`; `X-Request-Id`.
- Frame cache: an LRU of 256 serialised responses per worker process keyed on the canonical query; a hit returns the identical bytes without recomputation. The rate limiter runs before the cache lookup, so a hit still consumes a token.
- Errors: 400 `problem-invalid-parameter` (bounds, malformed lists, unknown body id, the observer named as a target, unknown observer, caps exceeded); 404 `problem-unknown-object` (a `minor` id absent from the MPC tables); 422 `problem-outside-coverage` with `range_tt` when any sample leaves the ephemeris range or the observer frame range (the Moon observer is bounded by its orientation kernel); 429 `problem-rate-limited`; 503 `problem-data-not-ready` while `starting`, or when `minor` is given while the `mpc` group is missing.

## GET /sky/altaz (D58, brief l.171-172)

Authoritative Skyfield values for up to 200 targets at one instant, used by the details panel and by the conformance tests. Plain synchronous route, rate limited, `Cache-Control: public, max-age=300`, `Server-Timing: compute;dur=<ms>`.

```text
GET /api/v1/sky/altaz?body=earth&lat=51.4779&lon=-0.0015&elev=46&tt=2461285.5&targets=hip:32349,moon,dso:NGC224,a:1,c:1P&refraction=1
```

| Parameter | Bounds | Default |
| --------- | ------ | ------- |
| `body`, `lat`, `lon`, `elev`, `tt` | as for `/sky/frame` | idem |
| `targets` | `,`-separated list of 1 to 200 targets (syntax below) | required |
| `refraction` | boolean (`0`/`1`, `true`/`false`); true is a 400 for observers other than Earth | `false` |

Target syntax: `hip:<number>` (Hipparcos star), `dso:<id>` (canonical OpenNGC id or a Messier alias: `dso:NGC224`, `dso:M31`; matching tolerates case and zero padding, `dso:ngc0224`), a body id of `/meta.bodies` other than the observer, `a:<..>` or `c:<..>` for minor bodies. Anything else is a 400.

Response: `[{ id, alt_deg, az_deg, ra_icrs_deg, dec_icrs_deg, ra_date_deg, dec_date_deg, dist_au?, mag?, phase?, diam_deg?, constellation? }]`, one row per target in canonical (sorted, de-duplicated) order, `id` as requested.

- `alt_deg` is the apparent altitude; with `refraction=1` it includes Skyfield's standard-atmosphere refraction (Bennett 1982 inverted iteratively; 10 °C and `1010 * exp(-elev_m / 9100)` mbar; zero below -1 degree and above 89.9 degrees). `az_deg` is measured from north through east in `[0, 360)`.
- `ra_icrs_deg`, `dec_icrs_deg` are the apparent ICRS coordinates, `ra_date_deg`, `dec_date_deg` refer to the true equator and equinox of date. Right ascensions are in degrees (not hours) in `[0, 360)`.
- `dist_au`, `phase` and `diam_deg` come from the same computation as `/sky/frame` samples (`n = 1`): bodies carry all three, minor bodies `dist_au` and `phase` (no size), stars and deep-sky objects none. `mag` is the apparent V magnitude for bodies and minor bodies, Hipparcos `Vmag` for `hip:` targets and the catalog magnitude for `dso:` targets when known; absent otherwise.
- Deep-sky objects are observed as Skyfield `Star`s at their ICRS J2000 catalog position without proper motion or parallax, so aberration and light deflection are applied exactly as for any star.
- `constellation?` (additive, hence optional in the schema, `api_version` 1.1.0, backlog B-71; the server always fills it) is the IAU abbreviation (`CMa`, `UMi`, ...) of the constellation containing the apparent position, resolved by Skyfield's bundled `load_constellation_map()` on the B1875 grid the IAU boundaries were defined on. The frontend reads it for the details panel and the SKY-5 highlight instead of testing the J2000-precessed boundary polygons itself (their edges are neither constant RA nor constant Dec after precession, and brief l.62 keeps precession server-side).
- Errors: 400 `problem-invalid-parameter` (syntax, more than 200 targets, `refraction=1` off Earth, the observer named as a target, bounds); 404 `problem-unknown-object` naming the unknown `hip:`, `dso:` or minor-body id; 422 `problem-outside-coverage` when `tt` leaves the ephemeris or observer frame range, and for a minor body whose elements are older than `mpc_elements.error_years` (50 years) with `range_tt` = elements epoch ± 50 years (an altaz row has no warnings channel and the backend never extrapolates silently, brief l.52); 429 `problem-rate-limited`; 503 `problem-data-not-ready` while `starting`, or for `dso:` targets while `dso` is missing and `a:`/`c:` targets while `mpc` is missing.

## GET /sky/events (reserved)

Rise, set, transit and twilight times for the local day (brief l.174-175, [L]). The path is reserved by the contract and not implemented at M2 (backlog L-01): a request answers 404 `problem-http-error` like any unrouted path.

## Caching headers

| Route | `Cache-Control` | `ETag` / conditional | Other headers |
| ----- | --------------- | -------------------- | ------------- |
| `/health` | `no-store` | | `Retry-After: 5` while `starting` (503) |
| `/meta` | `no-store` | | |
| `/catalogs/*` | `public, max-age=3600, stale-while-revalidate=86400` | strong `"<sha256>"`; `If-None-Match` -> 304 | |
| `/minor-bodies/search`, `/minor-bodies/defaults` | `public, max-age=300` | | |
| `/sky/frame` | `public, max-age=300` | | `Server-Timing: compute;dur=<ms>, cache;desc=hit` or `cache;desc=miss` |
| `/sky/altaz` | `public, max-age=300` | | `Server-Timing: compute;dur=<ms>` |
| problem responses | none | | `Retry-After` on 429 and 503 |

Every response carries `X-Request-Id`; GZip applies to any body of at least 1 KiB when `Accept-Encoding: gzip` is sent (see the conventions for the SKYS decision). CORS exposes `ETag`, `Server-Timing`, `Retry-After` and `X-Request-Id` to browser code.

## Problem types (RFC 9457, D54, brief l.106)

Every error body is a `Problem` document served as `application/problem+json`, rendered by one handler in `skyapi/middleware/problem.py` whatever raised it (a router, request validation, routing, an unexpected exception). Fields, `null` members omitted:

| Field | Content |
| ----- | ------- |
| `type` | `https://github.com/j-about/InterSidera/blob/master/docs/api.md#problem-<slug>`, one of the headings below |
| `title` | short summary of the type |
| `status` | the HTTP status code |
| `detail?` | explanation of this occurrence (never coordinates) |
| `instance?` | the request path (`/api/v1/sky/frame`), never the query string |
| `errors?` | `[{ loc, msg, type }]` per invalid parameter (400 only): `loc` is `["query", "<name>"]`, `type` is pydantic's error type |
| `range_tt?` | `[start, end]` valid TT range (422 only) |

Problem responses pass through GZip and CORS like any other response and carry `X-Request-Id`.

### problem-invalid-parameter

HTTP 400, title "Invalid parameter". A query parameter is missing, malformed, out of bounds or inconsistent with another one: request validation failures (`errors[]` lists each one), malformed or empty id lists, `all` mixed with ids, an unknown body id, the observer named as a target, `refraction=1` off Earth, more than 100 minor bodies, more than 200 targets, `n * (bodies + minor) > 4096`, an unknown observer id, an unknown target syntax.

### problem-unknown-object

HTTP 404, title "Unknown object". No Hipparcos star, deep-sky object or minor body carries the requested id (`hip:99999999`, `dso:NGC99999`, `a:99999999`); `detail` names it.

### problem-outside-coverage

HTTP 422, title "Outside data coverage". The requested window leaves the ephemeris range or the observer frame range (the Moon's orientation kernel, 1550-2650 with `moon_pa_de440`), or an altaz target's orbital elements are older than 50 years. `range_tt` carries the valid TT range. Hard coverage limits are 422s, never warnings. The advertised bounds of `/meta` lie on the canonical 1e-8 day grid (`round(tt, 8)`), so a `tt` equal to a bound is inside and `end + 1e-8` or `start - 1e-8` is the first refused value (backlog B-52; verified with curl at M6 on de440s: 200 at both bounds, 422 one grid step beyond with `range_tt` equal to the advertised coverage).

### problem-rate-limited

HTTP 429, title "Rate limited". The client's token bucket is empty; `Retry-After` (seconds, at least 1) says when one token is available again (section "Rate limiting").

### problem-data-not-ready

HTTP 503, title "Data not ready". While `starting`, every data-dependent route answers this with `Retry-After: 5` (`detail` carries the bootstrap's own reason when it failed); while `degraded`, only the routes that need a missing data group answer it, with `Retry-After: 60` (section "Degraded mode").

### problem-http-error

An unrouted path (404, title "Not Found") or a method other than GET on a known path (405, title "Method Not Allowed"); the title is the HTTP reason phrase and any header of the underlying HTTP exception (such as `Allow`) is preserved. `/sky/events` answers this until L-01 is implemented.

### problem-internal-error

HTTP 500, title "Internal server error", `detail` "unexpected error; the server log carries the request id". Correlate with the JSON log line through the `X-Request-Id` header. The exception is re-raised after rendering so it reaches the server log with its traceback.

## Rate limiting (D62, brief l.107)

- Token bucket per client IP, in memory, one per worker process (`fastapi run --workers N` gives each client N times the nominal budget). Defaults `SKYAPI_RATE_LIMIT_RPS=20` tokens per second and `SKYAPI_RATE_LIMIT_BURST=40` bucket size (`.env.example`).
- Applies to `/sky/frame`, `/sky/altaz` and `/minor-bodies/search`. `/health`, `/meta`, the catalogs and `/minor-bodies/defaults` are not limited.
- The key is the peer address uvicorn reports (`request.client.host`), never a client-supplied header: `X-Forwarded-For` changes nothing unless uvicorn's proxy-headers middleware is told to trust the proxy (`--forwarded-allow-ips=<proxy address>` or the `FORWARDED_ALLOW_IPS` variable, never `*`; `compose.yaml` sets it to `web`'s fixed address `10.213.0.3` alone, never the compose network, so uvicorn stops at the address nginx appended and a client cannot forge its key; an external proxy whose header must be honoured is appended after that address through `compose.override.yaml`). A request without a client address shares the `unknown` bucket.
- Refusal: 429 `problem-rate-limited` with `Retry-After = ceil(seconds until one token)`, at least 1.
- Buckets idle for more than 60 s are evicted once the table exceeds 10 000 keys.
- The API test suite (`rate_limit_rps=1e6`, `rate_limit_burst=10**6` in its settings) and the bench server (`SKYAPI_RATE_LIMIT_RPS=1000000 SKYAPI_RATE_LIMIT_BURST=1000000`, see `scripts/bench_api.py`) disable the limiter in practice so they measure the API, not the limiter; the 429 test builds its own app with `rate_limit_rps=0.01`.

## Warnings (brief l.168)

Warnings are objects `{ code, params?, range_tt? }` with a closed list of codes translated by the frontend, never free text. `params` carries the numbers a translation needs, `range_tt` the valid TT range when one exists; both are absent otherwise.

| Code | Where | `params` | `range_tt` | Meaning |
| ---- | ----- | -------- | ---------- | ------- |
| `iau_rotation_approximate` | `observer.warnings` | | 1800-01-01..2200-01-01 TT (`[2378496.5, 2524593.5]`) | the IAU rotation model of a planetary observer (Mercury, Venus, Mars, Jupiter to Pluto) is used outside the span it was fitted to; never on Earth or the Moon |
| `pluto_barycenter` | `observer.warnings` | | | the `pluto` observer sits on the Pluto-system barycenter (also `/meta.observers[].approximation_code`) |
| `delta_t_approximate` | `time.warnings` | | `[delta_t.observed_tt[0], delta_t.predicted_until_tt]` | at least one sample lies where delta T comes from the long-term parabola instead of tables (before -720 or after the IERS predictions) |
| `proper_motion_extrapolated` | `time.warnings` | `{ years: 10000 }` | J2000 ± 10 000 Julian years | the star catalog's linear proper motion is extrapolated beyond its documented validity |
| `mpc_extrapolation` | `minor[].warnings` | `{ years: <extrapolation_years, 2 decimals> }` | elements epoch ± 2 years | the window is more than `warn_years` from the elements epoch |
| `mpc_unreliable` | `minor[].warnings` | `{ years }` | elements epoch ± 50 years | more than `error_years` from the epoch: `samples` is `null`; `mpc_extrapolation` is present too |

`bodies[].warnings` is always empty at API v1 (the closed list assigns no code to major bodies). Coverage limits are 422s (`problem-outside-coverage`), not warnings; `/sky/altaz` has no warnings channel, so an unreliable minor body is a 422 there.

## Rounding (D68)

Floats are rounded before serialisation (deterministic, shorter bodies); range wraps are applied after rounding so a value that rounds to the upper bound lands at the lower one.

| Fields | Decimals | Then |
| ------ | -------- | ---- |
| unit vectors (`dir`, `sun_dir`), quaternions (`q`), `observer_velocity_au_d`, `dist_au`, every `tt`-valued field | 9 | (0.0002 arcsec on a unit vector) |
| `mag` | 3 | |
| `phase`, `diam_deg`, `alt_deg`, `dec_icrs_deg`, `dec_date_deg` | 7 | (0.00036 arcsec) |
| `az_deg`, `ra_icrs_deg`, `ra_date_deg` | 7 | `% 360` -> `[0, 360)` |
| `lst_hours` | 7 | `% 24` -> `[0, 24)` |
| canonical `lon_deg` | 6 | wrapped to `[-180, 180)` |
| `lat_deg` | 6 | |
| `tt_minus_utc_seconds` | 6 | |

The conformance tests run through the API stay far inside the brief's 2 arcsec tolerance after rounding.

## Degraded mode (D53, brief l.280)

Optional data groups (`required = false` in the data registry) may be missing without stopping the server: `/health` answers `200 degraded` with their codes in `missing`, `/meta.catalogs` omits the corresponding entry, and only the routes that need the group answer 503 `problem-data-not-ready`.

| Missing group | Source files | Routes answering 503 | Absent from `/meta.catalogs` |
| ------------- | ------------ | -------------------- | ---------------------------- |
| `dso` | OpenNGC `NGC.csv`, `addendum.csv` | `/catalogs/dso`; `/sky/altaz` with a `dso:` target | `dso` |
| `constellations` | Stellarium `modern` lines and description, d3-celestial bounds | `/catalogs/constellations` | `constellations` |
| `mpc` | `MPCORB.DAT`, `CometEls.txt` | `/minor-bodies/search`, `/minor-bodies/defaults`; `/sky/frame` with `minor=`; `/sky/altaz` with an `a:` or `c:` target | `minor_bodies` |

Required groups (ephemeris, the text PCK, the Moon frame and orientation kernels, Hipparcos, HYG) have no degraded mode: a missing required file with `SKYAPI_AUTO_FETCH=false` or a failed required download is fatal, `/health` stays `503 starting` with `detail`, and every data-dependent route answers 503 `problem-data-not-ready` with `Retry-After: 5`.
