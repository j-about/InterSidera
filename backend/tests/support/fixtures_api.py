"""Session fixtures for the API tests: an excerpt-backed `DATA_DIR`, the app and a ready client.

`api_data_dir` assembles a scratch `DATA_DIR` the way `make data` would: the four test kernels
(symlinked from `kernels_dir`), the committed excerpts under the registry file names, a generated
Stellarium `description.md`, then `build_all` so the caches carry a real `cache/manifest.json`
(ETags, versions, MPC tables). `api_settings` is built with `default_settings().model_copy(...)`,
never `Settings()`: session fixtures run before the function-scoped `clean_env`. The rate limit
is effectively disabled for the shared client; the 429 test builds its own app.
"""

import time
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from skyapi.data.caches import build_all
from skyapi.data.registry import load_registry
from skyapi.main import create_app
from skyapi.settings import Settings, default_settings
from support.fixtures_catalogs import EXCERPTS_DIR, STELLARIUM_DESCRIPTION_LICENSE_OK

KERNEL_KEYS = ("de440s", "pck00011", "moon_tf", "moon_bpc")
EXCERPT_SOURCES: dict[str, str] = {
    "hipparcos": "hip_main_excerpt.dat",
    "hyg": "hyg_v44_excerpt.csv",
    "ngc": "NGC_excerpt.csv",
    "ngc_addendum": "addendum_excerpt.csv",
    "stellarium_modern": "stellarium_modern_excerpt.json",
    "d3_bounds": "constellations_bounds_excerpt.json",
    "mpcorb": "MPCORB_excerpt.dat",
    "comets": "CometEls_excerpt.txt",
}
GROUP_KEYS: dict[str, tuple[str, ...]] = {
    "dso": ("ngc", "ngc_addendum"),
    "constellations": ("stellarium_modern", "stellarium_description", "d3_bounds"),
    "mpc": ("mpcorb", "comets"),
}
ALL_GROUPS = frozenset(GROUP_KEYS)
READY_TIMEOUT_SECONDS = 120.0


def assemble_data_dir(root: Path, kernels_dir: Path, *, groups: Iterable[str] = ALL_GROUPS) -> Path:
    """Kernels + excerpt sources for `groups` under their registry names, then `build_all`."""
    registry = load_registry()
    root.mkdir(parents=True, exist_ok=True)
    for key in KERNEL_KEYS:
        filename = registry.by_key(key).filename
        (root / filename).symlink_to(kernels_dir / filename)
    wanted = {"hipparcos", "hyg"}
    for group in groups:
        wanted.update(GROUP_KEYS[group])
    for key in wanted:
        filename = registry.by_key(key).filename
        if key == "stellarium_description":
            (root / filename).write_text(STELLARIUM_DESCRIPTION_LICENSE_OK, encoding="utf-8")
        else:
            (root / filename).symlink_to(EXCERPTS_DIR / EXCERPT_SOURCES[key])
    build_all(root, registry)
    return root


def api_settings_for(data_dir: Path, **overrides: Any) -> Settings:
    """Settings for an API test app: excerpt data dir, no fetch, de440s, no effective rate limit."""
    update: dict[str, Any] = {
        "data_dir": data_dir,
        "auto_fetch": False,
        "ephemeris": "de440s.bsp",
        "rate_limit_rps": 1e6,
        "rate_limit_burst": 1_000_000,
    }
    update.update(overrides)
    return default_settings().model_copy(update=update)


def wait_ready(client: TestClient, timeout: float = READY_TIMEOUT_SECONDS) -> dict[str, Any]:
    """Poll `/health` until the status leaves `starting`; fail fast when the bootstrap failed."""
    deadline = time.monotonic() + timeout
    while True:
        body: dict[str, Any] = client.get("/api/v1/health").json()
        if body["status"] != "starting":
            return body
        if body.get("detail"):
            pytest.fail(f"bootstrap failed: {body['detail']}")
        if time.monotonic() > deadline:
            pytest.fail(f"bootstrap still starting after {timeout} s: {body}")
        time.sleep(0.2)


@pytest.fixture(scope="session")
def api_data_dir(kernels_dir: Path, tmp_path_factory: pytest.TempPathFactory) -> Path:
    return assemble_data_dir(tmp_path_factory.mktemp("api-data"), kernels_dir)


@pytest.fixture(scope="session")
def api_settings(api_data_dir: Path) -> Settings:
    return api_settings_for(api_data_dir)


@pytest.fixture(scope="session")
def api_app(api_settings: Settings) -> FastAPI:
    return create_app(api_settings)


@pytest.fixture(scope="session")
def api_client(api_app: FastAPI) -> Iterator[TestClient]:
    with TestClient(api_app) as client:
        wait_ready(client)
        yield client
