"""The packaged data registry and its validation (D29, D30)."""

import itertools
import json
import re
from pathlib import Path

import pytest

from skyapi.data.registry import RegistryError, load_registry, parse_registry

pytestmark = pytest.mark.unit

BACKEND_ROOT = Path(__file__).resolve().parents[2]
EXPECTED_KEYS = {
    "de440s",
    "de440",
    "de441",
    "pck00011",
    "pck00010",
    "moon_tf",
    "moon_bpc",
    "hipparcos",
    "hyg",
    "ngc",
    "ngc_addendum",
    "stellarium_modern",
    "stellarium_description",
    "d3_bounds",
    "constellation_names",
    "mpcorb",
    "comets",
    "skyfield_tables",
    "nominatim",
    "lucide",
}
PINNED = {"de440s", "pck00011", "pck00010", "moon_tf", "moon_bpc", "hipparcos", "hyg"}
PENDING = {"de440", "de441"}
REFRESHABLE = {
    "ngc",
    "ngc_addendum",
    "stellarium_modern",
    "stellarium_description",
    "d3_bounds",
    "mpcorb",
    "comets",
}
HEX = set("0123456789abcdef")


def minimal_file(**overrides: object) -> dict[str, object]:
    table: dict[str, object] = {
        "key": "k",
        "kind": "download",
        "filename": "k.dat",
        "url": "https://example.org/k.dat",
        "size_bytes": 10,
        "sha256": "a" * 64,
        "min_size_bytes": 1,
        "group": "stars",
        "refresh": "never",
        "license": "MIT",
        "attribution": "Example",
        "version_or_date": "1",
    }
    table.update(overrides)
    return table


def test_packaged_registry_lists_every_dataset_of_the_brief() -> None:
    registry = load_registry()

    assert {entry.key for entry in registry.files} == EXPECTED_KEYS
    assert {entry.kind for entry in registry.files} == {
        "download",
        "builtin",
        "committed",
        "runtime_service",
        "ui_asset",
    }


def test_every_entry_has_license_and_attribution() -> None:
    for entry in load_registry().files:
        assert entry.license.strip(), entry.key
        assert entry.attribution.strip(), entry.key
        assert entry.version_or_date.strip(), entry.key


def test_every_download_has_url_filename_and_minimum_size() -> None:
    for entry in load_registry().files:
        if entry.is_download:
            assert entry.url is not None, entry.key
            assert entry.url.startswith("https://"), entry.key
            assert entry.filename, entry.key
            assert "/" not in entry.filename, entry.key
            assert entry.min_size_bytes > 0, entry.key


def test_pinned_entries_carry_a_sha256_and_an_exact_size() -> None:
    registry = load_registry()
    for key in PINNED:
        entry = registry.by_key(key)
        assert entry.sha256 is not None, key
        assert len(entry.sha256) == 64, key
        assert set(entry.sha256) <= HEX, key
        assert entry.size_bytes > 0, key
        assert entry.pinned
        assert not entry.sha256_pending


def test_pending_pins_have_a_size_but_no_hash_yet() -> None:
    registry = load_registry()
    for key in PENDING:
        entry = registry.by_key(key)
        assert entry.sha256 is None, key
        assert entry.sha256_pending, key
        assert entry.size_bytes > 0, key
        assert entry.optional, key


def test_refreshable_entries_are_unpinned() -> None:
    registry = load_registry()
    for key in REFRESHABLE:
        entry = registry.by_key(key)
        assert entry.sha256 is None, key
        assert not entry.sha256_pending, key
        assert entry.size_bytes == 0, key
    for entry in registry.files:
        if entry.is_download and entry.key not in REFRESHABLE:
            assert entry.sha256 is not None or entry.sha256_pending, entry.key


def test_mpcorb_is_downloaded_compressed_and_inflated() -> None:
    entry = load_registry().by_key("mpcorb")

    assert entry.gunzip
    assert entry.url is not None
    assert entry.url.endswith("MPCORB.DAT.gz")
    assert entry.filename == "MPCORB.DAT"
    assert entry.notes is not None
    assert "https://data.minorplanetcenter.net/iau/info/MPOrbitFormat.html" in entry.notes
    comets = load_registry().by_key("comets")
    assert comets.notes is not None
    assert "https://data.minorplanetcenter.net/iau/info/CometOrbitFormat.html" in comets.notes


