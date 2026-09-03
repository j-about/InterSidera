"""Shared fixtures: hermetic settings, the app factory, a lifespan-running client, the test
kernel set (D38) and the scope fixtures of `tests/support/` re-exported by name.

Fixture modules live in `tests/support/` (importable through `pythonpath = ["tests"]`) and are
imported here explicitly rather than through `pytest_plugins`, which pytest rejects outside the
root conftest. `kernels_dir` is defined here, not in `support.fixtures_astro`, because only this
one may download: it verifies the four pinned kernels through the data registry and fetches a
missing or corrupt one (network once; CI restores them from a cache).
"""

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from skyapi.data.download import Manifest, download_file, verify_file
from skyapi.data.registry import load_registry
from skyapi.main import create_app
from skyapi.settings import Settings
from support.fixtures_astro import astro_state, greenwich, jezero, tranquility, ts
from support.fixtures_catalogs import built_caches, catalog_state, excerpts_dir
from support.fixtures_data import (
    data_dir,
    http_root,
    local_data,
    local_registry,
    local_registry_path,
    local_server,
)
from support.fixtures_mpc import (
    de440s_kernel,
    mpc_build,
    mpc_cache,
    mpc_excerpts,
    mpc_index,
    mpc_state,
)

__all__ = [
    "app",
    "astro_state",
    "built_caches",
    "catalog_state",
    "clean_env",
    "client",
    "data_dir",
    "de440s_kernel",
    "excerpts_dir",
    "greenwich",
    "http_root",
    "jezero",
    "kernels_dir",
    "local_data",
    "local_registry",
    "local_registry_path",
    "local_server",
    "mpc_build",
    "mpc_cache",
    "mpc_excerpts",
    "mpc_index",
    "mpc_state",
    "settings",
    "tranquility",
    "ts",
]

# tests/conftest.py -> tests -> backend -> repository root
REPO_ROOT = Path(__file__).resolve().parents[2]
# The test kernel set (D38, B-31): de440s plus the PCK text kernel and the two Moon kernels.
TEST_KERNEL_KEYS = ("de440s", "pck00011", "moon_tf", "moon_bpc")


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove every `SKYAPI_*` variable so neither a developer `.env` nor CI `env:` leaks in.

    R9/D9: `make check` must behave identically from a clean clone and from a machine whose
    shell exports production values; tests set what they need explicitly.
    """
    for name in [key for key in os.environ if key.startswith("SKYAPI_")]:
        monkeypatch.delenv(name)


@pytest.fixture
def settings(clean_env: None, tmp_path_factory: pytest.TempPathFactory) -> Settings:
    """Explicit settings: never auto-fetch, small ephemeris, throwaway DATA_DIR."""
    return Settings(
        data_dir=tmp_path_factory.mktemp("data"),
        auto_fetch=False,
        ephemeris="de440s.bsp",
    )


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    return create_app(settings)


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    # The `with` block runs the lifespan, which is what populates the request state.
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="session")
def kernels_dir() -> Path:
    """Directory of the verified test kernels: `INTERSIDERA_TEST_DATA_DIR` or `<repo>/data`.

    The only ambient variable tests may read (backend-tests rule); it is not `SKYAPI_`-prefixed
    so `clean_env` leaves it alone. Every kernel is checked against its registry pin; a missing
    or corrupt one is downloaded through `skyapi.data.download` (the brief allows de440s and
    these small NAIF kernels in CI, brief l.400, l.428).
    """
    override = os.environ.get("INTERSIDERA_TEST_DATA_DIR")
    directory = Path(override) if override else REPO_ROOT / "data"
    directory.mkdir(parents=True, exist_ok=True)
    registry = load_registry()
    manifest = Manifest.load(directory)
    for key in TEST_KERNEL_KEYS:
        file = registry.by_key(key)
        result = verify_file(file, directory, manifest)
        if result.ok:
            continue
        download_file(file, directory, force=True)
        checked = verify_file(file, directory, Manifest.load(directory))
        if not checked.ok:
            pytest.fail(f"test kernel {file.filename} unusable after download: {checked.message}")
    return directory
