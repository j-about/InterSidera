"""Catalog builders on the committed excerpts (D45-D48): SKYS, index, DSO, constellations."""

import gzip
import hashlib
import json
import math
import struct
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from skyfield.api import load
from skyfield.positionlib import SSB
from skyfield.starlib import Star

from skyapi.catalogs.artifacts import CachePaths
from skyapi.catalogs.builders import (
    J2000_TT,
    BuildError,
    LicenseChangedError,
    bayer_designation,
    boundaries_by_abbr,
    build_constellations,
    build_dso,
    build_dso_entries,
    build_stars,
    check_stellarium_license,
    normalize_dso_id,
    normalize_ring,
)
from skyapi.catalogs.formats import BV_UNKNOWN, StarTable, read_skys
from skyapi.catalogs.readers import (
    SourceFormatError,
    parse_dec_dms,
    parse_ra_hms,
    read_bounds_json,
    read_constellation_names,
    read_hipparcos,
    read_hyg,
    read_openngc,
    read_stellarium_json,
)
from skyapi.catalogs.state import (
    ArtifactIdentity,
    CatalogState,
    CatalogStateError,
    build_dso_catalog,
    load_catalog_state,
    load_hipparcos_table,
)
from skyapi.models.catalogs import ConstellationsResponse, DsoEntry, StarIndexEntry
from support.fixtures_catalogs import (
    CONSTELLATION_NAMES_CSV,
    EXCERPTS_DIR,
    build_excerpt_caches,
    write_description_md,
)

pytestmark = pytest.mark.unit

ARCSEC_PER_RAD = 206264.80624709636
BARNARD, PROXIMA, BETELGEUSE, KAPPA1_SCL, POLARIS = 87937, 70890, 27989, 761, 11767


