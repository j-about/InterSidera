"""Star directions (brief l.138-139, D48): SKYS shader rule against Skyfield, incl. aberration."""

from pathlib import Path

import numpy as np
import pytest
from skyfield.api import load
from skyfield.jpllib import SpiceKernel
from skyfield.positionlib import SSB
from skyfield.starlib import Star

from skyapi.astro.stars import (
    UnknownStarError,
    catalog_direction,
    hipparcos_star,
    star_direction_at,
)
from skyapi.catalogs.builders import J2000_TT
from skyapi.catalogs.state import CatalogState

pytestmark = pytest.mark.unit

C_AU_PER_DAY = 173.1446  # brief l.139 / sky-math rules: first-order annual aberration
BARNARD, PROXIMA, SIRIUS = 87937, 70890, 32349


def angle_arcsec(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    cross = np.linalg.norm(np.cross(a, b), axis=-1)
    dot = np.sum(a * b, axis=-1)
    return np.degrees(np.arctan2(cross, dot)) * 3600.0


def test_catalog_direction_matches_skyfield_barycentric(catalog_state: CatalogState) -> None:
    ts = load.timescale()
    for hip in (BARNARD, PROXIMA, SIRIUS):
        star = hipparcos_star(ts, catalog_state.hipparcos, hip)
        for years in (-20.0, -5.5, 0.0, 12.25, 20.0):
            t = ts.tt_jd(J2000_TT + years * 365.25)
            reference = np.asarray(SSB.at(t).observe(star).position.au, dtype=np.float64)
            reference /= np.linalg.norm(reference)
            ours = catalog_direction(catalog_state.stars, hip, years)
            assert ours.shape == (3,)
            assert np.linalg.norm(ours) == pytest.approx(1.0, abs=1e-12)
            assert float(angle_arcsec(ours, reference)) < 0.1


def test_catalog_direction_vectorised_over_years(catalog_state: CatalogState) -> None:
    years = np.array([-20.0, 0.0, 20.0])
    directions = catalog_direction(catalog_state.stars, BARNARD, years)
    assert directions.shape == (3, 3)
    single = np.stack([catalog_direction(catalog_state.stars, BARNARD, y) for y in years])
    assert np.array_equal(directions, single)
    travelled = angle_arcsec(directions[0], directions[2])
    assert travelled == pytest.approx(40.0 * 10.36, rel=0.01)  # 40 years at 10.36"/yr


def test_unknown_star(catalog_state: CatalogState) -> None:
    with pytest.raises(UnknownStarError, match="999999"):
        catalog_direction(catalog_state.stars, 999999, 0.0)
    with pytest.raises(UnknownStarError):
        hipparcos_star(load.timescale(), catalog_state.hipparcos, 999999)
    assert issubclass(UnknownStarError, LookupError)


def test_hipparcos_star_is_scalar(catalog_state: CatalogState) -> None:
    ts = load.timescale()
    star = hipparcos_star(ts, catalog_state.hipparcos, BARNARD)
    assert isinstance(star, Star)
    assert star.ra_mas_per_year == pytest.approx(-797.84)
    assert star.dec_mas_per_year == pytest.approx(10326.93)
    assert star.parallax_mas == pytest.approx(549.01)
    assert star.epoch == pytest.approx(2448349.0625)  # J1991.25 (starlib l.99)


def test_shader_rule_with_aberration_matches_apparent(
    catalog_state: CatalogState, kernels_dir: Path
) -> None:
    """Within 1 arcsec of `earth.at(t).observe(star).apparent()` for every excerpt star (D48).

    The client rule: `dir(t) = normalize(dir + pm * years)`, then
    `normalize(dir(t) + v_earth / c)` with the Earth's barycentric velocity. Gravitational
    deflection is ignored (brief l.139); Proxima's 0.77" parallax stays inside the tolerance.
    """
    ts = load.timescale()
    eph = SpiceKernel(str(kernels_dir / "de440s.bsp"))
    earth = eph["earth"]
    table = catalog_state.stars
    hipparcos = catalog_state.hipparcos.loc[table.hip.tolist()]
    star = Star.from_dataframe(hipparcos)
    for years in (-20.0, 3.3, 20.0):
        t = ts.tt_jd(J2000_TT + years * 365.25)
        apparent = np.asarray(earth.at(t).observe(star).apparent().position.au, dtype=np.float64).T
        apparent /= np.linalg.norm(apparent, axis=1, keepdims=True)
        velocity = np.asarray(earth.at(t).velocity.au_per_d, dtype=np.float64)
        moved = table.dir.astype(np.float64) + table.pm.astype(np.float64) * years
        moved /= np.linalg.norm(moved, axis=1, keepdims=True)
        aberrated = moved + velocity / C_AU_PER_DAY
        aberrated /= np.linalg.norm(aberrated, axis=1, keepdims=True)
        residuals = angle_arcsec(aberrated, apparent)
        worst = int(np.argmax(residuals))
        assert residuals[worst] < 1.0, f"HIP {table.hip[worst]}: {residuals[worst]:.3f} arcsec"
    eph.close()


def test_star_direction_at_is_apparent(catalog_state: CatalogState, kernels_dir: Path) -> None:
    ts = load.timescale()
    eph = SpiceKernel(str(kernels_dir / "de440s.bsp"))
    earth = eph["earth"]
    t = ts.tt_jd(J2000_TT + 25.0 * 365.25)
    position = star_direction_at(ts, earth, catalog_state.hipparcos, SIRIUS, t)
    ra, dec, _ = position.radec()
    assert ra.hours == pytest.approx(6.7525, abs=0.01)
    assert dec.degrees == pytest.approx(-16.72, abs=0.05)
    reference = earth.at(t).observe(hipparcos_star(ts, catalog_state.hipparcos, SIRIUS)).apparent()
    assert np.array_equal(np.asarray(position.position.au), np.asarray(reference.position.au))
    with pytest.raises(UnknownStarError):
        star_direction_at(ts, earth, catalog_state.hipparcos, 999999, t)
    eph.close()
