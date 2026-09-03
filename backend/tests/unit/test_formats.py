"""SKYS v1 byte layout (brief l.132-139, D48): header, offsets, sentinel, round trip, errors."""

import struct

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from hypothesis.extra import numpy as npst

from skyapi.catalogs.formats import (
    BV_UNKNOWN,
    HEADER_SIZE,
    SKYS_MAGIC,
    SKYS_VERSION,
    SkysFormatError,
    StarTable,
    bytes_for,
    read_skys,
    write_skys,
)

pytestmark = pytest.mark.unit

J2000 = 2451545.0


def make_table(n: int, *, epoch_tt: float = J2000, sort: bool = True) -> StarTable:
    rng = np.random.default_rng(n)
    direction = rng.normal(size=(n, 3))
    direction /= np.linalg.norm(direction, axis=1, keepdims=True)
    mag = rng.integers(-1500, 14000, size=n).astype(np.int16)
    if sort:
        mag.sort()
    return StarTable(
        dir=direction.astype(np.float32),
        pm=(rng.normal(size=(n, 3)) * 1e-6).astype(np.float32),
        mag=mag,
        bv=rng.integers(-500, 3000, size=n).astype(np.int16),
        hip=np.arange(1, n + 1, dtype=np.uint32),
        epoch_tt=epoch_tt,
    )


def test_header_bytes_and_size() -> None:
    table = make_table(3)
    data = write_skys(table)
    assert data[:4] == SKYS_MAGIC == b"SKYS"
    assert struct.unpack_from("<I", data, 4) == (SKYS_VERSION,) == (1,)
    assert struct.unpack_from("<I", data, 8) == (3,)
    assert struct.unpack_from("<d", data, 12) == (J2000,)
    assert struct.unpack_from("<I", data, 20) == (0,)
    assert HEADER_SIZE == 24
    assert len(data) == bytes_for(3) == 24 + 3 * 32


def test_column_offsets_are_packed_without_padding() -> None:
    table = make_table(5)
    data = write_skys(table)
    n = 5
    off = HEADER_SIZE
    dir_bytes = data[off : off + 12 * n]
    off += 12 * n
    pm_bytes = data[off : off + 12 * n]
    off += 12 * n
    mag_bytes = data[off : off + 2 * n]
    off += 2 * n
    bv_bytes = data[off : off + 2 * n]
    off += 2 * n
    hip_bytes = data[off : off + 4 * n]
    assert off + 4 * n == len(data)
    assert np.frombuffer(dir_bytes, "<f4").reshape(n, 3).tolist() == table.dir.tolist()
    assert np.frombuffer(pm_bytes, "<f4").reshape(n, 3).tolist() == table.pm.tolist()
    assert np.frombuffer(mag_bytes, "<i2").tolist() == table.mag.tolist()
    assert np.frombuffer(bv_bytes, "<i2").tolist() == table.bv.tolist()
    assert np.frombuffer(hip_bytes, "<u4").tolist() == table.hip.tolist()


def test_bv_sentinel_round_trips() -> None:
    assert BV_UNKNOWN == 32767
    table = make_table(2)
    bv = table.bv.copy()
    bv[1] = BV_UNKNOWN
    table = StarTable(table.dir, table.pm, table.mag, bv, table.hip, table.epoch_tt)
    back = read_skys(write_skys(table))
    assert back.bv.tolist() == [int(bv[0]), 32767]
    assert back.bv.dtype == np.int16


def test_empty_table_round_trips() -> None:
    table = make_table(0)
    data = write_skys(table)
    assert len(data) == HEADER_SIZE
    back = read_skys(data)
    assert back.count == 0
    assert back.dir.shape == (0, 3)


def test_unsorted_magnitudes_rejected() -> None:
    table = make_table(4, sort=False)
    assert np.any(np.diff(table.mag) < 0)
    with pytest.raises(ValueError, match="sorted by magnitude"):
        write_skys(table)


def test_table_validation() -> None:
    table = make_table(2)
    with pytest.raises(ValueError, match="dir must have shape"):
        StarTable(table.dir[:1], table.pm, table.mag, table.bv, table.hip, J2000)
    with pytest.raises(ValueError, match="pm must have dtype float32"):
        StarTable(
            table.dir,
            table.pm.astype(np.float64),  # pyright: ignore[reportArgumentType]
            table.mag,
            table.bv,
            table.hip,
            J2000,
        )
    with pytest.raises(ValueError, match="hip must have shape"):
        StarTable(table.dir, table.pm, table.mag, table.bv, table.hip.reshape(1, 2), J2000)
    with pytest.raises(ValueError, match="epoch_tt must be finite"):
        StarTable(table.dir, table.pm, table.mag, table.bv, table.hip, float("nan"))


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda d: d[:10], "header needs 24 bytes"),
        (lambda d: b"NOPE" + d[4:], "bad SKYS magic"),
        (lambda d: d[:4] + struct.pack("<I", 2) + d[8:], "unsupported SKYS version 2"),
        (lambda d: d[:20] + struct.pack("<I", 1) + d[24:], "unknown SKYS flags"),
        (lambda d: d[:-1], "needs"),
        (lambda d: d + b"\0", "needs"),
        (lambda d: d[:8] + struct.pack("<I", 99) + d[12:], "with 99 stars needs"),
    ],
)
def test_truncated_or_garbage_input(mutate, message) -> None:
    data = write_skys(make_table(3))
    with pytest.raises(SkysFormatError, match=message):
        read_skys(mutate(data))
    assert issubclass(SkysFormatError, ValueError)


finite32 = st.floats(width=32, allow_nan=False, allow_infinity=False)


@st.composite
def star_tables(draw: st.DrawFn) -> StarTable:
    n = draw(st.integers(min_value=0, max_value=40))
    direction = draw(npst.arrays(np.float32, (n, 3), elements=finite32))
    pm = draw(npst.arrays(np.float32, (n, 3), elements=finite32))
    mag = draw(npst.arrays(np.int16, (n,), elements=st.integers(-32768, 32767)))
    bv = draw(npst.arrays(np.int16, (n,), elements=st.integers(-32768, 32767)))
    hip = draw(npst.arrays(np.uint32, (n,), elements=st.integers(0, 2**32 - 1)))
    epoch = draw(st.floats(min_value=0.0, max_value=5e6, allow_nan=False, allow_infinity=False))
    return StarTable(direction, pm, np.sort(mag), bv, hip, epoch)


@settings(max_examples=200, deadline=None)
@given(star_tables())
def test_round_trip(table: StarTable) -> None:
    data = write_skys(table)
    assert len(data) == bytes_for(table.count)
    back = read_skys(data)
    assert np.array_equal(back.dir, table.dir)
    assert np.array_equal(back.pm, table.pm)
    assert np.array_equal(back.mag, table.mag)
    assert np.array_equal(back.bv, table.bv)
    assert np.array_equal(back.hip, table.hip)
    assert back.epoch_tt == table.epoch_tt
    assert (back.dir.dtype, back.pm.dtype, back.mag.dtype, back.bv.dtype, back.hip.dtype) == (
        np.float32,
        np.float32,
        np.int16,
        np.int16,
        np.uint32,
    )
    assert write_skys(back) == data
