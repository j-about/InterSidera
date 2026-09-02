"""Shared fixtures: hermetic settings, the app factory and a lifespan-running client.

Brief l.368 reserves the session-scoped de440s ephemeris and temporary DATA_DIR for M1;
at M0 the only non-trivial code is settings parsing, so the fixtures stay minimal (D20).
"""

import os
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from skyapi.main import create_app
from skyapi.settings import Settings


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
