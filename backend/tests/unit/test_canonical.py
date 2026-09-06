"""api/canonical.py: rounding, wrapping, list handling and the canonical query objects (D55).

The `@given` tests use no fixtures at all: the functions under test are pure.
"""

import math

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from skyapi.api.canonical import (
    altaz_query,
    canonical_elev,
    canonical_lat,
    canonical_lon,
    canonical_observer,
    canonical_tt,
    expand_bodies,
    frame_query,
    split_ids,
    validate_minor_ids,
)
from skyapi.astro.bodies import BODY_IDS
from skyapi.astro.sampling import MAX_FRAME_CELLS, MAX_MINOR_BODIES, MAX_TARGETS
from skyapi.middleware.problem import InvalidParameterError

pytestmark = pytest.mark.unit

finite = st.floats(allow_nan=False, allow_infinity=False)
latitudes = st.floats(min_value=-90.0, max_value=90.0)
# TT Julian Dates of the DE441 span: the double spacing there is below 1e-9 day, so rounding
# to 1e-8 day is meaningful (a JD near 1e9 could not be rounded that finely).
tt_values = st.floats(min_value=-3.2e6, max_value=8.1e6)
coordinate_jitter = st.floats(min_value=-4e-7, max_value=4e-7)
tt_jitter = st.floats(min_value=-4e-9, max_value=4e-9)
elevation_jitter = st.floats(min_value=-0.4, max_value=0.4)


def _positive_zero(value: float) -> bool:
    """True unless `value` is `-0.0`."""
    return value != 0.0 or math.copysign(1.0, value) > 0.0


# --------------------------------------------------------------------------- properties


@settings(max_examples=300, deadline=None)
@given(latitudes)
def test_lat_is_rounded_idempotent_and_never_negative_zero(lat: float) -> None:
    value = canonical_lat(lat)
    assert -90.0 <= value <= 90.0
    assert canonical_lat(value) == value
    assert value == round(value, 6)
    assert abs(value - lat) <= 5e-7 + 1e-12
    assert _positive_zero(value)


@settings(max_examples=300, deadline=None)
@given(finite)
def test_lon_is_wrapped_idempotent_and_never_negative_zero(lon: float) -> None:
    value = canonical_lon(lon)
    assert -180.0 <= value < 180.0
    assert canonical_lon(value) == value
    assert value == round(value, 6)
    assert _positive_zero(value)


@settings(max_examples=300, deadline=None)
@given(st.floats(min_value=-180.0, max_value=180.0, exclude_max=True))
def test_lon_inside_the_range_only_rounds(lon: float) -> None:
    difference = abs(canonical_lon(lon) - lon)
    # 179.9999996 rounds to 180 and wraps to -180: a full turn away from the input.
    assert min(difference, abs(difference - 360.0)) <= 5e-7 + 1e-9


@settings(max_examples=300, deadline=None)
@given(finite)
def test_tt_stays_within_the_rounding_step(tt: float) -> None:
    value = canonical_tt(tt)
    assert abs(value - tt) <= 1e-8
    assert canonical_tt(value) == value
    assert _positive_zero(value)


@settings(max_examples=300, deadline=None)
@given(latitudes, coordinate_jitter)
def test_lat_differences_below_the_step_share_one_canonical_value(lat: float, delta: float) -> None:
    base = canonical_lat(lat)
    assert canonical_lat(base + delta) == base


@settings(max_examples=300, deadline=None)
@given(finite, coordinate_jitter)
def test_lon_differences_below_the_step_share_one_canonical_value(lon: float, delta: float) -> None:
    base = canonical_lon(lon)
    assert canonical_lon(base + delta) == base


@settings(max_examples=300, deadline=None)
@given(tt_values, tt_jitter)
def test_tt_differences_below_the_step_share_one_canonical_value(tt: float, delta: float) -> None:
    base = canonical_tt(tt)
    assert canonical_tt(base + delta) == base


