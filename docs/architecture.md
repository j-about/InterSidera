# Architecture

Status: stub written at M0; completed at M2 (backend), M3 (frontend) and M7 (deployment). The authoritative text is `docs/brief.xml`, architecture section (l.39-98); this document explains how the code realises it and is updated in the same commit as the code.

## Principles

- Skyfield (backend) is the single astronomical authority. The frontend never computes an astronomical position from first principles: it rotates catalog unit vectors by a backend horizon rotation, applies linear proper motion with backend vectors, interpolates backend samples, applies first-order annual aberration with the backend observer velocity, and applies a refraction correction (Earth only) validated against Skyfield.
- "Backend as oracle, client as propagator": deterministic, stateless, cacheable GET requests; the client owns the simulation clock.
- No accounts, no sessions, no database, no persistence; per-user state lives in the browser and the URL.
- Determinism: identical (observer, time, options) produce byte-identical responses.

## Time model

TT Julian Date (float64) is the simulation time; modes live, paused, playing at a signed speed; display TT -> UTC through `tt_minus_utc_seconds` from the current frame, then the user's zone through Intl with our own formatter (astronomical year numbering, proleptic Gregorian). Coverage ranges come from `/meta`; the backend never silently extrapolates. To be detailed at M3.

## Coordinate frames

ICRF exchange frame; local ENU horizon frame; ICRF -> ENU as sign-continuous Hamilton quaternions from Skyfield `rotation_at(t)` after the NEU -> ENU row swap; apparent directions for bodies; ENU -> Babylon (East +X, Up +Y, North +Z) in exactly one module, `frontend/src/sky/math/frames.ts`; equator-of-date quaternions from `framelib.true_equator_and_equinox_of_date`. Observer coordinates: WGS84 geodetic on Earth, planetocentric elsewhere (`PlanetTopos.from_latlon_distance`). To be detailed at M1/M3.

## Data flow

Boot (`/meta`, catalogs), scene request (`/sky/frame` window of `n` samples spaced `step_s`), per-animation-frame slerp and cubic Hermite interpolation, refetch triggers (70 % consumed, observer change, speed class change, body set change, jump), speed-adaptive sampling with `max_step_s` classes and snapshot mode, proper motion in the vertex shader. To be detailed at M3.

## Backend

Python 3.14, FastAPI application factory, Pydantic v2 models, pydantic-settings (`SKYAPI_` prefix). Package layout follows brief l.352-368: `api/v1/` routers, `astro/` (every Skyfield object), `catalogs/` (SKYS builder, OpenNGC subset, constellations), `data/` (registry, downloads), `models/`, `middleware/`, `tools/dump_openapi.py`, `cli/sky_data.py`.

### Lifespan state (decision D11)

Starlette 1.x removed every startup hook except lifespan, so `skyapi/lifespan.py` is an `@asynccontextmanager` created by `make_lifespan(settings)` and passed as `FastAPI(lifespan=...)`. It yields a `LifespanState` TypedDict (`{"sky": SkyState, "settings": Settings}`) that Starlette exposes as `request.state`. `SkyState` (`skyapi/state.py`) is a frozen, slotted dataclass; at M0 it holds only `version`, at M1/M2 it gains the timescale, ephemeris, planetary constants, frames, catalogs and MPC index without changing the pattern. Routes reach it through the typed dependency `get_sky_state(request)` in `api/deps.py` (`SkyStateDep = Annotated[SkyState, Depends(get_sky_state)]`), which type-narrows with an `isinstance` guard so pyright strict sees no `Any`. Nothing is stored on `app.state`, and `on_event` is never used. The lifespan performs the I/O (kernel loading, cache building, self-bootstrap download); `create_app()` itself does no I/O so `app.openapi()` can be rendered anywhere (`dump_openapi`, the snapshot test).

Because fastapi-cli 0.0.32 has no `--factory`, `skyapi/main.py` also exposes `app` as a lazily built module attribute (PEP 562 `__getattr__` returning a cached `create_app()`) next to the factory, and `[tool.fastapi] entrypoint = "skyapi.main:app"` makes `fastapi dev` deterministic (ADR-0003). uvicorn and fastapi-cli resolve the import string with `getattr(module, "app")`, so the instance is built exactly when a server asks for it; importing the module reads no environment variable. `request.state` is a Starlette `State` object with attribute access (no subscript), hence `getattr(request.state, "sky", None)` in `api/deps.py`. Tests never use that instance: they call `create_app(settings)` with explicit `Settings`.

### Routers never import Skyfield

Routers (`api/v1/*.py`) validate, canonicalize (sorted parameters, rounding, de-duplicated body lists), call a typed function from `astro/` with the `SkyState` and serialize a Pydantic model. `astro/loader.py` owns every Skyfield object; `astro/*` functions are pure with respect to the state they receive, vectorized over the frame's `Time` array and over the star catalog. Compute path operations are plain `def` so FastAPI runs them in the thread pool. Errors are typed exceptions mapped by one handler to RFC 9457 (M2). Caching: an in-memory LRU of frames keyed by the canonical query string; catalogs served from prebuilt files with content-hash ETags.

## Frontend

React 19 for UI chrome only; a framework-agnostic `SkyEngine` (Babylon.js 9, subpath imports) fed by a single simulation store (zustand) synchronised both ways with the URL; engine selection WebGPU (`WebGPUEngine.IsSupportedAsync`) or WebGL2; rendering layers (stars as quads with custom GLSL and WGSL shaders, DSO symbols, constellations, bodies with phase shading, reference overlays, sky background, HTML label overlay, AR); rotation-only camera at the origin; client-side refraction (Saemundsson/Bennett). At M0 the frontend is a static placeholder rendering `t('app.title')` and `t('app.tagline')`; the Vite dev server proxies `/api` to `http://127.0.0.1:8000`. To be detailed at M3-M5.

## Deployment

Development: `fastapi dev` (port 8000) and `vite` (port 5173, HTTPS via `@vitejs/plugin-basic-ssl` in development only) through `make dev`; `vite preview` on 4173 (HTTP) for Playwright. Production-like: Docker Compose with `api` (uvicorn workers) and `web` (nginx serving the SPA, proxying `/api`, optional TLS); `SKY_DATA_DIR` bind-mounted as DATA_DIR; data never baked into images. To be detailed at M7.
