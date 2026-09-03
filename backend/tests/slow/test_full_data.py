"""Full-data cache build (marker `slow`, brief l.400): counts, sizes and timing on the real files.

Runs only where `make data` has filled `DATA_DIR`; otherwise it skips with an explicit reason
(a data-availability condition, documented in `docs/testing.md`, never a gate bypass).
`make check` excludes `slow`; `make test` runs it.
"""

import json
import os
import time
from pathlib import Path

import pandas as pd
import pytest

from skyapi.catalogs.artifacts import cache_paths
from skyapi.catalogs.formats import read_skys
from skyapi.data.caches import build_all
from skyapi.data.registry import load_registry

pytestmark = pytest.mark.slow

KERNEL_FILES = ("de440s.bsp", "pck00011.tpc", "moon_de440_250416.tf", "moon_pa_de440_200625.bpc")
FULL_FILES = (
    "hip_main.dat",
    "hyg_v44.csv.gz",
    "NGC.csv",
    "addendum.csv",
    "stellarium_modern_index.json",
    "stellarium_modern_description.md",
    "constellations.bounds.json",
    "MPCORB.DAT",
    "CometEls.txt",
)


@pytest.fixture(scope="module")
def full_data_dir(kernels_dir: Path) -> Path:
    missing = [name for name in FULL_FILES if not (kernels_dir / name).is_file()]
    if missing:
        pytest.skip(
            "full data files not present in DATA_DIR: run `make data` "
            f"(missing: {', '.join(missing)})"
        )
    return kernels_dir


def test_full_build_counts_sizes_and_timing(
    full_data_dir: Path, tmp_path_factory: pytest.TempPathFactory
) -> None:
    # Build into a scratch directory: the raw files are symlinked so the developer's real
    # `data/cache` is never touched by the test suite.
    scratch = tmp_path_factory.mktemp("full-data")
    for name in KERNEL_FILES + FULL_FILES:
        os.symlink(full_data_dir / name, scratch / name)
    started = time.perf_counter()
    build_all(scratch, load_registry())
    elapsed = time.perf_counter() - started
    paths = cache_paths(scratch)

    stars = read_skys(paths.stars_skys.read_bytes())
    assert 117_000 <= len(stars.hip) <= 118_500, "Hipparcos rows with a position"
    assert 3_500_000 < paths.stars_skys.stat().st_size < 4_200_000, "stars.skys about 3.8 MB"
    index = json.loads(paths.stars_index.read_text(encoding="utf-8"))
    assert 3_000 <= len(index) <= 4_500, "named or designated stars (brief l.142: about 4000)"

    dso = json.loads(paths.dso_json.read_text(encoding="utf-8"))
    assert len(dso) > 1_000
    assert sum(1 for entry in dso if entry.get("messier") is not None) == 109
    assert any(entry["id"] == "NGC224" and entry.get("messier") == 31 for entry in dso)

    constellations = json.loads(paths.constellations_json.read_text(encoding="utf-8"))
    assert len(constellations["constellations"]) == 88
    serpens = next(c for c in constellations["constellations"] if c["abbr"] == "Ser")
    assert serpens["boundary_parts"] is not None
    assert len(serpens["boundary_parts"]) == 2

    # pandas-stubs declares the pyarrow overload with a mandatory `to_pandas_kwargs`
    # (`catalogs/mpc_build.py::read_mpc_parquet` carries the same note).
    asteroids = pd.read_parquet(
        paths.mpc_asteroids, engine="pyarrow", columns=["id"], to_pandas_kwargs={}
    )
    comets = pd.read_parquet(
        paths.mpc_comets, engine="pyarrow", columns=["id"], to_pandas_kwargs={}
    )
    assert len(asteroids) > 1_000_000
    assert len(comets) > 500
    assert paths.manifest.is_file()

    # Budget: the whole build well under the 60 s "ready" budget for everything but MPC
    # (brief l.256); MPC itself was measured at about 22 s on the development machine.
    assert elapsed < 300, f"full cache build took {elapsed:.1f} s"
    print(
        f"\nfull cache build: {elapsed:.1f} s; stars {len(stars.hip)}, index {len(index)}, "
        f"dso {len(dso)}, asteroids {len(asteroids)}, comets {len(comets)}"
    )
