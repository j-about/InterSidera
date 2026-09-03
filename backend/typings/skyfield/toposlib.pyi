# Stubs for skyfield 1.55 toposlib.py (see skyfield/__init__.pyi for the licence header).

from typing import Self

import numpy as np
from numpy.typing import NDArray

from .positionlib import ICRF as ICRF
from .timelib import Time as Time
from .units import Angle as Angle
from .units import Distance as Distance
from .units import FloatOrArray as FloatOrArray
from .vectorlib import VectorFunction as VectorFunction

class ITRSPosition(VectorFunction):  # skyfield 1.55 toposlib.py l.24
    center: int  # skyfield 1.55 toposlib.py l.27 (class attribute 399)
    itrs_xyz: Distance  # skyfield 1.55 toposlib.py l.30
    def __init__(self, itrs_xyz: Distance) -> None: ...  # skyfield 1.55 toposlib.py l.29
    @property
    def target(
        self,
    ) -> Self: ...  # skyfield 1.55 toposlib.py l.34-35 (the location is its own target)

class GeographicPosition(ITRSPosition):  # skyfield 1.55 toposlib.py l.52
    model: Geoid  # skyfield 1.55 toposlib.py l.73
    latitude: Angle  # skyfield 1.55 toposlib.py l.74
    longitude: Angle  # skyfield 1.55 toposlib.py l.75
    elevation: Distance  # skyfield 1.55 toposlib.py l.76
    def __init__(  # skyfield 1.55 toposlib.py l.71
        self,
        model: Geoid,
        latitude: Angle,
        longitude: Angle,
        elevation: Distance,
        itrs_xyz: Distance,
    ) -> None: ...
    def lst_hours_at(
        self, t: Time
    ) -> FloatOrArray: ...  # skyfield 1.55 toposlib.py l.88 (local apparent sidereal time)
    # 'standard' means 10 C and 1010 mbar scaled by exp(-elevation_m / 9100) (l.111-114).
    def refract(  # skyfield 1.55 toposlib.py l.100
        self,
        altitude_degrees: FloatOrArray,
        temperature_C: float | str,
        pressure_mbar: float | str,
    ) -> Angle: ...
    # GCRS -> altazimuth. LEFT-handed (rows reversed, l.77): det = -1, see brief pitfalls.
    def rotation_at(self, t: Time) -> NDArray[np.float64]: ...  # skyfield 1.55 toposlib.py l.118

class Geoid:  # skyfield 1.55 toposlib.py l.128
    name: str  # skyfield 1.55 toposlib.py l.140
    radius: Distance  # skyfield 1.55 toposlib.py l.141 (equatorial)
    inverse_flattening: float  # skyfield 1.55 toposlib.py l.142
    polar_radius: Distance  # skyfield 1.55 toposlib.py l.148-149 (@reify)
    def __init__(
        self, name: str, radius_m: float, inverse_flattening: float
    ) -> None: ...  # skyfield 1.55 toposlib.py l.139
    def latlon(  # skyfield 1.55 toposlib.py l.153-154
        self,
        latitude_degrees: float,
        longitude_degrees: float,
        elevation_m: float = 0.0,
        cls: type[GeographicPosition] = ...,
    ) -> GeographicPosition: ...
    # The four methods below require a geocentric position (center 399), else ValueError
    # (l.260-266).
    def latlon_of(
        self, position: ICRF
    ) -> tuple[Angle, Angle]: ...  # skyfield 1.55 toposlib.py l.203
    def height_of(self, position: ICRF) -> Distance: ...  # skyfield 1.55 toposlib.py l.215
    def geographic_position_of(
        self, position: ICRF
    ) -> GeographicPosition: ...  # skyfield 1.55 toposlib.py l.227
    def subpoint_of(
        self, position: ICRF
    ) -> GeographicPosition: ...  # skyfield 1.55 toposlib.py l.247

wgs84: Geoid  # skyfield 1.55 toposlib.py l.285 (6378137.0 m, 1/f 298.257223563)
iers2010: Geoid  # skyfield 1.55 toposlib.py l.286 (6378136.6 m, 1/f 298.25642)
