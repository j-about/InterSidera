# Stubs for skyfield 1.55 framelib.py (see skyfield/__init__.pyi for the licence header).
# Frames are used as `frame.rotation_at(t)`: for a Time array the matrix has shape (3,3,N).

from typing import Protocol

import numpy as np
from numpy.typing import NDArray

from .timelib import Time as Time

# Stub-only Protocol (does not exist at runtime): anything with `rotation_at(t)`, i.e. the frames
# below, planetarylib.Frame, GeographicPosition and PlanetTopos. Never import it outside
# `if TYPE_CHECKING:`.
class _RotationFrame(Protocol):
    def rotation_at(self, t: Time) -> NDArray[np.float64]: ...

ICRS_to_J2000: NDArray[np.float64]  # skyfield 1.55 framelib.py l.34 (3x3 frame bias)

class ICRS:  # skyfield 1.55 framelib.py l.39 (used as a class, never instantiated)
    @staticmethod
    def rotation_at(
        t: Time,
    ) -> NDArray[np.float64]: ...  # skyfield 1.55 framelib.py l.48-49 (identity)

class mean_equator_and_equinox_of_date:  # skyfield 1.55 framelib.py l.52
    @staticmethod
    def rotation_at(
        t: Time,
    ) -> NDArray[np.float64]: ...  # skyfield 1.55 framelib.py l.61-62 (t.P . ICRS_to_J2000)

class true_equator_and_equinox_of_date:  # skyfield 1.55 framelib.py l.65
    @staticmethod
    def rotation_at(
        t: Time,
    ) -> NDArray[np.float64]: ...  # skyfield 1.55 framelib.py l.86-87 (t.M, a proper rotation)

# `tirs`, `itrs` and `ecliptic_frame` are classes at l.96/119/154 that are immediately replaced by
# an instance of themselves at l.117/146/160, so the runtime names are instances; the classes
# below are stub-only stand-ins for `type(tirs)` etc.
class _tirs:  # skyfield 1.55 framelib.py l.96
    @staticmethod
    def rotation_at(t: Time) -> NDArray[np.float64]: ...  # skyfield 1.55 framelib.py l.107-108

tirs: _tirs  # skyfield 1.55 framelib.py l.117

class _itrs:  # skyfield 1.55 framelib.py l.119
    @staticmethod
    def rotation_at(
        t: Time,
    ) -> NDArray[np.float64]: ...  # skyfield 1.55 framelib.py l.133-134 (+ polar motion if loaded)

itrs: _itrs  # skyfield 1.55 framelib.py l.146

def build_ecliptic_matrix(t: Time) -> NDArray[np.float64]: ...  # skyfield 1.55 framelib.py l.148

class _ecliptic_frame:  # skyfield 1.55 framelib.py l.154 (true ecliptic and equinox of date)
    @staticmethod
    def rotation_at(t: Time) -> NDArray[np.float64]: ...  # skyfield 1.55 framelib.py l.156-157

ecliptic_frame: _ecliptic_frame  # skyfield 1.55 framelib.py l.160

class InertialFrame:  # skyfield 1.55 framelib.py l.162
    def __init__(
        self, doc: str, matrix: NDArray[np.float64]
    ) -> None: ...  # skyfield 1.55 framelib.py l.163
    def rotation_at(
        self, t: Time
    ) -> NDArray[np.float64]: ...  # skyfield 1.55 framelib.py l.167 (constant 3x3)

equatorial_B1950_frame: InertialFrame  # skyfield 1.55 framelib.py l.170
ecliptic_J2000_frame: InertialFrame  # skyfield 1.55 framelib.py l.175
galactic_frame: InertialFrame  # skyfield 1.55 framelib.py l.179
