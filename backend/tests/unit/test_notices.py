"""`THIRD_PARTY_NOTICES.md` rendering: deterministic, complete, equal to the committed file."""

import json
import re
from pathlib import Path

import pytest

from skyapi.data.registry import Registry, load_registry, parse_registry
from skyapi.tools.render_notices import (
    committed_location,
    credits_entries,
    main,
    render_credits,
    render_notices,
)

pytestmark = pytest.mark.unit

REPO_ROOT = Path(__file__).resolve().parents[3]
NOTICES = REPO_ROOT / "THIRD_PARTY_NOTICES.md"
CREDITS = REPO_ROOT / "frontend" / "src" / "data" / "credits.json"
CREDIT_KEYS = {
    "key",
    "filename",
    "kind",
    "url",
    "fallback_urls",
    "version_or_date",
    "license",
    "copyright",
    "attribution",
    "license_text",
    "notes",
}


@pytest.fixture
def registry() -> Registry:
    return load_registry()


def test_rendering_is_deterministic_and_carries_no_timestamp(registry: Registry) -> None:
    first = render_notices(registry)
    second = render_notices(registry)

    assert first == second
    assert not re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", first)
    assert first.endswith("\n")
    assert not first.endswith("\n\n")
    assert not any(line != line.rstrip() for line in first.splitlines())


def test_every_registry_entry_and_license_text_is_listed(registry: Registry) -> None:
    text = render_notices(registry)

    headings = [line for line in text.splitlines() if line.startswith("## ")]
    assert len(headings) == len(registry.files) + 1  # plus the excerpts section
    for entry in registry.files:
        assert f"## {entry.filename} (`{entry.key}`)" in text
        assert entry.attribution in text
        assert entry.license in text
        assert entry.version_or_date in text
        if entry.url is not None:
            assert f"<{entry.url}>" in text
        for url in entry.fallback_urls:
            assert f"<{url}>" in text
        license_text = registry.license_text(entry)
        if license_text is not None:
            assert license_text.strip().splitlines()[0] in text
            assert f"licenses/{entry.license_file}" in text
    assert "Olaf Frohn" in text
    assert "Brandon Rhodes" in text
    assert "Lucide" in text
    assert "https://creativecommons.org/licenses/by-sa/4.0/" in text
    assert "docs/brief.xml` l.326" in text
    assert "## Test excerpts" in text
    for excerpt in registry.excerpts:
        assert f"`{excerpt.path}`" in text
        assert excerpt.description in text


def test_excerpts_section_lists_each_excerpt() -> None:
    document = {
        "files": [
            {
                "key": "src",
                "kind": "download",
                "filename": "src.dat",
                "url": "https://example.org/src.dat",
                "size_bytes": 0,
                "min_size_bytes": 1,
                "group": "stars",
                "refresh": "yearly",
                "license": "CC-BY-4.0",
                "attribution": "Example catalog",
                "version_or_date": "v1",
            }
        ],
        "excerpts": [
            {
                "path": "tests/fixtures/excerpts/src_excerpt.dat",
                "source_key": "src",
                "description": "first rows",
            }
        ],
    }
    text = render_notices(parse_registry(document))

    expected = (
        "- `tests/fixtures/excerpts/src_excerpt.dat`: first rows "
        "(from `src`, Example catalog; CC-BY-4.0)"
    )
    assert expected in text
    assert "No excerpt is registered yet." not in text
    assert "No excerpt is registered yet." in render_notices(
        parse_registry({"files": document["files"]})
    )


def test_committed_notices_file_is_up_to_date(registry: Registry) -> None:
    assert NOTICES.is_file(), "THIRD_PARTY_NOTICES.md missing: run `make notices`"
    committed = NOTICES.read_text(encoding="utf-8")

    message = "THIRD_PARTY_NOTICES.md is stale: run `make notices`"
    assert committed == render_notices(registry), message


def test_committed_location_keeps_repository_paths(registry: Registry) -> None:
    names = registry.by_key("constellation_names")
    assert committed_location(names) == "backend/src/skyapi/data/constellation_names.csv"
    presets = registry.by_key("gazetteer")
    assert committed_location(presets) == "frontend/src/state/presets.ts"
    assert f"- Location: `{presets.filename}`" in render_notices(registry)


def test_credits_json_lists_every_entry_with_every_key(registry: Registry) -> None:
    entries = credits_entries(registry)
    assert [entry["key"] for entry in entries] == [file.key for file in registry.files]
    for entry in entries:
        assert set(entry) == CREDIT_KEYS
        assert isinstance(entry["fallback_urls"], list)
    lucide = next(entry for entry in entries if entry["key"] == "lucide")
    assert isinstance(lucide["license_text"], str)
    assert "ISC" in lucide["license_text"]
    text = render_credits(registry)
    assert text.endswith("\n")
    assert not text.endswith("\n\n")
    assert json.loads(text) == entries
    assert render_credits(registry) == text


def test_committed_credits_file_is_up_to_date(registry: Registry) -> None:
    assert CREDITS.is_file(), "frontend/src/data/credits.json missing: run `make notices`"
    message = "frontend/src/data/credits.json is stale: run `make notices`"
    assert CREDITS.read_text(encoding="utf-8") == render_credits(registry), message


def test_main_writes_the_file_and_ignores_the_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, registry: Registry
) -> None:
    monkeypatch.setenv("SKYAPI_WORKERS", "0")
    monkeypatch.setenv("SKYAPI_LOG_LEVEL", "bogus")
    out = tmp_path / "NOTICES.md"
    credits = tmp_path / "data" / "credits.json"

    assert main(["--out", str(out)]) == 0
    assert out.read_text(encoding="utf-8") == render_notices(registry)
    assert out.read_bytes().count(b"\r") == 0
    assert not credits.exists()

    assert main(["--out", str(out), "--json", str(credits)]) == 0
    assert credits.read_text(encoding="utf-8") == render_credits(registry)
    assert credits.read_bytes().count(b"\r") == 0
