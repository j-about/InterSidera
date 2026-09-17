"""Shape and provenance of every committed fixture under `tests/fixtures/` (D37).

Each file names its `source`, `generator` and `generated_at`, stays under 1 MB, and the
Skyfield-generated frames equal a live recomputation, so a change in `skyapi.astro` that is not
followed by `scripts/generate_fixtures.py skyfield` fails here rather than in M3's vitest. The
frontend-only orientation fixture (`device_orientation_cases.json`, plan D133, written by
`scripts/generate_fixtures.py orientation` without Skyfield) is checked for provenance and size
only; its content is verified by `frontend/src/sky/math/orientation.test.ts`.
"""

import json
import re
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from skyapi.astro import bodies
from skyapi.astro.horizon import (
    equinox_of_date_quaternions,
    horizon_quaternions,
    observer_velocity_au_d,
)
from skyapi.astro.observers import build_observer
from skyapi.astro.state import AstroState
from skyapi.astro.time import make_times

pytestmark = pytest.mark.conformance

FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures"
FIXTURE_FILES = (
    "horizons_cases.json",
    "skyfield_stars.json",
    "skyfield_frames.json",
    "skyfield_refraction.json",
    "device_orientation_cases.json",
)
MAX_BYTES = 1_000_000
GENERATED_AT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
# Sampled quantities are written with 12 significant digits (`SIGNIFICANT_DIGITS`).
ROUNDING = 1e-11

HORIZONS_OBSERVERS = frozenset({"greenwich", "paris", "sydney", "quito", "tranquility", "jezero"})
HORIZONS_TARGETS = frozenset(
    {
        "sun",
        "moon",
        "mercury",
        "venus",
        "earth",
        "mars",
        "jupiter",
        "saturn",
        "uranus",
        "neptune",
        "pluto",
    }
)
HORIZONS_BARYCENTERS = frozenset({"jupiter", "saturn", "uranus", "neptune", "pluto"})
HORIZONS_CASE_KEYS = frozenset(
    {
        "observer",
        "target",
        "horizons_id",
        "tt",
        "ra_icrf_astrometric_deg",
        "dec_icrf_astrometric_deg",
        "ra_apparent_of_date_deg",
        "dec_apparent_of_date_deg",
        "az_deg",
        "el_deg",
        "apmag",
        "surface_brightness",
        "illuminated_pct",
        "ang_diam_arcsec",
        "range_au",
        "range_rate_km_s",
        "phase_angle_deg",
        "tdb_minus_ut_s",
        "pole_ra_deg",
        "pole_dec_deg",
        "ra_icrf_apparent_deg",
        "dec_icrf_apparent_deg",
    }
)


def load_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))


def test_fixture_directory_holds_exactly_the_documented_files() -> None:
    assert sorted(path.name for path in FIXTURES_DIR.glob("*.json")) == sorted(FIXTURE_FILES)


@pytest.mark.parametrize("name", FIXTURE_FILES)
def test_fixture_provenance_and_size(name: str) -> None:
    path = FIXTURES_DIR / name
    assert path.stat().st_size < MAX_BYTES
    document = load_fixture(name)
    assert document["source"]
    assert document["generator"].startswith("scripts/generate_fixtures.py ")
    assert GENERATED_AT.match(document["generated_at"])
    assert isinstance(document["parameters"], dict)


def test_horizons_cases_shape() -> None:
    document = load_fixture("horizons_cases.json")
    cases = document["cases"]
    assert len(cases) == 360 == document["case_count"]
    assert set(document["observers"]) == HORIZONS_OBSERVERS
    assert {case["observer"] for case in cases} == HORIZONS_OBSERVERS
    assert {case["target"] for case in cases} == HORIZONS_TARGETS
    epochs = [epoch["jd_tt"] for epoch in document["epochs_tt"]]
    assert len(epochs) == 6
    assert {case["tt"] for case in cases} == set(epochs)
    for case in cases:
        assert set(case) == HORIZONS_CASE_KEYS
        body = document["observers"][case["observer"]]["body"]
        assert case["target"] != body
        has_body = case["target"] not in HORIZONS_BARYCENTERS
        assert (case["apmag"] is not None) == has_body
        assert (case["ang_diam_arcsec"] is not None) == has_body
    for site_id, meta in document["observers"].items():
        targets = {case["target"] for case in cases if case["observer"] == site_id}
        expected = HORIZONS_TARGETS - {meta["body"]}
        assert targets == expected, site_id
        assert len([case for case in cases if case["observer"] == site_id]) == 60


