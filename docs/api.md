# API

Status: stub written at M0; the SKYS byte layout, the catalog JSON shapes and the minor-body id syntax written at M1; completed at M2 (every endpoint, error and caching details). The binding contract is `docs/brief.xml`, api_contract section (l.100-183); the machine-readable document is `docs/openapi.json`.

## Base path and conventions (brief l.101-109)

- Base path `/api/v1`. All endpoints are GET, stateless and deterministic.
- Query parameters are canonicalized before computing and before cache lookup: sorted; latitude and longitude rounded to 1e-6 degrees (the reference frontend sends 0.01 degrees, OBS-7); elevation to 1 m; `tt` to 1e-8 day; body lists sorted and de-duplicated. The frontend aligns `tt0` to the sample grid so users share cache keys; the backend accepts any `tt`.
- JSON responses are Pydantic v2 models with complete OpenAPI metadata (descriptions, examples); TypeScript types are generated from the OpenAPI document and committed; CI fails on drift.
- Binary responses use `application/octet-stream`, little-endian, a versioned magic header and packed columnar typed arrays (table below, M2).
- Caching headers: catalogs `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` with a strong content-hash ETag and `If-None-Match` -> 304; frames and altaz `public, max-age=300`; `/meta` and `/health` `no-store`. GZip for responses >= 1 KiB (`GZipMiddleware(minimum_size=1024)`, M2).
- Errors follow RFC 9457 (`application/problem+json`: `type`, `title`, `status`, `detail`, `instance`, `errors[]`): 400 invalid parameter, 404 unknown object, 422 outside data coverage (with the valid range), 429 rate limited (`Retry-After`), 503 data not ready (`Retry-After`). M2.
- Rate limiting: in-memory token bucket per client IP on compute endpoints (default 20 req/s, burst 40), per worker process. M2.
- Units: degrees, astronomical units, TT Julian Date unless suffixed `_utc` (ISO 8601 `Z`, proleptic Gregorian, astronomical year numbering), magnitudes as floats.

## OpenAPI document and generated types

- `docs/openapi.json` is produced by `backend/src/skyapi/tools/dump_openapi.py`: it builds `create_app(default_settings())`, ignoring the environment (nothing settings-dependent may enter the document, decision D27) and writes `json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False)` plus a trailing newline to the `--out` path.
- `make types` runs that tool (`--out $(CURDIR)/docs/openapi.json`) and then `npm --prefix frontend run gen:types` = `openapi-typescript ../docs/openapi.json -o src/api/schema.d.ts --alphabetize`.
- `make check-contract` (part of `make check`) runs `make types`, asserts both files are tracked (`git ls-files --error-unmatch`) and unchanged (`git diff --exit-code`). CI splits the same gate: the backend job diffs `docs/openapi.json`, the frontend job regenerates `schema.d.ts` from the committed document.
- The pytest snapshot test compares the rendered document with the committed file and prints "run `make types`" on mismatch. A contract change is therefore always deliberate: code, `openapi.json` and `schema.d.ts` move in one commit, and `api_version` in `/meta` follows semver of the contract (M2).
- Interactive docs: `/api/v1/docs` (Swagger UI); `/api/v1/openapi.json` serves the same document at runtime; ReDoc is disabled.

## Endpoints

At M0 only `GET /api/v1/health` exists: `{ status: "ready", version }` with `Cache-Control: no-store` (`progress` is omitted when absent; `starting` and `degraded` plus 503 semantics arrive at M2). The full list (`/meta`, `/catalogs/stars`, `/catalogs/stars/index`, `/catalogs/dso`, `/catalogs/constellations`, `/minor-bodies/search`, `/minor-bodies/defaults`, `/sky/frame`, `/sky/altaz`) is specified in brief l.111-176 and documented here at M2. `/sky/events` is reserved ([L], backlog L-01).

## Binary catalog format SKYS v1

