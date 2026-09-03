"""`catalogs/mpc_build.py` on the committed MPC excerpts (D40, D42, D43)."""

import hashlib
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from skyapi.catalogs.artifacts import CachePaths
from skyapi.catalogs.mpc_build import (
    INDEX_COLUMNS,
    MPCORB_COLUMNS,
    build_mpc,
    mpcorb_body_offset,
    one_solution_per_designation,
    pack_number,
    read_mpc_parquet,
    strip_comment_lines,
    unpack_epoch_tt,
    unpack_number,
)
from support.fixtures_mpc import MpcBuild, MpcExcerpts

pytestmark = pytest.mark.unit

CERES_EPOCH_TT = 2461200.5  # K2669 = 2026-06-09.0 TT


def _data_rows(path: Path) -> list[bytes]:
    """Orbit rows of an excerpt: after the `#` lines and the dashed line, non-blank."""
    data = path.read_bytes()
    body = data[mpcorb_body_offset(data) :]
    return [line for line in body.split(b"\n") if line.strip()]


def _comet_rows(path: Path) -> list[bytes]:
    return [line for line in strip_comment_lines(path.read_bytes()).split(b"\n") if line.strip()]


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# --------------------------------------------------------------------------- header handling


def test_body_offset_skips_provenance_and_prose_header(mpc_excerpts: MpcExcerpts) -> None:
    data = mpc_excerpts.mpcorb.read_bytes()
    assert data.startswith(b"# Source: https://data.minorplanetcenter.net/iau/MPCORB/MPCORB.DAT.gz")
    offset = mpcorb_body_offset(data)
    assert data[offset : offset + 5] == b"00001"
    # The dashed separator is the line right before the first row.
    previous = data[:offset].rstrip(b"\n").rsplit(b"\n", 1)[-1]
    assert len(previous) >= 100
    assert set(previous) == {ord("-")}


def test_body_offset_without_prose_header(mpc_excerpts: MpcExcerpts) -> None:
    data = mpc_excerpts.mpcorb.read_bytes()
    rows_only = data[mpcorb_body_offset(data) :]
    assert mpcorb_body_offset(rows_only) == 0
    with_comments = b"# one\n# two\n" + rows_only
    assert mpcorb_body_offset(with_comments) == len(b"# one\n# two\n")
    assert mpcorb_body_offset(b"") == 0
    assert mpcorb_body_offset(b"# only a comment") == len(b"# only a comment")


def test_build_accepts_a_header_less_file(
    tmp_path: Path, mpc_excerpts: MpcExcerpts, mpc_build: MpcBuild
) -> None:
    data = mpc_excerpts.mpcorb.read_bytes()
    stripped = tmp_path / "MPCORB.rows.dat"
    stripped.write_bytes(data[mpcorb_body_offset(data) :])
    paths = CachePaths(root=tmp_path / "cache")
    result = build_mpc(stripped, mpc_excerpts.comets, paths)
    assert result.artifacts[0].count == mpc_build.result.artifacts[0].count
    assert _sha256(paths.mpc_asteroids) == _sha256(mpc_build.paths.mpc_asteroids)


def test_comment_lines_are_dropped(mpc_excerpts: MpcExcerpts) -> None:
    raw = mpc_excerpts.comets.read_bytes()
    assert raw.startswith(b"# Source: https://data.minorplanetcenter.net/iau/MPCORB/CometEls.txt")
    body = strip_comment_lines(raw)
    assert not any(line.startswith(b"#") for line in body.split(b"\n"))
    assert body.count(b"\n") == raw.count(b"\n") - 4


# --------------------------------------------------------------------------- packed forms


@pytest.mark.parametrize(
    ("packed", "number"),
    [
        ("00001", 1),
        ("99999", 99999),
        ("A0000", 100000),
        ("A0001", 100001),
        ("D4340", 134340),
        ("Z9999", 359999),
        ("a0001", 360001),
        ("z9999", 619999),
        ("~0000", 620000),
        ("~0001", 620001),
        ("~000A", 620010),
        ("~000a", 620036),
        ("~AZaz", 620000 + 10 * 62**3 + 35 * 62**2 + 36 * 62 + 61),
    ],
)
def test_unpack_number(packed: str, number: int) -> None:
    assert unpack_number(packed) == number
    assert pack_number(number) == packed


