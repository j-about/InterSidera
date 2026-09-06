"""Application factory (brief architecture/backend l.75) and the `fastapi dev` entry point."""

from collections.abc import Callable
from functools import cache
from importlib.metadata import version
from typing import Any

from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware

from skyapi.api.v1 import router as v1_router
from skyapi.data.registry import Registry
from skyapi.lifespan import make_lifespan
from skyapi.middleware.logging import RequestContextMiddleware
from skyapi.middleware.problem import problem_schema_components, register_exception_handlers
from skyapi.settings import Settings

DESCRIPTION = (
    "Stateless, cacheable GET API behind InterSidera: Skyfield is the astronomical authority, "
    "clients only rotate, interpolate and apply the corrections it supplies. Angles in degrees, "
    "distances in au, times as TT Julian Dates unless suffixed `_utc`. Errors are RFC 9457 "
    "problem documents (`application/problem+json`)."
)

OPENAPI_TAGS: list[dict[str, Any]] = [
    {"name": "health", "description": "Readiness of the API and its data (`no-store`)."},
    {
        "name": "meta",
        "description": "Contract version, coverage ranges, observers, bodies, catalogs, limits.",
    },
    {
        "name": "catalogs",
        "description": (
            "Prebuilt star, deep-sky and constellation catalogs served from cache files with a "
            "content-hash ETag (`If-None-Match` -> 304, `max-age=3600`)."
        ),
    },
    {"name": "minor-bodies", "description": "Search and default lists of asteroids and comets."},
    {
        "name": "sky",
        "description": (
            "Compute endpoints: sky frames (rotations and body samples over a time window) and "
            "authoritative alt/az values; rate-limited per client IP, `max-age=300`."
        ),
    },
]

# Headers the frontend must be able to read across origins (development: Vite on :5173).
CORS_EXPOSE_HEADERS = ["ETag", "Server-Timing", "Retry-After", "X-Request-Id"]
CORS_ALLOW_HEADERS = ["If-None-Match", "X-Request-Id"]
GZIP_MINIMUM_SIZE = 1024
# D59/B-46, measured 2026-09-06 on the full catalogs (docs/testing.md): level 9 costs 37 ms on the
# 822 KB DSO JSON against 19 ms at level 6 for 5 % more bytes, and the 3.8 MB SKYS (float32 unit
# vectors) shrinks by 17 % only while costing 100-155 ms at any level, which breaks the 50 ms
# catalog budget (brief l.256); it is served uncompressed (nginx may compress it at M7, l.556).
GZIP_COMPRESS_LEVEL = 6
GZIP_EXCLUDED_CONTENT_TYPES = ("application/octet-stream",)


def _with_problem_schema(original: Callable[[], dict[str, Any]]) -> Callable[[], dict[str, Any]]:
    """Add `Problem`/`ProblemError` to `components.schemas` (referenced by `problem_responses`)."""

    def openapi() -> dict[str, Any]:
        document = original()
        components: dict[str, Any] = document.setdefault("components", {})
        schemas: dict[str, Any] = components.setdefault("schemas", {})
        for name, schema in problem_schema_components().items():
            schemas.setdefault(name, schema)
        return document

    return openapi


def create_app(settings: Settings | None = None, *, registry: Registry | None = None) -> FastAPI:
    """Build the API; `settings` defaults to the environment so tests can inject their own.

    `registry` overrides the packaged data registry (tests point it at a local HTTP server);
    the factory itself performs no I/O: the registry is read by the bootstrap thread.

    D27: nothing settings-dependent may enter the OpenAPI document, so the pytest snapshot
    and `make types` (which both call this factory) always agree.
    """
    if settings is None:
        settings = Settings()
    app = FastAPI(
        title="InterSidera Sky API",
        version=version("skyapi"),
        description=DESCRIPTION,
        openapi_tags=OPENAPI_TAGS,
        lifespan=make_lifespan(settings, registry),
        # Everything, including the schema and its UI, lives under the versioned base path.
        openapi_url="/api/v1/openapi.json",
        docs_url="/api/v1/docs",
        redoc_url=None,
    )
    app.include_router(v1_router)
    register_exception_handlers(app)
    # D63: the last `add_middleware` call is the outermost layer. GZip innermost (compresses
    # every body incl. problem documents), CORS around it, the request context outermost so
    # every response, preflights included, carries `X-Request-Id` and one access record.
    # Starlette's ServerErrorMiddleware wraps them all: a 500 problem document therefore skips
    # CORS and GZip; the request id is echoed by the handler itself (`middleware/problem.py`).
    app.add_middleware(
        GZipMiddleware,
        minimum_size=GZIP_MINIMUM_SIZE,
        compresslevel=GZIP_COMPRESS_LEVEL,
        exclude_content_types=GZIP_EXCLUDED_CONTENT_TYPES,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET"],
        allow_headers=CORS_ALLOW_HEADERS,
        expose_headers=CORS_EXPOSE_HEADERS,
        max_age=600,
    )
    app.add_middleware(RequestContextMiddleware)
    app.openapi = _with_problem_schema(app.openapi)  # type: ignore[method-assign]
    return app


@cache
def _default_app() -> FastAPI:
    """The one process-wide instance built from the environment, created on first use."""
    return create_app()


def __getattr__(name: str) -> FastAPI:
    # D10 / ADR-0003: fastapi-cli 0.0.32 has no `--factory` option and the M0 definition of
    # done literally requires `fastapi dev` to answer `/api/v1/health`, so this module exposes
    # `app` for the `[tool.fastapi] entrypoint = "skyapi.main:app"` in pyproject.toml.
    # It is a PEP 562 lazy attribute rather than `app = create_app()`: uvicorn and fastapi-cli
    # both resolve the import string with `getattr(module, "app")`, which builds the instance
    # exactly when a server asks for it, while `import skyapi.main` (tests, dump_openapi) has
    # no side effect and reads no `SKYAPI_*` variable, keeping `make check` hermetic (R9).
    if name == "app":
        return _default_app()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