def angle_arcsec(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    cross = np.linalg.norm(np.cross(a, b), axis=-1)
    dot = np.sum(a * b, axis=-1)
    return np.degrees(np.arctan2(cross, dot)) * 3600.0


# --- stars -------------------------------------------------------------------------------------


def test_skys_count_and_sort_order(built_caches: CachePaths, excerpts_dir: Path) -> None:
    table = read_skys(built_caches.stars_skys.read_bytes())
    hipparcos = read_hipparcos(excerpts_dir / "hip_main_excerpt.dat")
    assert table.count == len(hipparcos) > 1000
    assert table.epoch_tt == J2000_TT
    assert np.all(np.diff(table.mag.astype(np.int32)) >= 0)
    assert set(table.hip.tolist()) == set(hipparcos.index.tolist())
    assert np.allclose(np.linalg.norm(table.dir.astype(np.float64), axis=1), 1.0, atol=1e-6)
    assert table.mag[0] == -1440  # Sirius, Vmag -1.44
    assert table.hip[0] == 32349


def test_barnard_proper_motion_magnitude(catalog_state: CatalogState) -> None:
    table = catalog_state.stars
    index = int(np.flatnonzero(table.hip == BARNARD)[0])
    pm_arcsec_per_year = float(np.linalg.norm(table.pm[index].astype(np.float64))) * ARCSEC_PER_RAD
    assert pm_arcsec_per_year == pytest.approx(10.36, abs=0.05)


def test_bv_present_and_sentinel(catalog_state: CatalogState, excerpts_dir: Path) -> None:
    table = catalog_state.stars
    by_hip = dict(zip(table.hip.tolist(), table.bv.tolist(), strict=True))
    assert by_hip[PROXIMA] == 1807  # B-V 1.807
    assert by_hip[32349] == 9  # Sirius, B-V 0.009
    raw_rows = [
        line
        for line in (excerpts_dir / "hip_main_excerpt.dat").read_bytes().splitlines()
        if not line.startswith(b"#")
    ]
    blank_bv = [int(row.split(b"|")[1]) for row in raw_rows if not row.split(b"|")[37].strip()]
    assert blank_bv, "the excerpt must contain a star with a blank B-V field"
    assert all(by_hip[hip] == BV_UNKNOWN == 32767 for hip in blank_bv if hip in by_hip)


def test_shader_rule_matches_skyfield_astrometric(
    catalog_state: CatalogState, excerpts_dir: Path
) -> None:
    """`normalize(dir + pm * years)` within 0.1" of `SSB.at(t).observe(star)` (brief l.139)."""
    table = catalog_state.stars
    hipparcos = read_hipparcos(excerpts_dir / "hip_main_excerpt.dat").loc[table.hip.tolist()]
    star = Star.from_dataframe(hipparcos)
    ts = load.timescale()
    for years in (-20.0, 0.0, 20.0):
        t = ts.tt_jd(J2000_TT + years * 365.25)
        reference = np.asarray(SSB.at(t).observe(star).position.au, dtype=np.float64).T
        reference /= np.linalg.norm(reference, axis=1, keepdims=True)
        moved = table.dir.astype(np.float64) + table.pm.astype(np.float64) * years
        moved /= np.linalg.norm(moved, axis=1, keepdims=True)
        worst = float(angle_arcsec(moved, reference).max())
        assert worst < 0.1, f"{worst:.4f} arcsec at {years:+.0f} years"


def test_star_index_entries(built_caches: CachePaths) -> None:
    entries = [
        StarIndexEntry.model_validate(item)
        for item in json.loads(built_caches.stars_index.read_text(encoding="utf-8"))
    ]
    by_hip = {entry.hip: entry for entry in entries}
    assert by_hip[BETELGEUSE].names.model_dump() == {
        "proper": "Betelgeuse",
        "bayer": "α Ori",
        "flamsteed": "58 Ori",
    }
    assert by_hip[BETELGEUSE].con == "Ori"
    assert by_hip[KAPPA1_SCL].names.bayer == "κ¹ Scl"
    assert by_hip[POLARIS].names.proper == "Polaris"
    assert [entry.hip for entry in entries] == sorted(by_hip)
    assert all(
        entry.names.proper or entry.names.bayer or entry.names.flamsteed for entry in entries
    )
    skys_hips = set(read_skys(built_caches.stars_skys.read_bytes()).hip.tolist())
    assert set(by_hip) <= skys_hips


def test_bayer_rendering() -> None:
    assert bayer_designation("Alp", "Ori") == "α Ori"
    assert bayer_designation("Kap-1", "Scl") == "κ¹ Scl"
    assert bayer_designation("Gam-3", "Oct") == "γ³ Oct"
    assert bayer_designation("Ome", "Cen") == "ω Cen"
    assert bayer_designation("p", "Eri") == "p Eri"


def test_hipparcos_parquet_columns(built_caches: CachePaths) -> None:
    frame = pd.read_parquet(built_caches.hipparcos_parquet)
    assert frame.columns.tolist() == [
        "hip",
        "ra_degrees",
        "dec_degrees",
        "ra_mas_per_year",
        "dec_mas_per_year",
        "parallax_mas",
        "magnitude",
        "bv_millimag",
        "epoch_year",
    ]
    assert frame["hip"].is_unique
    assert frame["hip"].is_monotonic_increasing
    assert (frame["epoch_year"] == 1991.25).all()
    assert frame["bv_millimag"].dtype == np.int16


# --- deep-sky objects --------------------------------------------------------------------------


def dso_entries(caches: CachePaths) -> dict[str, DsoEntry]:
    entries = [
        DsoEntry.model_validate(item)
        for item in json.loads(caches.dso_json.read_text(encoding="utf-8"))
    ]
    return {entry.id: entry for entry in entries}


def test_dso_subset_keeps_every_messier_and_drops_dup_nonex(built_caches: CachePaths) -> None:
    by_id = dso_entries(built_caches)
    messier = {entry.messier for entry in by_id.values() if entry.messier is not None}
    assert messier == set(range(1, 111)) - {102}
    assert "IC11" not in by_id  # Dup of NGC0281
    assert "IC67" not in by_id  # NonEx
    assert "M102" not in by_id  # Dup row named M102
    assert by_id["NGC5457"].messier == 101
    assert "M102" in by_id["NGC5457"].names


def test_dso_messier_alias_resolves_in_state(catalog_state: CatalogState) -> None:
    assert catalog_state.dso.messier[102].id == "NGC5457"
    assert catalog_state.dso.messier[101].id == "NGC5457"
    assert catalog_state.dso.messier[31].id == "NGC224"
    assert catalog_state.dso.messier[45].id == "Mel22"
    assert catalog_state.dso.messier[40].id == "M40"
    assert len(catalog_state.dso.messier) == 110


def test_dso_id_normalisation() -> None:
    assert normalize_dso_id("NGC0224") == "NGC224"
    assert normalize_dso_id("IC0434") == "IC434"
    assert normalize_dso_id("Mel022") == "Mel22"
    assert normalize_dso_id("NGC7318A") == "NGC7318A"
    assert normalize_dso_id("IC0080 NED01") == "IC80_NED01"
    assert normalize_dso_id("ESO056-115") == "ESO56-115"
    assert normalize_dso_id("M040") == "M40"
    assert normalize_dso_id("B033") == "B33"


def test_dso_fields_and_type_map(built_caches: CachePaths) -> None:
    by_id = dso_entries(built_caches)
    andromeda = by_id["NGC224"]
    assert andromeda.type == "galaxy"
    assert andromeda.messier == 31
    assert andromeda.ra_deg == pytest.approx(10.68479, abs=1e-4)
    assert andromeda.dec_deg == pytest.approx(41.26906, abs=1e-4)
    assert "Andromeda Galaxy" in andromeda.names
    assert by_id["Mel22"].type == "open_cluster"
    assert by_id["Mel22"].messier == 45
    assert by_id["NGC6205"].type == "globular_cluster"  # M13
    assert by_id["NGC6720"].type == "planetary_nebula"  # M57
    assert by_id["NGC1976"].type == "nebula"  # M42
    assert by_id["M40"].type == "other"  # double star
    assert by_id["B33"].type == "other"  # dark nebula, kept by the 6' major axis
    assert by_id["NGC7318A"].type == "galaxy"
    assert by_id["NGC7318A"].mag == 13.39
    assert by_id["NGC7000"].names == ["North America Nebula"]
    assert by_id["NGC7000"].mag == 4.0
    assert by_id["NGC7000"].major_arcmin == 120.0
    assert by_id["NGC5904"].con == "Ser"  # M5, OpenNGC `Se1`
    assert by_id["NGC6611"].con == "Ser"  # M16, OpenNGC `Se2`
    assert by_id["NGC5457"].mag == 7.9  # V-Mag preferred over B-Mag 8.36
    assert all(0.0 <= entry.ra_deg < 360.0 for entry in by_id.values())


def test_dso_negative_declination_and_thresholds(excerpts_dir: Path) -> None:
    rows = pd.concat(
        [
            read_openngc(excerpts_dir / "NGC_excerpt.csv"),
            read_openngc(excerpts_dir / "addendum_excerpt.csv"),
        ],
        ignore_index=True,
    )
    ic3_row = rows[rows["Name"] == "IC0003"].iloc[0]
    assert ic3_row["Dec"] == "-00:24:54.8"
    assert ic3_row["dec_deg"] == pytest.approx(-0.415222, abs=1e-6)

    default, aliases = build_dso_entries(rows, mag_limit=14.0, size_arcmin=5.0)
    ids = {entry.id for entry in default}
    assert aliases == {102: "NGC5457"}
    assert "IC3" not in ids  # B 14.78, 0.93'
    assert "NGC7318A" in ids
    assert "B33" in ids

    faint, _ = build_dso_entries(rows, mag_limit=15.0, size_arcmin=5.0)
    ic3 = next(entry for entry in faint if entry.id == "IC3")
    assert ic3.dec_deg < 0.0
    assert ic3.dec_deg == pytest.approx(-0.415222, abs=1e-6)
    assert ic3.mag == 14.78
    assert ic3.con == "Psc"

    strict, _ = build_dso_entries(rows, mag_limit=13.0, size_arcmin=10.0)
    strict_ids = {entry.id for entry in strict}
    assert "NGC7318A" not in strict_ids
    assert "B33" not in strict_ids
    assert {entry.messier for entry in strict if entry.messier} == set(range(1, 111)) - {102}


def test_dso_meta(excerpts_dir: Path, tmp_path: Path) -> None:
    result = build_dso(
        excerpts_dir / "NGC_excerpt.csv",
        excerpts_dir / "addendum_excerpt.csv",
        CachePaths(tmp_path),
        mag_limit=12.5,
        size_arcmin=8.0,
    )
    (artifact,) = result.artifacts
    assert artifact.name == "dso"
    assert artifact.source_keys == ("ngc", "ngc_addendum")
    assert dict(artifact.meta) == {
        "mag_limit": 12.5,
        "size_arcmin": 8.0,
        "messier_aliases": 1,
        "count": artifact.count,
    }
    assert artifact.sha256 == hashlib.sha256(artifact.path.read_bytes()).hexdigest()
    assert artifact.version.startswith("1-")


# --- constellations ----------------------------------------------------------------------------


def test_constellations_json(built_caches: CachePaths, catalog_state: CatalogState) -> None:
    response = ConstellationsResponse.model_validate_json(
        built_caches.constellations_json.read_bytes()
    )
    assert response.culture == "modern"
    by_abbr = {entry.abbr: entry for entry in response.constellations}
    assert sorted(by_abbr) == ["Cas", "Cru", "Ori", "Ser", "UMa", "UMi"]

    orion = by_abbr["Ori"]
    assert (orion.latin, orion.genitive) == ("Orion", "Orionis")
    skys_hips = set(catalog_state.stars.hip.tolist())
    assert {hip for segment in orion.lines for hip in segment} <= skys_hips
    assert (27989, 26727) in orion.lines or (26727, 27989) in orion.lines  # Betelgeuse-Alnitak
    assert 70.0 < orion.label.ra_deg < 95.0
    assert -10.0 < orion.label.dec_deg < 20.0

    serpens = by_abbr["Ser"]
    assert serpens.boundary_parts is not None
    assert len(serpens.boundary_parts) == 2
    assert serpens.boundary == serpens.boundary_parts[0]
    assert by_abbr["UMa"].boundary_parts is None

    for entry in response.constellations:
        rings = entry.boundary_parts or [entry.boundary]
        for ring in rings:
            assert ring[0] == ring[-1]
            assert len(ring) >= 4
            assert all(0.0 <= ra < 360.0 and -90.0 <= dec <= 90.0 for ra, dec in ring)


def test_constellation_names_csv_has_88_rows() -> None:
    names = read_constellation_names(CONSTELLATION_NAMES_CSV)
    assert len(names) == 88
    assert names["Ser"].latin == "Serpens"
    assert names["Ser"].genitive == "Serpentis"
    assert names["UMa"].genitive == "Ursae Majoris"
    assert names["Boo"].latin == "Boötes"
    assert all(len(abbr) == 3 for abbr in names)


def test_stellarium_license_check(
    tmp_path: Path, excerpts_dir: Path, built_caches: CachePaths
) -> None:
    good = write_description_md(tmp_path)
    assert check_stellarium_license(good) == "CC BY-SA 4.0"

    tampered = tmp_path / "tampered.md"
    tampered.write_text("## License\n\nText and data: CC BY-NC 4.0\n", encoding="utf-8")
    with pytest.raises(LicenseChangedError, match=r"no longer declares CC BY-SA 4\.0"):
        check_stellarium_license(tampered)
    with pytest.raises(LicenseChangedError):
        build_constellations(
            excerpts_dir / "stellarium_modern_excerpt.json",
            tampered,
            excerpts_dir / "constellations_bounds_excerpt.json",
            CONSTELLATION_NAMES_CSV,
            built_caches.hipparcos_parquet,
            CachePaths(tmp_path / "cache"),
        )

    missing = tmp_path / "missing.md"
    missing.write_text("# Modern\n\n## Authors\n\nStellarium's team\n", encoding="utf-8")
    with pytest.raises(LicenseChangedError, match="no `## License` section"):
        check_stellarium_license(missing)


def test_constellations_artifact(
    excerpts_dir: Path, built_caches: CachePaths, tmp_path: Path
) -> None:
    result = build_constellations(
        excerpts_dir / "stellarium_modern_excerpt.json",
        write_description_md(tmp_path),
        excerpts_dir / "constellations_bounds_excerpt.json",
        CONSTELLATION_NAMES_CSV,
        built_caches.hipparcos_parquet,
        CachePaths(tmp_path / "cache"),
    )
    (artifact,) = result.artifacts
    assert artifact.name == "constellations"
    assert artifact.count == 6
    assert artifact.declared_license == "CC BY-SA 4.0"
    assert artifact.source_keys == (
        "stellarium_modern",
        "stellarium_description",
        "d3_bounds",
        "constellation_names",
    )
    assert dict(artifact.meta) == {"culture": "modern", "count": 6}


# --- determinism -------------------------------------------------------------------------------


def test_building_twice_is_byte_identical(built_caches: CachePaths, tmp_path: Path) -> None:
    again = build_excerpt_caches(tmp_path / "cache")
    for name in (
        "stars_skys",
        "stars_index",
        "hipparcos_parquet",
        "dso_json",
        "constellations_json",
    ):
        first: Path = getattr(built_caches, name)
        second: Path = getattr(again, name)
        assert first.read_bytes() == second.read_bytes(), name


def test_stars_artifacts(excerpts_dir: Path, tmp_path: Path) -> None:
    result = build_stars(
        excerpts_dir / "hip_main_excerpt.dat",
        excerpts_dir / "hyg_v44_excerpt.csv",
        CachePaths(tmp_path),
    )
    names = [artifact.name for artifact in result.artifacts]
    assert names == ["stars", "stars_index", "hipparcos"]
    stars, index, hipparcos = result.artifacts
    assert stars.meta["epoch_tt"] == J2000_TT
    assert stars.meta["magnitude_limit"] == 11.01  # Proxima is the faintest excerpt star
    assert stars.count == stars.meta["count"] == hipparcos.count
    assert index.count < stars.count
    assert len({artifact.version for artifact in result.artifacts}) == 1
    for artifact in result.artifacts:
        assert artifact.source_keys == ("hipparcos", "hyg")
        assert artifact.bytes == artifact.path.stat().st_size
        assert artifact.sha256 == hashlib.sha256(artifact.path.read_bytes()).hexdigest()


# --- readers, builders and state: error paths -------------------------------------------------


def test_read_hyg_accepts_gzip_and_plain(excerpts_dir: Path, tmp_path: Path) -> None:
    plain = read_hyg(excerpts_dir / "hyg_v44_excerpt.csv")
    gzipped = tmp_path / "hyg.csv.gz"
    gzipped.write_bytes(gzip.compress((excerpts_dir / "hyg_v44_excerpt.csv").read_bytes()))
    assert read_hyg(gzipped).equals(plain)
    assert plain["hip"].dtype == np.int64
    assert "" not in set(plain["hip"].astype(str))


def test_openngc_reader_errors_and_blank_coordinates(tmp_path: Path) -> None:
    bad = tmp_path / "bad.csv"
    bad.write_text("# Source: test\nName;Type;RA\nNGC0001;G;00:07:15.84\n", encoding="utf-8")
    with pytest.raises(SourceFormatError, match="missing OpenNGC columns"):
        read_openngc(bad)
    assert math.isnan(parse_ra_hms(""))
    assert math.isnan(parse_dec_dms("  "))
    assert parse_ra_hms("12:00:00.00") == 180.0
    assert parse_ra_hms("24:00:00") == 0.0
    assert parse_dec_dms("-00:30:00") == -0.5
    assert parse_dec_dms("+00:30:00") == 0.5


def test_json_reader_errors(tmp_path: Path) -> None:
    array = tmp_path / "array.json"
    array.write_text("[1, 2]", encoding="utf-8")
    with pytest.raises(SourceFormatError, match="JSON object"):
        read_stellarium_json(array)
    no_constellations = tmp_path / "empty.json"
    no_constellations.write_text('{"_provenance": {}, "id": "modern"}', encoding="utf-8")
    with pytest.raises(SourceFormatError, match="constellations"):
        read_stellarium_json(no_constellations)
    with pytest.raises(SourceFormatError, match="FeatureCollection"):
        read_bounds_json(no_constellations)


def test_constellation_names_reader_errors(tmp_path: Path) -> None:
    malformed = tmp_path / "names.csv"
    malformed.write_text(
        "abbr,latin,genitive,english\nOrion,Orion,Orionis,Hunter\n", encoding="utf-8"
    )
    with pytest.raises(SourceFormatError, match="malformed row"):
        read_constellation_names(malformed)
    duplicate = tmp_path / "dup.csv"
    duplicate.write_text(
        "abbr,latin,genitive,english\nOri,Orion,Orionis,Hunter\nOri,Orion,Orionis,Hunter\n",
        encoding="utf-8",
    )
    with pytest.raises(SourceFormatError, match="duplicate abbreviation"):
        read_constellation_names(duplicate)


def openngc_frame(*rows: str) -> pd.DataFrame:
    header = (
        "Name;Type;RA;Dec;Const;MajAx;MinAx;PosAng;B-Mag;V-Mag;J-Mag;H-Mag;K-Mag;SurfBr;Hubble;"
        "Pax;Pm-RA;Pm-Dec;RadVel;Redshift;Cstar U-Mag;Cstar B-Mag;Cstar V-Mag;M;NGC;IC;"
        "Cstar Names;Identifiers;Common names;NED notes;OpenNGC notes;Sources"
    )
    text = "\n".join([header, *rows]) + "\n"
    path = Path(tempfile.mkdtemp()) / "rows.csv"
    path.write_text(text, encoding="utf-8")
    return read_openngc(path)


def row(name: str, kind: str, *, messier: str = "", ngc: str = "", vmag: str = "9.0") -> str:
    fields = [""] * 32
    fields[0], fields[1], fields[2], fields[3], fields[4] = (
        name,
        kind,
        "01:00:00.0",
        "+10:00:00",
        "And",
    )
    fields[9], fields[23], fields[24] = vmag, messier, ngc
    return ";".join(fields)


def test_dso_builder_errors() -> None:
    with pytest.raises(BuildError, match="unexpected OpenNGC name"):
        normalize_dso_id("???")
    with pytest.raises(BuildError, match="unknown OpenNGC type"):
        build_dso_entries(openngc_frame(row("NGC0001", "Quasar")), mag_limit=14.0, size_arcmin=5.0)
    with pytest.raises(BuildError, match="claimed twice"):
        build_dso_entries(
            openngc_frame(row("NGC0001", "G", messier="001"), row("NGC0002", "G", messier="001")),
            mag_limit=14.0,
            size_arcmin=5.0,
        )
    with pytest.raises(BuildError, match="no master object"):
        build_dso_entries(
            openngc_frame(row("NGC0001", "G", messier="001"), row("M102", "Dup", messier="077")),
            mag_limit=14.0,
            size_arcmin=5.0,
        )
    entries, aliases = build_dso_entries(
        openngc_frame(row("NGC0001", "G", messier="001"), row("IC0005", "Dup", ngc="0001")),
        mag_limit=14.0,
        size_arcmin=5.0,
    )
    assert [entry.id for entry in entries] == ["NGC1"]
    assert aliases == {}


def test_build_dso_rejects_duplicate_ids(tmp_path: Path) -> None:
    ngc = tmp_path / "NGC.csv"
    columns = list(read_openngc(EXCERPTS_DIR / "addendum_excerpt.csv").columns)
    columns = [column for column in columns if column not in ("ra_deg", "dec_deg")]
    lines = [";".join(columns), row("NGC0001", "G"), row("NGC001", "G")]
    ngc.write_text("\n".join(lines) + "\n", encoding="utf-8")
    addendum = tmp_path / "addendum.csv"
    addendum.write_text(";".join(columns) + "\n", encoding="utf-8")
    with pytest.raises(BuildError, match="duplicate DSO ids"):
        build_dso(ngc, addendum, CachePaths(tmp_path / "cache"))


def test_boundary_helpers() -> None:
    assert normalize_ring([[-10.0, 1.0], [10.0, 1.0], [10.0, 2.0]]) == [
        (350.0, 1.0),
        (10.0, 1.0),
        (10.0, 2.0),
        (350.0, 1.0),
    ]
    with pytest.raises(BuildError, match="at least three"):
        normalize_ring([[0.0, 0.0], [1.0, 1.0]])
    with pytest.raises(BuildError, match="expected a Polygon"):
        boundaries_by_abbr(
            {
                "type": "FeatureCollection",
                "features": [
                    {"id": "Ori", "geometry": {"type": "Point", "coordinates": [1.0, 2.0]}}
                ],
            }
        )


def test_constellation_builder_errors_and_label_fallback(
    excerpts_dir: Path, built_caches: CachePaths, tmp_path: Path
) -> None:
    description = write_description_md(tmp_path)
    names_without_orion = tmp_path / "names.csv"
    names_without_orion.write_text(
        "".join(
            line + "\n"
            for line in CONSTELLATION_NAMES_CSV.read_text(encoding="utf-8").splitlines()
            if not line.startswith("Ori,")
        ),
        encoding="utf-8",
    )
    with pytest.raises(BuildError, match=r"'Ori' missing from names\.csv"):
        build_constellations(
            excerpts_dir / "stellarium_modern_excerpt.json",
            description,
            excerpts_dir / "constellations_bounds_excerpt.json",
            names_without_orion,
            built_caches.hipparcos_parquet,
            CachePaths(tmp_path / "cache"),
        )

    bounds = json.loads((excerpts_dir / "constellations_bounds_excerpt.json").read_text("utf-8"))
    bounds["features"] = [feature for feature in bounds["features"] if feature["id"] != "Cru"]
    bounds_without_crux = tmp_path / "bounds.json"
    bounds_without_crux.write_text(json.dumps(bounds), encoding="utf-8")
    with pytest.raises(BuildError, match=r"'Cru' missing from bounds\.json"):
        build_constellations(
            excerpts_dir / "stellarium_modern_excerpt.json",
            description,
            bounds_without_crux,
            CONSTELLATION_NAMES_CSV,
            built_caches.hipparcos_parquet,
            CachePaths(tmp_path / "cache"),
        )

    # No line star in the parquet: the label falls back to the boundary centroid.
    empty_parquet = tmp_path / "empty.parquet"
    pd.read_parquet(built_caches.hipparcos_parquet).iloc[:0].to_parquet(empty_parquet, index=False)
    result = build_constellations(
        excerpts_dir / "stellarium_modern_excerpt.json",
        description,
        excerpts_dir / "constellations_bounds_excerpt.json",
        CONSTELLATION_NAMES_CSV,
        empty_parquet,
        CachePaths(tmp_path / "fallback"),
    )
    response = ConstellationsResponse.model_validate_json(result.artifacts[0].path.read_bytes())
    orion = next(entry for entry in response.constellations if entry.abbr == "Ori")
    assert 70.0 < orion.label.ra_deg < 97.0
    assert -11.0 < orion.label.dec_deg < 23.0
    polaris_side = next(entry for entry in response.constellations if entry.abbr == "UMi")
    assert polaris_side.label.dec_deg > 65.0


def test_load_catalog_state_errors_and_manifest(built_caches: CachePaths, tmp_path: Path) -> None:
    empty = CachePaths(tmp_path / "empty")
    with pytest.raises(CatalogStateError, match=r"stars\.skys"):
        load_catalog_state(empty)

    copy = CachePaths(tmp_path / "copy")
    copy.root.mkdir()
    for name in (
        "stars_skys",
        "stars_index",
        "hipparcos_parquet",
        "dso_json",
        "constellations_json",
    ):
        source: Path = getattr(built_caches, name)
        target: Path = getattr(copy, name)
        target.write_bytes(source.read_bytes())
    manifest = {
        "cache_format_version": 1,
        "artifacts": {
            "stars": {"sha256": "ab" * 32, "version": "1-deadbeef0000", "meta": {}},
            "constellations": {
                "sha256": "cd" * 32,
                "version": "1-deadbeef0001",
                "declared_license": "CC BY-SA 4.0",
            },
        },
    }
    copy.manifest.write_text(json.dumps(manifest), encoding="utf-8")
    state = load_catalog_state(copy)
    assert state.identities["stars"] == ArtifactIdentity("ab" * 32, "1-deadbeef0000", None)
    assert state.identities["constellations"].declared_license == "CC BY-SA 4.0"
    assert "hip" not in state.hipparcos.columns
    assert state.hipparcos.index.name == "hip"
    assert "ra_hours" in state.hipparcos.columns

    copy.manifest.write_text("[]", encoding="utf-8")
    with pytest.raises(CatalogStateError, match="JSON object"):
        load_catalog_state(copy)
    copy.manifest.write_text('{"artifacts": []}', encoding="utf-8")
    with pytest.raises(CatalogStateError, match="artifacts"):
        load_catalog_state(copy)
    copy.manifest.write_text('{"artifacts": {"stars": 1}}', encoding="utf-8")
    with pytest.raises(CatalogStateError, match="must be an object"):
        load_catalog_state(copy)
    copy.manifest.unlink()

    unsorted = read_skys(copy.stars_skys.read_bytes())
    swapped = StarTable(
        unsorted.dir,
        unsorted.pm,
        unsorted.mag[::-1].copy(),
        unsorted.bv,
        unsorted.hip,
        unsorted.epoch_tt,
    )
    copy.stars_skys.write_bytes(hand_packed_skys(swapped))
    with pytest.raises(CatalogStateError, match="not sorted"):
        load_catalog_state(copy)

    frame = pd.read_parquet(built_caches.hipparcos_parquet)
    pd.concat([frame, frame.iloc[:1]]).to_parquet(copy.hipparcos_parquet, index=False)
    with pytest.raises(CatalogStateError, match="duplicate HIP"):
        load_hipparcos_table(copy.hipparcos_parquet)

    entries = list(dso_entries(built_caches).values())
    with pytest.raises(CatalogStateError, match="duplicate DSO id"):
        build_dso_catalog([entries[0], entries[0]])


def hand_packed_skys(table: StarTable) -> bytes:
    """Serialise without the sort check, to exercise the loader's own guard."""
    header = struct.pack("<4sIIdI", b"SKYS", 1, table.count, table.epoch_tt, 0)
    return header + b"".join(
        [
            table.dir.tobytes(),
            table.pm.tobytes(),
            table.mag.tobytes(),
            table.bv.tobytes(),
            table.hip.tobytes(),
        ]
    )


def test_constellations_reject_duplicate_stellarium_ids(
    excerpts_dir: Path, built_caches: CachePaths, tmp_path: Path
) -> None:
    index = json.loads((excerpts_dir / "stellarium_modern_excerpt.json").read_text("utf-8"))
    orion = next(c for c in index["constellations"] if c["id"].endswith(" Ori"))
    index["constellations"].append(dict(orion))
    duplicated = tmp_path / "index.json"
    duplicated.write_text(json.dumps(index), encoding="utf-8")
    with pytest.raises(SourceFormatError, match="duplicate constellation ids"):
        build_constellations(
            duplicated,
            write_description_md(tmp_path),
            excerpts_dir / "constellations_bounds_excerpt.json",
            CONSTELLATION_NAMES_CSV,
            built_caches.hipparcos_parquet,
            CachePaths(tmp_path / "cache"),
        )
