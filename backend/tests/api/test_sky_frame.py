"""`GET /api/v1/sky/frame` (brief l.157-169): shapes, canonical echo, clamps, errors, caching."""

import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from skyapi.astro.bodies import BODY_IDS
from skyapi.main import create_app
from skyapi.middleware.problem import PROBLEM_TYPE_BASE
from support.fixtures_api import api_settings_for, wait_ready

pytestmark = pytest.mark.api

URL = "/api/v1/sky/frame"
TT0 = 2460000.5  # 2023-02-25T00:00:00 TT
CERES_EPOCH_TT = 2461200.5  # elements epoch of (1) Ceres in the excerpt (2026-06-09)
YEAR = 365.25
GREENWICH: dict[str, Any] = {"body": "earth", "lat": 51.48, "lon": 0.0, "elev": 0.0, "tt": TT0}


def _frame(client: TestClient, **params: Any):
    return client.get(URL, params={**GREENWICH, **params})


def _problem(response, status: int, slug: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert body["status"] == status
    assert body["type"] == f"{PROBLEM_TYPE_BASE}{slug}"
    assert body["instance"] == URL
    return body


def test_frame_shape_and_headers(api_client: TestClient) -> None:
    response = _frame(api_client, n=8)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["cache-control"] == "public, max-age=300"
    assert response.headers["server-timing"].startswith("compute;dur=")
    body = response.json()
    n = 8
    for key in ("horizon", "equinox_of_date"):
        q = np.asarray(body[key]["q"], dtype=np.float64)
        assert q.shape == (n, 4)
        assert np.allclose(np.linalg.norm(q, axis=1), 1.0, atol=1e-8)
        assert np.all(np.sum(q[1:] * q[:-1], axis=1) > 0.0)  # sign-continuous
    velocity = np.asarray(body["observer_velocity_au_d"], dtype=np.float64)
    assert velocity.shape == (n, 3)
    assert np.all(np.linalg.norm(velocity, axis=1) < 0.02)
    sun_dir = np.asarray(body["sun_dir"], dtype=np.float64)
    assert sun_dir.shape == (n, 3)
    assert np.allclose(np.linalg.norm(sun_dir, axis=1), 1.0, atol=1e-8)
    bodies = body["bodies"]
    assert {entry["id"] for entry in bodies} == set(BODY_IDS) - {"earth"}
    assert [entry["id"] for entry in bodies] == sorted(entry["id"] for entry in bodies)
    for entry in bodies:
        samples = entry["samples"]
        assert len(samples["dir"]) == n
        assert all(len(direction) == 3 for direction in samples["dir"])
        for name in ("dist_au", "mag", "phase", "diam_deg"):
            assert len(samples[name]) == n, (entry["id"], name)
        assert all(isinstance(value, float) for value in samples["mag"])
        assert entry["warnings"] == []
        assert entry["kind"] in {"star", "planet", "dwarf_planet", "moon"}
    assert body["minor"] == []
    time = body["time"]
    assert time["tt0"] == TT0
    assert time["step_s"] == 60
    assert time["n"] == n
    assert time["utc0"] == "2023-02-24T23:58:51Z"
    assert time["tt_minus_utc_seconds"] == pytest.approx(69.18, abs=0.1)
    assert len(time["lst_hours"]) == n
    assert all(0.0 <= value < 24.0 for value in time["lst_hours"])
    assert time["warnings"] == []
    observer = body["observer"]
    assert observer == {
        "body": "earth",
        "lat_deg": 51.48,
        "lon_deg": 0.0,
        "elev_m": 0.0,
        "latitude_kind": "geodetic",
        "warnings": [],
    }


def test_observer_echoes_canonical_values(api_client: TestClient) -> None:
    response = _frame(api_client, lat=-0.0000001, lon=190.0, elev=35.4, n=1, bodies="sun")
    assert response.status_code == 200, response.text
    observer = response.json()["observer"]
    assert observer["lon_deg"] == -170.0
    assert observer["lat_deg"] == 0.0
    assert math.copysign(1.0, observer["lat_deg"]) > 0.0
    assert '"lat_deg":0.0' in response.text
    assert "-0.0" not in response.text.split('"time"')[0]
    assert observer["elev_m"] == 35.0
    rounded = _frame(api_client, lat=48.85660049, lon=2.35220049, n=1, bodies="sun").json()
    assert rounded["observer"]["lat_deg"] == 48.8566
    assert rounded["observer"]["lon_deg"] == 2.3522


def test_step_is_clamped_to_the_requested_bodies_and_echoed(api_client: TestClient) -> None:
    moon = _frame(api_client, step_s=999999, n=2, bodies="moon").json()
    assert moon["time"]["step_s"] == 3600
    assert [entry["id"] for entry in moon["bodies"]] == ["moon"]
    outer = _frame(api_client, step_s=999999, n=2, bodies="sun,jupiter").json()
    assert outer["time"]["step_s"] == 86400
    assert [entry["id"] for entry in outer["bodies"]] == ["jupiter", "sun"]
    minor = _frame(api_client, step_s=999999, n=2, bodies="sun", minor="a:1").json()
    assert minor["time"]["step_s"] == 86400


@pytest.mark.parametrize(
    ("bodies", "fragment"),
    [
        ("earth", "from itself"),
        ("all,moon", "cannot be combined"),
        ("", "empty item"),
        ("mars+venus", "separate ids with ','"),
        ("mars venus", "separate ids with ','"),
        ("sun,vulcan", "unknown body ids: vulcan"),
    ],
)
def test_bad_body_lists_are_400(api_client: TestClient, bodies: str, fragment: str) -> None:
    body = _problem(_frame(api_client, bodies=bodies), 400, "invalid-parameter")
    assert body["title"] == "Invalid parameter"
    assert fragment in body["detail"]


def test_unknown_observer_is_400(api_client: TestClient) -> None:
    body = _problem(_frame(api_client, body="sun"), 400, "invalid-parameter")
    assert "unknown observer" in body["detail"]


def test_window_outside_the_ephemeris_is_422(api_client: TestClient) -> None:
    body = _problem(_frame(api_client, tt=1000000.0), 422, "outside-coverage")
    assert body["title"] == "Outside data coverage"
    start, end = body["range_tt"]
    assert start < end
    assert start < TT0 < end  # de440s: 1849..2150
    # A window that starts inside but ends outside is refused as a whole.
    edge = _frame(api_client, tt=end - 0.5, step_s=86400, n=2, bodies="sun")
    assert _problem(edge, 422, "outside-coverage")["range_tt"] == [start, end]


def test_the_advertised_bound_is_served_and_one_grid_step_beyond_is_422(
    api_client: TestClient,
) -> None:
    """B-52 (plan D161): `/meta` advertises bounds on the 1e-8 day grid the API rounds `tt` to,
    so a snapshot at the bound itself answers 200 and the next grid step outward answers 422."""
    coverage = api_client.get("/api/v1/meta").json()["coverage"]["ephemeris_tt"]
    start, end = coverage
    assert round(start, 8) == start
    assert round(end, 8) == end
    for bound, step in ((end, 1e-8), (start, -1e-8)):
        served = _frame(api_client, tt=bound, n=1, bodies="sun")
        assert served.status_code == 200, served.text
        assert served.json()["time"]["tt0"] == bound
        beyond = round(bound + step, 8)
        assert beyond != bound
        refused = _problem(
            _frame(api_client, tt=beyond, n=1, bodies="sun"), 422, "outside-coverage"
        )
        assert refused["range_tt"] == coverage
    # The `tt` canonicalization (1e-8 day) is what makes the bound requestable: a request a
    # hair inside the bound rounds onto it, never across it.
    hair = _frame(api_client, tt=end - 4e-9, n=1, bodies="sun")
    assert hair.status_code == 200, hair.text
    assert hair.json()["time"]["tt0"] == end


def test_time_warnings_at_2100(api_client: TestClient) -> None:
    body = _frame(api_client, tt=2488069.5, n=1, bodies="sun").json()
    warnings = {warning["code"]: warning for warning in body["time"]["warnings"]}
    assert "delta_t_approximate" in warnings
    assert len(warnings["delta_t_approximate"]["range_tt"]) == 2
    assert "params" not in warnings["delta_t_approximate"]


def test_minor_bodies_extrapolation_and_unreliable(api_client: TestClient) -> None:
    ten_years = _frame(api_client, tt=CERES_EPOCH_TT + 10 * YEAR, n=2, bodies="sun", minor="a:1")
    assert ten_years.status_code == 200, ten_years.text
    (ceres,) = ten_years.json()["minor"]
    assert ceres["id"] == "a:1"
    assert ceres["name"] == "Ceres"
    assert ceres["kind"] == "asteroid"
    assert ceres["elements_epoch_tt"] == CERES_EPOCH_TT
    assert ceres["extrapolation_years"] == pytest.approx(10.0, abs=0.01)
    assert len(ceres["samples"]["dir"]) == 2
    assert [warning["code"] for warning in ceres["warnings"]] == ["mpc_extrapolation"]
    assert ceres["warnings"][0]["params"]["years"] == pytest.approx(10.0, abs=0.01)
    assert ceres["warnings"][0]["range_tt"] == [
        CERES_EPOCH_TT - 2 * YEAR,
        CERES_EPOCH_TT + 2 * YEAR,
    ]

    sixty_years = _frame(api_client, tt=CERES_EPOCH_TT + 60 * YEAR, n=2, bodies="sun", minor="a:1")
    assert sixty_years.status_code == 200, sixty_years.text
    assert '"samples":null' in sixty_years.text
    (unreliable,) = sixty_years.json()["minor"]
    assert unreliable["samples"] is None
    assert [warning["code"] for warning in unreliable["warnings"]] == [
        "mpc_extrapolation",
        "mpc_unreliable",
    ]
    assert unreliable["warnings"][1]["range_tt"] == [
        CERES_EPOCH_TT - 50 * YEAR,
        CERES_EPOCH_TT + 50 * YEAR,
    ]


def test_minor_body_ids(api_client: TestClient) -> None:
    halley = _frame(api_client, tt=CERES_EPOCH_TT, n=1, bodies="sun", minor="c:1P,a:1,c:1P")
    assert halley.status_code == 200, halley.text
    minor = halley.json()["minor"]
    assert [entry["id"] for entry in minor] == ["a:1", "c:1P"]
    assert minor[1]["kind"] == "comet"
    assert minor[1]["name"] == "Halley"
    assert minor[1]["samples"]["diam_deg"] == [0.0]
    hale_bopp = _frame(api_client, tt=CERES_EPOCH_TT, n=1, bodies="sun", minor="c:C/1995_O1")
    assert hale_bopp.status_code == 200, hale_bopp.text
    assert hale_bopp.json()["minor"][0]["id"] == "c:C/1995_O1"
    body = _problem(_frame(api_client, minor="x:1"), 400, "invalid-parameter")
    assert "minor: invalid ids 'x:1'" in body["detail"]
    unknown = _problem(
        _frame(api_client, n=1, bodies="sun", minor="a:999999999"), 404, "unknown-object"
    )
    assert "a:999999999" in unknown["detail"]
    # An unnumbered asteroid of the excerpt has no name: the key is absent, not null (B-48).
    unnamed = [
        row
        for row in api_client.get("/api/v1/minor-bodies/search?q=2024").json()
        if row["kind"] == "asteroid" and row.get("name") is None
    ]
    assert unnamed, "the excerpt carries unnamed 2024 designations"
    nameless = _frame(api_client, tt=CERES_EPOCH_TT, n=1, bodies="sun", minor=unnamed[0]["id"])
    assert nameless.status_code == 200, nameless.text
    entry = nameless.json()["minor"][0]
    assert entry["id"] == unnamed[0]["id"]
    assert "name" not in entry


def test_frame_from_mars_has_no_lst(api_client: TestClient) -> None:
    response = api_client.get(
        URL, params={"body": "mars", "lat": 18.38, "lon": 77.58, "elev": 0, "tt": TT0, "n": 4}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert "lst_hours" not in body["time"]
    assert body["observer"]["latitude_kind"] == "planetocentric"
    ids = {entry["id"] for entry in body["bodies"]}
    assert "mars" not in ids
    assert "earth" in ids
    assert body["observer"]["warnings"] == []
    pluto = api_client.get(
        URL, params={"body": "pluto", "lat": 0, "lon": 0, "tt": TT0, "n": 1, "bodies": "sun"}
    )
    assert pluto.status_code == 200, pluto.text
    assert [w["code"] for w in pluto.json()["observer"]["warnings"]] == ["pluto_barycenter"]


def test_caps_are_400(api_client: TestClient) -> None:
    hundred = ",".join(f"a:{i}" for i in range(1, 101))
    body = _problem(_frame(api_client, n=64, bodies="all", minor=hundred), 400, "invalid-parameter")
    assert "4096" in body["detail"]
    too_many = ",".join(f"a:{i}" for i in range(1, 102))
    body = _problem(_frame(api_client, n=1, bodies="sun", minor=too_many), 400, "invalid-parameter")
    assert "at most 100" in body["detail"]
    for params in ({"n": 65}, {"n": 0}, {"step_s": 0}, {"step_s": 31557601}, {"lat": 91}):
        body = _problem(_frame(api_client, **params), 400, "invalid-parameter")
        assert body["errors"][0]["loc"] == ["query", next(iter(params))]


def test_second_identical_request_is_a_cache_hit(api_client: TestClient) -> None:
    params = {"tt": TT0 + 0.123456, "n": 3, "bodies": "moon,mars"}
    first = _frame(api_client, **params)
    assert first.status_code == 200, first.text
    assert "cache;desc=miss" in first.headers["server-timing"]
    # Differences below the rounding steps and a permuted list map to the same cache entry.
    second = _frame(api_client, tt=TT0 + 0.123456 + 1e-9, lat=51.4800001, n=3, bodies="mars,moon")
    assert second.status_code == 200
    assert "cache;desc=hit" in second.headers["server-timing"]
    assert second.headers["cache-control"] == "public, max-age=300"
    assert second.content == first.content


def test_rate_limit_answers_429_with_retry_after(api_data_dir: Path) -> None:
    settings = api_settings_for(api_data_dir, rate_limit_rps=0.01, rate_limit_burst=2)
    app = create_app(settings)
    with TestClient(app, client=("203.0.113.9", 4444)) as client:
        wait_ready(client)
        params = {**GREENWICH, "n": 1, "bodies": "sun"}
        assert client.get(URL, params=params).status_code == 200
        assert client.get(URL, params=params).status_code == 200
        third = client.get(URL, params=params)
        body = _problem(third, 429, "rate-limited")
        assert 99 <= int(third.headers["retry-after"]) <= 100  # 0.01 token/s refill
        assert body["title"] == "Rate limited"
        # The key is the peer address: a forwarded header never opens a new bucket.
        forwarded = client.get(URL, params=params, headers={"X-Forwarded-For": "198.51.100.7"})
        assert forwarded.status_code == 429
        assert client.get("/api/v1/health").status_code == 200  # health is not rate limited


def test_openapi_documents_the_route(api_client: TestClient) -> None:
    document = api_client.get("/api/v1/openapi.json").json()
    operation = document["paths"][URL]["get"]
    assert set(operation["responses"]) >= {"200", "400", "404", "422", "429", "503", "default"}
    parameters = {parameter["name"]: parameter for parameter in operation["parameters"]}
    assert set(parameters) == {"body", "lat", "lon", "elev", "tt", "step_s", "n", "bodies", "minor"}
    for parameter in parameters.values():
        assert parameter["description"]
    assert parameters["n"]["schema"]["maximum"] == 64
    assert parameters["step_s"]["schema"]["maximum"] == 31557600
    assert {parameters[name]["required"] for name in ("lat", "lon", "tt")} == {True}
    assert "HTTPValidationError" not in document["components"]["schemas"]


def test_degraded_mpc_answers_503_only_for_minor_bodies(
    kernels_dir: Path, tmp_path_factory: pytest.TempPathFactory
) -> None:
    """Brief l.280: a missing optional data group makes only the routes that need it 503."""
    from support.fixtures_api import assemble_data_dir

    data_dir = assemble_data_dir(
        tmp_path_factory.mktemp("frame-degraded"), kernels_dir, groups={"dso", "constellations"}
    )
    app = create_app(api_settings_for(data_dir))
    with TestClient(app) as client:
        assert wait_ready(client)["status"] == "degraded"
        base = "/api/v1/sky/frame?lat=51.48&lon=0&tt=2461285.5&n=2"
        assert client.get(base).status_code == 200
        response = client.get(base + "&minor=a:1")
        assert response.status_code == 503
        assert response.headers["content-type"] == "application/problem+json"
        assert response.headers["retry-after"] == "60"
        assert response.json()["type"].endswith("problem-data-not-ready")
        altaz = client.get("/api/v1/sky/altaz?lat=51.48&lon=0&tt=2461285.5&targets=moon,a:1")
        assert altaz.status_code == 503
        assert (
            client.get("/api/v1/sky/altaz?lat=51.48&lon=0&tt=2461285.5&targets=moon").status_code
            == 200
        )
