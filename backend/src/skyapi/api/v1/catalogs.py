"""Catalog routes served straight from the cache files (brief l.131-150, D59).

The artifacts are written by `sky-data build-caches` and never rebuilt per request (brief
l.535). Each route streams its file with the catalog cache policy and a strong ETag: the
artifact SHA-256 recorded in `cache/manifest.json`, quoted in the header and bare in
`/meta.catalogs.*.etag`. `If-None-Match` naming that ETag (or `*`) answers 304 with the same
`ETag` and `Cache-Control`. A catalog whose data is missing (degraded) or whose file vanished
answers 503 with `Retry-After`.
"""

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import FileResponse

from skyapi.api.deps import SettingsDep, SkyStateDep
from skyapi.catalogs.artifacts import cache_paths
from skyapi.catalogs.state import CatalogUnavailableError
from skyapi.middleware.caching import CACHE_CATALOG, etag_header, not_modified
from skyapi.middleware.problem import DataNotReadyError, problem_responses
from skyapi.models.catalogs import ConstellationsResponse, DsoEntry, StarIndexEntry
from skyapi.state import SkyState

router = APIRouter(tags=["catalogs"])

OCTET_STREAM = "application/octet-stream"
APPLICATION_JSON = "application/json"
# A degraded catalog stays missing until the operator runs `sky-data fetch` (brief l.280): one
# minute keeps a polling client polite without hiding the recovery for long.
DEGRADED_RETRY_AFTER_SECONDS = 60

_NOT_MODIFIED: dict[str, Any] = {
    "description": "Not modified (`If-None-Match` matched the ETag); `ETag` and `Cache-Control` "
    "are repeated, the body is empty."
}
_CACHING_NOTE = (
    " Served with `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` and a "
    "strong `ETag` (the artifact SHA-256, bare in `/meta.catalogs`); `If-None-Match` -> 304."
)


def _degraded(name: str) -> DataNotReadyError:
    """503 for a catalog whose data is missing, worded like `CatalogUnavailableError`."""
    return DataNotReadyError(
        str(CatalogUnavailableError(name)), retry_after=DEGRADED_RETRY_AFTER_SECONDS
    )


def _serve(request: Request, sky: SkyState, artifact: str, path: Path, media_type: str) -> Response:
    identity = sky.catalogs.identities.get(artifact)
    if identity is None or not path.is_file():
        raise DataNotReadyError(
            f"the {artifact} cache artifact is missing: run `sky-data build-caches`",
            retry_after=DEGRADED_RETRY_AFTER_SECONDS,
        )
    etag = etag_header(identity.sha256)
    headers = {"ETag": etag, "Cache-Control": CACHE_CATALOG}
    if not_modified(request, etag):
        return Response(status_code=304, headers=headers)
    # Starlette only adds its own stat-based ETag with `setdefault`, so ours wins.
    return FileResponse(
        path, media_type=media_type, headers=headers, content_disposition_type="inline"
    )


@router.get(
    "/catalogs/stars",
    response_class=Response,
    summary="Star catalog, binary SKYS v1",
    description=(
        "Every Hipparcos star with a position, as the little-endian binary format `SKYS` v1 "
        "(`application/octet-stream`). Header, 24 bytes: magic `SKYS` (4 bytes), `u32` version "
        "= 1, `u32` count `n`, `f64` epoch_tt (2451545.0 = J2000; Hipparcos positions are "
        "propagated from J1991.25 by Skyfield at build time), `u32` flags (reserved, 0). Then "
        "the columns, packed without padding: `dir` f32[3n] ICRF unit vector at the epoch, `pm` "
        "f32[3n] tangential proper-motion velocity in ICRF in radians per Julian year (parallax "
        "and radial velocity ignored), `mag` i16[n] Johnson V in millimagnitudes, `bv` i16[n] "
        "B-V in millimagnitudes (32767 when unknown), `hip` u32[n] Hipparcos identifier; total "
        "24 + 32 n bytes. Stars are sorted by magnitude ascending, so any prefix is a valid "
        "brighter-than subset. Shader rule: `dir(t) = normalize(dir + pm * years_since_epoch)`, "
        "then aberration `normalize(dir(t) + observer_velocity / c)`." + _CACHING_NOTE
    ),
    responses={
        200: {
            "description": "The SKYS v1 file (`24 + 32 n` bytes, `n` in the header).",
            "content": {OCTET_STREAM: {}},
        },
        304: _NOT_MODIFIED,
        **problem_responses(503),
    },
)
def get_stars(request: Request, sky: SkyStateDep, settings: SettingsDep) -> Response:
    return _serve(request, sky, "stars", cache_paths(settings.data_dir).stars_skys, OCTET_STREAM)


