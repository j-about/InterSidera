"""astro/frame.py: the `/sky/frame` composite on the excerpt-built states (D56)."""

from dataclasses import replace

import numpy as np
import pytest

from skyapi.astro.bodies import BODY_IDS
from skyapi.astro.frame import compute_frame
from skyapi.astro.frames import CoverageError
from skyapi.astro.minor_bodies import MinorBodyState, UnknownMinorBodyError
from skyapi.astro.observers import UnknownObserverError
from skyapi.astro.queries import FrameQuery
from skyapi.astro.state import AstroState
from skyapi.catalogs.state import CatalogState, CatalogUnavailableError
from skyapi.models.meta import MetaStatic
from skyapi.state import SkyState

pytestmark = pytest.mark.unit

TT0 = 2460000.5  # 2023-02-25T00:00:00 TT
CERES_EPOCH_TT = 2461200.5
YEAR = 365.25
ALL_BUT_EARTH = tuple(sorted(body for body in BODY_IDS if body != "earth"))


@pytest.fixture(scope="module")
def sky_state(
    astro_state: AstroState, catalog_state: CatalogState, mpc_state: MinorBodyState
) -> SkyState:
    # `meta` is never read by the composites; `model_construct` skips validation on purpose.
    return SkyState(
        version="test",
        astro=astro_state,
        catalogs=catalog_state,
        meta=MetaStatic.model_construct(),
        minor_bodies=mpc_state,
    )


def _query(**overrides: object) -> FrameQuery:
    fields: dict[str, object] = {
        "body": "earth",
        "lat_deg": 51.48,
        "lon_deg": 0.0,
        "elev_m": 0,
        "tt0": TT0,
        "step_s": 60,
        "n": 8,
        "bodies": ALL_BUT_EARTH,
        "minor": (),
    }
    fields.update(overrides)
    return FrameQuery(**fields)  # type: ignore[arg-type]


def test_frame_from_greenwich(sky_state: SkyState) -> None:
    query = _query(minor=("a:1", "c:1P"))
    result = compute_frame(sky_state, query)
    n = query.n
    assert result.horizon_q.shape == result.equinox_q.shape == (n, 4)
    assert np.allclose(np.linalg.norm(result.horizon_q, axis=1), 1.0, atol=1e-12)
    assert np.all(np.sum(result.horizon_q[1:] * result.horizon_q[:-1], axis=1) > 0.0)
    assert result.observer_velocity_au_d.shape == result.sun_dir.shape == (n, 3)
    assert np.allclose(np.linalg.norm(result.sun_dir, axis=1), 1.0, atol=1e-12)
    speed = np.linalg.norm(result.observer_velocity_au_d, axis=1)
    assert np.all((speed > 0.0165) & (speed < 0.0180))
    assert [body.id for body in result.bodies] == list(ALL_BUT_EARTH)
    for body in result.bodies:
        assert body.kind == sky_state.astro.bodies[body.id].kind
        assert body.samples.dir.shape == (n, 3)
        assert body.warnings == []
    assert list(result.minor) == ["a:1", "c:1P"]
    ceres = result.minor["a:1"]
    assert ceres.samples is not None
    assert ceres.samples.dir.shape == (n, 3)
    assert ceres.name == "Ceres"
    assert result.lst_hours is not None
    assert result.lst_hours.shape == (n,)
    assert np.all((result.lst_hours >= 0.0) & (result.lst_hours < 24.0))
    assert result.tt_minus_utc_seconds == pytest.approx(69.18, abs=0.1)
    # 2023-02-25T00:00:00 TT is 69.18 s before midnight UTC.
    assert result.utc0 == "2023-02-24T23:58:51Z"
    assert result.time_warnings == []
    assert result.observer_warnings == []
    assert result.observer.spec.id == "earth"
    assert (result.tt0, result.step_s, result.n) == (TT0, 60, n)


def test_frame_off_earth_has_no_lst_and_carries_observer_warnings(sky_state: SkyState) -> None:
    mars = compute_frame(
        sky_state,
        _query(
            body="mars",
            lat_deg=18.38,
            lon_deg=77.58,
            bodies=tuple(sorted(body for body in BODY_IDS if body != "mars")),
        ),
    )
    assert mars.lst_hours is None
    assert mars.observer_warnings == []
    assert "earth" in [body.id for body in mars.bodies]
    pluto = compute_frame(
        sky_state,
        _query(
            body="pluto",
            lat_deg=0.0,
            lon_deg=0.0,
            n=1,
            bodies=("sun",),
        ),
    )
    assert pluto.lst_hours is None
    assert [warning.code for warning in pluto.observer_warnings] == ["pluto_barycenter"]
    assert pluto.observer.spec.latitude_kind == "planetocentric"


def test_frame_time_warnings_and_delta_t(sky_state: SkyState) -> None:
    future = compute_frame(sky_state, _query(tt0=2488069.5, n=1, bodies=("sun",)))  # 2100-01-01
    assert "delta_t_approximate" in [warning.code for warning in future.time_warnings]
    past = compute_frame(sky_state, _query(tt0=2430000.5, n=1, bodies=("sun",)))  # 1941
    # Before 1972 the value is delta T = TT - UT1 (about 25 s in 1941).
    assert 20.0 < past.tt_minus_utc_seconds < 30.0
    assert past.utc0.startswith("1941-")


def test_frame_unreliable_minor_body_keeps_its_entry(sky_state: SkyState) -> None:
    result = compute_frame(
        sky_state,
        _query(tt0=CERES_EPOCH_TT + 60 * YEAR, n=2, bodies=("sun",), minor=("a:1", "a:4")),
    )
    assert list(result.minor) == ["a:1", "a:4"]
    for entry in result.minor.values():
        assert entry.samples is None
        assert [warning.code for warning in entry.warnings] == [
            "mpc_extrapolation",
            "mpc_unreliable",
        ]
        assert entry.extrapolation_years == pytest.approx(60.0, abs=0.01)


def test_frame_errors(sky_state: SkyState) -> None:
    with pytest.raises(UnknownObserverError):
        compute_frame(sky_state, _query(body="sun"))
    with pytest.raises(UnknownMinorBodyError):
        compute_frame(sky_state, _query(n=1, bodies=("sun",), minor=("a:999999999",)))
    end = sky_state.astro.ephemeris_coverage_tt[1]
    with pytest.raises(CoverageError) as info:
        compute_frame(sky_state, _query(tt0=end - 0.01, step_s=86400, n=2, bodies=("sun",)))
    assert info.value.range_tt == sky_state.astro.ephemeris_coverage_tt
    degraded = replace(sky_state, minor_bodies=None)
    with pytest.raises(CatalogUnavailableError):
        compute_frame(degraded, _query(n=1, bodies=("sun",), minor=("a:1",)))
    # Without minor bodies the degraded state serves frames normally.
    assert compute_frame(degraded, _query(n=1, bodies=("sun",))).minor == {}
