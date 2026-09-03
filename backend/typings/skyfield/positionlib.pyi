# Stubs for skyfield 1.55 positionlib.py (see skyfield/__init__.pyi for the licence header).

from typing import Any, NoReturn

import numpy as np
from numpy.typing import NDArray

from .framelib import _RotationFrame
from .jpllib import SpiceKernel as SpiceKernel
from .starlib import Star
from .timelib import Time as Time
from .units import Angle as Angle
from .units import Distance as Distance
from .units import FloatOrArray as FloatOrArray
from .units import Velocity as Velocity
from .vectorlib import VectorFunction as VectorFunction

# Barycentric for center 0, Geocentric for 399, ICRF otherwise.
def build_position(  # skyfield 1.55 positionlib.py l.24-25
    position_au: NDArray[np.float64],
    velocity_au_per_d: NDArray[np.float64] | None = None,
    t: Time | None = None,
    center: Any = None,
    target: Any = None,
) -> ICRF: ...

class SSB:  # skyfield 1.55 positionlib.py l.66 (a class with a static method, not a VectorFunction)
    @staticmethod
    def at(t: Time) -> Barycentric: ...  # skyfield 1.55 positionlib.py l.68-69

class ICRF:  # skyfield 1.55 positionlib.py l.76
    center_barycentric: Barycentric | None  # skyfield 1.55 positionlib.py l.91, l.105, l.696
    t: Time  # skyfield 1.55 positionlib.py l.97 (None only for hand-built positions)
    position: Distance  # skyfield 1.55 positionlib.py l.98
    xyz: Distance  # skyfield 1.55 positionlib.py l.98 (same object as .position)
    velocity: Velocity  # skyfield 1.55 positionlib.py l.101 (NaN-filled when unknown, l.100)
    # int NAIF code, or the observer vector function for positions built by .at()/.observe().
    center: Any  # skyfield 1.55 positionlib.py l.102
    target: Any  # skyfield 1.55 positionlib.py l.103
    # @reify, in days; Barycentric.observe() sets it explicitly on the Astrometric (l.697).
    light_time: FloatOrArray  # skyfield 1.55 positionlib.py l.226-227
    def __init__(  # skyfield 1.55 positionlib.py l.95-96
        self,
        position_au: NDArray[np.float64],
        velocity_au_per_d: NDArray[np.float64] | None = None,
        t: Time | None = None,
        center: Any = None,
        target: Any = None,
    ) -> None: ...
    def __sub__(
        self, body: ICRF
    ) -> ICRF: ...  # skyfield 1.55 positionlib.py l.169 (same center required)
    def distance(self) -> Distance: ...  # skyfield 1.55 positionlib.py l.201
    def speed(self) -> Velocity: ...  # skyfield 1.55 positionlib.py l.216
    # epoch: None (ICRS), a Time, a float TT Julian date (an int is rejected!) or 'date'
    # (l.263-273).
    def radec(
        self, epoch: Time | float | str | None = None
    ) -> tuple[Angle, Angle, Distance]: ...  # skyfield 1.55 positionlib.py l.236
    # Raises ValueError unless the observer is a GeographicPosition or PlanetTopos; refraction
    # (temperature_C not None) is only available for Earth observers (l.883-908).
    def altaz(  # skyfield 1.55 positionlib.py l.314
        self,
        temperature_C: float | str | None = None,
        pressure_mbar: float | str = "standard",
    ) -> tuple[Angle, Angle, Distance]: ...
    def separation_from(
        self, another_icrf: ICRF
    ) -> Angle: ...  # skyfield 1.55 positionlib.py l.338
    def frame_xyz(
        self, frame: _RotationFrame
    ) -> Distance: ...  # skyfield 1.55 positionlib.py l.433
    def frame_latlon(
        self, frame: _RotationFrame
    ) -> tuple[Angle, Angle, Distance]: ...  # skyfield 1.55 positionlib.py l.462
    def phase_angle(
        self, sun: VectorFunction
    ) -> Angle: ...  # skyfield 1.55 positionlib.py l.535 (needs center_barycentric)
    def fraction_illuminated(
        self, sun: VectorFunction
    ) -> FloatOrArray: ...  # skyfield 1.55 positionlib.py l.556
    def is_sunlit(
        self, ephemeris: SpiceKernel
    ) -> bool | NDArray[np.bool_]: ...  # skyfield 1.55 positionlib.py l.570
    def is_behind_earth(self) -> bool | NDArray[np.bool_]: ...  # skyfield 1.55 positionlib.py l.594

ICRS = ICRF  # skyfield 1.55 positionlib.py l.654

class Geometric(ICRF): ...  # skyfield 1.55 positionlib.py l.656 (deprecated)

class Barycentric(ICRF):  # skyfield 1.55 positionlib.py l.658
    # `body` needs `_observe_from_bcrs` (l.692): every VectorFunction with center 0, and Star.
    def observe(
        self, body: VectorFunction | Star
    ) -> Astrometric: ...  # skyfield 1.55 positionlib.py l.677

class Astrometric(ICRF):  # skyfield 1.55 positionlib.py l.702
    # Always raises ValueError ("try calling .apparent() first"); declared NoReturn so a call
    # site is flagged as unreachable afterwards. Runtime signature is `altaz(self)`.
    def altaz(  # skyfield 1.55 positionlib.py l.722
        self,
        temperature_C: float | str | None = None,
        pressure_mbar: float | str = "standard",
    ) -> NoReturn: ...
    def apparent(
        self, deflectors: tuple[int, ...] = (10, 599, 699)
    ) -> Apparent: ...  # skyfield 1.55 positionlib.py l.728

class Apparent(ICRF): ...  # skyfield 1.55 positionlib.py l.819

class Geocentric(ICRF):  # skyfield 1.55 positionlib.py l.856
    def itrf_xyz(
        self,
    ) -> Distance: ...  # skyfield 1.55 positionlib.py l.872 (deprecated: frame_xyz(itrs))
