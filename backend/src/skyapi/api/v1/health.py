"""`GET /health` (brief api_contract l.112).

`starting` with download progress and the 503 mapping arrive with the M2 lifespan
bootstrap; at M0 the app is ready as soon as the lifespan has run.
"""

from fastapi import APIRouter, Response

from skyapi.api.deps import SkyStateDep
from skyapi.models.health import HealthResponse

router = APIRouter(tags=["health"])


@router.get(
    "/health",
    response_model=HealthResponse,
    # `progress` is absent (not `null`) while nothing is downloading, as the contract's
    # `progress?` optional field reads.
    response_model_exclude_none=True,
    summary="Readiness of the API and its data",
    description=(
        "Reports whether the sky data is loaded. `starting` carries the download progress of "
        "the file currently being fetched; `degraded` means the API answers with reduced "
        "coverage. Never cached (`Cache-Control: no-store`)."
    ),
)
async def get_health(sky: SkyStateDep, response: Response) -> HealthResponse:
    # Brief api_contract/conventions l.105: `/meta` and `/health` -> `no-store`.
    # `async def` is acceptable here because the route does no I/O and no computation;
    # compute endpoints must be plain `def` (brief pitfalls l.531).
    response.headers["Cache-Control"] = "no-store"
    return HealthResponse(status="ready", version=sky.version)
