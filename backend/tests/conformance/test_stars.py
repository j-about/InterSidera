"""SKYS parity with `skyfield_stars.json` and the refraction reference (brief l.138-139, D48).

The fixture holds Skyfield's own directions for the seven parity stars at six epochs from 1900
to 2140; the excerpt-built catalog (`catalog_state`) carries the same seven stars. Measured on
2026-09-03: barycentric residual max 0.007" (the rule is exact for Skyfield's linear model, the
remainder is float32 storage); apparent residual max 0.66" (Proxima Centauri), 0.53" (Barnard's
Star), 0.38" (Sirius), 0.13" (Vega) and <= 0.005" for the other three: the shader rule ignores
parallax by design (brief l.135), so each residual is bounded by the star's parallax.
"""

import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from skyapi.astro.refraction import refraction_table, standard_pressure_mbar
from skyapi.astro.stars import catalog_direction
from skyapi.catalogs.builders import J2000_TT, JULIAN_YEAR_DAYS
from skyapi.catalogs.state import CatalogState

pytestmark = pytest.mark.conformance

FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures"
C_AU_PER_DAY = 173.1446  # brief l.139: first-order annual aberration in the shader
BARYCENTRIC_TOLERANCE_ARCSEC = 0.1
APPARENT_TOLERANCE_ARCSEC = 1.0
PARITY_HIPS = (11767, 32349, 27989, 87937, 70890, 91262, 65474)


def separation_arcsec(u: np.ndarray, v: np.ndarray) -> float:
    cross = float(np.linalg.norm(np.cross(u, v)))
    dot = float(np.dot(u, v))
    return math.degrees(math.atan2(cross, dot)) * 3600.0


def normalized(v: np.ndarray) -> np.ndarray:
    return v / np.linalg.norm(v)


@pytest.fixture(scope="module")
def stars_fixture() -> dict[str, Any]:
    return json.loads((FIXTURES_DIR / "skyfield_stars.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def refraction_fixture() -> dict[str, Any]:
    return json.loads((FIXTURES_DIR / "skyfield_refraction.json").read_text(encoding="utf-8"))


def test_fixture_covers_the_parity_stars_and_epochs(stars_fixture: dict[str, Any]) -> None:
    assert tuple(star["hip"] for star in stars_fixture["stars"]) == PARITY_HIPS
    assert stars_fixture["parameters"]["skys_epoch_tt"] == J2000_TT
    for star in stars_fixture["stars"]:
        assert len(star["samples"]) == 6
        for sample in star["samples"]:
            assert sample["years_since_epoch"] == pytest.approx(
                (sample["tt"] - J2000_TT) / JULIAN_YEAR_DAYS
            )
            for key in ("barycentric_dir", "apparent_dir"):
                assert np.linalg.norm(sample[key]) == pytest.approx(1.0, abs=1e-11)


def test_catalog_rows_equal_the_excerpt_rows(
    stars_fixture: dict[str, Any], catalog_state: CatalogState
) -> None:
    """The full `hip_main.dat` and the excerpt carry the same bytes for these stars."""
    for star in stars_fixture["stars"]:
        row = catalog_state.hipparcos.loc[star["hip"]]
        for column, value in star["catalog"].items():
            assert float(row[column]) == value, (star["hip"], column)


def test_skys_rows_equal_the_excerpt_build(
    stars_fixture: dict[str, Any], catalog_state: CatalogState
) -> None:
    """`skys.dir`/`skys.pm` (float32 written through 12 significant digits, an exact round
    trip) equal the rows the builder produced from the excerpt (D48: the rule is per star)."""
    table = catalog_state.stars
    for star in stars_fixture["stars"]:
        index = int(np.flatnonzero(table.hip == np.uint32(star["hip"]))[0])
        assert np.array_equal(table.dir[index], np.asarray(star["skys"]["dir"], dtype=np.float32))
        assert np.array_equal(table.pm[index], np.asarray(star["skys"]["pm"], dtype=np.float32))
        assert int(table.mag[index]) == star["skys"]["mag_millimag"]
        assert int(table.bv[index]) == star["skys"]["bv_millimag"]


def test_shader_rule_within_0_1_arcsec_of_barycentric(
    stars_fixture: dict[str, Any], catalog_state: CatalogState
) -> None:
    worst = 0.0
    for star in stars_fixture["stars"]:
        for sample in star["samples"]:
            ours = catalog_direction(catalog_state.stars, star["hip"], sample["years_since_epoch"])
            residual = separation_arcsec(ours, np.asarray(sample["barycentric_dir"]))
            worst = max(worst, residual)
            assert residual < BARYCENTRIC_TOLERANCE_ARCSEC, (star["name"], sample["calendar_tt"])
    print(f"\nSKYS rule vs barycentric: max {worst:.4f} arcsec")


def test_shader_rule_with_aberration_within_1_arcsec_of_apparent(
    stars_fixture: dict[str, Any], catalog_state: CatalogState
) -> None:
    """`normalize(dir(t) + v_earth / c)` against `earth.at(t).observe(star).apparent()`:
    gravitational deflection and parallax are ignored by design (brief l.139)."""
    print("\nSKYS rule + aberration vs apparent (arcsec, max over epochs)")
    for star in stars_fixture["stars"]:
        worst = 0.0
        for sample in star["samples"]:
            moved = catalog_direction(catalog_state.stars, star["hip"], sample["years_since_epoch"])
            velocity = np.asarray(sample["earth_velocity_au_d"], dtype=np.float64)
            aberrated = normalized(moved + velocity / C_AU_PER_DAY)
            residual = separation_arcsec(aberrated, np.asarray(sample["apparent_dir"]))
            worst = max(worst, residual)
            assert residual < APPARENT_TOLERANCE_ARCSEC, (star["name"], sample["calendar_tt"])
        print(f"  HIP {star['hip']:<6} {star['name']:<17} {worst:.3f}")


def test_refraction_fixture_equals_the_reference_table(
    refraction_fixture: dict[str, Any],
) -> None:
    grid = refraction_fixture["parameters"]["alt_true_deg"]
    count = round((grid["stop"] - grid["start"]) / grid["step"]) + 1
    alts = [grid["start"] + i * grid["step"] for i in range(count)]
    assert len(alts) == 183
    assert alts[0] == -1.0
    assert alts[-1] == 90.0
    assert [t["elevation_m"] for t in refraction_fixture["tables"]] == [0.0, 2850.0]
    for table in refraction_fixture["tables"]:
        elevation = float(table["elevation_m"])
        assert table["temperature_c"] == 10.0
        assert table["pressure_mbar"] == standard_pressure_mbar(elevation)
        expected = [[a, b] for a, b in refraction_table(alts, elevation)]
        assert table["rows"] == expected
        apparent = np.asarray([row[1] for row in table["rows"]])
        assert np.all(apparent >= np.asarray(alts))  # refraction lifts, never lowers
        assert apparent[-1] == 90.0  # zero above 89.9 deg
