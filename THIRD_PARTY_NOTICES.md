# Third-party notices

This file is generated from the data registry (`backend/src/skyapi/data/data_files.toml`) by `python -m skyapi.tools.render_notices` (`make notices`); never edit it by hand. As required by `docs/brief.xml` l.326, it lists every dataset InterSidera downloads at bootstrap, ships inside its dependencies or uses at run time, with its source URL, version or date, license and attribution text. The application code itself is under the MIT license (`LICENSE`). Catalogs derived from share-alike sources are served under the same license as their source, declared by the API in `/meta.catalogs.<name>.license` and rendered on the About screen.

## de440s.bsp (`de440s`)

- Kind: download (downloaded by `sky-data fetch` into `DATA_DIR`)
- Source: <https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de440s.bsp>
- Fallback sources: <https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp>
- Version or date: DE440 (2020), short-span file
- License: Public domain (US Government work)
- Copyright: US Government work (NASA/JPL-Caltech), not subject to copyright
- Attribution: Planetary and lunar ephemerides: JPL DE440 (Park et al. 2021)
- Notes: Development and CI ephemeris (`SKYAPI_EPHEMERIS=de440s.bsp`): coverage 1849..2150 TT; opened with Skyfield `SpiceKernel`.

## de440.bsp (`de440`)

- Kind: download (downloaded by `sky-data fetch` into `DATA_DIR`)
- Source: <https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de440.bsp>
- Fallback sources: <https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440.bsp>
- Version or date: DE440 (2020)
- License: Public domain (US Government work)
- Copyright: US Government work (NASA/JPL-Caltech), not subject to copyright
- Attribution: Planetary and lunar ephemerides: JPL DE440 (Park et al. 2021)
- Notes: Middle tier not named by the brief: coverage 1550..2650, exactly the Moon orientation kernel range; fetched only with `--only de440` or `SKYAPI_EPHEMERIS=de440.bsp`.

## de441.bsp (`de441`)

- Kind: download (downloaded by `sky-data fetch` into `DATA_DIR`)
- Source: <https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de441.bsp>
- Fallback sources: <https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de441.bsp>
- Version or date: DE441 (2020)
- License: Public domain (US Government work)
- Copyright: US Government work (NASA/JPL-Caltech), not subject to copyright
- Attribution: Planetary and lunar ephemerides: JPL DE441 (Park et al. 2021)
- Notes: Production ephemeris (code default of `SKYAPI_EPHEMERIS`): coverage -13200..+17191; two segments per target (Skyfield >= 1.51); memory-mapped, never read into memory; fetched by `sky-data fetch --full` or when it is the configured ephemeris.

## pck00011.tpc (`pck00011`)

- Kind: download (downloaded by `sky-data fetch` into `DATA_DIR`)
- Source: <https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc>
- Version or date: pck00011.tpc (NAIF, 2022-12-27)
- License: Public domain (US Government work)
- Copyright: US Government work (NASA/JPL NAIF), not subject to copyright
- Attribution: SPICE generic kernels, NAIF/JPL
- Notes: Planetary constants and IAU rotation models (Archinal et al. 2018); read with `PlanetaryConstants.read_text`; radii and rotation models for the non-Earth observers. Do not confuse with `pck00011_n0066.tpc`.

## pck00010.tpc (`pck00010`)

- Kind: download (downloaded by `sky-data fetch` into `DATA_DIR`)
- Source: <https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00010.tpc>
- Version or date: pck00010.tpc (NAIF, 2011-10-21)
- License: Public domain (US Government work)
- Copyright: US Government work (NASA/JPL NAIF), not subject to copyright
- Attribution: SPICE generic kernels, NAIF/JPL
- Notes: Fallback planetary constants kernel named by brief l.306 in case pck00011.tpc fails to parse (no known failure); fetched only with `--only pck00010`.

## moon_de440_250416.tf (`moon_tf`)

