"""Opens every Skyfield object the API needs and builds the frozen `AstroState` (brief l.76).

Files are opened directly (`SpiceKernel(path)`, `open(path, "rb")`), never through Skyfield's
`Loader.__call__`, which downloads a missing file silently (iokit.py l.203-215). The timescale is
the builtin one (bundled `iers.npz`/`delta_t.npz`, no disk, no network) with the proleptic
Gregorian calendar set explicitly (brief l.526).
"""

import warnings
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import BinaryIO

from jplephem.pck import Segment as PckSegment
from skyfield.api import load
from skyfield.constellationlib import load_constellation_map
from skyfield.jpllib import SpiceKernel
from skyfield.planetarylib import PlanetaryConstants
from skyfield.timelib import Timescale

from skyapi.astro.bodies import EPHEMERIS_KEYS, build_body_specs
from skyapi.astro.frames import (
    IAU_FRAME_CENTERS,
    CoverageError,
    IauRotationFrame,
    SegmentedFrame,
    read_rotation_model,
)
from skyapi.astro.observers import (
    IAU_OBSERVER_IDS,
    MOON_FRAME_NAME,
    OBSERVER_TABLE,
    build_observer_specs,
)
from skyapi.astro.state import AstroState

__all__ = [
    "COVERAGE_MARGIN_DAYS",
    "MOON_BPC_FILENAME",
    "MOON_TF_FILENAME",
    "PCK_TEXT_FILENAME",
    "CoverageError",
    "KernelPaths",
    "MissingDataError",
    "bpc_coverage",
    "build_moon_frame",
    "ephemeris_coverage",
    "kernel_paths",
    "load_astro_state",
]

PCK_TEXT_FILENAME = "pck00011.tpc"
MOON_TF_FILENAME = "moon_de440_250416.tf"
MOON_BPC_FILENAME = "moon_pa_de440_200625.bpc"

# `observe()` evaluates a target at `t - light_time` (up to ~7 h for Pluto) and DE441 `Stack`s
# return NaN silently outside their segments (jpllib.py l.267-283), so every coverage is shrunk
# by one day at both ends and checked explicitly before any ephemeris call.
COVERAGE_MARGIN_DAYS = 1.0

# Two adjacent segments may differ by float rounding of the same boundary second.
_ADJACENCY_TOLERANCE_DAYS = 1e-6


class MissingDataError(RuntimeError):
    """A required data file is absent or a kernel lacks a body the API serves."""


@dataclass(frozen=True, slots=True)
class KernelPaths:
    """Paths of the kernel set; the two Moon paths are `None` when those files are absent."""

    ephemeris: Path
    pck_text: Path
    moon_tf: Path | None
    moon_bpc: Path | None


def kernel_paths(data_dir: Path, ephemeris_name: str) -> KernelPaths:
    """Canonical kernel locations under `data_dir`; Moon paths only when both files exist."""
    moon_tf = data_dir / MOON_TF_FILENAME
    moon_bpc = data_dir / MOON_BPC_FILENAME
    both = moon_tf.is_file() and moon_bpc.is_file()
    return KernelPaths(
        ephemeris=data_dir / ephemeris_name,
        pck_text=data_dir / PCK_TEXT_FILENAME,
        moon_tf=moon_tf if both else None,
        moon_bpc=moon_bpc if both else None,
    )


def _tdb_to_tt(ts: Timescale, tdb_jd: float) -> float:
    return float(ts.tdb_jd(tdb_jd).tt)


def _merge_contiguous(name: str, spans: list[tuple[float, float]]) -> tuple[float, float]:
    spans.sort()
    start, end = spans[0]
    for next_start, next_end in spans[1:]:
        if next_start > end + _ADJACENCY_TOLERANCE_DAYS:
            raise MissingDataError(f"{name}: non-contiguous segments ({end} to {next_start})")
        end = max(end, next_end)
    return start, end