@router.get(
    "/catalogs/stars/index",
    response_model=list[StarIndexEntry],
    summary="Named or designated stars for search and labels",
    description=(
        "The stars that carry an IAU proper name, a Bayer or a Flamsteed designation (about "
        "3 400 of the Hipparcos catalog), with their constellation. Proper names are the IAU "
        "names and are not translated; `bayer` is the Greek letter with an optional superscript "
        "and the IAU abbreviation (`α Ori`), `flamsteed` the number and abbreviation (`58 Ori`)."
        + _CACHING_NOTE
    ),
    responses={304: _NOT_MODIFIED, **problem_responses(503)},
)
def get_stars_index(request: Request, sky: SkyStateDep, settings: SettingsDep) -> Response:
    return _serve(
        request, sky, "stars_index", cache_paths(settings.data_dir).stars_index, APPLICATION_JSON
    )


@router.get(
    "/catalogs/dso",
    response_model=list[DsoEntry],
    summary="Deep-sky objects (OpenNGC subset)",
    description=(
        "Every Messier object plus the NGC/IC objects with `mag <= 14` or a major axis of at "
        "least 5 arcminutes, J2000 ICRS. `id` is the OpenNGC name without zero padding and with "
        "spaces replaced by `_` (`NGC224`, `IC434`, `Mel22`); `messier` carries the Messier "
        "number when the object has one; `type` is the OpenNGC class mapped to six values. "
        "Answers 503 while the OpenNGC data is missing (`/health` lists `dso` in `missing`)."
        + _CACHING_NOTE
    ),
    responses={304: _NOT_MODIFIED, **problem_responses(503)},
)
def get_dso(request: Request, sky: SkyStateDep, settings: SettingsDep) -> Response:
    if sky.catalogs.dso is None:
        raise _degraded("dso")
    return _serve(request, sky, "dso", cache_paths(settings.data_dir).dso_json, APPLICATION_JSON)


@router.get(
    "/catalogs/constellations",
    response_model=ConstellationsResponse,
    summary="Constellation lines, boundaries and labels (modern culture)",
    description=(
        "The 88 IAU constellations: Stellarium `modern` line segments as pairs of Hipparcos "
        "identifiers (so lines follow the rendered stars), IAU boundary polygons as closed rings "
        "of ICRS J2000 `[ra_deg, dec_deg]` vertices (`boundary_parts` lists every ring when a "
        "constellation has more than one, Serpens), Latin and genitive names and a label "
        "position. Answers 503 while the Stellarium or d3-celestial data is missing (`/health` "
        "lists `constellations` in `missing`)." + _CACHING_NOTE
    ),
    responses={304: _NOT_MODIFIED, **problem_responses(503)},
)
def get_constellations(request: Request, sky: SkyStateDep, settings: SettingsDep) -> Response:
    if sky.catalogs.constellations is None:
        raise _degraded("constellations")
    return _serve(
        request,
        sky,
        "constellations",
        cache_paths(settings.data_dir).constellations_json,
        APPLICATION_JSON,
    )
