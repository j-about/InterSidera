"""`GET /health` (brief api_contract l.112-113, D52).

`starting` answers 503 with `Retry-After` and the same JSON body (progress included while a file
downloads) so the Docker healthcheck fails until the data is loaded and the frontend splash can
still read the progress; `ready` and `degraded` answer 200. Never cached.
"""

from importlib.metadata import version

from fastapi import APIRouter, Response

from skyapi.api.deps import BootstrapDep
from skyapi.middleware.caching import NO_STORE
from skyapi.middleware.problem import problem_responses
from skyapi.models.health import HealthResponse

router = APIRouter(tags=["health"])

STARTING_RETRY_AFTER_SECONDS = 5
_VERSION = version("skyapi")


@router.get(
    "/health",
    response_model=HealthResponse,
    # `progress`, `missing` and `detail` are absent (not `null`) when they do not apply, as the
    # contract's optional fields read.
    response_model_exclude_none=True,
    summary="Readiness of the API and its data",
    description=(
        "Reports whether the sky data is loaded. `starting` (HTTP 503 with `Retry-After`) "
        "carries the download progress of the file currently being fetched, or `detail` when "
        "the bootstrap failed; `degraded` (200) lists the `missing` data groups whose endpoints "
        "answer 503; `ready` (200) means every endpoint answers. Never cached "
        "(`Cache-Control: no-store`)."
    ),
    responses={
        503: {
            "model": HealthResponse,
            "description": "Starting: data is being fetched or loaded (`Retry-After`), "
            "or the bootstrap failed (`detail`).",
        },
        **problem_responses(),
    },
)
async def get_health(bootstrap: BootstrapDep) -> Response:
    # `async def` is acceptable here because the route does no I/O and no computation;
    # compute endpoints must be plain `def` (brief pitfalls l.531).
    snapshot = bootstrap.snapshot
    body = HealthResponse(
        status=snapshot.status,
        progress=snapshot.progress,
        missing=list(snapshot.missing) or None,
        detail=snapshot.detail,
        version=_VERSION,
    )
    headers = {"Cache-Control": NO_STORE}
    status_code = 200
    if snapshot.status == "starting":
        status_code = 503
        headers["Retry-After"] = str(STARTING_RETRY_AFTER_SECONDS)
    return Response(
        content=body.model_dump_json(exclude_none=True),
        status_code=status_code,
        media_type="application/json",
        headers=headers,
    )
