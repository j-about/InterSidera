"""`GET /meta` (brief api_contract l.115-129, D60).

Every field but `server_time` is `SkyState.meta`, assembled once by the bootstrap
(`skyapi/meta.py`) from the kernels, `cache/manifest.json` and the data registry. The route
reads the clock, adds `server_time` and answers `Cache-Control: no-store` (brief l.105).
"""

from fastapi import APIRouter, Response

from skyapi.api.deps import SkyStateDep
from skyapi.astro.time import now, tt_minus_utc_seconds, utc_iso
from skyapi.middleware.caching import NO_STORE
from skyapi.middleware.problem import problem_responses
from skyapi.models.meta import MetaResponse, ServerTime
from skyapi.state import SkyState

router = APIRouter(tags=["meta"])


def server_time(sky: SkyState) -> ServerTime:
    """`server_time` of `/meta`: the clock as a TT Julian Date, UTC text and TT - UTC."""
    t = now(sky.astro.ts)
    utc = utc_iso(t)
    seconds, _ = tt_minus_utc_seconds(t)
    return ServerTime(
        tt=float(t.tt),
        # A scalar `Time` formats to one string; the list branch exists for arrays only.
        utc=utc if isinstance(utc, str) else utc[0],
        tt_minus_utc_seconds=float(seconds),
    )


@router.get(
    "/meta",
    response_model=MetaResponse,
    # Optional entries (`geocoder.email`, `observers[].approximation_code`, the degraded
    # `catalogs.*`) are absent, not `null`, as the contract's `?` fields read.
    response_model_exclude_none=True,
    summary="Contract version, server time, coverage, observers, bodies, catalogs and limits",
    description=(
        "Everything a client needs before its first sky request, computed once at startup "
        "except `server_time` (`tt`, `utc`, `tt_minus_utc_seconds`, read from the server clock "
        "on every call). `ephemeris` names the JPL kernel and its TT range; `coverage` gives "
        "the ranges the warnings refer to: the ephemeris, the tabulated delta T (`observed_tt` "
        "and the end of the IERS predictions), the span the IAU rotation models are fitted to, "
        "the proper-motion extrapolation limit in years and the MPC element ages that raise "
        "`mpc_extrapolation` (warn) and `mpc_unreliable` (error). `observers[]` lists the ten "
        "bodies one can stand on with their body-fixed frame (`ITRS`, `MOON_ME_DE440_ME421`, "
        "`IAU_<BODY>`), IAU ellipsoid radii, latitude convention and the TT range the frame and "
        "the ephemeris serve; `pluto` is approximated by the Pluto-system barycenter "
        "(`approximation_code`). `bodies[]` lists the Sun, planets, Moon and Pluto with the "
        "`limits.max_step_s` class that bounds `step_s` when they are requested. `catalogs` "
        "describes the star, deep-sky, constellation and minor-body data: counts, cache "
        "versions, the bare SHA-256 `etag` the `/catalogs/*` routes send quoted, the star "
        "catalog epoch and magnitude limit, licenses and attributions; an entry is absent while "
        "its data is missing (`/health` says `degraded`). `geocoder` tells whether Nominatim "
        "lookups are enabled, the URL, the contact e-mail to send when configured, the "
        "attribution to display and the minimum interval between requests (1000 ms). `limits` "
        "carries the request caps (`max_samples` 64, `max_minor_bodies` 100, `max_targets` "
        "200), the time-lapse speeds of the reference frontend and `max_step_s` per body class. "
        "Never cached (`Cache-Control: no-store`); 503 with `Retry-After` while the data loads."
    ),
    responses=problem_responses(503),
)
def get_meta(sky: SkyStateDep) -> Response:
    # Plain `def`: `ts.now()` is the only computation, but the route stays on the thread pool
    # like every data-dependent endpoint (brief pitfalls l.531).
    meta = sky.meta
    body = MetaResponse(
        api_version=meta.api_version,
        server_time=server_time(sky),
        ephemeris=meta.ephemeris,
        observers=meta.observers,
        coverage=meta.coverage,
        bodies=meta.bodies,
        catalogs=meta.catalogs,
        geocoder=meta.geocoder,
        limits=meta.limits,
    )
    return Response(
        content=body.model_dump_json(exclude_none=True),
        media_type="application/json",
        headers={"Cache-Control": NO_STORE},
    )
