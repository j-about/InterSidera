"""`skyapi.bootstrap` (D51): the snapshot holder, the three stages, the lock and the thread body.

The stage tests run against the M1 local HTTP server and its synthetic registry (no network);
the end-to-end runs use the excerpt `DATA_DIR` fixtures (kernels from `kernels_dir`, caches
built once per session or module). `filterwarnings = error` makes a kernel file left open fatal
through the `ResourceWarning` its finaliser emits, which is how the failure paths prove that the
kernels are closed.
"""

import gc
import hashlib
import threading
import time
from collections.abc import Iterator
from importlib.metadata import version
from pathlib import Path
from typing import cast

import pytest

from skyapi.astro.loader import KernelPaths, load_astro_state
from skyapi.astro.state import AstroState
from skyapi.bootstrap import (
    LOCK_FILENAME,
    Bootstrap,
    BootstrapCancelledError,
    BootstrapError,
    Snapshot,
    Status,
    ensure_caches,
    ensure_files,
    exclusive_lock,
    load_states,
    run_bootstrap,
)
from skyapi.catalogs.artifacts import CachePaths, cache_paths
from skyapi.catalogs.state import CatalogState
from skyapi.data.caches import build_all
from skyapi.data.download import Manifest
from skyapi.data.registry import Registry, load_registry
from skyapi.models.health import DownloadProgress
from skyapi.settings import Settings
from skyapi.state import SkyState
from support.fixtures_api import KERNEL_KEYS, api_settings_for, assemble_data_dir
from support.fixtures_data import FakeBuilders, LocalData, write_sources

pytestmark = pytest.mark.unit

LOCAL_EPHEMERIS = "tiny_eph.bsp"


class RecordingBootstrap(Bootstrap):
    """Keeps every progress report so a test can read the download order."""

    def __init__(self) -> None:
        super().__init__()
        self.reports: list[tuple[str, int, int]] = []

    def report(self, filename: str, downloaded: int, total: int) -> None:
        self.reports.append((filename, downloaded, total))
        super().report(filename, downloaded, total)


class BuildAllSpy:
    """Stands in for `skyapi.data.caches.build_all`; records the directories it was asked for."""

    def __init__(self) -> None:
        self.calls: list[Path] = []

    def __call__(self, data_dir: Path, registry: Registry, **_: object) -> None:
        self.calls.append(data_dir)


def local_settings(data_dir: Path, *, auto_fetch: bool) -> Settings:
    return api_settings_for(data_dir, auto_fetch=auto_fetch, ephemeris=LOCAL_EPHEMERIS)


def write_downloads(local_data: LocalData, data_dir: Path) -> list[str]:
    """Every default download of the synthetic registry, as it would lie after `sky-data fetch`."""
    names: list[str] = []
    for entry in local_data.registry.downloads(LOCAL_EPHEMERIS):
        (data_dir / entry.filename).write_bytes(local_data.inflated[entry.key])
        names.append(entry.filename)
    return names


def link_kernels(target: Path, kernels_dir: Path) -> None:
    registry = load_registry()
    for key in KERNEL_KEYS:
        filename = registry.by_key(key).filename
        (target / filename).symlink_to(kernels_dir / filename)


class AstroStateSpy:
    """Wraps `load_astro_state` so a test can reach the state a failing stage had to close."""

    def __init__(self) -> None:
        self.states: list[AstroState] = []

    def __call__(self, paths: KernelPaths) -> AstroState:
        state = load_astro_state(paths)
        self.states.append(state)
        return state

    def assert_closed(self) -> None:
        assert len(self.states) == 1
        state = self.states[0]
        assert state.eph.segments == []  # `SpiceKernel.close()` empties its segment list
        assert len(state.bpc_files) == 1
        assert state.bpc_files[0].closed


@pytest.fixture
def astro_state_spy(monkeypatch: pytest.MonkeyPatch) -> AstroStateSpy:
    # `load_states` imports `load_astro_state` from `skyapi.astro.loader` at call time.
    spy = AstroStateSpy()
    monkeypatch.setattr("skyapi.astro.loader.load_astro_state", spy)
    return spy