def ephemeris_coverage(
    eph: SpiceKernel, ts: Timescale, ephemeris_keys: Iterable[str] = EPHEMERIS_KEYS
) -> tuple[float, float]:
    """TT range in which every served body can be observed, minus the light-time margin.

    Per `(center, target)` pair the contiguous segments are merged (DE441 splits each body in
    two); each served body's chain to the Solar System Barycenter is intersected, then all
    bodies together; TDB bounds become TT and shrink by `COVERAGE_MARGIN_DAYS` at both ends.
    """
    spans: defaultdict[tuple[int, int], list[tuple[float, float]]] = defaultdict(list)
    for segment in eph.segments:
        spk = segment.spk_segment
        spans[(segment.center, segment.target)].append((float(spk.start_jd), float(spk.end_jd)))
    by_target: dict[int, tuple[int, float, float]] = {}
    for (center, target), pair_spans in spans.items():
        start, end = _merge_contiguous(f"{eph.filename} {center}->{target}", pair_spans)
        by_target[target] = (center, start, end)
    start, end = -float("inf"), float("inf")
    for key in ephemeris_keys:
        try:
            code = eph.decode(key)
        except (KeyError, ValueError) as exc:
            raise MissingDataError(f"{eph.filename} does not serve {key!r}: {exc}") from exc
        while code != 0:
            if code not in by_target:
                raise MissingDataError(f"{eph.filename} cannot connect {key!r} to the barycenter")
            code, segment_start, segment_end = by_target[code]
            start, end = max(start, segment_start), min(end, segment_end)
    if not start < end:
        raise MissingDataError(f"{eph.filename} has no common coverage for the served bodies")
    return _tdb_to_tt(ts, start) + COVERAGE_MARGIN_DAYS, _tdb_to_tt(ts, end) - COVERAGE_MARGIN_DAYS


def bpc_coverage(segments: Sequence[PckSegment], ts: Timescale) -> tuple[float, float]:
    """TT range of contiguous binary-PCK segments for one body, minus the same margin."""
    if not segments:
        raise MissingDataError("no binary PCK segment to take coverage from")
    spans = [(float(s.initial_jd), float(s.final_jd)) for s in segments]
    start, end = _merge_contiguous("binary PCK", spans)
    return _tdb_to_tt(ts, start) + COVERAGE_MARGIN_DAYS, _tdb_to_tt(ts, end) - COVERAGE_MARGIN_DAYS


def _int_variable(pc: PlanetaryConstants, name: str) -> int:
    value = pc.variables.get(name)
    if not isinstance(value, int):
        raise MissingDataError(f"{name} is missing from the loaded text kernels")
    return value


def _str_variable(pc: PlanetaryConstants, name: str) -> str:
    value = pc.variables.get(name)
    if not isinstance(value, str):
        raise MissingDataError(f"{name} is missing from the loaded text kernels")
    return value


def build_moon_frame(
    pc: PlanetaryConstants, ts: Timescale
) -> tuple[SegmentedFrame, tuple[float, float]]:
    """`MOON_ME_DE440_ME421` as a `SegmentedFrame` over every `.bpc` segment (D35).

    Skyfield issues #952 and #960 (open on 2026-09-03): `read_binary` keeps every segment in
    `_segment_list` but `_segment_map[segment.body]` remembers only the last one, and
    `build_frame(integer, _segment=...)` accepts an explicit segment. This function is the only
    place that touches those two underscore names. `MOON_ME` (31001) is a two-level TK chain
    `build_frame` cannot resolve, so only `MOON_ME_DE440_ME421` is ever built.
    """
    integer = _int_variable(pc, f"FRAME_{MOON_FRAME_NAME}")
    relative = _str_variable(pc, f"TKFRAME_{integer}_RELATIVE")
    pa_integer = _int_variable(pc, f"FRAME_{relative}")
    # Skyfield #952 workaround: the full segment list is private (planetarylib.py l.29, l.82).
    all_segments = pc._segment_list  # pyright: ignore[reportPrivateUsage]
    segments = sorted(
        (segment for segment in all_segments if segment.body == pa_integer),
        key=lambda segment: float(segment.initial_jd),
    )
    if not segments:
        raise MissingDataError(
            f"no binary PCK segment for frame {relative} ({pa_integer}) is loaded"
        )
    coverage = bpc_coverage(segments, ts)
    with warnings.catch_warnings():
        # Skyfield 1.55 planetarylib.py l.113 does `matrix.shape = 3, 3`, which NumPy 2.5 deprecates
        # (a DeprecationWarning that `filterwarnings = error` would turn fatal); the frame itself is
        # unaffected. Narrow to that message and this one call.
        warnings.filterwarnings(
            "ignore",
            message=r"Setting the shape on a NumPy array has been deprecated",
            category=DeprecationWarning,
        )
        frames = [pc.build_frame(integer, _segment=segment) for segment in segments]
    frame = SegmentedFrame(
        MOON_FRAME_NAME,
        frames[0].center,
        frames,
        [float(s.initial_jd) for s in segments],
        [float(s.final_jd) for s in segments],
        coverage,
    )
    return frame, coverage


