"""Fixtures for the data pipeline tests (registry, downloader, caches, CLI).

`tests/conftest.py` imports the fixtures by name. `local_data` writes a small registry whose
URLs point at a `LocalServer` serving synthetic files from a temporary directory;
its file names deliberately differ from the real datasets so that a `data_dir` holding the real
test kernels can never collide with them.
"""

import gzip
import hashlib
import json
import random
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

import pytest

from skyapi.catalogs.artifacts import CACHE_FORMAT_VERSION, Artifact, BuildResult, CachePaths
from skyapi.data.caches import Builders
from skyapi.data.registry import Registry, load_registry
from support.httpserver import LocalServer, serving

TomlValue = str | int | bool | list[str]

# Content of every synthetic download, keyed by registry key: (served name, payload builder).
_SEED = 20260903


def _random_bytes(size: int, seed: int) -> bytes:
    return random.Random(seed).randbytes(size)


def _text_lines(count: int, seed: int) -> bytes:
    rng = random.Random(seed)
    lines = [f"{index:06d}|{rng.random():.12f}|row {index}" for index in range(count)]
    return ("\n".join(lines) + "\n").encode()


def toml_document(
    files: Sequence[Mapping[str, TomlValue]],
    excerpts: Sequence[Mapping[str, TomlValue]] = (),
) -> str:
    """Serialise flat tables (str/int/bool/list[str] values) into a registry TOML document."""
    chunks: list[str] = []
    for table_name, tables in (("files", files), ("excerpts", excerpts)):
        for table in tables:
            lines = [f"[[{table_name}]]"]
            for key, value in table.items():
                lines.append(f"{key} = {_toml_value(value)}")
            chunks.append("\n".join(lines))
    return "\n\n".join(chunks) + "\n"


def _toml_value(value: TomlValue) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value)
    return "[" + ", ".join(json.dumps(item) for item in value) + "]"


def write_registry(
    path: Path,
    files: Sequence[Mapping[str, TomlValue]],
    excerpts: Sequence[Mapping[str, TomlValue]] = (),
) -> Path:
    path.write_text(toml_document(files, excerpts), encoding="utf-8")
    return path


