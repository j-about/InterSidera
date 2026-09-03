# Stubs for skyfield 1.55 vectorlib.py (see skyfield/__init__.pyi for the licence header).

from typing import Any

from .jpllib import SpiceKernel as SpiceKernel
from .positionlib import Barycentric as Barycentric
from .timelib import Time as Time

class VectorFunction:  # skyfield 1.55 vectorlib.py l.11
    center: int  # set by every concrete subclass (e.g. jpllib.py l.210, toposlib.py l.27)
    target: Any  # int NAIF code for kernel segments, or the vector function itself for observers
    ephemeris: SpiceKernel | None  # skyfield 1.55 vectorlib.py l.14
    vector_name: str  # skyfield 1.55 vectorlib.py l.16-17 (@reify)
    center_name: str  # skyfield 1.55 vectorlib.py l.20-21 (@reify)
    target_name: str  # skyfield 1.55 vectorlib.py l.24-25 (@reify)
    def __add__(self, other: VectorFunction) -> VectorSum: ...  # skyfield 1.55 vectorlib.py l.41
    def __neg__(self) -> VectorFunction: ...  # skyfield 1.55 vectorlib.py l.57 (a ReversedVector)
    def __sub__(self, other: VectorFunction) -> VectorSum: ...  # skyfield 1.55 vectorlib.py l.60
    # `at()` really returns build_position(...) (positionlib.py l.24-32): Barycentric for center 0,
    # Geocentric for 399, ICRF otherwise. skyapi only ever calls `.at()` on observer sums centred
    # on the Solar System Barycenter (`eph['earth'] + wgs84.latlon(...)`, `eph['moon'] + topos`),
    # which need `.observe()`, so the return type is declared as Barycentric (a subclass of ICRF).
    def at(self, t: Time) -> Barycentric: ...  # skyfield 1.55 vectorlib.py l.73

class ReversedVector(VectorFunction):  # skyfield 1.55 vectorlib.py l.106
    vector_function: VectorFunction  # skyfield 1.55 vectorlib.py l.110
    def __init__(
        self, vector_function: VectorFunction
    ) -> None: ...  # skyfield 1.55 vectorlib.py l.107

class VectorSum(VectorFunction):  # skyfield 1.55 vectorlib.py l.131
    vector_functions: tuple[VectorFunction, ...]  # skyfield 1.55 vectorlib.py l.135
    def __init__(  # skyfield 1.55 vectorlib.py l.132
        self,
        center: int,
        target: Any,
        vector_functions: tuple[VectorFunction, ...],
    ) -> None: ...
