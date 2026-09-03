"""Cache builders: SKYS stars + index, OpenNGC subset, constellations (brief l.359, D45-D48).

Run by `sky-data build-caches` through `data/caches.py`, never per request (brief pitfalls
l.535). Each builder reads its source files, writes the artifacts named by `CachePaths` and
returns a `BuildResult` whose `Artifact`s carry the sha256 (the ETag), size, count and the
version derived from the source hashes. Output is deterministic: sorted rows, compact JSON.
"""

import hashlib
import json
import re
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from numpy.typing import NDArray
from pydantic import TypeAdapter
from skyfield.api import load
from skyfield.data.stellarium import parse_constellations_json
from skyfield.positionlib import SSB
from skyfield.starlib import Star

from skyapi.catalogs.artifacts import Artifact, BuildResult, CachePaths, artifact_version
from skyapi.catalogs.formats import StarTable, write_skys
from skyapi.catalogs.readers import (
    SourceFormatError,
    read_bounds_json,
    read_constellation_names,
    read_hipparcos,
    read_hyg,
    read_openngc,
    read_stellarium_json,
)
from skyapi.models.catalogs import (
    ConstellationEntry,
    ConstellationLabel,
    ConstellationsResponse,
    DsoEntry,
    DsoType,
    StarIndexEntry,
    StarNames,
)

J2000_TT = 2451545.0
"""SKYS epoch (brief l.133): Hipparcos J1991.25 positions propagated to J2000 by Skyfield."""

JULIAN_YEAR_DAYS = 365.25

HIPPARCOS_PARQUET_COLUMNS = (
    "hip",
    "ra_degrees",
    "dec_degrees",
    "ra_mas_per_year",
    "dec_mas_per_year",
    "parallax_mas",
    "magnitude",
    "bv_millimag",
    "epoch_year",
)

STELLARIUM_DECLARED_LICENSE = "CC BY-SA 4.0"

COORDINATE_DECIMALS = 6
"""Catalog coordinates are rounded to 1e-6 degree (0.0036 arcsec) for compact, stable JSON."""

_DSO_ADAPTER: TypeAdapter[list[DsoEntry]] = TypeAdapter(list[DsoEntry])


class LicenseChangedError(RuntimeError):
    """The Stellarium sky culture no longer declares the license we redistribute it under."""


class BuildError(ValueError):
    """A source file holds values the builder cannot map (upstream change, brief l.313)."""


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _dump_json(document: object) -> bytes:
    return json.dumps(document, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    )


def _write(path: Path, data: bytes) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def _artifact(
    name: str,
    path: Path,
    data: bytes,
    *,
    count: int,
    version: str,
    source_keys: tuple[str, ...],
    meta: Mapping[str, float | int | str | tuple[float, float] | None],
    declared_license: str | None = None,
) -> Artifact:
    return Artifact(
        name=name,
        path=path,
        sha256=_write(path, data),
        bytes=len(data),
        count=count,
        version=version,
        source_keys=source_keys,
        meta=meta,
        declared_license=declared_license,
    )


# --- stars ------------------------------------------------------------------------------------

GREEK_LETTERS: Mapping[str, str] = {
    "Alp": "α",
    "Bet": "β",
    "Gam": "γ",
    "Del": "δ",
    "Eps": "ε",
    "Zet": "ζ",
    "Eta": "η",
    "The": "θ",
    "Iot": "ι",
    "Kap": "κ",
    "Lam": "λ",
    "Mu": "μ",
    "Nu": "ν",
    "Xi": "ξ",
    "Omi": "ο",
    "Pi": "π",
    "Rho": "ρ",
    "Sig": "σ",
    "Tau": "τ",
    "Ups": "υ",
    "Phi": "φ",
    "Chi": "χ",
    "Psi": "ψ",
    "Ome": "ω",
}
"""HYG three-letter Greek abbreviations (D46)."""

SUPERSCRIPTS = str.maketrans("123456789", "¹²³⁴⁵⁶⁷⁸⁹")


def bayer_designation(bayer: str, con: str) -> str:
    """HYG `bayer` (`Alp`, `Kap-1`, `p`) + `con` -> `"α Ori"`, `"κ¹ Scl"`, `"p Eri"` (D46)."""
    letter, _, superscript = bayer.partition("-")
    rendered = GREEK_LETTERS.get(letter, letter) + superscript.translate(SUPERSCRIPTS)
    return f"{rendered} {con}"


