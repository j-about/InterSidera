"""Cache bookkeeping under `DATA_DIR/cache` (D33): manifest, staleness, orchestration.

`build_all` runs the catalog builders (`catalogs/builders.py`, `catalogs/mpc_build.py`) and
writes `cache/manifest.json`, the one file the M2 lifespan reads to know the catalog versions,
ETags and `/meta.catalogs` metadata. A group of artifacts is rebuilt only when one of its source
files changed (SHA-256 of the file in `DATA_DIR`, or of the packaged copy for `committed` entries
such as `constellation_names.csv`), the cache format version changed, an artifact is missing or
corrupt, the DSO selection options changed, or `--force` was given. A group whose missing sources
are all `required = false` in the registry is skipped with a warning (brief l.280: missing
optional data degrades the API, it never blocks the build).
"""

import json
import logging
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from importlib import resources
from importlib.metadata import version
from pathlib import Path
from typing import Protocol, cast

from skyapi.catalogs.artifacts import (
    CACHE_FORMAT_VERSION,
    Artifact,
    BuildResult,
    CachePaths,
    cache_paths,
)
from skyapi.data.download import sha256_of, utc_now_iso
from skyapi.data.registry import DataFile, Registry, package_root

logger = logging.getLogger(__name__)

MetaValue = float | int | str | tuple[float, float] | None
CONSTELLATION_NAMES_KEY = "constellation_names"


class CacheError(Exception):
    """Caches could not be built or read."""


class MissingSourceError(CacheError):
    """A required source file is absent from `DATA_DIR` (run `sky-data fetch`)."""


# --------------------------------------------------------------------------------- builders


class StarsBuilder(Protocol):
    def __call__(self, hip_main: Path, hyg_csv_gz: Path, out: CachePaths) -> BuildResult: ...


class DsoBuilder(Protocol):
    def __call__(
        self,
        ngc_csv: Path,
        addendum_csv: Path,
        out: CachePaths,
        *,
        mag_limit: float = ...,
        size_arcmin: float = ...,
    ) -> BuildResult: ...


class ConstellationsBuilder(Protocol):
    def __call__(
        self,
        index_json: Path,
        description_md: Path,
        bounds_json: Path,
        names_csv: Path,
        hipparcos_parquet: Path,
        out: CachePaths,
    ) -> BuildResult: ...


class MpcBuilder(Protocol):
    def __call__(self, mpcorb_dat: Path, comet_els: Path, out: CachePaths) -> BuildResult: ...


@dataclass(frozen=True, slots=True)
class Builders:
    """The four builder callables; tests inject fakes, `_builders()` returns the real ones."""

    stars: StarsBuilder
    dso: DsoBuilder
    constellations: ConstellationsBuilder
    mpc: MpcBuilder


def _builders() -> Builders:
    from skyapi.catalogs import builders, mpc_build

    return Builders(
        stars=builders.build_stars,
        dso=builders.build_dso,
        constellations=builders.build_constellations,
        mpc=mpc_build.build_mpc,
    )


# --------------------------------------------------------------------------------- manifest


@dataclass(frozen=True, slots=True)
class ArtifactRecord:
    """One artifact in `cache/manifest.json` (`path` is relative to the cache directory)."""

    path: str
    sha256: str
    bytes: int
    count: int
    version: str
    source_keys: tuple[str, ...]
    meta: Mapping[str, MetaValue]
    declared_license: str | None = None

    def to_json(self) -> dict[str, object]:
        return {
            "path": self.path,
            "sha256": self.sha256,
            "bytes": self.bytes,
            "count": self.count,
            "version": self.version,
            "source_keys": list(self.source_keys),
            "declared_license": self.declared_license,
            "meta": {key: _meta_to_json(value) for key, value in self.meta.items()},
        }

    @classmethod
    def from_json(cls, data: Mapping[str, object]) -> ArtifactRecord:
        meta_raw = data.get("meta", {})
        if not isinstance(meta_raw, dict):
            raise CacheError("artifact 'meta' must be an object")
        meta = {
            str(key): _meta_from_json(value)
            for key, value in cast(dict[object, object], meta_raw).items()
        }
        declared = data.get("declared_license")
        if declared is not None and not isinstance(declared, str):
            raise CacheError("artifact 'declared_license' must be a string")
        return cls(
            path=_str(data, "path"),
            sha256=_str(data, "sha256"),
            bytes=_int(data, "bytes"),
            count=_int(data, "count"),
            version=_str(data, "version"),
            source_keys=_str_tuple(data, "source_keys"),
            meta=meta,
            declared_license=declared,
        )