@settings(max_examples=200, deadline=None)
@given(
    st.permutations(["mars", "venus", "jupiter", "moon"]),
    st.permutations(["a:1", "c:1P", "a:4", "c:C/1995_O1"]),
)
def test_cache_key_is_independent_of_list_order(bodies: list[str], minor: list[str]) -> None:
    query = frame_query(
        body="earth",
        lat=48.8566,
        lon=2.3522,
        elev=35.0,
        tt=2461285.5,
        step_s=300,
        n=32,
        bodies=",".join(bodies),
        minor=",".join(minor),
    )
    reference = frame_query(
        body="earth",
        lat=48.8566,
        lon=2.3522,
        elev=35.0,
        tt=2461285.5,
        step_s=300,
        n=32,
        bodies="jupiter,mars,moon,venus",
        minor="a:1,a:4,c:1P,c:C/1995_O1",
    )
    assert query == reference
    assert query.cache_key() == reference.cache_key()
    assert query.bodies == ("jupiter", "mars", "moon", "venus")
    assert query.minor == ("a:1", "a:4", "c:1P", "c:C/1995_O1")


@settings(max_examples=200, deadline=None)
@given(coordinate_jitter, coordinate_jitter, tt_jitter, elevation_jitter)
def test_cache_key_ignores_differences_below_the_rounding_steps(
    d_lat: float, d_lon: float, d_tt: float, d_elev: float
) -> None:
    reference = frame_query(
        body="earth",
        lat=48.8566,
        lon=2.3522,
        elev=35.0,
        tt=2461285.5,
        step_s=300,
        n=32,
        bodies="all",
        minor=None,
    )
    jittered = frame_query(
        body="earth",
        lat=48.8566 + d_lat,
        lon=2.3522 + d_lon,
        elev=35.0 + d_elev,
        tt=2461285.5 + d_tt,
        step_s=300,
        n=32,
        bodies="all",
        minor=None,
    )
    assert jittered.cache_key() == reference.cache_key()
    assert jittered == reference


# --------------------------------------------------------------------------- examples


def test_scalar_examples() -> None:
    assert canonical_lon(190.0) == -170.0
    assert canonical_lon(180.0) == -180.0
    assert canonical_lon(-180.0) == -180.0
    assert canonical_lon(540.0) == -180.0
    assert canonical_lon(2.35220049) == 2.3522
    assert canonical_lon(-1e-7) == 0.0
    assert _positive_zero(canonical_lon(-1e-7))
    assert canonical_lat(-1e-7) == 0.0
    assert _positive_zero(canonical_lat(-1e-7))
    assert canonical_lat(90.0000004) == 90.0
    assert canonical_lat(48.85660049) == 48.8566
    assert canonical_elev(35.4) == 35
    assert canonical_elev(-12000.4) == -12000
    assert canonical_elev(100000.4) == 100000
    assert isinstance(canonical_elev(0.0), int)
    assert canonical_tt(2461285.500000004) == 2461285.5
    assert canonical_tt(2461285.500000006) == 2461285.50000001
    assert canonical_tt(-0.0) == 0.0
    assert _positive_zero(canonical_tt(-0.0))


@pytest.mark.parametrize("lat", [90.000001, -90.000001, 91.0, float("nan"), float("inf")])
def test_lat_out_of_range_is_400(lat: float) -> None:
    with pytest.raises(InvalidParameterError, match="lat"):
        canonical_lat(lat)


@pytest.mark.parametrize("elev", [-12000.6, 100000.6, float("nan"), float("-inf")])
def test_elev_out_of_range_is_400(elev: float) -> None:
    with pytest.raises(InvalidParameterError, match="elev"):
        canonical_elev(elev)


def test_non_finite_lon_and_tt_are_400() -> None:
    with pytest.raises(InvalidParameterError, match="lon"):
        canonical_lon(float("nan"))
    with pytest.raises(InvalidParameterError, match="tt"):
        canonical_tt(float("inf"))


def test_canonical_observer() -> None:
    assert canonical_observer("earth") == "earth"
    assert canonical_observer("pluto") == "pluto"
    for body in ("sun", "Earth", "vulcan", ""):
        with pytest.raises(InvalidParameterError, match="unknown observer"):
            canonical_observer(body)


