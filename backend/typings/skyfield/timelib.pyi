# Stubs for skyfield 1.55 timelib.py (see skyfield/__init__.pyi for the licence header).

from collections.abc import Callable, Iterable, Sequence
from datetime import datetime as _datetime
from datetime import timedelta, timezone
from typing import Any, NamedTuple, TypeAlias, overload

import numpy as np
from numpy.typing import NDArray

from .units import FloatOrArray as FloatOrArray

# Calendar components accept scalars, arrays or sequences (`_to_array`, timelib.py l.177-179).
_Calendar: TypeAlias = float | NDArray[Any] | Sequence[float]
_JulianDate: TypeAlias = FloatOrArray | Sequence[float]

GREGORIAN_START: int  # skyfield 1.55 timelib.py l.29
GREGORIAN_START_ENGLAND: int  # skyfield 1.55 timelib.py l.30
utc: timezone  # skyfield 1.55 timelib.py l.51

class CalendarTuple(NamedTuple):  # skyfield 1.55 timelib.py l.34
    year: FloatOrArray
    month: FloatOrArray
    day: FloatOrArray
    hour: FloatOrArray
    minute: FloatOrArray
    second: FloatOrArray

# numpy's NDArray alias is a `type` statement and cannot be a base class: spell the ndarray out.
class CalendarArray(
    np.ndarray[tuple[Any, ...], np.dtype[np.float64]]
):  # skyfield 1.55 timelib.py l.36 (shape (6, N))
    @property
    def year(self) -> NDArray[np.float64]: ...  # skyfield 1.55 timelib.py l.37-38
    @property
    def month(self) -> NDArray[np.float64]: ...  # skyfield 1.55 timelib.py l.39-40
    @property
    def day(self) -> NDArray[np.float64]: ...  # skyfield 1.55 timelib.py l.41-42
    @property
    def hour(self) -> NDArray[np.float64]: ...  # skyfield 1.55 timelib.py l.43-44
    @property
    def minute(self) -> NDArray[np.float64]: ...  # skyfield 1.55 timelib.py l.45-46
    @property
    def second(self) -> NDArray[np.float64]: ...  # skyfield 1.55 timelib.py l.47-48

class Timescale:  # skyfield 1.55 timelib.py l.77
    # Class attribute, None unless polar-motion data was loaded.
    polar_motion_table: Any | None  # skyfield 1.55 timelib.py l.97
    delta_t_function: Any  # skyfield 1.55 timelib.py l.103/106 (callable tt -> delta_t seconds)
    delta_t_table: tuple[NDArray[np.float64], NDArray[np.float64]]  # skyfield 1.55 timelib.py l.105
    leap_dates: NDArray[np.float64]  # skyfield 1.55 timelib.py l.108
    leap_offsets: NDArray[np.float64]  # skyfield 1.55 timelib.py l.108
    J2000: Time  # skyfield 1.55 timelib.py l.109
    B1950: Time  # skyfield 1.55 timelib.py l.110
    julian_calendar_cutoff: int | None  # skyfield 1.55 timelib.py l.111
    def __init__(  # skyfield 1.55 timelib.py l.99
        self,
        delta_t_recent: tuple[NDArray[np.float64], NDArray[np.float64]]
        | Callable[[FloatOrArray], FloatOrArray],
        leap_dates: NDArray[np.float64],
        leap_offsets: NDArray[np.float64],
    ) -> None: ...
    def now(self) -> Time: ...  # skyfield 1.55 timelib.py l.129
    def from_datetime(
        self, datetime: _datetime
    ) -> Time: ...  # skyfield 1.55 timelib.py l.133 (tz-aware only)
    def from_datetimes(
        self, datetime_list: Iterable[_datetime]
    ) -> Time: ...  # skyfield 1.55 timelib.py l.144
    def utc(  # skyfield 1.55 timelib.py l.157
        self,
        year: _Calendar,
        month: _Calendar = 1,
        day: _Calendar = 1,
        hour: _Calendar = 0,
        minute: _Calendar = 0,
        second: _Calendar = 0.0,
    ) -> Time: ...
    def tai_jd(
        self, jd: _JulianDate, fraction: FloatOrArray | None = None
    ) -> Time: ...  # skyfield 1.55 timelib.py l.294
    def tt(  # skyfield 1.55 timelib.py l.301-302 (`jd=` is deprecated: use tt_jd)
        self,
        year: _Calendar | None = None,
        month: _Calendar = 1,
        day: _Calendar = 1,
        hour: _Calendar = 0,
        minute: _Calendar = 0,
        second: _Calendar = 0.0,
        jd: _JulianDate | None = None,
    ) -> Time: ...
    def tt_jd(
        self, jd: _JulianDate, fraction: FloatOrArray | None = None
    ) -> Time: ...  # skyfield 1.55 timelib.py l.315
    def tdb_jd(
        self, jd: _JulianDate, fraction: FloatOrArray | None = None
    ) -> Time: ...  # skyfield 1.55 timelib.py l.346
    def ut1_jd(self, jd: _JulianDate) -> Time: ...  # skyfield 1.55 timelib.py l.367
    def linspace(
        self, t0: Time, t1: Time, num: int = 50
    ) -> Time: ...  # skyfield 1.55 timelib.py l.393