@pytest.fixture
def registry() -> Registry:
    return load_registry()


@pytest.fixture
def build_all_spy(monkeypatch: pytest.MonkeyPatch) -> BuildAllSpy:
    # `ensure_caches` imports `build_all` from `skyapi.data.caches` at call time.
    spy = BuildAllSpy()
    monkeypatch.setattr("skyapi.data.caches.build_all", spy)
    return spy


# ------------------------------------------------------------------------- Snapshot, Bootstrap


def test_initial_snapshot_is_starting_without_a_state() -> None:
    bootstrap = Bootstrap()

    assert bootstrap.snapshot == Snapshot()
    assert bootstrap.snapshot.status == "starting"
    assert bootstrap.sky is None
    assert not bootstrap.cancelled
    assert bootstrap.wait_settled(0) is False


@pytest.mark.parametrize("status", ["ready", "degraded"])
def test_a_published_state_is_mandatory_outside_starting(status: Status) -> None:
    with pytest.raises(ValueError, match="inconsistent"):
        Snapshot(status)


def test_a_starting_snapshot_never_carries_a_state() -> None:
    with pytest.raises(ValueError, match="inconsistent"):
        Snapshot("starting", sky=cast(SkyState, object()))


def test_snapshot_publication_is_atomic() -> None:
    """Readers never observe `ready` without `sky`: one immutable object is swapped at a time."""
    bootstrap = Bootstrap()
    sky = cast(SkyState, object())  # the holder never looks inside the state
    violations: list[Snapshot] = []
    stop = threading.Event()

    def read() -> None:
        while not stop.is_set():
            snapshot = bootstrap.snapshot
            if snapshot.status != "starting" and snapshot.sky is None:
                violations.append(snapshot)
            if snapshot.status == "starting" and snapshot.sky is not None:
                violations.append(snapshot)

    readers = [threading.Thread(target=read, name=f"reader-{index}") for index in range(4)]
    for reader in readers:
        reader.start()
    for index in range(2000):
        bootstrap.report("de440s.bsp", index, 2000)
        bootstrap.publish(Snapshot("ready", sky=sky))
        bootstrap.clear_progress()
        bootstrap.publish(Snapshot("degraded", sky=sky, missing=("mpc",)))
    stop.set()
    for reader in readers:
        reader.join(timeout=10.0)

    assert violations == []
    assert bootstrap.sky is sky


def test_report_publishes_progress_and_raises_once_cancelled() -> None:
    bootstrap = Bootstrap()

    bootstrap.report("de440s.bsp", 1024, 32_726_016)

    snapshot = bootstrap.snapshot
    assert snapshot.status == "starting"
    assert snapshot.sky is None
    assert snapshot.progress == DownloadProgress(
        file="de440s.bsp", downloaded_bytes=1024, total_bytes=32_726_016
    )

    bootstrap.clear_progress()
    assert bootstrap.snapshot == Snapshot()

    bootstrap.cancel()
    assert bootstrap.cancelled
    with pytest.raises(BootstrapCancelledError):
        bootstrap.report("de440s.bsp", 2048, 32_726_016)
    with pytest.raises(BootstrapCancelledError):
        bootstrap.check_cancelled()


def test_sleep_is_cut_short_by_cancel() -> None:
    bootstrap = Bootstrap()
    timer = threading.Timer(0.05, bootstrap.cancel)
    started = time.monotonic()
    timer.start()

    with pytest.raises(BootstrapCancelledError):
        bootstrap.sleep(30.0)

    assert time.monotonic() - started < 10.0
    timer.join()


def test_sleep_runs_to_completion_when_not_cancelled() -> None:
    bootstrap = Bootstrap()
    started = time.monotonic()

    bootstrap.sleep(0.05)

    assert time.monotonic() - started >= 0.04
    assert not bootstrap.cancelled


def test_wait_settled_blocks_until_settle() -> None:
    bootstrap = Bootstrap()
    assert bootstrap.wait_settled(0.01) is False
    timer = threading.Timer(0.05, bootstrap.settle)
    timer.start()

    assert bootstrap.wait_settled(10.0) is True
    assert bootstrap.wait_settled(0) is True
    timer.join()