def build_star_index(hyg: pd.DataFrame, known_hips: Iterable[int]) -> list[StarIndexEntry]:
    """`StarIndexEntry` rows for HYG stars with a HIP present in the SKYS table and a name."""
    known = set(int(hip) for hip in known_hips)
    entries: list[StarIndexEntry] = []
    for record in hyg.to_dict("records"):
        hip = int(record["hip"])
        proper, bayer, flam, con = (
            str(record["proper"]),
            str(record["bayer"]),
            str(record["flam"]),
            str(record["con"]),
        )
        if hip not in known or not (proper or bayer or flam) or len(con) != 3:
            continue
        names = StarNames(
            proper=proper or None,
            bayer=bayer_designation(bayer, con) if bayer else None,
            flamsteed=f"{flam} {con}" if flam else None,
        )
        entries.append(StarIndexEntry(hip=hip, names=names, con=con))
    entries.sort(key=lambda entry: entry.hip)
    return entries


def star_table_from_hipparcos(hipparcos: pd.DataFrame) -> StarTable:
    """SKYS columns from Skyfield's dataframe (D48): one vectorised `Star`, evaluated twice.

    `Star` is not a `VectorFunction` (no `.at()`), so the barycentric astrometric position comes
    from `SSB.at(t).observe(star)` (positionlib 1.55 l.66-74); `p1 - p0` over one Julian year is
    exact for Skyfield's linear proper-motion model, giving `pm` in radians per Julian year once
    divided by `|p0|`.
    """
    ts = load.timescale()
    star = Star.from_dataframe(hipparcos)
    t0 = ts.tt_jd(J2000_TT)
    t1 = ts.tt_jd(J2000_TT + JULIAN_YEAR_DAYS)
    p0: NDArray[np.float64] = np.asarray(SSB.at(t0).observe(star).position.au, dtype=np.float64)
    p1: NDArray[np.float64] = np.asarray(SSB.at(t1).observe(star).position.au, dtype=np.float64)
    norm = np.linalg.norm(p0, axis=0)
    direction = (p0 / norm).T
    pm = ((p1 - p0) / norm).T
    mag = np.rint(hipparcos["magnitude"].to_numpy(dtype=np.float64) * 1000.0)
    bv = hipparcos["bv_millimag"].to_numpy(dtype=np.int16)
    hip = hipparcos.index.to_numpy(dtype=np.int64)
    order = np.lexsort((hip, mag))
    return StarTable(
        dir=direction[order].astype(np.float32),
        pm=pm[order].astype(np.float32),
        mag=mag[order].astype(np.int16),
        bv=bv[order],
        hip=hip[order].astype(np.uint32),
        epoch_tt=J2000_TT,
    )


def build_stars(hip_main: Path, hyg_csv_gz: Path, out: CachePaths) -> BuildResult:
    """`stars.skys`, `stars_index.json` and `hipparcos.parquet` from Hipparcos + HYG (D46, D48)."""
    version = artifact_version({"hipparcos": sha256_of(hip_main), "hyg": sha256_of(hyg_csv_gz)})
    source_keys = ("hipparcos", "hyg")
    hipparcos = read_hipparcos(hip_main)
    table = star_table_from_hipparcos(hipparcos)
    skys = write_skys(table)
    index = build_star_index(read_hyg(hyg_csv_gz), table.hip.tolist())
    index_json = _dump_json([entry.model_dump(mode="json", exclude_none=True) for entry in index])
    parquet_frame = hipparcos.reset_index()[list(HIPPARCOS_PARQUET_COLUMNS)]
    out.root.mkdir(parents=True, exist_ok=True)
    parquet_frame.to_parquet(out.hipparcos_parquet, engine="pyarrow", index=False)
    parquet_bytes = out.hipparcos_parquet.read_bytes()
    return BuildResult(
        artifacts=(
            _artifact(
                "stars",
                out.stars_skys,
                skys,
                count=table.count,
                version=version,
                source_keys=source_keys,
                meta={
                    "epoch_tt": table.epoch_tt,
                    "magnitude_limit": float(table.mag[-1]) / 1000.0 if table.count else None,
                    "count": table.count,
                },
            ),
            _artifact(
                "stars_index",
                out.stars_index,
                index_json,
                count=len(index),
                version=version,
                source_keys=source_keys,
                meta={"count": len(index)},
            ),
            Artifact(
                name="hipparcos",
                path=out.hipparcos_parquet,
                sha256=hashlib.sha256(parquet_bytes).hexdigest(),
                bytes=len(parquet_bytes),
                count=len(parquet_frame),
                version=version,
                source_keys=source_keys,
                meta={"count": len(parquet_frame), "epoch_year": 1991.25},
            ),
        )
    )


