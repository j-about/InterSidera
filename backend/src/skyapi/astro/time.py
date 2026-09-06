"""Time helpers on the TT Julian Date (D41): sample grids, UTC strings, TT-UTC, warnings.

Simulation time is a TT Julian Date (brief l.49). Skyfield's builtin timescale supplies
ΔT = TT - UT1 and the leap-second table; we never call `Time.utc_iso()` because it raises on
negative years (brief l.526) and format the calendar tuple ourselves.
"""

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray
from skyfield.constants import DAY_S
from skyfield.timelib import Time, Timescale

from skyapi.astro.sampling import window
from skyapi.astro.warnings import SkyWarning

FloatOrArray = float | NDArray[np.float64]

J2000_TT = 2451545.0
JULIAN_YEAR_DAYS = 365.25
JULIAN_CENTURY_DAYS = 36525.0

# 1972-01-01T00:00:00 UTC, the first instant of the leap-second era, as a UTC-scale Julian Date;
# TAI - UTC was 10 s that day, so the same instant on the TT scale is 42.184 s later.
UTC_START_JD = 2441317.5
UTC_START_TT = UTC_START_JD + 42.184 / DAY_S

# IAU rotation models are fitted to the 1800..2200 span (Archinal et al. 2018); TT JDs of
# 1800-01-01 and 2200-01-01 (proleptic Gregorian, calendar-day boundary).
IAU_ROTATION_RELIABLE_TT: tuple[float, float] = (2378496.5, 2524593.5)
PROPER_MOTION_WARNING_YEARS = 10000
MPC_WARN_YEARS = 2
MPC_ERROR_YEARS = 50

# IERS `finals2000A.all`, the source of Skyfield's daily ΔT table, ends with Bulletin A's
# predictions, which extend one year past the last observed value.
IERS_PREDICTION_DAYS = 365.0
# ΔT is tabulated from -720 on (brief l.332: "historical and IERS tables for -720..present").
# Skyfield's builtin curve, `timelib.build_delta_t` (1.55, l.1094-1135), splices the Table S15
# splines of Stephenson, Morrison, Hohenkerk & Zawilski, whose first knot is `s.lower[0] ==
# -720.0`, onto the daily IERS table; only the long-term parabola before that (after two patch
# splines) is the "approximate" regime. `DELTA_T_TABLE_START_TT` is the TT Julian Date of
# -720-01-01 in the proleptic Gregorian calendar (`ts.tt(-720, 1, 1).tt`).
DELTA_T_TABLE_START_YEAR = -720
DELTA_T_TABLE_START_TT = 1458085.5


@dataclass(frozen=True, slots=True)
class DeltaTCoverage:
    """Extent of the tabulated ΔT: historical splines and daily IERS values, then predictions.

    `observed_tt` runs from -720 (`DELTA_T_TABLE_START_TT`) to one year before the end of the
    daily IERS table; `predicted_until_tt` is the end of that table (Bulletin A predictions).
    """

    observed_tt: tuple[float, float]
    predicted_until_tt: float
    iers_daily_tt: tuple[float, float]
    """The measured part of the daily IERS table (1973-01-02 to one year before its end): the
    range where Skyfield's delta T is known to the millisecond; conformance tests compare Earth
    rotation against Horizons on Skyfield's own timescale only inside it."""


def make_times(ts: Timescale, tt0: float, step_s: int, n: int) -> Time:
    """Build the frame's `Time` array (one vectorised object for every Skyfield call)."""
    return ts.tt_jd(window(tt0, step_s, n))


def now(ts: Timescale) -> Time:
    """The server clock as a scalar `Time` (`/meta.server_time`, `/minor-bodies/defaults`).

    The one place the API reads the wall clock: a route calls it once per request and passes
    the `Time` on, so a response never mixes two instants. `ts.now()` reads the system UTC
    clock and applies the leap-second table of the timescale.
    """
    return ts.now()


def _iso(fields: NDArray[np.int64]) -> str:
    year, month, day, hour, minute, second = (int(value) for value in fields)
    # Astronomical year numbering: year 0 exists and prints as 0000, 45 BC as -0044.
    year_text = f"{year:04d}" if year >= 0 else f"-{-year:04d}"
    return f"{year_text}-{month:02d}-{day:02d}T{hour:02d}:{minute:02d}:{second:02d}Z"


def utc_iso(t: Time) -> str | list[str]:
    """Format UTC as `YYYY-MM-DDThh:mm:ssZ` with a signed, 4+ digit astronomical year.

    Rounding to the second happens before the calendar split, by shifting the instant half a
    second forward and truncating, so `59.9999` carries into the next minute and never prints
    `:60` except during a real leap second. A scalar `Time` gives one string, an array a list.
    """
    shifted = t.ts.tt_jd(t.whole, t.tt_fraction + 0.5 / DAY_S)
    calendar = np.asarray(shifted.utc, dtype=np.float64)  # (6,) or (6, N)
    fields = np.floor(calendar).astype(np.int64)
    if fields.ndim == 1:
        return _iso(fields)
    return [_iso(fields[:, i]) for i in range(fields.shape[1])]


