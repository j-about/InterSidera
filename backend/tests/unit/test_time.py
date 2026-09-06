"""time.py: UTC strings with astronomical years, TT-UTC, sample grids, ΔT coverage, warnings."""

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from skyfield.timelib import Timescale

from skyapi.astro.time import (
    DELTA_T_TABLE_START_TT,
    DELTA_T_TABLE_START_YEAR,
    IAU_ROTATION_RELIABLE_TT,
    IERS_PREDICTION_DAYS,
    J2000_TT,
    PROPER_MOTION_WARNING_YEARS,
    delta_t_coverage,
    make_times,
    time_warnings,
    tt_minus_utc_seconds,
    utc_iso,
)

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    ("calendar", "expected"),
    [
        ((-44, 3, 15), "-0044-03-15T00:00:00Z"),
        ((0, 1, 1), "0000-01-01T00:00:00Z"),
        ((1582, 10, 4), "1582-10-04T00:00:00Z"),
        ((1582, 10, 10), "1582-10-10T00:00:00Z"),  # proleptic Gregorian: the day exists
        ((1582, 10, 15), "1582-10-15T00:00:00Z"),
        ((2024, 4, 8, 12, 34, 56), "2024-04-08T12:34:56Z"),
        ((12345, 6, 7), "12345-06-07T00:00:00Z"),
        ((-13200, 1, 1), "-13200-01-01T00:00:00Z"),
    ],
)
def test_utc_iso_uses_astronomical_year_numbering(
    ts: Timescale, calendar: tuple[int, ...], expected: str
) -> None:
    assert utc_iso(ts.utc(*calendar)) == expected


def test_proleptic_gregorian_calendar_is_explicit(ts: Timescale) -> None:
    assert ts.julian_calendar_cutoff is None
    # 1582-10-04 and 1582-10-15 are eleven days apart in the proleptic Gregorian calendar,
    # not one day apart as in the historical Julian -> Gregorian switch.
    assert np.isclose(ts.utc(1582, 10, 15).tt - ts.utc(1582, 10, 4).tt, 11.0)


def test_utc_iso_rounds_to_the_nearest_second_before_the_calendar_split(ts: Timescale) -> None:
    base = ts.utc(2000, 1, 1, 11, 59, 59.4)
    assert utc_iso(base) == "2000-01-01T11:59:59Z"
    assert utc_iso(ts.utc(2000, 1, 1, 11, 59, 59.6)) == "2000-01-01T12:00:00Z"
    assert utc_iso(ts.utc(2000, 12, 31, 23, 59, 59.9999)) == "2001-01-01T00:00:00Z"


def test_utc_iso_on_an_array_returns_a_list(ts: Timescale) -> None:
    t = make_times(ts, J2000_TT, 60, 3)
    strings = utc_iso(t)
    assert isinstance(strings, list)
    assert strings == ["2000-01-01T11:58:56Z", "2000-01-01T11:59:56Z", "2000-01-01T12:00:56Z"]


@settings(max_examples=150, deadline=None)
@given(
    year=st.integers(min_value=-4000, max_value=8000),
    month=st.integers(min_value=1, max_value=12),
    day=st.integers(min_value=1, max_value=28),
    hour=st.integers(min_value=0, max_value=23),
    minute=st.integers(min_value=0, max_value=59),
    second=st.integers(min_value=0, max_value=59),
)
def test_utc_iso_round_trips_through_the_timescale(
    ts: Timescale, year: int, month: int, day: int, hour: int, minute: int, second: int
) -> None:
    text = utc_iso(ts.utc(year, month, day, hour, minute, second))
    sign = "-" if year < 0 else ""
    expected = f"{sign}{abs(year):04d}-{month:02d}-{day:02d}T{hour:02d}:{minute:02d}:{second:02d}Z"
    assert text == expected


def test_tt_minus_utc_is_exact_in_the_leap_second_era(ts: Timescale) -> None:
    value, utc_is_ut1 = tt_minus_utc_seconds(ts.utc(2017, 1, 1))
    assert not utc_is_ut1
    assert np.isclose(value, 37.0 + 32.184, atol=1e-9)
    value, utc_is_ut1 = tt_minus_utc_seconds(ts.utc(1972, 1, 1))
    assert not utc_is_ut1
    assert np.isclose(value, 10.0 + 32.184, atol=1e-6)


def test_tt_minus_utc_falls_back_to_delta_t_before_1972(ts: Timescale) -> None:
    t = ts.utc(1960, 1, 1)
    value, utc_is_ut1 = tt_minus_utc_seconds(t)
    assert utc_is_ut1
    assert np.isclose(value, float(np.asarray(t.delta_t)))
    assert 30.0 < float(value) < 36.0  # ΔT around 1960 was about 33 s


