"""Frozen in-memory view of the catalog caches, loaded once at startup (D33, brief l.535).

`load_catalog_state(cache)` reads the artifacts written by `catalogs/builders.py` under
`DATA_DIR/cache` and the artifact identities (`sha256` = ETag, `version`) from
`cache/manifest.json` when `data/caches.py` has written it. Nothing here recomputes astronomy.
"""

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from pydantic import TypeAdapter

from skyapi.catalogs.artifacts import CachePaths
from skyapi.catalogs.formats import StarTable, read_skys
from skyapi.models.catalogs import ConstellationsResponse, DsoEntry, StarIndexEntry

_DSO_ADAPTER: TypeAdapter[list[DsoEntry]] = TypeAdapter(list[DsoEntry])
_INDEX_ADAPTER: TypeAdapter[list[StarIndexEntry]] = TypeAdapter(list[StarIndexEntry])
_MESSIER_NAME = re.compile(r"^M(\d+)$")


class CatalogStateError(RuntimeError):
    """A cache artifact is missing or malformed: run `sky-data build-caches`."""


@dataclass(frozen=True, slots=True)
class ArtifactIdentity:
    """What `/meta.catalogs.<name>` and the ETag need from `cache/manifest.json` (D33)."""

    sha256: str
    version: str
    declared_license: str | None = None


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
    dso: DsoCatalog
    constellations: ConstellationsResponse
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
    """`artifacts.{name}.{sha256, version, declared_license?}` from `cache/manifest.json`."""
    if not manifest_path.is_file():
        return {}
    document: object = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise CatalogStateError(f"{manifest_path}: expected a JSON object")
    artifacts: object = document.get("artifacts", {})  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
    if not isinstance(artifacts, dict):
        raise CatalogStateError(f"{manifest_path}: `artifacts` must be an object")
    identities: dict[str, ArtifactIdentity] = {}
    for name, record in artifacts.items():  # pyright: ignore[reportUnknownVariableType]
        if not isinstance(record, dict):
            raise CatalogStateError(f"{manifest_path}: artifact {name!r} must be an object")
        typed: dict[str, Any] = {str(key): value for key, value in record.items()}  # pyright: ignore[reportUnknownVariableType, reportUnknownArgumentType]
        license_value = typed.get("declared_license")
        identities[str(name)] = ArtifactIdentity(  # pyright: ignore[reportUnknownArgumentType]
            sha256=str(typed["sha256"]),
            version=str(typed["version"]),
            declared_license=str(license_value) if license_value is not None else None,
        )
    return identities


def load_catalog_state(cache: CachePaths) -> CatalogState:
    """Load every catalog artifact from the cache directory (`CatalogStateError` when missing)."""
    stars = read_skys(_require(cache.stars_skys).read_bytes())
    if not np.all(stars.mag[1:] >= stars.mag[:-1]):
        raise CatalogStateError(f"{cache.stars_skys.name}: not sorted by magnitude")
    hipparcos = load_hipparcos_table(cache.hipparcos_parquet)
    star_index = _INDEX_ADAPTER.validate_json(_require(cache.stars_index).read_bytes())
    dso_entries = _DSO_ADAPTER.validate_json(_require(cache.dso_json).read_bytes())
    constellations = ConstellationsResponse.model_validate_json(
        _require(cache.constellations_json).read_bytes()
    )
    return CatalogState(
        stars=stars,
        hipparcos=hipparcos,
        star_index=tuple(star_index),
        dso=build_dso_catalog(dso_entries),
        constellations=constellations,
        identities=read_identities(cache.manifest),
    )