@dataclass(frozen=True)
class LocalData:
    """A registry served by a local HTTP server plus the bytes behind every download."""

    server: LocalServer
    registry_path: Path
    registry: Registry
    contents: Mapping[str, bytes]
    """Transferred bytes per key (compressed for the gunzip entry)."""
    inflated: Mapping[str, bytes]
    """Bytes as they should lie on disk per key."""
    served_names: Mapping[str, str]

    def url(self, key: str) -> str:
        return self.server.url_for(self.served_names[key])


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_local_data(server: LocalServer, registry_path: Path) -> LocalData:
    inflated: dict[str, bytes] = {
        "tiny_eph": _random_bytes(200_000, _SEED),
        "alt_eph": _random_bytes(65_536, _SEED + 1),
        "huge_eph": _random_bytes(4_096, _SEED + 2),
        "tiny_pck": _text_lines(400, _SEED + 3),
        "names_gz": gzip.compress(_text_lines(300, _SEED + 4), mtime=0),
        "refresh_txt": _text_lines(120, _SEED + 5),
        "packed": _text_lines(2_000, _SEED + 6),
        "small_opt": _text_lines(30, _SEED + 7),
        "bounds_never": _text_lines(60, _SEED + 8),
    }
    contents = dict(inflated)
    contents["packed"] = gzip.compress(inflated["packed"], mtime=0)
    served_names = {
        "tiny_eph": "tiny_eph.bsp",
        "alt_eph": "alt_eph.bsp",
        "huge_eph": "de441.bsp",
        "tiny_pck": "tiny.tpc",
        "names_gz": "names.csv.gz",
        "refresh_txt": "refresh.txt",
        "packed": "packed.dat.gz",
        "small_opt": "small_opt.txt",
        "bounds_never": "bounds.json",
    }
    for key, name in served_names.items():
        server.put(name, contents[key])

    def download(key: str, **extra: TomlValue) -> dict[str, TomlValue]:
        table: dict[str, TomlValue] = {
            "key": key,
            "kind": "download",
            "filename": served_names[key].removesuffix(".gz")
            if key == "packed"
            else served_names[key],
            "url": server.url_for(served_names[key]),
            "size_bytes": len(inflated[key]),
            "sha256": _sha256(inflated[key]),
            "min_size_bytes": 1024,
            "group": "kernels",
            "required": True,
            "optional": False,
            "refresh": "never",
            "license": "Public domain (test data)",
            "copyright": "none",
            "attribution": f"Synthetic test file {key}",
            "version_or_date": "synthetic",
        }
        table.update(extra)
        return table

    files: list[dict[str, TomlValue]] = [
        download(
            "tiny_eph", group="ephemeris", fallback_urls=[server.url_for("tiny_eph_mirror.bsp")]
        ),
        download("alt_eph", group="ephemeris", optional=True),
        {
            **{
                k: v
                for k, v in download("huge_eph", group="ephemeris", optional=True).items()
                if k != "sha256"
            },
            "size_bytes": 3_307_878_400,
            "sha256_pending": True,
            "min_size_bytes": 3_000_000_000,
        },
        download("tiny_pck", refresh="rarely"),
        download(
            "names_gz",
            group="names",
            refresh="yearly",
            license="CC-BY-SA-4.0",
            license_file="CC-BY-SA-4.0-notice.txt",
        ),
        download("refresh_txt", group="mpc", required=False, refresh="weekly"),
        download("packed", group="mpc", required=False, refresh="weekly", gunzip=True),
        download("small_opt", group="dso", required=False, optional=True, refresh="yearly"),
        # Like the d3-celestial bounds: unpinned, fetched once and never refreshed.
        download("bounds_never", group="constellations", required=False, refresh="never"),
        {
            "key": "builtin_tables",
            "kind": "builtin",
            "filename": "bundled tables",
            "group": "earth_orientation",
            "refresh": "rarely",
            "license": "MIT",
            "copyright": "Copyright (c) 2013-2018 Brandon Rhodes",
            "license_file": "MIT-skyfield.txt",
            "attribution": "Bundled tables (MIT)",
            "version_or_date": "1.0",
        },
        {
            "key": "service",
            "kind": "runtime_service",
            "filename": "public geocoder",
            "url": "https://geocoder.example.org",
            "group": "geocoder",
            "refresh": "never",
            "license": "ODbL-1.0",
            "attribution": "(c) Example contributors",
            "version_or_date": "service",
        },
        {
            "key": "committed_csv",
            "kind": "committed",
            "filename": "names.csv",
            "group": "constellations",
            "refresh": "never",
            "license": "Factual data",
            "attribution": "Authored for the tests",
            "version_or_date": "2026-09-03",
        },
        {
            "key": "icons",
            "kind": "ui_asset",
            "filename": "icon set",
            "group": "ui",
            "refresh": "rarely",
            "license": "ISC",
            "license_file": "ISC-lucide.txt",
            "attribution": "Icons (ISC)",
            "version_or_date": "pinned in the lockfile",
        },
    ]
    for table in files:
        if table["kind"] != "download":
            table.pop("sha256", None)
    # Unpinned entries (D30): the refreshable files and `bounds_never`; their recorded sizes and
    # hashes live in the manifest.
    for table in files:
        if table["kind"] != "download" or table["key"] == "names_gz":
            continue
        if table.get("refresh") in ("weekly", "yearly") or table["key"] == "bounds_never":
            table.pop("sha256")
            table["size_bytes"] = 0
    write_registry(registry_path, files)
    return LocalData(
        server=server,
        registry_path=registry_path,
        registry=load_registry(registry_path),
        contents=contents,
        inflated=inflated,
        served_names=served_names,
    )


@pytest.fixture
def http_root(tmp_path: Path) -> Path:
    root = tmp_path / "served"
    root.mkdir()
    return root


@pytest.fixture
def local_server(http_root: Path) -> Iterator[LocalServer]:
    with serving(http_root) as server:
        yield server


@pytest.fixture
def local_data(local_server: LocalServer, tmp_path: Path) -> LocalData:
    return build_local_data(local_server, tmp_path / "registry.toml")


@pytest.fixture
def local_registry(local_data: LocalData) -> Registry:
    return local_data.registry


@pytest.fixture
def local_registry_path(local_data: LocalData) -> Path:
    return local_data.registry_path


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    path = tmp_path / "data"
    path.mkdir()
    return path


