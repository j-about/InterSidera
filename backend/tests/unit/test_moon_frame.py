"""D35 regression: the Moon frame works before 2426 (Skyfield #952) and dispatches by segment."""

import inspect
import warnings
from typing import cast

import numpy as np
import pytest
from skyfield.planetarylib import Frame, PlanetaryConstants
from skyfield.timelib import Timescale

from skyapi.astro.frames import CoverageError, SegmentedFrame
from skyapi.astro.horizon import horizon_quaternions
from skyapi.astro.observers import Observer
from skyapi.astro.state import AstroState

pytestmark = pytest.mark.unit

SEGMENT_BOUNDARY_TDB = 2607184.5  # 2426-01-01 in moon_pa_de440_200625.bpc


def test_moon_observer_works_before_2426(
    astro_state: AstroState, tranquility: Observer, ts: Timescale
) -> None:
    t = ts.utc(2019, 12, 20)
    q = horizon_quaternions(tranquility, t)
    assert q.shape == (1, 4)
    apparent = tranquility.vector.at(t).observe(astro_state.eph["earth"]).apparent()
    alt, _, _ = apparent.altaz()
    assert np.isfinite(float(np.asarray(alt.degrees)))


def test_segmented_frame_covers_both_bpc_segments(astro_state: AstroState) -> None:
    frame = astro_state.moon_frame
    assert frame is not None
    assert frame.segment_count == 2
    assert frame.center == 301
    assert frame.name == "MOON_ME_DE440_ME421"
    start, end = frame.tdb_bounds
    assert start == 2287184.5  # 1550-01-01
    assert end == 2688976.5  # 2650-01-01
    index = frame.segment_index(
        np.array([2458837.5, SEGMENT_BOUNDARY_TDB - 1e-6, SEGMENT_BOUNDARY_TDB, 2650000.0])
    )
    assert index.tolist() == [0, 0, 1, 1]
    with pytest.raises(CoverageError) as excinfo:
        frame.segment_index(np.array([end + 1.0]))
    assert excinfo.value.range_tt == frame.range_tt
    with pytest.raises(CoverageError):
        frame.rotation_at(astro_state.ts.tdb_jd(start - 1.0))


def test_segmented_frame_agrees_with_skyfield_on_the_last_segment(
    astro_state: AstroState, ts: Timescale
) -> None:
    # Skyfield's own frame keeps only the last-read segment (2426-2650, issue #952): it agrees
    # with ours there and fails before 2426, where ours keeps working.
    frame = astro_state.moon_frame
    assert frame is not None
    with warnings.catch_warnings():
        # Skyfield 1.55 `build_frame` sets `matrix.shape` (deprecated by NumPy 2.5); the loader
        # silences the same message for its own call.
        warnings.filterwarnings(
            "ignore", message=r"Setting the shape on a NumPy array", category=DeprecationWarning
        )
        skyfield_frame = astro_state.pc.build_frame_named("MOON_ME_DE440_ME421")
    late = ts.tdb_jd(np.array([2610000.5, 2650000.5]))
    assert np.allclose(frame.rotation_at(late), skyfield_frame.rotation_at(late), atol=1e-15)
    early = ts.tdb_jd(2458837.5)
    assert frame.rotation_at(early).shape == (3, 3)
    with pytest.raises(ValueError, match="segment only covers"):
        skyfield_frame.rotation_at(early)


def test_segmented_frame_dispatches_a_straddling_window(
    astro_state: AstroState, ts: Timescale
) -> None:
    frame = astro_state.moon_frame
    assert frame is not None
    t = ts.tdb_jd(SEGMENT_BOUNDARY_TDB + np.array([-2.0, -1.0, 1.0, 2.0]))
    rotation, rate = frame.rotation_and_rate_at(t)
    assert rotation.shape == rate.shape == (3, 3, 4)
    assert np.allclose(np.linalg.det(np.moveaxis(rotation, -1, 0)), 1.0, atol=1e-12)
    for i in range(4):
        single, single_rate = frame.rotation_and_rate_at(t[i])
        assert np.allclose(rotation[:, :, i], single)
        assert np.allclose(rate[:, :, i], single_rate)
    # The two segments meet smoothly: orientation is continuous across the boundary.
    around = frame.rotation_at(ts.tdb_jd(SEGMENT_BOUNDARY_TDB + np.array([-1e-6, 1e-6])))
    assert np.allclose(around[:, :, 0], around[:, :, 1], atol=1e-8)


