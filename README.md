# InterSidera

Real-time 3D sky map in the browser: every Hipparcos star, the planets, deep-sky objects, asteroids and comets as seen from your location or from the surface of another Solar System body, at any date covered by JPL DE441. Constellations, augmented reality on mobile, shareable URLs, no accounts.

## Quickstart

Prerequisites: [uv](https://docs.astral.sh/uv/), [fnm](https://github.com/Schniz/fnm), git, GNU make; Docker with Compose is optional (used from M7). Developed on Debian under WSL 2; any Linux works.

```bash
make setup   # Python 3.14 via uv, Node 24 via fnm, uv sync, npm ci, Playwright browsers, .env from .env.example
make data    # sky-data fetch (de440s 32 MB, kernels, catalogs, MPCORB 94 MB compressed / 317 MB inflated) then build-caches; needs the .env from make setup
make dev     # API with reload on http://127.0.0.1:8000 and Vite on https://localhost:5173 (proxies /api)
```

- Open <https://localhost:5173> and accept the self-signed development certificate once; check <http://127.0.0.1:8000/api/v1/health> (or <https://localhost:5173/api/v1/health> through the proxy).
- `make dev-api` and `make dev-web` start the two servers separately.
- The Makefile pins Node through `fnm exec --using=.node-version`, so it works regardless of your fnm default. For interactive shells in subdirectories, add `export FNM_VERSION_FILE_STRATEGY=recursive` (or `fnm env --version-file-strategy=recursive`) so `frontend/` inherits the root `.node-version`.
- Playwright browsers are downloaded by `make setup`, but launching them on a fresh WSL needs system libraries: either once with sudo, from the repository root, `sudo env "PATH=$PATH" fnm exec --using=24 npm --prefix frontend exec -- playwright install-deps`, or without sudo through a user-space library directory exported with `LD_LIBRARY_PATH` and `FONTCONFIG_PATH` plus, since the interface has native form controls, a private `fonts.conf` exported as `FONTCONFIG_FILE` (see [docs/dev-wsl2.md](docs/dev-wsl2.md)). `make e2e` then builds the e2e bundle and runs the Playwright suite on Chromium desktop and Pixel 7 emulation against a local API on de440s (the data of `make data`; without the MPC tables the minor-body steps take their "unavailable" branch). CI installs the browsers itself.
- Run `make check` before every commit: it is the same set of gates CI runs.

Other targets: `make test` (full pytest and vitest with coverage), `make build-e2e` (the frontend build that exposes the `window.__sky` debug hook) and `make e2e` (that build, then Playwright on Chromium desktop and mobile emulation against a locally started stack), `make types` (regenerate `docs/openapi.json` and `frontend/src/api/schema.d.ts`), `make notices` (regenerate `THIRD_PARTY_NOTICES.md` and `frontend/src/data/credits.json` from the data registry), `make build`, `make format`. The `sky-data` CLI (`uv run --directory backend sky-data fetch|update|verify|build-caches|status`) manages the data directory; `sky-data fetch --full` adds the 3.3 GB DE441 ephemeris (the code default without a `.env`; `make setup` copies `.env.example`, which selects de440s). `make up` / `make down` (docker compose) arrive with M7; until then they print a message and exit.

## Using the app

- Observer: the browser asks for your location on the first visit (rounded to 0.01 degree before it leaves the browser, never stored); otherwise enter coordinates (decimal or degrees-minutes-seconds), search a place through OpenStreetMap Nominatim (submit-only, attribution shown, switchable off), pick another body (Moon, Mars, Mercury, Venus, the giant planets, Pluto) or one of its landing-site presets.
- Time: local, UTC (UT before 1972), TT Julian Date and local sidereal time readout; a date-and-time editor over the whole ephemeris (negative years included), play at the signed speeds of the API, steps by minute, hour, day, sidereal day or calendar year, keyboard shortcuts (Space, `,` `.`, `[` `]`, `n`, `t`, arrows, `+`/`-`, switchable off) and warning badges when a value is approximate.
- Sky: stars, planets, deep-sky objects with type symbols and a type filter, asteroids and comets (pinned or the server's defaults), constellation lines, names and IAU boundaries, labels at four densities, a daylight and twilight atmosphere, a ground, refraction, grids, ecliptic and meridian; a manual magnitude limit; tap an object for its details (names, type, constellation, coordinates from the server), centre it or follow it.
- Search stars, deep-sky objects, planets, constellations and minor bodies in one box; switch between English and French; turn on night mode (red monochrome sky and interface with a brightness slider); copy a link that reproduces the view; export a PNG; read the credits and versions in About. Everything above lives in the URL: no account, no cookie, no storage.
- Augmented reality on a phone (Earth only, a secure context): the "Augmented reality" button starts the rear camera behind a transparent sky that follows the phone's orientation, with a compass-accuracy badge, a sideways drag to align north (the offset can be reset), a slider for the camera's field of view, the atmosphere switch, a badge showing the time offset when the clock is paused or time-lapsed, and, on Android Chrome while the sky renders on WebGL2, an immersive WebXR mode with a visible exit control (a WebGPU phone gets the sensor mode until Chrome ships the WebXR/WebGPU binding: backlog B-79, maintainer question 26); every failure (no camera, permission refused, no sensors) returns to the normal view with one message. Nothing about the AR session enters the URL. To test it from this WSL 2 setup on a real phone, follow the phone procedure in [docs/dev-wsl2.md](docs/dev-wsl2.md) and the manual checklist in [docs/testing.md](docs/testing.md).

## Repository map

- `/`: `Makefile`, `.node-version` (24), `.python-version` (3.14), `.env.example` (every `SKYAPI_` variable), `CLAUDE.md` (working agreement for Claude Code), `.claude/rules/` (file-specific rules), `.github/workflows/ci.yml`.
- `backend/`: the `skyapi` FastAPI + Skyfield service (uv-managed packaged app, src layout, `pyproject.toml`, `uv.lock`, tests). It carries the data pipeline (`sky-data`, `skyapi.data`), the astronomy core (`skyapi.astro`) and the catalog builders (`skyapi.catalogs`) from M1, and serves API v1 from M2: `/api/v1/{health,meta,catalogs/stars,catalogs/stars/index,catalogs/dso,catalogs/constellations,minor-bodies/search,minor-bodies/defaults,sky/frame,sky/altaz}` (see [docs/api.md](docs/api.md)); the data is loaded by a background bootstrap, so `/health` reports `starting` with download progress until the API is `ready`. `backend/typings/` holds the local type stubs for Skyfield and jplephem.
- `frontend/`: the React 19 + Vite 8 + Tailwind 4 client (TypeScript 6 strict, ESLint 10, Prettier, Vitest, Playwright). From M3 it renders the sky with Babylon.js 9 on WebGPU or WebGL2: every Hipparcos star with proper motion, aberration and refraction in custom GLSL and WGSL shaders, the Sun, Moon, planets and Pluto with phase shading, the horizon, grids, ecliptic and meridian, a rotation-only camera with inertia and zoom, a simulation clock (live, paused, time-lapse at signed speeds), a frame buffer fed by `/sky/frame`, and a URL that carries the whole view state. From M4 it adds the user interface: observer, time, layers and details panels (a bottom sheet on phones, a side column on desktops), geolocation, the Nominatim place search, planetary site presets, the time editor and transport, deep-sky objects, minor bodies, constellations, labels, atmosphere and ground, selection and picking, unified search, night mode, French and English, the share link, PNG export, the About screen with generated credits and the degraded-state banners.
- `docs/`: the specification (`brief.xml`), the plan and durable memory (`plan.md`), architecture, API, data, WSL 2 development, testing, backlog, and `decisions/` (ADRs); `openapi.json` is generated.
- `scripts/`: repository-level scripts (`check_i18n.mjs`, the translation completeness gate; `check_chunks.mjs`, the lazy-chunk gate of `make build`; `generate_fixtures.py`, the JPL Horizons and Skyfield fixture generator, run manually; `bench_api.py`, the latency benchmark of the API against the brief's budgets, run against a locally started `fastapi run`).
- `data/` (gitignored): the development `DATA_DIR` filled by `make data` (downloads plus `data/cache/`).
- `THIRD_PARTY_NOTICES.md`: every dataset with its license and attribution, generated from `backend/src/skyapi/data/data_files.toml`.

## Documentation

- [docs/brief.xml](docs/brief.xml): the authoritative specification.
- [docs/plan.md](docs/plan.md): status, decisions, milestones, risks, open questions, progress log; its section 11 collects the questions for the maintainer (the Nominatim usage policy and browser-direct calls, the additive `/sky/altaz.constellation` field, the presets in code, the night level in the URL, ...) to answer before production use.
- [docs/architecture.md](docs/architecture.md): principles, time model, frames, data flow, backend, frontend, deployment.
- [docs/api.md](docs/api.md): every endpoint, canonicalization, problem types, caching, rate limiting, binary catalog layout.
- [docs/data.md](docs/data.md): data sources, sizes, licenses and attributions.
- [docs/dev-wsl2.md](docs/dev-wsl2.md): HTTPS dev server, the phone procedure for augmented reality (USB port forwarding, mkcert with `DEV_TLS_CERT`/`DEV_TLS_KEY`, the insecure-origin exception), Playwright prerequisites.
- [docs/testing.md](docs/testing.md): `make check` vs `make test` vs `make e2e`, coverage gates, budgets.
- [docs/backlog.md](docs/backlog.md): deviations from the brief and deferred items.
- [docs/decisions/](docs/decisions/): architecture decision records.

## License

MIT, see [LICENSE](LICENSE).