# ------------------------------------------------------- fake catalog builders (caches, CLI)

SOURCE_KEYS = (
    "hipparcos",
    "hyg",
    "ngc",
    "ngc_addendum",
    "stellarium_modern",
    "stellarium_description",
    "d3_bounds",
    "mpcorb",
    "comets",
)
MPC_KEYS = ("mpcorb", "comets")


def write_sources(data_dir: Path, registry: Registry, keys: tuple[str, ...] = SOURCE_KEYS) -> None:
    for key in keys:
        (data_dir / registry.by_key(key).filename).write_text(f"source {key}\n")


def artifact(
    name: str, path: Path, payload: bytes, sources: tuple[str, ...], **meta: object
) -> Artifact:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return Artifact(
        name=name,
        path=path,
        sha256=hashlib.sha256(payload).hexdigest(),
        bytes=len(payload),
        count=len(payload),
        version=f"{CACHE_FORMAT_VERSION}-{hashlib.sha256(payload).hexdigest()[:12]}",
        source_keys=sources,
        meta=meta,  # type: ignore[arg-type]
        declared_license="CC BY-SA 4.0" if name == "constellations" else None,
    )


class FakeBuilders:
    """Writes deterministic payloads under `out`, derived from the source file contents."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def stars(self, hip_main: Path, hyg_csv_gz: Path, out: CachePaths) -> BuildResult:
        self.calls.append("stars")
        seed = hip_main.read_bytes() + hyg_csv_gz.read_bytes()
        return BuildResult(
            (
                artifact(
                    "stars",
                    out.stars_skys,
                    b"SKYS" + seed,
                    ("hipparcos", "hyg"),
                    epoch_tt=2451545.0,
                    magnitude_limit=13.0,
                ),
                artifact("stars_index", out.stars_index, b"[]" + seed, ("hyg",)),
                artifact("hipparcos", out.hipparcos_parquet, b"PAR1" + seed, ("hipparcos",)),
            )
        )

    def dso(
        self,
        ngc_csv: Path,
        addendum_csv: Path,
        out: CachePaths,
        *,
        mag_limit: float = 14.0,
        size_arcmin: float = 5.0,
    ) -> BuildResult:
        self.calls.append("dso")
        seed = (
            ngc_csv.read_bytes() + addendum_csv.read_bytes() + f"{mag_limit}/{size_arcmin}".encode()
        )
        return BuildResult(
            (
                artifact(
                    "dso",
                    out.dso_json,
                    b"{}" + seed,
                    ("ngc", "ngc_addendum"),
                    mag_limit=mag_limit,
                    size_arcmin=size_arcmin,
                ),
            )
        )

    def constellations(
        self,
        index_json: Path,
        description_md: Path,
        bounds_json: Path,
        names_csv: Path,
        hipparcos_parquet: Path,
        out: CachePaths,
    ) -> BuildResult:
        self.calls.append("constellations")
        assert names_csv.name == "constellation_names.csv"
        assert hipparcos_parquet == out.hipparcos_parquet
        seed = index_json.read_bytes() + description_md.read_bytes() + bounds_json.read_bytes()
        return BuildResult(
            (
                artifact(
                    "constellations",
                    out.constellations_json,
                    b"{}" + seed,
                    ("stellarium_modern", "stellarium_description", "d3_bounds", "hipparcos"),
                    culture="modern",
                ),
            )
        )

    def mpc(self, mpcorb_dat: Path, comet_els: Path, out: CachePaths) -> BuildResult:
        self.calls.append("mpc")
        seed = mpcorb_dat.read_bytes() + comet_els.read_bytes()
        return BuildResult(
            (
                artifact(
                    "mpc_asteroids", out.mpc_asteroids, b"PAR1a" + seed, MPC_KEYS, asteroids=3
                ),
                artifact("mpc_comets", out.mpc_comets, b"PAR1c" + seed, MPC_KEYS, comets=1),
                artifact(
                    "mpc_index",
                    out.mpc_index,
                    b"PAR1i" + seed,
                    MPC_KEYS,
                    elements_epoch_range_tt=(2460000.5, 2461000.5),
                ),
            )
        )

    def as_builders(self) -> Builders:
        return Builders(
            stars=self.stars, dso=self.dso, constellations=self.constellations, mpc=self.mpc
        )
