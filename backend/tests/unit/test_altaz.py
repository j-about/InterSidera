"""astro/altaz.py: target syntax and the `/sky/altaz` composite on the excerpt states (D58)."""

from dataclasses import replace

import pytest

from skyapi.astro.altaz import Target, TargetSyntaxError, compute_altaz, parse_target
from skyapi.astro.dso import UnknownDsoError, dso_star, resolve_dso_id
from skyapi.astro.frames import CoverageError
from skyapi.astro.minor_bodies import MinorBodyState, UnknownMinorBodyError
from skyapi.astro.queries import AltAzQuery
from skyapi.astro.stars import UnknownStarError
from skyapi.astro.state import AstroState
from skyapi.catalogs.state import CatalogState, CatalogUnavailableError
from skyapi.models.meta import MetaStatic
from skyapi.state import SkyState

pytestmark = pytest.mark.unit

CERES_EPOCH_TT = 2461200.5  # 2026-06-09.0 TT
YEAR = 365.25


@pytest.fixture(scope="module")
def sky_state(
    astro_state: AstroState, catalog_state: CatalogState, mpc_state: MinorBodyState
) -> SkyState:
    return SkyState(
        version="test",
        astro=astro_state,
        catalogs=catalog_state,
        meta=MetaStatic.model_construct(),
        minor_bodies=mpc_state,
    )


def _query(targets: tuple[str, ...], **overrides: object) -> AltAzQuery:
    fields: dict[str, object] = {
        "body": "earth",
        "lat_deg": 51.48,
        "lon_deg": 0.0,
        "elev_m": 0,
        "tt": CERES_EPOCH_TT,
        "targets": targets,
        "refraction": False,
    }
    fields.update(overrides)
    return AltAzQuery(**fields)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("hip:32349", Target("hip:32349", "hip", "32349")),
        ("hip:999999999", Target("hip:999999999", "hip", "999999999")),
        ("dso:NGC224", Target("dso:NGC224", "dso", "NGC224")),
        ("dso:M31", Target("dso:M31", "dso", "M31")),
        ("dso:IC80_NED01", Target("dso:IC80_NED01", "dso", "IC80_NED01")),
        ("moon", Target("moon", "body", "moon")),
        ("sun", Target("sun", "body", "sun")),
        ("a:1", Target("a:1", "minor", "a:1")),
        ("a:K24A00B", Target("a:K24A00B", "minor", "a:K24A00B")),
        ("c:1P", Target("c:1P", "minor", "c:1P")),
        ("c:C/2023_A3", Target("c:C/2023_A3", "minor", "c:C/2023_A3")),
    ],
)
def test_parse_target(raw: str, expected: Target) -> None:
    assert parse_target(raw) == expected


@pytest.mark.parametrize(
    "raw",
    ["", "hip:", "hip:abc", "hip:-1", "HIP:1", "dso:", "Moon", "vulcan", "x:1", "a:", "a:1 2"],
)
def test_parse_target_rejects_other_syntaxes(raw: str) -> None:
    with pytest.raises(TargetSyntaxError, match="invalid target"):
        parse_target(raw)


def test_dso_star_sits_at_the_catalog_position(catalog_state: CatalogState) -> None:
    andromeda = resolve_dso_id(catalog_state, "M31")
    star = dso_star(andromeda)
    assert float(star.ra.hours) * 15.0 == pytest.approx(andromeda.ra_deg, abs=1e-9)
    assert float(star.dec.degrees) == pytest.approx(andromeda.dec_deg, abs=1e-9)
    assert star.ra_mas_per_year == 0.0
    assert star.parallax_mas == 0.0
    assert star.epoch == 2451545.0  # J2000


