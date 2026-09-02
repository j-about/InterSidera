# skyapi (InterSidera backend)

FastAPI + Skyfield API of [InterSidera](../README.md): the single astronomical authority,
answering stateless, deterministic, cacheable `GET` requests under `/api/v1`. Packaged with
uv (`src` layout, `uv_build`), Python 3.14 (`.python-version`). The specification is
[`docs/brief.xml`](../docs/brief.xml); the running plan is [`docs/plan.md`](../docs/plan.md).

## Run it

From the repository root, through `make` (preferred; `make setup` once):

```sh
make dev-api      # fastapi dev on http://127.0.0.1:8000, reads ./.env when present
make check        # lockfile, ruff, pyright, pytest, frontend gates, contract drift
make types        # regenerate docs/openapi.json and the frontend types
make test         # full pytest including slow/conformance tests, plus vitest
```

Direct forms (always `--directory backend`: uv changes the working directory to `backend/`,
which is what `[tool.fastapi] entrypoint` in `pyproject.toml` and the relative `DATA_DIR`
default rely on):

```sh
uv sync --directory backend                      # create .venv from uv.lock
uv run --directory backend fastapi dev           # http://127.0.0.1:8000/api/v1/health
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

```
src/skyapi/
  main.py        app factory `create_app()` + the `app` instance for `fastapi dev`
  settings.py    pydantic-settings `Settings`
  lifespan.py    lifespan yielding `SkyState` and `Settings` into the request scope
  state.py       frozen `SkyState`
  api/           deps.py, v1/ routers (no Skyfield imports)
  models/        Pydantic response models with OpenAPI metadata
  tools/         dump_openapi.py
tests/           unit/, api/ (markers: unit, api, conformance, slow)
```

`astro/`, `catalogs/`, `data/`, `middleware/` and the `sky-data` CLI arrive with M1 and M2.