def ut1_iso(t: Time) -> str | list[str]:
    """Format UT1 as `YYYY-MM-DDThh:mm:ssZ`: the TT instant shifted by ΔT on a uniform calendar.

    Before 1972 the contract's "UTC" means UT1 (brief l.51, l.160): `tt_minus_utc_seconds`
    returns ΔT there, and the label must be the calendar of `tt - ΔT`, not Skyfield's UTC (a
    fixed offset from TAI before 1972). The shifted Julian Date is read through the TT calendar,
    which has no leap seconds, with the same half-second rounding as `utc_iso`.
    """
    delta_t = np.asarray(t.delta_t, dtype=np.float64)
    shifted = t.ts.tt_jd(t.whole, t.tt_fraction - (delta_t - 0.5) / DAY_S)
    calendar = np.asarray(shifted.tt_calendar(), dtype=np.float64)  # (6,) or (6, N)
    fields = np.floor(calendar).astype(np.int64)
    if fields.ndim == 1:
        return _iso(fields)
    return [_iso(fields[:, i]) for i in range(fields.shape[1])]


def time_reference(t: Time) -> tuple[float, str]:
    """`tt_minus_utc_seconds` at the first sample and the matching `utc0` label of a window.

    Both come from the same rule: UTC from 1972 on, UT1 before (whole window, like
    `tt_minus_utc_seconds`), so `utc0` always names the instant `tt0 - tt_minus_utc_seconds`.
    """
    delta, utc_is_ut1 = tt_minus_utc_seconds(t)
    first = float(np.atleast_1d(np.asarray(delta, dtype=np.float64))[0])
    t0 = t[0] if np.ndim(t.tt) else t
    label = ut1_iso(t0) if utc_is_ut1 else utc_iso(t0)
    return first, label if isinstance(label, str) else label[0]


def _scalar_or_array(value: NDArray[np.float64]) -> FloatOrArray:
    return float(value) if value.ndim == 0 else value


def tt_minus_utc_seconds(t: Time) -> tuple[FloatOrArray, bool]:
    """Return TT - UTC in seconds and whether the value is really TT - UT1.

    From 1972-01-01 UTC on, TT - UTC = ΔT + (UT1 - UTC) = `t.delta_t + t.dut1`, exact to the
    leap-second table. Before 1972 UTC had no leap seconds and Skyfield's `dut1` is meaningless,
    so the function returns ΔT = TT - UT1 with `utc_is_ut1=True` and the display is labelled UT
    (brief l.51). A window that straddles 1972 is treated as a whole: if any sample precedes
    1972 the UT1 form is used for every sample, so one frame carries one consistent label.
    """
    tt = np.asarray(t.tt, dtype=np.float64)
    delta_t = np.asarray(t.delta_t, dtype=np.float64)
    if bool(np.any(tt < UTC_START_TT)):
        return _scalar_or_array(delta_t), True
    dut1 = np.asarray(t.dut1, dtype=np.float64)
    return _scalar_or_array(delta_t + dut1), False


def delta_t_coverage(ts: Timescale) -> DeltaTCoverage:
    """Extent of the tabulated ΔT behind `ts.delta_t_function` (TT Julian Dates).

    The lower bound is the start of the historical table (-720, brief l.332), not the first row
    of the daily IERS table (1973): between the two Skyfield still interpolates measurements, so
    `delta_t_approximate` is raised only where the long-term parabola takes over.
    """
    table_tt, _ = ts.delta_t_table
    last = float(table_tt[-1])
    return DeltaTCoverage(
        observed_tt=(DELTA_T_TABLE_START_TT, last - IERS_PREDICTION_DAYS),
        predicted_until_tt=last,
        iers_daily_tt=(float(table_tt[0]), last - IERS_PREDICTION_DAYS),
    )


def time_warnings(ts: Timescale, t: Time) -> list[SkyWarning]:
    """Warnings that depend on the time alone: ΔT confidence and proper-motion extrapolation."""
    tt = np.atleast_1d(np.asarray(t.tt, dtype=np.float64))
    warnings: list[SkyWarning] = []
    coverage = delta_t_coverage(ts)
    delta_t_range = (coverage.observed_tt[0], coverage.predicted_until_tt)
    if bool(np.any(tt < delta_t_range[0]) or np.any(tt > delta_t_range[1])):
        warnings.append(SkyWarning("delta_t_approximate", range_tt=delta_t_range))
    span = PROPER_MOTION_WARNING_YEARS * JULIAN_YEAR_DAYS
    proper_motion_range = (J2000_TT - span, J2000_TT + span)
    if bool(np.any(tt < proper_motion_range[0]) or np.any(tt > proper_motion_range[1])):
        warnings.append(
            SkyWarning(
                "proper_motion_extrapolated",
                params={"years": PROPER_MOTION_WARNING_YEARS},
                range_tt=proper_motion_range,
            )
        )
    return warnings