- Kind: download (downloaded by `sky-data fetch` into `DATA_DIR`)
- Source: <https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_de440_250416.tf>
- Version or date: moon_de440_250416.tf (NAIF, 2025-04-16)
- License: Public domain (US Government work)
- Copyright: US Government work (NASA/JPL NAIF), not subject to copyright
- Attribution: SPICE generic kernels, NAIF/JPL
- Notes: Lunar frame kernel defining `MOON_ME_DE440_ME421`; supersedes the brief's `pck/moon_de440_220930.tf` (archived under `fk/satellites/a_old_versions/`). NAIF renames this file when it revises it: update `url`, `filename`, `size_bytes` and `sha256` here, then run `sky-data update`.

## moon_pa_de440_200625.bpc (`moon_bpc`)

- Kind: download (downloaded by `sky-data fetch` into `DATA_DIR`)
- Source: <https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/moon_pa_de440_200625.bpc>
- Version or date: moon_pa_de440_200625.bpc (NAIF, 2020-06-25)
- License: Public domain (US Government work)
- Copyright: US Government work (NASA/JPL NAIF), not subject to copyright
- Attribution: SPICE generic kernels, NAIF/JPL
- Notes: Binary PCK with the Moon principal-axis orientation, coverage 1549-12-31..2650-01-25 TDB, two segments for body 31008 split at 2426-02-16 (Skyfield #952 keeps only the last one: the loader selects the segment by date). The brief's ~70 MB is wrong.

## hip_main.dat (`hipparcos`)

- Kind: download (downloaded by `sky-data fetch` into `DATA_DIR`)
- Source: <https://cdsarc.cds.unistra.fr/ftp/cats/I/239/hip_main.dat>
- Fallback sources: <https://cdsarc.u-strasbg.fr/ftp/cats/I/239/hip_main.dat>
- Version or date: VizieR I/239 hip_main.dat (ESA SP-1200, 1997)
- License: CDS/ESA, free with citation
- Copyright: ESA 1997; distributed by CDS, Strasbourg (VizieR I/239)
- Attribution: The Hipparcos and Tycho Catalogues, ESA SP-1200 (1997), via CDS/VizieR
- Notes: Uncompressed pipe-separated main catalogue (the value of `skyfield.data.hipparcos.URL`); Skyfield's source warns that the URL is unstable, hence the pin and the VizieR mirror fallback. Rows without a position are dropped; `B-V` (field H37) is read by our own reader.

## hyg_v44.csv.gz (`hyg`)

- Kind: download (downloaded by `sky-data fetch` into `DATA_DIR`)
- Source: <https://codeberg.org/astronexus/hyg/media/branch/main/data/hyg/CURRENT/hyg_v44.csv.gz>
- Version or date: HYG v4.4 (2026)
- License: CC-BY-SA-4.0
- Copyright: David Nash, astronexus.com
- Attribution: HYG database v4.4, David Nash, astronexus.com, CC BY-SA 4.0
- Notes: Kept compressed on disk (pandas infers gzip from the extension), so the pin is the `.gz` hash. Git LFS: the `/raw/branch/` URL returns a 133-byte pointer, hence the `/media/branch/` URL and `min_size_bytes`. Builds only the `stars/index` crosswalk (HIP -> proper, Bayer, Flamsteed, constellation), served under CC BY-SA 4.0.

License text (`backend/src/skyapi/data/licenses/CC-BY-SA-4.0-notice.txt`):

```text
Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)

License text: https://creativecommons.org/licenses/by-sa/4.0/
Legal code:   https://creativecommons.org/licenses/by-sa/4.0/legalcode

The InterSidera catalogs derived from CC BY-SA 4.0 sources (the stars name index built
from the HYG database, the deep-sky catalog built from OpenNGC, and the constellation
figures built from the Stellarium "modern" sky culture) are adapted from, and therefore
modified with respect to, the sources named in the notices above: rows are selected,
columns are renamed and re-encoded, identifiers are normalised and the data is repacked
into the cache formats served by the API. These derived catalogs are made available under
the same CC BY-SA 4.0 license, with the attribution text of each source declared by the
API (`/meta.catalogs.<name>.license` and `.attribution`) and rendered on the About screen.
The build scripts that produce them are public in this repository
(`backend/src/skyapi/catalogs/`), which satisfies the share-alike condition for the
transformation itself. No endorsement by the original authors is implied.
```

## NGC.csv (`ngc`)

- Kind: download (downloaded by `sky-data fetch` into `DATA_DIR`)
- Source: <https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/NGC.csv>
- Version or date: OpenNGC master branch (fetch date recorded in DATA_DIR/manifest.json)
- License: CC-BY-SA-4.0
- Copyright: Mattia Verga
- Attribution: OpenNGC, Mattia Verga, CC BY-SA 4.0
- Notes: Semicolon-separated; the subset keeps every Messier object plus objects with mag <= 14 or major axis >= 5 arcmin (`build-caches --dso-mag-limit --dso-size-arcmin`); the derived catalog is served under CC BY-SA 4.0.

License text (`backend/src/skyapi/data/licenses/CC-BY-SA-4.0-notice.txt`):

```text
Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)

License text: https://creativecommons.org/licenses/by-sa/4.0/
Legal code:   https://creativecommons.org/licenses/by-sa/4.0/legalcode

The InterSidera catalogs derived from CC BY-SA 4.0 sources (the stars name index built
from the HYG database, the deep-sky catalog built from OpenNGC, and the constellation
figures built from the Stellarium "modern" sky culture) are adapted from, and therefore
modified with respect to, the sources named in the notices above: rows are selected,
columns are renamed and re-encoded, identifiers are normalised and the data is repacked
into the cache formats served by the API. These derived catalogs are made available under
the same CC BY-SA 4.0 license, with the attribution text of each source declared by the
API (`/meta.catalogs.<name>.license` and `.attribution`) and rendered on the About screen.
The build scripts that produce them are public in this repository
(`backend/src/skyapi/catalogs/`), which satisfies the share-alike condition for the
transformation itself. No endorsement by the original authors is implied.
```

## addendum.csv (`ngc_addendum`)

- Kind: download (downloaded by `sky-data fetch` into `DATA_DIR`)
- Source: <https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/addendum.csv>
- Version or date: OpenNGC master branch (fetch date recorded in DATA_DIR/manifest.json)
- License: CC-BY-SA-4.0
- Copyright: Mattia Verga
- Attribution: OpenNGC, Mattia Verga, CC BY-SA 4.0
- Notes: Objects outside NGC/IC (M40, M45 as `Mel022`, Caldwell, Barnard...); the brief's `addendum/addendum.csv` path is a 404.

License text (`backend/src/skyapi/data/licenses/CC-BY-SA-4.0-notice.txt`):

```text
Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)

License text: https://creativecommons.org/licenses/by-sa/4.0/
Legal code:   https://creativecommons.org/licenses/by-sa/4.0/legalcode

The InterSidera catalogs derived from CC BY-SA 4.0 sources (the stars name index built
from the HYG database, the deep-sky catalog built from OpenNGC, and the constellation
figures built from the Stellarium "modern" sky culture) are adapted from, and therefore
modified with respect to, the sources named in the notices above: rows are selected,
columns are renamed and re-encoded, identifiers are normalised and the data is repacked
into the cache formats served by the API. These derived catalogs are made available under
the same CC BY-SA 4.0 license, with the attribution text of each source declared by the
API (`/meta.catalogs.<name>.license` and `.attribution`) and rendered on the About screen.
The build scripts that produce them are public in this repository
(`backend/src/skyapi/catalogs/`), which satisfies the share-alike condition for the
transformation itself. No endorsement by the original authors is implied.
```

## stellarium_modern_index.json (`stellarium_modern`)

- Kind: download (downloaded by `sky-data fetch` into `DATA_DIR`)
- Source: <https://raw.githubusercontent.com/Stellarium/stellarium/master/skycultures/modern/index.json>
- Version or date: Stellarium master branch, sky culture `modern` (fetch date recorded in DATA_DIR/manifest.json)
- License: CC-BY-SA-4.0
- Copyright: Stellarium contributors
- Attribution: Constellation figures: Stellarium 'modern' sky culture, CC BY-SA 4.0
- Notes: Parsed with `skyfield.data.stellarium.parse_constellations_json` (Skyfield >= 1.55). The license is declared in the culture's description.md, not in this file (see `stellarium_description`). `modern`, not `modern_st`: the brief names `modern`.

License text (`backend/src/skyapi/data/licenses/CC-BY-SA-4.0-notice.txt`):

```text
Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)

License text: https://creativecommons.org/licenses/by-sa/4.0/
Legal code:   https://creativecommons.org/licenses/by-sa/4.0/legalcode

The InterSidera catalogs derived from CC BY-SA 4.0 sources (the stars name index built
from the HYG database, the deep-sky catalog built from OpenNGC, and the constellation
figures built from the Stellarium "modern" sky culture) are adapted from, and therefore
modified with respect to, the sources named in the notices above: rows are selected,
columns are renamed and re-encoded, identifiers are normalised and the data is repacked
into the cache formats served by the API. These derived catalogs are made available under
the same CC BY-SA 4.0 license, with the attribution text of each source declared by the
API (`/meta.catalogs.<name>.license` and `.attribution`) and rendered on the About screen.
The build scripts that produce them are public in this repository
(`backend/src/skyapi/catalogs/`), which satisfies the share-alike condition for the
transformation itself. No endorsement by the original authors is implied.
```

## stellarium_modern_description.md (`stellarium_description`)

- Kind: download (downloaded by `sky-data fetch` into `DATA_DIR`)
- Source: <https://raw.githubusercontent.com/Stellarium/stellarium/master/skycultures/modern/description.md>
- Version or date: Stellarium master branch, sky culture `modern` (fetch date recorded in DATA_DIR/manifest.json)
- License: CC-BY-SA-4.0
- Copyright: Stellarium contributors
- Attribution: Constellation figures: Stellarium 'modern' sky culture, CC BY-SA 4.0
- Notes: Fetched so that `build-caches` verifies the declared license at build time (its `## License` section must still read "Text and data: CC BY-SA 4.0", brief l.313) and records it as `declared_license` in cache/manifest.json. Illustrations (Free Art License) are not used.

License text (`backend/src/skyapi/data/licenses/CC-BY-SA-4.0-notice.txt`):

```text
Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)

License text: https://creativecommons.org/licenses/by-sa/4.0/
Legal code:   https://creativecommons.org/licenses/by-sa/4.0/legalcode

The InterSidera catalogs derived from CC BY-SA 4.0 sources (the stars name index built
from the HYG database, the deep-sky catalog built from OpenNGC, and the constellation
figures built from the Stellarium "modern" sky culture) are adapted from, and therefore
modified with respect to, the sources named in the notices above: rows are selected,
columns are renamed and re-encoded, identifiers are normalised and the data is repacked
into the cache formats served by the API. These derived catalogs are made available under
the same CC BY-SA 4.0 license, with the attribution text of each source declared by the
API (`/meta.catalogs.<name>.license` and `.attribution`) and rendered on the About screen.
The build scripts that produce them are public in this repository
(`backend/src/skyapi/catalogs/`), which satisfies the share-alike condition for the
transformation itself. No endorsement by the original authors is implied.
```

## constellations.bounds.json (`d3_bounds`)

- Kind: download (downloaded by `sky-data fetch` into `DATA_DIR`)
- Source: <https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.bounds.json>
- Version or date: d3-celestial master branch (fetch date recorded in DATA_DIR/manifest.json)
- License: BSD-3-Clause
- Copyright: Copyright (c) 2015, Olaf Frohn
- Attribution: Constellation boundaries: d3-celestial (Olaf Frohn), after Davenhall & Leggett 1990
- Notes: GeoJSON polygons in J2000, longitudes -180..180 normalised to 0..360 RA by the builder; `Ser` appears twice (Caput and Cauda). Alternative source: VizieR VI/49 `bound_20.dat`.

License text (`backend/src/skyapi/data/licenses/BSD-3-Clause-d3-celestial.txt`):

```text
Copyright (c) 2015, Olaf Frohn
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## constellation_names.csv (`constellation_names`)

- Kind: committed (factual data authored for this project and committed)
- Location: `backend/src/skyapi/data/constellation_names.csv`
- Version or date: authored 2026-09-03 from the IAU constellation list (archived at iauarchive.eso.org)
- License: Factual data, no license constraint
- Copyright: InterSidera authors (compiled factual data)
- Attribution: Constellation names and genitives after the IAU list of the 88 constellations
- Notes: Committed at backend/src/skyapi/data/constellation_names.csv (88 rows `abbr,latin,genitive,english`, brief l.314); cross-checked against d3-celestial `constellations.json`. Translated names live in the frontend resource files keyed by IAU abbreviation.

## MPCORB.DAT (`mpcorb`)

- Kind: download (downloaded by `sky-data fetch` into `DATA_DIR`)
- Source: <https://data.minorplanetcenter.net/iau/MPCORB/MPCORB.DAT.gz>
- Stored as: inflated gzip stream
- Version or date: MPCORB.DAT.gz, regenerated daily by the MPC (fetch date recorded in DATA_DIR/manifest.json)
- License: Free, attribution requested (IAU Minor Planet Center)
- Copyright: IAU Minor Planet Center
- Attribution: Orbital elements: IAU Minor Planet Center
- Notes: Downloaded as MPCORB.DAT.gz and inflated to MPCORB.DAT (Skyfield's `iokit` has no gzip support); the manifest records both the transfer hash and the on-disk hash. Format: https://data.minorplanetcenter.net/iau/info/MPOrbitFormat.html. `www.minorplanetcenter.net` (Skyfield's `MPCORB_URL`) is unreachable from some networks, hence the `data.` host.

## CometEls.txt (`comets`)

- Kind: download (downloaded by `sky-data fetch` into `DATA_DIR`)
- Source: <https://data.minorplanetcenter.net/iau/MPCORB/CometEls.txt>
- Version or date: CometEls.txt, regenerated daily by the MPC (fetch date recorded in DATA_DIR/manifest.json)
- License: Free, attribution requested (IAU Minor Planet Center)
- Copyright: IAU Minor Planet Center
- Attribution: Orbital elements: IAU Minor Planet Center
- Notes: Format: https://data.minorplanetcenter.net/iau/info/CometOrbitFormat.html. Several solutions per designation: the builder sorts by `reference` and keeps the last row per designation.

## skyfield built-in delta-T and leap-second tables (`skyfield_tables`)

- Kind: builtin (bundled inside a Python dependency)
- Source: <https://rhodesmill.org/skyfield/>
- Version or date: Skyfield 1.55 (bundled `iers.npz` and `delta_t.npz`)
- License: MIT
- Copyright: Copyright (c) 2013-2018 Brandon Rhodes
- Attribution: Earth orientation: Skyfield built-in delta-T and leap-second tables (Brandon Rhodes, MIT)
- Notes: Ships inside the Skyfield wheel and is refreshed with each Skyfield release (brief l.317); the IERS `finals2000A.all` download is an [L] option (backlog L-04).

License text (`backend/src/skyapi/data/licenses/MIT-skyfield.txt`):

```text
Copyright © 2013–2018 Brandon Rhodes and available under the MIT license:

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## OpenStreetMap Nominatim geocoder (`nominatim`)

- Kind: runtime_service (public web service called by the browser at run time)
- Source: <https://nominatim.openstreetmap.org>
- Version or date: public service, usage policy as read on 2026-09-03
- License: ODbL-1.0 (data); Nominatim usage policy
- Copyright: (c) OpenStreetMap contributors
- Attribution: Geocoding: (c) OpenStreetMap contributors, via Nominatim
- Notes: Browser-only, never called or proxied by the API (brief l.318); at most 1 request/s, no client-side autocomplete, identifying Referer, `email=` when configured; policy: https://operations.osmfoundation.org/policies/nominatim/. Configured through `/meta.geocoder` so it can be switched off without an app update.

## Lucide icons (lucide-react) (`lucide`)

- Kind: ui_asset (frontend asset from an npm dependency)
- Source: <https://lucide.dev>
- Version or date: lucide-react, version pinned in frontend/package-lock.json
- License: ISC
- Copyright: Copyright (c) 2026 Lucide Icons and Contributors
- Attribution: Icons: Lucide (ISC)
- Notes: The only third-party UI asset of v1 (brief l.320): system font stack, no third-party images or textures. Icons derived from Feather carry the MIT notice reproduced in the license text.

License text (`backend/src/skyapi/data/licenses/ISC-lucide.txt`):

```text
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Test excerpts

Small excerpts of the datasets above are committed under `backend/tests/fixtures/excerpts/` for the test suite (brief l.325): each is under 1 MB and carries an in-file header stating its source URL, license and fetch date.

- `tests/fixtures/excerpts/hip_main_excerpt.dat`: 1,000 brightest Hipparcos rows plus the test stars (HIP 761, 11767, 26220, 27989, 32349, 70890, 87937) and every HIP referenced by the Stellarium lines of Ori, UMa, Ser, Cru, Cas, UMi; original pipe-separated rows (from `hipparcos`, The Hipparcos and Tycho Catalogues, ESA SP-1200 (1997), via CDS/VizieR; CDS/ESA, free with citation)
- `tests/fixtures/excerpts/hyg_v44_excerpt.csv`: HYG v4.4 header and the rows whose hip is in the Hipparcos excerpt (1,010 rows), gunzipped, lines verbatim (from `hyg`, HYG database v4.4, David Nash, astronexus.com, CC BY-SA 4.0; CC-BY-SA-4.0)
- `tests/fixtures/excerpts/NGC_excerpt.csv`: OpenNGC NGC.csv header plus every Messier row, NGC7000, NGC0224, NGC7318A, IC0003, IC0011 (Dup) and the first NonEx row (from `ngc`, OpenNGC, Mattia Verga, CC BY-SA 4.0; CC-BY-SA-4.0)
- `tests/fixtures/excerpts/addendum_excerpt.csv`: OpenNGC addendum.csv header plus M040, the M102 Dup row, Mel022 (M45) and B033 (from `ngc_addendum`, OpenNGC, Mattia Verga, CC BY-SA 4.0; CC-BY-SA-4.0)
- `tests/fixtures/excerpts/stellarium_modern_excerpt.json`: Stellarium modern index.json reduced to id and the constellations Ori, UMa, Ser, Cru, Cas, UMi (id, lines, common_name), with a _provenance object (from `stellarium_modern`, Constellation figures: Stellarium 'modern' sky culture, CC BY-SA 4.0; CC-BY-SA-4.0)
- `tests/fixtures/excerpts/constellations_bounds_excerpt.json`: d3-celestial constellations.bounds.json FeatureCollection reduced to Ori, UMa, Ser (both polygons), Cru, Cas, UMi, with a _provenance object (from `d3_bounds`, Constellation boundaries: d3-celestial (Olaf Frohn), after Davenhall & Leggett 1990; BSD-3-Clause)
- `tests/fixtures/excerpts/MPCORB_excerpt.dat`: MPCORB.DAT provenance lines, the real MPC header through the dashed separator, then 9 numbered rows ((1) Ceres, (2) Pallas, (4) Vesta, (433) Eros, (99942) Apophis, (100001) letter-packed, (134340) Pluto, (620000) tilde-packed, the last numbered object), 10 unnumbered multi-opposition rows (5 with 2024 designations) and 5 one-opposition rows, blank section separators kept; 202-character records verbatim (from `mpcorb`, Orbital elements: IAU Minor Planet Center; Free, attribution requested (IAU Minor Planet Center))
- `tests/fixtures/excerpts/CometEls_excerpt.txt`: CometEls.txt provenance lines then 20 rows verbatim: 1P/Halley, 2P/Encke, C/1995 O1 (Hale-Bopp), C/2023 A3 (Tsuchinshan-ATLAS), both solutions of P/2021 N1 (ZTF), 3D-A, 332P-B, 1I/`Oumuamua, A/2018 W3, C/1947 X1-B, one row without a perturbed epoch, further P/ and C/ comets (from `comets`, Orbital elements: IAU Minor Planet Center; Free, attribution requested (IAU Minor Planet Center))
