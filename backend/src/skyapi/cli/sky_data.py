"""`sky-data`: fetch, update, verify, build-caches, status (brief l.364, l.394; D32).

Exit codes: 0 success, 1 failure (a download, verification or build failed), 2 usage error
(unknown verb or key, unknown ephemeris, invalid `SKYAPI_*` settings). Logging goes to stderr as
plain text (the JSON formatter is the API's, M2). `--registry PATH` exists for the tests only: it
points the CLI at a registry whose URLs target a local HTTP server.
"""

import argparse
import json
import logging
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

from pydantic import ValidationError

from skyapi.catalogs.builders import BuildError, LicenseChangedError
from skyapi.catalogs.mpc_build import MpcFormatError
from skyapi.catalogs.readers import SourceFormatError
from skyapi.data.caches import (
    CacheError,
    CacheManifest,
    build_all,
    cache_paths,
    caches_are_current,
    verify_caches,
)
from skyapi.data.download import (
    DownloadError,
    Manifest,
    VerifyResult,
    download_file,
    probe_unchanged,
    verify_file,
)
from skyapi.data.registry import DataFile, Registry, RegistryError, load_registry
from skyapi.settings import Settings

logger = logging.getLogger("skyapi.cli.sky_data")

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_USAGE = 2
LARGE_DOWNLOAD_BYTES = 1_000_000_000
RESTART_REMINDER = (
    "Data updated: a running API only reloads data at startup, restart it "
    "(docker compose restart api)."
)
# Every failure a cache build raises, reported as one line with exit code 1 (the exit-code
# contract of the module docstring, never a traceback): cache bookkeeping (`CacheError`), an
# upstream format change in a catalog or MPC file (`BuildError`, `SourceFormatError`,
# `MpcFormatError`) and a Stellarium sky culture whose declared license changed (brief l.313:
# "verify at fetch time and record the declared license").
BUILD_ERRORS: tuple[type[Exception], ...] = (
    CacheError,
    BuildError,
    SourceFormatError,
    MpcFormatError,
    LicenseChangedError,
)
STATUS_COLUMNS = (
    "kind",
    "key",
    "filename",
    "present",
    "size",
    "sha256",
    "license",
    "attribution",
    "refresh",
)


class UsageError(Exception):
    """Wrong invocation: reported on stderr with exit code 2."""


@dataclass(frozen=True, slots=True)
class Context:
    registry: Registry
    settings: Settings
    out: TextIO
    err: TextIO


@dataclass(frozen=True, slots=True)
class _FetchReport:
    code: int
    downloaded: tuple[str, ...]
    """Files (re)written under DATA_DIR by this run."""


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        code = exc.code
        return code if isinstance(code, int) else (EXIT_OK if code is None else EXIT_USAGE)
    _configure_logging(verbose=bool(args.verbose))
    try:
        return _dispatch(args)
    finally:
        # The handler binds the `sys.stderr` of this call; detaching it keeps an in-process
        # caller (the tests) from logging into a stream that is closed afterwards.
        _remove_cli_handlers()


