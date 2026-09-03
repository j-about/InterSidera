"""The `sky-data` CLI against a local server through `--registry` (D32)."""

import json
from collections.abc import Sequence
from pathlib import Path

import pytest

from skyapi.catalogs.artifacts import CACHE_FORMAT_VERSION
from skyapi.catalogs.builders import BuildError, LicenseChangedError
from skyapi.catalogs.mpc_build import MpcFormatError
from skyapi.catalogs.readers import SourceFormatError
from skyapi.cli import sky_data
from skyapi.cli.sky_data import RESTART_REMINDER, main
from skyapi.data.caches import ArtifactRecord, Builders, CacheError, CacheManifest, cache_paths
from skyapi.data.download import Manifest
from skyapi.data.registry import Registry, load_registry
from support.fixtures_data import SOURCE_KEYS, FakeBuilders, LocalData, write_sources

pytestmark = pytest.mark.unit


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, data_dir: Path) -> Path:
    monkeypatch.setenv("SKYAPI_DATA_DIR", str(data_dir))
    monkeypatch.setenv("SKYAPI_EPHEMERIS", "tiny_eph.bsp")
    return data_dir


def run(local: LocalData, *argv: str) -> int:
    return main(["--registry", str(local.registry_path), *argv])


def files_in(data_dir: Path) -> set[str]:
    return {path.name for path in data_dir.iterdir()}