def test_skyfield_frames_shape() -> None:
    document = load_fixture("skyfield_frames.json")
    windows = document["windows"]
    assert [w["id"] for w in windows] == [
        "greenwich_2024-04-08T18_300s",
        "tranquility_2000-01-01T12_3600s",
        "jezero_2024-04-08T00_3600s",
    ]
    assert [(w["observer"], w["step_s"], w["n"]) for w in windows] == [
        ("earth", 300, 32),
        ("moon", 3600, 8),
        ("mars", 3600, 8),
    ]
    for window in windows:
        n = window["n"]
        assert len(window["tt"]) == n
        assert window["tt"] == [window["tt0"] + i * window["step_s"] / 86400.0 for i in range(n)]
        for key in ("horizon_q", "equinox_q"):
            q = np.asarray(window[key], dtype=np.float64)
            assert q.shape == (n, 4)
            assert np.allclose(np.linalg.norm(q, axis=1), 1.0, atol=ROUNDING)
            assert np.all(np.sum(q[1:] * q[:-1], axis=1) > 0.0)  # sign-continuous
        for key in ("observer_velocity_au_d", "sun_dir"):
            assert np.asarray(window[key]).shape == (n, 3)
        assert np.allclose(np.linalg.norm(window["sun_dir"], axis=1), 1.0, atol=ROUNDING)
        expected_bodies = set(bodies.BODY_IDS) - {window["observer"]}
        assert set(window["bodies"]) == expected_bodies
        for sample in window["bodies"].values():
            direction = np.asarray(sample["dir"], dtype=np.float64)
            assert direction.shape == (n, 3)
            assert np.allclose(np.linalg.norm(direction, axis=1), 1.0, atol=ROUNDING)
            for key in ("dist_au", "mag", "phase", "diam_deg"):
                values = np.asarray(sample[key], dtype=np.float64)
                assert values.shape == (n,)
                assert np.all(np.isfinite(values))
            phase = np.asarray(sample["phase"], dtype=np.float64)
            assert np.all((phase >= 0.0) & (phase <= 1.0))


def test_skyfield_frames_match_a_live_recomputation(astro_state: AstroState) -> None:
    """The committed windows equal `skyapi.astro` on the test kernels to the 12-digit rounding."""
    document = load_fixture("skyfield_frames.json")
    for window in document["windows"]:
        site = window["site"]
        observer = build_observer(
            astro_state, window["observer"], site["lat_deg"], site["lon_deg"], site["elev_m"]
        )
        assert observer.spec.frame_name == site["frame_name"]
        assert observer.spec.latitude_kind == site["latitude_kind"]
        t = make_times(astro_state.ts, window["tt0"], window["step_s"], window["n"])
        assert np.array_equal(np.asarray(t.tt), np.asarray(window["tt"]))
        np.testing.assert_allclose(
            horizon_quaternions(observer, t), window["horizon_q"], rtol=0.0, atol=ROUNDING
        )
        np.testing.assert_allclose(
            equinox_of_date_quaternions(t), window["equinox_q"], rtol=0.0, atol=ROUNDING
        )
        np.testing.assert_allclose(
            observer_velocity_au_d(observer, t),
            window["observer_velocity_au_d"],
            rtol=ROUNDING,
            atol=0.0,
        )
        np.testing.assert_allclose(
            bodies.sun_direction(astro_state, observer, t),
            window["sun_dir"],
            rtol=0.0,
            atol=ROUNDING,
        )
        samples = bodies.body_samples(astro_state, observer, t, list(window["bodies"]))
        for body_id, expected in window["bodies"].items():
            sample = samples[body_id]
            np.testing.assert_allclose(sample.dir, expected["dir"], rtol=0.0, atol=ROUNDING)
            np.testing.assert_allclose(sample.dist_au, expected["dist_au"], rtol=ROUNDING, atol=0.0)
            np.testing.assert_allclose(sample.mag, expected["mag"], rtol=ROUNDING, atol=ROUNDING)
            np.testing.assert_allclose(sample.phase, expected["phase"], rtol=0.0, atol=ROUNDING)
            np.testing.assert_allclose(
                sample.diam_deg, expected["diam_deg"], rtol=ROUNDING, atol=0.0
            )


def test_skyfield_stars_shape() -> None:
    document = load_fixture("skyfield_stars.json")
    assert len(document["stars"]) == 7
    for star in document["stars"]:
        assert set(star) == {"hip", "name", "catalog", "skys", "samples"}
        assert set(star["skys"]) == {"dir", "pm", "mag_millimag", "bv_millimag"}
        assert len(star["skys"]["dir"]) == 3
        assert len(star["skys"]["pm"]) == 3
        assert [s["calendar_tt"] for s in star["samples"]] == document["parameters"]["epochs_tt"]
        for sample in star["samples"]:
            assert len(sample["earth_velocity_au_d"]) == 3
            speed = float(np.linalg.norm(sample["earth_velocity_au_d"]))
            assert 0.0165 < speed < 0.0180  # about 29.8 km/s


def test_skyfield_refraction_shape() -> None:
    document = load_fixture("skyfield_refraction.json")
    assert [t["elevation_m"] for t in document["tables"]] == [0.0, 2850.0]
    for table in document["tables"]:
        rows = np.asarray(table["rows"], dtype=np.float64)
        assert rows.shape == (183, 2)
        assert rows[0, 0] == -1.0
        assert rows[-1, 0] == 90.0
        assert np.allclose(np.diff(rows[:, 0]), 0.5)
        assert np.all(np.diff(rows[:, 1]) > 0.0)  # apparent altitude is monotonic in true altitude
