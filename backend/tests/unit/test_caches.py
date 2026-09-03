"""Cache orchestration and bookkeeping with fake builders (D33)."""

import json
import logging
from dataclasses import replace
from importlib import resources
from pathlib import Path

import pytest

from skyapi.catalogs.artifacts import CACHE_FORMAT_VERSION
from skyapi.data.caches import (
    ArtifactRecord,
    CacheError,
    CacheManifest,
    MissingSourceError,
    build_all,
    cache_paths,
    caches_are_current,
    verify_caches,
)
from skyapi.data.download import sha256_of
from skyapi.data.registry import Registry, load_registry
from support.fixtures_data import MPC_KEYS, SOURCE_KEYS, FakeBuilders, write_sources

pytestmark = pytest.mark.unit

# Every source the manifest records: the downloads plus the committed constellation names CSV.
ALL_SOURCES = {*SOURCE_KEYS, "constellation_names"}


@pytest.fixture
def registry() -> Registry:
    return load_registry()


@pytest.fixture
def fake() -> FakeBuilders:
    return FakeBuilders()


def test_build_all_writes_every_group_and_the_manifest(
    data_dir: Path, registry: Registry, fake: FakeBuilders
) -> None:
    write_sources(data_dir, registry)

    manifest = build_all(data_dir, registry, builders=fake.as_builders())

    assert fake.calls == ["stars", "dso", "constellations", "mpc"]
    assert set(manifest.sources) == ALL_SOURCES
    assert set(manifest.artifacts) == {
        "stars",
        "stars_index",
        "hipparcos",
        "dso",
        "constellations",
        "mpc_asteroids",
        "mpc_comets",
        "mpc_index",
    }
    assert manifest.cache_format_version == CACHE_FORMAT_VERSION
    assert manifest.artifacts["mpc_index"].path == "mpc/index.parquet"
    assert manifest.artifacts["constellations"].declared_license == "CC BY-SA 4.0"
    assert manifest.artifacts["mpc_index"].meta["elements_epoch_range_tt"] == (2460000.5, 2461000.5)
    paths = cache_paths(data_dir)
    assert paths.manifest.is_file()
    assert CacheManifest.load(paths.manifest) == manifest
    document = json.loads(paths.manifest.read_text())
    assert set(document) == {
        "cache_format_version",
        "skyapi_version",
        "built_at",
        "sources",
        "artifacts",
    }
    assert set(document["artifacts"]["dso"]) == {
        "path",
        "sha256",
        "bytes",
        "count",
        "version",
        "source_keys",
        "declared_license",
        "meta",
    }
    assert verify_caches(data_dir) == []
    assert caches_are_current(data_dir, registry, manifest)


def test_second_build_is_a_no_op(data_dir: Path, registry: Registry, fake: FakeBuilders) -> None:
    write_sources(data_dir, registry)
    first = build_all(data_dir, registry, builders=fake.as_builders())
    fake.calls.clear()

    second = build_all(data_dir, registry, builders=fake.as_builders())

    assert fake.calls == []
    assert second.artifacts == first.artifacts
    assert second.sources == first.sources


def test_changed_source_rebuilds_only_its_group(
    data_dir: Path, registry: Registry, fake: FakeBuilders
) -> None:
    write_sources(data_dir, registry)
    before = build_all(data_dir, registry, builders=fake.as_builders())
    fake.calls.clear()
    (data_dir / registry.by_key("ngc").filename).write_text("a new OpenNGC release\n")

    after = build_all(data_dir, registry, builders=fake.as_builders())

    assert fake.calls == ["dso"]
    assert after.artifacts["dso"] != before.artifacts["dso"]
    assert after.artifacts["stars"] == before.artifacts["stars"]
    assert after.sources["ngc"] != before.sources["ngc"]
    assert not caches_are_current(data_dir, registry, before)
    assert caches_are_current(data_dir, registry, after)


def test_changed_hipparcos_rebuilds_stars_and_constellations(
    data_dir: Path, registry: Registry, fake: FakeBuilders
) -> None:
    write_sources(data_dir, registry)
    build_all(data_dir, registry, builders=fake.as_builders())
    fake.calls.clear()
    (data_dir / registry.by_key("hipparcos").filename).write_text("new rows\n")

    build_all(data_dir, registry, builders=fake.as_builders())

    assert fake.calls == ["stars", "constellations"]


