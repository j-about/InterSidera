"""Startup bootstrap in a background thread with `starting` / `ready` / `degraded` states (D51).

uvicorn serves nothing until the lifespan has yielded, so the data cannot be loaded before the
first request if `/health` is to report `starting` with download progress (brief l.80). The
lifespan therefore starts `run_bootstrap` in a thread and yields at once; `Bootstrap` publishes
one immutable `Snapshot` at a time, so a reader never sees `ready` without a `SkyState`.

Stages, each preceded by a cancellation check: (1) data files present (downloaded when
`SKYAPI_AUTO_FETCH` is true, otherwise a missing required file is fatal and a missing optional
one degrades); (2) caches current and intact, else rebuilt; both under an exclusive lock so
several workers never download or build twice into one `DATA_DIR`; (3) the astronomical, catalog
and minor-body states; (4) the static part of `/meta`; (5) publication. A fatal error keeps
`starting` with a `detail` so `/health` explains it (ADR-0008).

Heavy imports (Skyfield, pandas) happen inside the functions: importing this module, as the
routers do through `api/deps.py`, stays light.
"""

import fcntl
import logging
import threading
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from importlib.metadata import version
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from skyapi.models.health import DownloadProgress
from skyapi.settings import Settings
from skyapi.state import SkyState

if TYPE_CHECKING:
    from skyapi.astro.minor_bodies import MinorBodyState
    from skyapi.astro.state import AstroState
    from skyapi.catalogs.state import CatalogState
    from skyapi.data.registry import Registry

logger = logging.getLogger(__name__)

Status = Literal["starting", "ready", "degraded"]
LOCK_FILENAME = ".bootstrap.lock"
JOIN_TIMEOUT_SECONDS = 70.0  # longer than the downloader's 60 s socket timeout


class BootstrapCancelledError(Exception):
    """The lifespan is shutting down while the bootstrap is still running."""


class BootstrapError(RuntimeError):
    """The data cannot be made ready without an operator (message shown by `/health`)."""


@dataclass(frozen=True, slots=True)
class Snapshot:
    """What `/health` and `get_sky_state` read: one immutable object, swapped atomically."""

    status: Status = "starting"
    sky: SkyState | None = None
    progress: DownloadProgress | None = None
    detail: str | None = None
    missing: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        # The invariant `/health` and `get_sky_state` rely on: `ready` and `degraded` always
        # carry a state, `starting` never does.
        if (self.status == "starting") != (self.sky is None):
            raise ValueError(f"snapshot {self.status!r} with sky={self.sky!r} is inconsistent")


class Bootstrap:
    """Thread-safe holder of the current `Snapshot` plus the cancellation and settle events."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._snapshot = Snapshot()
        self._settled = threading.Event()
        self._cancel = threading.Event()

    @property
    def snapshot(self) -> Snapshot:
        with self._lock:
            return self._snapshot

    @property
    def sky(self) -> SkyState | None:
        return self.snapshot.sky

    def publish(self, snapshot: Snapshot) -> None:
        with self._lock:
            self._snapshot = snapshot

    def report(self, filename: str, downloaded: int, total: int) -> None:
        """`ProgressCallback` of the downloader: exposes the progress, honours cancellation."""
        if self._cancel.is_set():
            raise BootstrapCancelledError
        self.publish(
            Snapshot(
                "starting",
                progress=DownloadProgress(
                    file=filename, downloaded_bytes=downloaded, total_bytes=total
                ),
            )
        )

    def clear_progress(self) -> None:
        self.publish(Snapshot("starting"))

    def sleep(self, seconds: float) -> None:
        """Interruptible sleep for the downloader's backoff."""
        if self._cancel.wait(seconds):
            raise BootstrapCancelledError

    def check_cancelled(self) -> None:
        if self._cancel.is_set():
            raise BootstrapCancelledError

    def cancel(self) -> None:
        self._cancel.set()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def settle(self) -> None:
        self._settled.set()

    def wait_settled(self, timeout: float | None = None) -> bool:
        """Block until the bootstrap thread has finished (ready, degraded or failed)."""
        return self._settled.wait(timeout)


