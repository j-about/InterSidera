"""Speed-adaptive sampling limits shared by `/sky/frame` and `/meta.limits` (D50, brief l.70).

The window is `n` samples spaced `step_s` simulated seconds apart on the TT Julian Date scale.
Each body class has a maximum step so the client can decide on snapshot mode before requesting.
"""

from collections.abc import Iterable, Mapping
from types import MappingProxyType

import numpy as np
from numpy.typing import NDArray

DAY_S = 86400.0
MAX_SAMPLES = 64
MIN_STEP_S = 1

MAX_STEP_S: Mapping[str, int] = MappingProxyType(
    {
        "moon": 3600,
        "inner_planets": 21600,
        "sun_and_outer": 86400,
        "minor": 86400,
    }
)

STEP_CLASS_BY_BODY: Mapping[str, str] = MappingProxyType(
    {
        "sun": "sun_and_outer",
        "mercury": "inner_planets",
        "venus": "inner_planets",
        "earth": "sun_and_outer",
        "moon": "moon",
        "mars": "inner_planets",
        "jupiter": "sun_and_outer",
        "saturn": "sun_and_outer",
        "uranus": "sun_and_outer",
        "neptune": "sun_and_outer",
        "pluto": "sun_and_outer",
    }
)


def step_class(body_id: str) -> str:
    """Return the `max_step_s` class of a major body id."""
    try:
        return STEP_CLASS_BY_BODY[body_id]
    except KeyError:
        raise ValueError(f"unknown body id {body_id!r}") from None


def clamp_step(step_s: int, body_ids: Iterable[str], minor_ids: Iterable[str] = ()) -> int:
    """Clamp `step_s` to the smallest class maximum among the requested bodies.

    Minor bodies (any id in `minor_ids`) belong to the `minor` class. With no body at all the
    step is only bounded below by `MIN_STEP_S`.
    """
    if step_s < MIN_STEP_S:
        raise ValueError(f"step_s must be >= {MIN_STEP_S}, got {step_s}")
    limits = [MAX_STEP_S[step_class(body_id)] for body_id in body_ids]
    if any(True for _ in minor_ids):
        limits.append(MAX_STEP_S["minor"])
    if not limits:
        return step_s
    return min(step_s, min(limits))


def window(tt0: float, step_s: int, n: int) -> NDArray[np.float64]:
    """Return the `n` TT Julian Dates `tt0 + i * step_s / 86400`, `i = 0..n-1`."""
    if not 1 <= n <= MAX_SAMPLES:
        raise ValueError(f"n must be between 1 and {MAX_SAMPLES}, got {n}")
    if step_s < MIN_STEP_S:
        raise ValueError(f"step_s must be >= {MIN_STEP_S}, got {step_s}")
    return tt0 + np.arange(n, dtype=np.float64) * (float(step_s) / DAY_S)
