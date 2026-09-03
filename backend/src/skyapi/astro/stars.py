"""Star directions: the authoritative Skyfield path and the SKYS shader rule (brief l.138-139).

`star_direction_at` backs `/sky/altaz` for `hip:` targets at M2; `catalog_direction` reproduces
the client-side rule `dir(t) = normalize(dir + pm * years)` in float64 for the parity tests.
"""

import numpy as np
import pandas as pd
from numpy.typing import NDArray
from skyfield.positionlib import Apparent
from skyfield.starlib import Star
from skyfield.timelib import Time, Timescale
from skyfield.vectorlib import VectorFunction

from skyapi.catalogs.formats import StarTable

_STAR_COLUMNS = (
    "ra_degrees",
    "dec_degrees",
    "ra_mas_per_year",
    "dec_mas_per_year",
    "parallax_mas",
    "epoch_year",
)


class UnknownStarError(LookupError):
    """No Hipparcos row (or SKYS row) carries this identifier."""

    def __init__(self, hip: int) -> None:
        super().__init__(f"unknown Hipparcos identifier {hip}")
        self.hip = hip


def hipparcos_star(ts: Timescale, hipparcos: pd.DataFrame, hip: int) -> Star:
    """A scalar `Star` for one Hipparcos row (`hipparcos` indexed by `hip`, see `state.py`).

    Built from the row's floats rather than `Star.from_dataframe(hipparcos.loc[[hip]])`: a
    one-row frame yields shape-`(1,)` arrays that do not broadcast against a `Time` array, while
    a scalar `Star` does. The epoch conversion is Skyfield's own (starlib 1.55 l.99).
    """
    if hip not in hipparcos.index:
        raise UnknownStarError(hip)
    values: NDArray[np.float64] = hipparcos.loc[[hip], list(_STAR_COLUMNS)].to_numpy(
        dtype=np.float64
    )[0]
    ra_degrees, dec_degrees, pm_ra, pm_dec, parallax, epoch_year = (float(v) for v in values)
    return Star(
        ra_hours=ra_degrees / 15.0,
        dec_degrees=dec_degrees,
        ra_mas_per_year=pm_ra,
        dec_mas_per_year=pm_dec,
        parallax_mas=parallax,
        epoch=ts.tt_jd(1721045.0 + epoch_year * 365.25),
    )


def star_direction_at(
    ts: Timescale, earth: VectorFunction, hipparcos: pd.DataFrame, hip: int, t: Time
) -> Apparent:
    """Apparent geocentric direction of a Hipparcos star: `earth.at(t).observe(star).apparent()`."""
    star = hipparcos_star(ts, hipparcos, hip)
    return earth.at(t).observe(star).apparent()


def catalog_direction(
    table: StarTable, hip: int, years_since_epoch: float | NDArray[np.float64]
) -> NDArray[np.float64]:
    """The SKYS shader rule in float64: `normalize(dir + pm * years)`, shape `(3,)` or `(n, 3)`."""
    matches = np.flatnonzero(table.hip == np.uint32(hip))
    if matches.size == 0:
        raise UnknownStarError(hip)
    index = int(matches[0])
    direction = table.dir[index].astype(np.float64)
    pm = table.pm[index].astype(np.float64)
    years = np.asarray(years_since_epoch, dtype=np.float64)
    moved: NDArray[np.float64] = direction + pm * years[..., np.newaxis]
    normalized: NDArray[np.float64] = moved / np.linalg.norm(moved, axis=-1, keepdims=True)
    return normalized
