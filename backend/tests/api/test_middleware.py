"""The middleware stack (D63): request id, CORS and GZip, through the ready `api_client`."""

import uuid

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.api

ORIGIN = "https://localhost:5173"  # the `cors_origins` default of `Settings`
EXPOSED = {"etag", "server-timing", "retry-after", "x-request-id"}


def header_set(value: str) -> set[str]:
    return {item.strip().lower() for item in value.split(",") if item.strip()}


# ------------------------------------------------------------------------------- X-Request-Id


def test_uuid_shaped_request_id_is_echoed_lower_cased(api_client: TestClient) -> None:
    request_id = str(uuid.uuid4())

    response = api_client.get("/api/v1/health", headers={"X-Request-Id": request_id.upper()})

    assert response.status_code == 200
    assert response.headers["x-request-id"] == request_id


@pytest.mark.parametrize(
    "bad",
    [
        "abc",
        "0f8fad5b-d9cb-469f-a165-70867728950",  # one hex digit short
        "0f8fad5bd9cb469fa16570867728950e",  # no dashes
        "<script>alert(1)</script>",
        "x" * 200,
    ],
)
def test_non_uuid_request_id_is_replaced_by_a_fresh_one(api_client: TestClient, bad: str) -> None:
    response = api_client.get("/api/v1/health", headers={"X-Request-Id": bad})

    echoed = response.headers["x-request-id"]
    assert echoed != bad
    assert str(uuid.UUID(echoed)) == echoed


def test_missing_request_id_is_generated_per_request(api_client: TestClient) -> None:
    first = api_client.get("/api/v1/health").headers["x-request-id"]
    second = api_client.get("/api/v1/health").headers["x-request-id"]

    assert str(uuid.UUID(first)) == first
    assert str(uuid.UUID(second)) == second
    assert first != second


def test_request_id_is_present_on_problem_responses(api_client: TestClient) -> None:
    response = api_client.get("/api/v1/nowhere")

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"
    assert str(uuid.UUID(response.headers["x-request-id"]))


# --------------------------------------------------------------------------------------- CORS


def test_cors_preflight_from_the_configured_origin(api_client: TestClient) -> None:
    response = api_client.options(
        "/api/v1/meta",
        headers={
            "Origin": ORIGIN,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "If-None-Match",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ORIGIN
    assert "get" in header_set(response.headers["access-control-allow-methods"])
    assert "if-none-match" in header_set(response.headers["access-control-allow-headers"])
    assert response.headers["access-control-max-age"] == "600"
    # The request-context middleware is the outermost layer: preflights carry an id too.
    assert str(uuid.UUID(response.headers["x-request-id"]))


def test_cors_response_exposes_the_headers_the_frontend_reads(api_client: TestClient) -> None:
    # `Access-Control-Expose-Headers` belongs to the actual response, not to the preflight.
    response = api_client.get("/api/v1/health", headers={"Origin": ORIGIN})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ORIGIN
    assert header_set(response.headers["access-control-expose-headers"]) >= EXPOSED


def test_cors_headers_are_also_on_problem_responses(api_client: TestClient) -> None:
    response = api_client.get("/api/v1/nowhere", headers={"Origin": ORIGIN})

    assert response.status_code == 404
    assert response.headers["access-control-allow-origin"] == ORIGIN
    assert header_set(response.headers["access-control-expose-headers"]) >= EXPOSED


def test_unknown_origin_gets_no_cors_headers(api_client: TestClient) -> None:
    response = api_client.get("/api/v1/health", headers={"Origin": "https://evil.example"})

    assert response.status_code == 200
    # Starlette adds `Access-Control-Expose-Headers` to every response carrying an `Origin`;
    # without `Access-Control-Allow-Origin` the browser refuses the response anyway.
    assert "access-control-allow-origin" not in response.headers


def test_preflight_from_an_unknown_origin_is_refused(api_client: TestClient) -> None:
    response = api_client.options(
        "/api/v1/meta",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"},
    )

    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


# --------------------------------------------------------------------------------------- GZip


def test_bodies_of_at_least_one_kib_are_gzipped(api_client: TestClient) -> None:
    response = api_client.get("/api/v1/openapi.json", headers={"Accept-Encoding": "gzip"})

    assert response.status_code == 200
    assert response.headers["content-encoding"] == "gzip"
    assert response.json()["openapi"].startswith("3.")  # httpx inflated it transparently
    assert len(response.content) >= 1024
    assert int(response.headers["content-length"]) < len(response.content)


def test_small_bodies_are_not_gzipped(api_client: TestClient) -> None:
    response = api_client.get("/api/v1/health", headers={"Accept-Encoding": "gzip"})

    assert response.status_code == 200
    assert len(response.content) < 1024
    assert "content-encoding" not in response.headers


def test_gzip_needs_the_client_to_accept_it(api_client: TestClient) -> None:
    response = api_client.get("/api/v1/openapi.json", headers={"Accept-Encoding": "identity"})

    assert response.status_code == 200
    assert "content-encoding" not in response.headers
    assert int(response.headers["content-length"]) == len(response.content)
