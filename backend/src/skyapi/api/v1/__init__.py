"""API v1 router: base path `/api/v1` (brief api_contract/conventions l.102)."""

from fastapi import APIRouter

from skyapi.api import API_VERSION
from skyapi.api.v1 import catalogs, health, meta, minor_bodies, sky

__all__ = ["API_VERSION", "router"]

router = APIRouter(prefix="/api/v1")
router.include_router(health.router)
router.include_router(meta.router)
router.include_router(catalogs.router)
router.include_router(minor_bodies.router)
router.include_router(sky.router)