Written by `backend/src/skyapi/catalogs/formats.py` (`write_skys`/`read_skys`, pure, 100 % covered, hypothesis round-trip) and served by `GET /catalogs/stars` at M2 as `application/octet-stream`. Little-endian throughout, no padding, `count` stars sorted by `mag` ascending so any prefix is a valid brighter-than subset (brief l.131-139).

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

## Catalog JSON shapes (served at M2, built at M1)

- `GET /catalogs/stars/index`: `[{ hip, names: { proper?, bayer?, flamsteed? }, con }]` for the named or designated stars of HYG v4.4 (3,429 entries; the brief estimates about 4 000). `bayer` is the Greek letter with an optional superscript and the IAU abbreviation (`"α Ori"`, `"κ¹ Scl"`; the two Latin-letter Bayer designations such as `"p Eri"` pass through), `flamsteed` is `"58 Ori"`, `proper` is HYG's `proper` column verbatim (the IAU WGSN names plus a few traditional nearby-star catalog names and unofficial "B" companion names). Not translated.
- `GET /catalogs/dso`: `[{ id, names, messier?, type, ra_deg, dec_deg, mag?, major_arcmin?, minor_arcmin?, pa_deg?, con }]`. `id` is the OpenNGC name without the zero padding of its first numeric run and with spaces replaced by `_` (`NGC0224` -> `NGC224`, `IC0434` -> `IC434`, `Mel022` -> `Mel22`, `IC0080 NED01` -> `IC80_NED01`). Type map: `G`/`GPair`/`GTrpl`/`GGroup` -> `galaxy`, `OCl` -> `open_cluster`, `GCl` -> `globular_cluster`, `PN` -> `planetary_nebula`, `Neb`/`HII`/`EmN`/`RfN`/`SNR`/`Cl+N` -> `nebula`, `*`/`**`/`*Ass`/`DrkN`/`Nova`/`Other` -> `other`; `Dup` and `NonEx` rows are dropped. Messier aliases: `M31` resolves to `NGC224` through `messier`; the `M102` duplicate row follows OpenNGC's NED convention and resolves to `NGC5457` (M101), which therefore carries `"M102"` in its `names` (the catalog state rebuilds the alias map from names matching `^M\d+$`). `mag` is V else B. Subset: every Messier object plus `mag <= 14` or `major_arcmin >= 5` (configurable at build time), applied to the NGC/IC rows and to the addendum rows alike (Hyades, the Magellanic Clouds and the Horsehead pass by size). An OpenNGC type code the builder does not know fails the build instead of becoming `other`.
- `GET /catalogs/constellations`: `{ culture: "modern", constellations: [{ abbr, latin, genitive, lines: [[hip, hip], ...], boundary: [[ra_deg, dec_deg], ...], label: { ra_deg, dec_deg }, boundary_parts? }] }`. Lines come from Stellarium's `modern` sky culture, boundaries from d3-celestial (J2000, RA normalised to 0..360, closed rings). Serpens has two disjoint IAU polygons: `boundary` holds Serpens Caput and the additive optional `boundary_parts` lists both rings (deviation B-33); clients that draw boundaries must read `boundary_parts` when present.
- Minor-body ids (used by `/minor-bodies/*`, `/sky/frame` and `/sky/altaz`): `a:<number>` for numbered asteroids, `a:<MPC packed designation>` for unnumbered ones, `c:<number><orbit type>` for numbered periodic comets (`c:1P`), `c:<designation with spaces replaced by _>` otherwise (`c:C/2023_A3`).

## Warnings, coverage and limits (M2)

Closed list of warning codes (`iau_rotation_approximate`, `pluto_barycenter`, `delta_t_approximate`, `proper_motion_extrapolated`, `mpc_extrapolation`, `mpc_unreliable`), `/meta.coverage` ranges and `/meta.limits` (`max_samples 64`, `max_minor_bodies 100`, `max_targets 200`, `max_step_s` per body class) to be documented at M2.
