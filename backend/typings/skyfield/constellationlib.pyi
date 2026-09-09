# Stubs for skyfield 1.55 constellationlib.py (see skyfield/__init__.pyi for the licence header).
# Only `load_constellation_map` is declared: the bundled `constellations.npz` needs no download,
# and `load_constellation_names` is unused (our names come from `constellation_names.csv`).

from collections.abc import Callable

import numpy as np

from .positionlib import ICRF

# The returned function precesses `position` to B1875 and looks the IAU abbreviation up in a grid;
# a scalar position yields a numpy str_ (an array position an ndarray of them).
def load_constellation_map() -> Callable[
    [ICRF], np.str_
]: ...  # skyfield 1.55 constellationlib.py l.34-64