# --- deep-sky objects -------------------------------------------------------------------------

DSO_TYPE_MAP: Mapping[str, DsoType] = {
    "G": "galaxy",
    "GPair": "galaxy",
    "GTrpl": "galaxy",
    "GGroup": "galaxy",
    "OCl": "open_cluster",
    "GCl": "globular_cluster",
    "PN": "planetary_nebula",
    "Neb": "nebula",
    "HII": "nebula",
    "EmN": "nebula",
    "RfN": "nebula",
    "SNR": "nebula",
    "Cl+N": "nebula",
    "*": "other",
    "**": "other",
    "*Ass": "other",
    "DrkN": "other",
    "Nova": "other",
    "Other": "other",
}
"""OpenNGC `Type` codes (NGC_guide.txt) -> contract types (brief l.145, D47)."""

DSO_DROPPED_TYPES = frozenset({"Dup", "NonEx"})

_NAME_PATTERN = re.compile(r"^([A-Za-z]+)0*(\d+)(.*)$")


def normalize_dso_id(name: str) -> str:
    """`NGC0224` -> `NGC224`, `IC0080 NED01` -> `IC80_NED01`, `Mel022` -> `Mel22` (D47)."""
    match = _NAME_PATTERN.match(name.strip())
    if match is None:
        raise BuildError(f"unexpected OpenNGC name {name!r}")
    prefix, number, rest = match.groups()
    return f"{prefix}{int(number)}{rest}".replace(" ", "_")


def _dso_sort_key(entry: DsoEntry) -> tuple[str, int, str]:
    match = _NAME_PATTERN.match(entry.id)
    if match is None:  # pragma: no cover - ids come from normalize_dso_id
        return (entry.id, 0, "")
    prefix, number, rest = match.groups()
    return (prefix, int(number), rest)


def _optional_float(text: str) -> float | None:
    return float(text) if text.strip() else None


def build_dso_entries(
    rows: pd.DataFrame, *, mag_limit: float, size_arcmin: float
) -> tuple[list[DsoEntry], dict[int, str]]:
    """Subset rule and Messier aliases (D47) over the concatenated OpenNGC rows.

    Returns the kept entries and `{messier_number: id}` for the `Dup` rows named `M<n>` whose
    `M` column points at another object (OpenNGC's NED convention: M102 -> M101 = NGC5457).
    """
    records = rows.to_dict("records")
    masters_by_messier: dict[int, str] = {}
    entries: list[DsoEntry] = []
    for record in records:
        kind = str(record["Type"])
        if kind in DSO_DROPPED_TYPES:
            continue
        if kind not in DSO_TYPE_MAP:
            raise BuildError(f"unknown OpenNGC type {kind!r} for {record['Name']!r}")
        messier = int(record["M"]) if str(record["M"]).strip() else None
        mag = _optional_float(str(record["V-Mag"])) or _optional_float(str(record["B-Mag"]))
        major = _optional_float(str(record["MajAx"]))
        keep = (
            messier is not None
            or (mag is not None and mag <= mag_limit)
            or (major is not None and major >= size_arcmin)
        )
        if not keep:
            continue
        common = str(record["Common names"])
        entry = DsoEntry(
            id=normalize_dso_id(str(record["Name"])),
            names=[name.strip() for name in common.split(",") if name.strip()],
            messier=messier,
            type=DSO_TYPE_MAP[kind],
            ra_deg=round(float(record["ra_deg"]), COORDINATE_DECIMALS),
            dec_deg=round(float(record["dec_deg"]), COORDINATE_DECIMALS),
            mag=mag,
            major_arcmin=major,
            minor_arcmin=_optional_float(str(record["MinAx"])),
            pa_deg=_optional_float(str(record["PosAng"])),
            con=str(record["Const"]),
        )
        entries.append(entry)
        if messier is not None:
            if messier in masters_by_messier:
                raise BuildError(f"Messier {messier} claimed twice ({masters_by_messier[messier]})")
            masters_by_messier[messier] = entry.id
    aliases: dict[int, str] = {}
    for record in records:
        name = str(record["Name"])
        if str(record["Type"]) != "Dup" or not re.fullmatch(r"M0*\d+", name):
            continue
        alias = int(name[1:])
        target = str(record["M"]).strip()
        if not target or int(target) not in masters_by_messier:
            raise BuildError(f"Messier alias {name} has no master object")
        aliases[alias] = masters_by_messier[int(target)]
    entries.sort(key=_dso_sort_key)
    return entries, aliases


