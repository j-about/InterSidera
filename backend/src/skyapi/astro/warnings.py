"""Closed list of warning codes and the warning object (brief api_contract l.168).

Warnings are never free text: the frontend translates the `code`, `params` carries the numbers
a translation may need and `range_tt` the valid range when one exists. Producers live next to
the astronomy they qualify (`time.py`, `observers.py`, `minor_bodies.py`); M2 routers only
serialise them.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal, get_args

WarningCode = Literal[
    "iau_rotation_approximate",
    "pluto_barycenter",
    "delta_t_approximate",
    "proper_motion_extrapolated",
    "mpc_extrapolation",
    "mpc_unreliable",
]

WARNING_CODES: frozenset[str] = frozenset(get_args(WarningCode))


@dataclass(frozen=True, slots=True)
class SkyWarning:
    """One warning object `{ code, params?, range_tt? }` (brief l.168)."""

    code: WarningCode
    params: Mapping[str, float | int | str] | None = None
    range_tt: tuple[float, float] | None = None
