"""Typed FastAPI dependencies giving routes access to the lifespan state (D11, D51)."""

from typing import Annotated

from fastapi import Depends, Request

from skyapi.bootstrap import Bootstrap
from skyapi.middleware.caching import FrameCache
from skyapi.middleware.problem import DataNotReadyError
from skyapi.settings import Settings
from skyapi.state import SkyState


def _lifespan_value[T](request: Request, key: str, expected: type[T]) -> T:
    """One entry of the lifespan mapping (`request.state` has attribute access only).

    A missing or foreign value means the app was built without its lifespan running
    (e.g. `TestClient` used outside a `with` block), which is a programming error.
    """
    value = getattr(request.state, key, None)
    if not isinstance(value, expected):
        raise RuntimeError("lifespan did not run")
    return value


def get_settings(request: Request) -> Settings:
    return _lifespan_value(request, "settings", Settings)


def get_bootstrap(request: Request) -> Bootstrap:
    return _lifespan_value(request, "bootstrap", Bootstrap)


def get_frame_cache(request: Request) -> FrameCache:
    return _lifespan_value(request, "frame_cache", FrameCache)


def get_sky_state(request: Request) -> SkyState:
    """The published `SkyState`, or 503 `Retry-After: 5` while the bootstrap is `starting`."""
    snapshot = get_bootstrap(request).snapshot
    if snapshot.sky is None:
        detail = snapshot.detail or "the sky data is still loading"
        raise DataNotReadyError(f"data not ready: {detail}", retry_after=5)
    return snapshot.sky


SettingsDep = Annotated[Settings, Depends(get_settings)]
BootstrapDep = Annotated[Bootstrap, Depends(get_bootstrap)]
FrameCacheDep = Annotated[FrameCache, Depends(get_frame_cache)]
SkyStateDep = Annotated[SkyState, Depends(get_sky_state)]
