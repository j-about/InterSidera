"""MPC cache build (D43): `MPCORB.DAT` + `CometEls.txt` -> `mpc/{asteroids,comets,index}.parquet`.

`sky-data build-caches` (`data/caches.py`) calls `build_mpc` once; the API never parses the MPC
files again (brief l.316, l.530). Only `mpc/index.parquet` is loaded in RAM by
`astro/minor_bodies.py`; the two orbit tables are read one row at a time.

Rows are parsed with our own `pd.read_fwf(..., chunksize=)` call rather than
`skyfield.data.mpc.load_mpcorb_dataframe` (R30): the single-call loader peaks at 3.6 GB RSS on the
1.56 M-row file (measured 2026-09-03, above the 3 GB threshold of the plan) and its misspelled
`dtypes=` keyword lets pandas infer column types from the rows present, so an excerpt and the
full file would produce different Parquet schemas. The column table below is copied from the
MPC format document (<https://data.minorplanetcenter.net/iau/info/MPOrbitFormat.html>) with the
column names of `skyfield.data.mpc._MPCORB_COLUMNS`, so `mpc.mpcorb_orbit(row, ...)` keeps
reading the row attributes it expects.
"""

import hashlib
import io
import logging
import re
import resource
import string
import time
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any, Literal

import numpy as np
import pandas as pd
from skyfield.data import mpc
from skyfield.timelib import julian_day

from skyapi.catalogs.artifacts import Artifact, BuildResult, CachePaths, artifact_version

logger = logging.getLogger(__name__)

# One `read_fwf` chunk; the python-fwf engine needs about 1.1 MB of transient memory per 1 000
# rows, so 200 000 rows keep the parser under ~250 MB while the finished frame is ~370 MB.
MPCORB_CHUNK_ROWS = 200_000
PARQUET_ROW_GROUP_SIZE = 65_536
# The header of MPCORB.DAT ends with a line of dashes (160 today); a data row never does.
_MPCORB_SEPARATOR_MIN_DASHES = 100
# The prose header is ~5 KB; the separator has to be found within this many leading bytes.
_MPCORB_HEADER_SCAN_BYTES = 262_144

_MpcDtype = Literal["str", "float64", "Int64"]

# MPOrbitFormat.html column table: (name, 0-based half-open slice, dtype). Fortran columns are
# 1-based inclusive, so "9 - 13" becomes (8, 13). Names follow skyfield 1.55 data/mpc.py l.15-39.
MPCORB_COLUMNS: tuple[tuple[str, tuple[int, int], _MpcDtype], ...] = (
    ("designation_packed", (0, 7), "str"),  # 1-7 a7 number or provisional designation
    ("magnitude_H", (8, 13), "float64"),  # 9-13 f5.2 absolute magnitude H
    ("magnitude_G", (14, 19), "float64"),  # 15-19 f5.2 slope parameter G
    ("epoch_packed", (20, 25), "str"),  # 21-25 a5 epoch (packed, .0 TT)
    ("mean_anomaly_degrees", (26, 35), "float64"),  # 27-35 f9.5
    ("argument_of_perihelion_degrees", (37, 46), "float64"),  # 38-46 f9.5 J2000.0
    ("longitude_of_ascending_node_degrees", (48, 57), "float64"),  # 49-57 f9.5 J2000.0
    ("inclination_degrees", (59, 68), "float64"),  # 60-68 f9.5 J2000.0
    ("eccentricity", (70, 79), "float64"),  # 71-79 f9.7
    ("mean_daily_motion_degrees", (80, 91), "float64"),  # 81-91 f11.8
    ("semimajor_axis_au", (92, 103), "float64"),  # 93-103 f11.7
    ("uncertainty", (105, 106), "str"),  # 106 i1 U parameter, or a1 `E`, `D`, `F`
    ("reference", (107, 116), "str"),  # 108-116 a9
    ("observations", (117, 122), "Int64"),  # 118-122 i5
    ("oppositions", (123, 126), "Int64"),  # 124-126 i3
    ("observation_period", (127, 136), "str"),  # 128-136 first-last year or arc in days
    ("rms_residual_arcseconds", (137, 141), "float64"),  # 138-141 f4.2
    ("coarse_perturbers", (142, 145), "str"),  # 143-145 a3
    ("precise_perturbers", (146, 149), "str"),  # 147-149 a3
    ("computer_name", (150, 160), "str"),  # 151-160 a10
    ("hex_flags", (161, 165), "str"),  # 162-165 z4.4
    ("designation", (166, 194), "str"),  # 167-194 readable designation
    ("last_observation_date", (194, 202), "Int64"),  # 195-202 i8 YYYYMMDD
)

