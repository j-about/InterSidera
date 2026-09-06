"""`/api/v1/minor-bodies/search` and `/defaults` on the MPC excerpts and degraded (D61)."""

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from skyapi.main import create_app
from skyapi.middleware.caching import CACHE_COMPUTE
from support.fixtures_api import api_settings_for, assemble_data_dir, wait_ready

pytestmark = pytest.mark.api

SEARCH = "/api/v1/minor-bodies/search"
DEFAULTS = "/api/v1/minor-bodies/defaults"


def _ids(entries: list[dict[str, Any]]) -> list[str]:
    return [entry["id"] for entry in entries]


@pytest.fixture(scope="module")
def degraded_client(
    kernels_dir: Path, tmp_path_factory: pytest.TempPathFactory
) -> Iterator[TestClient]:
    """An app whose DATA_DIR lacks the MPC sources (and OpenNGC): no minor bodies."""
    data_dir = assemble_data_dir(
        tmp_path_factory.mktemp("minor-degraded"), kernels_dir, groups={"constellations"}
    )
    with TestClient(create_app(api_settings_for(data_dir))) as client:
        assert "mpc" in wait_ready(client)["missing"]
        yield client


def test_search_finds_ceres_by_name(api_client: TestClient) -> None:
    response = api_client.get(SEARCH, params={"q": "ceres"})

    assert response.status_code == 200
    # D61: no policy in the brief, treated like the compute endpoints.
    assert response.headers["cache-control"] == CACHE_COMPUTE == "public, max-age=300"
    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    assert _ids(body) == ["a:1"]
    ceres = body[0]
    assert ceres["designation"] == "(1) Ceres"
    assert ceres["name"] == "Ceres"
    assert ceres["kind"] == "asteroid"
    assert ceres["h_mag"] == pytest.approx(3.34)
    assert ceres["elements_epoch_tt"] == 2461200.5  # K2669 = 2026-06-09.0 TT


def test_search_finds_halley_by_its_short_form(api_client: TestClient) -> None:
    response = api_client.get(SEARCH, params={"q": "1P"})

    assert response.status_code == 200
    body = response.json()
    assert body[0]["id"] == "c:1P"
    assert body[0]["kind"] == "comet"
    assert body[0]["name"] == "Halley"
    # Comets carry no H: the optional field is absent, not `null`.
    assert "h_mag" not in body[0]
    assert _ids(api_client.get(SEARCH, params={"q": "c:1P"}).json()) == ["c:1P"]
    assert _ids(api_client.get(SEARCH, params={"q": "hale"}).json()) == ["c:C/1995_O1"]


def test_search_respects_limit(api_client: TestClient) -> None:
    every = api_client.get(SEARCH, params={"q": "2024"}).json()
    assert len(every) == 5
    assert all(entry["designation"].startswith("2024") for entry in every)
    assert all("name" not in entry for entry in every)

    two = api_client.get(SEARCH, params={"q": "2024", "limit": 2}).json()
    assert len(two) == 2
    assert two == every[:2]


def test_search_without_a_match_is_an_empty_list(api_client: TestClient) -> None:
    response = api_client.get(SEARCH, params={"q": "zzzz-no-such-object"})

    assert response.status_code == 200
    assert response.json() == []


@pytest.mark.parametrize(
    ("params", "loc"),
    [
        pytest.param({"q": "x" * 65}, ["query", "q"], id="q-too-long"),
        pytest.param({"q": ""}, ["query", "q"], id="q-empty"),
        pytest.param({}, ["query", "q"], id="q-missing"),
        pytest.param({"q": "ceres", "limit": 0}, ["query", "limit"], id="limit-zero"),
        pytest.param({"q": "ceres", "limit": 101}, ["query", "limit"], id="limit-too-large"),
        pytest.param({"q": "ceres", "limit": "many"}, ["query", "limit"], id="limit-text"),
    ],
)
def test_search_validation_is_a_400_problem(
    api_client: TestClient, params: dict[str, Any], loc: list[str]
) -> None:
    response = api_client.get(SEARCH, params=params)

    assert response.status_code == 400
    assert response.headers["content-type"] == "application/problem+json"
    problem = response.json()
    assert problem["status"] == 400
    assert problem["title"] == "Invalid parameter"
    assert problem["type"].endswith("#problem-invalid-parameter")
    assert problem["instance"] == SEARCH
    assert problem["errors"][0]["loc"] == loc
    assert problem["errors"][0]["msg"]


def test_defaults_rank_bright_asteroids_then_recent_comets(api_client: TestClient) -> None:
    response = api_client.get(DEFAULTS)

    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=300"
    body = response.json()
    assert 0 < len(body) <= 100
    asteroids = [entry for entry in body if entry["kind"] == "asteroid"]
    comets = [entry for entry in body if entry["kind"] == "comet"]
    # Asteroids first (H <= 9 sorted by H), then the comets: no asteroid after a comet.
    assert body == asteroids + comets
    h_mags = [entry["h_mag"] for entry in asteroids]
    assert all(h <= 9.0 for h in h_mags)
    assert h_mags == sorted(h_mags)
    # Excerpt: Vesta 3.20, Ceres 3.34, Pallas 4.12; (134340) Pluto is a major body (D36).
    assert _ids(asteroids) == ["a:4", "a:1", "a:2"]
    assert "a:134340" not in _ids(body)
    assert all("h_mag" not in entry for entry in comets)


@pytest.mark.parametrize("route", [SEARCH, DEFAULTS], ids=["search", "defaults"])
def test_degraded_without_mpc_is_a_503_problem(degraded_client: TestClient, route: str) -> None:
    response = degraded_client.get(route, params={"q": "ceres"})

    assert response.status_code == 503
    assert response.headers["content-type"] == "application/problem+json"
    assert response.headers["retry-after"] == "60"
    problem = response.json()
    assert problem["status"] == 503
    assert problem["title"] == "Data not ready"
    assert problem["type"].endswith("#problem-data-not-ready")
    assert problem["instance"] == route
    assert "MPC" in problem["detail"]
