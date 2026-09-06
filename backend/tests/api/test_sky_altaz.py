"""`GET /api/v1/sky/altaz` (brief l.171-172): targets, refraction, errors, headers."""

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from skyapi.main import create_app
from skyapi.middleware.problem import PROBLEM_TYPE_BASE
from support.fixtures_api import api_settings_for, wait_ready

pytestmark = pytest.mark.api

URL = "/api/v1/sky/altaz"
CERES_EPOCH_TT = 2461200.5
YEAR = 365.25
GREENWICH: dict[str, Any] = {"body": "earth", "lat": 51.48, "lon": 0.0, "elev": 0.0}


def _altaz(client: TestClient, **params: Any):
    return client.get(URL, params={**GREENWICH, "tt": CERES_EPOCH_TT, **params})


def _problem(response, status: int, slug: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert body["status"] == status
    assert body["type"] == f"{PROBLEM_TYPE_BASE}{slug}"
    assert body["instance"] == URL
    return body


@pytest.mark.parametrize("tt", [2451545.0, 2470000.5])
def test_polaris_from_greenwich(api_client: TestClient, tt: float) -> None:
    response = _altaz(api_client, tt=tt, targets="hip:11767")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "public, max-age=300"
    assert response.headers["server-timing"].startswith("compute;dur=")
    (polaris,) = response.json()
    assert polaris["id"] == "hip:11767"
    assert polaris["alt_deg"] == pytest.approx(51.48, abs=1.0)
    assert polaris["mag"] == pytest.approx(1.97, abs=0.05)
    assert set(polaris) == {
        "id",
        "alt_deg",
        "az_deg",
        "ra_icrs_deg",
        "dec_icrs_deg",
        "ra_date_deg",
        "dec_date_deg",
        "mag",
    }


def test_mixed_targets(api_client: TestClient) -> None:
    response = _altaz(api_client, targets="moon,sun,hip:32349,dso:M31,a:1,c:1P")
    assert response.status_code == 200, response.text
    rows = response.json()
    assert [row["id"] for row in rows] == ["a:1", "c:1P", "dso:M31", "hip:32349", "moon", "sun"]
    for row in rows:
        assert 0.0 <= row["az_deg"] < 360.0
        assert 0.0 <= row["ra_icrs_deg"] < 360.0
        assert 0.0 <= row["ra_date_deg"] < 360.0
        assert -90.0 <= row["dec_icrs_deg"] <= 90.0
        assert -90.0 <= row["dec_date_deg"] <= 90.0
        assert -90.0 <= row["alt_deg"] <= 90.0
    by_id = {row["id"]: row for row in rows}
    moon = by_id["moon"]
    assert 0.0024 < moon["dist_au"] < 0.0028
    assert 0.49 < moon["diam_deg"] < 0.56
    assert 0.0 <= moon["phase"] <= 1.0
    assert by_id["sun"]["mag"] < -26.0
    andromeda = by_id["dso:M31"]
    assert andromeda["mag"] == pytest.approx(3.4, abs=0.15)
    assert "dist_au" not in andromeda
    sirius = by_id["hip:32349"]
    assert sirius["mag"] == pytest.approx(-1.44, abs=0.05)
    assert "dist_au" not in sirius
    assert "phase" not in sirius
    assert "diam_deg" not in sirius
    ceres = by_id["a:1"]
    assert ceres["dist_au"] > 1.0
    assert 0.0 <= ceres["phase"] <= 1.0
    assert 6.0 < ceres["mag"] < 10.0
    assert "diam_deg" not in ceres
    assert by_id["c:1P"]["dist_au"] > 30.0


def test_refraction_changes_a_low_altitude_on_earth_only(api_client: TestClient) -> None:
    plain = _altaz(api_client, lat=5.0, targets="hip:11767").json()[0]
    refracted = _altaz(api_client, lat=5.0, targets="hip:11767", refraction=1).json()[0]
    assert 0.1 < refracted["alt_deg"] - plain["alt_deg"] < 0.5
    assert refracted["az_deg"] == plain["az_deg"]
    mars = api_client.get(
        URL,
        params={
            "body": "mars",
            "lat": 18.38,
            "lon": 77.58,
            "tt": CERES_EPOCH_TT,
            "targets": "earth",
            "refraction": 1,
        },
    )
    body = _problem(mars, 400, "invalid-parameter")
    assert "Earth observers only" in body["detail"]
    unrefracted = api_client.get(
        URL,
        params={
            "body": "mars",
            "lat": 18.38,
            "lon": 77.58,
            "tt": CERES_EPOCH_TT,
            "targets": "earth",
        },
    )
    assert unrefracted.status_code == 200, unrefracted.text
    assert unrefracted.json()[0]["id"] == "earth"


@pytest.mark.parametrize(
    ("target", "fragment"),
    [("hip:999999999", "999999999"), ("dso:NGC0", "NGC0"), ("a:999999999", "a:999999999")],
)
def test_unknown_targets_are_404(api_client: TestClient, target: str, fragment: str) -> None:
    body = _problem(_altaz(api_client, targets=target), 404, "unknown-object")
    assert body["title"] == "Unknown object"
    assert fragment in body["detail"]


def test_bad_targets_are_400(api_client: TestClient) -> None:
    too_many = ",".join(f"hip:{i}" for i in range(1, 202))
    body = _problem(_altaz(api_client, targets=too_many), 400, "invalid-parameter")
    assert "at most 200" in body["detail"]
    body = _problem(_altaz(api_client, targets="xyz:1"), 400, "invalid-parameter")
    assert "invalid target 'xyz:1'" in body["detail"]
    body = _problem(_altaz(api_client, targets="earth,moon"), 400, "invalid-parameter")
    assert "from itself" in body["detail"]
    body = _problem(_altaz(api_client, targets="moon+sun"), 400, "invalid-parameter")
    assert "separate ids with ','" in body["detail"]
    missing = api_client.get(URL, params={**GREENWICH, "tt": CERES_EPOCH_TT})
    body = _problem(missing, 400, "invalid-parameter")
    assert body["errors"][0]["loc"] == ["query", "targets"]


def test_unreliable_minor_body_is_422(api_client: TestClient) -> None:
    response = _altaz(api_client, tt=CERES_EPOCH_TT + 60 * YEAR, targets="a:1,moon")
    body = _problem(response, 422, "outside-coverage")
    assert body["range_tt"] == [CERES_EPOCH_TT - 50 * YEAR, CERES_EPOCH_TT + 50 * YEAR]
    assert "a:1" in body["detail"]


def test_instant_outside_the_ephemeris_is_422(api_client: TestClient) -> None:
    body = _problem(_altaz(api_client, tt=1000000.0, targets="moon"), 422, "outside-coverage")
    assert body["range_tt"][0] < body["range_tt"][1]


def test_openapi_documents_the_route(api_client: TestClient) -> None:
    document = api_client.get("/api/v1/openapi.json").json()
    operation = document["paths"][URL]["get"]
    assert set(operation["responses"]) >= {"200", "400", "404", "422", "429", "503", "default"}
    parameters = {parameter["name"]: parameter for parameter in operation["parameters"]}
    assert set(parameters) == {"body", "lat", "lon", "elev", "tt", "targets", "refraction"}
    assert parameters["targets"]["required"] is True
    assert all(parameter["description"] for parameter in parameters.values())


def test_altaz_is_rate_limited(api_data_dir: Path) -> None:
    settings = api_settings_for(api_data_dir, rate_limit_rps=0.01, rate_limit_burst=2)
    app = create_app(settings)
    with TestClient(app, client=("203.0.113.10", 4444)) as client:
        wait_ready(client)
        url = "/api/v1/sky/altaz?lat=51.48&lon=0&tt=2461285.5&targets=moon"
        assert client.get(url).status_code == 200
        assert client.get(url).status_code == 200
        third = client.get(url)
        assert third.status_code == 429
        assert 99 <= int(third.headers["retry-after"]) <= 100
        assert third.headers["content-type"] == "application/problem+json"
        assert third.json()["type"].endswith("problem-rate-limited")