# Columns of `mpc/index.parquet`, in order (D42).
INDEX_COLUMNS: tuple[str, ...] = (
    "id",
    "designation",
    "name",
    "kind",
    "h_mag",
    "magnitude_g",
    "magnitude_k",
    "elements_epoch_tt",
    "perihelion_tt",
    "designation_packed",
)

# Readable designation of a numbered object: "(1) Ceres", "(100001) 1978 VD7".
_NUMBERED_RE = re.compile(r"^\((\d+)\)\s*(.*)$")
# Provisional ("2024 AB123", "A899 OF") and survey ("2040 P-L", "3138 T-1") designations are not
# names.
_PROVISIONAL_RE = re.compile(r"^(?:(?:\d{4}|[A-Z]\d{3}) [A-Z]{2}\d*|\d{4} (?:P-L|T-[123]))$")
# Trailing parenthesised comet name: "C/1995 O1 (Hale-Bopp)" -> "C/1995 O1".
_COMET_NAME_RE = re.compile(r"\s*\(([^()]*)\)\s*$")

_BASE62 = string.digits + string.ascii_uppercase + string.ascii_lowercase
_PACKED_NUMBER_RE = re.compile(r"^(?:\d{5}|[A-Za-z]\d{4}|~[0-9A-Za-z]{4})$")


class MpcFormatError(ValueError):
    """The MPC file does not have the documented layout."""


def unpack_number(designation_packed: str) -> int:
    """Number of a numbered minor planet from its packed form (MPOrbitFormat.html).

    `00001` -> 1; `A0001` -> 100001 (`A`..`Z` = 10..35, `a`..`z` = 36..61, times 10 000);
    `~0000` -> 620000 (`~` plus four base-62 digits added to 620 000).
    """
    if not _PACKED_NUMBER_RE.match(designation_packed):
        raise ValueError(f"not a packed minor-planet number: {designation_packed!r}")
    if designation_packed.startswith("~"):
        value = 0
        for char in designation_packed[1:]:
            value = value * 62 + _BASE62.index(char)
        return 620_000 + value
    head = designation_packed[0]
    if head.isdigit():
        return int(designation_packed)
    return _BASE62.index(head) * 10_000 + int(designation_packed[1:])


def pack_number(number: int) -> str:
    """Inverse of `unpack_number`: 1 -> `00001`, 100001 -> `A0001`, 620000 -> `~0000`."""
    if number < 1:
        raise ValueError(f"minor-planet numbers start at 1: {number}")
    if number < 100_000:
        return f"{number:05d}"
    if number < 620_000:
        head, tail = divmod(number, 10_000)
        return f"{_BASE62[head]}{tail:04d}"
    value = number - 620_000
    if value >= 62**4:
        raise ValueError(f"number too large for the MPC packed form: {number}")
    digits = ""
    for _ in range(4):
        value, digit = divmod(value, 62)
        digits = _BASE62[digit] + digits
    return "~" + digits


def unpack_epoch_tt(epoch_packed: str) -> float:
    """TT Julian Date at 0h of a packed MPC epoch (`K2669` -> 2026-06-09.0 TT).

    Same arithmetic as skyfield 1.55 data/mpc.py l.85-92 (`mpcorb_orbit`): century letter
    (`I`=18, `J`=19, `K`=20), two-digit year, base-31 month and day characters.
    """
    if len(epoch_packed) != 5:
        raise ValueError(f"packed epoch must have 5 characters: {epoch_packed!r}")

    def n(char: str) -> int:
        return ord(char) - (48 if char.isdigit() else 55)

    year = 100 * n(epoch_packed[0]) + int(epoch_packed[1:3])
    month = n(epoch_packed[3])
    day = n(epoch_packed[4])
    return float(julian_day(year, month, day)) - 0.5


