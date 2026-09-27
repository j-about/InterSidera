"""loader.py: kernel paths, coverage computation, the D35 Moon frame and typed errors."""

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pytest
from hypothesis import given
from hypothesis import strategies as st
from skyfield.timelib import Timescale

from skyapi.astro.frames import CoverageError
from skyapi.astro.horizon import horizon_quaternions
from skyapi.astro.loader import (
    COVERAGE_GRID_DECIMALS,
    COVERAGE_MARGIN_DAYS,
    MOON_BPC_FILENAME,
    MOON_TF_FILENAME,
    PCK_TEXT_FILENAME,
    KernelPaths,
    MissingDataError,
    bpc_coverage,
    ceil_to_grid,
    ephemeris_coverage,
    floor_to_grid,
    kernel_paths,
    load_astro_state,
)
from skyapi.astro.observers import Observer, ObserverUnavailableError, build_observer
from skyapi.astro.state import AstroState

pytestmark = pytest.mark.unit

DE440S_START_TDB = 2396752.5
DE440S_END_TDB = 2506352.5


def test_kernel_paths_uses_the_canonical_filenames(kernels_dir: Path, tmp_path: Path) -> None:
    paths = kernel_paths(kernels_dir, "de440s.bsp")
    assert paths.ephemeris == kernels_dir / "de440s.bsp"
    assert paths.pck_text == kernels_dir / PCK_TEXT_FILENAME
    assert paths.moon_tf == kernels_dir / MOON_TF_FILENAME
    assert paths.moon_bpc == kernels_dir / MOON_BPC_FILENAME
    bare = kernel_paths(tmp_path, "de440.bsp")
    assert bare.ephemeris == tmp_path / "de440.bsp"
    assert bare.moon_tf is None
    assert bare.moon_bpc is None
    (tmp_path / MOON_TF_FILENAME).write_bytes(b"KPL/FK")
    only_tf = kernel_paths(tmp_path, "de440.bsp")
    assert only_tf.moon_tf is None  # both or neither
    assert only_tf.moon_bpc is None


def test_missing_files_raise_missing_data_error(kernels_dir: Path, tmp_path: Path) -> None:
    good = kernel_paths(kernels_dir, "de440s.bsp")
    with pytest.raises(MissingDataError, match="missing"):
        load_astro_state(KernelPaths(tmp_path / "nope.bsp", good.pck_text, None, None))
    with pytest.raises(MissingDataError, match="both"):
        load_astro_state(KernelPaths(good.ephemeris, good.pck_text, good.moon_tf, None))
    with pytest.raises(MissingDataError, match="missing"):
        load_astro_state(
            KernelPaths(good.ephemeris, good.pck_text, good.moon_tf, tmp_path / "absent.bpc")
        )


def test_ephemeris_coverage_is_the_de440s_span_minus_the_margin(
    astro_state: AstroState, ts: Timescale
) -> None:
    start, end = astro_state.ephemeris_coverage_tt
    assert astro_state.ephemeris_name == "de440s.bsp"
    assert np.isclose(ts.tt_jd(start).tdb, DE440S_START_TDB + COVERAGE_MARGIN_DAYS, atol=1e-6)
    assert np.isclose(ts.tt_jd(end).tdb, DE440S_END_TDB - COVERAGE_MARGIN_DAYS, atol=1e-6)
    assert ephemeris_coverage(astro_state.eph, ts) == astro_state.ephemeris_coverage_tt
    # de440s carries no Mars-centre segment (4 -> 499): the served Mars key is the barycenter.
    with pytest.raises(MissingDataError, match="'mars'"):
        ephemeris_coverage(astro_state.eph, ts, ["mars"])
    with pytest.raises(MissingDataError, match=r"unknown|does not serve"):
        ephemeris_coverage(astro_state.eph, ts, ["vulcan"])


def test_coverage_error_just_outside_the_de440s_limits(greenwich: Observer, ts: Timescale) -> None:
    start, end = greenwich.coverage_tt
    horizon_quaternions(greenwich, ts.tt_jd(np.array([start, end])))  # the bounds are inclusive
    for outside in (start - 1e-3, end + 1e-3):
        with pytest.raises(CoverageError) as excinfo:
            horizon_quaternions(greenwich, ts.tt_jd(outside))
        assert excinfo.value.range_tt == (start, end)
    with pytest.raises(CoverageError):
        horizon_quaternions(greenwich, ts.tt_jd(np.array([start, end, end + 1e-3])))


def _on_grid(value: float) -> bool:
    return round(value, COVERAGE_GRID_DECIMALS) == value


def test_advertised_bounds_lie_on_the_api_grid(
    astro_state: AstroState, greenwich: Observer, ts: Timescale
) -> None:
    """B-52 (plan D161): the API rounds `tt` to 1e-8 day, so a bound off that grid was refused
    about half of the time; both coverages now end on the grid and the neighbouring grid step
    inward is served while the step outward is not. (The inward move itself is the grid helpers'
    property, tested below and on raw segment bounds in the bpc test.)"""
    assert astro_state.moon_coverage_tt is not None
    for start, end in (astro_state.ephemeris_coverage_tt, astro_state.moon_coverage_tt):
        assert _on_grid(start)
        assert _on_grid(end)
    start, end = greenwich.coverage_tt
    assert (start, end) == astro_state.ephemeris_coverage_tt
    # What the API canonicalizes a request at the bound and one grid step inside to: both served.
    inside = ts.tt_jd(
        np.array([round(start, 8), round(start + 1e-8, 8), round(end - 1e-8, 8), round(end, 8)])
    )
    horizon_quaternions(greenwich, inside)
    # One grid step outward is refused on both sides.
    for outside in (round(start - 1e-8, 8), round(end + 1e-8, 8)):
        assert outside not in (start, end)
        with pytest.raises(CoverageError):
            horizon_quaternions(greenwich, ts.tt_jd(outside))