# ------------------------------------------------------------------------------- ensure_files


def test_present_files_are_skipped_without_a_request(local_data: LocalData, data_dir: Path) -> None:
    write_downloads(local_data, data_dir)
    bootstrap = Bootstrap()

    missing = ensure_files(
        local_settings(data_dir, auto_fetch=True), local_data.registry, bootstrap
    )

    assert missing == set()
    assert local_data.server.requests == []
    assert bootstrap.snapshot == Snapshot()
    assert not Manifest.path(data_dir).exists()  # nothing fetched, nothing recorded


def test_missing_required_file_without_auto_fetch_is_fatal(
    local_data: LocalData, data_dir: Path
) -> None:
    write_downloads(local_data, data_dir)
    (data_dir / "tiny.tpc").unlink()

    with pytest.raises(BootstrapError, match=r"tiny\.tpc.*SKYAPI_AUTO_FETCH.*sky-data fetch"):
        ensure_files(local_settings(data_dir, auto_fetch=False), local_data.registry, Bootstrap())

    assert local_data.server.requests == []


def test_an_empty_file_counts_as_missing(local_data: LocalData, data_dir: Path) -> None:
    # The downloader lands files atomically, so an empty file is never a partial transfer.
    write_downloads(local_data, data_dir)
    (data_dir / LOCAL_EPHEMERIS).write_bytes(b"")

    with pytest.raises(BootstrapError, match=LOCAL_EPHEMERIS):
        ensure_files(local_settings(data_dir, auto_fetch=False), local_data.registry, Bootstrap())


def test_missing_optional_files_without_auto_fetch_degrade_their_groups(
    local_data: LocalData, data_dir: Path
) -> None:
    write_downloads(local_data, data_dir)
    (data_dir / "refresh.txt").unlink()  # group mpc, required = false
    (data_dir / "bounds.json").unlink()  # group constellations, required = false

    missing = ensure_files(
        local_settings(data_dir, auto_fetch=False), local_data.registry, Bootstrap()
    )

    assert missing == {"mpc", "constellations"}
    assert local_data.server.requests == []


def test_unknown_ephemeris_is_a_bootstrap_error(local_data: LocalData, data_dir: Path) -> None:
    settings = api_settings_for(data_dir, ephemeris="nowhere.bsp")

    with pytest.raises(BootstrapError, match="SKYAPI_EPHEMERIS must be one of"):
        ensure_files(settings, local_data.registry, Bootstrap())


def test_unreadable_manifest_is_a_bootstrap_error(local_data: LocalData, data_dir: Path) -> None:
    write_downloads(local_data, data_dir)
    Manifest.path(data_dir).write_text("{not json", encoding="utf-8")

    with pytest.raises(BootstrapError, match="unreadable manifest"):
        ensure_files(local_settings(data_dir, auto_fetch=False), local_data.registry, Bootstrap())


def test_auto_fetch_downloads_missing_files_and_records_the_manifest(
    local_data: LocalData, data_dir: Path
) -> None:
    bootstrap = RecordingBootstrap()
    downloads = local_data.registry.downloads(LOCAL_EPHEMERIS)

    missing = ensure_files(
        local_settings(data_dir, auto_fetch=True), local_data.registry, bootstrap
    )

    assert missing == set()
    for entry in downloads:
        assert (data_dir / entry.filename).read_bytes() == local_data.inflated[entry.key]
    manifest = Manifest.load(data_dir)
    assert set(manifest.entries) == {entry.key for entry in downloads}
    recorded = manifest.get("tiny_eph")
    assert recorded is not None
    assert recorded.sha256 == hashlib.sha256(local_data.inflated["tiny_eph"]).hexdigest()
    assert recorded.url == local_data.url("tiny_eph")
    # The ephemeris is fetched first; progress is published per file, then cleared.
    assert bootstrap.reports[0][0] == LOCAL_EPHEMERIS
    assert [name for name, _, _ in bootstrap.reports if name == LOCAL_EPHEMERIS][-1:] == [
        LOCAL_EPHEMERIS
    ]
    assert bootstrap.reports[-1][1] == bootstrap.reports[-1][2] > 0  # complete: downloaded == total
    assert bootstrap.snapshot == Snapshot()
    assert local_data.server.requests_for(LOCAL_EPHEMERIS) != []


