"""`/minor-bodies/search` and `/minor-bodies/defaults` (brief l.152-155, D61).

Both read the in-memory MPC index of `SkyState.minor_bodies` (`astro/minor_bodies.py`). The
brief names no cache policy for them: they answer `Cache-Control: public, max-age=300` like the
compute endpoints (backlog B-44) and 503 with `Retry-After` while the MPC data is missing
(degraded). Ids are `a:<number>` / `a:<packed designation>` for asteroids and `c:<designation>`
with spaces replaced by `_` for comets (`c:1P`, `c:C/2023_A3`); they are URL-safe and used by
`/sky/frame`, `/sky/altaz` and the frontend URL.
"""

from typing import Annotated

from fastapi import APIRouter, Query, Response
from pydantic import TypeAdapter

from skyapi.api.deps import SkyStateDep
from skyapi.astro.minor_bodies import MinorBodyIndex, defaults, search
from skyapi.astro.sampling import MAX_MINOR_BODIES
from skyapi.astro.time import now
from skyapi.middleware.caching import CACHE_COMPUTE
from skyapi.middleware.problem import DataNotReadyError, problem_responses
from skyapi.middleware.ratelimit import RateLimited
from skyapi.models.catalogs import MinorBodySummary
from skyapi.state import SkyState

router = APIRouter(tags=["minor-bodies"])

QUERY_MAX_LENGTH = 64
SEARCH_DEFAULT_LIMIT = 20
SEARCH_MAX_LIMIT = 100
# The MPC data stays missing until the operator runs `sky-data fetch` (brief l.280).
DEGRADED_RETRY_AFTER_SECONDS = 60

_SUMMARIES: TypeAdapter[list[MinorBodySummary]] = TypeAdapter(list[MinorBodySummary])


def _index(sky: SkyState) -> MinorBodyIndex:
    if sky.minor_bodies is None:
        raise DataNotReadyError(
            "the minor-body tables are not loaded: the MPC data is missing (degraded)",
            retry_after=DEGRADED_RETRY_AFTER_SECONDS,
        )
    return sky.minor_bodies.index


def _respond(entries: list[MinorBodySummary]) -> Response:
    # `name` and `h_mag` are absent, not `null`, when unknown (the contract's `?` fields).
    return Response(
        content=_SUMMARIES.dump_json(entries, exclude_none=True),
        media_type="application/json",
        headers={"Cache-Control": CACHE_COMPUTE},
    )


@router.get(
    "/minor-bodies/search",
    response_model=list[MinorBodySummary],
    response_model_exclude_none=True,
    dependencies=[RateLimited],
    summary="Search asteroids and comets by id, designation or name",
    description=(
        "Case-insensitive search over the MPC orbit tables: an exact id (`a:433`, `c:1P`), a "
        "bare number (`433`), a short comet form (`1P`), a designation prefix (`2024 YR`, "
        "`C/2023`) or a substring of a name (`ceres`, `hale`). Results carry the URL-safe id to "
        "use in `/sky/frame` and `/sky/altaz`, the MPC designation, the name when the object has "
        "one, the kind, the absolute magnitude H (asteroids) and the epoch of the orbital "
        "elements. Name matches are ranked by brightness; at most `limit` entries. Rate-limited "
        "per client IP (429 with `Retry-After`); `Cache-Control: public, max-age=300`; 503 "
        "with `Retry-After` while the MPC data is missing."
    ),
    responses=problem_responses(400, 429, 503),
)
def search_minor_bodies(
    sky: SkyStateDep,
    q: Annotated[
        str,
        Query(
            min_length=1,
            max_length=QUERY_MAX_LENGTH,
            description="Id, number, designation prefix or name substring; whitespace is "
            "collapsed and the match is case-insensitive.",
            examples=["ceres", "433", "2024 YR", "1P", "C/2023 A3"],
        ),
    ],
    limit: Annotated[
        int,
        Query(
            ge=1,
            le=SEARCH_MAX_LIMIT,
            description="Maximum number of results.",
            examples=[SEARCH_DEFAULT_LIMIT],
        ),
    ] = SEARCH_DEFAULT_LIMIT,
) -> Response:
    return _respond(search(_index(sky), q, limit))


@router.get(
    "/minor-bodies/defaults",
    response_model=list[MinorBodySummary],
    response_model_exclude_none=True,
    summary="Default minor bodies ranked by expected brightness",
    description=(
        "At most `limits.max_minor_bodies` (100) entries in the shape of `/minor-bodies/search`: "
        "the asteroids with H <= 9 sorted by H (Pluto excluded: it is served as a major body), "
        "then the comets whose orbital-element epoch lies within 2 years of the server date, "
        "sorted by the proximity of their perihelion to the server date. Depends on the server "
        "clock only; `Cache-Control: public, max-age=300`; 503 with `Retry-After` while the MPC "
        "data is missing."
    ),
    responses=problem_responses(503),
)
def default_minor_bodies(sky: SkyStateDep) -> Response:
    index = _index(sky)
    now_tt = float(now(sky.astro.ts).tt)
    return _respond(defaults(index, now_tt, MAX_MINOR_BODIES))
