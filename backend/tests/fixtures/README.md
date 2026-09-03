# Conformance fixtures

Machine-generated reference values for the conformance tests (brief `api_contract/conformance`,
decision D37). Every file is produced by `scripts/generate_fixtures.py`, carries `source`,
`generator`, `generated_at`, the parameters used and the raw request URLs, and is committed as
is: tests and CI never contact the network (`.claude/rules/backend-tests.md`).

## `horizons_cases.json`

Reference values: JPL Horizons, Solar System Dynamics Group, <https://ssd.jpl.nasa.gov/horizons/>;
US Government work, public domain.

Generated on 2026-09-03 with the Horizons API (response signature version 1.2) by

```sh
uv run --directory backend python ../scripts/generate_fixtures.py horizons \
    --out ../backend/tests/fixtures/horizons_cases.json --raw-dir <scratch directory>
```

after one `--probe` request (Jezero, Sun, 2000-01-01T12 TT) that settled the longitude sign
convention for Martian sites (see `longitude_sign_decision` inside the file). The script runs
manually, one request at a time with a 1.5 s pause and 30/60/120 s back-off (SSD API fair-use
policy), and refuses to run when the `CI` environment variable is set. 61 requests, 360 cases.

### What is in it

- `observers`: four Earth sites (`greenwich`, `paris`, `sydney`, `quito`; WGS84 geodetic,
  `COORD_TYPE=GEODETIC`), one lunar site (`tranquility`, planetocentric, frame
  `MOON_ME_DE440_ME421`, which Horizons calls "mean Earth of DE421") and one Martian site
  (`jezero`, planetocentric). Non-Earth sites are sent as `COORD_TYPE=CYLINDRICAL`
  `{E-long, DXY km, DZ km}` built from our planetocentric coordinates and the `pck00011.tpc`
  triaxial radius; the echoed `Center geodetic` / `Center cylindric` / `Center pole/equ` header
  lines are stored verbatim (`*_echo`) and were asserted against the request before writing.
- `epochs_tt`: six TT epochs inside de440s (1849-2150): 1900-01-01T00, 1969-07-21T03,
  2000-01-01T12, 2024-04-08T18, 2050-06-15T00, 2140-12-31T00, as TT Julian Dates
  (`TLIST_TYPE=JD`, `TIME_TYPE=TT`).
- `targets`: Horizons ids of our body ids (`sun` 10, `moon` 301, `mercury` 199, `venus` 299,
  `earth` 399, `mars` 499, `jupiter` 5, `saturn` 6, `uranus` 7, `neptune` 8, `pluto` 9; the
  outer planets and Pluto are the system barycenters, as our ephemeris keys are, D44) with the
  echoed `Target radii` and `Target pole/equ` lines.
