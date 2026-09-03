# Stubs for skyfield 1.55 data/mpc.py (see skyfield/__init__.pyi for the licence header).

from typing import IO, Any

import pandas as pd

from ..keplerlib import _KeplerOrbit
from ..timelib import Timescale as Timescale

MPCORB_URL: str  # skyfield 1.55 data/mpc.py l.13 (MPCORB.DAT.gz)
COMET_URL: str  # skyfield 1.55 data/mpc.py l.112 (CometEls.txt)

# Binary, already-gunzipped, header-stripped file object (wrapped in io.TextIOWrapper, l.67).
def load_mpcorb_dataframe(fobj: IO[bytes]) -> pd.DataFrame: ...  # skyfield 1.55 data/mpc.py l.59

# `row` is duck-typed (attribute access: semimajor_axis_au, eccentricity, epoch_packed, ...):
# a pandas row Series or any object exposing those names.
def mpcorb_orbit(
    row: Any, ts: Timescale, gm_km3_s2: float
) -> _KeplerOrbit: ...  # skyfield 1.55 data/mpc.py l.80
def load_comets_dataframe(
    fobj: IO[bytes],
) -> pd.DataFrame: ...  # skyfield 1.55 data/mpc.py l.150 (12 columns)
def load_comets_dataframe_slow(
    fobj: IO[bytes],
) -> pd.DataFrame: ...  # skyfield 1.55 data/mpc.py l.199 (all 18 columns)

# `row` needs attribute access for the elements and item access for row['designation'] (l.234).
def comet_orbit(
    row: Any, ts: Timescale, gm_km3_s2: float
) -> _KeplerOrbit: ...  # skyfield 1.55 data/mpc.py l.215
def unpack(designation_packed: str) -> str: ...  # skyfield 1.55 data/mpc.py l.263