def test_missing_or_corrupt_artifact_triggers_its_group(
    data_dir: Path, registry: Registry, fake: FakeBuilders
) -> None:
    write_sources(data_dir, registry)
    build_all(data_dir, registry, builders=fake.as_builders())
    paths = cache_paths(data_dir)
    paths.dso_json.unlink()
    paths.mpc_comets.write_bytes(b"garbage")
    problems = verify_caches(data_dir)
    assert problems == [
        "dso: dso.json missing",
        "mpc_comets: mpc/comets.parquet does not match its recorded sha256",
    ]
    fake.calls.clear()

    build_all(data_dir, registry, builders=fake.as_builders())

    assert fake.calls == ["dso", "mpc"]
    assert verify_caches(data_dir) == []


def test_force_rebuilds_everything(data_dir: Path, registry: Registry, fake: FakeBuilders) -> None:
    write_sources(data_dir, registry)
    build_all(data_dir, registry, builders=fake.as_builders())
    fake.calls.clear()

    build_all(data_dir, registry, force=True, builders=fake.as_builders())

    assert fake.calls == ["stars", "dso", "constellations", "mpc"]


def test_dso_options_change_rebuilds_dso(
    data_dir: Path, registry: Registry, fake: FakeBuilders
) -> None:
    write_sources(data_dir, registry)
    build_all(data_dir, registry, builders=fake.as_builders())
    fake.calls.clear()

    manifest = build_all(data_dir, registry, dso_mag_limit=12.0, builders=fake.as_builders())

    assert fake.calls == ["dso"]
    assert manifest.artifacts["dso"].meta == {"mag_limit": 12.0, "size_arcmin": 5.0}


def test_missing_mpc_files_skip_the_optional_group_with_a_warning(
    data_dir: Path, registry: Registry, fake: FakeBuilders, caplog: pytest.LogCaptureFixture
) -> None:
    write_sources(data_dir, registry, tuple(key for key in SOURCE_KEYS if key not in MPC_KEYS))

    with caplog.at_level(logging.WARNING, logger="skyapi.data.caches"):
        manifest = build_all(data_dir, registry, builders=fake.as_builders())

    assert fake.calls == ["stars", "dso", "constellations"]
    assert "mpcorb, comets missing" in caplog.text
    assert "optional" in caplog.text
    assert not any(key in manifest.sources for key in MPC_KEYS)
    assert not any(name.startswith("mpc") for name in manifest.artifacts)
    assert caches_are_current(data_dir, registry, manifest)
    fake.calls.clear()
    write_sources(data_dir, registry, MPC_KEYS)

    later = build_all(data_dir, registry, builders=fake.as_builders())

    assert fake.calls == ["mpc"]
    assert set(later.sources) == ALL_SOURCES


def test_mpc_records_are_kept_when_the_raw_files_are_deleted(
    data_dir: Path, registry: Registry, fake: FakeBuilders
) -> None:
    write_sources(data_dir, registry)
    first = build_all(data_dir, registry, builders=fake.as_builders())
    for key in MPC_KEYS:
        (data_dir / registry.by_key(key).filename).unlink()
    fake.calls.clear()

    second = build_all(data_dir, registry, builders=fake.as_builders())

    assert fake.calls == []
    assert second.artifacts["mpc_index"] == first.artifacts["mpc_index"]
    assert second.sources["mpcorb"] == first.sources["mpcorb"]


def test_missing_required_source_raises(
    data_dir: Path, registry: Registry, fake: FakeBuilders
) -> None:
    write_sources(data_dir, registry, ("hipparcos",))

    with pytest.raises(MissingSourceError, match="missing hyg in DATA_DIR"):
        build_all(data_dir, registry, builders=fake.as_builders())

    assert fake.calls == []


def test_constellation_names_csv_hash_participates_in_staleness(
    data_dir: Path, registry: Registry, fake: FakeBuilders
) -> None:
    # The committed CSV (ADR-0005) never lies in DATA_DIR: its packaged copy is hashed, and a
    # recorded hash that no longer matches (the file was edited) rebuilds the constellations.
    write_sources(data_dir, registry)
    manifest = build_all(data_dir, registry, builders=fake.as_builders())
    csv = resources.files("skyapi.data") / registry.by_key("constellation_names").filename
    with resources.as_file(csv) as path:
        assert manifest.sources["constellation_names"] == sha256_of(path)
    assert not (data_dir / "constellation_names.csv").exists()
    fake.calls.clear()
    edited = replace(manifest, sources={**manifest.sources, "constellation_names": "0" * 64})
    edited.save(cache_paths(data_dir).manifest)
    assert not caches_are_current(data_dir, registry, edited)

    after = build_all(data_dir, registry, builders=fake.as_builders())

    assert fake.calls == ["constellations"]
    assert after.sources["constellation_names"] == manifest.sources["constellation_names"]
    assert caches_are_current(data_dir, registry, after)