@pytest.mark.parametrize("bad", [0, -1, 620_000 + 62**4])
def test_pack_number_rejects_out_of_range(bad: int) -> None:
    with pytest.raises(ValueError, match="number"):
        pack_number(bad)


@pytest.mark.parametrize("bad", ["K24A00B", "1234", "123456", "~000!", "", "(1) Ceres"])
def test_unpack_number_rejects_non_numbers(bad: str) -> None:
    with pytest.raises(ValueError, match="packed"):
        unpack_number(bad)


def test_unpack_epoch_matches_skyfield_arithmetic() -> None:
    assert unpack_epoch_tt("K2669") == CERES_EPOCH_TT
    # J2000.0 = 2000-01-01.5 TT -> 0h of that day is 2451544.5.
    assert unpack_epoch_tt("K0011") == 2451544.5
    # Month/day letters: A = 10, V = 31.
    assert unpack_epoch_tt("J99AV") == unpack_epoch_tt("J99B1") - 1.0
    with pytest.raises(ValueError, match="5 characters"):
        unpack_epoch_tt("K266")


# --------------------------------------------------------------------------- asteroids


def test_asteroid_row_count(mpc_build: MpcBuild, mpc_excerpts: MpcExcerpts) -> None:
    rows = _data_rows(mpc_excerpts.mpcorb)
    assert all(len(row) == 202 for row in rows)
    asteroids = read_mpc_parquet(mpc_build.paths.mpc_asteroids)
    assert len(asteroids) == len(rows) == mpc_build.result.artifacts[0].count


def test_asteroid_ids_and_names(mpc_build: MpcBuild) -> None:
    asteroids = read_mpc_parquet(mpc_build.paths.mpc_asteroids).set_index("id")
    assert asteroids.at["a:1", "designation"] == "(1) Ceres"
    assert asteroids.at["a:1", "name"] == "Ceres"
    assert asteroids.at["a:1", "designation_packed"] == "00001"
    assert asteroids.at["a:1", "kind"] == "asteroid"
    assert asteroids.at["a:1", "elements_epoch_tt"] == CERES_EPOCH_TT
    assert asteroids.at["a:4", "name"] == "Vesta"
    assert asteroids.at["a:433", "name"] == "Eros"
    assert asteroids.at["a:99942", "name"] == "Apophis"
    # Letter- and tilde-packed numbers are unpacked and cross-checked against "(n)".
    assert asteroids.at["a:100001", "designation_packed"] == "A0001"
    assert asteroids.at["a:134340", "designation_packed"] == "D4340"
    assert asteroids.at["a:620000", "designation_packed"] == "~0000"
    # Unnumbered objects: `a:<packed>`, provisional designation, no name.
    unnumbered = asteroids[~asteroids["designation"].str.startswith("(")]
    assert len(unnumbered) == 15
    assert all(
        body_id == f"a:{packed}" for body_id, packed in unnumbered["designation_packed"].items()
    )
    assert all(len(packed) == 7 for packed in unnumbered["designation_packed"])
    assert bool(unnumbered["name"].isna().all())
    assert bool(unnumbered["designation"].str.match(r"^\d{4} [A-Z]{2}\d*$").all())
    assert (unnumbered["designation"].str.startswith("2024")).sum() == 5
    # Numbered but unnamed objects keep a provisional designation after ")" and no name.
    numbered = asteroids[asteroids["designation"].str.startswith("(")]
    tail = numbered["designation"].str.replace(r"^\(\d+\)\s*", "", regex=True)
    provisional = tail.str.match(r"^\d{4} [A-Z]{2}\d*$")
    assert numbered["name"].isna().to_numpy().tolist() == provisional.to_numpy().tolist()
    assert asteroids.index.is_unique


def test_asteroids_sorted_by_packed_designation(mpc_build: MpcBuild) -> None:
    packed = read_mpc_parquet(mpc_build.paths.mpc_asteroids)["designation_packed"]
    values = packed.tolist()
    assert values == sorted(values)