@contextmanager
def exclusive_lock(path: Path) -> Generator[None]:
    """Advisory exclusive lock (`flock`) so parallel workers serialise downloads and builds."""
    with path.open("a+b") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def ensure_files(settings: Settings, registry: Registry, bootstrap: Bootstrap) -> set[str]:
    """Stage 1: every default download present; returns the groups that stay missing.

    A file counts as present when it exists and is not empty: the downloader lands files
    atomically, so a partial transfer never bears the final name; hashing every file at each
    start (de441 is 3.3 GB) would eat the readiness budget, so integrity stays with
    `sky-data verify` and with the cache builder, which hashes every source it reads.
    """
    from skyapi.data.download import DownloadError, Manifest, download_file
    from skyapi.data.registry import RegistryError

    data_dir = settings.data_dir
    try:
        entries = registry.downloads(settings.ephemeris)
        manifest = Manifest.load(data_dir)
    except (RegistryError, DownloadError) as exc:
        # An unknown `SKYAPI_EPHEMERIS` or an unreadable `manifest.json`: the message says so.
        raise BootstrapError(str(exc)) from exc
    missing: set[str] = set()
    for entry in entries:
        path = data_dir / entry.filename
        if path.is_file() and path.stat().st_size > 0:
            continue
        if not settings.auto_fetch:
            if entry.required:
                # The absolute directory goes to the log only: `/health.detail` is public.
                logger.error("required data file %s is missing from %s", entry.filename, data_dir)
                raise BootstrapError(
                    f"{entry.filename} is missing from DATA_DIR and SKYAPI_AUTO_FETCH is "
                    "false: run `sky-data fetch`"
                )
            missing.add(entry.group)
            continue
        bootstrap.check_cancelled()
        logger.info("downloading %s", entry.filename)
        try:
            result = download_file(
                entry, data_dir, progress=bootstrap.report, sleep=bootstrap.sleep
            )
        except DownloadError as exc:
            bootstrap.clear_progress()
            if entry.required:
                raise BootstrapError(str(exc)) from exc
            # Brief l.18: continue with what is available and record the gap.
            logger.error("optional download failed, API degraded: %s", exc)
            missing.add(entry.group)
            continue
        manifest.record(entry.key, result)
        manifest.save(data_dir)
        bootstrap.clear_progress()
    return missing


def ensure_caches(data_dir: Path, registry: Registry) -> None:
    """Stage 2: rebuild the caches when a source changed or an artifact is corrupt (brief l.282)."""
    from skyapi.catalogs.artifacts import cache_paths
    from skyapi.data.caches import (
        CacheError,
        CacheManifest,
        build_all,
        caches_are_current,
        verify_caches,
    )

    paths = cache_paths(data_dir)
    try:
        manifest = CacheManifest.load(paths.manifest)
    except CacheError as exc:
        logger.error("unreadable cache manifest, rebuilding the caches: %s", exc)
        paths.manifest.unlink(missing_ok=True)
        manifest = None
    if manifest is not None and caches_are_current(data_dir, registry, manifest):
        problems = verify_caches(data_dir)
        if not problems:
            return
        logger.error("corrupt caches, rebuilding: %s", "; ".join(problems))
    logger.info("building caches in %s", paths.root)
    try:
        build_all(data_dir, registry)
    except CacheError as exc:
        # `MissingSourceError` names the file and the `sky-data fetch` remedy (D51).
        raise BootstrapError(str(exc)) from exc


