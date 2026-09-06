"""RFC 9457 problem documents on the compute routes (D54, brief l.106, l.275)."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from skyapi.main import create_app
from skyapi.middleware.problem import PROBLEM_TYPE_BASE, PROBLEM_TYPES
from support.fixtures_api import api_settings_for

pytestmark = pytest.mark.api

# tests/api/<this file> -> tests/api -> tests -> backend -> repository root
REPO_ROOT = Path(__file__).resolve().parents[3]

GITHUB_DOCS_PREFIX = "https://github.com/j-about/InterSidera/blob/master/docs/api.md#problem-"


def test_validation_error_is_a_400_problem_without_the_query_string(api_client: TestClient) -> None:
    response = api_client.get("/api/v1/sky/frame", params={"lat": "abc", "lon": 0, "tt": 2460000.5})
    assert response.status_code == 400
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert body["title"] == "Invalid parameter"
    assert body["status"] == 400
    assert body["instance"] == "/api/v1/sky/frame"
    assert body["type"] == f"{PROBLEM_TYPE_BASE}invalid-parameter"
    assert body["errors"][0]["loc"] == ["query", "lat"]
    assert body["errors"][0]["msg"]
    assert body["errors"][0]["type"]
    assert "abc" not in body["instance"]
    assert set(body) <= {"type", "title", "status", "detail", "instance", "errors", "range_tt"}


def test_missing_required_parameters_are_listed(api_client: TestClient) -> None:
    response = api_client.get("/api/v1/sky/frame")
    assert response.status_code == 400
    body = response.json()
    locations = [error["loc"] for error in body["errors"]]
    assert ["query", "lat"] in locations
    assert ["query", "lon"] in locations
    assert ["query", "tt"] in locations
    assert all(error["type"] == "missing" for error in body["errors"])
    assert body["detail"] == "3 invalid parameter(s)"


def test_unrouted_path_is_a_404_problem(api_client: TestClient) -> None:
    response = api_client.get("/api/v1/nowhere")
    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert body["status"] == 404
    assert body["title"] == "Not Found"
    assert body["instance"] == "/api/v1/nowhere"
    assert body["type"] == f"{PROBLEM_TYPE_BASE}http-error"


def test_wrong_method_is_a_405_problem(api_client: TestClient) -> None:
    response = api_client.post("/api/v1/sky/altaz")
    assert response.status_code == 405
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["status"] == 405


def test_problem_types_point_at_the_documentation(api_client: TestClient) -> None:
    assert PROBLEM_TYPE_BASE == GITHUB_DOCS_PREFIX
    responses = [
        api_client.get("/api/v1/sky/frame", params={"lat": 0, "lon": 0, "tt": 2460000.5, "n": 0}),
        api_client.get(
            "/api/v1/sky/altaz",
            params={"lat": 0, "lon": 0, "tt": 2460000.5, "targets": "hip:999999999"},
        ),
        api_client.get("/api/v1/sky/frame", params={"lat": 0, "lon": 0, "tt": 1000000.0}),
        api_client.get("/api/v1/nowhere"),
    ]
    assert [response.status_code for response in responses] == [400, 404, 422, 404]
    for response in responses:
        body = response.json()
        assert body["type"].startswith(GITHUB_DOCS_PREFIX)
        slug = body["type"].removeprefix(GITHUB_DOCS_PREFIX)
        assert slug in PROBLEM_TYPES
        assert "?" not in body["instance"]


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/meta",
        "/api/v1/catalogs/stars",
        "/api/v1/catalogs/stars/index",
        "/api/v1/catalogs/dso",
        "/api/v1/catalogs/constellations",
        "/api/v1/minor-bodies/search?q=ceres",
        "/api/v1/minor-bodies/defaults",
        "/api/v1/sky/frame?lat=51.48&lon=0&tt=2461285.5&n=1&bodies=sun",
        "/api/v1/sky/altaz?lat=51.48&lon=0&tt=2461285.5&targets=moon",
    ],
)
def test_data_routes_answer_503_while_starting(client: TestClient, path: str) -> None:
    # The function-scoped `client` has an empty DATA_DIR: the bootstrap never publishes a state.
    response = client.get(path)
    path = path.split("?")[0]

    assert response.status_code == 503
    assert response.headers["content-type"] == "application/problem+json"
    assert response.headers["retry-after"] == "5"
    body = response.json()
    assert body["type"] == PROBLEM_TYPE_BASE + "data-not-ready"
    assert body["status"] == 503
    assert body["instance"] == path


def test_unhandled_exception_is_a_500_problem_with_the_request_id(tmp_path: Path) -> None:
    app = create_app(api_settings_for(tmp_path))

    @app.get("/api/v1/boom", include_in_schema=False)
    def boom() -> None:
        raise RuntimeError("boom")

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get(
            "/api/v1/boom", headers={"X-Request-Id": "123e4567-e89b-12d3-a456-426614174000"}
        )

    assert response.status_code == 500
    assert response.headers["content-type"] == "application/problem+json"
    assert response.headers["x-request-id"] == "123e4567-e89b-12d3-a456-426614174000"
    body = response.json()
    assert body["type"] == PROBLEM_TYPE_BASE + "internal-error"
    assert "123e4567-e89b-12d3-a456-426614174000" in body["detail"]
    assert "boom" not in body["detail"]  # no exception text leaks


def test_every_problem_type_is_documented_in_api_md() -> None:
    text = (REPO_ROOT / "docs" / "api.md").read_text(encoding="utf-8")
    for slug in PROBLEM_TYPES:
        assert f"### problem-{slug}" in text, slug
