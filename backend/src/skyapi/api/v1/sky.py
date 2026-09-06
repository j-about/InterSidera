"""`GET /sky/frame` and `GET /sky/altaz` (brief l.157-172, D56-D58, D68).

Plain `def` routes (CPU-bound, thread pool): canonicalize (`api/canonical.py`), look the frame
cache up, call the `astro/` composites, round per D68, serialise through the Pydantic models
so NaN magnitudes become `null`, and map the typed `astro/` exceptions to problem documents.
Nothing here imports Skyfield.
"""

import math
import time
from collections.abc import Generator, Mapping, Sequence
from contextlib import contextmanager
from typing import Annotated, Any

import numpy as np
from fastapi import APIRouter, Query, Response
from numpy.typing import NDArray

from skyapi.api.canonical import altaz_query, frame_query
from skyapi.api.deps import FrameCacheDep, SkyStateDep
from skyapi.astro.altaz import AltAzResult, TargetSyntaxError, compute_altaz
from skyapi.astro.dso import UnknownDsoError
from skyapi.astro.frame import FrameResult, compute_frame
from skyapi.astro.frames import CoverageError
from skyapi.astro.minor_bodies import UnknownMinorBodyError
from skyapi.astro.observers import ObserverUnavailableError, UnknownObserverError
from skyapi.astro.queries import FrameQuery
from skyapi.astro.sampling import MAX_MINOR_BODIES, MAX_SAMPLES, MAX_STEP_S_CEILING, MAX_TARGETS
from skyapi.astro.stars import UnknownStarError
from skyapi.astro.warnings import SkyWarning
from skyapi.catalogs.state import CatalogUnavailableError
from skyapi.middleware.caching import CACHE_COMPUTE, server_timing
from skyapi.middleware.problem import (
    DataNotReadyError,
    InvalidParameterError,
    OutsideCoverageError,
    UnknownObjectError,
    problem_responses,
)
from skyapi.middleware.ratelimit import RateLimited
from skyapi.models.altaz import AltAzEntry
from skyapi.models.frame import FrameResponse

router = APIRouter(tags=["sky"])

# D68: decimals kept in the JSON bodies (deterministic, shorter payloads); ranges are wrapped
# after rounding so `az_deg`/`ra_*_deg` stay in [0, 360) and `lst_hours` in [0, 24).
VECTOR_DECIMALS = 9  # unit vectors, quaternions, velocities, dist_au, tt fields
MAGNITUDE_DECIMALS = 3
ANGLE_DECIMALS = 7  # phase, diam_deg, alt/az/ra/dec, lst_hours
SECONDS_DECIMALS = 6  # tt_minus_utc_seconds
DEGRADED_RETRY_AFTER_SECONDS = 60

_BODY_PARAM = Query(
    max_length=16,
    description=(
        "Observer body id: `earth`, `moon`, `mercury`, `venus`, `mars`, `jupiter`, `saturn`, "
        "`uranus`, `neptune` or `pluto` (the Sun is never an observer)."
    ),
    examples=["earth"],
)
_LAT_PARAM = Query(
    ge=-90.0,
    le=90.0,
    allow_inf_nan=False,
    description=(
        "Observer latitude in degrees (geodetic on Earth, planetocentric elsewhere), "
        "canonicalized to 1e-6 degree."
    ),
    examples=[48.8566],
)
_LON_PARAM = Query(
    ge=-360.0,
    le=360.0,
    allow_inf_nan=False,
    description=(
        "Observer east longitude in degrees within [-360, 360], canonicalized to 1e-6 degree "
        "and wrapped into [-180, 180)."
    ),
    examples=[2.3522],
)
_ELEV_PARAM = Query(
    ge=-12000.0,
    le=100000.0,
    allow_inf_nan=False,
    description="Observer elevation above the reference surface in metres, canonicalized to 1 m.",
    examples=[35],
)


@contextmanager
def _mapped_astro_errors() -> Generator[None]:
    """Translate the typed `astro/` exceptions into problem documents (D54)."""
    try:
        yield
    except (UnknownObserverError, TargetSyntaxError) as exc:
        raise InvalidParameterError(str(exc)) from exc
    except (UnknownStarError, UnknownDsoError, UnknownMinorBodyError) as exc:
        raise UnknownObjectError(str(exc)) from exc
    except CoverageError as exc:
        raise OutsideCoverageError(str(exc), exc.range_tt) from exc
    except (ObserverUnavailableError, CatalogUnavailableError) as exc:
        raise DataNotReadyError(str(exc), retry_after=DEGRADED_RETRY_AFTER_SECONDS) from exc