def test_asteroid_parquet_schema(mpc_build: MpcBuild) -> None:
    asteroids = read_mpc_parquet(mpc_build.paths.mpc_asteroids)
    expected_dtypes = {name: kind for name, _, kind in MPCORB_COLUMNS}
    for name, kind in expected_dtypes.items():
        assert str(asteroids[name].dtype) == kind, name
    for name in ("id", "name", "kind"):
        assert str(asteroids[name].dtype) == "str", name
    assert str(asteroids["elements_epoch_tt"].dtype) == "float64"
    assert bool(asteroids["semimajor_axis_au"].notna().all())


# --------------------------------------------------------------------------- comets


def test_comet_rows_and_dedup(mpc_build: MpcBuild, mpc_excerpts: MpcExcerpts) -> None:
    raw = _comet_rows(mpc_excerpts.comets)
    ztf = [row for row in raw if row[102:158].strip() == b"P/2021 N1 (ZTF)"]
    assert len(ztf) == 2, "the excerpt must keep both solutions of P/2021 N1"
    comets = read_mpc_parquet(mpc_build.paths.mpc_comets).set_index("id")
    assert len(comets) == len(raw) - 1 == mpc_build.result.artifacts[1].count
    kept = "c:P/2021_N1"
    # Equal references sort stably: the later line in the file wins, as one coherent row.
    last = ztf[-1]
    assert comets.at[kept, "perihelion_distance_au"] == pytest.approx(float(last[30:39]))
    assert comets.at[kept, "reference"] == last[159:168].strip().decode()
    year, month, day = int(last[81:85]), int(last[85:87]), int(last[87:89])
    expected_epoch = unpack_epoch_tt(f"K{year - 2000:02d}{month:X}{day:X}")
    assert comets.at[kept, "elements_epoch_tt"] == expected_epoch


def test_comet_ids_and_names(mpc_build: MpcBuild) -> None:
    comets = read_mpc_parquet(mpc_build.paths.mpc_comets).set_index("id")
    assert comets.at["c:1P", "designation"] == "1P/Halley"
    assert comets.at["c:1P", "name"] == "Halley"
    assert comets.at["c:2P", "name"] == "Encke"
    assert comets.at["c:C/1995_O1", "designation"] == "C/1995 O1 (Hale-Bopp)"
    assert comets.at["c:C/1995_O1", "name"] == "Hale-Bopp"
    assert comets.at["c:C/2023_A3", "name"] == "Tsuchinshan-ATLAS"
    assert comets.at["c:1I", "name"] == "`Oumuamua"
    assert comets.at["c:P/2021_N1", "name"] == "ZTF"
    assert bool((comets["kind"] == "comet").all())
    a_objects = comets[comets["designation"].str.startswith("A/")]
    assert len(a_objects) == 1
    assert bool(a_objects["name"].isna().all())
    assert a_objects.index[0] == "c:" + a_objects["designation"].iloc[0].replace(" ", "_")
    fragments = comets[comets["designation"].str.match(r"^\d+[A-Z]-[A-Z]+/")]
    assert len(fragments) >= 1
    for body_id, designation in fragments["designation"].items():
        assert body_id == "c:" + designation.split("/")[0]
    assert not comets.index.has_duplicates
    assert " " not in "".join(comets.index)


def test_comet_epoch_falls_back_to_perihelion(mpc_build: MpcBuild) -> None:
    comets = read_mpc_parquet(mpc_build.paths.mpc_comets)
    without_epoch = comets[comets["perturbed_epoch_year"].isna()]
    assert len(without_epoch) >= 1
    assert bool((without_epoch["elements_epoch_tt"] == without_epoch["perihelion_tt"]).all())
    with_epoch = comets[comets["perturbed_epoch_year"].notna()]
    assert bool((with_epoch["elements_epoch_tt"] != with_epoch["perihelion_tt"]).all())
    # 1P/Halley: perihelion 2061 08 2.9648 TT (K = 20xx, month 8, day 2).
    halley_perihelion = comets.set_index("id").at["c:1P", "perihelion_tt"]
    assert halley_perihelion == pytest.approx(unpack_epoch_tt("K6182") + 0.9648, abs=1e-6)