class Time:  # skyfield 1.55 timelib.py l.412
    ts: Timescale  # skyfield 1.55 timelib.py l.427
    whole: FloatOrArray  # skyfield 1.55 timelib.py l.428
    tt_fraction: FloatOrArray  # skyfield 1.55 timelib.py l.429
    shape: tuple[int, ...]  # skyfield 1.55 timelib.py l.430 (`()` for a scalar time)
    def __init__(
        self, ts: Timescale, tt: FloatOrArray, tt_fraction: FloatOrArray | None = None
    ) -> None: ...  # skyfield 1.55 timelib.py l.424
    def __len__(self) -> int: ...  # skyfield 1.55 timelib.py l.432 (TypeError on a scalar time)
    def __getitem__(self, index: Any) -> Time: ...  # skyfield 1.55 timelib.py l.447
    def utc_datetime(self) -> _datetime | NDArray[Any]: ...  # skyfield 1.55 timelib.py l.516
    def utc_iso(
        self, delimiter: str = "T", places: int = 0
    ) -> str | list[str]: ...  # skyfield 1.55 timelib.py l.572
    def utc_strftime(
        self, format: str = ...
    ) -> str | list[str]: ...  # skyfield 1.55 timelib.py l.628
    def tt_calendar(self) -> CalendarTuple | CalendarArray: ...  # skyfield 1.55 timelib.py l.716
    M: NDArray[np.float64]  # skyfield 1.55 timelib.py l.748-749 (@reify; ICRS -> equinox of date)
    MT: NDArray[np.float64]  # skyfield 1.55 timelib.py l.769-770 (@reify)
    J: FloatOrArray  # skyfield 1.55 timelib.py l.811-812 (@reify; Julian year)
    utc: CalendarTuple | CalendarArray  # skyfield 1.55 timelib.py l.822-823 (@reify)
    tai_fraction: FloatOrArray  # skyfield 1.55 timelib.py l.829-830 (@reify)
    tdb_fraction: FloatOrArray  # skyfield 1.55 timelib.py l.833-834 (@reify)
    ut1_fraction: FloatOrArray  # skyfield 1.55 timelib.py l.838-839 (@reify)
    delta_t: FloatOrArray  # skyfield 1.55 timelib.py l.842-843 (@reify; TT - UT1, seconds)
    dut1: FloatOrArray  # skyfield 1.55 timelib.py l.846-847 (@reify; UT1 - UTC, seconds)
    gmst: FloatOrArray  # skyfield 1.55 timelib.py l.850-851 (@reify; hours)
    gast: FloatOrArray  # skyfield 1.55 timelib.py l.855-856 (@reify; hours)
    tai: FloatOrArray  # skyfield 1.55 timelib.py l.867-868 (@property)
    tt: FloatOrArray  # skyfield 1.55 timelib.py l.871-872 (@property)
    tdb: FloatOrArray  # skyfield 1.55 timelib.py l.875-876 (@property)
    ut1: FloatOrArray  # skyfield 1.55 timelib.py l.879-880 (@property)
    def nutation_matrix(self) -> NDArray[np.float64]: ...  # skyfield 1.55 timelib.py l.901
    def precession_matrix(self) -> NDArray[np.float64]: ...  # skyfield 1.55 timelib.py l.908
    def __add__(
        self, other_time: timedelta | float | NDArray[np.float64]
    ) -> Time: ...  # skyfield 1.55 timelib.py l.923
    @overload
    def __sub__(
        self, other_time: Time
    ) -> FloatOrArray: ...  # skyfield 1.55 timelib.py l.934-938 (days of TT)
    @overload
    def __sub__(
        self, other_time: timedelta | float | NDArray[np.float64]
    ) -> Time: ...  # skyfield 1.55 timelib.py l.939-948
    P: NDArray[np.float64]  # skyfield 1.55 timelib.py l.967 (reify(precession_matrix))
    N: NDArray[np.float64]  # skyfield 1.55 timelib.py l.968 (reify(nutation_matrix))

# Proleptic Gregorian Julian day of a calendar date (`day` may carry a fraction); used by
# skyapi.catalogs.mpc_build to unpack MPC epochs the way data/mpc.py l.88-92 does.
def julian_day(  # skyfield 1.55 timelib.py l.976
    year: FloatOrArray,
    month: FloatOrArray = 1,
    day: FloatOrArray = 1,
    julian_before: float | None = None,
) -> FloatOrArray: ...
