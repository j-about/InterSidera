"""SKYS v1, the binary star catalog served by `GET /catalogs/stars` (brief l.132-139, D48).

Pure module: NumPy only, no I/O, no Skyfield, 100 % line coverage. The TypeScript parser in
`frontend/src/sky/math` mirrors this byte layout exactly.

Layout (little-endian, packed without padding):

    magic    4 bytes  "SKYS"
    version  u32      1
    count    u32      number of stars n
    epoch_tt f64      TT Julian Date of `dir` (2451545.0 = J2000)
    flags    u32      reserved, 0
    dir      f32[3n]  ICRF unit vectors at the epoch
    pm       f32[3n]  tangential proper-motion velocity, radians per Julian year
    mag      i16[n]   Johnson V in millimagnitudes
    bv       i16[n]   B-V in millimagnitudes, 32767 when unknown
    hip      u32[n]   Hipparcos identifier

Rows are sorted by `mag` ascending so any prefix is a valid brighter-than subset.
"""

import struct
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

SKYS_MAGIC = b"SKYS"
SKYS_VERSION = 1
HEADER_SIZE = 24
BV_UNKNOWN = 32767
"""Sentinel for an unknown B-V colour index (brief l.137)."""

_HEADER = struct.Struct("<4sIIdI")
_BYTES_PER_STAR = 12 + 12 + 2 + 2 + 4


class SkysFormatError(ValueError):
    """The bytes are not a well-formed SKYS v1 file."""


def bytes_for(count: int) -> int:
    """Total file size for `count` stars."""
    return HEADER_SIZE + _BYTES_PER_STAR * count


@dataclass(frozen=True, slots=True)
class StarTable:
    """In-memory SKYS columns carrying the on-disk dtypes (D48)."""

    dir: NDArray[np.float32]
    pm: NDArray[np.float32]
    mag: NDArray[np.int16]
    bv: NDArray[np.int16]
    hip: NDArray[np.uint32]
    epoch_tt: float

    def __post_init__(self) -> None:
        if self.hip.ndim != 1:
            raise ValueError(f"hip must have shape (n,), got {self.hip.shape}")
        n = self.hip.shape[0]
        expected: tuple[tuple[str, tuple[int, ...], type], ...] = (
            ("dir", (n, 3), np.float32),
            ("pm", (n, 3), np.float32),
            ("mag", (n,), np.int16),
            ("bv", (n,), np.int16),
            ("hip", (n,), np.uint32),
        )
        for name, shape, dtype in expected:
            arr: NDArray[np.generic] = getattr(self, name)
            if arr.shape != shape:
                raise ValueError(f"{name} must have shape {shape}, got {arr.shape}")
            if arr.dtype != dtype:
                raise ValueError(f"{name} must have dtype {dtype.__name__}, got {arr.dtype}")
        if not np.isfinite(self.epoch_tt):
            raise ValueError(f"epoch_tt must be finite, got {self.epoch_tt}")

    @property
    def count(self) -> int:
        return int(self.hip.shape[0])


def write_skys(table: StarTable) -> bytes:
    """Serialise a `StarTable`; raises `ValueError` unless it is sorted by `mag` ascending."""
    if table.count > 1 and bool(np.any(np.diff(table.mag.astype(np.int32)) < 0)):
        raise ValueError("SKYS rows must be sorted by magnitude ascending")
    header = _HEADER.pack(SKYS_MAGIC, SKYS_VERSION, table.count, table.epoch_tt, 0)
    columns = (
        table.dir.astype("<f4", copy=False).tobytes(),
        table.pm.astype("<f4", copy=False).tobytes(),
        table.mag.astype("<i2", copy=False).tobytes(),
        table.bv.astype("<i2", copy=False).tobytes(),
        table.hip.astype("<u4", copy=False).tobytes(),
    )
    return header + b"".join(columns)


def read_skys(data: bytes) -> StarTable:
    """Parse SKYS v1 bytes; raises `SkysFormatError` on magic, version or length mismatch."""
    if len(data) < HEADER_SIZE:
        raise SkysFormatError(f"SKYS header needs {HEADER_SIZE} bytes, got {len(data)}")
    magic, version, count, epoch_tt, flags = _HEADER.unpack_from(data)
    if magic != SKYS_MAGIC:
        raise SkysFormatError(f"bad SKYS magic {magic!r}")
    if version != SKYS_VERSION:
        raise SkysFormatError(f"unsupported SKYS version {version}")
    if flags != 0:
        raise SkysFormatError(f"unknown SKYS flags 0x{flags:08x}")
    if len(data) != bytes_for(count):
        raise SkysFormatError(
            f"SKYS with {count} stars needs {bytes_for(count)} bytes, got {len(data)}"
        )
    offset = HEADER_SIZE
    columns: list[NDArray[np.generic]] = []
    for dtype, width in (("<f4", 3), ("<f4", 3), ("<i2", 1), ("<i2", 1), ("<u4", 1)):
        arr = np.frombuffer(data, dtype=dtype, count=count * width, offset=offset)
        offset += arr.nbytes
        columns.append(arr.reshape(count, width) if width == 3 else arr)
    return StarTable(
        dir=np.asarray(columns[0], dtype=np.float32),
        pm=np.asarray(columns[1], dtype=np.float32),
        mag=np.asarray(columns[2], dtype=np.int16),
        bv=np.asarray(columns[3], dtype=np.int16),
        hip=np.asarray(columns[4], dtype=np.uint32),
        epoch_tt=float(epoch_tt),
    )
