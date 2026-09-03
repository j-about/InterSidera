# Stubs for skyfield 1.55 jpllib.py (see skyfield/__init__.pyi for the licence header).

import os

from jplephem.spk import SPK as SPK
from jplephem.spk import Segment

from .timelib import Time as Time
from .timelib import Timescale as Timescale
from .vectorlib import VectorFunction as VectorFunction

class SpiceKernel:  # skyfield 1.55 jpllib.py l.20
    path: str | os.PathLike[str]  # skyfield 1.55 jpllib.py l.70 (stored as given)
    filename: str  # skyfield 1.55 jpllib.py l.71
    spk: SPK  # skyfield 1.55 jpllib.py l.72
    segments: list[SPICESegment]  # skyfield 1.55 jpllib.py l.73
    def __init__(
        self, path: str | os.PathLike[str]
    ) -> None: ...  # skyfield 1.55 jpllib.py l.69 (memory-maps the file)
    def comments(self) -> str: ...  # skyfield 1.55 jpllib.py l.74 (bound SPK.comments)
    def close(self) -> None: ...  # skyfield 1.55 jpllib.py l.103
    @property
    def codes(self) -> set[int]: ...  # skyfield 1.55 jpllib.py l.110-111
    def names(self) -> dict[int, list[str]]: ...  # skyfield 1.55 jpllib.py l.116
    def decode(
        self, name: int | str
    ) -> int: ...  # skyfield 1.55 jpllib.py l.139 (ValueError unknown, KeyError absent)
    # Returns the segment itself, a Stack (several segments for one target) or a VectorSum chain
    # from the SSB (jpllib.py l.179-189).
    def __getitem__(self, target: int | str) -> VectorFunction: ...  # skyfield 1.55 jpllib.py l.165
    def __contains__(self, name_or_code: int | str) -> bool: ...  # skyfield 1.55 jpllib.py l.191

class SPICESegment(VectorFunction):  # skyfield 1.55 jpllib.py l.198
    center: int  # skyfield 1.55 jpllib.py l.210
    target: int  # skyfield 1.55 jpllib.py l.211
    spk_segment: Segment  # skyfield 1.55 jpllib.py l.212
    def __init__(
        self, ephemeris: SpiceKernel, spk_segment: Segment
    ) -> None: ...  # skyfield 1.55 jpllib.py l.208
    def time_range(
        self, ts: Timescale
    ) -> tuple[Time, Time]: ...  # skyfield 1.55 jpllib.py l.218 (TDB)

class ChebyshevPosition(SPICESegment): ...  # skyfield 1.55 jpllib.py l.222 (SPK type 2)
class ChebyshevPositionVelocity(SPICESegment): ...  # skyfield 1.55 jpllib.py l.241 (SPK type 3)

class Stack(VectorFunction):  # skyfield 1.55 jpllib.py l.246
    center: int  # skyfield 1.55 jpllib.py l.249
    target: int  # skyfield 1.55 jpllib.py l.250
    segments: list[SPICESegment]  # skyfield 1.55 jpllib.py l.257
    def __init__(self, segments: list[SPICESegment]) -> None: ...  # skyfield 1.55 jpllib.py l.248