def test_auto_fetch_leaves_present_files_alone(local_data: LocalData, data_dir: Path) -> None:
    write_downloads(local_data, data_dir)
    (data_dir / "refresh.txt").unlink()

    missing = ensure_files(
        local_settings(data_dir, auto_fetch=True), local_data.registry, Bootstrap()
    )

    assert missing == set()
    assert [record.name for record in local_data.server.requests] == ["refresh.txt"]
    assert set(Manifest.load(data_dir).entries) == {"refresh_txt"}


def test_a_failed_optional_download_degrades_its_group(
    local_data: LocalData, data_dir: Path
) -> None:
    local_data.server.behaviour.missing = {"refresh.txt"}  # 404: every source fails at once
    bootstrap = Bootstrap()

    missing = ensure_files(
        local_settings(data_dir, auto_fetch=True), local_data.registry, bootstrap
    )

    assert missing == {"mpc"}
    assert not (data_dir / "refresh.txt").exists()
    assert (data_dir / "packed.dat").is_file()  # the later downloads still ran
    assert (data_dir / "bounds.json").is_file()
    assert bootstrap.snapshot == Snapshot()
    assert "refresh_txt" not in Manifest.load(data_dir).entries


def test_a_failed_required_download_is_fatal(local_data: LocalData, data_dir: Path) -> None:
    local_data.server.behaviour.missing = {"tiny.tpc"}
    bootstrap = Bootstrap()

    with pytest.raises(BootstrapError, match=r"tiny\.tpc: every source failed"):
        ensure_files(local_settings(data_dir, auto_fetch=True), local_data.registry, bootstrap)

    assert (data_dir / LOCAL_EPHEMERIS).is_file()  # fetched before the failure, kept
    assert bootstrap.snapshot == Snapshot()  # no stale progress after the failure


def test_a_cancelled_bootstrap_downloads_nothing(local_data: LocalData, data_dir: Path) -> None:
    bootstrap = Bootstrap()
    bootstrap.cancel()

    with pytest.raises(BootstrapCancelledError):
        ensure_files(local_settings(data_dir, auto_fetch=True), local_data.registry, bootstrap)

    assert local_data.server.requests == []


# ------------------------------------------------------------------------------ ensure_caches


def test_caches_are_built_when_there_is_no_manifest(
    data_dir: Path, registry: Registry, build_all_spy: BuildAllSpy
) -> None:
    ensure_caches(data_dir, registry)

    assert build_all_spy.calls == [data_dir]


def test_current_caches_are_not_rebuilt(
    data_dir: Path, registry: Registry, build_all_spy: BuildAllSpy
) -> None:
    write_sources(data_dir, registry)
    _real_build(data_dir, registry)

    ensure_caches(data_dir, registry)

    assert build_all_spy.calls == []


def test_unreadable_manifest_is_deleted_and_the_caches_rebuilt(
    data_dir: Path, registry: Registry, build_all_spy: BuildAllSpy
) -> None:
    paths = cache_paths(data_dir)
    paths.root.mkdir()
    paths.manifest.write_text("{not json", encoding="utf-8")

    ensure_caches(data_dir, registry)

    assert build_all_spy.calls == [data_dir]
    assert not paths.manifest.exists()  # removed before the rebuild, which writes a fresh one


def test_a_corrupt_artifact_triggers_a_rebuild(
    data_dir: Path, registry: Registry, build_all_spy: BuildAllSpy
) -> None:
    write_sources(data_dir, registry)
    paths = _real_build(data_dir, registry)
    paths.dso_json.write_bytes(b"tampered")

    ensure_caches(data_dir, registry)

    assert build_all_spy.calls == [data_dir]


