# Architecture

Status: stub written at M0; backend data pipeline and astronomy core written at M1; completed at M2 (API), M3 (frontend) and M7 (deployment). The authoritative text is `docs/brief.xml`, architecture section (l.39-98); this document explains how the code realises it and is updated in the same commit as the code.

## Principles

- Skyfield (backend) is the single astronomical authority. The frontend never computes an astronomical position from first principles: it rotates catalog unit vectors by a backend horizon rotation, applies linear proper motion with backend vectors, interpolates backend samples, applies first-order annual aberration with the backend observer velocity, and applies a refraction correction (Earth only) validated against Skyfield.
- "Backend as oracle, client as propagator": deterministic, stateless, cacheable GET requests; the client owns the simulation clock.
- No accounts, no sessions, no database, no persistence; per-user state lives in the browser and the URL.
- Determinism: identical (observer, time, options) produce byte-identical responses.

## Time model

TT Julian Date (float64) is the simulation time; modes live, paused, playing at a signed speed; display TT -> UTC through `tt_minus_utc_seconds` from the current frame, then the user's zone through Intl with our own formatter (astronomical year numbering, proleptic Gregorian). Coverage ranges come from `/meta`; the backend never silently extrapolates. To be detailed at M3.

## Coordinate frames

ICRF exchange frame; local ENU horizon frame; ICRF -> ENU as sign-continuous Hamilton quaternions from Skyfield `rotation_at(t)` after the NEU -> ENU row swap; apparent directions for bodies; ENU -> Babylon (East +X, Up +Y, North +Z) in exactly one module, `frontend/src/sky/math/frames.ts`; equator-of-date quaternions from `framelib.true_equator_and_equinox_of_date`. Observer coordinates: WGS84 geodetic on Earth (`wgs84.latlon`), planetocentric elsewhere (`PlanetTopos.from_latlon_distance` on the triaxial radius of the IAU ellipsoid at that latitude and longitude, plus the elevation).

