"""Application state created once by the bootstrap and shared read-only by every request.

Brief l.397: `astro/` functions receive their state explicitly; there is no module-level mutable
state apart from what the lifespan creates. The lifespan (D51) starts the bootstrap thread and
yields the `LifespanState` mapping; `SkyState` is published by that thread once every mandatory
data set is loaded (`astro` and `catalogs` are never `None` on a published state; optional data
leaves `minor_bodies` `None` and its group in `missing`).
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING, TypedDict

from skyapi.models.meta import MetaStatic
from skyapi.settings import Settings

if TYPE_CHECKING:
    # Typing-only imports keep `skyapi.state` (and therefore the routers) free of Skyfield.
    from skyapi.astro.minor_bodies import MinorBodyState
    from skyapi.astro.state import AstroState
    from skyapi.bootstrap import Bootstrap
    from skyapi.catalogs.state import CatalogState
    from skyapi.middleware.caching import FrameCache
    from skyapi.middleware.ratelimit import TokenBucketLimiter


@dataclass(frozen=True, slots=True)
class SkyState:
    """Immutable astronomical context published by the bootstrap (D53)."""

    version: str
    astro: AstroState
    catalogs: CatalogState
    meta: MetaStatic
    minor_bodies: MinorBodyState | None = None
    missing: tuple[str, ...] = ()
    """Data groups that are absent (`dso`, `constellations`, `mpc`): the API is degraded."""


class LifespanState(TypedDict):
    """Mapping yielded by the lifespan; Starlette copies it into every request scope."""

    bootstrap: Bootstrap
    settings: Settings
    limiter: TokenBucketLimiter
    frame_cache: FrameCache