def mpcorb_body_offset(head: bytes) -> int:
    """Byte offset of the first orbit row: after leading `#` lines and the dashed separator.

    Excerpts carry `#` provenance lines (D40) before the real MPC header; the MPC header ends
    with a line of at least `_MPCORB_SEPARATOR_MIN_DASHES` dashes (never a hard-coded line
    count). A file that starts directly with rows (Skyfield's own excerpt style) yields the
    offset of its first non-`#` line.
    """
    offset = 0
    while head.startswith(b"#", offset):
        newline = head.find(b"\n", offset)
        if newline < 0:
            return len(head)
        offset = newline + 1
    scan = offset
    while True:
        newline = head.find(b"\n", scan)
        line = head[scan:] if newline < 0 else head[scan:newline]
        stripped = line.rstrip(b"\r")
        if len(stripped) >= _MPCORB_SEPARATOR_MIN_DASHES and stripped.strip(b"-") == b"":
            return newline + 1 if newline >= 0 else len(head)
        if newline < 0:
            break
        scan = newline + 1
    return offset


def strip_comment_lines(data: bytes) -> bytes:
    """Drop every line starting with `#` (excerpt provenance, D40)."""
    return b"".join(line for line in data.splitlines(keepends=True) if not line.startswith(b"#"))


def one_solution_per_designation(comets: pd.DataFrame) -> pd.DataFrame:
    """Keep one orbit solution per comet designation (brief l.530).

    Skyfield's documentation sorts by `reference` and takes `groupby("designation").last()`;
    pandas `last()` returns the last non-NA value *per column*, which would splice the NaN
    `perturbed_epoch_*` or `number` of one solution with the elements of another.
    `drop_duplicates(keep="last")` keeps whole rows. The lexicographic `reference` sort is
    Skyfield's recipe, not a recency guarantee; ties keep file order (stable sort).
    """
    ordered = comets.sort_values("reference", kind="stable")
    return ordered.drop_duplicates(subset="designation", keep="last")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_mpcorb(mpcorb_dat: Path) -> pd.DataFrame:
    names = [name for name, _, _ in MPCORB_COLUMNS]
    colspecs = [span for _, span, _ in MPCORB_COLUMNS]
    dtype: dict[str, str] = {name: kind for name, _, kind in MPCORB_COLUMNS}
    with mpcorb_dat.open("rb") as binary:
        offset = mpcorb_body_offset(binary.read(_MPCORB_HEADER_SCAN_BYTES))
        binary.seek(offset)
        # MPC files are ASCII (the comet loader in Skyfield decodes them as such, too).
        text = io.TextIOWrapper(binary, encoding="ascii", newline="")
        # Blank section separators are skipped by read_fwf (skip_blank_lines defaults to True).
        chunks: list[pd.DataFrame] = list(
            pd.read_fwf(
                text,
                colspecs=colspecs,
                names=names,
                dtype=dtype,
                chunksize=MPCORB_CHUNK_ROWS,
            )
        )
        text.detach()
    if not chunks:
        return pd.DataFrame({name: pd.Series(dtype=kind) for name, _, kind in MPCORB_COLUMNS})
    return pd.concat(chunks, ignore_index=True)


def _asteroid_name(rest: str) -> str | None:
    text = rest.strip()
    if not text or _PROVISIONAL_RE.match(text):
        return None
    return text


def _asteroid_table(mpcorb_dat: Path) -> pd.DataFrame:
    frame = _read_mpcorb(mpcorb_dat)
    # Skyfield's documentation drops rows without a semimajor axis (kepler-orbits.rst l.204-206).
    frame = frame[frame["semimajor_axis_au"].notna()].reset_index(drop=True)
    if frame["designation_packed"].isna().any() or frame["designation"].isna().any():
        raise MpcFormatError("MPCORB row without a packed or readable designation")
    parts = frame["designation"].str.extract(_NUMBERED_RE)
    numbered = parts[0].notna()
    numbers = pd.to_numeric(parts.loc[numbered, 0]).astype("int64")
    packed_numbers = frame.loc[numbered, "designation_packed"].map(unpack_number).astype("int64")
    mismatch = numbers != packed_numbers
    if bool(mismatch.any()):
        first = frame.loc[numbered, "designation"][mismatch].iloc[0]
        raise MpcFormatError(f"packed number does not match the readable designation: {first!r}")
    ids = pd.Series("a:" + frame["designation_packed"], index=frame.index, dtype="str")
    ids.loc[numbered] = "a:" + numbers.astype("str")
    names = pd.Series(np.nan, index=frame.index, dtype="str")
    names.loc[numbered] = parts.loc[numbered, 1].map(_asteroid_name)
    epochs = {packed: unpack_epoch_tt(packed) for packed in frame["epoch_packed"].unique()}
    frame["id"] = ids
    frame["name"] = names
    frame["kind"] = pd.Series("asteroid", index=frame.index, dtype="str")
    frame["elements_epoch_tt"] = frame["epoch_packed"].map(epochs).astype("float64")
    if frame["id"].duplicated().any():
        raise MpcFormatError("duplicate asteroid id in MPCORB")
    # `designation_packed` is unique per object; sorting on it keeps the Parquet row-group
    # statistics tight for the `orbit_for` lookups (D43).
    return frame.sort_values("designation_packed", kind="stable").reset_index(drop=True)


