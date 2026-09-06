"""`/api/v1/catalogs/*`: cache files, strong ETags, 304, GZip and degraded 503 (D59)."""

import hashlib
import json
import re
import struct
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from skyapi.catalogs.artifacts import CachePaths, cache_paths
from skyapi.catalogs.formats import read_skys
from skyapi.main import create_app
from skyapi.middleware.caching import CACHE_CATALOG
from support.fixtures_api import api_settings_for, assemble_data_dir, wait_ready

pytestmark = pytest.mark.api

ETAG_RE = re.compile(r'^"[0-9a-f]{64}"$')
OCTET_STREAM = "application/octet-stream"
APPLICATION_JSON = "application/json"
# (route, `CachePaths` attribute, media type)
ROUTES = [
    pytest.param("/api/v1/catalogs/stars", "stars_skys", OCTET_STREAM, id="stars"),
    pytest.param("/api/v1/catalogs/stars/index", "stars_index", APPLICATION_JSON, id="index"),
    pytest.param("/api/v1/catalogs/dso", "dso_json", APPLICATION_JSON, id="dso"),
    pytest.param(
        "/api/v1/catalogs/constellations", "constellations_json", APPLICATION_JSON, id="con"
    ),
]
JSON_ROUTES = ROUTES[1:]


def _cache_file(paths: CachePaths, attribute: str) -> Path:
    path = getattr(paths, attribute)
    assert isinstance(path, Path)
    return path


@pytest.fixture(scope="module")
def paths(api_data_dir: Path) -> CachePaths:
    return cache_paths(api_data_dir)


@pytest.fixture(scope="module")
def degraded_client(
    kernels_dir: Path, tmp_path_factory: pytest.TempPathFactory
) -> Iterator[TestClient]:
    """An app whose DATA_DIR lacks the OpenNGC and MPC sources (constellations only)."""
    data_dir = assemble_data_dir(
        tmp_path_factory.mktemp("catalogs-degraded"), kernels_dir, groups={"constellations"}
    )
    with TestClient(create_app(api_settings_for(data_dir))) as client:
        assert wait_ready(client)["status"] == "degraded"
        yield client


@pytest.mark.parametrize(("route", "attribute", "media_type"), ROUTES)
def test_route_serves_the_cache_file_with_a_content_hash_etag(
    api_client: TestClient, paths: CachePaths, route: str, attribute: str, media_type: str
) -> None:
    expected = _cache_file(paths, attribute).read_bytes()

    response = api_client.get(route)

    assert response.status_code == 200
    # Brief api_contract/conventions l.105.
    assert response.headers["cache-control"] == CACHE_CATALOG
    assert response.headers["content-type"].startswith(media_type)
    etag = response.headers["etag"]
    assert ETAG_RE.match(etag)
    assert etag == f'"{hashlib.sha256(expected).hexdigest()}"'
    assert response.content == expected


@pytest.mark.parametrize(("route", "attribute", "media_type"), ROUTES)
def test_if_none_match_with_the_current_etag_is_304(
    api_client: TestClient, route: str, attribute: str, media_type: str
) -> None:
    etag = api_client.get(route).headers["etag"]

    response = api_client.get(route, headers={"If-None-Match": etag})

    assert response.status_code == 304
    assert response.headers["etag"] == etag
    assert response.headers["cache-control"] == CACHE_CATALOG
    assert response.content == b""


@pytest.mark.parametrize(
    "header",
    ["W/{etag}", "*", '"stale", {etag}', 'W/{etag}, "other"'],
    ids=["weak", "star", "list", "weak-list"],
)
def test_weak_star_and_list_tags_also_match(api_client: TestClient, header: str) -> None:
    etag = api_client.get("/api/v1/catalogs/dso").headers["etag"]

    response = api_client.get(
        "/api/v1/catalogs/dso", headers={"If-None-Match": header.format(etag=etag)}
    )

    assert response.status_code == 304
    assert response.headers["etag"] == etag


def test_stale_tag_gets_the_full_body(api_client: TestClient, paths: CachePaths) -> None:
    response = api_client.get(
        "/api/v1/catalogs/stars", headers={"If-None-Match": '"' + "0" * 64 + '"'}
    )

    assert response.status_code == 200
    assert response.content == paths.stars_skys.read_bytes()


def test_skys_header_and_length(api_client: TestClient, paths: CachePaths) -> None:
    body = api_client.get("/api/v1/catalogs/stars").content

    # docs/api.md byte layout: magic, u32 version, u32 count, f64 epoch_tt, u32 flags.
    magic, version, count, epoch_tt, flags = struct.unpack_from("<4sIIdI", body, 0)
    assert magic == b"SKYS"
    assert version == 1
    assert count == read_skys(paths.stars_skys.read_bytes()).count
    assert count > 0
    assert epoch_tt == 2451545.0
    assert flags == 0
    assert len(body) == 24 + 32 * count


@pytest.mark.parametrize(("route", "attribute", "media_type"), JSON_ROUTES)
def test_json_routes_parse_and_match_the_cache(
    api_client: TestClient, paths: CachePaths, route: str, attribute: str, media_type: str
) -> None:
    response = api_client.get(route)

    assert response.json() == json.loads(_cache_file(paths, attribute).read_bytes())


def test_constellations_document_shape(api_client: TestClient) -> None:
    body = api_client.get("/api/v1/catalogs/constellations").json()

    assert body["culture"] == "modern"
    assert body["constellations"]
    orion = next(entry for entry in body["constellations"] if entry["abbr"] == "Ori")
    assert orion["latin"] == "Orion"
    assert all(len(pair) == 2 for pair in orion["lines"])
    assert orion["boundary"][0] == orion["boundary"][-1]


def test_dso_is_gzipped_when_accepted_with_the_same_etag(
    api_client: TestClient, paths: CachePaths
) -> None:
    plain = api_client.get("/api/v1/catalogs/dso", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers

    response = api_client.get("/api/v1/catalogs/dso", headers={"Accept-Encoding": "gzip"})

    assert response.status_code == 200
    assert response.headers["content-encoding"] == "gzip"
    assert response.headers["etag"] == plain.headers["etag"]
    assert response.headers["cache-control"] == CACHE_CATALOG
    # httpx decodes transparently: the payload is the cache file.
    assert response.content == paths.dso_json.read_bytes()


def test_degraded_dso_is_503_while_the_other_catalogs_serve(degraded_client: TestClient) -> None:
    response = degraded_client.get("/api/v1/catalogs/dso")

    assert response.status_code == 503
    assert response.headers["content-type"] == "application/problem+json"
    assert response.headers["retry-after"] == "60"
    problem = response.json()
    assert problem["status"] == 503
    assert problem["title"] == "Data not ready"
    assert problem["type"].endswith("#problem-data-not-ready")
    assert problem["instance"] == "/api/v1/catalogs/dso"
    assert "dso" in problem["detail"]

    for route in (
        "/api/v1/catalogs/stars",
        "/api/v1/catalogs/stars/index",
        "/api/v1/catalogs/constellations",
    ):
        assert degraded_client.get(route).status_code == 200, route