def test_a_changed_source_triggers_a_rebuild(
    data_dir: Path, registry: Registry, build_all_spy: BuildAllSpy
) -> None:
    write_sources(data_dir, registry)
    _real_build(data_dir, registry)
    (data_dir / registry.by_key("ngc").filename).write_text("a new OpenNGC release\n")

    ensure_caches(data_dir, registry)

    assert build_all_spy.calls == [data_dir]


def test_a_missing_required_source_is_a_bootstrap_error(data_dir: Path, registry: Registry) -> None:
    # The real `build_all` on an empty directory: `MissingSourceError` becomes the `/health` detail.
    with pytest.raises(BootstrapError, match=r"missing hipparcos.*sky-data fetch"):
        ensure_caches(data_dir, registry)


def _real_build(data_dir: Path, registry: Registry) -> CachePaths:
    """Caches built by the fake builders, with a real `cache/manifest.json`.

    `build_all` here is the module-level import, untouched by the `build_all_spy` monkeypatch
    of `skyapi.data.caches.build_all`.
    """
    build_all(data_dir, registry, builders=FakeBuilders().as_builders())
    return cache_paths(data_dir)


# ------------------------------------------------------------------------------ exclusive_lock


def test_exclusive_lock_blocks_a_second_holder_until_release(tmp_path: Path) -> None:
    path = tmp_path / LOCK_FILENAME
    acquired = threading.Event()

    def contender() -> None:
        with exclusive_lock(path):
            acquired.set()

    thread = threading.Thread(target=contender, name="lock-contender")
    with exclusive_lock(path):
        thread.start()
        assert acquired.wait(0.3) is False

    assert acquired.wait(10.0) is True
    thread.join(timeout=10.0)
    assert path.is_file()


def test_exclusive_lock_is_released_on_error(tmp_path: Path) -> None:
    path = tmp_path / LOCK_FILENAME
    with pytest.raises(RuntimeError, match="inside"), exclusive_lock(path):
        raise RuntimeError("inside")

    acquired = threading.Event()

    def contender() -> None:
        with exclusive_lock(path):
            acquired.set()

    thread = threading.Thread(target=contender)
    thread.start()
    assert acquired.wait(10.0) is True
    thread.join(timeout=10.0)


# ------------------------------------------------------------------------------- run_bootstrap


@pytest.fixture(scope="module")
def ready_bootstrap(api_data_dir: Path) -> Iterator[Bootstrap]:
    """`run_bootstrap` on the complete excerpt data dir (kernels, caches, MPC), run once."""
    bootstrap = Bootstrap()
    run_bootstrap(api_settings_for(api_data_dir), None, bootstrap)
    yield bootstrap
    sky = bootstrap.sky
    if sky is not None:
        sky.astro.close()


