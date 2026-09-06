# InterSidera: working agreement for Claude Code

## Project

- InterSidera is an account-free web application that shows the sky (every Hipparcos star, Sun, Moon, planets, Pluto, deep-sky objects, asteroids, comets) from any place on Earth or from the surface of another Solar System body, at any date in the ephemeris, with augmented reality on phones.
- License: MIT (`LICENSE`, never modified). Product name = repository directory name.
- Backend = FastAPI + Skyfield, the single astronomical authority ("oracle"); frontend = React 19 + Babylon.js 9, a "propagator" that only rotates, interpolates and applies backend-supplied corrections.
- No accounts, no database, no persistence: every per-user state lives in the URL.
- Eight milestones M0-M7, at least one local Conventional Commit per milestone, never a push.

## Authoritative documents

- `docs/brief.xml` is the specification. When sections conflict (brief l.11): legal and licensing > security and privacy > api_contract > architecture > [M] functional > non-functional budgets > [S] > style.
- `docs/plan.md` is the durable memory across sessions: status, decisions D1-D50, milestones, risks, open questions, progress log. Read it first in every session; update it in every milestone commit.
- `docs/decisions/` holds one ADR per notable decision; `docs/backlog.md` records every deviation from the brief with its reason and the deferred [L] items.

## Commands (root `Makefile`)

- `make setup`: Python 3.14 via uv, Node 24 via fnm, `uv sync`, `npm ci`, Playwright browsers, `.env` from `.env.example`.
- `make data`: `sky-data fetch` then `sky-data build-caches` into `DATA_DIR` (loads `.env`; `sky-data fetch --full` adds de441).
- `make dev`: API (`fastapi dev`, port 8000) and Vite (port 5173, HTTPS, proxies `/api`) together; `make dev-api` / `make dev-web` separately.
- `make check`: every gate, before each commit and in CI: `uv lock --check`, ruff format/check (backend and `scripts/*.py`), pyright (backend, then `scripts/*.py` as explicit files), `pytest -m "not slow"` with coverage (astro and catalogs >= 90 %, `quaternions.py` and `formats.py` 100 %), `tsc -b`, eslint + prettier, vitest, `node --check`, prettier and a run of `scripts/check_i18n.mjs`, `make types` + `make notices` + drift gate on the generated files.
- `make test`: full pytest (slow and conformance included) + vitest.
- `make e2e`: `make build` then Playwright against a locally started stack.
- `make types`: regenerate `docs/openapi.json` and `frontend/src/api/schema.d.ts`. `make notices`: regenerate `THIRD_PARTY_NOTICES.md` from the data registry.
- `make build`: production frontend build.
- `make up` / `make down`: docker compose (arrive in M7).
- `make format`: ruff format + fix, prettier + eslint --fix.
- uv and npm run only through make, or as `uv run --directory backend ...` / `npm --prefix frontend ...`; Node always through `fnm exec --using=<repo>/.node-version`; never `cd` in a recipe; never a root `npx` (it fetches a floating version).

## Toolchain pins and why

- Node `24` in `.node-version`; fnm and CI resolve it to the newest 24.x (>= 24.15.0, the jsdom 30 floor; 24.20.0 here). npm stays the bundled 11.x.
- Python `3.14` in two `.python-version` files (root and `backend/`, because uv stops at the project boundary); `requires-python = ">=3.14,<3.15"`.
- TypeScript `~6.0.3` (ADR-0001): TypeScript 7 is the Go port without a compiler API until 7.1; typescript-eslint requires `<6.1.0`.
- ESLint 10 plus npm `overrides` for `eslint-plugin-jsx-a11y` and `openapi-typescript` (ADR-0002); never `--legacy-peer-deps`.
- `fastapi[standard-no-fastapi-cloud-cli]` and a lazily built module attribute `app` (PEP 562) under the factory (ADR-0003): fastapi-cli has no `--factory`; importing `skyapi.main` reads no environment.
- Implied tooling dependencies (`@testing-library/dom`, `@eslint/js`, `globals`, `@types/*`, `httpx2`) are recorded in ADR-0004; nothing else without an ADR.
- Committed factual data lives inside the package (`backend/src/skyapi/data/`, ADR-0005); pyright strict is kept over Skyfield/jplephem through hand-written stubs in `backend/typings/` plus `pandas-stubs` (ADR-0006); planetary observer frames are our own IAU rotation model from the text PCK because Skyfield 1.55 only builds frames from binary PCKs (ADR-0007); the data is loaded by a background bootstrap thread so `/health` can report `starting` with progress (ADR-0008).
- Do not bump TypeScript to 7, npm to 12 or Python to 3.15, and do not remove the overrides, until the ADR revisit trigger fires. Never pre-releases.