def test_grid_helpers_on_known_values() -> None:
    """Both branches of each helper: the nearest grid point when it lies inward, the next one when
    it lies outward, and a value already on the grid left alone."""
    assert ceil_to_grid(2396753.500000004) == 2396753.50000001  # nearest is outward: next step
    assert ceil_to_grid(2396753.500000006) == 2396753.50000001  # nearest is inward
    assert floor_to_grid(2506351.499999996) == 2506351.49999999  # nearest is outward: next step
    assert floor_to_grid(2506351.499999994) == 2506351.49999999  # nearest is inward
    assert ceil_to_grid(2396753.50000001) == 2396753.50000001
    assert floor_to_grid(2506351.49999999) == 2506351.49999999


@given(st.floats(min_value=2_200_000.0, max_value=2_700_000.0))
def test_grid_helpers_move_inward_by_less_than_one_step_onto_the_grid(value: float) -> None:
    """B-52: the helpers answer on the API's `tt` grid, never outward and by less than one grid
    step, and a value already on the grid (the API's canonical form) is returned unchanged."""
    step = 10.0**-COVERAGE_GRID_DECIMALS
    up, down = ceil_to_grid(value), floor_to_grid(value)
    assert _on_grid(up)
    assert _on_grid(down)
    assert 0.0 <= up - value < step
    assert 0.0 <= value - down < step
    on_grid = round(value, COVERAGE_GRID_DECIMALS)
    assert ceil_to_grid(on_grid) == on_grid
    assert floor_to_grid(on_grid) == on_grid


def test_moon_coverage_is_the_bpc_span_minus_the_margin(
    astro_state: AstroState, ts: Timescale
) -> None:
    assert astro_state.moon_coverage_tt is not None
    start, end = astro_state.moon_coverage_tt
    assert np.isclose(ts.tt_jd(start).tdb, 2287184.5 + COVERAGE_MARGIN_DAYS, atol=1e-6)
    assert np.isclose(ts.tt_jd(end).tdb, 2688976.5 - COVERAGE_MARGIN_DAYS, atol=1e-6)
    assert astro_state.moon_frame is not None
    assert astro_state.moon_frame.range_tt == astro_state.moon_coverage_tt


def test_timescale_is_builtin_and_proleptic(astro_state: AstroState) -> None:
    assert astro_state.ts.julian_calendar_cutoff is None
    assert astro_state.ts.delta_t_table[0].shape[0] > 10_000


@dataclass(frozen=True)
class _FakeSegment:
    initial_jd: float
    final_jd: float


def test_bpc_coverage_merges_contiguous_segments(ts: Timescale) -> None:
    segments = [_FakeSegment(2600000.5, 2610000.5), _FakeSegment(2590000.5, 2600000.5)]
    start, end = bpc_coverage(segments, ts)  # type: ignore[arg-type]
    assert np.isclose(ts.tt_jd(start).tdb, 2590000.5 + 1.0, atol=1e-6)
    assert np.isclose(ts.tt_jd(end).tdb, 2610000.5 - 1.0, atol=1e-6)
    assert _on_grid(start)  # B-52: bounds on the 1e-8 day grid
    assert _on_grid(end)
    # The grid step is inward: the raw TT bounds (margin applied, unrounded) enclose the result.
    raw_start = float(ts.tdb_jd(2590000.5).tt) + 1.0
    raw_end = float(ts.tdb_jd(2610000.5).tt) - 1.0
    assert raw_start <= start < raw_start + 1e-8
    assert raw_end - 1e-8 < end <= raw_end
    with pytest.raises(MissingDataError, match="non-contiguous"):
        bpc_coverage([_FakeSegment(0.0, 10.0), _FakeSegment(11.0, 20.0)], ts)  # type: ignore[arg-type]
    with pytest.raises(MissingDataError, match="no binary PCK"):
        bpc_coverage([], ts)


def test_state_without_the_moon_kernels(kernels_dir: Path) -> None:
    paths = kernel_paths(kernels_dir, "de440s.bsp")
    state = load_astro_state(KernelPaths(paths.ephemeris, paths.pck_text, None, None))
    try:
        assert state.moon_frame is None
        assert state.moon_coverage_tt is None
        assert state.bpc_files == ()
        assert "moon" in state.observers  # the spec exists, the frame does not
        build_observer(state, "earth", 51.48, 0.0)
        build_observer(state, "mars", 18.38, 77.58)
        with pytest.raises(ObserverUnavailableError):
            build_observer(state, "moon", 0.674, 23.473)
    finally:
        state.close()


def test_close_releases_the_kernel_files(kernels_dir: Path) -> None:
    state = load_astro_state(kernel_paths(kernels_dir, "de440s.bsp"))
    assert len(state.bpc_files) == 1
    assert not state.bpc_files[0].closed
    state.close()
    assert state.bpc_files[0].closed
    assert state.eph.segments == []  # SpiceKernel.close() empties its segment list
