# Testing

Status: stub written at M0; backend coverage gates, fixtures and conformance policy written at M1; completed progressively: frontend coverage at M3, measured latency budgets at M2 and M6, the manual AR checklist at M5.

## The three entry points

| Target       | Runs                                                                                                                                                                                                                                                                                                                                                    | When                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `make check` | `uv lock --check`; `ruff format --check` and `ruff check` on the backend and on `scripts/*.py` (backend config); `pyright`; `pytest -m "not slow"` with `--cov=skyapi.astro --cov=skyapi.catalogs`, then `coverage report --fail-under=90` on `src/skyapi/astro/*` and on `src/skyapi/catalogs/*` and `--fail-under=100` on `quaternions.py` + `formats.py`; `npm run typecheck` (`tsc -b`); `npm run lint`; `npm run test`; `node --check scripts/check_i18n.mjs`, config-free prettier on `scripts/`, `node scripts/check_i18n.mjs`; `make types` and `make notices` then the drift gate on `docs/openapi.json`, `frontend/src/api/schema.d.ts` and `THIRD_PARTY_NOTICES.md` | before every commit; mirrored by CI |
| `make test`  | full `pytest` (including `slow` and `conformance`) and `vitest run`                                                                                                                                                                                                                                                                                     | before a milestone commit                           |
| `make e2e`   | `make build` then `playwright test` against a locally started stack (API on de440s, `vite preview` on 4173)                                                                                                                                                                                                                                             | before a milestone commit, when browsers can launch |

Check and test targets never load `.env` (only run targets do), so they behave identically from a clean clone and in CI.

## Backend (pytest)

