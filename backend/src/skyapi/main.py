"""Application factory (brief architecture/backend l.75) and the `fastapi dev` entry point."""

from functools import cache
from importlib.metadata import version

from fastapi import FastAPI

from skyapi.api.v1 import router as v1_router
from skyapi.lifespan import make_lifespan
from skyapi.settings import Settings


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the API; `settings` defaults to the environment so tests can inject their own.

    D27: nothing settings-dependent may enter the OpenAPI document, so the pytest snapshot
    and `make types` (which both call this factory) always agree.
    """
    if settings is None:
        settings = Settings()
    app = FastAPI(
        title="InterSidera Sky API",
        version=version("skyapi"),
        lifespan=make_lifespan(settings),
        # Everything, including the schema and its UI, lives under the versioned base path.
        openapi_url="/api/v1/openapi.json",
        docs_url="/api/v1/docs",
        redoc_url=None,
    )
    app.include_router(v1_router)
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
