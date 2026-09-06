"""Lifespan factory: the only startup/shutdown hook (Starlette 1.x removed `on_event`).

The lifespan configures logging, starts the bootstrap thread (D51) and yields the mapping that
Starlette merges into `scope["state"]` for every request (D11); routes read it through
`skyapi.api.deps`. At shutdown it cancels and joins the bootstrap and closes the kernel files.
"""

from collections.abc import AsyncGenerator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager

import anyio.to_thread
from fastapi import FastAPI

from skyapi.bootstrap import JOIN_TIMEOUT_SECONDS, start_bootstrap
from skyapi.data.registry import Registry
from skyapi.middleware.caching import FrameCache
from skyapi.middleware.logging import configure_logging
from skyapi.middleware.ratelimit import TokenBucketLimiter
from skyapi.settings import Settings
from skyapi.state import LifespanState

Lifespan = Callable[[FastAPI], AbstractAsyncContextManager[LifespanState]]


def make_lifespan(settings: Settings, registry: Registry | None = None) -> Lifespan:
    """Bind `settings` (and, for tests, a registry) into a lifespan for `FastAPI(lifespan=...)`."""

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[LifespanState]:
        configure_logging(settings.log_level)
        bootstrap, thread = start_bootstrap(settings, registry)
        try:
            yield {
                "bootstrap": bootstrap,
                "settings": settings,
                "limiter": TokenBucketLimiter(settings.rate_limit_rps, settings.rate_limit_burst),
                "frame_cache": FrameCache(),
            }
        finally:
            bootstrap.cancel()
            await anyio.to_thread.run_sync(thread.join, JOIN_TIMEOUT_SECONDS)
            sky = bootstrap.sky
            if sky is not None:
                sky.astro.close()

    return lifespan
