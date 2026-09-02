# InterSidera

Real-time 3D sky map in the browser: every Hipparcos star, the planets, deep-sky objects, asteroids and comets as seen from your location or from the surface of another Solar System body, at any date covered by JPL DE441. Constellations, augmented reality on mobile, shareable URLs, no accounts.

## Quickstart

Prerequisites: [uv](https://docs.astral.sh/uv/), [fnm](https://github.com/Schniz/fnm), git, GNU make; Docker with Compose is optional (used from M7). Developed on Debian under WSL 2; any Linux works.

```bash
make setup   # Python 3.14 via uv, Node 24 via fnm, uv sync, npm ci, Playwright browsers, .env from .env.example
make dev     # API with reload on http://127.0.0.1:8000 and Vite on https://localhost:5173 (proxies /api)
```

- Open <https://localhost:5173> and accept the self-signed development certificate once; check <http://127.0.0.1:8000/api/v1/health> (or <https://localhost:5173/api/v1/health> through the proxy).
- `make dev-api` and `make dev-web` start the two servers separately.
- The Makefile pins Node through `fnm exec --using=.node-version`, so it works regardless of your fnm default. For interactive shells in subdirectories, add `export FNM_VERSION_FILE_STRATEGY=recursive` (or `fnm env --version-file-strategy=recursive`) so `frontend/` inherits the root `.node-version`.
- Playwright browsers are downloaded by `make setup`, but launching them on a fresh WSL needs system libraries installed once with sudo, from the repository root: `sudo env "PATH=$PATH" fnm exec --using=24 npm --prefix frontend exec -- playwright install-deps`. Until then `make e2e` is blocked locally (CI is unaffected).
- Run `make check` before every commit: it is the same set of gates CI runs.

Other targets: `make test` (full pytest and vitest), `make e2e` (Playwright against a locally started stack), `make types` (regenerate `docs/openapi.json` and `frontend/src/api/schema.d.ts`), `make build`, `make format`. `make data` (`sky-data fetch`) arrives with M1 and `make up` / `make down` (docker compose) with M7; until then they print a message and exit.

## Repository map

- `/`: `Makefile`, `.node-version` (24), `.python-version` (3.14), `.env.example` (every `SKYAPI_` variable), `CLAUDE.md` (working agreement for Claude Code), `.claude/rules/` (file-specific rules), `.github/workflows/ci.yml`.
- `backend/`: the `skyapi` FastAPI + Skyfield service (uv-managed packaged app, src layout, `pyproject.toml`, `uv.lock`, tests). At M0 it exposes `GET /api/v1/health` only.
- `frontend/`: the React 19 + Vite 8 + Tailwind 4 client (TypeScript 6 strict, ESLint 10, Prettier, Vitest, Playwright). At M0 it renders a placeholder page and proxies `/api`.
- `docs/`: the specification (`brief.xml`), the plan and durable memory (`plan.md`), architecture, API, data, WSL 2 development, testing, backlog, and `decisions/` (ADRs); `openapi.json` is generated.
- `scripts/`: repository-level scripts (`check_i18n.mjs`, the translation completeness gate; fixture generation and benchmarks arrive at M1/M2).
- `data/` (gitignored): the development `DATA_DIR` filled by `sky-data fetch` from M1.

## Documentation

- [docs/brief.xml](docs/brief.xml): the authoritative specification.
- [docs/plan.md](docs/plan.md): status, decisions, milestones, risks, open questions, progress log.
- [docs/architecture.md](docs/architecture.md): principles, time model, frames, data flow, backend, frontend, deployment.
- [docs/api.md](docs/api.md): API conventions, generated types, binary catalog layout.
- [docs/data.md](docs/data.md): data sources, sizes, licenses and attributions.
- [docs/dev-wsl2.md](docs/dev-wsl2.md): HTTPS dev server, reaching it from a phone through WSL 2, Playwright prerequisites.
- [docs/testing.md](docs/testing.md): `make check` vs `make test` vs `make e2e`, coverage gates, budgets.
- [docs/backlog.md](docs/backlog.md): deviations from the brief and deferred items.
- [docs/decisions/](docs/decisions/): architecture decision records.

## License

MIT, see [LICENSE](LICENSE).