def test_skyfield_private_names_the_workaround_relies_on_still_exist() -> None:
    assert "_segment_list" in vars(PlanetaryConstants()), (
        "Skyfield renamed PlanetaryConstants._segment_list: update build_moon_frame (D35)"
    )
    assert "_segment" in inspect.signature(PlanetaryConstants.build_frame).parameters, (
        "Skyfield changed build_frame(_segment=): update build_moon_frame (D35)"
    )


class _FakeFrame:
    """Stands in for a Skyfield `Frame`: a constant matrix tagged with the segment number."""

    center = 301

    def __init__(self, tag: float) -> None:
        self.tag = tag

    def rotation_at(self, t: object) -> np.ndarray:
        n = np.asarray(getattr(t, "tdb")).shape  # noqa: B009
        return (
            np.broadcast_to(np.eye(3)[:, :, np.newaxis] * self.tag, (3, 3, *n)).copy()
            if n
            else np.eye(3) * self.tag
        )

    def rotation_and_rate_at(self, t: object) -> tuple[np.ndarray, np.ndarray]:
        rotation = self.rotation_at(t)
        return rotation, rotation * 10.0


class _FakeTime:
    def __init__(self, tdb: np.ndarray | float) -> None:
        self.tdb = tdb

    def __getitem__(self, index: np.ndarray) -> _FakeTime:
        return _FakeTime(np.asarray(self.tdb)[index])


def _fake_frame() -> SegmentedFrame:
    frames = cast(list[Frame], [_FakeFrame(1.0), _FakeFrame(2.0), _FakeFrame(3.0)])
    return SegmentedFrame("FAKE", 301, frames, [0.0, 10.0, 20.0], [10.0, 20.0, 30.0], (0.5, 29.5))


def test_segmented_frame_synthetic_dispatch() -> None:
    frame = _fake_frame()
    assert frame.segment_count == 3
    rotation = frame.rotation_at(_FakeTime(np.array([25.0, 5.0, 10.0, 15.0, 30.0])))  # type: ignore[arg-type]
    assert rotation[0, 0].tolist() == [
        3.0,
        1.0,
        2.0,
        2.0,
        3.0,
    ]  # boundaries go to the later segment
    _, rate = frame.rotation_and_rate_at(_FakeTime(np.array([5.0, 25.0])))  # type: ignore[arg-type]
    assert rate[0, 0].tolist() == [10.0, 30.0]
    assert frame.rotation_at(_FakeTime(15.0))[0, 0] == 2.0  # type: ignore[arg-type]
    with pytest.raises(CoverageError) as excinfo:
        frame.rotation_at(_FakeTime(np.array([5.0, 31.0])))  # type: ignore[arg-type]
    assert excinfo.value.range_tt == (0.5, 29.5)
    with pytest.raises(CoverageError):
        frame.rotation_and_rate_at(_FakeTime(-1.0))  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("initial", "final", "match"),
    [
        ([0.0, 10.0], [10.0], "equal in size"),
        ([0.0, 10.0], [10.0, 10.0], "end after it starts"),
        ([10.0, 0.0], [20.0, 10.0], "sorted"),
        ([0.0, 5.0], [10.0, 20.0], "non-overlapping"),
    ],
)
def test_segmented_frame_validates_its_segments(
    initial: list[float], final: list[float], match: str
) -> None:
    frames = cast(list[Frame], [_FakeFrame(1.0) for _ in initial])
    with pytest.raises(ValueError, match=match):
        SegmentedFrame("FAKE", 301, frames, initial, final, (0.0, 1.0))
    with pytest.raises(ValueError, match="non-empty"):
        SegmentedFrame("FAKE", 301, [], [], [], (0.0, 1.0))
