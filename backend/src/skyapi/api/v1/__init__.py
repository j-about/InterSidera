"""API v1 router: base path `/api/v1` (brief api_contract/conventions l.102)."""

from fastapi import APIRouter

from skyapi.api.v1 import health

router = APIRouter(prefix="/api/v1")
router.include_router(health.router)
