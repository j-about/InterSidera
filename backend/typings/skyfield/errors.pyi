# Stubs for skyfield 1.55 errors.py (see skyfield/__init__.pyi for the licence header).

import numpy as np
from jplephem.spk import Segment
from numpy.typing import NDArray

from .timelib import Time as Time

class DeprecationError(Exception): ...  # skyfield 1.55 errors.py l.3

class EphemerisRangeError(ValueError):  # skyfield 1.55 errors.py l.6
    start_time: Time  # skyfield 1.55 errors.py l.18
    end_time: Time  # skyfield 1.55 errors.py l.19
    time_mask: NDArray[np.bool_]  # skyfield 1.55 errors.py l.20 (True marks out-of-range times)
    segment: Segment  # skyfield 1.55 errors.py l.21 (the jplephem SPK segment, jpllib.py l.235)
    def __init__(  # skyfield 1.55 errors.py l.16
        self,
        message: str,
        start_time: Time,
        end_time: Time,
        time_mask: NDArray[np.bool_],
        segment: Segment,
    ) -> None: ...
