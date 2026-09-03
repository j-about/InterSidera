---
paths:
  - "backend/src/**/*.py"
  - "backend/pyproject.toml"
  - "backend/typings/**/*.pyi"
---

# Backend rules (FastAPI + Skyfield, `skyapi`)

- Routers (`api/v1/*.py`) validate, canonicalize, call `astro/` and serialize. They never import Skyfield (brief l.397).
- `astro/` owns every Skyfield object (`loader.py`) and exposes pure, typed functions that receive `SkyState` explicitly. No module-level mutable state anywhere except the state built in lifespan.
- Lifespan is the only startup hook (Starlette 1.x removed `on_event`). `lifespan.py` yields a `LifespanState` TypedDict; routes reach it through `get_sky_state(request)` in `api/deps.py` (`Annotated[SkyState, Depends(...)]`), never `app.state`.
- `create_app(settings)` is the factory; `skyapi.main.app` is a lazily built module attribute (PEP 562 `__getattr__`) that exists only because fastapi-cli has no `--factory` (ADR-0003). Importing `skyapi.main` must stay free of environment reads and I/O. `request.state` is a Starlette `State` with attribute access only (no subscript). Tests build their own app with explicit `Settings`.
- Nothing settings-dependent may enter the OpenAPI document (D27): `dump_openapi` and the snapshot test must produce byte-identical output regardless of environment.
- Compute path operations are plain `def` (thread pool, NumPy releases the GIL); never `async def` for CPU work (brief l.77).
- Every parameter has explicit bounds; errors are typed exception classes mapped by one handler to RFC 9457 `application/problem+json` (M2); never a bare `except`.
- Logging: stdlib `logging` with a JSON formatter, request id, no query strings and no coordinates.
- Canonicalize before cache lookup and before computation; echo canonical values in the response.
- pyright strict on `src/`: complete annotations, no untyped `Any` leaving a public function, `numpy.typing.NDArray` for arrays. ruff line length 100, rule sets E,F,W,I,UP,B,SIM,N,RUF,PT,ANN; E501 stays enabled, use `# noqa: E501` only on unbreakable URLs.
- Settings are read once from the environment with the `SKYAPI_` prefix; no `env_file` in `Settings` (the Makefile passes `--env-file` on run targets only).
- Dependency ranges are `>=x.y,<next-major`; 0.x tools are bounded at the minor; nothing added without an ADR.
- Typing of the untyped astronomy libraries (ADR-0006): `backend/typings/skyfield/**/*.pyi` and `typings/jplephem/*.pyi` are hand-written stubs covering exactly the surface `src/` uses, one `.pyi` per imported module, each declaration citing the Skyfield 1.55 source line; import from concrete modules (`skyfield.timelib`, `skyfield.jpllib`, ...), the only `skyfield.api` import is `load` for the builtin timescale; pandas through `pandas-stubs`; pyarrow never imported directly (Parquet goes through pandas). Ruff excludes `typings/`; pyright checks it.
- Skyfield never downloads anything: open `SpiceKernel(path)` and `open(path, "rb")` directly; `Loader.__call__`/`open`/`download` are absent from the stubs on purpose. Every `DATA_DIR` file comes from `sky-data` (`skyapi.data`).
- `astro/frames.py` is the one place where astronomy is computed outside Skyfield (the IAU rotation models of the text PCK, ADR-0007); `astro/loader.py` holds the single use of Skyfield private names (`_segment_list`, `build_frame(..., _segment=)`) for the multi-segment Moon PCK (issue #952). Nothing else may touch a Skyfield private name.
- Committed factual data (`data_files.toml`, `licenses/*.txt`, `constellation_names.csv`) lives in `skyapi/data/` and is read through `importlib.resources` (ADR-0005); `THIRD_PARTY_NOTICES.md` is rendered from the registry by `skyapi.tools.render_notices` and never hand-edited.

## Skyfield pitfalls index (brief l.523-535)

- `rotation_at` returns a LEFT-handed north-east-up matrix (det -1): swap rows x and y to get ENU before the quaternion; test `atan2(E, N)` and `asin(U)` against `altaz()`.
- Both `rotation_at` methods take `Time` arrays: one `ts.tt_jd(array)` per frame, never a Python loop over samples.
- `altaz(temperature_C=..., pressure_mbar=...)` raises off Earth: request refraction only for Earth observers.
- Set `julian_calendar_cutoff = None` explicitly (proleptic Gregorian); `utc_iso()` raises on negative years, build ISO strings from `t.utc` with signed years.
- DE441 has two segments per target (Skyfield >= 1.51); the file is memory-mapped, never read into memory or context; de440s covers 1849-2150 only.
- `build_latlon_degrees` fails for non-spherical bodies: use `PlanetTopos.from_latlon_distance` with the IAU ellipsoid radius at that latitude; Moon frame from the `.tf` + `.bpc`; Skyfield #952 keeps only the last `.bpc` segment per body, select the segment by date.
- One `Star.from_dataframe` for the whole catalog; evaluate at J2000 for `dir` and `pm` (Hipparcos epoch is J1991.25); read `B-V` yourself from `hip_main.dat`.
- MPC: gunzip `MPCORB.DAT.gz` on download; `build-caches` parses it once with our chunked `pd.read_fwf` (Skyfield's single-call loader needs 3.6 GB, B-39) into Parquet and keeps Skyfield's column names so `mpcorb_orbit`/`comet_orbit` work; comets through `load_comets_dataframe_slow`, one solution per designation with `drop_duplicates` after a stable `reference` sort (never `groupby().last()`); use `GM_SUN_DE440_km3_s2` for every Kepler orbit.
- `FileResponse` + ETag for binary catalogs; `GZipMiddleware(minimum_size=1024)`; rate limiting is per worker process; no deprecated `ORJSONResponse`.
- `true_equator_and_equinox_of_date.rotation_at(t)` is a proper rotation; RA/Dec of date via `.radec(epoch=t)`; LST validated against `t.gast` + east longitude.
- The Sun is never an observer; observing from a body also requested as target is a 400; `bodies=all` excludes the observer's body.
- Star and DSO catalogs are built at `build-caches` time, versioned by content hash (the ETag), never rebuilt per request.
