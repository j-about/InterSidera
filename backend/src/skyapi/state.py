"""Application state created once in the lifespan and shared read-only by every request.

Brief l.397: `astro/` functions receive their state explicitly; there is no module-level
mutable state apart from what the lifespan creates. At M1 the three astronomical sub-states
exist (`AstroState`: kernels, frames, observers, bodies; `CatalogState`: stars, DSO,
constellations; `MinorBodyState`: MPC index and orbits) but the lifespan does not load them yet:
M2 wires the bootstrap and the `starting`/`ready`/`degraded` health states (D11).
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING, TypedDict

from skyapi.settings import Settings

if TYPE_CHECKING:
    # Typing-only imports keep `skyapi.state` (and therefore the routers) free of Skyfield.
    from skyapi.astro.minor_bodies import MinorBodyState
    from skyapi.astro.state import AstroState
    from skyapi.catalogs.state import CatalogState


@dataclass(frozen=True, slots=True)
class SkyState:
    """Immutable astronomical context; sub-states stay `None` until the M2 lifespan loads them."""

    version: str
    astro: AstroState | None = None
    catalogs: CatalogState | None = None
    minor_bodies: MinorBodyState | None = None


class LifespanState(TypedDict):
    """Mapping yielded by the lifespan; Starlette copies it into every request scope."""

    sky: SkyState
    settings: Settings