- Markers (declared, `--strict-markers`): `unit`, `api`, `conformance`, `slow`. `make check` excludes `slow`.
- Hermetic by construction: the autouse `clean_env` fixture in `tests/conftest.py` removes every `SKYAPI_*` variable; fixtures build `Settings(data_dir=tmp_path_factory.mktemp("data"), auto_fetch=False, ephemeris="de440s.bsp")` explicitly; `TestClient` runs as a context manager so the lifespan executes.
- `filterwarnings = ["error"]`: warnings are failures; targeted ignores only, each with a comment and a backlog line.
- Data: the session fixture `kernels_dir` (`tests/conftest.py`, default `<repo>/data`, override `INTERSIDERA_TEST_DATA_DIR`) provides the test kernel set `de440s.bsp` (1849-2150, the only ephemeris tests may use), `pck00011.tpc`, `moon_de440_250416.tf` and `moon_pa_de440_200625.bpc` (about 46 MB, public domain): it verifies the registry pins and downloads a missing file through `skyapi.data.download`, once. CI restores and saves those four files with `actions/cache` (saved even when the run fails). No other network: no de441, no MPCORB, no Nominatim, no Horizons.
- Excerpts: every other dataset is exercised on committed excerpts under `tests/fixtures/excerpts/` (each under 1 MB, in-file provenance header, `[[excerpts]]` entry in the registry, described in `excerpts/README.md`); the session fixtures `built_caches`, `catalog_state`, `mpc_cache` and `mpc_state` build the caches from them into a temporary directory.
- Session fixtures run before the function-scoped `clean_env`, so they never construct `Settings`: they receive `kernels_dir` and `CachePaths` directly; only the function-scoped `settings` fixture builds `Settings(...)` explicitly.
- Coverage gates (active from M1): >= 90 % on `skyapi/astro` and on `skyapi/catalogs` separately, 100 % on `astro/quaternions.py` and `catalogs/formats.py`, measured by the `make check` pytest run (`-m "not slow"`) and enforced by three `coverage report --include=... --fail-under=...` lines (CI mirrors them). Hypothesis property tests cover the quaternion conversions, the time formatting round trip and the SKYS round trip (canonicalization at M2). Local subset runs (`pytest -k ...`) add `--no-cov`: pytest-cov's warning about modules that were never imported would fail under `filterwarnings = error`.
- `slow` tests (`tests/slow/`) build every cache from the full files in `DATA_DIR` and check counts, sizes and timings; when the full files are absent they skip with the reason "full data files not present in DATA_DIR: run `make data`". That skip is a data-availability condition, not a gate bypass: `make check` never runs them, `make test` runs them on a machine where `make data` has been run.
- Horizons reference values live in `tests/fixtures/horizons_cases.json`, produced by `scripts/generate_fixtures.py horizons` (run manually at M1; the script refuses to run in CI). Skyfield-derived parity fixtures (`skyfield_*.json`) come from `scripts/generate_fixtures.py skyfield`.
- M0 suite: `tests/api/test_health.py` (200, `no-store`, body, `/health` at the root is 404, `/api/v1/openapi.json` 200), `tests/api/test_openapi_snapshot.py` (rendered document equals `docs/openapi.json`; the message says to run `make types`), `tests/unit/test_settings.py` (prefix, CSV `CORS_ORIGINS`, defaults, invalid `LOG_LEVEL`, unknown `SKYAPI_*` ignored).
- Conformance (M1, `tests/conformance`, 30 tests against `horizons_cases.json`, 360 cases from six observers, six epochs and the Sun, Moon, planets and Pluto): apparent ICRF directions (Horizons quantity 45) agree within 0.011 arcsec at every epoch and site (Sun, planets and Pluto within 0.001 arcsec; the Moon's residual is topocentric parallax of the tiny time-scale difference); astrometric ICRF (quantity 1) within 0.011 arcsec; RA/Dec of date through our equinox quaternion within 0.31 arcsec; alt/az from Earth sites within 0.56 arcsec; alt/az from Tranquility Base within 0.008 arcsec; alt/az from Jezero within 0.0006 arcsec after tilting our planetocentric zenith to Horizons' planetodetic normal (0.2034 degrees at that latitude; untilted the difference is 159-732 arcsec); the Mars pole (quantity 32) within 0.017 arcsec of our IAU 2015 model at all six epochs, so Horizons serves the same `pck00011` model and the feared IAU 2009 discrepancy (R34) does not exist; ranges within 1e-10 au, illuminated fractions within 0.02 percentage points, angular diameters within 0.006 %, magnitudes within 0.1 mag (Horizons has none for the barycentre targets Jupiter to Pluto). Stars: SKYS rows equal the excerpt build exactly, barycentric parity 0.007 arcsec, apparent parity after first-order aberration bounded by each star's parallax (Proxima 0.655 arcsec, Polaris 0.004 arcsec). No tolerance beyond the brief's 2 arcsec was needed (B-36 stays empty). Moon-frame tests include a pre-2426 date (Skyfield #952).
- Time-scale policy behind the alt/az comparisons: Skyfield's bundled daily IERS table runs 1973-01-02 to 2027-01-23, so only the 2000 and 2024 epochs are IERS-covered and use the builtin timescale (`delta_t_coverage(ts).observed_tt` decides, not a hard-coded list). At 1900, 1969, 2050 and 2140 Horizons and Skyfield use different delta T models (Horizons holds the last EOP prediction constant and uses Stephenson/Morrison before 1962; Skyfield uses the S15 splines and the 2016 parabola; one second of delta T is 15 arcsec of Earth rotation, 991 arcsec at 2140), so the tests rebuild the timescale with Horizons' own value from quantity 30. That quantity is TDB - UT1 only before 1962 and TDB - UTC afterwards (64.184 s in 2000 = 32.184 s + 32 leap seconds), so injecting it assumes UT1 = UTC: at the four far epochs Horizons' UT1 - UTC is at most 0.03 s (0.45 arcsec), while at 2000 it was +0.355 s (5.7 arcsec), which is why 2000 stays on the builtin timescale. Moon and Mars sites rotate on TDB and always use the builtin timescale.
- Measured at M1 on the development machine (aarch64 WSL 2, 10 cores, 7 GB): `make check` runs 399 unit and API tests in about 28 s; coverage `skyapi/astro` 98 %, `skyapi/catalogs` 99 %, `quaternions.py` and `formats.py` 100 %. Full-data cache build (`tests/slow`, symlinked sources, scratch cache): 25.4 s in total; stars 1.6 s (117,955 rows, `stars.skys` 3,774,584 B, index 3,429 entries), DSO 0.5 s (5,229 entries, 109 Messier objects plus the M102 alias), constellations under 0.1 s (88), MPC 22.2 s with a peak RSS of 1,219 MB through the chunked reader (Skyfield's single-call `load_mpcorb_dataframe` measured 46.9 s and 3,648 MB on the same file, hence B-39): 1,562,091 asteroids, 957 comets, `asteroids.parquet` 160 MB, `index.parquet` 38 MB. Minor-body index load 0.54 s; `search` median 0.8 ms (max 2.3 ms) on the full index; `defaults` 1.7 ms; a cold `orbit_for` 11-17 ms (asteroid, one Parquet row group) or 4-5 ms (comet); 3 minor bodies x 64 samples 46 ms warm. Conformance residuals: the two bullets above.

## Frontend unit tests (Vitest)

- Configured in `vite.config.ts` (`defineConfig` from `vitest/config`): jsdom, `globals: true`, `setupFiles: ['./src/test/setup.ts']` (imports `@testing-library/jest-dom/vitest` and the i18n resources), explicit `include: ['src/**/*.{test,spec}.{ts,tsx}']` and `exclude` covering `e2e/**` and `dist/**`.
- M0 suite: `src/App.test.tsx` renders the placeholder and asserts the level-1 heading reads "InterSidera" (Vitest exits 1 with zero test files, so one real test is required).
- Coverage gate (active from M3 with `@vitest/coverage-v8` at the exact vitest version): 100 % line coverage on `src/sky/math/**` and `src/state/url.ts`; fixture parity tests load `backend/tests/fixtures/` through `src/test/`: stars <= 1 arcsec, bodies <= 1 arcmin for `step_s <= 3600` and `|speed| <= 3600`, refraction <= 1 arcmin above -1 degree.
- Babylon.js never runs under jsdom; rendering is tested in Playwright only.

## End-to-end (Playwright 1.62)

- Projects: `chromium-desktop` (Desktop Chrome), `chromium-mobile` (Pixel 7 emulation), `webkit` (Desktop Safari). All three have debian13-arm64 builds, so WebKit is "available" on this machine (brief l.410).
- `webServer`: `uv run fastapi run --host 127.0.0.1 --port 8000` in `../backend` with `SKYAPI_AUTO_FETCH=false` and `SKYAPI_EPHEMERIS=de440s.bsp`, then `npm run preview` on `http://127.0.0.1:4173`; `reuseExistingServer` outside CI; `trace: 'retain-on-failure'`; `retries: 1` and `workers: 1` in CI.
- M0 spec: `e2e/smoke.spec.ts` (title, visible h1, `/api/v1/health` through the preview proxy returns `status: "ready"`). Later suites (brief l.385): url-state, selection, search, time, night-mode, mobile; the OBS-8 assertion that no cookies, localStorage, sessionStorage or IndexedDB are used (M4); rendering sanity checks through the `window.__sky` debug hook (M3).
- WebGL2 works in headless Chromium without flags (Playwright already passes `--enable-unsafe-swiftshader`). WebGPU flags for headless Chromium are measured at M3, not assumed.
- CI runs Chromium only, in the `e2e` job added at M3 (`playwright install --with-deps chromium`, traces uploaded with `actions/upload-artifact@v7` when not cancelled).

### Prerequisite on WSL: system libraries

Browsers are downloaded by `make setup`, but this WSL Debian lacks the shared libraries they need (libnss3, libgbm1, libasound2, libwoff2dec, ...). A human must run once:

```bash
sudo env "PATH=$PATH" fnm exec --using=24 npm --prefix frontend exec -- playwright install-deps
```

Until then `make e2e` fails at browser launch; the blocked state is recorded in `docs/plan.md` (B-24) and is not part of the M0 definition of done.

## Manual checks

- M0 definition of done: `make check` green; `curl -s -D - http://127.0.0.1:8000/api/v1/health` returns `200`, `content-type: application/json`, `cache-control: no-store` and `{"status":"ready","version":"0.1.0"}`; `curl -sk https://localhost:5173/api/v1/health` returns the same JSON through the Vite proxy; `ci.yml` reviewed line by line.
- Manual AR checklist (M5): placeholder; to be written for the human to run on a real device (permissions, compass accuracy, calibration drag, camera field of view, WebXR entry and exit, degraded messages).

## Budgets (measured at M2 and M6)

| Budget (brief l.254-260)                           | Target                      | Measured | Milestone |
| -------------------------------------------------- | --------------------------- | -------- | --------- |
| `/sky/frame` p95, n = 32, default bodies, one vCPU | < 150 ms                    | tbd      | M2        |
| `/sky/frame` p95 with 100 minor bodies             | < 400 ms                    | tbd      | M2        |
| catalogs served from prebuilt files                | < 50 ms                     | tbd      | M2        |
| `/minor-bodies/search`                             | < 50 ms                     | tbd      | M2        |
| ready after start with data present                | < 60 s                      | tbd      | M2        |
| RSS per worker                                     | < 1 GB                      | tbd      | M6        |
| desktop frame rate, full catalog, all layers       | 60 fps                      | tbd      | M3/M6     |
| 2022 mid-range phone frame rate                    | >= 30 fps                   | tbd      | M6        |
| catalog parsing                                    | < 300 ms                    | tbd      | M6        |
| first meaningful sky (warm / cold 4G)              | < 2 s / < 5 s               | tbd      | M6        |
| main JavaScript bundle                             | <= 1.5 MB gzipped           | tbd      | M6        |
| session download                                   | catalogs <= 6 MB compressed | tbd      | M6        |
| Lighthouse accessibility score on the main view    | >= 90                       | tbd      | M6        |
| live mode drift                                    | <= 100 ms                   | tbd      | M6        |