def test_hipparcos_has_the_vizier_mirror_as_fallback() -> None:
    entry = load_registry().by_key("hipparcos")

    assert entry.fallback_urls == ("https://cdsarc.u-strasbg.fr/ftp/cats/I/239/hip_main.dat",)
    assert entry.urls[0] == entry.url


def test_hyg_stays_compressed_and_uses_the_media_url() -> None:
    entry = load_registry().by_key("hyg")

    assert not entry.gunzip
    assert entry.filename == "hyg_v44.csv.gz"
    assert entry.url is not None
    assert "/media/branch/" in entry.url
    assert entry.min_size_bytes >= 1_000_000  # the 133-byte LFS pointer must be refused


def test_default_download_selection_for_de440s() -> None:
    registry = load_registry()

    keys = [entry.key for entry in registry.downloads("de440s.bsp")]

    assert keys[0] == "de440s"
    assert "de440" not in keys
    assert "de441" not in keys
    assert "pck00010" not in keys
    assert set(keys) == {
        "de440s",
        "pck00011",
        "moon_tf",
        "moon_bpc",
        "hipparcos",
        "hyg",
        "ngc",
        "ngc_addendum",
        "stellarium_modern",
        "stellarium_description",
        "d3_bounds",
        "mpcorb",
        "comets",
    }


def test_full_adds_de441_once() -> None:
    registry = load_registry()

    with_full = [entry.key for entry in registry.downloads("de440s.bsp", full=True)]
    de441_first = [entry.key for entry in registry.downloads("de441.bsp", full=True)]

    assert with_full[-1] == "de441"
    assert with_full.count("de441") == 1
    assert de441_first[0] == "de441"
    assert de441_first.count("de441") == 1
    assert "de440s" not in de441_first


def test_unknown_ephemeris_names_the_known_ones() -> None:
    with pytest.raises(RegistryError, match=r"de440s\.bsp") as info:
        load_registry().downloads("de999.bsp")
    assert "de441.bsp" in str(info.value)
    assert "de440.bsp" in str(info.value)


def test_ephemerides_are_the_three_jpl_files() -> None:
    assert [e.filename for e in load_registry().ephemerides()] == [
        "de440s.bsp",
        "de440.bsp",
        "de441.bsp",
    ]


def test_by_key_unknown_raises() -> None:
    with pytest.raises(RegistryError, match="unknown registry key"):
        load_registry().by_key("nope")


def test_license_files_are_packaged_and_readable() -> None:
    registry = load_registry()
    seen: set[str] = set()
    for entry in registry.files:
        if entry.license_file is not None:
            text = registry.license_text(entry)
            assert text is not None, entry.key
            assert text.strip(), entry.key
            seen.add(entry.license_file)
        else:
            assert registry.license_text(entry) is None
    assert seen == {
        "BSD-3-Clause-d3-celestial.txt",
        "MIT-skyfield.txt",
        "ISC-lucide.txt",
        "CC-BY-SA-4.0-notice.txt",
    }
    assert "Olaf Frohn" in registry.license_text(registry.by_key("d3_bounds"))  # type: ignore[operator]