def _comet_id_and_name(row: pd.Series[Any]) -> tuple[str, str | None]:
    designation = str(row["designation"]).strip()
    number = row["number"]
    if pd.notna(number):
        # Numbered periodic comet: "1P/Halley", fragments "73P-BT/Schwassmann-Wachmann".
        prefix, _, name = designation.partition("/")
        expected = f"{int(number)}{str(row['orbit_type']).strip()}"
        if not prefix.startswith(expected):
            raise MpcFormatError(
                f"comet designation {designation!r} does not start with {expected}"
            )
        return f"c:{prefix}", (name.strip() or None)
    match = _COMET_NAME_RE.search(designation)
    name = match.group(1).strip() if match else ""
    bare = designation[: match.start()] if match else designation
    return "c:" + bare.strip().replace(" ", "_"), (name or None)


def _comet_table(comet_els: Path) -> pd.DataFrame:
    body = strip_comment_lines(comet_els.read_bytes())
    frame = mpc.load_comets_dataframe_slow(io.BytesIO(body))
    frame = one_solution_per_designation(frame).reset_index(drop=True)
    if frame["designation"].isna().any():
        raise MpcFormatError("CometEls row without a designation")
    ids_names = [_comet_id_and_name(row) for _, row in frame.iterrows()]
    frame["id"] = pd.Series([body_id for body_id, _ in ids_names], index=frame.index, dtype="str")
    frame["name"] = pd.Series([name for _, name in ids_names], index=frame.index, dtype="str")
    frame["kind"] = pd.Series("comet", index=frame.index, dtype="str")
    perihelion = [
        float(julian_day(int(year), int(month), float(day))) - 0.5
        for year, month, day in zip(
            frame["perihelion_year"],
            frame["perihelion_month"],
            frame["perihelion_day"],
            strict=True,
        )
    ]
    frame["perihelion_tt"] = pd.Series(perihelion, index=frame.index, dtype="float64")
    # Elements epoch: the perturbed epoch when present, else the perihelion time (D43).
    epoch = [
        float(julian_day(int(year), int(month), int(day))) - 0.5
        if pd.notna(year) and pd.notna(month) and pd.notna(day)
        else fallback
        for year, month, day, fallback in zip(
            frame["perturbed_epoch_year"],
            frame["perturbed_epoch_month"],
            frame["perturbed_epoch_day"],
            perihelion,
            strict=True,
        )
    ]
    frame["elements_epoch_tt"] = pd.Series(epoch, index=frame.index, dtype="float64")
    if frame["id"].duplicated().any():
        raise MpcFormatError("duplicate comet id in CometEls")
    return frame.sort_values("id", kind="stable").reset_index(drop=True)


def _nan_column(frame: pd.DataFrame) -> pd.Series[Any]:
    return pd.Series(np.nan, index=frame.index, dtype="float64")


