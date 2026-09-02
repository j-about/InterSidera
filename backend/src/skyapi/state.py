"""Application state created once in the lifespan and shared read-only by every request.

Brief l.397: `astro/` functions receive `SkyState` explicitly; there is no module-level
mutable state apart from what the lifespan creates. M1/M2 add the timescale, ephemeris,
frames, catalogs and MPC index as further frozen fields without changing the pattern (D11).
"""

from dataclasses import dataclass
from typing import TypedDict

from skyapi.settings import Settings


@dataclass(frozen=True, slots=True)
class SkyState:
    """Immutable astronomical context; at M0 only the package version."""

    version: str


class LifespanState(TypedDict):
    """Mapping yielded by the lifespan; Starlette copies it into every request scope."""

    sky: SkyState
    settings: Settings