def load_astro_state(paths: KernelPaths) -> AstroState:
    """Open the kernels and build the immutable state; never downloads anything."""
    for path in (paths.ephemeris, paths.pck_text):
        if not path.is_file():
            raise MissingDataError(f"required kernel {path} is missing")
    if (paths.moon_tf is None) != (paths.moon_bpc is None):
        raise MissingDataError("the Moon frame needs both the .tf and the .bpc kernel")
    if paths.moon_tf is not None and paths.moon_bpc is not None:
        for moon_path in (paths.moon_tf, paths.moon_bpc):
            if not moon_path.is_file():
                raise MissingDataError(f"Moon kernel {moon_path} is missing")
    ts = load.timescale()
    ts.julian_calendar_cutoff = None  # proleptic Gregorian everywhere (brief l.526)
    eph = SpiceKernel(str(paths.ephemeris))
    bpc_files: list[BinaryIO] = []
    try:
        pc = PlanetaryConstants()
        with paths.pck_text.open("rb") as text_pck:
            pc.read_text(text_pck)
        moon_frame: SegmentedFrame | None = None
        moon_coverage: tuple[float, float] | None = None
        if paths.moon_tf is not None and paths.moon_bpc is not None:
            with paths.moon_tf.open("rb") as frame_kernel:
                pc.read_text(frame_kernel)
            # The DAF reader keeps reading from this handle (memory-mapped arrays) for as long
            # as the state lives; `AstroState.close()` releases it.
            bpc_file = paths.moon_bpc.open("rb")
            bpc_files.append(bpc_file)
            pc.read_binary(bpc_file)
            moon_frame, moon_coverage = build_moon_frame(pc, ts)
        iau_frames = {
            observer_id: IauRotationFrame(
                IAU_FRAME_CENTERS[observer_id],
                read_rotation_model(
                    pc.variables,
                    OBSERVER_TABLE[observer_id].radii_code,
                    IAU_FRAME_CENTERS[observer_id],
                ),
            )
            for observer_id in IAU_OBSERVER_IDS
        }
        return AstroState(
            ts=ts,
            eph=eph,
            ephemeris_name=paths.ephemeris.name,
            ephemeris_coverage_tt=ephemeris_coverage(eph, ts),
            pc=pc,
            moon_frame=moon_frame,
            moon_coverage_tt=moon_coverage,
            iau_frames=MappingProxyType(iau_frames),
            observers=build_observer_specs(pc.variables),
            bodies=build_body_specs(pc.variables),
            # Bundled `constellations.npz` (46 KB grid), no download (brief l.41 keeps this
            # server-side: the lookup precesses the position to B1875).
            constellation_at=load_constellation_map(),
            bpc_files=tuple(bpc_files),
        )
    except Exception:
        eph.close()
        for handle in bpc_files:
            handle.close()
        raise
