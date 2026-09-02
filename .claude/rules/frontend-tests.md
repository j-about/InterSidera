---
paths:
  - "frontend/src/**/*.test.*"
  - "frontend/src/test/**"
  - "frontend/e2e/**"
---

# Frontend test rules (Vitest, Testing Library, Playwright)

- Vitest is configured in `vite.config.ts` (`defineConfig` from `vitest/config`): `environment: 'jsdom'`, `globals: true`, `setupFiles: ['./src/test/setup.ts']`, explicit `include: ['src/**/*.{test,spec}.{ts,tsx}']` and `exclude` re-adding `e2e/**` and `dist/**` (Vitest 4 excludes only `node_modules` and `.git` by default). `test.projects`, never `workspace`.
- `src/test/setup.ts` imports `@testing-library/jest-dom/vitest` (the `/vitest` subpath) and `../i18n` so components render real translations.
- Unit tests cover `sky/math`, `state/url` and `api/catalogs` against the shared fixtures in `backend/tests/fixtures/` (loaded through `src/test/`); Testing Library smoke tests cover components. `sky/math` and `state/url` stay at 100 % coverage (`@vitest/coverage-v8`, exact version of vitest, from M3).
- Babylon.js never runs in jsdom: engine and shader behaviour are tested only in Playwright, on both WebGL2 and WebGPU when the flags are measured (M3).
- Playwright projects: `chromium-desktop` (Desktop Chrome), `chromium-mobile` (Pixel 7), `webkit` (Desktop Safari). `baseURL` is `http://127.0.0.1:4173` (`vite preview`, plain HTTP); the API runs on `http://127.0.0.1:8000` with `SKYAPI_AUTO_FETCH=false` and `SKYAPI_EPHEMERIS=de440s.bsp`. Use `127.0.0.1`, never `localhost` (may resolve to `::1`).
- `trace: 'retain-on-failure'`; `retries: 1` and `workers: 1` in CI only; `forbidOnly` in CI.
- The `window.__sky` debug hook exists only in dev and test builds; e2e sanity checks go through it (Polaris altitude equals latitude within 1 degree from Greenwich; a planet within 1 arcmin of `/sky/altaz`).
- No request may leave for an origin other than the app and the configured geocoder; tests never call Nominatim or Horizons. Assert the absence of cookies, localStorage, sessionStorage and IndexedDB (OBS-8) in e2e from M4.
- Suites to grow: smoke, url-state, selection, search, time, night-mode, mobile (brief l.385).
- Browsers on this WSL need `sudo env "PATH=$PATH" fnm exec --using=24 npm --prefix frontend exec -- playwright install-deps` once (manual); until then `make e2e` is blocked locally and the state is recorded in `docs/testing.md`. CI runs Chromium only.
- Never skip, weaken, delete or mark a test as expected failure to make a gate pass.