@pytest.fixture(scope="module")
def dso_only_data_dir(kernels_dir: Path, tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Kernels, stars and DSO only: no constellation and no MPC sources."""
    return assemble_data_dir(tmp_path_factory.mktemp("dso-only"), kernels_dir, groups={"dso"})


def test_run_bootstrap_on_complete_data_is_ready(
    ready_bootstrap: Bootstrap, api_data_dir: Path
) -> None:
    snapshot = ready_bootstrap.snapshot

    assert ready_bootstrap.wait_settled(0) is True
    assert snapshot.status == "ready"
    assert snapshot.missing == ()
    assert snapshot.detail is None
    assert snapshot.progress is None
    sky = snapshot.sky
    assert sky is not None
    assert sky is ready_bootstrap.sky
    assert sky.version == version("skyapi")
    assert sky.missing == ()
    assert sky.astro.ephemeris_name == "de440s.bsp"
    assert sky.astro.moon_frame is not None
    assert sky.catalogs.stars.count > 0
    assert sky.catalogs.dso is not None
    assert sky.catalogs.constellations is not None
    assert sky.minor_bodies is not None
    assert sky.meta.ephemeris.name == "de440s.bsp"
    assert sky.meta.catalogs.dso is not None
    assert sky.meta.catalogs.constellations is not None
    assert sky.meta.catalogs.minor_bodies is not None
    assert (api_data_dir / LOCK_FILENAME).is_file()


def test_run_bootstrap_without_optional_groups_is_degraded(dso_only_data_dir: Path) -> None:
    bootstrap = Bootstrap()

    run_bootstrap(api_settings_for(dso_only_data_dir), None, bootstrap)

    snapshot = bootstrap.snapshot
    sky = snapshot.sky
    try:
        assert bootstrap.wait_settled(0) is True
        assert snapshot.status == "degraded"
        assert snapshot.missing == ("constellations", "mpc")
        assert snapshot.detail is None
        assert sky is not None
        assert sky.missing == ("constellations", "mpc")
        assert sky.minor_bodies is None
        assert sky.catalogs.constellations is None
        assert sky.catalogs.dso is not None
        assert sky.meta.catalogs.dso is not None
        assert sky.meta.catalogs.constellations is None
        assert sky.meta.catalogs.minor_bodies is None
    finally:
        if sky is not None:
            sky.astro.close()


def test_run_bootstrap_on_an_empty_data_dir_explains_the_missing_ephemeris(tmp_path: Path) -> None:
    bootstrap = Bootstrap()
    data_dir = tmp_path / "data"  # created by the bootstrap itself

    run_bootstrap(api_settings_for(data_dir), None, bootstrap)

    snapshot = bootstrap.snapshot
    assert bootstrap.wait_settled(0) is True
    assert snapshot.status == "starting"
    assert snapshot.sky is None
    assert snapshot.detail is not None
    assert snapshot.detail.startswith("de440s.bsp is missing from DATA_DIR")
    assert "SKYAPI_AUTO_FETCH is false" in snapshot.detail
    assert snapshot.detail.endswith("run `sky-data fetch`")  # no exception class name in front
    assert (data_dir / LOCK_FILENAME).is_file()


def test_run_bootstrap_cancelled_before_loading_publishes_the_reason(api_data_dir: Path) -> None:
    bootstrap = Bootstrap()
    bootstrap.cancel()

    run_bootstrap(api_settings_for(api_data_dir), None, bootstrap)

    assert bootstrap.wait_settled(0) is True
    assert bootstrap.snapshot == Snapshot("starting", detail="bootstrap cancelled by shutdown")


def test_load_states_closes_the_kernels_when_the_catalogs_fail(
    kernels_dir: Path, tmp_path: Path, astro_state_spy: AstroStateSpy
) -> None:
    """Kernels but no caches: `load_astro_state` succeeds, `load_catalog_state` raises.

    The kernel files opened by the first call must be closed by the time the error surfaces.
    Checked on the state itself, and by `gc.collect()`: an unclosed file would emit a
    `ResourceWarning` from its finaliser, fatal under `filterwarnings = error` (pytest reports
    it as an unraisable exception).
    """
    link_kernels(tmp_path, kernels_dir)
    missing: set[str] = set()

    with pytest.raises(BootstrapError, match=r"stars\.skys.*sky-data build-caches"):
        load_states(api_settings_for(tmp_path), missing)

    astro_state_spy.assert_closed()
    gc.collect()
    assert missing == set()


def test_run_bootstrap_failure_after_the_kernels_opened_closes_them(
    api_data_dir: Path, monkeypatch: pytest.MonkeyPatch, astro_state_spy: AstroStateSpy
) -> None:
    def explode(cache: CachePaths) -> CatalogState:
        raise RuntimeError("catalog boom")

    # `load_states` imports the name from `skyapi.catalogs.state` at call time.
    monkeypatch.setattr("skyapi.catalogs.state.load_catalog_state", explode)
    bootstrap = Bootstrap()

    run_bootstrap(api_settings_for(api_data_dir), None, bootstrap)

    snapshot = bootstrap.snapshot
    assert bootstrap.wait_settled(0) is True
    assert snapshot.status == "starting"
    assert snapshot.sky is None
    assert snapshot.detail == "RuntimeError: catalog boom"  # unexpected: class name kept
    # The logged traceback keeps the frames (and the state) alive until the log is torn down, so
    # the finaliser check alone would fire too late: the spy looks at the state directly.
    astro_state_spy.assert_closed()
    gc.collect()