@dataclass(frozen=True, slots=True)
class CacheManifest:
    """`cache/manifest.json` (D33)."""

    cache_format_version: int
    skyapi_version: str
    built_at: str
    sources: Mapping[str, str]
    artifacts: Mapping[str, ArtifactRecord]

    def to_json(self) -> dict[str, object]:
        return {
            "cache_format_version": self.cache_format_version,
            "skyapi_version": self.skyapi_version,
            "built_at": self.built_at,
            "sources": dict(sorted(self.sources.items())),
            "artifacts": {
                name: record.to_json() for name, record in sorted(self.artifacts.items())
            },
        }

    @classmethod
    def from_json(cls, data: Mapping[str, object]) -> CacheManifest:
        sources_raw = data.get("sources", {})
        artifacts_raw = data.get("artifacts", {})
        if not isinstance(sources_raw, dict) or not isinstance(artifacts_raw, dict):
            raise CacheError("'sources' and 'artifacts' must be objects")
        sources: dict[str, str] = {}
        for key, value in cast(dict[object, object], sources_raw).items():
            if not isinstance(key, str) or not isinstance(value, str):
                raise CacheError("'sources' must map keys to sha256 strings")
            sources[key] = value
        artifacts: dict[str, ArtifactRecord] = {}
        for name, value in cast(dict[object, object], artifacts_raw).items():
            if not isinstance(name, str) or not isinstance(value, dict):
                raise CacheError("'artifacts' must map names to objects")
            artifacts[name] = ArtifactRecord.from_json(cast(dict[str, object], value))
        return cls(
            cache_format_version=_int(data, "cache_format_version"),
            skyapi_version=_str(data, "skyapi_version"),
            built_at=_str(data, "built_at"),
            sources=sources,
            artifacts=artifacts,
        )

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(self.to_json(), indent=2) + "\n", encoding="utf-8", newline="\n")
        os.replace(tmp, path)

    @classmethod
    def load(cls, path: Path) -> CacheManifest | None:
        """The manifest, or None when the caches were never built."""
        if not path.is_file():
            return None
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise CacheError(f"unreadable cache manifest {path}: {exc}") from exc
        if not isinstance(document, dict):
            raise CacheError(f"unreadable cache manifest {path}: not a JSON object")
        try:
            return cls.from_json(cast(dict[str, object], document))
        except CacheError as exc:
            raise CacheError(f"unreadable cache manifest {path}: {exc}") from exc


# ----------------------------------------------------------------------------------- groups


@dataclass(frozen=True, slots=True)
class CacheGroup:
    """Artifacts built together from the same source files.

    Whether a group may be skipped when its sources are absent is not a property of the group:
    it follows the `required` flag of each missing registry entry (brief l.280).
    """

    name: str
    source_keys: tuple[str, ...]
    artifact_paths: Callable[[CachePaths], tuple[Path, ...]]


STARS = CacheGroup(
    "stars",
    ("hipparcos", "hyg"),
    lambda p: (p.stars_skys, p.stars_index, p.hipparcos_parquet),
)
DSO = CacheGroup("dso", ("ngc", "ngc_addendum"), lambda p: (p.dso_json,))
# The committed `constellation_names.csv` is a source like the downloads: the builder hashes it
# into the artifact version, so editing it must make the group stale (hashed from the packaged
# copy, ADR-0005).
CONSTELLATIONS = CacheGroup(
    "constellations",
    (
        "stellarium_modern",
        "stellarium_description",
        "d3_bounds",
        "hipparcos",
        CONSTELLATION_NAMES_KEY,
    ),
    lambda p: (p.constellations_json,),
)
MPC = CacheGroup(
    "mpc", ("mpcorb", "comets"), lambda p: (p.mpc_asteroids, p.mpc_comets, p.mpc_index)
)
# Order matters: the constellations builder reads the `hipparcos.parquet` the stars build wrote.
GROUPS: tuple[CacheGroup, ...] = (STARS, DSO, CONSTELLATIONS, MPC)


@dataclass(frozen=True, slots=True)
class BuildOptions:
    dso_mag_limit: float = 14.0
    dso_size_arcmin: float = 5.0


# ---------------------------------------------------------------------------------- sources


