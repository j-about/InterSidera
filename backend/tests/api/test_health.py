"""`GET /api/v1/health` (D52): ready, starting (503 with progress or detail) and degraded."""

import threading
import time
from collections.abc import Callable, Iterator
from importlib.metadata import version
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient

from skyapi.main import create_app
from support.fixtures_api import api_settings_for, assemble_data_dir, wait_ready
from support.fixtures_data import LocalData
from support.httpserver import LocalServer

pytestmark = pytest.mark.api

HEALTH = "/api/v1/health"
Body = dict[str, Any]


def poll_health(
    client: TestClient, done: Callable[[Body], bool], timeout: float = 10.0
) -> tuple[httpx2.Response, Body]:
    """Poll `/health` every 20 ms until `done(body)` holds; fail with the last body otherwise."""
    deadline = time.monotonic() + timeout
    while True:
        response = client.get(HEALTH)
        body: Body = response.json()
        if done(body):
            return response, body
        if time.monotonic() > deadline:
            pytest.fail(f"/health did not reach the expected state within {timeout} s: {body}")
        time.sleep(0.02)


@pytest.fixture(scope="module")
def degraded_client(
    kernels_dir: Path, tmp_path_factory: pytest.TempPathFactory
) -> Iterator[TestClient]:
    """Kernels, stars, DSO and constellations, but no MPC sources: the API runs degraded."""
    data_dir = assemble_data_dir(
        tmp_path_factory.mktemp("degraded"), kernels_dir, groups={"dso", "constellations"}
    )
    with TestClient(create_app(api_settings_for(data_dir))) as client:
        wait_ready(client)
        yield client


def test_health_is_ready_and_not_cached(api_client: TestClient) -> None:
    response = api_client.get(HEALTH)

    assert response.status_code == 200
    # Brief api_contract/conventions l.105.
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"].startswith("application/json")
    assert "retry-after" not in response.headers

    body = response.json()
    assert body["status"] == "ready"
    assert body["version"] == version("skyapi")
    # `progress`, `missing` and `detail` are optional and must be absent, not `null`, when idle.
    assert body == {"status": "ready", "version": version("skyapi")}


def test_health_reports_starting_with_detail_on_an_empty_data_dir(client: TestClient) -> None:
    # The function-scoped `client` has an empty DATA_DIR and `auto_fetch=False`: the bootstrap
    # fails on the missing ephemeris and `/health` says so with a 503.
    response, body = poll_health(client, lambda body: bool(body.get("detail")))

    assert response.status_code == 503
    assert response.headers["retry-after"] == "5"
    assert response.headers["cache-control"] == "no-store"
    assert body["status"] == "starting"
    assert body["version"] == version("skyapi")
    assert "progress" not in body
    assert "missing" not in body
    assert "de440s.bsp" in body["detail"]
    assert "sky-data fetch" in body["detail"]


def test_wait_ready_fails_fast_on_a_failed_bootstrap(client: TestClient) -> None:
    with pytest.raises(pytest.fail.Exception, match="bootstrap failed"):
        wait_ready(client, timeout=30.0)


def test_health_reports_download_progress_while_starting(
    local_data: LocalData, local_server: LocalServer, tmp_path: Path
) -> None:
    """`auto_fetch` against the local server, which sends 1 KiB of the ephemeris and then waits.

    While it waits, `/health` is `503 starting` with `progress` naming the file. Once released,
    the remaining downloads complete; the synthetic registry has none of the catalog sources, so
    the cache build fails and the bootstrap settles on a `detail` (the progress observation is
    what this test is about).
    """
    hold = threading.Event()
    local_server.behaviour.hold = hold
    data_dir = tmp_path / "data"  # created by the bootstrap
    settings = api_settings_for(data_dir, auto_fetch=True, ephemeris="tiny_eph.bsp")
    app = create_app(settings, registry=local_data.registry)
    expected_total = len(local_data.inflated["tiny_eph"])

    with TestClient(app) as client:
        try:
            response, body = poll_health(
                client, lambda body: body.get("progress", {}).get("file") == "tiny_eph.bsp"
            )
            assert response.status_code == 503
            assert response.headers["retry-after"] == "5"
            assert response.headers["cache-control"] == "no-store"
            assert body["status"] == "starting"
            assert body["version"] == version("skyapi")
            assert "detail" not in body
            assert "missing" not in body
            progress = body["progress"]
            assert progress["total_bytes"] == expected_total
            assert 0 <= progress["downloaded_bytes"] < expected_total
        finally:
            hold.set()  # never leave the server handler (and the bootstrap thread) waiting

        response, body = poll_health(
            client, lambda body: body["status"] != "starting" or bool(body.get("detail")), 30.0
        )
        assert response.status_code == 503
        assert body["status"] == "starting"
        assert body["detail"]
        assert "progress" not in body
        assert (data_dir / "tiny_eph.bsp").read_bytes() == local_data.inflated["tiny_eph"]
        assert (data_dir / "tiny.tpc").is_file()  # the downloads after the held one ran too


def test_health_is_degraded_without_the_mpc_data(degraded_client: TestClient) -> None:
    response = degraded_client.get(HEALTH)

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert "retry-after" not in response.headers
    body = response.json()
    assert body["status"] == "degraded"
    assert body["missing"] == ["mpc"]
    assert body["version"] == version("skyapi")
    assert "detail" not in body
    assert "progress" not in body


def test_openapi_document_is_served_under_the_base_path(client: TestClient) -> None:
    response = client.get("/api/v1/openapi.json")

    assert response.status_code == 200
    assert response.json()["openapi"].startswith("3.")


def test_health_is_not_exposed_at_the_root(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"
