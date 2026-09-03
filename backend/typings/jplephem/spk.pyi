# Stubs for jplephem 2.24 spk.py (see jplephem/__init__.pyi for the licence header).

import os
from types import TracebackType
from typing import Any, Self, TypeAlias

import numpy as np
from numpy.typing import NDArray

# Defined locally: jplephem stubs must not import from the skyfield stub package.
FloatOrArray: TypeAlias = float | NDArray[np.float64]

S_PER_DAY: float  # jplephem 2.24 spk.py l.14

class SPK:  # jplephem 2.24 spk.py l.20
    daf: Any  # jplephem 2.24 spk.py l.38 (jplephem.daf.DAF, memory-mapped file)
    # Skyfield's SPICESegment accepts only SPK data types 2 and 3 (jpllib.py l.200-206), which
    # jplephem represents with `Segment`; Type9Segment is out of scope for these stubs.
    segments: list[Segment]  # jplephem 2.24 spk.py l.39-42
    pairs: dict[tuple[int, int], Segment]  # jplephem 2.24 spk.py l.43
    def __init__(self, daf: Any) -> None: ...  # jplephem 2.24 spk.py l.37
    @classmethod
    def open(cls, path: str | os.PathLike[str]) -> Self: ...  # jplephem 2.24 spk.py l.45-46
    def close(self) -> None: ...  # jplephem 2.24 spk.py l.55
    def __getitem__(
        self, key: tuple[int, int]
    ) -> Segment: ...  # jplephem 2.24 spk.py l.74 ((center, target))
    def comments(self) -> str: ...  # jplephem 2.24 spk.py l.78
    def __enter__(self) -> Self: ...  # jplephem 2.24 spk.py l.82
    def __exit__(  # jplephem 2.24 spk.py l.85
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None: ...

class BaseSegment:  # jplephem 2.24 spk.py l.93
    daf: Any  # jplephem 2.24 spk.py l.116
    source: bytes  # jplephem 2.24 spk.py l.117 (e.g. b'DE-0440LE-0440')
    start_second: float  # jplephem 2.24 spk.py l.118 (seconds from J2000, TDB)
    end_second: float  # jplephem 2.24 spk.py l.118
    target: int  # jplephem 2.24 spk.py l.118
    center: int  # jplephem 2.24 spk.py l.118
    frame: int  # jplephem 2.24 spk.py l.119
    data_type: int  # jplephem 2.24 spk.py l.119
    start_i: int  # jplephem 2.24 spk.py l.119
    end_i: int  # jplephem 2.24 spk.py l.119
    start_jd: float  # jplephem 2.24 spk.py l.120 (TDB Julian date)
    end_jd: float  # jplephem 2.24 spk.py l.121
    def __init__(
        self, daf: Any, source: bytes, descriptor: tuple[Any, ...]
    ) -> None: ...  # jplephem 2.24 spk.py l.115
    def describe(self, verbose: bool = True) -> str: ...  # jplephem 2.24 spk.py l.126
    # Positions in km, shape (3,) or (3,N); the base class raises ValueError for unknown types.
    def compute(
        self, tdb: FloatOrArray, tdb2: FloatOrArray = 0.0
    ) -> NDArray[np.float64]: ...  # jplephem 2.24 spk.py l.140
    # (position km, velocity km/day) for type 2; type 3 returns the 6-vector split the same way.
    def compute_and_differentiate(  # jplephem 2.24 spk.py l.148
        self,
        tdb: FloatOrArray,
        tdb2: FloatOrArray = 0.0,
    ) -> tuple[NDArray[np.float64], NDArray[np.float64]]: ...

class Segment(BaseSegment):  # jplephem 2.24 spk.py l.157 (SPK data types 2 and 3)
    def compute(
        self, tdb: FloatOrArray, tdb2: FloatOrArray = 0.0
    ) -> NDArray[np.float64]: ...  # jplephem 2.24 spk.py l.160
    # Raises jplephem OutOfRangeError for dates outside the segment.
    def compute_and_differentiate(  # jplephem 2.24 spk.py l.165
        self,
        tdb: FloatOrArray,
        tdb2: FloatOrArray = 0.0,
    ) -> tuple[NDArray[np.float64], NDArray[np.float64]]: ...
