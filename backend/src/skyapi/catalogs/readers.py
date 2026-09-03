"""Readers for the catalog source files, shared by the builders (D40, D46-D48).

Every reader strips leading `#` provenance lines first (the committed excerpts under
`tests/fixtures/excerpts/` carry a source/license header, brief l.325) and then hands the bytes
to Skyfield or pandas. Nothing here computes astronomy: the readers return tables.
"""

import csv
import gzip
import json
import math
from collections.abc import Mapping
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from skyfield.data import hipparcos

from skyapi.catalogs.formats import BV_UNKNOWN

_GZIP_MAGIC = b"\x1f\x8b"

# hip_main.dat field positions (CDS I/239 ReadMe): H1 = HIP is column 1, H37 = B-V is column 37.
_HIP_COLUMN_HIP = 1
_HIP_COLUMN_BV = 37

OPENNGC_COLUMNS = (
    "Name",
    "Type",
    "RA",
    "Dec",
    "Const",
    "MajAx",
    "MinAx",
    "PosAng",
    "B-Mag",
    "V-Mag",
    "M",
    "NGC",
    "IC",
    "Common names",
)
"""The OpenNGC columns the DSO builder needs (D47); the files carry 32 `;`-separated columns."""


class SourceFormatError(ValueError):
    """A source file does not have the layout the reader expects (upstream format change)."""


def strip_comment_lines(path: Path) -> BytesIO:
    """Return the file bytes without their leading `#` lines, gunzipped when the file is gzip."""
    raw = path.read_bytes()
    if raw[:2] == _GZIP_MAGIC:
        raw = gzip.decompress(raw)
    return BytesIO(_strip_leading_comments(raw))


def _strip_leading_comments(raw: bytes) -> bytes:
    pos = 0
    while raw.startswith(b"#", pos):
        newline = raw.find(b"\n", pos)
        pos = len(raw) if newline < 0 else newline + 1
    return raw[pos:]


def read_hipparcos(path: Path) -> pd.DataFrame:
    """Hipparcos main catalogue as Skyfield's dataframe plus `bv_millimag` (D48).

    Rows without a position are dropped here (Skyfield keeps them). `B-V` is not in Skyfield's
    `usecols`, so it is read by a second positional pass; a blank field is six spaces, which
    would turn the column into `str`, hence the `to_numeric(errors="coerce")` and the
    `BV_UNKNOWN` sentinel. Index: `hip`.
    """
    buffer = strip_comment_lines(path)
    frame = hipparcos.load_dataframe(buffer)
    frame = frame[frame["ra_degrees"].notnull()]
    buffer.seek(0)
    bv_frame = pd.read_csv(
        buffer,
        sep="|",
        header=None,
        usecols=[_HIP_COLUMN_HIP, _HIP_COLUMN_BV],
        names=["hip", "bv"],
        dtype=str,
    )
    hip = pd.to_numeric(bv_frame["hip"].str.strip(), errors="raise").astype(np.int64)
    bv = pd.to_numeric(bv_frame["bv"].str.strip(), errors="coerce").to_numpy(dtype=np.float64)
    millimag = np.where(np.isnan(bv), BV_UNKNOWN, np.rint(bv * 1000.0)).astype(np.int16)
    bv_by_hip = pd.Series(millimag, index=pd.Index(hip.to_numpy(), name="hip"))
    frame = frame.assign(
        bv_millimag=bv_by_hip.reindex(frame.index).fillna(BV_UNKNOWN).astype(np.int16)
    )
    return frame.sort_index()


HYG_COLUMNS = ("hip", "proper", "bayer", "flam", "con")


def read_hyg(path: Path) -> pd.DataFrame:
    """HYG rows that carry a Hipparcos id, as strings (`hip`, `proper`, `bayer`, `flam`, `con`).

    Accepts the gzipped release file or a plain-text excerpt with `#` lines (D40); the CSV has
    quoted headers, `""` for empty strings and blank numeric fields, so it is parsed as text.
    """
    frame = pd.read_csv(
        strip_comment_lines(path),
        usecols=list(HYG_COLUMNS),
        dtype=str,
        keep_default_na=False,
    )
    frame = frame[frame["hip"] != ""]
    frame = frame.assign(hip=pd.to_numeric(frame["hip"], errors="raise").astype(np.int64))
    return frame.reset_index(drop=True)