def _rows(values: NDArray[np.float64], decimals: int) -> list[list[float]]:
    rounded: list[list[float]] = np.round(values, decimals).tolist()
    return rounded


def _values(values: NDArray[np.float64], decimals: int) -> list[float]:
    rounded: list[float] = np.round(values, decimals).tolist()
    return rounded


def _magnitudes(values: NDArray[np.float64]) -> list[float | None]:
    return [None if math.isnan(value) else value for value in _values(values, MAGNITUDE_DECIMALS)]


def _warning_payloads(warnings: Sequence[SkyWarning]) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    for warning in warnings:
        payload: dict[str, Any] = {"code": warning.code}
        if warning.params is not None:
            payload["params"] = dict(warning.params)
        if warning.range_tt is not None:
            payload["range_tt"] = list(warning.range_tt)
        payloads.append(payload)
    return payloads


def _samples_payload(
    direction: NDArray[np.float64],
    dist_au: NDArray[np.float64],
    mag: NDArray[np.float64],
    phase: NDArray[np.float64],
    diam_deg: NDArray[np.float64],
) -> dict[str, Any]:
    return {
        "dir": _rows(direction, VECTOR_DECIMALS),
        "dist_au": _values(dist_au, VECTOR_DECIMALS),
        "mag": _magnitudes(mag),
        "phase": _values(phase, ANGLE_DECIMALS),
        "diam_deg": _values(diam_deg, ANGLE_DECIMALS),
    }


def frame_payload(result: FrameResult, query: FrameQuery) -> dict[str, Any]:
    """The `FrameResponse` document as plain data, rounded per D68.

    Optional fields (`time.lst_hours`, `warnings[].params`, `warnings[].range_tt`,
    `minor[].name`) are simply absent when they do not apply, so `exclude_unset=True` drops
    them; `minor[].samples` is set to `None` explicitly and serialises as `null` (brief l.168).
    """
    observer = result.observer
    time_payload: dict[str, Any] = {
        "tt0": round(result.tt0, VECTOR_DECIMALS),
        "step_s": result.step_s,
        "n": result.n,
        "tt_minus_utc_seconds": round(result.tt_minus_utc_seconds, SECONDS_DECIMALS),
        "utc0": result.utc0,
        "warnings": _warning_payloads(result.time_warnings),
    }
    if result.lst_hours is not None:
        time_payload["lst_hours"] = _values(
            np.round(result.lst_hours, ANGLE_DECIMALS) % 24.0, ANGLE_DECIMALS
        )
    minor_payloads: list[dict[str, Any]] = []
    for body_id, entry in result.minor.items():
        samples = entry.samples
        minor_payload: dict[str, Any] = {
            "id": body_id,
            "kind": entry.kind,
            "samples": None
            if samples is None
            else _samples_payload(
                samples.dir, samples.dist_au, samples.mag, samples.phase, samples.diam_deg
            ),
            "elements_epoch_tt": round(entry.elements_epoch_tt, VECTOR_DECIMALS),
            "extrapolation_years": round(entry.extrapolation_years, ANGLE_DECIMALS),
            "warnings": _warning_payloads(entry.warnings),
        }
        if entry.name is not None:
            minor_payload["name"] = entry.name
        minor_payloads.append(minor_payload)
    return {
        "observer": {
            "body": query.body,
            "lat_deg": query.lat_deg,
            "lon_deg": query.lon_deg,
            "elev_m": query.elev_m,
            "latitude_kind": observer.spec.latitude_kind,
            "warnings": _warning_payloads(result.observer_warnings),
        },
        "time": time_payload,
        "horizon": {"q": _rows(result.horizon_q, VECTOR_DECIMALS)},
        "equinox_of_date": {"q": _rows(result.equinox_q, VECTOR_DECIMALS)},
        "observer_velocity_au_d": _rows(result.observer_velocity_au_d, VECTOR_DECIMALS),
        "sun_dir": _rows(result.sun_dir, VECTOR_DECIMALS),
        "bodies": [
            {
                "id": body.id,
                "kind": body.kind,
                "samples": _samples_payload(
                    body.samples.dir,
                    body.samples.dist_au,
                    body.samples.mag,
                    body.samples.phase,
                    body.samples.diam_deg,
                ),
                "warnings": _warning_payloads(body.warnings),
            }
            for body in result.bodies
        ],
        "minor": minor_payloads,
    }


