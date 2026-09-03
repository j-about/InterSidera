# Stubs for skyfield 1.55 units.py (see skyfield/__init__.pyi for the licence header).

from typing import TypeAlias

import numpy as np
from numpy.typing import NDArray

# Skyfield accepts a scalar or an array almost everywhere (`_to_array`, functions.py l.166-180)
# and returns a numpy.float64 for scalars; `float` covers both under pyright.
FloatOrArray: TypeAlias = float | NDArray[np.float64]

class Distance:  # skyfield 1.55 units.py l.81
    au: FloatOrArray  # skyfield 1.55 units.py l.116 (getset)
    km: FloatOrArray  # skyfield 1.55 units.py l.118 (getset)
    m: FloatOrArray  # skyfield 1.55 units.py l.119 (getset)
    def __init__(  # skyfield 1.55 units.py l.100
        self,
        au: FloatOrArray | None = None,
        km: FloatOrArray | None = None,
        m: FloatOrArray | None = None,
    ) -> None: ...
    @classmethod
    def from_au(
        cls, au: FloatOrArray
    ) -> Distance: ...  # skyfield 1.55 units.py l.112-113 (deprecated)
    def length(self) -> Distance: ...  # skyfield 1.55 units.py l.128
    def light_seconds(self) -> FloatOrArray: ...  # skyfield 1.55 units.py l.142

class Velocity:  # skyfield 1.55 units.py l.151
    au_per_d: FloatOrArray  # skyfield 1.55 units.py l.169 (getset)
    km_per_s: FloatOrArray  # skyfield 1.55 units.py l.170 (getset)
    m_per_s: FloatOrArray  # skyfield 1.55 units.py l.172 (getset)
    def __init__(  # skyfield 1.55 units.py l.160
        self,
        au_per_d: FloatOrArray | None = None,
        km_per_s: FloatOrArray | None = None,
    ) -> None: ...

class Angle:  # skyfield 1.55 units.py l.270
    radians: FloatOrArray  # skyfield 1.55 units.py l.303 (getset)
    hours: FloatOrArray  # skyfield 1.55 units.py l.311-312 (@reify)
    degrees: FloatOrArray  # skyfield 1.55 units.py l.316-317 (@reify)
    preference: str  # skyfield 1.55 units.py l.288
    signed: bool  # skyfield 1.55 units.py l.291
    def __init__(  # skyfield 1.55 units.py l.272-273
        self,
        angle: Angle | None = None,
        radians: FloatOrArray | None = None,
        degrees: FloatOrArray | None = None,
        hours: FloatOrArray | None = None,
        preference: str | None = None,
        signed: bool = False,
    ) -> None: ...
    @classmethod
    def from_degrees(
        cls, degrees: FloatOrArray, signed: bool = False
    ) -> Angle: ...  # skyfield 1.55 units.py l.293-294
    def arcminutes(self) -> FloatOrArray: ...  # skyfield 1.55 units.py l.321
    def arcseconds(self) -> FloatOrArray: ...  # skyfield 1.55 units.py l.325
    def mas(self) -> FloatOrArray: ...  # skyfield 1.55 units.py l.329
    def hstr(
        self, places: int = 2, warn: bool = True, format: str = ...
    ) -> str: ...  # skyfield 1.55 units.py l.378
    def dstr(
        self, places: int = 1, warn: bool = True, format: str | None = None
    ) -> str: ...  # skyfield 1.55 units.py l.417
