# Stubs for skyfield 1.55 api.py (see skyfield/__init__.pyi for the licence header).
# Only the names skyapi uses are re-exported; EarthSatellite, Topos, load_file, load_constellation_*
# position_of_radec/position_from_radec and wms are intentionally absent.

from datetime import timezone

from .constants import B1950 as B1950
from .constants import T0 as T0
from .constants import pi as pi
from .constants import tau as tau
from .iokit import Loader as Loader
from .planetarylib import PlanetaryConstants as PlanetaryConstants
from .positionlib import SSB as SSB
from .starlib import Star as Star
from .timelib import GREGORIAN_START as GREGORIAN_START
from .timelib import GREGORIAN_START_ENGLAND as GREGORIAN_START_ENGLAND
from .timelib import Time as Time
from .timelib import Timescale as Timescale
from .toposlib import iers2010 as iers2010
from .toposlib import wgs84 as wgs84
from .units import Angle as Angle
from .units import Distance as Distance
from .units import Velocity as Velocity

utc: timezone  # skyfield 1.55 api.py l.17-19 (timelib.utc)
# Loader('.'); its downloading methods are deliberately not declared, see iokit.pyi.
load: Loader  # skyfield 1.55 api.py l.23
N: float  # skyfield 1.55 api.py l.24
E: float  # skyfield 1.55 api.py l.24
S: float  # skyfield 1.55 api.py l.25
W: float  # skyfield 1.55 api.py l.25
