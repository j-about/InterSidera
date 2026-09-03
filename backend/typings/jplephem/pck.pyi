# Stubs for jplephem 2.24 pck.py (see jplephem/__init__.pyi for the licence header).

import os
from typing import Any, Literal, Self, TypeAlias, overload

import numpy as np
from numpy.typing import NDArray

# Defined locally: jplephem stubs must not import from the skyfield stub package.
FloatOrArray: TypeAlias = float | NDArray[np.float64]

S_PER_DAY: float  # jplephem 2.24 pck.py l.12

class PCK:  # jplephem 2.24 pck.py l.18 (binary PCK, .bpc)
    daf: Any  # jplephem 2.24 pck.py l.32 (jplephem.daf.DAF)
    segments: list[Segment]  # jplephem 2.24 pck.py l.33-34
    def __init__(self, daf: Any) -> None: ...  # jplephem 2.24 pck.py l.31
    @classmethod
    def open(cls, path: str | os.PathLike[str]) -> Self: ...  # jplephem 2.24 pck.py l.36-37
    def close(self) -> None: ...  # jplephem 2.24 pck.py l.41
    def comments(self) -> str: ...  # jplephem 2.24 pck.py l.55

class Segment:  # jplephem 2.24 pck.py l.59
    daf: Any  # jplephem 2.24 pck.py l.77
    source: bytes  # jplephem 2.24 pck.py l.78
    initial_second: float  # jplephem 2.24 pck.py l.79 (seconds from J2000, TDB)
    final_second: float  # jplephem 2.24 pck.py l.79
    body: int  # jplephem 2.24 pck.py l.79 (PCK body/frame id, e.g. 31006 MOON_PA_DE421)
    frame: int  # jplephem 2.24 pck.py l.79 (1 = J2000 base frame)
    data_type: int  # jplephem 2.24 pck.py l.80 (only 2 is supported, l.102-105)
    start_i: int  # jplephem 2.24 pck.py l.80
    end_i: int  # jplephem 2.24 pck.py l.80
    initial_jd: float  # jplephem 2.24 pck.py l.81 (TDB Julian date)
    final_jd: float  # jplephem 2.24 pck.py l.82
    def __init__(
        self, daf: Any, source: bytes, descriptor: tuple[Any, ...]
    ) -> None: ...  # jplephem 2.24 pck.py l.76
    def describe(self, verbose: bool = True) -> str: ...  # jplephem 2.24 pck.py l.88
    # Euler angles (RA, Dec, W) in radians, shape (3,) or (3,N); with derivative=True also their
    # rates in radians per SECOND. Dates outside the segment raise a plain ValueError (l.143-148).
    @overload
    def compute(
        self, tdb: FloatOrArray, tdb2: FloatOrArray, derivative: Literal[False]
    ) -> NDArray[np.float64]: ...  # jplephem 2.24 pck.py l.120
    @overload
    def compute(  # jplephem 2.24 pck.py l.120
        self,
        tdb: FloatOrArray,
        tdb2: FloatOrArray,
        derivative: Literal[True] = True,
    ) -> tuple[NDArray[np.float64], NDArray[np.float64]]: ...
    @overload
    def compute(  # jplephem 2.24 pck.py l.120
        self,
        tdb: FloatOrArray,
        tdb2: FloatOrArray,
        derivative: bool,
    ) -> NDArray[np.float64] | tuple[NDArray[np.float64], NDArray[np.float64]]: ...