Body-fixed frames (M1): the Moon uses the binary PCK frame `MOON_ME_DE440_ME421` (`moon_de440_250416.tf` + `moon_pa_de440_200625.bpc`); because Skyfield 1.55 keeps only the last segment of a multi-segment binary PCK (issue #952), `astro/loader.py` builds one Skyfield `Frame` per segment and a `SegmentedFrame` dispatches every time sample to the segment that covers it. Mercury, Venus, Mars, the giant planets and Pluto use `astro/frames.py`, our implementation of the IAU rotation model encoded in `pck00011.tpc` (pole right ascension and declination, prime meridian, nutation-precession terms whose angles are polynomials of degree `MAX_PHASE_DEGREE`), exposed through the same `center`/`rotation_at`/`rotation_and_rate_at` interface that `PlanetTopos` expects (ADR-0007: Skyfield builds frames only from binary PCKs and NAIF ships none for the planets). The rotation ICRF to body-fixed is `rot_z(-W) · rot_x(-(π/2 - δ)) · rot_z(-(π/2 + α))`; the horizon rotation adds Skyfield's latitude/longitude rotations and yields the left-handed north-east-up matrix that `astro/quaternions.py` turns into a right-handed ENU quaternion (row swap, Shepperd conversion, sign continuity). Frame centres are the ephemeris targets the observer vector is added to: 399 Earth, 301 Moon, and the barycentres 1, 2, 4, 5, 6, 7, 8, 9 for the other planets (de440s has no Mars 4 -> 499 segment, and the Mars barycentre is within a metre of the planet; Mercury and Venus have no moons; the outer-planet offset is sub-arcsecond; Pluto carries the `pluto_barycenter` approximation code). `AstroState.close()` releases the kernel file handles; the M2 lifespan calls it on shutdown.

## Data flow

Boot (`/meta`, catalogs), scene request (`/sky/frame` window of `n` samples spaced `step_s`), per-animation-frame slerp and cubic Hermite interpolation, refetch triggers (70 % consumed, observer change, speed class change, body set change, jump), speed-adaptive sampling with `max_step_s` classes and snapshot mode, proper motion in the vertex shader. To be detailed at M3.

## Backend

Python 3.14, FastAPI application factory, Pydantic v2 models, pydantic-settings (`SKYAPI_` prefix). Package layout follows brief l.352-368 with one deviation (ADR-0005: the committed factual files live inside `skyapi/data/`): `api/v1/` routers, `astro/` (every Skyfield object), `catalogs/` (SKYS builder, OpenNGC subset, constellations, MPC caches), `data/` (registry, downloads, caches, license texts), `models/`, `middleware/` (M2), `tools/` (`dump_openapi.py`, `render_notices.py`), `cli/sky_data.py`. Type stubs for the untyped astronomy libraries live in `backend/typings/` (ADR-0006).

### Data pipeline (M1)

- `data/registry.py` loads `data_files.toml`, the single description of every dataset (URL, fallback URLs, size, pinned SHA-256 for immutable files, license, copyright, attribution, refresh cadence, optional flag) plus the committed test excerpts. `THIRD_PARTY_NOTICES.md` is rendered from it.
- `data/download.py` downloads with the standard library only: resumable `.part` files with a sidecar, `Range`/`If-Range`, identity encoding, size and content-type guards, retries with backoff, streamed SHA-256, optional gunzip (MPCORB), atomic replace, a progress callback that `/health` will expose at M2. `DATA_DIR/manifest.json` records what was fetched (hash, size, URL, `Last-Modified`, time); refreshable files are verified against it, immutable files against their pin.
- `data/caches.py` orchestrates the builders into `DATA_DIR/cache/` and writes `cache/manifest.json` (source hashes, per-artifact SHA-256 = ETag, version, count, `meta` for `/meta.catalogs`, declared license). Caches are rebuilt only when a source hash or the format version changes.
- `cli/sky_data.py` exposes `fetch`, `update`, `verify`, `build-caches` and `status`; `make data` runs fetch then build-caches.

### Astronomy core (M1)

- `astro/loader.py` builds the frozen `AstroState` (timescale from Skyfield's bundled tables with the proleptic Gregorian calendar, the memory-mapped ephemeris opened as `SpiceKernel`, the planetary constants, the Moon frame, the IAU frames, observer and body tables, coverage ranges). Coverage is computed from the ephemeris segments along each chain to the barycentre, intersected over the served bodies and shrunk by one day for light time; multi-segment DE441 targets would otherwise return NaN silently.
- `astro/state.py` holds the kernel-level context; `catalogs/state.py` (star table, Hipparcos frame, star index, DSO, constellations) and `astro/minor_bodies.py` (search index, orbit cache) hold the catalog contexts. The root `SkyState` composes them at M2; at M1 its optional fields stay `None`.
- `astro/time.py` (sample grids, ISO strings with astronomical year numbering, TT - UTC or TT - UT1, delta T coverage, time warnings), `astro/quaternions.py` (pure), `astro/horizon.py` (horizon and equator-of-date quaternions, local sidereal time, observer velocity, authoritative alt/az), `astro/observers.py`, `astro/frames.py`, `astro/bodies.py` (apparent directions, distances, phases, angular diameters, magnitudes: Skyfield's `planetary_magnitude` for Mercury to Neptune, cited formulas for the Sun, the Moon and Pluto), `astro/sampling.py` (the `max_step_s` classes), `astro/refraction.py` (Skyfield's refraction as the reference table for the client-side formula), `astro/stars.py`, `astro/dso.py`, `astro/constellations.py`, `astro/minor_bodies.py` (MPC ids, search, defaults, Kepler orbits with `GM_SUN_DE440_km3_s2`, H-G and comet magnitudes, extrapolation warnings).
- Every function is vectorised over one `Time` array per frame and receives its state explicitly; per-body results are `astro/samples.py::Samples` arrays and warnings are `astro/warnings.py::SkyWarning` objects with the closed code list of the contract.

### Catalog builders (M1)

`catalogs/formats.py` (SKYS v1, pure, 100 % covered), `catalogs/readers.py` (provenance-header-tolerant readers), `catalogs/builders.py` (stars: one vectorised `Star` evaluated from the solar-system barycentre at J2000 and one Julian year later; star index from HYG; DSO subset from OpenNGC; constellations from Stellarium lines, d3-celestial boundaries and the committed IAU names, with the Stellarium license asserted at build time) and `catalogs/mpc_build.py` (MPC Parquet caches and the search index). `catalogs/artifacts.py` defines the shared `CachePaths`, `Artifact` and `BuildResult` types and the version rule; artifacts are versioned by the hash of their sources and served by content hash (ETag) at M2.

### Lifespan state (decision D11)

Starlette 1.x removed every startup hook except lifespan, so `skyapi/lifespan.py` is an `@asynccontextmanager` created by `make_lifespan(settings)` and passed as `FastAPI(lifespan=...)`. It yields a `LifespanState` TypedDict (`{"sky": SkyState, "settings": Settings}`) that Starlette exposes as `request.state`. `SkyState` (`skyapi/state.py`) is a frozen, slotted dataclass; at M0 it holds only `version`, at M1/M2 it gains the timescale, ephemeris, planetary constants, frames, catalogs and MPC index without changing the pattern. Routes reach it through the typed dependency `get_sky_state(request)` in `api/deps.py` (`SkyStateDep = Annotated[SkyState, Depends(get_sky_state)]`), which type-narrows with an `isinstance` guard so pyright strict sees no `Any`. Nothing is stored on `app.state`, and `on_event` is never used. The lifespan performs the I/O (kernel loading, cache building, self-bootstrap download); `create_app()` itself does no I/O so `app.openapi()` can be rendered anywhere (`dump_openapi`, the snapshot test).

Because fastapi-cli 0.0.32 has no `--factory`, `skyapi/main.py` also exposes `app` as a lazily built module attribute (PEP 562 `__getattr__` returning a cached `create_app()`) next to the factory, and `[tool.fastapi] entrypoint = "skyapi.main:app"` makes `fastapi dev` deterministic (ADR-0003). uvicorn and fastapi-cli resolve the import string with `getattr(module, "app")`, so the instance is built exactly when a server asks for it; importing the module reads no environment variable. `request.state` is a Starlette `State` object with attribute access (no subscript), hence `getattr(request.state, "sky", None)` in `api/deps.py`. Tests never use that instance: they call `create_app(settings)` with explicit `Settings`.

### Routers never import Skyfield

Routers (`api/v1/*.py`) validate, canonicalize (sorted parameters, rounding, de-duplicated body lists), call a typed function from `astro/` with the `SkyState` and serialize a Pydantic model. `astro/loader.py` owns every Skyfield object; `astro/*` functions are pure with respect to the state they receive, vectorized over the frame's `Time` array and over the star catalog. Compute path operations are plain `def` so FastAPI runs them in the thread pool. Errors are typed exceptions mapped by one handler to RFC 9457 (M2). Caching: an in-memory LRU of frames keyed by the canonical query string; catalogs served from prebuilt files with content-hash ETags.

## Frontend

React 19 for UI chrome only; a framework-agnostic `SkyEngine` (Babylon.js 9, subpath imports) fed by a single simulation store (zustand) synchronised both ways with the URL; engine selection WebGPU (`WebGPUEngine.IsSupportedAsync`) or WebGL2; rendering layers (stars as quads with custom GLSL and WGSL shaders, DSO symbols, constellations, bodies with phase shading, reference overlays, sky background, HTML label overlay, AR); rotation-only camera at the origin; client-side refraction (Saemundsson/Bennett). At M0 the frontend is a static placeholder rendering `t('app.title')` and `t('app.tagline')`; the Vite dev server proxies `/api` to `http://127.0.0.1:8000`. To be detailed at M3-M5.

## Deployment

Development: `fastapi dev` (port 8000) and `vite` (port 5173, HTTPS via `@vitejs/plugin-basic-ssl` in development only) through `make dev`; `vite preview` on 4173 (HTTP) for Playwright. Production-like: Docker Compose with `api` (uvicorn workers) and `web` (nginx serving the SPA, proxying `/api`, optional TLS); `SKY_DATA_DIR` bind-mounted as DATA_DIR; data never baked into images. To be detailed at M7.
