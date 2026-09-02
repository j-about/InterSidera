"""`dump_openapi` writes the snapshot document whatever the environment says (D27)."""

from pathlib import Path

import pytest
from fastapi import FastAPI

from skyapi.tools.dump_openapi import main, render_openapi

pytestmark = pytest.mark.unit


def test_main_ignores_invalid_environment_variables(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, app: FastAPI
) -> None:
    monkeypatch.setenv("SKYAPI_WORKERS", "0")
    monkeypatch.setenv("SKYAPI_LOG_LEVEL", "bogus")
    out = tmp_path / "openapi.json"

    assert main(["--out", str(out)]) == 0

    # Same bytes as the app built by the test fixtures with explicit settings.
    assert out.read_text(encoding="utf-8") == render_openapi(app)