def _dispatch(args: argparse.Namespace) -> int:
    try:
        registry = load_registry(args.registry)
        settings = Settings()
    except RegistryError as exc:
        print(f"sky-data: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except ValidationError as exc:
        print(f"sky-data: invalid SKYAPI_* settings: {exc}", file=sys.stderr)
        return EXIT_USAGE
    context = Context(registry=registry, settings=settings, out=sys.stdout, err=sys.stderr)
    try:
        return int(args.handler(context, args))
    except (UsageError, RegistryError) as exc:
        # Unknown key or ephemeris name: the invocation or SKYAPI_EPHEMERIS is wrong.
        print(f"sky-data: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except (DownloadError, *BUILD_ERRORS) as exc:
        logger.error("%s", exc)
        return EXIT_FAILURE


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sky-data",
        description="Manage the InterSidera data directory (SKYAPI_DATA_DIR, SKYAPI_EPHEMERIS).",
    )
    parser.add_argument(
        "--registry",
        type=Path,
        default=None,
        help="(tests only) load the registry from PATH instead of the packaged data_files.toml",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging on stderr")
    verbs = parser.add_subparsers(dest="verb", required=True, metavar="VERB")

    fetch = verbs.add_parser(
        "fetch", help="download the configured ephemeris and every default dataset"
    )
    fetch.add_argument("--full", action="store_true", help="also download de441.bsp (3.3 GB)")
    fetch.add_argument("--only", nargs="+", metavar="KEY", help="download only these registry keys")
    fetch.add_argument("--force", action="store_true", help="re-download files already present")
    fetch.set_defaults(handler=cmd_fetch)

    update = verbs.add_parser(
        "update", help="refresh the refreshable datasets (MPC weekly) and rebuild the caches"
    )
    update.set_defaults(handler=cmd_update)

    verify = verbs.add_parser("verify", help="check sizes and SHA-256 of every file and cache")
    verify.set_defaults(handler=cmd_verify)

    build = verbs.add_parser("build-caches", help="build the catalog caches under DATA_DIR/cache")
    build.add_argument("--force", action="store_true", help="rebuild even when up to date")
    build.add_argument(
        "--dso-mag-limit", type=float, default=14.0, help="keep DSO brighter than this (V or B)"
    )
    build.add_argument(
        "--dso-size-arcmin",
        type=float,
        default=5.0,
        help="keep DSO whose major axis is at least this many arcminutes",
    )
    build.set_defaults(handler=cmd_build_caches)

    status = verbs.add_parser("status", help="list every registry entry with its license")
    status.add_argument("--json", action="store_true", help="machine-readable output")
    status.set_defaults(handler=cmd_status)
    return parser


# ------------------------------------------------------------------------------------ verbs


def cmd_fetch(context: Context, args: argparse.Namespace) -> int:
    only: list[str] | None = args.only
    if only:
        files = [context.registry.by_key(key) for key in only]
        for entry in files:
            if not entry.is_download:
                raise UsageError(f"{entry.key} is a {entry.kind} entry, nothing to download")
    else:
        files = context.registry.downloads(context.settings.ephemeris, full=bool(args.full))
    return _fetch_files(context, files, force=bool(args.force)).code


def cmd_update(context: Context, args: argparse.Namespace) -> int:
    del args
    data_dir = context.settings.data_dir
    manifest = Manifest.load(data_dir)
    to_fetch: list[DataFile] = []
    for entry in _refreshable(context.registry.downloads(context.settings.ephemeris)):
        recorded = manifest.get(entry.key)
        present = (data_dir / entry.filename).is_file()
        if present and recorded is not None and probe_unchanged(entry.urls[0], recorded):
            logger.info("%s: unchanged upstream, kept", entry.filename)
            continue
        to_fetch.append(entry)
    fetched = _fetch_files(context, to_fetch, force=True)
    code = fetched.code
    before = CacheManifest.load(cache_paths(data_dir).manifest)
    after: CacheManifest | None = None
    if before is not None and caches_are_current(data_dir, context.registry, before):
        logger.info("caches already match the data files")
    else:
        try:
            after = build_all(data_dir, context.registry)
        except BUILD_ERRORS as exc:
            logger.error("cache build failed: %s", exc)
            code = EXIT_FAILURE
    # The reminder is for a running API holding stale data: only when a file was re-downloaded
    # or a cache group was rebuilt with a different result, never when nothing changed.
    if fetched.downloaded or (after is not None and _caches_changed(before, after)):
        print(RESTART_REMINDER, file=context.out)
    else:
        logger.info("nothing changed: data files and caches are up to date")
    return code


def _refreshable(selected: Sequence[DataFile]) -> list[DataFile]:
    """The downloads `update` may re-fetch: unpinned, not awaiting a pin, not `refresh = never`.

    Pinned files are immutable (D30). A `sha256_pending` ephemeris (de440, de441) is unpinned
    only until its hash is recorded: re-downloading 3.3 GB because a HEAD probe failed must not
    happen from a weekly cron. `refresh = "never"` entries (the d3-celestial bounds) are fetched
    once and kept.
    """
    return [
        entry
        for entry in selected
        if entry.sha256 is None and not entry.sha256_pending and entry.refresh != "never"
    ]


def _caches_changed(before: CacheManifest | None, after: CacheManifest) -> bool:
    """True when at least one artifact record differs from the manifest the build started from."""
    previous: Mapping[str, object] = {} if before is None else before.artifacts
    return dict(after.artifacts) != dict(previous)


def cmd_verify(context: Context, args: argparse.Namespace) -> int:
    del args
    data_dir = context.settings.data_dir
    manifest = Manifest.load(data_dir)
    expected = context.registry.downloads(context.settings.ephemeris)
    failures = 0
    for entry in context.registry.files:
        if not entry.is_download:
            continue
        result = verify_file(entry, data_dir, manifest)
        if not result.present and entry not in expected:
            print(
                f"{entry.filename}: absent (optional, fetch with --only {entry.key})",
                file=context.out,
            )
            continue
        ok = result.ok
        failures += 0 if ok else 1
        marker = "ok" if ok else "FAIL"
        print(f"{entry.filename}: {marker}: {result.message}", file=context.out)
    cache_manifest_path = cache_paths(data_dir).manifest
    if cache_manifest_path.is_file():
        problems = verify_caches(data_dir)
        for problem in problems:
            print(f"cache: FAIL: {problem}", file=context.out)
        failures += len(problems)
        if not problems:
            print("cache: ok: every artifact matches cache/manifest.json", file=context.out)
    else:
        print("cache: not built (run sky-data build-caches)", file=context.out)
    if failures:
        logger.error("%d problem(s) found in %s", failures, data_dir)
        return EXIT_FAILURE
    return EXIT_OK


def cmd_build_caches(context: Context, args: argparse.Namespace) -> int:
    manifest = build_all(
        context.settings.data_dir,
        context.registry,
        force=bool(args.force),
        dso_mag_limit=float(args.dso_mag_limit),
        dso_size_arcmin=float(args.dso_size_arcmin),
    )
    for name, record in sorted(manifest.artifacts.items()):
        print(
            f"{name}: {record.path} ({record.count} records, {record.bytes} bytes, "
            f"version {record.version})",
            file=context.out,
        )
    return EXIT_OK


def cmd_status(context: Context, args: argparse.Namespace) -> int:
    rows = status_rows(context.registry, context.settings.data_dir)
    if args.json:
        json.dump(rows, context.out, indent=2)
        context.out.write("\n")
        return EXIT_OK
    widths = {
        column: max(len(column), *(len(str(row[column])) for row in rows))
        for column in STATUS_COLUMNS
    }
    header = "  ".join(column.ljust(widths[column]) for column in STATUS_COLUMNS)
    print(header.rstrip(), file=context.out)
    print("  ".join("-" * widths[column] for column in STATUS_COLUMNS), file=context.out)
    for row in rows:
        line = "  ".join(str(row[column]).ljust(widths[column]) for column in STATUS_COLUMNS)
        print(line.rstrip(), file=context.out)
    return EXIT_OK


def status_rows(registry: Registry, data_dir: Path) -> list[dict[str, str | int | bool | None]]:
    manifest = Manifest.load(data_dir)
    rows: list[dict[str, str | int | bool | None]] = []
    for entry in registry.files:
        row: dict[str, str | int | bool | None] = {
            "kind": entry.kind,
            "key": entry.key,
            "filename": entry.filename,
            "present": "-",
            "size": "-",
            "sha256": "n/a",
            "license": entry.license,
            "attribution": entry.attribution,
            "refresh": entry.refresh,
        }
        if entry.is_download:
            result = verify_file(entry, data_dir, manifest)
            row["present"] = "yes" if result.present else "no"
            if result.present:
                row["size"] = (data_dir / entry.filename).stat().st_size
            elif entry.size_bytes > 0:
                row["size"] = f"{entry.size_bytes} expected"
            row["sha256"] = _sha_status(entry, result)
        rows.append(row)
    return rows


def _sha_status(entry: DataFile, result: VerifyResult) -> str:
    if not result.present:
        return "pinned" if entry.pinned else ("pending" if entry.sha256_pending else "unpinned")
    if result.sha_ok is True:
        return "ok (pin)" if entry.pinned else "ok (manifest)"
    if result.sha_ok is False or result.size_ok is False:
        return "MISMATCH"
    return "unpinned, recorded on next fetch"


# -------------------------------------------------------------------------------- helpers


def _fetch_files(context: Context, files: Sequence[DataFile], *, force: bool) -> _FetchReport:
    data_dir = context.settings.data_dir
    manifest = Manifest.load(data_dir)
    failures: list[str] = []
    downloaded: list[str] = []
    for entry in files:
        if not force:
            current = verify_file(entry, data_dir, manifest)
            if current.ok and current.sha_ok is True:
                logger.info("%s: present and verified, skipping", entry.filename)
                continue
        if entry.size_bytes > LARGE_DOWNLOAD_BYTES:
            print(
                f"warning: {entry.filename} is {entry.size_bytes / 1e9:.1f} GB; "
                "set SKYAPI_EPHEMERIS=de440s.bsp for development",
                file=context.err,
            )
        printer = _ProgressPrinter(context.err)
        try:
            result = download_file(entry, data_dir, progress=printer, force=force)
        except DownloadError as exc:
            printer.finish()
            logger.error("%s", exc)
            failures.append(entry.filename)
            continue
        printer.finish()
        manifest.record(entry.key, result)
        manifest.save(data_dir)
        downloaded.append(entry.filename)
        print(
            f"{entry.filename}: {result.size_bytes} bytes, sha256 {result.sha256}"
            + (" (resumed)" if result.resumed else ""),
            file=context.out,
        )
    if failures:
        logger.error("%d download(s) failed: %s", len(failures), ", ".join(failures))
        return _FetchReport(EXIT_FAILURE, tuple(downloaded))
    return _FetchReport(EXIT_OK, tuple(downloaded))


class _ProgressPrinter:
    """One updating line per file on a TTY; silent otherwise (logs carry the outcome)."""

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream
        self._tty = stream.isatty()
        self._last_percent = -1
        self._active = False

    def __call__(self, filename: str, downloaded: int, total: int) -> None:
        if not self._tty:
            return
        if total > 0:
            percent = downloaded * 100 // total
            if percent == self._last_percent:
                return
            self._last_percent = percent
            text = f"\r{filename}: {downloaded / 1e6:.1f} / {total / 1e6:.1f} MB ({percent}%)"
        else:
            text = f"\r{filename}: {downloaded / 1e6:.1f} MB"
        self._stream.write(text.ljust(79))
        self._stream.flush()
        self._active = True

    def finish(self) -> None:
        if self._active:
            self._stream.write("\n")
            self._stream.flush()
            self._active = False


class _CliHandler(logging.StreamHandler[TextIO]):
    """Marks the handler `main()` installs so a second call replaces it (tests)."""


def _remove_cli_handlers() -> None:
    root = logging.getLogger("skyapi")
    for handler in list(root.handlers):
        if isinstance(handler, _CliHandler):
            root.removeHandler(handler)


def _configure_logging(*, verbose: bool) -> None:
    root = logging.getLogger("skyapi")
    _remove_cli_handlers()
    handler = _CliHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    root.addHandler(handler)
    root.setLevel(logging.DEBUG if verbose else logging.INFO)


if __name__ == "__main__":
    raise SystemExit(main())
