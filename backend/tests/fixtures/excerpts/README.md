# Test excerpts

Small cuts of the third-party data files that `sky-data fetch` downloads, committed so the
catalog builders can be tested without network access (brief l.325, decision D40). Every file
is under 1 MB and starts with an in-file provenance header: `#` lines (`Source`, `License`,
`Fetched`, `Excerpt`) for the text formats, which the readers in `skyapi/catalogs/readers.py`
strip before handing the bytes to Skyfield or pandas, and a top-level `_provenance` object for
the two JSON files, which `parse_constellations_json` and our GeoJSON reader ignore. Each file
also has an `[[excerpts]]` entry in `skyapi/data/data_files.toml`, so it appears in
`THIRD_PARTY_NOTICES.md`.

All excerpts were cut on 2026-09-03 from the files fetched that day by a one-off script kept
outside the repository; the cutting rules are described below so they can be reproduced.

| File | Source | License | How it was cut |
| --- | --- | --- | --- |
| `hip_main_excerpt.dat` | Hipparcos main catalogue, CDS/VizieR I/239 (`hip_main.dat`) | CDS/ESA, free with citation ("The Hipparcos and Tycho Catalogues, ESA SP-1200 (1997)") | The 1,000 brightest rows by `Vmag`, plus the test stars HIP 761 (κ¹ Scl), 11767 (Polaris), 26220 (a star whose `B-V` field is blank), 27989 (Betelgeuse), 32349 (Sirius), 70890 (Proxima), 87937 (Barnard's star), plus every HIP referenced by the Stellarium lines of the six excerpt constellations. Rows are the original pipe-separated records, byte for byte, in HIP order (1,012 rows; two of them, HIP 55203 and 78727, have no astrometric solution and exercise the "drop rows without a position" rule). |
| `hyg_v44_excerpt.csv` | HYG database v4.4, David Nash, astronexus.com (`hyg_v44.csv.gz`, gunzipped) | CC BY-SA 4.0 | The original header row plus every row whose `hip` is in the Hipparcos excerpt (1,010 rows), lines kept verbatim. |
| `NGC_excerpt.csv` | OpenNGC `database_files/NGC.csv`, Mattia Verga | CC BY-SA 4.0 | Header plus every row with an `M` value (107 Messier masters), NGC7000, NGC0224, NGC7318A (letter suffix), IC0003 (a `-00:` declination), IC0011 (a `Dup` of NGC0281) and the first `NonEx` row (IC0067); lines kept verbatim. |
| `addendum_excerpt.csv` | OpenNGC `database_files/addendum.csv`, Mattia Verga | CC BY-SA 4.0 | Header plus every row with an `M` value (`M040`, the `M102` `Dup` row pointing at M101, `Mel022` = M45) and `B033` (Horsehead Nebula, a `DrkN` kept by the size rule); lines kept verbatim. |
| `stellarium_modern_excerpt.json` | Stellarium sky culture `modern`, `skycultures/modern/index.json` | CC BY-SA 4.0 (Text and data, as declared in the culture's `description.md`) | Top-level `id` and the `constellations` entries for Ori, UMa, Ser, Cru, Cas and UMi (the polar boundary case), each reduced to its original `id`, `lines` and `common_name`; the other top-level keys (asterisms, edges, common star names) are dropped. |
| `constellations_bounds_excerpt.json` | d3-celestial `data/constellations.bounds.json`, Olaf Frohn (after Davenhall & Leggett 1990) | BSD-3-Clause | The GeoJSON `FeatureCollection` reduced to the features whose `id` is Ori, UMa, Ser, Cru, Cas or UMi; Ser appears twice (Caput and Cauda), so seven features; features unchanged. |
| `MPCORB_excerpt.dat` | Minor Planet Center `MPCORB.DAT.gz` (data.minorplanetcenter.net), inflated | free, attribution requested ("Orbital elements: IAU Minor Planet Center") | The four `#` provenance lines precede the real 43-line MPC header (the builder never counts lines: it skips `#` lines, then everything through the first line of 100 or more dashes). Then, verbatim 202-character records: 9 numbered objects chosen to cover every packed-number form ((1) Ceres, (2) Pallas, (4) Vesta, (433) Eros, (99942) Apophis, (100001) `A0001`, (134340) `D4340` Pluto, (620000) `~0000` and the last numbered object, `~` with letters), a blank separator, the first 5 unnumbered multi-opposition rows plus the first 5 whose designation starts with `2024 `, a blank separator, and the first 5 one-opposition rows (5 distinct epochs). |
| `CometEls_excerpt.txt` | Minor Planet Center `CometEls.txt` | free, attribution requested ("Orbital elements: IAU Minor Planet Center") | Four `#` provenance lines (filtered out before `load_comets_dataframe_slow`, which decodes ASCII) then 20 rows in file order: 1P/Halley, 2P/Encke, C/1995 O1 (Hale-Bopp), C/2023 A3 (Tsuchinshan-ATLAS), both orbit solutions of P/2021 N1 (ZTF) (the only duplicated designation in the 958-row file, used by the deduplication test), the numbered fragments 3D-A and 332P-B, the interstellar 1I/`Oumuamua, the nameless A/2018 W3, the unnumbered fragment C/1947 X1-B, one row without a perturbed epoch (perihelion-time fallback) and the first remaining P/ and C/ comets. |

The Stellarium `description.md` has no excerpt: the builder only reads its `## License`
section, and the test suite writes a three-line stand-in (`tests/support/fixtures_catalogs.py`).
