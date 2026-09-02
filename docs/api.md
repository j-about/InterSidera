# API

Status: stub written at M0; completed at M2 (every endpoint, the SKYS byte-layout table, error and caching details). The binding contract is `docs/brief.xml`, api_contract section (l.100-183); the machine-readable document is `docs/openapi.json`.

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

## Binary catalog format SKYS v1 (M2)

Byte-layout table to be written at M2 from `backend/src/skyapi/catalogs/formats.py` (brief l.131-139): header `SKYS` magic (4 bytes), `version u32 = 1`, `count u32`, `epoch_tt f64` (J2000 = 2451545.0), `flags u32` (reserved, 0); then columns packed without padding in this order: `dir f32[count*3]`, `pm f32[count*3]` (radians per Julian year), `mag i16[count]` (millimagnitudes, Johnson V), `bv i16[count]` (32767 when unknown), `hip u32[count]`; sorted by magnitude ascending so any prefix is a valid brighter-than subset.

## Warnings, coverage and limits (M2)

Closed list of warning codes (`iau_rotation_approximate`, `pluto_barycenter`, `delta_t_approximate`, `proper_motion_extrapolated`, `mpc_extrapolation`, `mpc_unreliable`), `/meta.coverage` ranges and `/meta.limits` (`max_samples 64`, `max_minor_bodies 100`, `max_targets 200`, `max_step_s` per body class) to be documented at M2.
