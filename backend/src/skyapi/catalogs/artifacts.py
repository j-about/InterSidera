"""Shared types for cache artifacts: what a builder produces and where caches live (D33).

`data/caches.py` orchestrates the builders and writes `cache/manifest.json`; the builders in
`catalogs/builders.py` and `catalogs/mpc_build.py` return `BuildResult`s. Keeping these types
here lets the three modules evolve independently.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

CACHE_FORMAT_VERSION = 1


@dataclass(frozen=True, slots=True)
class CachePaths:
    """Every artifact path under `DATA_DIR/cache` (D33)."""

    root: Path

    @property
    def stars_skys(self) -> Path:
        return self.root / "stars.skys"

    @property
    def stars_index(self) -> Path:
        return self.root / "stars_index.json"

    @property
    def hipparcos_parquet(self) -> Path:
        return self.root / "hipparcos.parquet"

    @property
    def dso_json(self) -> Path:
        return self.root / "dso.json"

    @property
    def constellations_json(self) -> Path:
        return self.root / "constellations.json"

    @property
    def mpc_dir(self) -> Path:
        return self.root / "mpc"

    @property
    def mpc_asteroids(self) -> Path:
        return self.mpc_dir / "asteroids.parquet"

    @property
    def mpc_comets(self) -> Path:
        return self.mpc_dir / "comets.parquet"

    @property
    def mpc_index(self) -> Path:
        return self.mpc_dir / "index.parquet"

    @property
    def manifest(self) -> Path:
        return self.root / "manifest.json"


def cache_paths(data_dir: Path) -> CachePaths:
    return CachePaths(root=data_dir / "cache")


@dataclass(frozen=True, slots=True)
class Artifact:
    """One built file: identity for ETags and `/meta.catalogs` (brief l.124-125, l.535)."""

    name: str
    path: Path
    sha256: str
    bytes: int
    count: int
    version: str
    source_keys: tuple[str, ...]
    meta: Mapping[str, float | int | str | tuple[float, float] | None]
    declared_license: str | None = None


@dataclass(frozen=True, slots=True)
class BuildResult:
    artifacts: tuple[Artifact, ...]


def artifact_version(source_sha256s: Mapping[str, str]) -> str:
    """`"<cache_format_version>-<12 hex>"` from the sorted source hashes (D33)."""
    import hashlib

    digest = hashlib.sha256()
    for key in sorted(source_sha256s):
        digest.update(key.encode())
        digest.update(source_sha256s[key].encode())
    return f"{CACHE_FORMAT_VERSION}-{digest.hexdigest()[:12]}"
