"""Frozen in-memory view of the catalog caches, loaded once at startup (D33, D53, brief l.535).

`load_catalog_state(cache)` reads the artifacts written by `catalogs/builders.py` under
`DATA_DIR/cache` and the artifact identities (`sha256` = ETag, `version`, `count`, `meta`) from
`cache/manifest.json` when `data/caches.py` has written it. The star artifacts are mandatory;
the DSO and constellation artifacts are optional (`None` when absent: the API is degraded for
them, brief l.280). Nothing here recomputes astronomy.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType

import numpy as np
import pandas as pd
from pydantic import TypeAdapter

from skyapi.catalogs.artifacts import CachePaths
from skyapi.catalogs.formats import StarTable, read_skys
from skyapi.data.caches import CacheError, CacheManifest, MetaValue
from skyapi.models.catalogs import ConstellationsResponse, DsoEntry, StarIndexEntry

_DSO_ADAPTER: TypeAdapter[list[DsoEntry]] = TypeAdapter(list[DsoEntry])
_INDEX_ADAPTER: TypeAdapter[list[StarIndexEntry]] = TypeAdapter(list[StarIndexEntry])
_MESSIER_NAME = re.compile(r"^M(\d+)$")
_NO_META: Mapping[str, MetaValue] = MappingProxyType({})


class CatalogStateError(RuntimeError):
    """A cache artifact is missing or malformed: run `sky-data build-caches`."""


class CatalogUnavailableError(RuntimeError):
    """An optional catalog is not loaded (its data is missing): the API is degraded for it."""

    def __init__(self, name: str) -> None:
        super().__init__(f"the {name} catalog is not loaded: its data is missing (degraded)")
        self.name = name


@dataclass(frozen=True, slots=True)
class ArtifactIdentity:
    """What `/meta.catalogs.<name>` and the ETag need from `cache/manifest.json` (D33, D53)."""

    sha256: str
    version: str
    declared_license: str | None = None
    count: int = 0
    meta: Mapping[str, MetaValue] = _NO_META


@dataclass(frozen=True, slots=True)
class DsoCatalog:
    entries: tuple[DsoEntry, ...]
    by_id: Mapping[str, DsoEntry]
    messier: Mapping[int, DsoEntry]
    """Messier number -> object, including the aliases the builder wrote into `names` (M102)."""


@dataclass(frozen=True, slots=True)
class CatalogState:
    stars: StarTable
    hipparcos: pd.DataFrame
    """Indexed by `hip`, with `ra_hours` added so `Star.from_dataframe` works on any row set."""
    star_index: tuple[StarIndexEntry, ...]
    dso: DsoCatalog | None
    """`None` when the OpenNGC data is missing (degraded)."""
    constellations: ConstellationsResponse | None
    """`None` when the Stellarium or d3-celestial data is missing (degraded)."""
    identities: Mapping[str, ArtifactIdentity]
    """Per artifact name; empty when `cache/manifest.json` is absent."""


def _require(path: Path) -> Path:
    if not path.is_file():
        raise CatalogStateError(f"missing cache artifact {path}: run `sky-data build-caches`")
    return path


def load_hipparcos_table(path: Path) -> pd.DataFrame:
    frame = pd.read_parquet(_require(path), engine="pyarrow", to_pandas_kwargs={}).set_index("hip")
    if not frame.index.is_unique:
        raise CatalogStateError(f"{path.name}: duplicate HIP identifiers")
    return frame.assign(ra_hours=frame["ra_degrees"] / 15.0)


def build_dso_catalog(entries: list[DsoEntry]) -> DsoCatalog:
    by_id: dict[str, DsoEntry] = {}
    messier: dict[int, DsoEntry] = {}
    for entry in entries:
        if entry.id in by_id:
            raise CatalogStateError(f"duplicate DSO id {entry.id}")
        by_id[entry.id] = entry
        if entry.messier is not None:
            messier[entry.messier] = entry
    for entry in entries:
        for name in entry.names:
            match = _MESSIER_NAME.match(name)
            if match is not None and int(match.group(1)) != entry.messier:
                messier.setdefault(int(match.group(1)), entry)
    return DsoCatalog(entries=tuple(entries), by_id=by_id, messier=messier)


def read_identities(manifest_path: Path) -> Mapping[str, ArtifactIdentity]:
    """Artifact identities from `cache/manifest.json` (empty when the caches were never built)."""
    try:
        manifest = CacheManifest.load(manifest_path)
    except CacheError as exc:
        raise CatalogStateError(str(exc)) from exc
    if manifest is None:
        return {}
    return {
        name: ArtifactIdentity(
            sha256=record.sha256,
            version=record.version,
            declared_license=record.declared_license,
            count=record.count,
            meta=record.meta,
        )
        for name, record in manifest.artifacts.items()
    }


def load_catalog_state(cache: CachePaths) -> CatalogState:
    """Load the catalog artifacts (`CatalogStateError` when a star artifact is missing).

    The DSO and constellation artifacts are optional: absent files leave the corresponding
    field `None` so the API can run degraded (brief l.280).
    """
    stars = read_skys(_require(cache.stars_skys).read_bytes())
    if not np.all(stars.mag[1:] >= stars.mag[:-1]):
        raise CatalogStateError(f"{cache.stars_skys.name}: not sorted by magnitude")
    hipparcos = load_hipparcos_table(cache.hipparcos_parquet)
    star_index = _INDEX_ADAPTER.validate_json(_require(cache.stars_index).read_bytes())
    dso: DsoCatalog | None = None
    if cache.dso_json.is_file():
        dso = build_dso_catalog(_DSO_ADAPTER.validate_json(cache.dso_json.read_bytes()))
    constellations: ConstellationsResponse | None = None
    if cache.constellations_json.is_file():
        constellations = ConstellationsResponse.model_validate_json(
            cache.constellations_json.read_bytes()
        )
    return CatalogState(
        stars=stars,
        hipparcos=hipparcos,
        star_index=tuple(star_index),
        dso=dso,
        constellations=constellations,
        identities=read_identities(cache.manifest),
    )