def _normalise(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _license_core(license_text: str) -> str:
    """The leading clause of a registry license string, normalised (before `(`, `:` or `;`)."""
    return _normalise(re.split(r"[(:;]", license_text, maxsplit=1)[0])


def test_excerpts_exist_are_small_and_declare_source_and_license() -> None:
    """Brief l.325: every committed excerpt is under 1 MB and states its source and license.

    Passes with zero registered excerpts; checks each one that is registered.
    """
    registry = load_registry()
    for excerpt in registry.excerpts:
        path = BACKEND_ROOT / excerpt.path
        source = registry.by_key(excerpt.source_key)
        assert path.is_file(), f"missing excerpt {excerpt.path}"
        assert path.stat().st_size < 1_000_000, f"{excerpt.path} exceeds 1 MB"
        assert source.url is not None
        head = path.read_text(encoding="utf-8", errors="replace")[:8192]
        if path.suffix == ".json":
            provenance = json.loads(path.read_text(encoding="utf-8"))["_provenance"]
            blob = json.dumps(provenance)
        else:
            # The provenance header is the block of leading `#` lines (D40); the readers strip it.
            header_lines = itertools.takewhile(lambda line: line.startswith("#"), head.splitlines())
            blob = "\n".join(header_lines)
            assert blob, f"{excerpt.path}: no leading `#` provenance header"
        assert source.url in blob, f"{excerpt.path}: provenance header lacks the source URL"
        # Registry licenses are SPDX-style ("CC-BY-SA-4.0"); headers spell them for humans
        # ("CC BY-SA 4.0"), so compare the leading clause of each without punctuation or case.
        assert _license_core(source.license) in _normalise(blob), (
            f"{excerpt.path}: provenance header lacks the license {source.license!r}"
        )


def test_minimal_document_parses() -> None:
    registry = parse_registry({"files": [minimal_file()]})

    assert registry.by_key("k").filename == "k.dat"
    assert registry.excerpts == ()


def test_plain_http_is_accepted_for_the_loopback_host_only() -> None:
    parse_registry({"files": [minimal_file(url="http://127.0.0.1:8080/k.dat")]})
    parse_registry({"files": [minimal_file(url="http://localhost/k.dat")]})
    with pytest.raises(RegistryError, match="must use https"):
        parse_registry({"files": [minimal_file(url="http://127.0.0.1.example.org/k.dat")]})


@pytest.mark.parametrize(
    ("document", "message"),
    [
        (
            {"files": [minimal_file(), minimal_file(filename="other.dat")]},
            "duplicate registry keys",
        ),
        ({"files": [minimal_file(), minimal_file(key="k2")]}, "duplicate registry filenames"),
        ({"files": [minimal_file(sha256="xyz")]}, "64 lowercase hex"),
        ({"files": [minimal_file(url=None)]}, "need a 'url'"),
        ({"files": [minimal_file(url="http://example.org/k")]}, "must use https"),
        ({"files": [minimal_file(license="")]}, "'license' must not be empty"),
        ({"files": [minimal_file(attribution="  ")]}, "'attribution' must not be empty"),
        (
            {"files": [minimal_file(license_file="nope.txt")]},
            "not found under skyapi/data/licenses",
        ),
        ({"files": [minimal_file(kind="magic")]}, "'kind' must be one of"),
        ({"files": [minimal_file(group="elsewhere")]}, "'group' must be one of"),
        ({"files": [minimal_file(refresh="hourly")]}, "'refresh' must be one of"),
        ({"files": [minimal_file(sha256_pending=True)]}, "exclusive"),
        (
            {
                "files": [
                    minimal_file(sha256=None, sha256_pending=False, size_bytes=0, min_size_bytes=0)
                ]
            },
            "positive 'min_size_bytes'",
        ),
        ({"files": [minimal_file(size_bytes=0)]}, "pinned file needs its exact 'size_bytes'"),
        ({"files": [minimal_file(bogus=1)]}, "unknown fields"),
        ({"files": [minimal_file(size_bytes=-1)]}, "non-negative integer"),
        ({"files": [minimal_file(gunzip="yes")]}, "must be a boolean"),
        ({"files": [minimal_file(fallback_urls="https://x")]}, "array of strings"),
        (
            {
                "files": [
                    minimal_file(
                        kind="builtin", url=None, sha256=None, sha256_pending=False, optional=True
                    )
                ]
            },
            "'optional' applies to downloads only",
        ),
        ({"files": [minimal_file(kind="committed", url=None)]}, "only downloads carry sha256"),
        ({"files": "nope"}, "must be an array of tables"),
        ({"files": ["nope"]}, "entries must be tables"),
        (
            {
                "files": [minimal_file()],
                "excerpts": [{"path": "x", "source_key": "zz", "description": "d"}],
            },
            "unknown source_key",
        ),
        (
            {"files": [minimal_file()], "excerpts": [{"path": "x", "source_key": "k"}]},
            "missing 'description'",
        ),
    ],
)
def test_invalid_documents_are_rejected(document: dict[str, object], message: str) -> None:
    with pytest.raises(RegistryError, match=message):
        parse_registry(document)


def test_unreadable_file_raises(tmp_path: Path) -> None:
    with pytest.raises(RegistryError, match="cannot read registry"):
        load_registry(tmp_path / "missing.toml")
    broken = tmp_path / "broken.toml"
    broken.write_text("[[files]\n", encoding="utf-8")
    with pytest.raises(RegistryError, match="invalid registry"):
        load_registry(broken)