def test_compute_altaz_mixed_targets(sky_state: SkyState) -> None:
    targets = ("a:1", "c:1P", "dso:M31", "hip:11767", "hip:32349", "moon", "sun")
    rows = compute_altaz(sky_state, _query(targets))
    assert [row.id for row in rows] == list(targets)
    by_id = {row.id: row for row in rows}
    for row in rows:
        assert 0.0 <= row.ra_icrs_deg < 360.0
        assert 0.0 <= row.ra_date_deg < 360.0
        assert 0.0 <= row.az_deg < 360.0
        assert -90.0 <= row.alt_deg <= 90.0
        assert -90.0 <= row.dec_icrs_deg <= 90.0
        assert -90.0 <= row.dec_date_deg <= 90.0
    polaris = by_id["hip:11767"]
    assert polaris.alt_deg == pytest.approx(51.48, abs=1.0)
    assert polaris.dist_au is None
    assert polaris.phase is None
    assert polaris.diam_deg is None
    assert polaris.mag == pytest.approx(1.97, abs=0.05)  # Hipparcos Vmag
    assert by_id["hip:32349"].mag == pytest.approx(-1.44, abs=0.05)
    andromeda = by_id["dso:M31"]
    assert andromeda.mag == pytest.approx(3.44, abs=0.1)
    entry = resolve_dso_id(sky_state.catalogs, "M31")
    assert andromeda.ra_icrs_deg == pytest.approx(entry.ra_deg, abs=0.02)  # aberration only
    assert andromeda.dec_icrs_deg == pytest.approx(entry.dec_deg, abs=0.02)
    moon = by_id["moon"]
    assert moon.dist_au is not None
    assert 0.0024 < moon.dist_au < 0.0028
    assert moon.diam_deg is not None
    assert 0.49 < moon.diam_deg < 0.56
    assert moon.phase is not None
    assert 0.0 <= moon.phase <= 1.0
    sun = by_id["sun"]
    assert sun.mag is not None
    assert sun.mag < -26.0
    assert sun.phase == 1.0
    ceres = by_id["a:1"]
    assert ceres.dist_au is not None
    assert ceres.dist_au > 1.0
    assert ceres.phase is not None
    assert 0.0 <= ceres.phase <= 1.0
    assert ceres.mag is not None
    assert 6.0 < ceres.mag < 10.0
    assert ceres.diam_deg is None
    halley = by_id["c:1P"]
    assert halley.dist_au is not None
    assert halley.dist_au > 30.0


def test_refraction_raises_a_low_target(sky_state: SkyState) -> None:
    # Polaris from latitude 5 deg N stands about 5.6 deg high: refraction adds ~0.15 deg.
    plain = compute_altaz(sky_state, _query(("hip:11767",), lat_deg=5.0))[0]
    refracted = compute_altaz(sky_state, _query(("hip:11767",), lat_deg=5.0, refraction=True))[0]
    assert 0.1 < refracted.alt_deg - plain.alt_deg < 0.5
    assert refracted.az_deg == plain.az_deg
    assert refracted.ra_icrs_deg == plain.ra_icrs_deg


def test_unreliable_minor_body_is_a_coverage_error(sky_state: SkyState) -> None:
    with pytest.raises(CoverageError, match="a:1") as info:
        compute_altaz(sky_state, _query(("a:1", "moon"), tt=CERES_EPOCH_TT + 60 * YEAR))
    assert info.value.range_tt == (CERES_EPOCH_TT - 50 * YEAR, CERES_EPOCH_TT + 50 * YEAR)


def test_unknown_targets(sky_state: SkyState) -> None:
    with pytest.raises(UnknownStarError):
        compute_altaz(sky_state, _query(("hip:999999999",)))
    with pytest.raises(UnknownDsoError):
        compute_altaz(sky_state, _query(("dso:NGC0",)))
    with pytest.raises(UnknownMinorBodyError):
        compute_altaz(sky_state, _query(("a:999999999",)))
    with pytest.raises(TargetSyntaxError):
        compute_altaz(sky_state, _query(("xyz:1",)))


def test_missing_optional_catalogs_are_unavailable(sky_state: SkyState) -> None:
    without_mpc = replace(sky_state, minor_bodies=None)
    with pytest.raises(CatalogUnavailableError, match="mpc"):
        compute_altaz(without_mpc, _query(("a:1",)))
    assert len(compute_altaz(without_mpc, _query(("moon", "hip:11767")))) == 2
    without_dso = replace(sky_state, catalogs=replace(sky_state.catalogs, dso=None))
    with pytest.raises(CatalogUnavailableError, match="dso"):
        compute_altaz(without_dso, _query(("dso:M31",)))


def test_altaz_outside_the_coverage(sky_state: SkyState) -> None:
    end = sky_state.astro.ephemeris_coverage_tt[1]
    with pytest.raises(CoverageError):
        compute_altaz(sky_state, _query(("hip:11767",), tt=end + 1.0))
    with pytest.raises(CoverageError):
        compute_altaz(sky_state, _query(("moon",), tt=end + 1.0))