def _json_response(content: bytes, headers: Mapping[str, str]) -> Response:
    return Response(content=content, media_type="application/json", headers=dict(headers))


@router.get(
    "/sky/frame",
    response_model=FrameResponse,
    dependencies=[RateLimited],
    summary="Sky frame: rotations and body samples over a time window",
    description=(
        "One window of `n` samples spaced `step_s` seconds apart from `tt`: the ICRF -> ENU "
        "horizon quaternions, the ICRF -> equinox-of-date quaternions, the observer's "
        "barycentric velocity, the Sun direction and, per requested body and minor body, the "
        "apparent direction, distance, magnitude, illuminated fraction and angular diameter. "
        "Parameters are canonicalized before computing and before the cache lookup (coordinates "
        "to 1e-6 degree, elevation to 1 m, `tt` to 1e-8 day, lists sorted and de-duplicated) "
        "and the canonical values are echoed. `step_s` is clamped to the smallest per-class "
        "maximum among the requested bodies (`/meta.limits.max_step_s`) and the value used is "
        "reported. `n * (bodies + minor)` may not exceed 4096. Hard coverage limits (ephemeris, "
        "observer frame) answer 422 with the valid range; soft ones are `warnings`. Rate "
        "limited per client IP; `Cache-Control: public, max-age=300`; `Server-Timing` reports "
        "the compute time and the cache outcome."
    ),
    responses=problem_responses(400, 404, 422, 429, 503),
)
def get_frame(
    sky: SkyStateDep,
    cache: FrameCacheDep,
    *,
    body: Annotated[str, _BODY_PARAM] = "earth",
    lat: Annotated[float, _LAT_PARAM],
    lon: Annotated[float, _LON_PARAM],
    elev: Annotated[float, _ELEV_PARAM] = 0.0,
    tt: Annotated[
        float,
        Query(
            allow_inf_nan=False,
            description=(
                "TT Julian Date of the first sample, canonicalized to 1e-8 day; any finite "
                "value is accepted and the data coverage decides (422 outside it)."
            ),
            examples=[2461285.5],
        ),
    ],
    step_s: Annotated[
        int,
        Query(
            ge=1,
            le=MAX_STEP_S_CEILING,
            description=(
                "Seconds between samples; clamped to the requested bodies' class maximum and "
                "echoed in `time.step_s`."
            ),
            examples=[300],
        ),
    ] = 60,
    n: Annotated[
        int,
        Query(ge=1, le=MAX_SAMPLES, description="Number of samples.", examples=[32]),
    ] = 32,
    bodies: Annotated[
        str,
        Query(
            max_length=256,
            description=(
                "`all` (every body but the observer's own) or a comma-separated list of body "
                "ids; naming the observer's body is a 400."
            ),
            examples=["all", "moon,mars,jupiter"],
        ),
    ] = "all",
    minor: Annotated[
        str | None,
        Query(
            max_length=4096,
            description=(
                f"Comma-separated minor-body ids (`a:<number>`, `a:<packed designation>`, "
                f"`c:<designation>`), at most {MAX_MINOR_BODIES}."
            ),
            examples=["a:1,c:1P"],
        ),
    ] = None,
) -> Response:
    query = frame_query(
        body=body,
        lat=lat,
        lon=lon,
        elev=elev,
        tt=tt,
        step_s=step_s,
        n=n,
        bodies=bodies,
        minor=minor,
    )
    started = time.perf_counter()
    key = query.cache_key()
    cached = cache.get(key)
    if cached is not None:
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        return _json_response(
            cached,
            {
                "Cache-Control": CACHE_COMPUTE,
                "Server-Timing": server_timing(elapsed_ms, cache="hit"),
            },
        )
    with _mapped_astro_errors():
        result = compute_frame(sky, query)
    document = FrameResponse.model_validate(frame_payload(result, query))
    content = document.model_dump_json(exclude_unset=True).encode("utf-8")
    cache.put(key, content)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    return _json_response(
        content,
        {"Cache-Control": CACHE_COMPUTE, "Server-Timing": server_timing(elapsed_ms, cache="miss")},
    )


