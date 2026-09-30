"""`GET /api/v1/meta` on the excerpt data and on a degraded app (D60, brief l.115-129)."""

import re
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from skyapi.catalogs.artifacts import cache_paths
from skyapi.catalogs.formats import read_skys
from skyapi.main import create_app
from support.fixtures_api import api_settings_for, assemble_data_dir, wait_ready

pytestmark = pytest.mark.api

# Brief l.120: the ten observers and their body-fixed frames.
OBSERVER_FRAMES = {
    "mercury": "IAU_MERCURY",
    "venus": "IAU_VENUS",
    "earth": "ITRS",
    "moon": "MOON_ME_DE440_ME421",
    "mars": "IAU_MARS",
    "jupiter": "IAU_JUPITER",
    "saturn": "IAU_SATURN",
    "uranus": "IAU_URANUS",
    "neptune": "IAU_NEPTUNE",
    "pluto": "IAU_PLUTO",
}
BODY_IDS = {
    "sun", "mercury", "venus", "earth", "moon", "mars",
    "jupiter", "saturn", "uranus", "neptune", "pluto",
}  # fmt: skip
SPEEDS = [1, 10, 60, 600, 3600, 86400, 604800, 2629800, 31557600]
UTC_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
# de440s runs from 1849-12-26 to 2150-01-22 (brief l.533 "1849-2150"): its segment bounds as
# TT Julian Dates; `/meta` trims a light-time margin of about one day at each end.
DE440S_START_TT = 2396752.5
DE440S_END_TT = 2506352.5
MARGIN_DAYS = 2.0
UNIX_EPOCH_JD = 2440587.5


def _ordered(pair: Any) -> bool:
    return isinstance(pair, list) and len(pair) == 2 and pair[0] < pair[1]


@pytest.fixture(scope="module")
def meta(api_client: TestClient) -> dict[str, Any]:
    response = api_client.get("/api/v1/meta")
    assert response.status_code == 200
    return response.json()


@pytest.fixture(scope="module")
def degraded_client(
    kernels_dir: Path, tmp_path_factory: pytest.TempPathFactory
) -> Iterator[TestClient]:
    """An app whose DATA_DIR lacks the OpenNGC and MPC sources (constellations only)."""
    data_dir = assemble_data_dir(
        tmp_path_factory.mktemp("meta-degraded"), kernels_dir, groups={"constellations"}
    )
    with TestClient(create_app(api_settings_for(data_dir))) as client:
        assert wait_ready(client)["status"] == "degraded"
        yield client


def test_meta_is_json_versioned_and_not_cached(api_client: TestClient) -> None:
    response = api_client.get("/api/v1/meta")

    assert response.status_code == 200
    # Brief api_contract/conventions l.105.
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["api_version"] == "1.1.0"  # 1.1.0: additive `constellation` on altaz


def test_ephemeris_and_coverage(meta: dict[str, Any]) -> None:
    ephemeris = meta["ephemeris"]
    assert ephemeris["name"] == "de440s.bsp"
    assert _ordered(ephemeris["coverage_tt"])
    start, end = ephemeris["coverage_tt"]
    # The light-time margin trims the kernel range slightly and never extends it.
    assert DE440S_START_TT <= start <= DE440S_START_TT + MARGIN_DAYS
    assert DE440S_END_TT - MARGIN_DAYS <= end <= DE440S_END_TT

    coverage = meta["coverage"]
    assert coverage["ephemeris_tt"] == ephemeris["coverage_tt"]
    assert _ordered(coverage["delta_t"]["observed_tt"])
    assert coverage["delta_t"]["observed_tt"][1] < coverage["delta_t"]["predicted_until_tt"]
    assert _ordered(coverage["iau_rotation_reliable_tt"])
    assert coverage["proper_motion_warning_years"] == 10000
    assert coverage["mpc_elements"] == {"warn_years": 2, "error_years": 50}


def test_observers(meta: dict[str, Any]) -> None:
    observers = {entry["id"]: entry for entry in meta["observers"]}
    assert set(observers) == set(OBSERVER_FRAMES)
    assert len(meta["observers"]) == 10
    start, end = meta["ephemeris"]["coverage_tt"]
    for observer_id, frame in OBSERVER_FRAMES.items():
        entry = observers[observer_id]
        assert entry["frame"] == frame
        assert entry["name_key"] == f"bodies.{observer_id}"
        assert len(entry["radii_km"]) == 3
        assert all(radius > 0 for radius in entry["radii_km"])
        assert entry["latitude_kind"] == (
            "geodetic" if observer_id == "earth" else "planetocentric"
        )
        assert _ordered(entry["coverage_tt"])
        assert start <= entry["coverage_tt"][0] < entry["coverage_tt"][1] <= end
        if observer_id == "pluto":
            assert entry["approximation_code"] == "pluto_barycenter"
        else:
            # Optional and absent, not `null`, for the exact observers.
            assert "approximation_code" not in entry


