"""OpenAPI snapshot (brief api_contract/conformance l.182).

The committed `docs/openapi.json` is what the frontend types are generated from; a contract
change must update it in the same commit, deliberately.
"""

from pathlib import Path

import pytest

from skyapi.main import create_app
from skyapi.settings import Settings
from skyapi.tools.dump_openapi import render_openapi

pytestmark = pytest.mark.api

# tests/api/<this file> -> tests/api -> tests -> backend -> repository root
REPO_ROOT = Path(__file__).resolve().parents[3]
SNAPSHOT = REPO_ROOT / "docs" / "openapi.json"


def test_committed_openapi_document_matches_the_app(settings: Settings) -> None:
    rendered = render_openapi(create_app(settings))

    assert SNAPSHOT.is_file(), f"{SNAPSHOT} is missing: run `make types`"
    assert rendered == SNAPSHOT.read_text(encoding="utf-8"), "run `make types`"
