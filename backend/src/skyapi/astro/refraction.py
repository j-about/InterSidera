"""Reference refraction model the client-side formula must match (D50, brief l.90).

Skyfield's `altaz(temperature_C='standard', pressure_mbar='standard')` applies
`earthlib.refract`: Bennett's (1982) formula inverted iteratively from the true altitude, with
10 °C and `1010 * exp(-elevation_m / 9100)` mbar, zero refraction below -1° and above 89.9°.
Earth only. The `skyfield` fixture subcommand writes `refraction_table` for M3 to validate the
Sæmundsson/Bennett shader formula within 1 arcmin above -1°.
"""

from collections.abc import Iterable

import numpy as np
from numpy.typing import ArrayLike
from skyfield.earthlib import refract

from skyapi.astro.time import FloatOrArray

STANDARD_TEMPERATURE_C = 10.0
STANDARD_PRESSURE_MBAR = 1010.0
PRESSURE_SCALE_HEIGHT_M = 9100.0


def standard_pressure_mbar(elevation_m: float = 0.0) -> float:
    """Skyfield's `'standard'` pressure at an elevation (toposlib.py l.113-114)."""
    return STANDARD_PRESSURE_MBAR * float(np.exp(-elevation_m / PRESSURE_SCALE_HEIGHT_M))


def apparent_altitude_reference(alt_true_deg: ArrayLike, elevation_m: float = 0.0) -> FloatOrArray:
    """Apparent (refracted) altitude in degrees for true altitudes, Skyfield's standard model."""
    alt = np.asarray(alt_true_deg, dtype=np.float64)
    apparent = np.asarray(
        refract(alt, STANDARD_TEMPERATURE_C, standard_pressure_mbar(elevation_m)),
        dtype=np.float64,
    )
    return float(apparent) if apparent.ndim == 0 else apparent


def refraction_table(
    alts_true_deg: Iterable[float], elevation_m: float = 0.0
) -> list[tuple[float, float]]:
    """`(true altitude, apparent altitude)` pairs in degrees for the committed M3 fixture."""
    alts = np.asarray(list(alts_true_deg), dtype=np.float64)
    apparent = np.atleast_1d(np.asarray(apparent_altitude_reference(alts, elevation_m)))
    return [(float(a), float(b)) for a, b in zip(alts, apparent, strict=True)]