## Conventions that matter most

- The API contract (`docs/brief.xml` api_contract) is binding. After any model or route change run `make types`; `docs/openapi.json` and `frontend/src/api/schema.d.ts` are generated and never hand-edited.
- Astronomy math lives only in `backend/src/skyapi/astro` and `frontend/src/sky/math`. The ENU -> Babylon mapping (East +X, Up +Y, North +Z) exists only in `frontend/src/sky/math/frames.ts`. UI components contain no astronomy math.
- Routers never import Skyfield: they validate, canonicalize (`api/canonical.py`), call `astro/` and serialize; errors are `ApiError` subclasses from `middleware/problem.py` (RFC 9457). Lifespan state is reached through `api/deps.py` (`get_sky_state` answers 503 until the bootstrap thread has published the `SkyState`, ADR-0008), never `app.state` or `on_event`. `astro/` never imports `api/`.
- Compute path operations are plain `def` (thread pool), never `async def`.
- Conventional Commits with a scope (`feat`, `fix`, `chore`, `docs`, `test`, `build`, `ci`, `refactor`); `make check` green before every commit; never push, never rewrite history, never create branches unless asked.
- No data files, secrets or generated caches in git (exceptions: the generated `docs/openapi.json`, `frontend/src/api/schema.d.ts` and `THIRD_PARTY_NOTICES.md`, and test fixtures). `data/` is gitignored; `.env` is never committed.
- Privacy: latitude and longitude are rounded to 0.01 degrees before any API call (OBS-7); logs carry no query strings or coordinates.
- No browser storage: no cookies, localStorage, sessionStorage or IndexedDB (OBS-8). The URL is the state.
- Every UI string goes through `t()` with a key present in both `en.json` and `fr.json`; `scripts/check_i18n.mjs` fails on missing or unused keys.
- Documentation changes ship in the same commit as the code they describe.

## Do not

- Push, change remotes, modify `LICENSE`, create branches, rewrite history, use `--no-verify`.
- `cat` or print a data file (ephemeris, MPCORB, catalogs): use `head -c`, `wc -c` or a Python one-liner.
- Add a dependency without an ADR; use `--legacy-peer-deps`; install pre-releases.
- Skip, weaken, delete or mark xfail a test to make a gate pass; fix the cause.
- Write `async def` compute routes; import Skyfield in a router; keep module-level mutable state; use `BaseHTTPMiddleware` (pure ASGI only); log a query string or coordinates; return a plain dict that may contain NaN (only a model turns NaN into `null`).
- Let Skyfield download anything (`load(...)`, `Loader.open`): every data file comes from `sky-data`; touch a Skyfield private name outside `astro/loader.py` (implementing `VectorFunction._at` in a subclass is the sanctioned hook); hand-edit `THIRD_PARTY_NOTICES.md` or an excerpt's provenance header.
- Import `@babylonjs/core` root or `@babylonjs/core/Legacy/legacy`; add `tailwind.config.js`; build Tailwind classes by concatenation.
- Use `useEffect` for derived state or `forwardRef`; use `!` non-null assertions or leave floating promises anywhere in `frontend/src`.
- Copy a `SKYAPI_*` value into a `VITE_*` variable.
- Let pytest inherit `.env` or the CI environment (`--env-file` only on run targets; the autouse `clean_env` fixture stays).
- Call Nominatim or JPL Horizons from tests or CI.

## File-specific rules

`.claude/rules/*.md` carry `paths:` frontmatter and apply to the files they name: `backend.md`, `backend-tests.md`, `frontend.md`, `sky-math.md`, `frontend-tests.md`, `tooling.md`, `docs.md`.

## Working agreement

- Plan first (plan mode) for every milestone, then implement in small steps; run the relevant tests after every step.
- Use subagents for independent, precisely described work with an explicit list of files they may touch; run an adversarial review at the end of each milestone.
- Consult official documentation (Context7, DeepWiki, or the vendor docs) before writing code against an uncertain API; never guess signatures.
- Keep the context small: compact after each milestone; `docs/plan.md` carries the state forward.
- Collect non-blocking questions under "Questions for the maintainer" in `docs/plan.md` and continue.
- Ask the human only when blocked by (brief l.513): a missing or unrecognisable LICENSE; no network access for a required download; a contradiction the precedence rule cannot resolve; a destructive action outside this repository.
