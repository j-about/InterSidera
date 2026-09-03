"""Kernel-level astronomical context built once by `loader.load_astro_state` (D11, brief l.397).

Catalogs and minor bodies live in their own states (scopes C and D); the root `SkyState`
composes them at M2. Every `astro/` function receives this object explicitly; nothing here is
mutable and nothing is module-level.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import BinaryIO

from skyfield.jpllib import SpiceKernel
from skyfield.planetarylib import PlanetaryConstants
from skyfield.timelib import Timescale

from skyapi.astro.bodies import BodySpec
from skyapi.astro.frames import IauRotationFrame, SegmentedFrame
from skyapi.astro.observers import ObserverSpec


@dataclass(frozen=True, slots=True)
class AstroState:
    """Timescale, ephemeris, planetary constants, frames and the observer and body tables.

    Coverage tuples are TT Julian Dates already shrunk by the light-time margin (loader). The
    Moon frame and its coverage are `None` when the two Moon kernels are absent, which makes the
    `moon` observer unavailable while everything else keeps working. `bpc_files` are the binary
    PCK handles the loader opened for `pc` (Skyfield offers no way to close them); `close()`
    releases every kernel file at lifespan shutdown or test teardown.
    """

    ts: Timescale
    eph: SpiceKernel
    ephemeris_name: str
    ephemeris_coverage_tt: tuple[float, float]
    pc: PlanetaryConstants
    moon_frame: SegmentedFrame | None
    moon_coverage_tt: tuple[float, float] | None
    iau_frames: Mapping[str, IauRotationFrame]
    observers: Mapping[str, ObserverSpec]
    bodies: Mapping[str, BodySpec]
    bpc_files: tuple[BinaryIO, ...] = ()

    def close(self) -> None:
        """Close the ephemeris and the binary PCK files; the state must not be used afterwards."""
        self.eph.close()
        for handle in self.bpc_files:
            handle.close()