def test_bodies(meta: dict[str, Any]) -> None:
    bodies = {entry["id"]: entry for entry in meta["bodies"]}
    assert set(bodies) == BODY_IDS
    assert len(meta["bodies"]) == 11
    step_classes = set(meta["limits"]["max_step_s"])
    for body_id, entry in bodies.items():
        assert entry["name_key"] == f"bodies.{body_id}"
        assert entry["radius_km"] > 0
        assert entry["step_class"] in step_classes
    assert bodies["sun"]["kind"] == "star"
    assert bodies["moon"]["kind"] == "moon"
    assert bodies["moon"]["step_class"] == "moon"
    assert bodies["pluto"]["kind"] == "dwarf_planet"
    assert bodies["mars"]["step_class"] == "inner_planets"
    assert bodies["jupiter"]["step_class"] == "sun_and_outer"


def test_catalogs(meta: dict[str, Any], api_client: TestClient, api_data_dir: Path) -> None:
    catalogs = meta["catalogs"]
    stars = catalogs["stars"]
    table = read_skys(cache_paths(api_data_dir).stars_skys.read_bytes())
    assert stars["count"] == table.count
    assert stars["epoch_tt"] == 2451545.0
    assert re.fullmatch(r"1-[0-9a-f]{12}", stars["version"])
    assert SHA256_RE.match(stars["etag"])
    assert stars["magnitude_limit"] == pytest.approx(float(table.mag[-1]) / 1000.0)
    assert stars["license"]
    assert stars["attribution"]
    # The bare `etag` is the quoted `ETag` of `/catalogs/stars` (D59).
    header = api_client.get("/api/v1/catalogs/stars").headers["etag"]
    assert header == f'"{stars["etag"]}"'

    dso = catalogs["dso"]
    assert dso["count"] > 0
    assert SHA256_RE.match(dso["etag"])
    assert dso["license"]
    assert dso["attribution"]

    constellations = catalogs["constellations"]
    assert constellations["count"] > 0
    assert constellations["culture"] == "modern"
    assert SHA256_RE.match(constellations["etag"])
    assert constellations["license"]
    assert constellations["attribution"]

    minor = catalogs["minor_bodies"]
    assert minor["asteroids"] > 0
    assert minor["comets"] > 0
    assert _ordered(minor["elements_epoch_range_tt"])
    assert minor["license"]
    assert minor["attribution"]


def test_geocoder_and_limits(meta: dict[str, Any]) -> None:
    geocoder = meta["geocoder"]
    assert isinstance(geocoder["enabled"], bool)
    assert geocoder["url"].startswith("https://")
    # Brief l.193, l.318: the attribution carries "© OpenStreetMap contributors" verbatim.
    assert "© OpenStreetMap contributors" in geocoder["attribution"]
    # Brief l.193 (OBS-4): at least one second between two Nominatim requests.
    assert geocoder["min_interval_ms"] == 1000
    # No e-mail is configured for the test app: the optional field is absent, not `null`.
    assert "email" not in geocoder

    limits = meta["limits"]
    assert limits["max_samples"] == 64
    assert limits["max_minor_bodies"] == 100
    assert limits["max_targets"] == 200
    assert limits["speeds"] == SPEEDS
    assert limits["max_step_s"] == {
        "moon": 3600,
        "inner_planets": 21600,
        "sun_and_outer": 86400,
        "minor": 86400,
    }


def test_server_time_follows_the_clock(api_client: TestClient) -> None:
    before = time.time()
    server_time = api_client.get("/api/v1/meta").json()["server_time"]
    after = time.time()

    assert UTC_RE.match(server_time["utc"])
    # TT - UTC = 32.184 s + 37 leap seconds since 2017.
    assert 69.0 < server_time["tt_minus_utc_seconds"] < 70.0
    expected_tt = UNIX_EPOCH_JD + before / 86400.0 + server_time["tt_minus_utc_seconds"] / 86400.0
    tolerance_days = (after - before + 2.0) / 86400.0
    assert server_time["tt"] == pytest.approx(expected_tt, abs=tolerance_days)


def test_degraded_app_omits_the_missing_catalogs(degraded_client: TestClient) -> None:
    health = degraded_client.get("/api/v1/health").json()
    assert health["status"] == "degraded"
    assert health["missing"] == ["dso", "mpc"]

    response = degraded_client.get("/api/v1/meta")

    assert response.status_code == 200
    catalogs = response.json()["catalogs"]
    assert "dso" not in catalogs
    assert "minor_bodies" not in catalogs
    assert catalogs["stars"]["count"] > 0
    assert catalogs["constellations"]["count"] > 0