- `cases`: one object per (observer, target, epoch). Earth sites see the ten bodies other than
  the Earth; the Moon and Mars see the same list minus themselves plus the Earth. Fields
  (Horizons quantity in brackets; `null` where Horizons printed `n.a.`):
  `ra_icrf_astrometric_deg`, `dec_icrf_astrometric_deg` [1];
  `ra_apparent_of_date_deg`, `dec_apparent_of_date_deg` [2];
  `az_deg`, `el_deg` [4, airless];
  `apmag`, `surface_brightness` [9]; `illuminated_pct` [10]; `ang_diam_arcsec` [13];
  `range_au`, `range_rate_km_s` [20]; `phase_angle_deg` [24, S-T-O]; `tdb_minus_ut_s` [30];
  `pole_ra_deg`, `pole_dec_deg` [32, the target's north pole]; `ra_icrf_apparent_deg`,
  `dec_icrf_apparent_deg` [45].
  Horizons quirks observed: the barycenter targets `jupiter`, `saturn`, `uranus`, `neptune`
  and `pluto` (ids 5-9) carry no physical body, so their `apmag`, `surface_brightness`,
  `illuminated_pct`, `ang_diam_arcsec`, `pole_ra_deg` and `pole_dec_deg` are `null` and their
  `Target radii` / `Target pole/equ` echoes read `undefined`; the Sun has `phase_angle_deg`
  0 and `illuminated_pct` 100 rather than `n.a.`; the lunar site's frame echo reads
  `MEAN_ME (high precision)`.
- `barycenter_offset_check`: Jupiter system barycenter (5) versus Jupiter centre (599) from
  Greenwich at every epoch, with the angular separation in arcseconds (0.006″ to 0.034″ over
  the six epochs), so that the choice of the barycenter as our `jupiter` target is documented
  with numbers.
- `request_urls`: every URL sent, in order.

### Epoch and quantity policy (D37, R37)

Horizons and Skyfield use different ΔT models outside the IERS table: Horizons holds ΔT
constant beyond its ~73-day EOP prediction and uses Stephenson/Morrison before 1962, while
Skyfield's builtin timescale uses the S15 splines and the 2016 parabola. One second of ΔT is
15″ of Earth rotation, so:

- Quantities that do not depend on Earth rotation ([1], [45], [20], [24], [13], [9], [10]) are
  compared at full tolerance (planets and Moon within 2″) at every epoch.
- Earth-site azimuth/elevation [4] and RA/Dec of date [2] are compared at 2″ only for the epochs
  inside the IERS table (1969-07-21, 2000-01-01, 2024-04-08).
- At 1900, 2050 and 2140 they are compared only after rebuilding the Skyfield timescale with
  Horizons' own ΔT for that row: `tdb_minus_ut_s` [30] is TDB − UT, so ΔT = TT − UT =
  `tdb_minus_ut_s` − (TDB − TT), injected as a constant `delta_t` into `load.timescale(...)`.
  This isolates rotation-model differences from ΔT-model differences.
- Moon and Mars sites rotate on TDB and are unaffected by ΔT. For non-Earth sites Horizons
  measures apparent RA [2] from the body frame's own origin, so only [4] and [45] are
  comparable there; refraction is never modelled off Earth. The Martian site is analysed
  before any tolerance is set (R34: Horizons uses the IAU 2009 rotation model, we use the
  IAU 2015 model of `pck00011.tpc`; Horizons' zenith for a user site is the planetodetic
  normal of the 3396.19/3376.2 km ellipsoid).

Never loosen a tolerance against these values; record any systematic disagreement in
`docs/testing.md` and `docs/backlog.md` first.

## Skyfield-generated fixtures

`skyfield_stars.json`, `skyfield_frames.json` and `skyfield_refraction.json` are our own
astronomy core sampled into JSON: Skyfield 1.55 through `skyapi.astro` on `de440s.bsp`,
`pck00011.tpc` and the two Moon kernels (`source` inside each file). They are local and
deterministic apart from `generated_at` (the files are byte-identical across runs otherwise), so
they are regenerated whenever the astronomy core changes, with

```sh
uv run --directory backend python ../scripts/generate_fixtures.py skyfield \
    --data-dir ../data --out-dir ../backend/tests/fixtures
```

which needs the kernel set and the full `hip_main.dat` in `--data-dir` (`make data`). Every file
carries `source`, `generator`, `generated_at`, `skyfield_version` and `parameters`. Sampled
quantities (unit vectors, quaternions, velocities, distances, magnitudes) are rounded to 12
significant digits (2e-7″ on a unit vector); TT Julian Dates are written exactly.

### What is in them

- `skyfield_stars.json`: for the seven parity stars HIP 11767 (Polaris), 32349 (Sirius), 27989
  (Betelgeuse), 87937 (Barnard's Star), 70890 (Proxima Centauri), 91262 (Vega) and 65474
  (Spica): the Hipparcos `catalog` row (`ra_degrees`, `dec_degrees`, `ra_mas_per_year`,
  `dec_mas_per_year`, `parallax_mas`, `epoch_year`, `magnitude`, `bv_millimag`), the SKYS row
  the builder writes (`skys.dir`, `skys.pm` in radians per Julian year, `mag_millimag`,
  `bv_millimag`; D48, computed by `star_table_from_hipparcos` on those rows, which is bit for bit
  the full build's result because the rule is per star) and six `samples` at TT 1900-01-01,
  1950-01-01, 2000-01-01T12, 2024-04-08T18, 2100-01-01 and 2140-12-31: `tt`,
  `years_since_epoch` (Julian years from J2000), `barycentric_dir` (`SSB.at(t).observe(star)`,
  normalised), `apparent_dir` (`earth.at(t).observe(star).apparent()`, geocentric, normalised)
  and `earth_velocity_au_d` (the Earth's barycentric velocity).
- `skyfield_frames.json`: three windows shaped like `/sky/frame`: `observer` (body id), `site`
  (`id`, `lat_deg`, `lon_deg`, `elev_m`, `frame_name`, `latitude_kind`), `tt0`, `step_s`, `n`,
  `tt` (n exact TT JDs), `horizon_q` and `equinox_q` (n × 4 unit quaternions `[x, y, z, w]`,
  Hamilton, ICRF → ENU and ICRF → true equator and equinox of date, sign-continuous),
  `observer_velocity_au_d` (n × 3), `sun_dir` (n × 3) and `bodies` (`dir` n × 3 apparent ICRF
  unit vectors, `dist_au`, `mag`, `phase`, `diam_deg`, n each). Windows: Greenwich
  2024-04-08T18 TT, step 300 s, n 32, every body but the Earth; Tranquility Base (Moon)
  2000-01-01T12 TT, step 3600 s, n 8, every body but the Moon (the Earth included); Jezero (Mars)
  2024-04-08T00 TT, step 3600 s, n 8, every body but Mars.
- `skyfield_refraction.json`: `tables`, one per elevation (0 m and 2850 m), each with
  `temperature_c` 10, `pressure_mbar` = 1010 exp(−elevation / 9100) and `rows` of
  `[alt_true_deg, alt_apparent_deg]` on the true-altitude grid −1.0° to 90.0° in steps of 0.5°
  (183 rows), from Skyfield's `earthlib.refract` (Bennett 1982 inverted; zero below −1° and
  above 89.9°). Full precision, so the backend test compares them exactly.

### Parity policy (brief l.179-181)

- Backend (`tests/conformance/test_stars.py`, `test_fixture_files.py`): the SKYS rule
  `normalize(dir + pm · years)` in float64 reproduces `barycentric_dir` within 0.1″ and, after
  first-order aberration with `earth_velocity_au_d` and c = 173.1446 au/day, `apparent_dir`
  within 1″; the SKYS rows equal the excerpt-built catalog exactly; the refraction rows equal
  `refraction_table` exactly; the frame windows equal a live recomputation to the rounding.
- Frontend (M3, vitest through `frontend/src/test/`): the TypeScript propagation, interpolation,
  proper-motion and refraction code reproduces these files within stars ≤ 1″, bodies ≤ 1′ for
  `step_s ≤ 3600` and |speed| ≤ 3600, refraction ≤ 1′ above −1°.

Regenerate the three files together and commit them with the code change that made them move.