def with_messier_alias_names(
    entries: Sequence[DsoEntry], aliases: Mapping[int, str]
) -> list[DsoEntry]:
    """Append `"M<n>"` to the `names` of an alias target so the served JSON carries the alias.

    `DsoEntry` has one `messier` slot; the alias survives in `names` (the frontend search reads
    them) and `state.py` rebuilds the Messier map from there.
    """
    by_id = {alias_id: number for number, alias_id in aliases.items()}
    result: list[DsoEntry] = []
    for entry in entries:
        if entry.id in by_id:
            alias_name = f"M{by_id[entry.id]}"
            names = [*entry.names, alias_name] if alias_name not in entry.names else entry.names
            entry = entry.model_copy(update={"names": names})
        result.append(entry)
    return result


def build_dso(
    ngc_csv: Path,
    addendum_csv: Path,
    out: CachePaths,
    *,
    mag_limit: float = 14.0,
    size_arcmin: float = 5.0,
) -> BuildResult:
    """`dso.json`: all Messier objects plus mag <= `mag_limit` or major axis >= `size_arcmin`."""
    version = artifact_version({"ngc": sha256_of(ngc_csv), "ngc_addendum": sha256_of(addendum_csv)})
    rows = pd.concat([read_openngc(ngc_csv), read_openngc(addendum_csv)], ignore_index=True)
    entries, aliases = build_dso_entries(rows, mag_limit=mag_limit, size_arcmin=size_arcmin)
    entries = with_messier_alias_names(entries, aliases)
    ids = [entry.id for entry in entries]
    if len(set(ids)) != len(ids):
        raise BuildError("duplicate DSO ids after normalisation")
    data = _dump_json(_DSO_ADAPTER.dump_python(entries, mode="json", exclude_none=True))
    return BuildResult(
        artifacts=(
            _artifact(
                "dso",
                out.dso_json,
                data,
                count=len(entries),
                version=version,
                source_keys=("ngc", "ngc_addendum"),
                meta={
                    "mag_limit": mag_limit,
                    "size_arcmin": size_arcmin,
                    "messier_aliases": len(aliases),
                    "count": len(entries),
                },
            ),
        )
    )


# --- constellations ---------------------------------------------------------------------------

Ring = list[tuple[float, float]]


def check_stellarium_license(description_md: Path) -> str:
    """Return the declared license or raise `LicenseChangedError` (brief l.313, D45).

    The `## License` section of the culture's `description.md` reads "Text and data: CC BY-SA 4.0"
    today; anything else means the redistribution terms changed and a human must look.
    """
    text = description_md.read_text(encoding="utf-8")
    match = re.search(r"^## License\s*$(.*?)(?=^## |\Z)", text, flags=re.M | re.S)
    if match is None:
        raise LicenseChangedError(f"{description_md.name}: no `## License` section")
    section = match.group(1)
    if STELLARIUM_DECLARED_LICENSE not in section:
        raise LicenseChangedError(
            f"{description_md.name}: `## License` no longer declares {STELLARIUM_DECLARED_LICENSE}"
        )
    return STELLARIUM_DECLARED_LICENSE


def normalize_ring(coordinates: Sequence[Sequence[float]]) -> Ring:
    """GeoJSON `[lon, lat]` in -180..180 -> `(ra_deg, dec_deg)` in 0..360, ring closed."""
    ring: Ring = [(float(lon) % 360.0, float(lat)) for lon, lat in coordinates]
    if ring and ring[0] != ring[-1]:
        ring.append(ring[0])
    if len(ring) < 4:
        raise BuildError("a boundary polygon needs at least three distinct vertices")
    return ring


def boundaries_by_abbr(bounds: Mapping[str, Any]) -> dict[str, list[Ring]]:
    """Group the d3-celestial features by id (Serpens has two `Ser` polygons)."""
    grouped: dict[str, list[Ring]] = {}
    for feature in bounds["features"]:
        geometry = feature["geometry"]
        if geometry["type"] != "Polygon":
            raise BuildError(f"{feature['id']}: expected a Polygon, got {geometry['type']}")
        grouped.setdefault(str(feature["id"]), []).append(
            normalize_ring(geometry["coordinates"][0])
        )
    return grouped


