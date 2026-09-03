"""Session fixtures for the MPC cache: excerpts -> `build_mpc` -> index -> state.

Activate with `-p support.fixtures_mpc` (or wire it through `conftest.py`). The state fixture
needs `de440s.bsp` under `INTERSIDERA_TEST_DATA_DIR` (default `<repo>/data`, the documented
exception of `.claude/rules/backend-tests.md`); it fails with a clear message when absent.
"""

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest
from skyfield.api import load
from skyfield.jpllib import SpiceKernel

from skyapi.astro.minor_bodies import (
    MinorBodyIndex,
    MinorBodyState,
    load_minor_body_index,
    load_minor_body_state,
)
from skyapi.catalogs.artifacts import BuildResult, CachePaths
from skyapi.catalogs.mpc_build import build_mpc

REPO_ROOT = Path(__file__).resolve().parents[3]
EXCERPTS_DIR = Path(__file__).resolve().parents[1] / "fixtures" / "excerpts"


@dataclass(frozen=True)
class MpcExcerpts:
    mpcorb: Path
    comets: Path


@dataclass(frozen=True)
class MpcBuild:
    paths: CachePaths
    result: BuildResult


@pytest.fixture(scope="session")
def mpc_excerpts() -> MpcExcerpts:
    return MpcExcerpts(
        mpcorb=EXCERPTS_DIR / "MPCORB_excerpt.dat",
        comets=EXCERPTS_DIR / "CometEls_excerpt.txt",
    )


@pytest.fixture(scope="session")
def mpc_build(tmp_path_factory: pytest.TempPathFactory, mpc_excerpts: MpcExcerpts) -> MpcBuild:
    paths = CachePaths(root=tmp_path_factory.mktemp("mpc-cache"))
    result = build_mpc(mpc_excerpts.mpcorb, mpc_excerpts.comets, paths)
    return MpcBuild(paths=paths, result=result)


@pytest.fixture(scope="session")
def mpc_cache(mpc_build: MpcBuild) -> CachePaths:
    return mpc_build.paths


@pytest.fixture(scope="session")
def mpc_index(mpc_cache: CachePaths) -> MinorBodyIndex:
    return load_minor_body_index(mpc_cache)


@pytest.fixture(scope="session")
def de440s_kernel(kernels_dir: Path) -> Iterator[SpiceKernel]:
    """de440s from the shared kernel set (`kernels_dir` is defined in `conftest.py`, D38)."""
    kernel = SpiceKernel(str(kernels_dir / "de440s.bsp"))
    yield kernel
    kernel.close()


@pytest.fixture(scope="session")
def mpc_state(mpc_cache: CachePaths, de440s_kernel: SpiceKernel) -> MinorBodyState:
    ts = load.timescale()
    ts.julian_calendar_cutoff = None
    return load_minor_body_state(mpc_cache, ts, de440s_kernel["sun"])