def test_missing_optional_dso_and_constellation_sources_skip_their_groups(
    data_dir: Path, registry: Registry, fake: FakeBuilders, caplog: pytest.LogCaptureFixture
) -> None:
    # Brief l.280: OpenNGC and the Stellarium/d3-celestial files are `required = false` in the
    # registry; without them the build succeeds with a warning and the other groups are built.
    optional = ("ngc", "ngc_addendum", "stellarium_modern", "stellarium_description", "d3_bounds")
    assert all(not registry.by_key(key).required for key in optional)
    assert registry.by_key("hyg").required
    write_sources(data_dir, registry, tuple(key for key in SOURCE_KEYS if key not in optional))

    with caplog.at_level(logging.WARNING, logger="skyapi.data.caches"):
        manifest = build_all(data_dir, registry, builders=fake.as_builders())

    assert fake.calls == ["stars", "mpc"]
    assert "dso cache skipped: ngc, ngc_addendum missing" in caplog.text
    assert (
        "constellations cache skipped: stellarium_modern, stellarium_description, d3_bounds missing"
        in caplog.text
    )
    assert not any(key in manifest.sources for key in optional)
    assert "dso" not in manifest.artifacts
    assert "constellations" not in manifest.artifacts
    assert caches_are_current(data_dir, registry, manifest)


def test_caches_are_current_edge_cases(
    data_dir: Path, registry: Registry, fake: FakeBuilders
) -> None:
    write_sources(data_dir, registry)
    manifest = build_all(data_dir, registry, builders=fake.as_builders())

    assert not caches_are_current(data_dir, registry, None)
    assert not caches_are_current(
        data_dir, registry, replace(manifest, cache_format_version=CACHE_FORMAT_VERSION + 1)
    )
    (data_dir / registry.by_key("comets").filename).unlink()
    assert not caches_are_current(data_dir, registry, manifest)


def test_verify_caches_without_a_manifest(data_dir: Path) -> None:
    problems = verify_caches(data_dir)

    assert len(problems) == 1
    assert "caches not built" in problems[0]
    cache_paths(data_dir).root.mkdir()
    cache_paths(data_dir).manifest.write_text("{")
    assert "unreadable cache manifest" in verify_caches(data_dir)[0]


def test_format_version_mismatch_is_reported_and_rebuilt(
    data_dir: Path, registry: Registry, fake: FakeBuilders
) -> None:
    write_sources(data_dir, registry)
    manifest = build_all(data_dir, registry, builders=fake.as_builders())
    replace(manifest, cache_format_version=CACHE_FORMAT_VERSION + 1).save(
        cache_paths(data_dir).manifest
    )
    fake.calls.clear()

    assert verify_caches(data_dir)[0].startswith("cache format version")
    build_all(data_dir, registry, builders=fake.as_builders())
    assert fake.calls == ["stars", "dso", "constellations", "mpc"]


def test_manifest_json_round_trip_and_validation(tmp_path: Path) -> None:
    record = ArtifactRecord(
        path="dso.json",
        sha256="a" * 64,
        bytes=3,
        count=2,
        version="1-abc",
        source_keys=("ngc",),
        meta={"mag_limit": 14.0, "culture": "modern", "range": (1.0, 2.0), "none": None},
        declared_license=None,
    )
    manifest = CacheManifest(
        CACHE_FORMAT_VERSION,
        "0.1.0",
        "2026-09-03T00:00:00+00:00",
        {"ngc": "b" * 64},
        {"dso": record},
    )
    path = tmp_path / "manifest.json"
    manifest.save(path)

    assert CacheManifest.load(path) == manifest
    assert CacheManifest.load(tmp_path / "absent.json") is None

    for broken in (
        {"cache_format_version": "1"},
        {
            "cache_format_version": 1,
            "skyapi_version": "x",
            "built_at": "y",
            "sources": [],
            "artifacts": {},
        },
        {
            "cache_format_version": 1,
            "skyapi_version": "x",
            "built_at": "y",
            "sources": {},
            "artifacts": {
                "a": {
                    "path": "p",
                    "sha256": "s",
                    "bytes": 1,
                    "count": 1,
                    "version": "v",
                    "source_keys": ["k"],
                    "meta": {"bad": [1, 2, 3]},
                }
            },
        },
    ):
        path.write_text(json.dumps(broken))
        with pytest.raises(CacheError):
            CacheManifest.load(path)
