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
- Playwright browsers are downloaded by `make setup`, but launching them on a fresh WSL needs system libraries: either once with sudo, from the repository root, `sudo env "PATH=$PATH" fnm exec --using=24 npm --prefix frontend exec -- playwright install-deps`, or without sudo through a user-space library directory exported with `LD_LIBRARY_PATH` (see [docs/dev-wsl2.md](docs/dev-wsl2.md)). CI installs them itself.
- Run `make check` before every commit: it is the same set of gates CI runs.

Other targets: `make test` (full pytest and vitest with coverage), `make build-e2e` (the frontend build that exposes the `window.__sky` debug hook) and `make e2e` (that build, then Playwright on Chromium desktop and mobile emulation against a locally started stack), `make types` (regenerate `docs/openapi.json` and `frontend/src/api/schema.d.ts`), `make notices` (regenerate `THIRD_PARTY_NOTICES.md` from the data registry), `make build`, `make format`. The `sky-data` CLI (`uv run --directory backend sky-data fetch|update|verify|build-caches|status`) manages the data directory; `sky-data fetch --full` adds the 3.3 GB DE441 ephemeris (the code default without a `.env`; `make setup` copies `.env.example`, which selects de440s). `make up` / `make down` (docker compose) arrive with M7; until then they print a message and exit.

## Repository map

- `/`: `Makefile`, `.node-version` (24), `.python-version` (3.14), `.env.example` (every `SKYAPI_` variable), `CLAUDE.md` (working agreement for Claude Code), `.claude/rules/` (file-specific rules), `.github/workflows/ci.yml`.
- `backend/`: the `skyapi` FastAPI + Skyfield service (uv-managed packaged app, src layout, `pyproject.toml`, `uv.lock`, tests). It carries the data pipeline (`sky-data`, `skyapi.data`), the astronomy core (`skyapi.astro`) and the catalog builders (`skyapi.catalogs`) from M1, and serves API v1 from M2: `/api/v1/{health,meta,catalogs/stars,catalogs/stars/index,catalogs/dso,catalogs/constellations,minor-bodies/search,minor-bodies/defaults,sky/frame,sky/altaz}` (see [docs/api.md](docs/api.md)); the data is loaded by a background bootstrap, so `/health` reports `starting` with download progress until the API is `ready`. `backend/typings/` holds the local type stubs for Skyfield and jplephem.
- `frontend/`: the React 19 + Vite 8 + Tailwind 4 client (TypeScript 6 strict, ESLint 10, Prettier, Vitest, Playwright). From M3 it renders the sky with Babylon.js 9 on WebGPU or WebGL2: every Hipparcos star with proper motion, aberration and refraction in custom GLSL and WGSL shaders, the Sun, Moon, planets and Pluto with phase shading, the horizon, grids, ecliptic and meridian, a rotation-only camera with inertia and zoom, a simulation clock (live, paused, time-lapse at signed speeds), a frame buffer fed by `/sky/frame`, and a URL that carries the whole view state. The panels, labels and search arrive at M4.
- `docs/`: the specification (`brief.xml`), the plan and durable memory (`plan.md`), architecture, API, data, WSL 2 development, testing, backlog, and `decisions/` (ADRs); `openapi.json` is generated.
- `scripts/`: repository-level scripts (`check_i18n.mjs`, the translation completeness gate; `generate_fixtures.py`, the JPL Horizons and Skyfield fixture generator, run manually; `bench_api.py`, the latency benchmark of the API against the brief's budgets, run against a locally started `fastapi run`).
- `data/` (gitignored): the development `DATA_DIR` filled by `make data` (downloads plus `data/cache/`).
- `THIRD_PARTY_NOTICES.md`: every dataset with its license and attribution, generated from `backend/src/skyapi/data/data_files.toml`.

## Documentation

- [docs/brief.xml](docs/brief.xml): the authoritative specification.
- [docs/plan.md](docs/plan.md): status, decisions, milestones, risks, open questions, progress log.
- [docs/architecture.md](docs/architecture.md): principles, time model, frames, data flow, backend, frontend, deployment.
- [docs/api.md](docs/api.md): every endpoint, canonicalization, problem types, caching, rate limiting, binary catalog layout.
- [docs/data.md](docs/data.md): data sources, sizes, licenses and attributions.
- [docs/dev-wsl2.md](docs/dev-wsl2.md): HTTPS dev server, reaching it from a phone through WSL 2, Playwright prerequisites.
- [docs/testing.md](docs/testing.md): `make check` vs `make test` vs `make e2e`, coverage gates, budgets.
- [docs/backlog.md](docs/backlog.md): deviations from the brief and deferred items.
- [docs/decisions/](docs/decisions/): architecture decision records.

## License

MIT, see [LICENSE](LICENSE).