def _source_present(data_dir: Path, entry: DataFile) -> bool:
    """`DATA_DIR/<filename>` for downloads; the packaged copy for `committed` entries."""
    if entry.kind == "committed":
        return (package_root() / entry.filename).is_file()
    return (data_dir / entry.filename).is_file()


def _source_sha256(data_dir: Path, entry: DataFile) -> str:
    if entry.kind == "committed":
        # ADR-0005: committed data is read through importlib.resources (works from a wheel too).
        with resources.as_file(package_root() / entry.filename) as path:
            return sha256_of(path)
    return sha256_of(data_dir / entry.filename)


# ------------------------------------------------------------------------------- operations


def caches_are_current(data_dir: Path, registry: Registry, manifest: CacheManifest | None) -> bool:
    """True when every recorded source still hashes the same and the format version matches."""
    if manifest is None or manifest.cache_format_version != CACHE_FORMAT_VERSION:
        return False
    for key, recorded in manifest.sources.items():
        entry = registry.by_key(key)
        if not _source_present(data_dir, entry) or _source_sha256(data_dir, entry) != recorded:
            return False
    return True


def verify_caches(data_dir: Path) -> list[str]:
    """Problems with the built caches (empty list = every recorded artifact is intact)."""
    paths = cache_paths(data_dir)
    try:
        manifest = CacheManifest.load(paths.manifest)
    except CacheError as exc:
        return [str(exc)]
    if manifest is None:
        return [f"{paths.manifest} missing: caches not built"]
    problems: list[str] = []
    if manifest.cache_format_version != CACHE_FORMAT_VERSION:
        problems.append(
            f"cache format version {manifest.cache_format_version}, expected {CACHE_FORMAT_VERSION}"
        )
    for name, record in sorted(manifest.artifacts.items()):
        path = paths.root / record.path
        if not path.is_file():
            problems.append(f"{name}: {record.path} missing")
        elif path.stat().st_size != record.bytes or sha256_of(path) != record.sha256:
            problems.append(f"{name}: {record.path} does not match its recorded sha256")
    return problems


def build_all(
    data_dir: Path,
    registry: Registry,
    *,
    force: bool = False,
    dso_mag_limit: float = 14.0,
    dso_size_arcmin: float = 5.0,
    builders: Builders | None = None,
) -> CacheManifest:
    """Build every stale cache group and write `cache/manifest.json`; idempotent (D33)."""
    paths = cache_paths(data_dir)
    paths.root.mkdir(parents=True, exist_ok=True)
    options = BuildOptions(dso_mag_limit=dso_mag_limit, dso_size_arcmin=dso_size_arcmin)
    existing = CacheManifest.load(paths.manifest)
    hashes: dict[str, str] = {}
    records: dict[str, ArtifactRecord] = {}
    for group in GROUPS:
        entries = [registry.by_key(key) for key in group.source_keys]
        missing = [entry for entry in entries if not _source_present(data_dir, entry)]
        if missing:
            # Brief l.280: data marked `required = false` in the registry (OpenNGC, Stellarium,
            # d3-celestial, MPC) leaves the API degraded when absent, never not-ready: the group
            # is skipped with a warning and the other groups are still built.
            names = ", ".join(entry.key for entry in missing)
            if any(entry.required for entry in missing):
                raise MissingSourceError(
                    f"cannot build the {group.name} cache: missing {names}"
                    " in DATA_DIR (run `sky-data fetch`)"
                )
            logger.warning(
                "%s cache skipped: %s missing from DATA_DIR (optional data, the API degrades)",
                group.name,
                names,
            )
            _carry_over(existing, group, paths, hashes, records)
            continue
        for entry in entries:
            if entry.key not in hashes:
                hashes[entry.key] = _source_sha256(data_dir, entry)
        group_hashes = {key: hashes[key] for key in group.source_keys}
        if not force and not _is_stale(existing, group, group_hashes, paths, options):
            logger.info("%s cache up to date", group.name)
            _carry_over(existing, group, paths, hashes, records)
            continue
        logger.info("building the %s cache", group.name)
        result = _run(group, registry, data_dir, paths, options, builders or _builders())
        for artifact in result.artifacts:
            records[artifact.name] = _record(artifact, paths.root)
    manifest = CacheManifest(
        cache_format_version=CACHE_FORMAT_VERSION,
        skyapi_version=version("skyapi"),
        built_at=utc_now_iso(),
        sources=hashes,
        artifacts=records,
    )
    manifest.save(paths.manifest)
    return manifest