def test_drop_duplicates_keeps_whole_rows_unlike_groupby_last() -> None:
    frame = pd.DataFrame(
        {
            "designation": ["P/2021 N1 (ZTF)", "P/2021 N1 (ZTF)", "C/1995 O1 (Hale-Bopp)"],
            "reference": ["MPC 1", "MPC 2", "MPC194091"],
            "perturbed_epoch_year": [2020.0, np.nan, 2026.0],
            "perihelion_distance_au": [1.0, 2.0, 0.92],
        }
    )
    spliced = frame.sort_values("reference").groupby("designation").last()
    ztf = "P/2021 N1 (ZTF)"
    # pandas `last()` takes the last non-NA value per column: the 2020 epoch of solution 1 with
    # the perihelion distance of solution 2.
    assert spliced.at[ztf, "perturbed_epoch_year"] == 2020.0
    assert spliced.at[ztf, "perihelion_distance_au"] == 2.0
    coherent = one_solution_per_designation(frame).set_index("designation")
    assert pd.isna(coherent.at[ztf, "perturbed_epoch_year"])
    assert coherent.at[ztf, "perihelion_distance_au"] == 2.0
    assert coherent.at[ztf, "reference"] == "MPC 2"
    assert len(coherent) == 2


# --------------------------------------------------------------------------- index + artifacts


def test_index_columns_and_meta(mpc_build: MpcBuild) -> None:
    index = read_mpc_parquet(mpc_build.paths.mpc_index)
    assert tuple(index.columns) == INDEX_COLUMNS
    for name in ("id", "designation", "name", "kind", "designation_packed"):
        assert str(index[name].dtype) == "str", name
    for name in ("h_mag", "magnitude_g", "magnitude_k", "elements_epoch_tt", "perihelion_tt"):
        assert str(index[name].dtype) == "float64", name
    asteroids, comets, index_artifact = mpc_build.result.artifacts
    assert (asteroids.name, comets.name, index_artifact.name) == (
        "mpc_asteroids",
        "mpc_comets",
        "mpc_index",
    )
    assert len(index) == asteroids.count + comets.count == index_artifact.count
    assert index_artifact.meta["asteroids"] == asteroids.count
    assert index_artifact.meta["comets"] == comets.count
    epoch_range = index_artifact.meta["elements_epoch_range_tt"]
    assert isinstance(epoch_range, tuple)
    low, high = epoch_range
    assert low <= CERES_EPOCH_TT <= high
    assert low == index["elements_epoch_tt"].min()
    assert high == index["elements_epoch_tt"].max()
    by_id = index.set_index("id")
    assert by_id.at["a:1", "h_mag"] == pytest.approx(3.34)
    assert pd.isna(by_id.at["c:1P", "h_mag"])
    assert by_id.at["c:1P", "magnitude_g"] == pytest.approx(5.5)
    assert by_id.at["c:1P", "magnitude_k"] == pytest.approx(3.2)
    assert index["id"].is_unique
    designations = index["designation"].tolist()
    assert designations == sorted(designations), "index rows are sorted by designation bytes"
    for artifact in mpc_build.result.artifacts:
        assert artifact.source_keys == ("mpcorb", "comets")
        assert artifact.version == index_artifact.version
        assert artifact.bytes == artifact.path.stat().st_size
        assert artifact.sha256 == _sha256(artifact.path)


def test_build_is_deterministic(
    tmp_path: Path, mpc_excerpts: MpcExcerpts, mpc_build: MpcBuild
) -> None:
    again = build_mpc(mpc_excerpts.mpcorb, mpc_excerpts.comets, CachePaths(root=tmp_path / "cache"))
    for first, second in zip(mpc_build.result.artifacts, again.artifacts, strict=True):
        assert first.sha256 == second.sha256
        assert first.version == second.version
        assert first.count == second.count


def test_excerpts_are_small(mpc_excerpts: MpcExcerpts) -> None:
    assert mpc_excerpts.mpcorb.stat().st_size < 1_000_000
    assert mpc_excerpts.comets.stat().st_size < 1_000_000
