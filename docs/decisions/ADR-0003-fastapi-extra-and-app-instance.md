# ADR-0003: FastAPI extra without the cloud CLI, and a lazily built `app` attribute under the factory

- Status: Accepted
- Date: 2026-09-02

## Context

The brief names `fastapi[standard]` (l.33, l.395), an application-factory pattern (l.75), `fastapi dev` for development (l.95) and, as the M0 definition of done, "`fastapi dev` answers `/api/v1/health`" (l.442). It also excludes SaaS tooling by intent (l.36: "analytics or error-reporting SaaS") and asks for restraint (l.10).

Verified on 2026-09-02 (FastAPI 0.141.1, fastapi-cli 0.0.32):

- `fastapi[standard]` = `fastapi-cli[standard]`, `fastar`, `httpx<1`, `jinja2`, `python-multipart`, `email-validator`, `uvicorn[standard]`, `pydantic-settings`, `pydantic-extra-types`. `fastapi-cli[standard]` additionally pulls `fastapi-cloud-cli`, the login/deploy client for the hosted FastAPI Cloud service; `fastapi --version` prints its version and its Typer sub-app is registered when present.
- FastAPI publishes the extra `standard-no-fastapi-cloud-cli`: identical to `standard` minus `fastapi-cloud-cli` and minus `fastar` (a tar helper used by the cloud upload path).
- fastapi-cli 0.0.32 has no `--factory` option: `_run()` calls `uvicorn.run(app=import_string, ...)` without `factory=`, and discovery rejects any object that is not a `FastAPI` instance. Without a path argument it looks only for `main.py`/`app.py`/`api.py` (and `app/` variants) in the current working directory, which does not match a src layout. It reads `[tool.fastapi] entrypoint = "module:app"` from `Path.cwd()/pyproject.toml`.
- Starlette 1.x keeps lifespan as the only startup hook; `create_app()` can therefore stay free of I/O. Building the instance eagerly at import time would still call `Settings()` and read `SKYAPI_*`, which is why the instance is built lazily (see Decision).

## Options considered

Dependency extra:

1. `fastapi[standard]` as written, accepting `fastapi-cloud-cli` and `fastar` in the lockfile with a note. Rejected: pulls a hosted-service CLI the project will never use, against l.36 and l.10.
2. `fastapi[standard-no-fastapi-cloud-cli]`. Chosen: same `fastapi dev`/`fastapi run`, same uvicorn[standard] and httpx; nothing we use depends on `fastar`.

Application instance:

1. Factory only, run with `uv run uvicorn skyapi.main:create_app --factory --reload`. Works, but fails the literal M0 definition of done and loses `fastapi dev`'s defaults. Rejected.
2. A `main.py` at the backend root for auto-discovery. Breaks the src layout of brief l.355. Rejected.
3. Keep `create_app(settings: Settings | None = None) -> FastAPI` as the factory and expose `app` as a PEP 562 module attribute (`__getattr__` returning a `functools.cache`d `create_app()`), with `[tool.fastapi] entrypoint = "skyapi.main:app"` in `backend/pyproject.toml`. uvicorn and fastapi-cli resolve the import string with `getattr(module, "app")`, which builds the instance exactly when a server asks for it. Chosen. An eager `app = create_app()` was tried first and rejected: it read the environment at import, so a malformed ambient `SKYAPI_*` value broke `import skyapi.main` in the test suite before the `clean_env` fixture could run, and `dump_openapi` implicitly built a second app from the environment.

## Decision

- `backend/pyproject.toml`: `"fastapi[standard-no-fastapi-cloud-cli]>=0.141,<1"` and `[tool.fastapi] entrypoint = "skyapi.main:app"`.
- `backend/src/skyapi/main.py`: `create_app()` builds the application (title, version from `importlib.metadata`, `lifespan=make_lifespan(settings)`, `openapi_url="/api/v1/openapi.json"`, `docs_url="/api/v1/docs"`, `redoc_url=None`); `app` is a lazily built, cached module attribute (PEP 562 `__getattr__`) with a comment citing fastapi-cli's missing `--factory` and the hermeticity reason.
- Tests never import `app`; they call `create_app(settings)` with explicit `Settings` (autouse `clean_env` fixture, see `.claude/rules/backend-tests.md`).
- `tools/dump_openapi.py` calls `create_app(default_settings())` (decision D27; `default_settings()` ignores the environment, so `make types` never fails on an unrelated invalid `SKYAPI_*` value), and nothing settings-dependent may enter the OpenAPI document, so the pytest snapshot and `make types` always agree.

## Consequences

- `uv run --directory backend fastapi dev` is deterministic (the CLI logs "Using import string skyapi.main:app") and works only from `backend/`, which the Makefile guarantees with `--directory`.
- Importing `skyapi.main` has no side effect and reads no `SKYAPI_*` variable; the instance is created on the first access of `skyapi.main.app` (servers), and all data loading happens in the lifespan, so `app.openapi()` can be rendered in any environment.
- Recorded as deviation B-17 in `docs/backlog.md`; pydantic-settings stays an explicit dependency even though the extra also pulls it (brief l.395).
- `fastapi --version` no longer prints a Cloud CLI line; the compose `api` service runs `fastapi run --workers ${SKYAPI_WORKERS}` (M7).

## Revisit trigger

- fastapi-cli gains a `--factory` option or factory-aware discovery: drop the lazy `app` attribute and point the entrypoint at the factory.
- A dependency we adopt requires `fastar`, or FastAPI removes the `standard-no-fastapi-cloud-cli` extra: re-evaluate the extra (and record it here).

## Amendment (M7)

Plan D171 and D188 (ADR-0023, ADR-0025), 2026-09-28. The container command: the api image's exec-form `CMD ["fastapi", "run", "--host", "0.0.0.0", "--port", "8000"]` carries no `--workers` because an exec-form CMD never expands a variable; `compose.yaml` passes `command: ["fastapi", "run", "--host", "0.0.0.0", "--port", "8000", "--workers", "${SKYAPI_WORKERS:-1}"]`, interpolated from `.env` at parse time, which is how the consequence "the compose `api` service runs `fastapi run --workers ${SKYAPI_WORKERS}`" is realised; outside compose the image honours uvicorn's own `WEB_CONCURRENCY`; `PORT` is never set (`fastapi run --port` reads it as its port); `Settings.workers` stays an informational setting no code consumes. fastapi-cli reads `[tool.fastapi] entrypoint` from the `pyproject.toml` of the current directory, so the final stage copies `/app/pyproject.toml` beside `/app/.venv` and keeps `WORKDIR /app`. `FORWARDED_ALLOW_IPS`: `fastapi run` passes no `--forwarded-allow-ips`, so uvicorn 0.53.0 reads the variable (default `127.0.0.1,::1`); compose sets it to `web`'s fixed address `10.213.0.3` (written once as `x-sky.web_address`; never the whole network, whose gateway relays host connections, never `*`) on the api service, so uvicorn stops at the address nginx appends; an external TLS proxy whose header must be honoured is appended after it through `compose.override.yaml` (plan D188 as amended on 2026-09-28). The decision text above is unchanged.