def _run(
    group: CacheGroup,
    registry: Registry,
    data_dir: Path,
    paths: CachePaths,
    options: BuildOptions,
    builders: Builders,
) -> BuildResult:
    def source(key: str) -> Path:
        return data_dir / registry.by_key(key).filename

    if group is STARS:
        return builders.stars(source("hipparcos"), source("hyg"), paths)
    if group is DSO:
        return builders.dso(
            source("ngc"),
            source("ngc_addendum"),
            paths,
            mag_limit=options.dso_mag_limit,
            size_arcmin=options.dso_size_arcmin,
        )
    if group is CONSTELLATIONS:
        names = registry.by_key(CONSTELLATION_NAMES_KEY)
        with resources.as_file(package_root() / names.filename) as names_csv:
            return builders.constellations(
                source("stellarium_modern"),
                source("stellarium_description"),
                source("d3_bounds"),
                names_csv,
                paths.hipparcos_parquet,
                paths,
            )
    paths.mpc_dir.mkdir(parents=True, exist_ok=True)
    return builders.mpc(source("mpcorb"), source("comets"), paths)


def _is_stale(
    existing: CacheManifest | None,
    group: CacheGroup,
    group_hashes: Mapping[str, str],
    paths: CachePaths,
    options: BuildOptions,
) -> bool:
    if existing is None or existing.cache_format_version != CACHE_FORMAT_VERSION:
        return True
    if any(existing.sources.get(key) != digest for key, digest in group_hashes.items()):
        return True
    expected = {_relative(path, paths.root) for path in group.artifact_paths(paths)}
    records = {r.path: r for r in existing.artifacts.values() if r.path in expected}
    if set(records) != expected:
        return True
    for record in records.values():
        path = paths.root / record.path
        if not path.is_file() or path.stat().st_size != record.bytes:
            return True
        if sha256_of(path) != record.sha256:
            return True
        if group is DSO and (
            record.meta.get("mag_limit") != options.dso_mag_limit
            or record.meta.get("size_arcmin") != options.dso_size_arcmin
        ):
            return True
    return False


def _carry_over(
    existing: CacheManifest | None,
    group: CacheGroup,
    paths: CachePaths,
    hashes: dict[str, str],
    records: dict[str, ArtifactRecord],
) -> None:
    """Keep the previous records (and their source hashes) of a group that was not rebuilt."""
    if existing is None:
        return
    expected = {_relative(path, paths.root) for path in group.artifact_paths(paths)}
    kept = False
    for name, record in existing.artifacts.items():
        if record.path in expected:
            records[name] = record
            kept = True
    if kept:
        for key in group.source_keys:
            if key not in hashes and key in existing.sources:
                hashes[key] = existing.sources[key]


def _record(artifact: Artifact, root: Path) -> ArtifactRecord:
    return ArtifactRecord(
        path=_relative(artifact.path, root),
        sha256=artifact.sha256,
        bytes=artifact.bytes,
        count=artifact.count,
        version=artifact.version,
        source_keys=tuple(artifact.source_keys),
        meta=dict(artifact.meta),
        declared_license=artifact.declared_license,
    )


def _relative(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def _meta_to_json(value: MetaValue) -> object:
    return list(value) if isinstance(value, tuple) else value


def _meta_from_json(value: object) -> MetaValue:
    if value is None or isinstance(value, (int, float, str)):
        return value
    if isinstance(value, list):
        items = cast(list[object], value)
        if len(items) == 2 and all(isinstance(item, (int, float)) for item in items):
            return (float(cast(float, items[0])), float(cast(float, items[1])))
    raise CacheError(f"unsupported meta value {value!r}")


def _str(data: Mapping[str, object], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str):
        raise CacheError(f"field {key!r} must be a string")
    return value


def _int(data: Mapping[str, object], key: str) -> int:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise CacheError(f"field {key!r} must be an integer")
    return value


def _str_tuple(data: Mapping[str, object], key: str) -> tuple[str, ...]:
    value = data.get(key)
    if not isinstance(value, list):
        raise CacheError(f"field {key!r} must be an array of strings")
    items: list[str] = []
    for item in cast(list[object], value):
        if not isinstance(item, str):
            raise CacheError(f"field {key!r} must be an array of strings")
        items.append(item)
    return tuple(items)