def test_split_ids() -> None:
    assert split_ids("moon,mars, venus ,mars", "bodies") == ("mars", "moon", "venus")
    assert split_ids("a:1", "minor") == ("a:1",)
    for raw in ("", ",", "moon,", ",moon", "moon,,mars", "mars+venus", "mars venus", " "):
        with pytest.raises(InvalidParameterError, match="bodies"):
            split_ids(raw, "bodies")


def test_expand_bodies() -> None:
    everything_but_earth = tuple(sorted(body for body in BODY_IDS if body != "earth"))
    assert expand_bodies("all", "earth") == everything_but_earth
    assert "earth" not in expand_bodies("all", "earth")
    assert "mars" not in expand_bodies("all", "mars")
    assert "earth" in expand_bodies("all", "mars")
    assert len(expand_bodies("all", "moon")) == len(BODY_IDS) - 1
    assert expand_bodies("venus,mars", "earth") == ("mars", "venus")
    assert expand_bodies("earth,sun", "moon") == ("earth", "sun")
    with pytest.raises(InvalidParameterError, match="from itself"):
        expand_bodies("earth", "earth")
    with pytest.raises(InvalidParameterError, match="from itself"):
        expand_bodies("moon,sun", "moon")
    with pytest.raises(InvalidParameterError, match="'all' cannot be combined"):
        expand_bodies("all,moon", "earth")
    with pytest.raises(InvalidParameterError, match="unknown body ids: vulcan"):
        expand_bodies("sun,vulcan", "earth")
    with pytest.raises(InvalidParameterError, match="unknown body ids: Moon"):
        expand_bodies("Moon", "earth")


def test_validate_minor_ids() -> None:
    accepted = ("a:1", "a:K24A00B", "c:1P", "c:C/2023_A3", "c:73P-BT", "c:1I", "a:~0000")
    assert validate_minor_ids(("a:1", "c:C/2023_A3", "c:73P-BT")) == (
        "a:1",
        "c:C/2023_A3",
        "c:73P-BT",
    )
    for raw in accepted[:6]:
        assert validate_minor_ids((raw,)) == (raw,)
    for raw in ("x:1", "a:", "a:1 2", "1", "a:~0000", "c:C/2023 A3", "A:1"):
        with pytest.raises(InvalidParameterError, match="minor: invalid ids"):
            validate_minor_ids((raw,))
    too_many = tuple(f"a:{i}" for i in range(1, MAX_MINOR_BODIES + 2))
    with pytest.raises(InvalidParameterError, match=f"at most {MAX_MINOR_BODIES}"):
        validate_minor_ids(too_many)
    assert len(validate_minor_ids(too_many[:MAX_MINOR_BODIES])) == MAX_MINOR_BODIES


def _frame(**overrides: object) -> object:
    params: dict[str, object] = {
        "body": "earth",
        "lat": 48.8566,
        "lon": 2.3522,
        "elev": 35.0,
        "tt": 2461285.5,
        "step_s": 300,
        "n": 32,
        "bodies": "all",
        "minor": None,
    }
    params.update(overrides)
    return frame_query(**params)  # type: ignore[arg-type]


def test_frame_query_canonical_values_and_clamp() -> None:
    query = frame_query(
        body="earth",
        lat=48.85660049,
        lon=362.3522,
        elev=35.4,
        tt=2461285.500000004,
        step_s=999999,
        n=32,
        bodies="all",
        minor="c:1P, a:1",
    )
    assert query.lat_deg == 48.8566
    assert query.lon_deg == 2.3522
    assert query.elev_m == 35
    assert query.tt0 == 2461285.5
    assert query.step_s == 3600  # the Moon is among `all`
    assert query.minor == ("a:1", "c:1P")
    assert query.cache_key() == (
        "bodies=jupiter,mars,mercury,moon,neptune,pluto,saturn,sun,uranus,venus&body=earth"
        "&elev=35&lat=48.8566&lon=2.3522&minor=a:1,c:1P&n=32&step_s=3600&tt=2461285.5"
    )
    no_moon = frame_query(
        body="earth",
        lat=0.0,
        lon=0.0,
        elev=0.0,
        tt=2461285.5,
        step_s=999999,
        n=1,
        bodies="sun,jupiter",
        minor=None,
    )
    assert no_moon.step_s == 86400
    assert no_moon.minor == ()
    unclamped = frame_query(
        body="earth", lat=0.0, lon=0.0, elev=0.0, tt=0.0, step_s=1, n=64, bodies="moon", minor=None
    )
    assert unclamped.step_s == 1