def load_states(
    settings: Settings, missing: set[str]
) -> tuple[AstroState, CatalogState, MinorBodyState | None]:
    """Stage 3: the kernel, catalog and minor-body states; `missing` gains the absent groups."""
    from skyapi.astro.loader import MissingDataError, kernel_paths, load_astro_state
    from skyapi.astro.minor_bodies import load_minor_body_state
    from skyapi.catalogs.artifacts import cache_paths
    from skyapi.catalogs.state import CatalogStateError, load_catalog_state

    data_dir = settings.data_dir
    try:
        astro = load_astro_state(kernel_paths(data_dir, settings.ephemeris))
    except MissingDataError as exc:
        raise BootstrapError(str(exc)) from exc
    try:
        paths = cache_paths(data_dir)
        catalogs = load_catalog_state(paths)
        if catalogs.dso is None:
            missing.add("dso")
        if catalogs.constellations is None:
            missing.add("constellations")
        minor: MinorBodyState | None = None
        mpc_files = (paths.mpc_index, paths.mpc_asteroids, paths.mpc_comets)
        if all(path.is_file() for path in mpc_files):
            minor = load_minor_body_state(paths, astro.ts, astro.eph["sun"])
        else:
            missing.add("mpc")
    except CatalogStateError as exc:
        # "missing cache artifact ...: run `sky-data build-caches`" needs no traceback.
        astro.close()
        raise BootstrapError(str(exc)) from exc
    except Exception:
        astro.close()
        raise
    return astro, catalogs, minor


def run_bootstrap(settings: Settings, registry: Registry | None, bootstrap: Bootstrap) -> None:
    """Thread body: the five stages, with every outcome published as a `Snapshot`."""
    from skyapi.meta import build_meta_static

    astro: AstroState | None = None
    published = False
    try:
        if registry is None:
            from skyapi.data.registry import load_registry

            registry = load_registry()
        data_dir = settings.data_dir
        data_dir.mkdir(parents=True, exist_ok=True)
        with exclusive_lock(data_dir / LOCK_FILENAME):
            missing = ensure_files(settings, registry, bootstrap)
            bootstrap.check_cancelled()
            ensure_caches(data_dir, registry)
        bootstrap.check_cancelled()
        astro, catalogs, minor = load_states(settings, missing)
        bootstrap.check_cancelled()
        meta = build_meta_static(settings, registry, astro, catalogs, minor)
        groups = tuple(sorted(missing))
        sky = SkyState(
            version=version("skyapi"),
            astro=astro,
            catalogs=catalogs,
            meta=meta,
            minor_bodies=minor,
            missing=groups,
        )
        status: Status = "degraded" if groups else "ready"
        bootstrap.publish(Snapshot(status, sky=sky, missing=groups))
        published = True
        logger.info("bootstrap %s (missing data groups: %s)", status, ", ".join(groups) or "none")
    except BootstrapCancelledError:
        logger.info("bootstrap cancelled by shutdown")
        bootstrap.publish(Snapshot("starting", detail="bootstrap cancelled by shutdown"))
    except Exception as exc:
        # Operational errors (missing data, failed download, unreadable cache) already tell the
        # operator what to do and are logged as one line; anything else keeps its class name
        # in `detail` and its traceback in the log.
        expected = isinstance(exc, BootstrapError)
        detail = str(exc) if expected else f"{type(exc).__name__}: {exc}"
        logger.error("bootstrap failed: %s", detail, exc_info=not expected)
        bootstrap.publish(Snapshot("starting", detail=detail))
    finally:
        if astro is not None and not published:
            astro.close()
        bootstrap.settle()


def start_bootstrap(
    settings: Settings, registry: Registry | None = None
) -> tuple[Bootstrap, threading.Thread]:
    """Start the bootstrap thread; the lifespan cancels and joins it at shutdown."""
    bootstrap = Bootstrap()
    thread = threading.Thread(
        target=run_bootstrap,
        args=(settings, registry, bootstrap),
        name="skyapi-bootstrap",
        daemon=True,
    )
    thread.start()
    return bootstrap, thread