def test_status_lists_every_entry_with_its_kind_and_license(
    local_data: LocalData, env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert run(local_data, "status") == 0

    out = capsys.readouterr().out
    header = out.splitlines()[0].split()
    assert header == [
        "kind",
        "key",
        "filename",
        "present",
        "size",
        "sha256",
        "license",
        "attribution",
        "refresh",
    ]
    for entry in local_data.registry.files:
        assert entry.key in out
        assert entry.license in out
        assert entry.kind in out
    assert "MIT" in out
    assert "runtime_service" in out


def test_status_json(local_data: LocalData, env: Path, capsys: pytest.CaptureFixture[str]) -> None:
    run(local_data, "fetch", "--only", "tiny_pck")
    capsys.readouterr()

    assert run(local_data, "status", "--json") == 0

    rows = json.loads(capsys.readouterr().out)
    assert [row["key"] for row in rows] == [entry.key for entry in local_data.registry.files]
    by_key = {row["key"]: row for row in rows}
    assert by_key["tiny_pck"]["present"] == "yes"
    assert by_key["tiny_pck"]["sha256"] == "ok (pin)"
    assert by_key["tiny_pck"]["size"] == len(local_data.inflated["tiny_pck"])
    assert by_key["tiny_eph"]["present"] == "no"
    assert by_key["tiny_eph"]["sha256"] == "pinned"
    assert by_key["huge_eph"]["sha256"] == "pending"
    assert by_key["huge_eph"]["size"] == "3307878400 expected"
    assert by_key["refresh_txt"]["sha256"] == "unpinned"
    assert by_key["service"]["present"] == "-"
    assert by_key["service"]["sha256"] == "n/a"
    assert set(rows[0]) == set(sky_data.STATUS_COLUMNS)


def test_status_on_the_packaged_registry_lists_every_dataset(
    env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["status"]) == 0

    out = capsys.readouterr().out
    for entry in load_registry().files:
        assert entry.key in out
        assert entry.filename in out
    assert "download" in out
    assert "builtin" in out
    assert "committed" in out
    assert "ui_asset" in out


def test_verify_on_an_empty_directory_fails_and_names_the_missing_files(
    local_data: LocalData, env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert run(local_data, "verify") == 1

    out = capsys.readouterr().out
    assert "tiny_eph.bsp: FAIL: missing" in out
    assert "alt_eph.bsp: absent (optional, fetch with --only alt_eph)" in out
    assert "cache: not built" in out


def test_fetch_only_then_verify(
    local_data: LocalData, env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert run(local_data, "fetch", "--only", "tiny_pck", "refresh_txt") == 0

    out = capsys.readouterr().out
    assert files_in(env) == {"tiny.tpc", "refresh.txt", "manifest.json"}
    assert "tiny.tpc:" in out
    assert "sha256" in out
    manifest = Manifest.load(env)
    assert set(manifest.entries) == {"tiny_pck", "refresh_txt"}
    assert run(local_data, "verify") == 1  # the other default files are still missing
    assert "tiny.tpc: ok: sha256 matches the pin" in capsys.readouterr().out


def test_default_fetch_downloads_the_selection_and_verify_passes(
    local_data: LocalData, env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert run(local_data, "fetch") == 0

    assert files_in(env) == {
        "tiny_eph.bsp",
        "tiny.tpc",
        "names.csv.gz",
        "refresh.txt",
        "packed.dat",
        "bounds.json",
        "manifest.json",
    }
    capsys.readouterr()
    assert run(local_data, "verify") == 0
    out = capsys.readouterr().out
    assert "packed.dat: ok: sha256 matches the manifest" in out
    assert "names.csv.gz: ok: sha256 matches the pin" in out
    assert (env / "manifest.json").read_text().count('"sha256_download"') == 1


def test_fetch_skips_present_verified_files_unless_forced(local_data: LocalData, env: Path) -> None:
    run(local_data, "fetch", "--only", "tiny_eph")
    assert len(local_data.server.requests_for("tiny_eph.bsp")) == 1

    assert run(local_data, "fetch", "--only", "tiny_eph") == 0
    assert len(local_data.server.requests_for("tiny_eph.bsp")) == 1

    assert run(local_data, "fetch", "--only", "tiny_eph", "--force") == 0
    assert len(local_data.server.requests_for("tiny_eph.bsp")) == 2


def test_fetch_full_warns_before_a_download_above_one_gigabyte(
    local_data: LocalData, env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code = run(local_data, "fetch", "--full")

    captured = capsys.readouterr()
    assert (
        "warning: de441.bsp is 3.3 GB; set SKYAPI_EPHEMERIS=de440s.bsp for development"
        in captured.err
    )
    assert code == 1  # the local server serves 4 KB, the registry expects 3.3 GB
    assert "Content-Length" in captured.err
    assert not (env / "de441.bsp").exists()
    assert (env / "tiny_eph.bsp").exists()  # the other downloads still ran


def test_fetch_continues_after_a_failure_and_exits_one(
    local_data: LocalData, env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    local_data.server.behaviour.missing.add("tiny.tpc")

    assert run(local_data, "fetch") == 1

    assert "tiny.tpc" not in files_in(env)
    assert "tiny_eph.bsp" in files_in(env)
    assert "1 download(s) failed: tiny.tpc" in capsys.readouterr().err


def test_corrupt_file_fails_verify_naming_it(
    local_data: LocalData, env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    run(local_data, "fetch")
    path = env / "tiny_eph.bsp"
    data = bytearray(path.read_bytes())
    data[100] ^= 0x01
    path.write_bytes(bytes(data))
    capsys.readouterr()

    assert run(local_data, "verify") == 1

    out = capsys.readouterr().out
    assert "tiny_eph.bsp: FAIL: sha256" in out
    assert "pinned" in out


@pytest.mark.parametrize(
    ("argv", "fragment"),
    [
        (["fetch", "--only", "nope"], "unknown registry key"),
        (["fetch", "--only", "service"], "runtime_service entry, nothing to download"),
        (["frobnicate"], "invalid choice"),
        ([], "required: VERB"),
    ],
)
def test_usage_errors_exit_two(
    local_data: LocalData,
    env: Path,
    capsys: pytest.CaptureFixture[str],
    argv: Sequence[str],
    fragment: str,
) -> None:
    assert run(local_data, *argv) == 2

    assert fragment in capsys.readouterr().err


def test_help_exits_zero(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--help"]) == 0
    assert "fetch" in capsys.readouterr().out


def test_unknown_ephemeris_is_a_usage_error(
    local_data: LocalData,
    env: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("SKYAPI_EPHEMERIS", "de999.bsp")

    assert run(local_data, "fetch") == 2

    err = capsys.readouterr().err
    assert "unknown ephemeris 'de999.bsp'" in err
    assert "tiny_eph.bsp" in err
    assert "alt_eph.bsp" in err


def test_invalid_settings_are_a_usage_error(
    local_data: LocalData,
    env: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("SKYAPI_WORKERS", "0")

    assert run(local_data, "status") == 2

    assert "invalid SKYAPI_* settings" in capsys.readouterr().err


def test_missing_registry_file_is_a_usage_error(
    env: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["--registry", str(tmp_path / "nope.toml"), "status"]) == 2

    assert "cannot read registry" in capsys.readouterr().err


def test_update_refreshes_changed_files_rebuilds_and_reminds(
    local_data: LocalData,
    env: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    run(local_data, "fetch")
    capsys.readouterr()
    builds: list[Path] = []

    def fake_build_all(data_dir: Path, registry: Registry, **kwargs: object) -> CacheManifest:
        builds.append(data_dir)
        return CacheManifest(1, "test", "now", {}, {})

    monkeypatch.setattr(sky_data, "build_all", fake_build_all)
    local_data.server.put("refresh.txt", b"a brand new upstream release\n" * 100)
    packed_before = len(local_data.server.requests_for("packed.dat.gz"))
    pinned_before = len(local_data.server.requests_for("tiny_eph.bsp"))

    assert run(local_data, "update") == 0

    captured = capsys.readouterr()
    assert RESTART_REMINDER in captured.out
    assert (env / "refresh.txt").read_bytes().startswith(b"a brand new upstream release")
    assert len(local_data.server.requests_for("tiny_eph.bsp")) == pinned_before  # pinned: untouched
    packed_requests = local_data.server.requests_for("packed.dat.gz")
    assert len(packed_requests) == packed_before + 1
    assert packed_requests[-1].method == "HEAD"
    assert builds == [env]
    assert Manifest.load(env).get("refresh_txt") is not None


def test_update_redownloads_when_the_upstream_validators_changed(
    local_data: LocalData, env: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run(local_data, "fetch")
    monkeypatch.setattr(sky_data, "build_all", lambda *a, **k: CacheManifest(1, "t", "n", {}, {}))
    local_data.server.behaviour.version = 2
    before = len(local_data.server.requests_for("packed.dat.gz"))

    assert run(local_data, "update") == 0

    methods = [r.method for r in local_data.server.requests_for("packed.dat.gz")[before:]]
    assert methods == ["HEAD", "GET"]


EMPTY_MANIFEST = CacheManifest(CACHE_FORMAT_VERSION, "test", "now", {}, {})


def fake_build(manifest: CacheManifest):
    """A `build_all` stand-in returning `manifest` (the local registry has no real sources)."""
    return lambda *args, **kwargs: manifest


def get_count(local: LocalData) -> int:
    return sum(1 for record in local.server.requests if record.method == "GET")


def test_update_never_refreshes_a_pending_pin_ephemeris(
    local_data: LocalData, env: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # de441 (3.3 GB, `sha256_pending`) configured as the ephemeris: unpinned and absent, yet a
    # weekly `update` must not fetch it (a failed HEAD probe would otherwise re-download it).
    monkeypatch.setenv("SKYAPI_EPHEMERIS", "de441.bsp")
    monkeypatch.setattr(sky_data, "build_all", fake_build(EMPTY_MANIFEST))

    assert run(local_data, "update") == 0

    assert local_data.server.requests_for("de441.bsp") == []
    assert not (env / "de441.bsp").exists()
    assert (env / "refresh.txt").exists()  # the weekly files were fetched


def test_update_keeps_unpinned_refresh_never_files(
    local_data: LocalData, env: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run(local_data, "fetch")
    monkeypatch.setattr(sky_data, "build_all", fake_build(EMPTY_MANIFEST))
    local_data.server.put("bounds.json", b"a regenerated upstream file\n" * 100)
    local_data.server.behaviour.version = 2  # every HEAD probe now reports a change
    bounds_before = len(local_data.server.requests_for("bounds.json"))
    packed_before = len(local_data.server.requests_for("packed.dat.gz"))

    assert run(local_data, "update") == 0

    # `refresh = "never"`: neither probed nor re-downloaded, the first fetch is kept.
    assert len(local_data.server.requests_for("bounds.json")) == bounds_before
    assert (env / "bounds.json").read_bytes() == local_data.inflated["bounds_never"]
    methods = [r.method for r in local_data.server.requests_for("packed.dat.gz")[packed_before:]]
    assert methods == ["HEAD", "GET"]


def test_update_without_changes_prints_no_restart_reminder(
    local_data: LocalData,
    env: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    run(local_data, "fetch")
    capsys.readouterr()
    monkeypatch.setattr(sky_data, "build_all", fake_build(EMPTY_MANIFEST))
    gets_before = get_count(local_data)

    assert run(local_data, "update") == 0

    assert RESTART_REMINDER not in capsys.readouterr().out
    assert get_count(local_data) == gets_before  # probes only, nothing re-downloaded


def test_update_reminds_when_only_a_cache_was_rebuilt(
    local_data: LocalData,
    env: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    run(local_data, "fetch")
    capsys.readouterr()
    record = ArtifactRecord("dso.json", "a" * 64, 3, 2, "1-abc", ("ngc",), {})
    rebuilt = CacheManifest(CACHE_FORMAT_VERSION, "test", "now", {}, {"dso": record})
    monkeypatch.setattr(sky_data, "build_all", fake_build(rebuilt))
    gets_before = get_count(local_data)

    assert run(local_data, "update") == 0

    assert RESTART_REMINDER in capsys.readouterr().out
    assert get_count(local_data) == gets_before


@pytest.mark.parametrize(
    "error",
    [
        CacheError("unreadable cache manifest"),
        BuildError("constellation 'Xyz' missing from constellation_names.csv"),
        SourceFormatError("NGC.csv: column 'Type' missing"),
        MpcFormatError("MPCORB.DAT: header not found"),
        LicenseChangedError("description.md: no `## License` section"),
    ],
    ids=lambda error: type(error).__name__,
)
def test_build_failures_exit_one_with_one_line(
    local_data: LocalData,
    env: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    error: Exception,
) -> None:
    def failing_build_all(*args: object, **kwargs: object) -> CacheManifest:
        raise error

    monkeypatch.setattr(sky_data, "build_all", failing_build_all)

    assert run(local_data, "build-caches") == 1
    err = capsys.readouterr().err
    assert str(error) in err
    assert "Traceback" not in err

    assert run(local_data, "update") == 1
    assert f"cache build failed: {error}" in capsys.readouterr().err


def test_build_caches_runs_the_builders_and_prints_the_artifacts(
    env: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("SKYAPI_EPHEMERIS", "de440s.bsp")
    registry = load_registry()
    write_sources(env, registry, SOURCE_KEYS)
    fake = FakeBuilders()
    monkeypatch.setattr(
        sky_data, "build_all", lambda *a, **k: _real_build_all(fake.as_builders(), *a, **k)
    )

    assert main(["build-caches", "--dso-mag-limit", "12.5"]) == 0

    out = capsys.readouterr().out
    assert fake.calls == ["stars", "dso", "constellations", "mpc"]
    assert "dso: dso.json" in out
    assert "mpc_index: mpc/index.parquet" in out
    manifest = CacheManifest.load(cache_paths(env).manifest)
    assert manifest is not None
    assert manifest.artifacts["dso"].meta["mag_limit"] == 12.5
    capsys.readouterr()
    assert (
        main(["verify"]) == 1
    )  # data files are dummies without pins/manifest records... caches ok
    assert "cache: ok: every artifact matches cache/manifest.json" in capsys.readouterr().out


def test_build_caches_without_sources_exits_one(
    env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["build-caches"]) == 1

    assert "missing hipparcos" in capsys.readouterr().err


def _real_build_all(
    builders: Builders, data_dir: Path, registry: Registry, **kwargs: object
) -> CacheManifest:
    from skyapi.data import caches

    return caches.build_all(data_dir, registry, builders=builders, **kwargs)  # type: ignore[arg-type]
