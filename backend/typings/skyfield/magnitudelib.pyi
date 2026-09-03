# Stubs for skyfield 1.55 magnitudelib.py (see skyfield/__init__.pyi for the licence header).

from .positionlib import ICRF as ICRF
from .units import FloatOrArray as FloatOrArray

# Dispatches on `position.target` (NAIF code 199/299/399/499/599/699/799/899 or barycenters
# 1/2/4/5/6/7/8, l.307-325); ValueError for anything else (Moon, Sun, Pluto). Needs a position
# from `.observe()` (center_barycentric). Out-of-model phase angles yield nan, not an error.
def planetary_magnitude(position: ICRF) -> FloatOrArray: ...  # skyfield 1.55 magnitudelib.py l.36