def _wrap_degrees(value: float) -> float:
    return round(value, ANGLE_DECIMALS) % 360.0


def _optional(value: float | None, decimals: int) -> float | None:
    return None if value is None else round(value, decimals)


def altaz_entry(result: AltAzResult) -> AltAzEntry:
    """One response row, rounded per D68 (`az`/`ra` wrapped into [0, 360) after rounding)."""
    return AltAzEntry(
        id=result.id,
        alt_deg=round(result.alt_deg, ANGLE_DECIMALS),
        az_deg=_wrap_degrees(result.az_deg),
        ra_icrs_deg=_wrap_degrees(result.ra_icrs_deg),
        dec_icrs_deg=round(result.dec_icrs_deg, ANGLE_DECIMALS),
        ra_date_deg=_wrap_degrees(result.ra_date_deg),
        dec_date_deg=round(result.dec_date_deg, ANGLE_DECIMALS),
        dist_au=_optional(result.dist_au, VECTOR_DECIMALS),
        mag=_optional(result.mag, MAGNITUDE_DECIMALS),
        phase=_optional(result.phase, ANGLE_DECIMALS),
        diam_deg=_optional(result.diam_deg, ANGLE_DECIMALS),
    )


@router.get(
    "/sky/altaz",
    response_model=list[AltAzEntry],
    # `dist_au`, `mag`, `phase`, `diam_deg` are absent (not `null`) when they do not apply.
    response_model_exclude_none=True,
    dependencies=[RateLimited],
    summary="Authoritative alt/az and RA/Dec of targets at one instant",
    description=(
        "Skyfield's apparent altitude and azimuth, ICRS and of-date right ascension and "
        "declination for up to 200 targets seen from the observer at `tt`: `hip:<number>`, "
        "`dso:<canonical OpenNGC id>` (Messier aliases resolved through the catalog), body ids, "
        "`a:<number>` and `c:<designation>`. Bodies and minor bodies also carry `dist_au`, `mag` "
        "and `phase` (bodies: `diam_deg` too). Refraction (standard atmosphere) is applied only "
        "when requested and only for Earth observers. Rows follow the canonical (sorted) target "
        "list and echo the ids as requested. Rate limited per client IP; "
        "`Cache-Control: public, max-age=300`."
    ),
    responses=problem_responses(400, 404, 422, 429, 503),
)
def get_altaz(
    sky: SkyStateDep,
    response: Response,
    *,
    body: Annotated[str, _BODY_PARAM] = "earth",
    lat: Annotated[float, _LAT_PARAM],
    lon: Annotated[float, _LON_PARAM],
    elev: Annotated[float, _ELEV_PARAM] = 0.0,
    tt: Annotated[
        float,
        Query(
            allow_inf_nan=False,
            description="TT Julian Date of the instant, canonicalized to 1e-8 day.",
            examples=[2461285.5],
        ),
    ],
    targets: Annotated[
        str,
        Query(
            max_length=8192,
            description=(
                f"Comma-separated targets (`hip:<number>`, `dso:<id>`, body id, `a:<..>`, "
                f"`c:<..>`), at most {MAX_TARGETS}."
            ),
            examples=["hip:32349,moon,dso:NGC224,a:1,c:1P"],
        ),
    ],
    refraction: Annotated[
        bool,
        Query(
            description="Apply Skyfield's standard-atmosphere refraction (Earth observers only).",
            examples=[False],
        ),
    ] = False,
) -> list[AltAzEntry]:
    query = altaz_query(
        body=body, lat=lat, lon=lon, elev=elev, tt=tt, targets=targets, refraction=refraction
    )
    started = time.perf_counter()
    with _mapped_astro_errors():
        results = compute_altaz(sky, query)
    entries = [altaz_entry(result) for result in results]
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    response.headers["Cache-Control"] = CACHE_COMPUTE
    response.headers["Server-Timing"] = server_timing(elapsed_ms)
    return entries
