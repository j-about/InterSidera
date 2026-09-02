"""`GET /api/v1/health` at M0: ready, uncached, exactly the contract's fields."""

from importlib.metadata import version

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.api


def test_health_is_ready_and_not_cached(client: TestClient) -> None:
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    # Brief api_contract/conventions l.105.
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"].startswith("application/json")

    body = response.json()
    assert body["status"] == "ready"
    assert body["version"] == version("skyapi")
    # `progress` is optional in the contract and must be absent, not `null`, when idle.
    assert body == {"status": "ready", "version": version("skyapi")}


def test_openapi_document_is_served_under_the_base_path(client: TestClient) -> None:
    response = client.get("/api/v1/openapi.json")

    assert response.status_code == 200
    assert response.json()["openapi"].startswith("3.")


def test_health_is_not_exposed_at_the_root(client: TestClient) -> None:
    assert client.get("/health").status_code == 404