def read_openngc(path: Path) -> pd.DataFrame:
    """One OpenNGC file (`NGC.csv` or `addendum.csv`) with `ra_deg`/`dec_deg` added (D47).

    Every column stays a string (`""` when empty); `Const` `Se1`/`Se2` become `Ser`; RA/Dec are
    parsed here with the sign taken from the string so `-00:24:54.8` stays negative.
    """
    frame = pd.read_csv(
        strip_comment_lines(path),
        sep=";",
        dtype=str,
        keep_default_na=False,
    )
    missing = [column for column in OPENNGC_COLUMNS if column not in frame.columns]
    if missing:
        raise SourceFormatError(f"{path.name}: missing OpenNGC columns {missing}")
    frame = frame.assign(
        Const=frame["Const"].replace({"Se1": "Ser", "Se2": "Ser"}),
        ra_deg=[parse_ra_hms(value) for value in frame["RA"]],
        dec_deg=[parse_dec_dms(value) for value in frame["Dec"]],
    )
    return frame.reset_index(drop=True)


def parse_ra_hms(text: str) -> float:
    """`HH:MM:SS.SS` -> degrees in [0, 360); NaN for an empty field."""
    if not text.strip():
        return math.nan
    hours, minutes, seconds = (float(part) for part in text.strip().split(":"))
    return (hours + minutes / 60.0 + seconds / 3600.0) * 15.0 % 360.0


def parse_dec_dms(text: str) -> float:
    """`+DD:MM:SS.S` -> degrees, the sign read from the string; NaN for an empty field."""
    stripped = text.strip()
    if not stripped:
        return math.nan
    sign = -1.0 if stripped.startswith("-") else 1.0
    degrees, minutes, seconds = (float(part) for part in stripped.lstrip("+-").split(":"))
    return sign * (degrees + minutes / 60.0 + seconds / 3600.0)


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("rb") as handle:
        document: object = json.load(handle)
    if not isinstance(document, dict):
        raise SourceFormatError(f"{path.name}: expected a JSON object at the top level")
    typed: dict[str, Any] = {str(key): value for key, value in document.items()}  # pyright: ignore[reportUnknownVariableType, reportUnknownArgumentType]
    typed.pop("_provenance", None)
    return typed


def read_stellarium_json(path: Path) -> dict[str, Any]:
    """Stellarium sky-culture `index.json` as a dict, the excerpt `_provenance` key removed."""
    document = _read_json(path)
    if not isinstance(document.get("constellations"), list):
        raise SourceFormatError(f"{path.name}: no `constellations` list")
    return document


def read_bounds_json(path: Path) -> dict[str, Any]:
    """d3-celestial `constellations.bounds.json` (GeoJSON FeatureCollection) as a dict."""
    document = _read_json(path)
    if document.get("type") != "FeatureCollection" or not isinstance(
        document.get("features"), list
    ):
        raise SourceFormatError(f"{path.name}: not a GeoJSON FeatureCollection")
    return document


@dataclass(frozen=True, slots=True)
class ConstellationName:
    abbr: str
    latin: str
    genitive: str
    english: str


def read_constellation_names(path: Path) -> Mapping[str, ConstellationName]:
    """The committed `constellation_names.csv` (88 rows `abbr,latin,genitive,english`)."""
    text = strip_comment_lines(path).read().decode("utf-8")
    names: dict[str, ConstellationName] = {}
    for row in csv.DictReader(text.splitlines()):
        entry = ConstellationName(
            abbr=row["abbr"], latin=row["latin"], genitive=row["genitive"], english=row["english"]
        )
        if len(entry.abbr) != 3 or not entry.latin or not entry.genitive:
            raise SourceFormatError(f"{path.name}: malformed row {row}")
        if entry.abbr in names:
            raise SourceFormatError(f"{path.name}: duplicate abbreviation {entry.abbr}")
        names[entry.abbr] = entry
    return names
