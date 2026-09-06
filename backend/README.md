# skyapi (InterSidera backend)

FastAPI + Skyfield API of [InterSidera](../README.md): the single astronomical authority,
answering stateless, deterministic, cacheable `GET` requests under `/api/v1`. Packaged with
uv (`src` layout, `uv_build`), Python 3.14 (`.python-version`). The specification is
[`docs/brief.xml`](../docs/brief.xml); the running plan is [`docs/plan.md`](../docs/plan.md).

## Run it

From the repository root, through `make` (preferred; `make setup` once):

```sh
make data         # sky-data fetch then sky-data build-caches into DATA_DIR (reads ./.env)
make dev-api      # fastapi dev on http://127.0.0.1:8000, reads ./.env when present
make check        # lockfile, ruff, pyright, pytest with coverage gates, frontend gates, contract and notices drift
make types        # regenerate docs/openapi.json and the frontend types
make notices      # regenerate THIRD_PARTY_NOTICES.md from the data registry
make test         # full pytest including slow/conformance tests, plus vitest
```

Direct forms (always `--directory backend`: uv changes the working directory to `backend/`,
which is what `[tool.fastapi] entrypoint` in `pyproject.toml` and the relative `DATA_DIR`
default rely on):

```sh
uv sync --directory backend                      # create .venv from uv.lock
uv run --directory backend fastapi dev           # http://127.0.0.1:8000/api/v1/health (503 while starting, then 200 ready)
uv run --directory backend pytest -m "not slow"
uv run --directory backend ruff format . && uv run --directory backend ruff check .
fnm exec --using=24 uv run --directory backend pyright   # pyright needs `node` on PATH
uv run --directory backend python -m skyapi.tools.dump_openapi --out "$PWD/docs/openapi.json"
```

`pyright` from PyPI is a thin wrapper that downloads the Node package on first run into
`~/.cache/pyright-python`; run it from an fnm-activated shell (or via `fnm exec`) so a Node 24
binary is on `PATH`. The Makefile does this for you.

## Configuration

Settings are read once from `SKYAPI_*` environment variables (`skyapi/settings.py`); every
variable and its safe default is documented in [`.env.example`](../.env.example). Nothing here
reads a `.env` file: `make dev-api` passes `--env-file .env` to `uv run`, while `make check`,
pytest and CI stay hermetic (the test suite also clears any `SKYAPI_*` it inherits).

`SKYAPI_DATA_DIR` defaults to `../data`, relative to this directory, i.e. the gitignored `data/`
at the repository root. `SKYAPI_EPHEMERIS` defaults to the production `de441.bsp` (about 3 GB);
`.env.example` and CI select `de440s.bsp` (32 MB, 1849-2150).

## Layout

```text
src/skyapi/
  main.py        app factory `create_app()` (middleware, error handlers) + the `app` instance for `fastapi dev`
  settings.py    pydantic-settings `Settings`
  lifespan.py    lifespan starting the bootstrap thread and yielding bootstrap, settings, limiter, frame cache
  bootstrap.py   startup stages (files, caches, states, meta) with starting/ready/degraded snapshots (ADR-0008)
  state.py       frozen `SkyState` (astro, catalogs, meta, optional minor bodies, missing groups)
  meta.py        the static part of `/meta`, built once at bootstrap
  api/           deps.py, canonical.py, v1/ routers health, meta, catalogs, minor_bodies, sky (no Skyfield imports)
  middleware/    problem.py (RFC 9457), ratelimit.py, logging.py (JSON + request id), caching.py
  astro/         every Skyfield object: loader, state, time, quaternions, frames (IAU rotation
                 models), observers, horizon, bodies, sampling, refraction, stars, dso,
                 constellations, minor_bodies, samples, warnings, queries (canonical query
                 dataclasses), frame and altaz (the /sky composites)
  catalogs/      formats.py (SKYS v1, pure), readers.py, builders.py, mpc_build.py, state.py,
                 artifacts.py
  data/          registry.py, download.py, caches.py, data_files.toml (the registry),
                 licenses/*.txt, constellation_names.csv
  cli/           sky_data.py (`sky-data fetch|update|verify|build-caches|status`)
  models/        Pydantic response models with OpenAPI metadata (health, meta, catalogs, frame, altaz, problem)
  tools/         dump_openapi.py, render_notices.py
typings/         hand-written type stubs for Skyfield and jplephem (pyright strict, ADR-0006)
tests/           unit/, api/, conformance/, slow/ (markers: unit, api, conformance, slow);
                 support/ (fixture modules), fixtures/ (Horizons and Skyfield fixtures, excerpts/)
```

The endpoints, their parameters and headers are documented in [`docs/api.md`](../docs/api.md); `scripts/bench_api.py` measures them against the brief's budgets.