def test_frame_query_rejects_bad_requests() -> None:
    with pytest.raises(InvalidParameterError, match="unknown observer"):
        _frame(body="sun")
    with pytest.raises(InvalidParameterError, match="from itself"):
        _frame(bodies="earth")
    with pytest.raises(InvalidParameterError, match="minor: invalid ids"):
        _frame(minor="x:1")
    with pytest.raises(InvalidParameterError, match="minor: empty item"):
        _frame(minor="")
    with pytest.raises(InvalidParameterError, match="step_s"):
        _frame(step_s=0)
    with pytest.raises(InvalidParameterError, match="step_s"):
        _frame(step_s=31557601)
    with pytest.raises(InvalidParameterError, match="n must"):
        _frame(n=65)
    with pytest.raises(InvalidParameterError, match="n must"):
        _frame(n=0)
    hundred = ",".join(f"a:{i}" for i in range(1, 101))
    with pytest.raises(InvalidParameterError, match=str(MAX_FRAME_CELLS)):
        _frame(n=64, bodies="all", minor=hundred)
    # 37 * (10 + 100) = 4070 fits, 38 * 110 = 4180 does not.
    assert _frame(n=37, bodies="all", minor=hundred) is not None
    with pytest.raises(InvalidParameterError, match=str(MAX_FRAME_CELLS)):
        _frame(n=38, bodies="all", minor=hundred)


def test_altaz_query() -> None:
    query = altaz_query(
        body="earth",
        lat=51.48,
        lon=-0.0000001,
        elev=0.0,
        tt=2461285.5,
        targets="moon,sun,hip:32349,dso:M31,a:1,c:1P,moon",
        refraction=True,
    )
    assert query.targets == ("a:1", "c:1P", "dso:M31", "hip:32349", "moon", "sun")
    assert query.lon_deg == 0.0
    assert _positive_zero(query.lon_deg)
    assert query.refraction is True
    unrefracted = altaz_query(
        body="mars", lat=18.38, lon=77.58, elev=0.0, tt=2461285.5, targets="earth", refraction=False
    )
    assert unrefracted.body == "mars"
    with pytest.raises(InvalidParameterError, match="refraction is available for Earth"):
        altaz_query(
            body="mars",
            lat=18.38,
            lon=77.58,
            elev=0.0,
            tt=2461285.5,
            targets="earth",
            refraction=True,
        )
    with pytest.raises(InvalidParameterError, match="from itself"):
        altaz_query(
            body="earth",
            lat=0.0,
            lon=0.0,
            elev=0.0,
            tt=2461285.5,
            targets="earth",
            refraction=False,
        )
    with pytest.raises(InvalidParameterError, match="invalid target 'xyz:1'"):
        altaz_query(
            body="earth",
            lat=0.0,
            lon=0.0,
            elev=0.0,
            tt=2461285.5,
            targets="xyz:1",
            refraction=False,
        )
    with pytest.raises(InvalidParameterError, match="targets: empty item"):
        altaz_query(
            body="earth", lat=0.0, lon=0.0, elev=0.0, tt=2461285.5, targets="", refraction=False
        )
    too_many = ",".join(f"hip:{i}" for i in range(1, MAX_TARGETS + 2))
    with pytest.raises(InvalidParameterError, match=f"at most {MAX_TARGETS}"):
        altaz_query(
            body="earth",
            lat=0.0,
            lon=0.0,
            elev=0.0,
            tt=2461285.5,
            targets=too_many,
            refraction=False,
        )
