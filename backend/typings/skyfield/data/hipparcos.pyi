# Stubs for skyfield 1.55 data/hipparcos.py (see skyfield/__init__.pyi for the licence header).

from typing import IO

import pandas as pd

URL: str  # skyfield 1.55 data/hipparcos.py l.14 (hip_main.dat at CDS)
url: str  # skyfield 1.55 data/hipparcos.py l.23 (old name)
PANDAS_MESSAGE: str  # skyfield 1.55 data/hipparcos.py l.25

# Seekable binary file (plain or gzip, sniffed at l.59-60). Columns: magnitude, ra_degrees,
# dec_degrees, parallax_mas, ra_mas_per_year, dec_mas_per_year, ra_hours, epoch_year (1991.25);
# index `hip`. B-V is NOT read; rows without astrometry keep NaN RA/Dec.
def load_dataframe(fobj: IO[bytes]) -> pd.DataFrame: ...  # skyfield 1.55 data/hipparcos.py l.47
