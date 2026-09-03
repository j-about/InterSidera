"""observers.py: radii, `eph[key] + topos` for every observer id, coverage, warnings (D44)."""

import dataclasses

import numpy as np
import pytest
from skyfield.planetarylib import PlanetTopos
from skyfield.timelib import Timescale
from skyfield.toposlib import GeographicPosition

from skyapi.astro.frames import IAU_FRAME_CENTERS, CoverageError
from skyapi.astro.observers import (
    OBSERVER_IDS,
    Observer,
    ObserverUnavailableError,
    UnknownObserverError,
    build_observer,
    ensure_coverage,
    observer_coverage,
    observer_warnings,
    planetocentric_radius_km,
)
from skyapi.astro.state import AstroState

pytestmark = pytest.mark.unit

MARS_RADII = (3396.19, 3396.19, 3376.20)
JUPITER_RADII = (71492.0, 71492.0, 66854.0)


def test_planetocentric_radius_on_a_sphere_is_constant() -> None:
    for lat, lon in ((0.0, 0.0), (45.0, 90.0), (-90.0, 10.0), (89.9, -170.0)):
        assert np.isclose(planetocentric_radius_km((1737.4, 1737.4, 1737.4), lat, lon), 1737.4)


def test_planetocentric_radius_on_oblate_bodies() -> None:
    assert np.isclose(planetocentric_radius_km(MARS_RADII, 0.0, 77.58), 3396.19)
    assert np.isclose(planetocentric_radius_km(MARS_RADII, 90.0, 0.0), 3376.20)
    mid = planetocentric_radius_km(MARS_RADII, 45.0, 0.0)
    assert 3376.20 < mid < 3396.19
    assert np.isclose(mid, planetocentric_radius_km(MARS_RADII, 45.0, 123.0))  # a = b: no lon term
    assert np.isclose(planetocentric_radius_km(JUPITER_RADII, 90.0, 0.0), 66854.0)
    assert np.isclose(planetocentric_radius_km(JUPITER_RADII, 0.0, 0.0), 71492.0)
    triaxial = (3.0, 2.0, 1.0)
    assert np.isclose(planetocentric_radius_km(triaxial, 0.0, 0.0), 3.0)
    assert np.isclose(planetocentric_radius_km(triaxial, 0.0, 90.0), 2.0)
    assert np.isclose(planetocentric_radius_km(triaxial, 90.0, 0.0), 1.0)


def test_observer_specs_carry_pck_radii(astro_state: AstroState) -> None:
    assert tuple(astro_state.observers) == OBSERVER_IDS
    assert "sun" not in astro_state.observers
    assert astro_state.observers["mars"].radii_km == MARS_RADII
    assert astro_state.observers["moon"].radii_km == (1737.4, 1737.4, 1737.4)
    assert astro_state.observers["earth"].latitude_kind == "geodetic"
    assert astro_state.observers["jupiter"].latitude_kind == "planetocentric"
    assert astro_state.observers["pluto"].approximation_code == "pluto_barycenter"
    assert astro_state.observers["mars"].approximation_code is None
    assert astro_state.observers["mars"].name_key == "bodies.mars"


@pytest.mark.parametrize("observer_id", OBSERVER_IDS)
def test_build_observer_sums_type_check_for_every_id(
    astro_state: AstroState, observer_id: str, ts: Timescale
) -> None:
    observer = build_observer(astro_state, observer_id, 12.5, -45.25, 120.0)
    assert observer.spec.id == observer_id
    assert observer.vector.center == 0  # a barycentric VectorSum: `eph[key] + topos` succeeded
    assert observer.vector.target is observer.topos
    if observer_id == "earth":
        assert isinstance(observer.topos, GeographicPosition)
        assert observer.topos.center == 399
    else:
        assert isinstance(observer.topos, PlanetTopos)
        expected_center = 301 if observer_id == "moon" else IAU_FRAME_CENTERS[observer_id]
        assert observer.topos.center == expected_center
        # The topos alone is the body-centred observer vector: its length is the surface radius.
        body_centred = observer.topos.at(ts.tt_jd(2460000.5))
        distance_km = float(np.linalg.norm(np.asarray(body_centred.xyz.km)))
        radius = planetocentric_radius_km(observer.spec.radii_km, 12.5, -45.25) + 0.12
        assert np.isclose(distance_km, radius, atol=1e-6)
    position = observer.vector.at(ts.tt_jd(2460000.5))
    assert np.all(np.isfinite(np.asarray(position.xyz.au)))
    assert observer.coverage_tt == observer_coverage(astro_state, observer_id)


def test_observer_coverage(astro_state: AstroState) -> None:
    assert observer_coverage(astro_state, "earth") == astro_state.ephemeris_coverage_tt
    assert observer_coverage(astro_state, "mars") == astro_state.ephemeris_coverage_tt
    assert astro_state.moon_coverage_tt is not None
    start, end = observer_coverage(astro_state, "moon")
    assert start == max(astro_state.ephemeris_coverage_tt[0], astro_state.moon_coverage_tt[0])
    assert end == min(astro_state.ephemeris_coverage_tt[1], astro_state.moon_coverage_tt[1])


def test_the_sun_and_unknown_ids_are_rejected(astro_state: AstroState) -> None:
    with pytest.raises(UnknownObserverError, match="'sun'"):
        build_observer(astro_state, "sun", 0.0, 0.0)
    with pytest.raises(ValueError, match="vulcan"):
        observer_coverage(astro_state, "vulcan")
    with pytest.raises(ValueError, match="latitude"):
        build_observer(astro_state, "earth", 91.0, 0.0)


def test_moon_observer_needs_the_moon_kernels(astro_state: AstroState) -> None:
    without_moon = dataclasses.replace(astro_state, moon_frame=None, moon_coverage_tt=None)
    with pytest.raises(ObserverUnavailableError):
        build_observer(without_moon, "moon", 0.0, 0.0)
    with pytest.raises(ObserverUnavailableError):
        observer_coverage(without_moon, "moon")
    build_observer(without_moon, "mars", 0.0, 0.0)  # everything else keeps working


def test_ensure_coverage(greenwich: Observer, ts: Timescale) -> None:
    start, end = greenwich.coverage_tt
    ensure_coverage(greenwich, ts.tt_jd(np.array([start, end])))
    with pytest.raises(CoverageError) as excinfo:
        ensure_coverage(greenwich, ts.tt_jd(np.array([start + 1.0, end + 1e-3])))
    assert excinfo.value.range_tt == greenwich.coverage_tt


def test_observer_warnings(astro_state: AstroState, ts: Timescale) -> None:
    inside = ts.tt(2000, 1, 1)
    outside = ts.tt(1700, 1, 1)
    assert observer_warnings(astro_state.observers["earth"], outside) == []
    assert observer_warnings(astro_state.observers["moon"], outside) == []
    assert observer_warnings(astro_state.observers["mars"], inside) == []
    (mars_warning,) = observer_warnings(astro_state.observers["mars"], outside)
    assert mars_warning.code == "iau_rotation_approximate"
    assert mars_warning.range_tt is not None
    codes = [w.code for w in observer_warnings(astro_state.observers["pluto"], inside)]
    assert codes == ["pluto_barycenter"]
    codes = [w.code for w in observer_warnings(astro_state.observers["pluto"], outside)]
    assert codes == ["iau_rotation_approximate", "pluto_barycenter"]