def unit_vectors(ra_deg: NDArray[np.float64], dec_deg: NDArray[np.float64]) -> NDArray[np.float64]:
    ra = np.radians(ra_deg)
    dec = np.radians(dec_deg)
    return np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], axis=-1)


def centroid_label(vectors: NDArray[np.float64]) -> ConstellationLabel:
    mean = vectors.mean(axis=0)
    ra = float(np.degrees(np.arctan2(mean[1], mean[0])) % 360.0)
    dec = float(np.degrees(np.arctan2(mean[2], np.hypot(mean[0], mean[1]))))
    return ConstellationLabel(
        ra_deg=round(ra, COORDINATE_DECIMALS) % 360.0, dec_deg=round(dec, COORDINATE_DECIMALS)
    )


def build_constellations(
    index_json: Path,
    description_md: Path,
    bounds_json: Path,
    names_csv: Path,
    hipparcos_parquet: Path,
    out: CachePaths,
) -> BuildResult:
    """`constellations.json` (D45): Stellarium `modern` lines, d3-celestial boundaries, IAU names.

    Brief l.313 names the `modern` culture, whose `index.json` (88 constellations, HIP-based
    polylines) is what `parse_constellations_json` reads; Skyfield's own docstring example uses
    `modern_st`, a different figure set (Sky & Telescope style), so it is deliberately not used.
    """
    declared = check_stellarium_license(description_md)
    version = artifact_version(
        {
            "stellarium_modern": sha256_of(index_json),
            "stellarium_description": sha256_of(description_md),
            "d3_bounds": sha256_of(bounds_json),
            "constellation_names": sha256_of(names_csv),
        }
    )
    read_stellarium_json(index_json)  # structural check; parse_constellations_json wants a file
    with index_json.open("rb") as handle:
        parsed: list[tuple[str, list[tuple[int, int]]]] = parse_constellations_json(handle)
    boundaries = boundaries_by_abbr(read_bounds_json(bounds_json))
    names = read_constellation_names(names_csv)
    hipparcos = pd.read_parquet(
        hipparcos_parquet,
        engine="pyarrow",
        columns=["hip", "ra_degrees", "dec_degrees"],
        to_pandas_kwargs={},
    ).set_index("hip")

    entries: list[ConstellationEntry] = []
    for abbr, lines in sorted(parsed):
        if abbr not in names:
            raise BuildError(f"constellation {abbr!r} missing from {names_csv.name}")
        if abbr not in boundaries:
            raise BuildError(f"constellation {abbr!r} missing from {bounds_json.name}")
        rings = boundaries[abbr]
        hips = sorted({hip for segment in lines for hip in segment})
        present = [hip for hip in hips if hip in hipparcos.index]
        if present:
            stars = hipparcos.loc[present]
            vectors = unit_vectors(
                stars["ra_degrees"].to_numpy(dtype=np.float64),
                stars["dec_degrees"].to_numpy(dtype=np.float64),
            )
        else:
            first = np.asarray(rings[0][:-1], dtype=np.float64)
            vectors = unit_vectors(first[:, 0], first[:, 1])
        entries.append(
            ConstellationEntry(
                abbr=abbr,
                latin=names[abbr].latin,
                genitive=names[abbr].genitive,
                lines=[(int(a), int(b)) for a, b in lines],
                boundary=rings[0],
                boundary_parts=rings if len(rings) > 1 else None,
                label=centroid_label(vectors),
            )
        )
    if len({entry.abbr for entry in entries}) != len(entries):
        raise SourceFormatError(f"{index_json.name}: duplicate constellation ids")
    response = ConstellationsResponse(culture="modern", constellations=entries)
    data = _dump_json(response.model_dump(mode="json", exclude_none=True))
    return BuildResult(
        artifacts=(
            _artifact(
                "constellations",
                out.constellations_json,
                data,
                count=len(entries),
                version=version,
                source_keys=(
                    "stellarium_modern",
                    "stellarium_description",
                    "d3_bounds",
                    "constellation_names",
                ),
                meta={"culture": "modern", "count": len(entries)},
                declared_license=declared,
            ),
        )
    )
