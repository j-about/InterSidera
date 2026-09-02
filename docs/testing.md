# Testing

Status: stub written at M0; completed progressively: coverage gates at M1 (backend) and M3 (frontend), measured latency budgets at M2 and M6, the manual AR checklist at M5.

## The three entry points

| Target       | Runs                                                                                                                                                                                                                                                                                                                                                    | When                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `make check` | `uv lock --check`; `ruff format --check`; `ruff check`; `pyright`; `pytest -m "not slow"`; `npm run typecheck` (`tsc -b`); `npm run lint` (`eslint . --max-warnings 0 && prettier --check .`); `npm run test` (`vitest run`); `node --check scripts/check_i18n.mjs`, config-free prettier on `scripts/`, `node scripts/check_i18n.mjs`; `make types` then the drift gate on `docs/openapi.json` and `frontend/src/api/schema.d.ts` | before every commit; mirrored by CI                 |
| `make test`  | full `pytest` (including `slow` and `conformance`) and `vitest run`                                                                                                                                                                                                                                                                                     | before a milestone commit                           |
| `make e2e`   | `make build` then `playwright test` against a locally started stack (API on de440s, `vite preview` on 4173)                                                                                                                                                                                                                                             | before a milestone commit, when browsers can launch |

Check and test targets never load `.env` (only run targets do), so they behave identically from a clean clone and in CI.

## Backend (pytest)

- Markers (declared, `--strict-markers`): `unit`, `api`, `conformance`, `slow`. `make check` excludes `slow`.
- Hermetic by construction: the autouse `clean_env` fixture in `tests/conftest.py` removes every `SKYAPI_*` variable; fixtures build `Settings(data_dir=tmp_path_factory.mktemp("data"), auto_fetch=False, ephemeris="de440s.bsp")` explicitly; `TestClient` runs as a context manager so the lifespan executes.
- `filterwarnings = ["error"]`: warnings are failures; targeted ignores only, each with a comment and a backlog line.
- Data: `de440s.bsp` (1849-2150) is the only ephemeris tests may use; it is cached in the test `DATA_DIR` and restored in CI by `actions/cache` (M1). No network: no de441, no MPCORB, no Nominatim, no Horizons. Horizons reference values live in committed fixtures produced by `scripts/generate_fixtures.py` (run manually, sources cited).
- Coverage gates (active from M1): >= 90 % on `skyapi/astro` and `skyapi/catalogs`; 100 % on `astro/quaternions.py` and `catalogs/formats.py`; hypothesis property tests for canonicalization, time conversions and the SKYS round-trip.
- M0 suite: `tests/api/test_health.py` (200, `no-store`, body, `/health` at the root is 404, `/api/v1/openapi.json` 200), `tests/api/test_openapi_snapshot.py` (rendered document equals `docs/openapi.json`; the message says to run `make types`), `tests/unit/test_settings.py` (prefix, CSV `CORS_ORIGINS`, defaults, invalid `LOG_LEVEL`, unknown `SKYAPI_*` ignored).
- Conformance tolerances (M1): Sun, Moon and planets within 2 arcsec of Horizons; stars within 1 arcsec of Skyfield's own transformation of the catalog. Moon-frame tests include a pre-2426 date (Skyfield #952).

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
