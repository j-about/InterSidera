# Stubs for skyfield 1.55 starlib.py (see skyfield/__init__.pyi for the licence header).

from collections.abc import Sequence
from typing import Self

import pandas as pd

from .timelib import Time as Time
from .units import Angle as Angle
from .units import FloatOrArray as FloatOrArray

# Star is NOT a VectorFunction: it has no `.at()`, no `center`, and cannot be added to an
# ephemeris body. It is observed with `Barycentric.observe(star)` (starlib.py l.109
# `_observe_from_bcrs`). Every field may be an array: one Star for a whole catalog.
class Star:  # skyfield 1.55 starlib.py l.10
    au_km: float  # skyfield 1.55 starlib.py l.40
    target: None  # skyfield 1.55 starlib.py l.41
    ra: Angle  # skyfield 1.55 starlib.py l.47/49
    dec: Angle  # skyfield 1.55 starlib.py l.54/56
    ra_mas_per_year: FloatOrArray  # skyfield 1.55 starlib.py l.71
    dec_mas_per_year: FloatOrArray  # skyfield 1.55 starlib.py l.72
    parallax_mas: FloatOrArray  # skyfield 1.55 starlib.py l.73
    radial_km_per_s: FloatOrArray  # skyfield 1.55 starlib.py l.74
    # TT Julian date; a Time passed to __init__ is converted to its .tt at l.63-64.
    epoch: FloatOrArray  # skyfield 1.55 starlib.py l.75
    names: Sequence[str]  # skyfield 1.55 starlib.py l.76
    def __init__(  # skyfield 1.55 starlib.py l.43-45
        self,
        ra: Angle | None = None,
        dec: Angle | None = None,
        ra_hours: FloatOrArray | None = None,
        dec_degrees: FloatOrArray | None = None,
        ra_mas_per_year: FloatOrArray = 0.0,
        dec_mas_per_year: FloatOrArray = 0.0,
        parallax_mas: FloatOrArray = 0.0,
        radial_km_per_s: FloatOrArray = 0.0,
        names: Sequence[str] = (),
        epoch: Time | FloatOrArray = ...,
    ) -> None: ...
    # Requires columns epoch_year, ra_hours, dec_degrees; optional ra_mas_per_year,
    # dec_mas_per_year, parallax_mas (l.99-106). Filter NaN RA/Dec rows first.
    @classmethod
    def from_dataframe(cls, df: pd.DataFrame) -> Self: ...  # skyfield 1.55 starlib.py l.97-98
