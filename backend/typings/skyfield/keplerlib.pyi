# Stubs for skyfield 1.55 keplerlib.py (see skyfield/__init__.pyi for the licence header).
# `_KeplerOrbit` is private in Skyfield but is the return type of skyfield.data.mpc.mpcorb_orbit /
# comet_orbit, so skyapi has to name it (under `if TYPE_CHECKING:`; add `_rotation`-style
# private-usage ignores where members are touched).

from typing import Self

import numpy as np
from numpy.typing import NDArray

from .timelib import Time as Time
from .units import Distance as Distance
from .units import FloatOrArray as FloatOrArray
from .units import Velocity as Velocity
from .vectorlib import VectorFunction as VectorFunction

class _KeplerOrbit(VectorFunction):  # skyfield 1.55 keplerlib.py l.20
    position_at_epoch: Distance  # skyfield 1.55 keplerlib.py l.47
    velocity_at_epoch: Velocity  # skyfield 1.55 keplerlib.py l.48
    epoch: Time  # skyfield 1.55 keplerlib.py l.49
    mu_au3_d2: float  # skyfield 1.55 keplerlib.py l.50
    # `center` (l.51) is the base `int` (10 for the MPC orbits); `target_name` (l.52) is the
    # designation string for MPC orbits and keeps the base `str` declaration.
    # ECLIPJ2000 -> ICRF for MPC orbits (set by data/mpc.py l.109 and l.236).
    _rotation: NDArray[np.float64] | None  # skyfield 1.55 keplerlib.py l.54
    def __init__(  # skyfield 1.55 keplerlib.py l.21-28
        self,
        position: Distance,
        velocity: Velocity,
        epoch: Time,
        mu_au3_d2: float,
        center: int | None = None,
        target_name: str | None = None,
    ) -> None: ...
    @property
    def target(self) -> Self: ...  # skyfield 1.55 keplerlib.py l.56-57
    @classmethod
    def _from_periapsis(  # skyfield 1.55 keplerlib.py l.60-72
        cls,
        semilatus_rectum_au: FloatOrArray,
        eccentricity: FloatOrArray,
        inclination_degrees: FloatOrArray,
        longitude_of_ascending_node_degrees: FloatOrArray,
        argument_of_perihelion_degrees: FloatOrArray,
        t_periapsis: Time,
        gm_km3_s2: float,
        center: int | None = None,
        target_name: str | None = None,
    ) -> Self: ...
    @classmethod
    def _from_mean_anomaly(  # skyfield 1.55 keplerlib.py l.151-164
        cls,
        semilatus_rectum_au: FloatOrArray,
        eccentricity: FloatOrArray,
        inclination_degrees: FloatOrArray,
        longitude_of_ascending_node_degrees: FloatOrArray,
        argument_of_perihelion_degrees: FloatOrArray,
        mean_anomaly_degrees: FloatOrArray,
        epoch: Time,
        gm_km3_s2: float,
        center: int | None = None,
        target_name: str | None = None,
    ) -> Self: ...

# Two-body propagation; t1 may be an array, the result has shape (3,) + t1.shape.
def propagate(  # skyfield 1.55 keplerlib.py l.435
    position: NDArray[np.float64],
    velocity: NDArray[np.float64],
    t0: FloatOrArray,
    t1: FloatOrArray,
    gm: float,
) -> tuple[NDArray[np.float64], NDArray[np.float64]]: ...
