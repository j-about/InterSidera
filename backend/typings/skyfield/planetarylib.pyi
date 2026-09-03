# Stubs for skyfield 1.55 planetarylib.py (see skyfield/__init__.pyi for the licence header).

from typing import IO, Any, Protocol, Self

import numpy as np
from jplephem.pck import Segment
from numpy.typing import NDArray

from .timelib import Time as Time
from .units import Angle as Angle
from .units import Distance as Distance
from .vectorlib import VectorFunction as VectorFunction

# Stub-only Protocol (does not exist at runtime): what PlanetTopos needs from a frame
# (planetarylib.py l.219, l.244, l.258). Satisfied by `Frame` and by skyapi's own IAU rotation
# frames. Import it under `if TYPE_CHECKING:` only.
class FrameLike(Protocol):
    center: int
    def rotation_at(self, t: Time) -> NDArray[np.float64]: ...
    def rotation_and_rate_at(self, t: Time) -> tuple[NDArray[np.float64], NDArray[np.float64]]: ...

class PlanetaryConstants:  # skyfield 1.55 planetarylib.py l.17
    variables: dict[str, Any]  # skyfield 1.55 planetarylib.py l.27 (text-kernel assignments)
    # Skyfield issue #952 (open in 1.55): read_binary() keeps only the LAST segment per body in
    # `_segment_map` (l.83); `_segment_list` (l.82) keeps them all. skyapi selects the segment
    # covering the requested date from `_segment_list` and passes it to build_frame(_segment=...).
    _segment_list: list[Segment]  # skyfield 1.55 planetarylib.py l.29
    _segment_map: dict[int, Segment]  # skyfield 1.55 planetarylib.py l.30
    def __init__(self) -> None: ...  # skyfield 1.55 planetarylib.py l.26
    def read_text(
        self, file: IO[bytes]
    ) -> None: ...  # skyfield 1.55 planetarylib.py l.46 (.tf/.tpc; closes the file)
    def read_binary(
        self, file: IO[bytes]
    ) -> None: ...  # skyfield 1.55 planetarylib.py l.69 (.bpc; keeps it open, memory-mapped)
    def build_frame_named(self, name: str) -> Frame: ...  # skyfield 1.55 planetarylib.py l.94
    def build_frame(
        self, integer: int, _segment: Segment | None = None
    ) -> Frame: ...  # skyfield 1.55 planetarylib.py l.99
    # Raises ValueError for non-spherical BODY<n>_RADII (l.143-145): skyapi uses
    # PlanetTopos.from_latlon_distance directly instead.
    def build_latlon_degrees(  # skyfield 1.55 planetarylib.py l.137-138
        self,
        frame: Frame,
        latitude_degrees: float,
        longitude_degrees: float,
        elevation_m: float = 0.0,
    ) -> PlanetTopos: ...

class Frame:  # skyfield 1.55 planetarylib.py l.159 (satisfies FrameLike)
    center: int  # skyfield 1.55 planetarylib.py l.163
    def __init__(
        self, center: int, segment: Segment, matrix: NDArray[np.float64] | None
    ) -> None: ...  # skyfield 1.55 planetarylib.py l.162
    def rotation_at(
        self, t: Time
    ) -> NDArray[np.float64]: ...  # skyfield 1.55 planetarylib.py l.167
    def rotation_and_rate_at(
        self, t: Time
    ) -> tuple[
        NDArray[np.float64], NDArray[np.float64]
    ]: ...  # skyfield 1.55 planetarylib.py l.175 (rate per day)

class PlanetTopos(VectorFunction):  # skyfield 1.55 planetarylib.py l.211
    center: int  # skyfield 1.55 planetarylib.py l.219 (frame.center)
    latitude: Angle  # skyfield 1.55 planetarylib.py l.229 (set only by from_latlon_distance)
    longitude: Angle  # skyfield 1.55 planetarylib.py l.230
    def __init__(
        self, frame: FrameLike, position_au: NDArray[np.float64]
    ) -> None: ...  # skyfield 1.55 planetarylib.py l.218
    @classmethod
    def from_latlon_distance(  # skyfield 1.55 planetarylib.py l.223-224 (planetocentric, spherical)
        cls,
        frame: FrameLike,
        latitude: Angle,
        longitude: Angle,
        distance: Distance,
    ) -> Self: ...
    @property
    def target(self) -> Self: ...  # skyfield 1.55 planetarylib.py l.233-234
    # Altazimuth rotation for this location's sky; LEFT-handed (row y negated, l.264): det = -1.
    def rotation_at(
        self, t: Time
    ) -> NDArray[np.float64]: ...  # skyfield 1.55 planetarylib.py l.249