def test_tt_minus_utc_treats_a_straddling_window_as_ut1(ts: Timescale) -> None:
    t = ts.tt_jd(np.array([ts.utc(1971, 12, 31).tt, ts.utc(1972, 1, 2).tt]))
    values, utc_is_ut1 = tt_minus_utc_seconds(t)
    assert utc_is_ut1
    assert np.asarray(values).shape == (2,)
    inside = ts.tt_jd(np.array([ts.utc(2017, 1, 1).tt, ts.utc(2017, 6, 1).tt]))
    values, utc_is_ut1 = tt_minus_utc_seconds(inside)
    assert not utc_is_ut1
    assert np.allclose(values, 69.184, atol=1e-9)


def test_make_times_builds_the_frame_grid(ts: Timescale) -> None:
    t = make_times(ts, 2460000.5, 3600, 64)
    tt = np.asarray(t.tt)
    assert tt.shape == (64,)
    assert tt[0] == 2460000.5
    assert np.allclose(np.diff(tt), 3600.0 / 86400.0)
    with pytest.raises(ValueError, match="n must"):
        make_times(ts, 2460000.5, 3600, 65)


def test_delta_t_coverage_starts_with_the_historical_table(ts: Timescale) -> None:
    coverage = delta_t_coverage(ts)
    table_tt, _ = ts.delta_t_table
    # Brief l.332: ΔT is tabulated from -720 (Skyfield's Table S15 splines, whose first knot the
    # builtin curve keeps at -720.0 after the two parabola patch splines), then daily by IERS.
    assert coverage.observed_tt[0] == DELTA_T_TABLE_START_TT
    assert np.isclose(DELTA_T_TABLE_START_TT, ts.tt(DELTA_T_TABLE_START_YEAR, 1, 1).tt)
    assert -720.0 in ts.delta_t_function.long_term_function.lower
    assert coverage.observed_tt[0] < float(table_tt[0])  # the daily table only starts in 1973
    assert coverage.predicted_until_tt == float(table_tt[-1])
    assert coverage.predicted_until_tt - coverage.observed_tt[1] == IERS_PREDICTION_DAYS
    assert coverage.iers_daily_tt == (float(table_tt[0]), coverage.observed_tt[1])
    first_daily = utc_iso(ts.tt_jd(float(table_tt[0])))
    assert isinstance(first_daily, str)
    assert first_daily.startswith("1973-01-0")


def test_time_warnings(ts: Timescale) -> None:
    assert time_warnings(ts, ts.utc(2000, 1, 1)) == []
    # Tabulated ΔT (brief l.332): no `delta_t_approximate` before the daily IERS table starts,
    # only before the historical table (-720) or after the predictions.
    assert time_warnings(ts, ts.utc(1969, 7, 21)) == []
    assert time_warnings(ts, ts.utc(1900, 1, 1)) == []
    assert time_warnings(ts, ts.utc(1582, 10, 4)) == []
    assert time_warnings(ts, ts.utc(-720, 1, 2)) == []
    codes = [w.code for w in time_warnings(ts, ts.utc(-1000, 1, 1))]
    assert codes == ["delta_t_approximate"]
    (warning,) = time_warnings(ts, ts.utc(-1000, 1, 1))
    assert warning.range_tt is not None
    assert warning.range_tt == (DELTA_T_TABLE_START_TT, delta_t_coverage(ts).predicted_until_tt)
    far = ts.tt_jd(J2000_TT + (PROPER_MOTION_WARNING_YEARS + 1) * 365.25)
    codes = [w.code for w in time_warnings(ts, far)]
    assert codes == ["delta_t_approximate", "proper_motion_extrapolated"]
    window = make_times(ts, J2000_TT, 86400, 2)
    assert time_warnings(ts, window) == []


def test_iau_reliability_span_matches_the_calendar_boundaries(ts: Timescale) -> None:
    assert np.isclose(IAU_ROTATION_RELIABLE_TT[0], ts.tt(1800, 1, 1).tt)
    assert np.isclose(IAU_ROTATION_RELIABLE_TT[1], ts.tt(2200, 1, 1).tt)


def test_time_reference_labels_ut1_before_1972(ts) -> None:
    """Before 1972 `utc0` names the instant `tt0 - tt_minus_utc_seconds` (UT1), not TAI - 10 s."""
    from skyapi.astro.time import DAY_S, time_reference, utc_iso

    t = ts.tt(1941, 1, 1, 12, 0, 0)
    delta, label = time_reference(t)
    expected = ts.tt_jd(t.tt - delta / DAY_S)
    year, month, day, hour, minute, second = (int(value) for value in expected.tt_calendar())
    assert label == f"{year:04d}-{month:02d}-{day:02d}T{hour:02d}:{minute:02d}:{round(second):02d}Z"
    assert 20 < delta < 30  # delta T in 1941 (TT - UT1 about 24.6 s)
    assert label != utc_iso(t)  # Skyfield's pre-1972 "UTC" differs by TT - TAI - 10 s

    modern = ts.tt(2024, 4, 8, 12, 0, 0)
    delta_modern, label_modern = time_reference(modern)
    assert label_modern == utc_iso(modern)
    assert delta_modern == 69.184
