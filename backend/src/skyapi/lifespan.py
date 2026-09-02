"""Lifespan factory: the only startup/shutdown hook (Starlette 1.x removed `on_event`).

The lifespan yields a mapping that Starlette merges into `scope["state"]` for every request
(the "lifespan state" pattern, D11); routes read it through `skyapi.api.deps`.
At M0 nothing is loaded and no I/O happens; M1/M2 add the Skyfield bootstrap here.
"""

from collections.abc import AsyncGenerator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from importlib.metadata import version

from fastapi import FastAPI

from skyapi.settings import Settings
from skyapi.state import LifespanState, SkyState

Lifespan = Callable[[FastAPI], AbstractAsyncContextManager[LifespanState]]


def make_lifespan(settings: Settings) -> Lifespan:
    """Bind `settings` into a lifespan context manager for `FastAPI(lifespan=...)`."""

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[LifespanState]:
        yield {"sky": SkyState(version=version("skyapi")), "settings": settings}

    return lifespan
