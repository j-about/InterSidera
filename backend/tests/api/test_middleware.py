"""The middleware stack (D63, D149): request id, security headers, CORS and GZip.

Through the ready `api_client`; the 429 case and the "appends when absent" case build their own
app (`api_settings_for`, the function-scoped `settings`).
"""

import uuid
from pathlib import Path

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.responses import Response

from skyapi.main import create_app
from skyapi.middleware.headers import API_POLICY, DOCS_POLICY, SecurityHeadersMiddleware
from skyapi.middleware.logging import RequestContextMiddleware
from skyapi.settings import Settings
from support.fixtures_api import api_settings_for, wait_ready

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


# ---------------------------------------------------------------------------- security headers
# Plan D149 (brief l.274, l.276; backlog B-87): `nosniff` and the deny-everything CSP on every
# response, the Swagger page excepted; the middleware sits outside CORS (risk R111: the preflight
# proves the placement, CORS answers preflights without calling the inner app).

FRAME_400 = "/api/v1/sky/frame?lat=abc&lon=0&tt=2460000.5"
FRAME_OK = "/api/v1/sky/frame?lat=51.48&lon=0&elev=0&tt=2461285.5&n=1&bodies=sun"


def assert_security_headers(response: httpx2.Response, policy: str = API_POLICY) -> None:
    # `get_list`: each header exactly once (nginx adds its own set at M7, the API never doubles).
    assert response.headers.get_list("x-content-type-options") == ["nosniff"]
    assert response.headers.get_list("content-security-policy") == [policy]


def test_middleware_stack_order_is_context_headers_cors_gzip(api_app: FastAPI) -> None:
    # `add_middleware` inserts at the front: the list reads outermost first (D63 amended).
    assert [middleware.cls for middleware in api_app.user_middleware] == [
        RequestContextMiddleware,
        SecurityHeadersMiddleware,
        CORSMiddleware,
        GZipMiddleware,
    ]


@pytest.mark.parametrize(
    ("path", "status"),
    [
        ("/api/v1/health", 200),
        ("/api/v1/meta", 200),
        ("/api/v1/openapi.json", 200),
        ("/api/v1/catalogs/stars", 200),
        (FRAME_400, 400),
        ("/api/v1/nowhere", 404),
    ],
)
def test_security_headers_on_json_binary_and_problem_responses(
    api_client: TestClient, path: str, status: int
) -> None:
    response = api_client.get(path)

    assert response.status_code == status
    assert_security_headers(response)


def test_security_headers_on_a_304_catalog_response(api_client: TestClient) -> None:
    etag = api_client.get("/api/v1/catalogs/dso").headers["etag"]

    response = api_client.get("/api/v1/catalogs/dso", headers={"If-None-Match": etag})

    assert response.status_code == 304
    assert response.content == b""
    assert_security_headers(response)


def test_security_headers_on_a_cors_preflight(api_client: TestClient) -> None:
    # CORS answers the preflight itself: only a layer outside it can decorate the answer.
    response = api_client.options(
        "/api/v1/meta",
        headers={"Origin": ORIGIN, "Access-Control-Request-Method": "GET"},
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ORIGIN
    assert_security_headers(response)


def test_security_headers_on_a_refused_preflight_and_a_405(api_client: TestClient) -> None:
    refused = api_client.options(
        "/api/v1/meta",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"},
    )
    assert refused.status_code == 400
    assert_security_headers(refused)

    wrong_method = api_client.post("/api/v1/sky/altaz")
    assert wrong_method.status_code == 405
    assert_security_headers(wrong_method)


def test_security_headers_on_a_429_problem(api_data_dir: Path) -> None:
    settings = api_settings_for(api_data_dir, rate_limit_rps=0.01, rate_limit_burst=1)
    app = create_app(settings)
    with TestClient(app, client=("203.0.113.10", 4444)) as client:
        wait_ready(client)
        assert client.get(FRAME_OK).status_code == 200
        response = client.get(FRAME_OK)

    assert response.status_code == 429
    assert response.headers["content-type"] == "application/problem+json"
    assert "retry-after" in response.headers
    assert_security_headers(response)


def test_security_headers_on_a_503_while_starting(client: TestClient) -> None:
    # The function-scoped `client` has an empty DATA_DIR: every data route answers 503.
    response = client.get("/api/v1/meta")

    assert response.status_code == 503
    assert_security_headers(response)


def test_docs_page_has_its_own_relaxed_policy(api_client: TestClient) -> None:
    response = api_client.get("/api/v1/docs")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert_security_headers(response, DOCS_POLICY)
    # The policy names exactly the hosts FastAPI's Swagger page loads from (fastapi/openapi/
    # docs.py): a FastAPI bump that moved them would show up here before a browser refused them.
    assert "https://cdn.jsdelivr.net/npm/swagger-ui-dist" in response.text
    assert "https://fastapi.tiangolo.com/img/favicon.png" in response.text
    for host in ("https://cdn.jsdelivr.net", "https://fastapi.tiangolo.com"):
        assert host in DOCS_POLICY
    # Only that path: the schema it fetches and the slash-redirect toward the page stay strict.
    assert_security_headers(api_client.get("/api/v1/openapi.json"))
    redirect = api_client.get("/api/v1/docs/", follow_redirects=False)
    assert redirect.status_code == 307
    assert_security_headers(redirect)
    # Only its GET: another method on the same path is a 405 problem document, JSON that executes
    # nothing, so it carries the strict policy, not the page's relaxed one.
    post = api_client.post("/api/v1/docs")
    assert post.status_code == 405
    assert post.headers["content-type"] == "application/problem+json"
    assert_security_headers(post)
    # No OAuth flow (plan D150): the root-level `/docs/oauth2-redirect` page FastAPI registers by
    # default (an inline script the strict policy refuses) does not exist, and the Swagger init
    # script does not point at it.
    assert "oauth2RedirectUrl" not in response.text
    oauth2 = api_client.get("/docs/oauth2-redirect")
    assert oauth2.status_code == 404
    assert_security_headers(oauth2)


def test_security_headers_are_appended_only_when_absent(settings: Settings) -> None:
    app = create_app(settings)
    own = {"Content-Security-Policy": "default-src 'self'", "X-Content-Type-Options": "nosniff"}

    @app.get("/api/v1/own-headers", include_in_schema=False)
    def own_headers() -> Response:
        return Response(content=b"{}", media_type="application/json", headers=own)

    with TestClient(app) as client:
        response = client.get("/api/v1/own-headers")

    assert response.status_code == 200
    assert_security_headers(response, "default-src 'self'")