def _index_table(asteroids: pd.DataFrame, comets: pd.DataFrame) -> pd.DataFrame:
    asteroid_index = pd.DataFrame(
        {
            "id": asteroids["id"],
            "designation": asteroids["designation"],
            "name": asteroids["name"],
            "kind": asteroids["kind"],
            "h_mag": asteroids["magnitude_H"].astype("float64"),
            "magnitude_g": _nan_column(asteroids),
            "magnitude_k": _nan_column(asteroids),
            "elements_epoch_tt": asteroids["elements_epoch_tt"],
            "perihelion_tt": _nan_column(asteroids),
            "designation_packed": asteroids["designation_packed"],
        }
    )
    comet_index = pd.DataFrame(
        {
            "id": comets["id"],
            "designation": comets["designation"],
            "name": comets["name"],
            "kind": comets["kind"],
            "h_mag": _nan_column(comets),
            "magnitude_g": comets["magnitude_g"].astype("float64"),
            "magnitude_k": comets["magnitude_k"].astype("float64"),
            "elements_epoch_tt": comets["elements_epoch_tt"],
            "perihelion_tt": comets["perihelion_tt"],
            "designation_packed": comets["designation_packed"].astype("str"),
        }
    )
    index = pd.concat([asteroid_index, comet_index], ignore_index=True)
    for column in ("id", "designation", "name", "kind", "designation_packed"):
        index[column] = index[column].astype("str")
    if not index["designation"].str.isascii().all():
        raise MpcFormatError("MPC designations must be ASCII (the in-memory index is bytes)")
    # Rows sorted by designation (code points = ASCII bytes) so `astro/minor_bodies.py` can run
    # `searchsorted` prefix queries on the array as loaded, without a sorted copy.
    index = index.sort_values("designation", kind="stable").reset_index(drop=True)
    return index[list(INDEX_COLUMNS)]


def read_mpc_parquet(
    path: Path, filters: Sequence[tuple[str, str, object]] | None = None
) -> pd.DataFrame:
    """`pd.read_parquet` through pyarrow with optional row filters (row-group pruning).

    pandas-stubs 3.0.5 declares the `engine="pyarrow"` overload with a mandatory
    `to_pandas_kwargs`, hence the empty mapping.
    """
    return pd.read_parquet(path, engine="pyarrow", filters=filters, to_pandas_kwargs={})


def _write_parquet(frame: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_parquet(path, engine="pyarrow", index=False, row_group_size=PARQUET_ROW_GROUP_SIZE)


def _epoch_range(frames: Iterable[pd.DataFrame]) -> tuple[float, float] | None:
    epochs = pd.concat([frame["elements_epoch_tt"] for frame in frames], ignore_index=True)
    epochs = epochs.dropna()
    if epochs.empty:
        return None
    return float(epochs.min()), float(epochs.max())


def _artifact(
    name: str,
    path: Path,
    count: int,
    version: str,
    meta: dict[str, float | int | str | tuple[float, float] | None],
) -> Artifact:
    return Artifact(
        name=name,
        path=path,
        sha256=_sha256(path),
        bytes=path.stat().st_size,
        count=count,
        version=version,
        source_keys=("mpcorb", "comets"),
        meta=meta,
    )


def build_mpc(mpcorb_dat: Path, comet_els: Path, out: CachePaths) -> BuildResult:
    """Parse the two MPC files once and write the three Parquet artifacts under `out.mpc_dir`."""
    started = time.perf_counter()
    version = artifact_version({"mpcorb": _sha256(mpcorb_dat), "comets": _sha256(comet_els)})

    asteroids = _asteroid_table(mpcorb_dat)
    _write_parquet(asteroids, out.mpc_asteroids)
    comets = _comet_table(comet_els)
    _write_parquet(comets, out.mpc_comets)
    index = _index_table(asteroids, comets)
    _write_parquet(index, out.mpc_index)

    asteroid_range = _epoch_range([asteroids])
    comet_range = _epoch_range([comets])
    both_range = _epoch_range([asteroids, comets])
    result = BuildResult(
        artifacts=(
            _artifact(
                "mpc_asteroids",
                out.mpc_asteroids,
                len(asteroids),
                version,
                {"elements_epoch_range_tt": asteroid_range},
            ),
            _artifact(
                "mpc_comets",
                out.mpc_comets,
                len(comets),
                version,
                {"elements_epoch_range_tt": comet_range},
            ),
            _artifact(
                "mpc_index",
                out.mpc_index,
                len(index),
                version,
                {
                    "asteroids": len(asteroids),
                    "comets": len(comets),
                    "elements_epoch_range_tt": both_range,
                },
            ),
        )
    )
    # ru_maxrss is in kilobytes on Linux (R30 measurement; no query strings, no coordinates).
    logger.info(
        "mpc build: asteroids=%d comets=%d seconds=%.1f max_rss_mb=%d",
        len(asteroids),
        len(comets),
        time.perf_counter() - started,
        resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024,
    )
    return result
