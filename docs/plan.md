# InterSidera: plan and durable memory

## 1. Status

- Milestone: **M0 Bootstrap done 2026-09-02**; next: M1 (plan mode first, per brief l.504).
- Next: M1 "Data pipeline and astronomy core", planned in plan mode once the M0 definition of done (section 6) is met and committed.
- Specification: `docs/brief.xml` v1.2 (587 lines). Precedence when sections conflict (brief l.11): legal and licensing > security and privacy > api_contract > architecture > [M] functional > non-functional budgets > [S] > style.

How to use this file (brief l.507: it is the durable memory across sessions):

- At the start of every session read sections 1, 6 and 12, then the sections a task touches (3 and 7 before changing a pin, 5 before touching a data URL, 4 and 10 before deviating from the brief).
- Tick checkboxes in section 6 and append one line to section 12 in the same commit as the change. Never rewrite past entries.
- Decide-and-continue for non-blocking questions: record the decision in section 10; questions that need the maintainer go to section 11. Ask the human only for the four blocking cases of brief l.513.
- Every deviation from the brief also gets a row in `docs/backlog.md`; every notable decision an ADR in `docs/decisions/`.

## 2. Environment snapshot (verified 2026-09-02)

| Item                   | Value                                                                                                                       | Consequence                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| OS / architecture      | Debian 13 (trixie) on WSL 2, **aarch64**                                                                                    | lockfiles must also carry `linux-x64-gnu` binaries for x86-64 CI; Playwright has debian13-arm64    |
| Cores / RAM / disk     | 10 / 7 GB / 944 GB free                                                                                                     | `fastapi run --workers` sized at M7; de441 (3.1 GB) fits                                           |
| Shell / make           | bash 5.2.37 / GNU Make 4.4.1                                                                                                | `SHELL := /bin/bash`, `.SHELLFLAGS := -eu -o pipefail -c`                                          |
| uv                     | 0.12.9                                                                                                                      | `uv init` packages by default; `uv lock --check` valid; `--directory` changes CWD, `--project` not |
| Python                 | CPython **3.14.7** via `uv python install 3.14` (3.15.0rc2 pre-release)                                                     | `.python-version` = `3.14`; `requires-python = ">=3.14,<3.15"`                                     |
| fnm / Node             | fnm 1.39.0; default v24.14.0; **v24.20.0** installed (npm 11.19.0)                                                          | jsdom 30 needs `^24.15.0`; Makefile uses `fnm exec --using=.node-version`, default left untouched  |
| git                    | 2.54.0; one commit on `master`; remote `origin` = github.com/j-about/InterSidera                                            | never push, never change remotes                                                                   |
| Docker / Compose       | 29.6.2 / v5.3.1 present                                                                                                     | M7 can build and run locally; the brief's "Docker may be absent" fallback is not needed            |
| Playwright system libs | **absent** (libnss3, libgbm1, libasound2, libwoff2dec, ...)                                                                 | browsers download but cannot launch until `sudo env "PATH=$PATH" fnm exec --using=24 npm --prefix frontend exec -- playwright install-deps` (manual, needs sudo)  |
| Network                | PyPI, npm, GitHub, codeberg, NAIF, CDS, `data.minorplanetcenter.net` reachable; **`www.minorplanetcenter.net` TCP timeout** | per-dataset URL override at M1 (section 5)                                                         |
| Repository at start    | `LICENSE` (MIT), `README.md` (one paragraph), untracked `docs/brief.xml`                                                    | LICENSE untouched, README appended, brief kept verbatim                                            |
| CI runner              | `ubuntu-latest` = Ubuntu 24.04 x64, Node 24.19.0 in the toolcache, Python 3.14.7                                            | `node-version-file: .node-version` resolves from the toolcache                                     |

## 3. Decision register

| #   | Decision                                                                                                                                                                                                                                                                                              | Reason                                                                                                                                            | Record                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| D1  | TypeScript `~6.0.3`, never 7.x                                                                                                                                                                                                                                                                        | TS 7.0.2 (Go port) has no compiler API until 7.1; typescript-eslint peer `<6.1.0`; tilde because a 6.1 would break that peer on any `npm install` | ADR-0001, backlog B-01, B-02             |
| D2  | ESLint `^10.9.1` + npm `overrides` (`eslint-plugin-jsx-a11y -> eslint: "$eslint"`, `openapi-typescript -> typescript: "$typescript"`); never `--legacy-peer-deps`                                                                                                                                     | stale peers (jsx-a11y `^3..^9`, issue #1075; openapi-typescript `^5.x`); ESLint 9 would violate "latest stable"                                   | ADR-0002, backlog B-03                   |
| D3  | `.node-version` = `24`; `make setup` runs `fnm install 24`; bundled npm 11.19 (no npm 12); `engines.node >= 24.15.0`; `frontend/.npmrc` `engine-strict=true`                                                                                                                                          | jsdom 30 floor `^24.15.0`; CI and local both resolve `24` to a >= 24.15 release                                                                   | backlog B-10                             |
| D4  | `requires-python = ">=3.14,<3.15"`; `.python-version` = `3.14` at root and in `backend/`                                                                                                                                                                                                              | uv ignores version files beyond the project boundary; `<3.15` keeps the lock unforked and blocks 3.15 silently                                    | backlog B-13                             |
| D5  | `fastapi[standard-no-fastapi-cloud-cli]>=0.141,<1`                                                                                                                                                                                                                                                    | drops the hosted-SaaS CLI (brief l.36 spirit) and `fastar`; same `fastapi dev/run`, uvicorn[standard], httpx                                      | ADR-0003, backlog B-17                   |
| D6  | Backend runtime deps at M0: fastapi extra + pydantic-settings only; skyfield/numpy/pandas/pyarrow pinned in section 7, added at M1                                                                                                                                                                    | "create only what the current milestone needs" (brief l.337)                                                                                      | section 7                                |
| D7  | Frontend runtime deps at M0: react, react-dom, i18next, react-i18next; babylon/zustand/lucide installed at M3/M4                                                                                                                                                                                      | the placeholder text must go through `t()` (UX-1) so `check_i18n` has real keys                                                                   | section 7                                |
| D8  | Implied tooling deps: `@testing-library/dom`, `@eslint/js`, `globals`, `@types/react`, `@types/react-dom`, `@types/node ^24`; dev `httpx2>=2.12,<3`; `oxlint` and `eslint-plugin-react-refresh` removed from the scaffold; `@vitest/coverage-v8` at M3                                                | required peers and types; `filterwarnings = ["error"]` makes httpx2 necessary (matches FastAPI upstream)                                          | ADR-0004, backlog B-11, B-15, B-18, B-22 |
| D9  | `uv run --directory backend ...`, `npm --prefix frontend ...`, Node via `fnm exec --using=$(CURDIR)/.node-version`; `--env-file $(CURDIR)/.env` only on run targets                                                                                                                                   | `make check` stays hermetic from a clean clone (brief l.564); `.env` never leaks into tests; pydantic-settings has no `env_file`                  | Makefile, `.claude/rules/tooling.md`     |
| D10 | `[tool.fastapi] entrypoint = "skyapi.main:app"` + `app` exposed as a lazily built module attribute (PEP 562) under the factory; importing `skyapi.main` reads no environment                                                                                                                                                                                                 | fastapi-cli 0.0.32 has no `--factory`; the M0 DoD literally says `fastapi dev`                                                                    | ADR-0003                                 |
| D11 | Lifespan-state pattern from day one: `lifespan.py` yields a `LifespanState` TypedDict, `state.py` holds a frozen `SkyState` (M0 field `version`), `api/deps.py` exposes `get_sky_state(request)`; no `app.state`, no `on_event`                                                                       | Starlette 1.x removed non-lifespan hooks; M2 adds fields without changing the pattern                                                             | `docs/architecture.md`                   |
| D12 | No CORS or GZip middleware at M0 (M2, brief l.456); the Vite proxy makes development same-origin                                                                                                                                                                                                      | restraint                                                                                                                                         | section 6, M2                            |
| D13 | `make check` = brief l.421 with three hardenings: `dump_openapi --out <abs path>`, `npm --prefix frontend run gen:types` (no root `npx`), drift gate = `git ls-files --error-unmatch` then `git diff --exit-code`                                                                                     | determinism, supply chain, non-vacuous gate (`git diff` ignores untracked files)                                                                  | backlog B-04, B-05, B-06                 |
| D14 | Vitest config in `vite.config.ts`; `globals: true`; jsdom; explicit include/exclude; `npm run test` = `vitest run` (no coverage until M3)                                                                                                                                                             | brief l.370 layout; Vitest 4 default `exclude` shrank to `node_modules`/`.git`                                                                    | section 6, M3                            |
| D15 | `basicSsl()` only when `command === 'serve' && mode === 'development' && !isPreview`; `vite preview` HTTP on 4173 for Playwright; proxy target `http://127.0.0.1:8000`; no `server.host: true`                                                                                                        | avoids HTTPS in e2e/CI; `localhost` may resolve to `::1`; LAN exposure is opt-in and documented at M5                                             | `docs/dev-wsl2.md`                       |
| D16 | CI: jobs `backend` and `frontend`; split drift gate (backend diffs `openapi.json`, frontend regenerates `schema.d.ts`); backend job runs `setup-node` and caches `~/.cache/pyright-python`; workflow env `SKYAPI_AUTO_FETCH=false`, `SKYAPI_EPHEMERIS=de440s.bsp`; e2e/docker jobs as comments        | pyright (PyPI) is a Node wrapper needing Node and one network fetch; logically equivalent gate                                                    | backlog B-16, B-19                       |
| D17 | `SKYAPI_DATA_DIR` code default `Path("../data")` (relative to `backend/`, the CWD of every backend command)                                                                                                                                                                                           | `Path("data")` would collide with the committed `backend/data/`                                                                                   | `settings.py`, `.env.example`            |
| D18 | `Settings` declares all eleven `SKYAPI_` fields (brief l.397); `CORS_ORIGINS` comma-separated via `Annotated[list[str], NoDecode, BeforeValidator(_split_csv)]`; `WORKERS` default 1                                                                                                                  | pydantic-settings JSON-decodes lists by default; CSV is shell- and compose-friendly                                                               | `.env.example`                           |
| D19 | ESLint: `defineConfig`/`globalIgnores`; `strictTypeChecked` + `stylisticTypeChecked` with `projectService: true`; react-hooks flat recommended; jsx-a11y `flatConfigs.recommended`; `no-restricted-imports` for the Babylon root and `Legacy`. Consequence: no `!` and no floating promises in `src/` | strict from day one avoids churn; symmetric with pyright strict                                                                                   | `.claude/rules/frontend.md`              |
| D20 | Tests at M0: `tests/api/test_health.py`, `tests/api/test_openapi_snapshot.py`, `tests/unit/test_settings.py`; autouse `clean_env` fixture deletes every `SKYAPI_*`; `--import-mode=importlib`                                                                                                         | settings parsing is the only non-trivial M0 code; the snapshot makes the committed json meaningful                                                | `.claude/rules/backend-tests.md`         |
| D21 | Placeholder page is static (`t('app.title')`, `t('app.tagline')`), no fetch, no `api/client.ts` (M3); the proxy is proven by `curl` and, when browsers launch, by the e2e smoke                                                                                                                       | restraint; `api/client.ts` is M3 scope                                                                                                            | section 6, M3                            |
| D22 | `index.html`: lang, charset, viewport with `viewport-fit=cover`, `<title>InterSidera</title>`, own minimal `favicon.svg`; manifest and referrer meta at M4/M6                                                                                                                                         | replace Vite-branded assets                                                                                                                       | section 6, M4                            |
| D23 | Docs at M0: full `docs/plan.md`; stubs for `architecture.md`, `api.md`, `data.md`, `dev-wsl2.md`, `testing.md`; `backlog.md` started; ADR-0001..0004; README quickstart appended; no `THIRD_PARTY_NOTICES.md` (generated by M1's registry)                                                            | "docs skeleton" (brief l.441)                                                                                                                     | backlog B-21                             |
| D24 | Data-source corrections (section 5) recorded in `docs/plan.md` and `docs/data.md`, not coded at M0                                                                                                                                                                                                    | M1 scope                                                                                                                                          | section 5                                |
| D25 | ruff `E501` stays enabled (brief l.396 literal, no global ignore); unbreakable URLs get `# noqa: E501`                                                                                                                                                                                                | avoids an undocumented deviation                                                                                                                  | `.claude/rules/backend.md`               |
| D26 | `scripts/*.py` (M1+) linted with the backend ruff config; `scripts/check_i18n.mjs` formatted by a config-free prettier run (`SCRIPTS_PRETTIER` in the Makefile, mirrored in CI) and syntax-checked with `node --check`; ESLint is not used on `scripts/` (observed 2026-09-02: ESLint 10 refuses files outside its base path)                                  | the i18n gate script must not be the one unlinted file                                                                                            | backlog B-23                             |
| D27 | Both halves of the contract gate build the app the same way: `dump_openapi.main()` calls `create_app(default_settings())`, which ignores the environment; nothing settings-dependent may enter the OpenAPI document                                                                                                               | prevents the pytest half and the `make types` half from disagreeing later                                                                         | `.claude/rules/backend.md`               |

## 4. Deviations from the brief's wording

Each row also exists in `docs/backlog.md` with the same identifier.

| ID   | Brief says                                                  | We do                                                                                                  | Reason                                                                                          |
| ---- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| B-01 | caret ranges in `package.json` (l.32)                       | `typescript: ~6.0.3`                                                                                   | typescript-eslint peer `<6.1.0` (ADR-0001)                                                      |
| B-02 | TypeScript latest stable (l.34)                             | TypeScript 6.0.x; 7.x upgrade path recorded                                                            | TS 7 has no compiler API until 7.1 (ADR-0001)                                                   |
| B-03 | declared peers                                              | npm `overrides` for `eslint-plugin-jsx-a11y` and `openapi-typescript`                                  | stale upstream peers; ESLint 9 fallback would violate "latest stable" (ADR-0002)                |
| B-04 | `npx openapi-typescript ...` (l.422)                        | `npm --prefix frontend run gen:types`                                                                  | a root `npx` fetches a floating version without prompting in CI                                 |
| B-05 | `dump_openapi > docs/openapi.json` (l.422)                  | `dump_openapi --out $(CURDIR)/docs/openapi.json`                                                       | uv stdout purity not guaranteed; the tool writes the file itself                                |
| B-06 | `git diff --exit-code <files>` (l.421)                      | `git ls-files --error-unmatch` first, then `git diff --exit-code`                                      | `git diff` ignores untracked files, the gate would be vacuous before the first commit           |
| B-07 | `tsconfig.json` only (l.370)                                | `tsconfig.json` + `tsconfig.app.json` + `tsconfig.node.json` (project references)                      | the create-vite 9.2.0 template layout; `e2e/**` and `playwright.config.ts` in the node project  |
| B-08 | `npm create vite@latest` (l.441)                            | `npm create vite@9.2.0`                                                                                | reproducible scaffold; template drift verified by diff                                          |
| B-09 | plain `openapi-typescript` invocation                       | `--alphabetize`                                                                                        | diff-stable generated file for the drift gate                                                   |
| B-10 | none                                                        | `frontend/.npmrc` `engine-strict=true`                                                                 | fails fast on an old Node instead of an EBADENGINE warning; first thing to relax if CI diverges |
| B-11 | dev deps list (l.395), "httpx comes with fastapi[standard]" | `filterwarnings = ["error"]` and `httpx2>=2.12,<3` in the dev group                                    | Starlette 1.6 `TestClient` warns on httpx 0.x; FastAPI upstream did the same (ADR-0004)         |
| B-12 | `i18n/ index.ts en.json fr.json` (l.382)                    | plus `i18n/resources.d.ts`                                                                             | typed `t()` keys through `CustomTypeOptions`                                                    |
| B-13 | `.python-version` at the root (l.343)                       | duplicated in `backend/`                                                                               | uv does not search beyond the project boundary; setup-uv `working-directory: backend`           |
| B-14 | `>=x.y,<next-major` (l.32)                                  | `ruff>=0.16.5,<0.17`                                                                                   | a 0.x tool bounded at the minor: rule renames land in minors                                    |
| B-15 | create-vite output                                          | `oxlint`, `.oxlintrc.json` and `eslint-plugin-react-refresh` removed                                   | not in the brief's list (l.405); ADR if react-refresh is wanted at M4                           |
| B-16 | CI `backend` job without Node (l.427)                       | `actions/setup-node@v7` + `actions/cache@v6` on `~/.cache/pyright-python` in the backend job           | the PyPI `pyright` is a Node wrapper that downloads the npm package on first run                |
| B-17 | `fastapi[standard]` (l.33, l.395)                           | `fastapi[standard-no-fastapi-cloud-cli]`                                                               | drops the hosted SaaS CLI and `fastar` (ADR-0003)                                               |
| B-18 | dev deps list (l.405)                                       | `@testing-library/dom`, `@eslint/js`, `globals`, `@types/react`, `@types/react-dom`, `@types/node ^24` | hard peers and ambient types (TS 6 defaults `types` to `[]`) (ADR-0004)                         |
| B-19 | `make types` + one `git diff` in CI (l.421)                 | backend job diffs `docs/openapi.json`; frontend job regenerates `schema.d.ts` from the committed json  | jobs are independent; logically the same gate                                                   |
| B-20 | `[project.scripts] sky-data = ...` (l.394)                  | added at M1 with the module                                                                            | `uv sync` fails on a missing entry-point module                                                 |
| B-21 | `THIRD_PARTY_NOTICES.md` (l.345)                            | generated at M1 from the data registry                                                                 | nothing to list before the registry exists                                                      |
| B-22 | dev deps list (l.405)                                       | `@vitest/coverage-v8` exact `4.1.11` added at M3                                                       | vitest peers the exact version; the coverage gate starts at M3 (ADR-0004 amendment)             |
| B-23 | `scripts/*.py` linting unspecified                          | ruff recipe line `--config backend/pyproject.toml scripts` added at M1 with the first script           | no unlinted Python                                                                              |
| B-24 | Playwright configured at M0 (l.441)                         | browsers installed; launching needs `sudo env "PATH=$PATH" fnm exec --using=24 npm --prefix frontend exec -- playwright install-deps` (manual)                        | WSL system libraries absent; sudo is outside the agent's remit                                  |
| B-25 | `scripts/check_i18n.mjs` (l.388, l.411), no lint scope stated | `node --check` + config-free prettier (`SCRIPTS_PRETTIER`), mirrored in CI; no ESLint on `scripts/` | ESLint 10 refuses files outside its base path (`frontend/`); prettier would resolve the Tailwind plugin from the working directory |
| B-26 | `fastapi dev` for development (l.95) | accept the fastapi-cli 0.0.32 banner printing `/docs` although `docs_url` is `/api/v1/docs` | cosmetic upstream banner; Swagger UI lives at `/api/v1/docs`; recheck at M6 |
| B-27 | Makefile targets (l.346), frontend/backend files (l.355, l.370) | helper targets `help`, `format`, `check-backend`/`-frontend`/`-i18n`/`-contract`; `frontend/.prettierignore`; `backend/src/skyapi/py.typed` | sub-targets keep `check` readable and mirror the CI steps; `format` is the fix side of `check`; PEP 561 marker; generated files excluded from prettier |

## 5. Corrections to the brief's data sources

Verified 2026-09-02 (details in `docs/data.md`; coded at M1).

| Dataset                             | Brief says                                                                  | Verified                                                                                                                                                                                                                                                                                      | Evidence                                                                                                                                                                                           | Action (M1)                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| JPL ephemerides                     | de441 ~3.1 GB, de440s ~32 MB                                                | `de440s.bsp` 32,726,016 B; `de441.bsp` 3,307,878,400 B; `de440.bsp` 119,799,808 B (1550..2650) is a useful middle tier the brief omits                                                                                                                                                        | <https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de440s.bsp> (same size on <https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp>)                                               | sizes confirmed; record de440.bsp as an option (its range equals the Moon PCK coverage)                                  |
| `pck00011.tpc`                      | < 1 MB, verify parsing, fall back to `pck00010.tpc`                         | 131,226 B; `pck00010.tpc` 126,143 B; no known Skyfield parse failure (`read_text` only checks the KPL magic); do not confuse with `pck00011_n0066.tpc`                                                                                                                                        | <https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc>                                                                                                                              | keep the fallback URL in the registry, low risk                                                                          |
| Moon frame kernel                   | `pck/moon_de440_220930.tf`                                                  | superseded (in `fk/satellites/a_old_versions/`); current `fk/satellites/moon_de440_250416.tf`, 19,478 B; frame `MOON_ME_DE440_ME421` (31001) correct                                                                                                                                          | <https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_de440_250416.tf>                                                                                                            | fix URL and directory; document the NAIF rename procedure (`sky-data update`)                                            |
| Moon PCK `moon_pa_de440_200625.bpc` | ~70 MB                                                                      | 12,863,488 B; coverage 1549-12-31..2650-01-25 TDB; two segments for body 31008 split at 2426-02-16; **Skyfield #952**: `read_binary` keeps the last segment per body, frame fails before 2426                                                                                                 | <https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/moon_pa_de440_200625.bpc>; <https://github.com/skyfielders/python-skyfield/issues/952> (and #960)                                          | fix size; date-aware segment selector; pre-2426 regression test; `/meta.observers.moon.coverage_tt` from the kernel      |
| Hipparcos                           | `skyfield.data.hipparcos.URL`                                               | `https://cdsarc.cds.unistra.fr/ftp/cats/I/239/hip_main.dat`, uncompressed, 53,316,318 B; Skyfield's source warns the URL is unstable (VizieR gunzipped it in 2020)                                                                                                                            | <https://raw.githubusercontent.com/skyfielders/python-skyfield/1.55/skyfield/data/hipparcos.py>                                                                                                    | SHA-256 pin; fail loudly on a 404 body instead of caching it                                                             |
| HYG                                 | v4.2 at `data/hyg/v42/hyg_v42.csv.gz`                                       | path gone; current **v4.4** at `data/hyg/CURRENT/hyg_v44.csv.gz`; **Git LFS**: `/raw/branch/` returns a 133-byte pointer, `/media/branch/main/` serves 13,636,362 B, sha256 `00b349893b9a53106dd488d8371e8d2fa586043e500bb3cdb8bff3931682197d`; CC BY-SA 4.0; v4.2 still at `data/hyg/OLDER/` | <https://codeberg.org/astronexus/hyg/media/branch/main/data/hyg/CURRENT/hyg_v44.csv.gz>; <https://codeberg.org/astronexus/hyg/raw/branch/main/README.md>                                           | use v4.4 (default decision, maintainer question 2); media URL; size sanity check > 1 MB; attribution names v4.4          |
| OpenNGC                             | `addendum/addendum.csv`                                                     | 404; `database_files/NGC.csv` 3,876,622 B; `database_files/addendum.csv` 17,484 B; CC BY-SA 4.0 (REUSE `LICENSES/`)                                                                                                                                                                           | <https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/addendum.csv>                                                                                                         | fix path                                                                                                                 |
| Stellarium constellations           | `skycultures/modern/index.json`, CC BY-SA 4.0 per `description.md`          | exists, 205,767 B; `description.md` 53,269 B declares "Text and data: CC BY-SA 4.0"; Skyfield's docstring names `modern_st` (a different figure set, 94,299 B); `index.json` also embeds 781 IAU edges (B1875)                                                                                | <https://raw.githubusercontent.com/Stellarium/stellarium/master/skycultures/modern/index.json>; <https://raw.githubusercontent.com/Stellarium/stellarium/master/skycultures/modern/description.md> | keep `modern` (maintainer question 3); fetch `description.md` to record the license; comment why not `modern_st`         |
| d3-celestial bounds                 | < 1 MB, BSD-3                                                               | 40,714 B; BSD-3-Clause confirmed                                                                                                                                                                                                                                                              | <https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.bounds.json>                                                                                                     | none                                                                                                                     |
| MPC MPCORB / CometEls               | `skyfield.data.mpc.MPCORB_URL` / `COMET_URL` (`www.minorplanetcenter.net`)  | `www` host **unreachable** (TCP timeout on 80 and 443); same paths on `data.minorplanetcenter.net`: `MPCORB.DAT.gz` 93,580,511 B, `CometEls.txt` 162,690 B; Skyfield `iokit` has no gzip support                                                                                              | <https://data.minorplanetcenter.net/iau/MPCORB/MPCORB.DAT.gz>; <https://data.minorplanetcenter.net/iau/MPCORB/CometEls.txt>                                                                        | per-dataset URL override defaulting to the `data.` host; **gunzip before** `load_mpcorb_dataframe`; offline fixture path |
| `GM_SUN`                            | "GM_SUN" (l.316) and `GM_SUN_Pitjeva_2005_km3_s2` (l.530)                   | no `GM_SUN` symbol; `GM_SUN_Pitjeva_2005_km3_s2` and `GM_SUN_DE440_km3_s2` (new in 1.55, used by Skyfield's own docs)                                                                                                                                                                         | <https://raw.githubusercontent.com/skyfielders/python-skyfield/1.55/skyfield/constants.py>                                                                                                         | use `GM_SUN_DE440_km3_s2` everywhere (Q5)                                                                                |
| IAU-CSN fallback                    | CC BY 4.0 proper names only                                                 | reachable, 71,800 B; hosted on a personal university page                                                                                                                                                                                                                                     | <https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt>                                                                                                                                         | keep HYG primary; record the fallback                                                                                    |
| Nominatim                           | browser-direct, <= 1 req/s, attribution, never cached or proxied by the API | policy also **forbids client-side autocomplete**, requires an identifying Referer/UA, recommends a proxy plus caching, and permits the public API only after "a deliberate, informed decision" by the developer                                                                               | <https://operations.osmfoundation.org/policies/nominatim/>                                                                                                                                         | submit-only search at M4 (brief already says so); proxy tension is maintainer question 1                                 |

## 6. Milestones

Rules (brief l.437): milestones run in order; each ends with `make check` green, documentation updated and a local commit. Items are ticked in the commit that completes them.

### M0 Bootstrap (brief l.439-444), done 2026-09-02

Tasks:

- [x] Read LICENSE (MIT) and README.md; check tool availability and versions (uv, fnm, node, python, docker)
- [x] Pin `.python-version` (`3.14`, root and `backend/`) and `.node-version` (`24`)
- [x] Write `CLAUDE.md` (< 150 lines) and `docs/plan.md`; `.claude/rules/*.md`
- [x] Backend packaged app with uv exposing `/api/v1/health` only (settings, lifespan state, health router, `dump_openapi`, tests)
- [x] Frontend from create-vite 9.2.0 (react-ts) plus Tailwind 4, ESLint, Prettier, Vitest and Playwright configured; placeholder page through `t()`
- [x] Makefile with the twelve targets (`data`, `up`, `down` print "arrives in M1/M7")
- [x] `.editorconfig`, `.gitattributes`, `.gitignore`, `.env.example`
- [x] CI workflow with the `backend` and `frontend` jobs
- [x] Docs skeleton: stubs, `backlog.md`, ADR-0001..0004, README quickstart

Amended items (verified facts, section 3):

- [x] `frontend/package-lock.json` contains the three `linux-x64-gnu` binaries; `lockfileVersion` 3; `npm ls canvas` empty (observed: all present, canvas absent)
- [x] `docs/openapi.json` and `frontend/src/api/schema.d.ts` generated and committed so the drift gate is meaningful from day one
- [x] Zero ERESOLVE and zero EBADENGINE at `npm install`; whether the overrides were strictly required recorded here (observed: both strictly required, npm 11.19.0 hard-fails with ERESOLVE without each; zero warnings with them)
- [x] pyright first run downloads its npm package (network once); `~/.cache/pyright-python` cached in CI (observed: first run downloaded the package; `actions/cache@v6` step present)
- [x] Playwright browsers installed (chromium, webkit); launch blocked until the manual `sudo env "PATH=$PATH" fnm exec --using=24 npm --prefix frontend exec -- playwright install-deps` (B-24) (observed: chromium 151 and webkit 26.5 downloaded; launch blocked, e2e not executed at M0)

Definition of done:

- [x] `make check` passes on the skeleton (2026-09-02: exit 0; 14 pytest, 1 vitest, i18n 2 keys)
- [x] `fastapi dev` answers `/api/v1/health` (`200`, `cache-control: no-store`, `{"status":"ready","version":"0.1.0"}`; `/health` at the root is 404) (verified with `make dev-api` and curl; log `Using import string: skyapi.main:app`)
- [x] The Vite dev server shows the placeholder page and proxies `/api` (`curl -sk https://localhost:5173/api/v1/health`) (verified: HTTPS 200 with `<title>InterSidera</title>`, proxied health 200, plain HTTP refused)
- [x] `.github/workflows/ci.yml` reviewed line by line (checklist: latest majors, `working-directory`, root-relative `node-version-file`/`cache-dependency-path`, `cache-dependency-glob` relative to `working-directory`, `permissions: contents: read`, no `pull_request_target`, `SKYAPI_AUTO_FETCH=false`, nothing touches de441/MPCORB/Nominatim/Horizons) (reviewed 2026-09-02; both job bodies reproduced from a scratch copy of the index, every step exit 0)
- [x] Commit `chore: bootstrap monorepo (backend, frontend, tooling, ci)`; never push

### M1 Data pipeline and astronomy core (brief l.446-453)

Tasks:

- [ ] `sky-data` CLI: registry (`backend/data/data_files.toml`: url, size, sha256, license, attribution), resumable downloads with progress, `fetch`, `update`, `verify`, `build-caches`, `status`; `THIRD_PARTY_NOTICES.md` generated from the registry
- [ ] `astro/`: timescale and ephemeris loading (env-selected file), Earth and planetary observers (PCK and Moon frames), horizon quaternions with sign continuity, body samples (direction, distance, magnitude, phase, angular diameter), Sun direction, refraction reference helper, minor-body orbits and search index
- [ ] `catalogs/`: SKYS binary builder from Hipparcos plus the HYG name index, OpenNGC subset builder, constellations (Skyfield 1.55 parser, boundaries, Latin names and genitives; translated names in the frontend resource files keyed by IAU abbreviation)
- [ ] Tests: unit tests on de440s; `scripts/generate_fixtures.py` calling the JPL Horizons API with the fixtures committed; conformance tests within tolerance; hypothesis tests for the SKYS round-trip

Amended items:

- [ ] First task: `import skyfield` + de440s load on CPython 3.14.7 (Skyfield 1.55 is not classified for 3.14, PR #1100 open); pandas 3 smoke test of `load_mpcorb_dataframe` (`dtypes=` kwarg) and `load_comets_dataframe`; fallback `pandas>=2.3,<3` with an ADR only if it fails
- [ ] MPC: per-dataset URL override defaulting to `data.minorplanetcenter.net`; gunzip before `load_mpcorb_dataframe`; offline fixture path; `str`-dtype columns in the Parquet cache
- [ ] HYG v4.4 through the LFS media URL with a > 1 MB size check; OpenNGC `database_files/` paths
- [ ] Moon: `fk/satellites/moon_de440_250416.tf` (19,478 B) and `pck/moon_pa_de440_200625.bpc` (12.3 MB, coverage 1549-12-31..2650-01-25 TDB); Skyfield #952 date-aware segment selector; pre-2426 regression test (for example 2019-12-20); documented kernel rename procedure
- [ ] `GM_SUN_DE440_km3_s2` for every Kepler orbit (Q5)
- [ ] `backend/data/` packaging decision (outside `src/`, not in the wheel): settings path + Dockerfile COPY, or move under `src/skyapi/data/` (Q16)
- [ ] `actions/cache@v6` for `data/de440s.bsp` in the backend CI job, key on `backend/data/data_files.toml`
- [ ] `ruff check --config backend/pyproject.toml scripts` recipe line for `scripts/*.py`
- [ ] `[project.scripts] sky-data = "skyapi.cli.sky_data:main"` added with the module
- [ ] `de440.bsp` (114 MB, 1550..2650) documented as a middle tier in `.env.example` and `docs/data.md`
- [ ] Hipparcos SHA-256 pin; loud failure on a 404 body; `B-V` read from `hip_main.dat`
- [ ] Stellarium `modern`: fetch `description.md` and record the declared license; comment why not `modern_st`

Definition of done:

- [ ] coverage >= 90 % on `astro/` and `catalogs/` (100 % on `astro/quaternions.py` and `catalogs/formats.py`)
- [ ] `sky-data status` lists every file with its license
- [ ] `docs/data.md` written
- [ ] Commit `feat(backend): data pipeline and astronomy core`

### M2 API v1 (brief l.455-460)

Tasks:

- [ ] Every endpoint of the API contract except `/sky/events` ([L]) with canonicalization, caching headers and ETags, GZip, RFC 9457 errors, rate limiting, lifespan bootstrap with health states, complete OpenAPI metadata, `docs/openapi.json` and `make types`
- [ ] Tests: API tests for every endpoint including error paths and caching headers; OpenAPI snapshot; `scripts/bench_api.py` measuring `/sky/frame` latency against the budget

Amended items:

- [ ] `GZipMiddleware(minimum_size=1024)` (Starlette 1.6: `application/octet-stream` is compressed, 206 responses are not, large bodies compress on a worker thread)
- [ ] `CORSMiddleware` from `settings.cors_origins` (dev origin `https://localhost:5173`)
- [ ] `/health` `starting` with download progress and `503` + `Retry-After` while not ready; `degraded` when optional data is missing
- [ ] Pin `starlette>=1.6,<1.7` only if the FastAPI 0.141.1 + Starlette 1.6.0 resolution breaks (R6)
- [ ] `Server-Timing` header on frame responses; request-id middleware; JSON logging without coordinates
- [ ] `api_version` in `/meta` follows semver of the contract

Definition of done:

- [ ] latency budgets met on the development machine and recorded in `docs/testing.md`
- [ ] `docs/api.md` complete including the SKYS byte-layout table
- [ ] Commit `feat(api): v1 endpoints, caching, rate limiting and health`

### M3 Sky engine (brief l.462-468)

Tasks:

- [ ] Generated API types and client; catalog loaders (SKYS parser, DSO, constellations, star index) with ETag handling
- [ ] `sky/math` pure modules (quaternion, frames, interpolation, proper motion, refraction, time) with fixture parity tests
- [ ] `SkyEngine`: engine selection (WebGPU or WebGL2), star layer with custom shaders on both backends, bodies layer with phase shading, horizon, grids, ecliptic, meridian, camera controls and field of view, simulation clock, frame buffer and fetch policy, URL state store

Amended items:

- [ ] `@vitest/coverage-v8` exact `4.1.11`; `coverage.include` on `src/sky/math/**` and `src/state/url.ts` with 100 % thresholds (ADR-0004 amendment)
- [ ] `build.rolldownOptions.output.codeSplitting` for the Babylon vendor chunk (never `manualChunks`)
- [ ] `api/client.ts` single fetch layer with backoff; `@babylonjs/core ^9.23.0`, `zustand ^5.0.15` installed
- [ ] WebGPU headless Chromium flags measured on arm64 and x64 (`--enable-unsafe-webgpu`, `--use-angle=swiftshader` are unverified); WebGL2 needs nothing (Playwright passes `--enable-unsafe-swiftshader`)
- [ ] CI `e2e` job: `needs: [backend, frontend]`, API on de440s, `playwright install --with-deps chromium`, `actions/upload-artifact@v7` with `if: ${{ !cancelled() }}` and `if-no-files-found: ignore`
- [ ] `window.__sky` debug hook in dev and test builds only
- [ ] TS 6 `noUncheckedSideEffectImports` verified against Babylon side-effect imports and `?raw` shaders (R13)

Definition of done:

- [ ] parity tests pass; Playwright sanity checks through the debug hook (Greenwich: Polaris altitude equals the latitude within 1 degree; a planet within 1 arcmin of `/sky/altaz`)
- [ ] 60 fps on the development machine with the full catalog
- [ ] Commit `feat(frontend): sky engine, catalogs and core rendering`

### M4 User interface and features (brief l.470-474)

Tasks:

- [ ] Observer panel (geolocation, manual entry, Nominatim, other bodies, presets), time editor and transport controls, layer toggles and magnitude override, deep-sky and minor-bodies layers, constellations (lines, names, boundaries), labels, selection and details panel, unified search, atmosphere and refraction toggles, night mode, i18n FR/EN, share link, About and credits, degraded states, responsive layout, accessibility

Amended items:

- [ ] `public/manifest.webmanifest` and icons; `<meta name="referrer" content="strict-origin-when-cross-origin">`
- [ ] Nominatim: submit-only search (no type-ahead), at most one request in flight and >= 1 s apart, `format=jsonv2`, `limit=5`, `accept-language`, `email=` from `/meta.geocoder`, attribution "(c) OpenStreetMap contributors", disable toggle, 403/429 handling
- [ ] e2e assertion that no cookies, localStorage, sessionStorage or IndexedDB are used (OBS-8)
- [ ] `lang` URL parameter, language from `navigator.languages`, manual toggle; `constellations.<abbr>` keys in both languages
- [ ] `lucide-react ^1.39.0` installed; `eslint-plugin-react-refresh` reconsidered with an ADR if HMR export rules are wanted

Definition of done:

- [ ] every [M] requirement outside augmented reality implemented
- [ ] e2e suite green on desktop and mobile emulation; `check_i18n` green; jsx-a11y clean
- [ ] Commit `feat(frontend): user interface, search, constellations and i18n`

### M5 Augmented reality (brief l.476-480)

Tasks:

- [ ] Sensor mode (camera video, orientation, permissions, calibration, compass accuracy), WebXR mode [S], field-of-view matching, graceful degradation; orientation-to-camera math in `sky/math/orientation.ts` with fixture tests
- [ ] `docs/dev-wsl2.md` phone-testing procedure (HTTPS, LAN exposure, certificate trust); manual AR checklist in `docs/testing.md`

Definition of done:

- [ ] unit tests on the orientation math pass
- [ ] e2e suite still passes with AR code split into lazy chunks
- [ ] manual checklist written and flagged for the human to run on a real device
- [ ] Commit `feat(frontend): augmented reality (sensor and WebXR modes)`

### M6 Hardening (brief l.482-486)

Tasks:

- [ ] Performance passes (bundle analysis, frame-time profiling, backend benchmark), accessibility audit, CSP and security headers, error paths, i18n completeness, ADRs for every notable decision, README quickstart, documentation review, backlog
- [ ] Dependency audits in CI (`pip-audit`, `npm audit`) with a documented allow-list (brief l.276)
- [ ] Revisit ADR-0001 and ADR-0002 triggers (TypeScript 7.1 API, jsx-a11y ESLint 10 peer)

Definition of done:

- [ ] every budget in non_functional_requirements measured and recorded in `docs/testing.md`, deviations explained
- [ ] Commit `chore: hardening, performance and documentation`

### M7 Delivery (brief l.488-492)

Tasks:

- [ ] Backend Dockerfile (multi-stage with uv, `UV_COMPILE_BYTECODE=1`, `uv sync --locked --no-dev`, non-root user, healthcheck on `/api/v1/health`), frontend Dockerfile (build stage, then nginx with `nginx.conf`: SPA fallback, immutable cache headers for hashed assets, `/api` proxy, security headers, optional TLS), `compose.yaml` (services `api` and `web`, `SKY_DATA_DIR` bind mount for DATA_DIR, healthchecks, `.env`), CI `docker` job, release checklist

Amended items:

- [ ] `docker/setup-buildx-action@v4` + `docker/build-push-action@v7` (`push: false`, `platforms: linux/amd64`, `cache-from/to: type=gha`)
- [ ] `SKY_DATA_DIR=./data` uncommented in `.env.example`; compose sets `SKYAPI_DATA_DIR=/data`
- [ ] `FROM python:3.14-slim` + `COPY --from=ghcr.io/astral-sh/uv:0.12.9 /uv /uvx /bin/`; no compiler layer (all wheels are cp314 manylinux on amd64 and arm64)
- [ ] `backend/data/` COPY or packaging per the M1 decision (Q16)
- [ ] `make up` / `make down` implemented

Definition of done:

- [ ] from a clean clone, `docker compose run --rm api sky-data fetch` then `docker compose up` reaches `ready` and the app works end to end
- [ ] the acceptance checklist (brief l.560-586) passes and is recorded here
- [ ] Commit `build: docker compose, images and release checklist`

## 7. Reserved pins for later milestones

Verified on the registries 2026-09-02; re-check at the milestone that installs them.

| Package                  | Range                                                                                                                                            | Milestone | Notes                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `skyfield`               | `>=1.55,<2`                                                                                                                                      | M1        | 1.55 (2026-08-07): `parse_constellations_json`, `GM_SUN_DE440_km3_s2`; pure Python; not classified for 3.14 (smoke test first) |
| `numpy`                  | `>=2.5,<3`                                                                                                                                       | M1        | 2.5.2, cp314 manylinux_2_28 wheels on aarch64 and x86_64                                                                       |
| `pandas`                 | `>=3.0,<4`                                                                                                                                       | M1        | 3.0.5; fallback `>=2.3,<3` with an ADR only if the MPC smoke test fails                                                        |
| `pyarrow`                | `>=25.0,<26`                                                                                                                                     | M1        | 25.0.1; Parquet cache and pandas 3 string backing                                                                              |
| `jplephem` (transitive)  | `>=2.24,<3` if pinned                                                                                                                            | M1        | pin explicitly only if the #952 workaround touches DAF internals                                                               |
| `starlette` (transitive) | `>=1.6,<1.7` if needed                                                                                                                           | M2        | only if FastAPI 0.141.1 + Starlette 1.6.0 breaks (R6)                                                                          |
| `@babylonjs/core`        | `^9.23.0`                                                                                                                                        | M3        | no peer dependencies; subpath imports only                                                                                     |
| `zustand`                | `^5.0.15`                                                                                                                                        | M3        | peers react/@types/react >= 18                                                                                                 |
| `@vitest/coverage-v8`    | `4.1.11` exact                                                                                                                                   | M3        | vitest peers the exact version; bump together with vitest                                                                      |
| `lucide-react`           | `^1.39.0`                                                                                                                                        | M4        | ISC icons                                                                                                                      |
| GitHub Actions           | `checkout@v7`, `setup-node@v7`, `setup-uv@v10`, `cache@v6`, `upload-artifact@v7`, `docker/setup-buildx-action@v4`, `docker/build-push-action@v7` | M0/M3/M7  | latest majors on 2026-09-02                                                                                                    |
| Docker images            | `python:3.14-slim`, `ghcr.io/astral-sh/uv:0.12.9`, `node:24`, `nginx:stable-alpine`                                                              | M7        | multi-arch (amd64, arm64)                                                                                                      |

Current M0 pins (backend `>=x.y,<next-major`, frontend caret): fastapi 0.141.1, pydantic-settings 2.15.0, pytest 9.1.1, pytest-cov 7.1.0, hypothesis 6.167.1, ruff 0.16.5, pyright 1.1.411, httpx2 2.12.0; react 19.2.8, i18next 26.4.1, react-i18next 17.0.13, typescript 6.0.3, vite 8.2.2, @vitejs/plugin-react 6.1.1, @vitejs/plugin-basic-ssl 2.3.0, tailwindcss 4.3.3, vitest 4.1.11, jsdom 30.0.1, @testing-library/react 16.3.3, @testing-library/dom 10.4.1, @testing-library/jest-dom 7.0.1, @playwright/test 1.62.1, eslint 10.9.1, @eslint/js 10.0.1, globals 17.12.0, typescript-eslint 8.69.0, eslint-plugin-react-hooks 7.1.1, eslint-plugin-jsx-a11y 6.10.2, prettier 3.9.6, prettier-plugin-tailwindcss 0.8.1, openapi-typescript 7.13.0, @types/react 19.2.18, @types/react-dom 19.2.5, @types/node 24.13.3.

## 8. Risks

| #   | Risk                                                                                                                           | Mitigation / decision                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| R1  | A later agent bumps TypeScript to 7 and breaks lint and codegen                                                                | `~6.0.3`, ADR-0001, CLAUDE.md do-not list, `tooling.md`; revisit when typescript-eslint supports TS 7 (after 7.1)               |
| R2  | npm 11.19 hard-fails vs warns on the two stale peers (unverified before install)                                               | ship the overrides regardless; observe at the first `npm install` and record it in section 6 Observed 2026-09-02: npm 11.19.0 hard-fails with ERESOLVE without either override; both are strictly required, zero warnings with them. |
| R3  | jsdom `canvas` peer triggers a node-canvas source build on aarch64                                                             | check `npm ls canvas` after install; Babylon tests stay in Playwright Observed 2026-09-02: `npm ls canvas` empty, no native build. |
| R4  | aarch64 lockfile missing x64 binaries makes the first CI run red                                                               | mandatory grep for the three `linux-x64-gnu` packages before committing Observed 2026-09-02: all three `linux-x64-gnu` packages present, `lockfileVersion` 3. |
| R5  | pyright needs Node and network in CI                                                                                           | `setup-node` + `~/.cache/pyright-python` cache in the backend job                                                               |
| R6  | FastAPI 0.141.1 with Starlette 1.6.0 (no upper bound) is untested upstream at release level                                    | health + snapshot tests guard; pin `starlette>=1.6,<1.7` only if it breaks                                                      |
| R7  | `filterwarnings=error` surfaces third-party DeprecationWarnings on 3.14                                                        | targeted `ignore:<msg>:<Category>:<module>` entries with a comment and a backlog line; never blanket                            |
| R8  | `license = "MIT"` string with `uv_build` 0.12.9 (unverified)                                                                   | fall back to `{ text = "MIT" }` Observed 2026-09-02: `license = "MIT"` accepted by uv_build 0.12.9 without warning. |
| R9  | `.env` or CI env leaking into tests                                                                                            | `--env-file` only on run targets (D9); autouse `clean_env` fixture Observed 2026-09-02: suite passes with deliberately malformed `SKYAPI_*` values in the environment; `skyapi.main` builds `app` lazily so importing it reads nothing. |
| R10 | Node `localhost` resolves to `::1` while uvicorn binds 127.0.0.1                                                               | every URL in configs uses `127.0.0.1`                                                                                           |
| R11 | `DATA_DIR` default `../data` is CWD-dependent                                                                                  | documented; `--directory backend` and `[tool.fastapi]` enforce the CWD; compose sets `/data` at M7                              |
| R12 | `uv run --env-file` precedence and path semantics (unverified)                                                                 | absolute `$(CURDIR)/.env`; nothing else sets `SKYAPI_*` in development                                                          |
| R13 | TS 6 `noUncheckedSideEffectImports` vs Babylon side-effect imports and `?raw` (M3)                                             | `vite/client` declares `*?raw`; M3 verifies with `tsc -b`                                                                       |
| R14 | typescript-eslint `projectService` may not find `vite.config.ts`, `playwright.config.ts`, `e2e/**`                             | verify at the first lint; fallback `projectService: { allowDefaultProject: [...] }` or an explicit `project` list Observed 2026-09-02: `projectService` resolves `vite.config.ts`, `playwright.config.ts`, `e2e/**` and `resources.d.ts` through the solution-style tsconfig; no fallback needed. |
| R15 | Playwright system libs absent on this WSL; WebGPU headless flags on arm64 unknown (M3)                                         | `sudo env "PATH=$PATH" fnm exec --using=24 npm --prefix frontend exec -- playwright install-deps` is a manual human step (B-24); e2e conditional at M0; CI Chromium only; flags measured at M3 |
| R16 | `npm create vite@latest` template drift                                                                                        | pinned `create-vite@9.2.0`; diff before deleting scaffold files                                                                 |
| R17 | `git diff --exit-code` is vacuous on untracked files                                                                           | `git ls-files --error-unmatch` first (D13); both generated files committed at M0                                                |
| R18 | pandas 3.0.5 vs Skyfield `mpc.py` `dtypes=` typo and `str`-dtype columns (not executed)                                        | pin `>=3.0,<4` at M1 with a real MPCORB smoke test; fallback `>=2.3,<3` with an ADR                                             |
| R19 | Skyfield 1.55 not classified for Python 3.14 (PR #1100 open)                                                                   | M1 first task: `import skyfield` + de440s load on 3.14.7                                                                        |
| R20 | Skyfield #952: multi-segment Moon PCK makes Moon observers fail before 2426                                                    | M1: date-aware segment selector + pre-2426 regression test                                                                      |
| R21 | MPC `www` host unreachable from this network                                                                                   | per-dataset URL override defaulting to `data.minorplanetcenter.net`; offline fixture path                                       |
| R22 | `backend/data/` sits outside `src/` and is not packaged by `uv_build`                                                          | decide at M1 (settings path + Dockerfile COPY vs move under `src/skyapi/data/`), Q16                                            |
| R23 | Nominatim policy recommends proxy + caching (brief says never), forbids autocomplete, requires a deliberate developer decision | follow the brief (browser-direct) at M4 with submit-only search, <= 1 req/s, Referer meta, attribution; maintainer question 1   |
| R24 | `engine-strict=true` is a global gate over every package's `engines`                                                           | keep; first thing to relax if `npm ci` diverges between CI and development (B-10)                                               |

## 9. Assumptions

- Outbound HTTPS stays available for PyPI, npm, GitHub, codeberg.org, NAIF, CDS/VizieR and `data.minorplanetcenter.net`; the `www.minorplanetcenter.net` timeout is specific to this network path and will be re-probed at M1.
- Development happens on aarch64 (WSL 2), CI and production images on amd64; every native dependency ships wheels or binaries for both, so no compiler is needed anywhere.
- `de440s.bsp` (1849-2150) is sufficient for every automated test; de441 is only ever fetched by a human or in production; `de440.bsp` is an optional middle tier for Moon-observer tests.
- No accounts, sessions, database or secrets exist; `.env` holds only non-secret `SKYAPI_*` values.
- The fnm default alias stays at v24.14.0; every Node invocation goes through `fnm exec --using=.node-version`, so the default is irrelevant to the build.
- Skyfield 1.55 runs on CPython 3.14.7 (upstream reports passing tests); verified as the first M1 task.
- The human performs the steps that need privileges or credentials: `sudo env "PATH=$PATH" fnm exec --using=24 npm --prefix frontend exec -- playwright install-deps`, `git push`, `sky-data fetch --full`, TLS certificates, the AR checklist on a real device.
- Docker 29.6.2 and Compose v5.3.1 remain available locally for M7.
- The brief's line numbers cited throughout refer to `docs/brief.xml` v1.2 as committed at M0; the file is never edited.

## 10. Open questions (decision taken, non-blocking)

| #   | Question                                                                                            | Decision                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Should `make check` also run `npm run build`?                                                       | No: brief l.421 is exhaustive; the CI frontend job builds.                                                                                                                                                    |
| Q2  | Keep `eslint-plugin-react-refresh` from the create-vite scaffold?                                   | Removed (not in l.405); ADR at M4 if HMR export rules prove useful.                                                                                                                                           |
| Q3  | HYG v4.4 or v4.2; Stellarium `modern` or `modern_st`?                                               | Proceed with v4.4 and `modern`; maintainer questions 2 and 3; revisit at M1 before the first fetch if answered.                                                                                               |
| Q4  | Set `fnm default 24.20.0` on this machine?                                                          | Not done by the Makefile (`--using` pins the version); README notes `FNM_VERSION_FILE_STRATEGY=recursive` for interactive shells.                                                                             |
| Q5  | Which Sun GM constant: the brief says `GM_SUN` (l.316) and `GM_SUN_Pitjeva_2005_km3_s2` (l.530)?    | Proceed with `GM_SUN_DE440_km3_s2` (consistent with the DE440/DE441 ephemerides and Skyfield's own docs); revisit at M1 if Horizons residuals suggest otherwise; maintainer question 7.                       |
| Q6  | Does pandas 3.0.5 accept Skyfield's misspelled `dtypes=` kwarg in `read_fwf`?                       | Static reading says it is ignored; proceed with `pandas>=3.0,<4`; smoke test at M1; fallback `>=2.3,<3` with an ADR.                                                                                          |
| Q7  | Is `www.minorplanetcenter.net` down or blocked for this network?                                    | Irrelevant to the design: configurable per-dataset URL with the `data.` host as default; re-probe at M1.                                                                                                      |
| Q8  | Replace d3-celestial boundaries with the IAU edges embedded in Stellarium's `index.json`?           | No for now (B1875 segments need parsing and precession; d3-celestial is ready-made J2000 GeoJSON); evaluate at M6 if dropping a dataset is wanted.                                                            |
| Q9  | How to work around Skyfield #952 without the hard-coded private-API hack?                           | A small date-aware selector in `astro/loader.py` choosing the `.bpc` segment covering the requested time, with the private-attribute use documented and a pre-2426 test; revisit when #952 is fixed upstream. |
| Q10 | Gate `@vitejs/plugin-basic-ssl` or run everything over HTTPS?                                       | Gated to `vite dev` in development mode (D15); Playwright and CI use plain HTTP on 4173; revisit at M5 if phone testing needs HTTPS preview.                                                                  |
| Q11 | Playwright trace mode: `on-first-retry` (docs) or `retain-on-failure` (brief: "traces on failure")? | `retain-on-failure` (works with `retries: 0` locally); revisit at M3 when the e2e CI job lands.                                                                                                               |
| Q12 | Where do `e2e/**` and `playwright.config.ts` get type-checked?                                      | In `tsconfig.node.json` `include` (three-file layout, B-07); fallback `allowDefaultProject` if `projectService` cannot see them (R14).                                                                        |
| Q13 | Does Vite 8 warn about the `test` key in `vite.config.ts`?                                          | Use `defineConfig` from `vitest/config` as the Vitest docs prescribe; observe at the first `vite build`; no action expected.                                                                                  |
| Q14 | Does npm 11.19 hard-fail (ERESOLVE) or only warn on the stale peers?                                | Ship the overrides either way (deterministic install); record the observation in section 6 (M0 amended items).                                                                                                |
| Q15 | Does `uv_build` 0.12.9 accept `license = "MIT"` (PEP 639 string)?                                   | Try the string; fall back to `{ text = "MIT" }` (R8).                                                                                                                                                         |
| Q16 | How is `backend/data/` shipped in the image if `uv_build` does not package it?                      | Decide at M1: settings path + explicit Dockerfile COPY, or move under `src/skyapi/data/`; the registry loader is written against the decision.                                                                |
| Q17 | Use the `pyright[nodejs]` extra for a hermetic CI instead of `setup-node`?                          | Not adopted (extra dependency); `setup-node` + cache; revisit at M6 if the backend job flakes on the pyright download.                                                                                        |
| Q18 | Should `ci.yml` carry e2e/docker stubs before their milestone?                                      | Comments only (present); real jobs land at M3 and M7.                                                                                                                                                         |
| Q19 | `uv sync --locked` and `uv lock --check` overlap                                                    | CI uses `uv sync --locked`; `make check` keeps `uv lock --check` as brief l.421 spells it.                                                                                                                    |

## 11. Questions for the maintainer

1. **Nominatim policy tension.** The brief (l.193, l.318) mandates browser-direct calls that are "never cached or proxied by the API". The OSMF usage policy (<https://operations.osmfoundation.org/policies/nominatim/>) says "If at all possible, set up a proxy and also enable caching of requests", forbids client-side autocomplete (the brief already agrees: submit-only), requires an identifying Referer or User-Agent, and states that the public API may only be used "where the application developer has made a deliberate, informed decision to use it and is directly responsible for complying with this policy" (its "Usage in LLMs" section). Please confirm that browser-direct use is your deliberate decision, or approve a small caching proxy under `/api/v1/geocode` for M4. Until answered: browser-direct, submit-only, <= 1 req/s, Referer meta, attribution, disable toggle.
2. **HYG version.** The brief pins v4.2; the repository now serves v4.4 at `data/hyg/CURRENT/` (v4.2 remains at `data/hyg/OLDER/`). v4.4 merged duplicated Gliese-Jahreiss stars and relabelled two stars, which can change the HIP-to-name crosswalk row count. Default: v4.4 with the attribution naming it.
3. **Stellarium figure set.** The brief chooses `modern`; Skyfield 1.55's `parse_constellations_json` docstring names `modern_st` (Sky & Telescope figures). Both parse identically. Default: `modern`, with a code comment so nobody "fixes" it.
4. **Playwright system libraries.** Browsers cannot launch on this WSL until `sudo env "PATH=$PATH" fnm exec --using=24 npm --prefix frontend exec -- playwright install-deps` (or the equivalent `apt install`) runs once; sudo is outside the agent's remit. Until then `make e2e` is blocked locally (CI is unaffected).
5. **TypeScript 7.1 timing.** TS 7.1 (targeted autumn 2026) should ship the API that unblocks typescript-eslint. Do you want the alias recipe (`npm:@typescript/typescript6`) attempted at M6, or only a plain bump once typescript-eslint and openapi-typescript declare support?
6. **`backend/data/` packaging.** The brief puts the committed CSV/TOML under `backend/data/` (l.354), outside `src/`, so `uv_build` does not package it. Options at M1: keep the path and COPY it in the Dockerfile with a settings entry, or move it under `src/skyapi/data/` (deviation from the layout). Default: decide at M1, preferring the move if the Dockerfile would otherwise need a second data path.
7. **Sun GM constant.** The brief names `GM_SUN` (l.316) and `GM_SUN_Pitjeva_2005_km3_s2` (l.530); Skyfield 1.55 has no `GM_SUN` and its documentation aliases `GM_SUN_DE440_km3_s2`. Default: the DE440 value, consistent with the ephemeris.

## 12. Progress log

- 2026-09-02 M0 started: brief read in full; environment inventoried; CLAUDE.md, .claude/rules, docs/plan.md, doc stubs and ADR-0001..0004 written.
- 2026-09-02 M0 done: `make check` green (17 pytest, 1 vitest, i18n 2 keys); `fastapi dev` health and the Vite `/api` proxy verified with curl; ci.yml reviewed line by line and both job bodies reproduced from a scratch copy of the index; three adversarial reviewers (CI reproduction, code, brief/DoD), every finding fixed; committed as `chore: bootstrap monorepo (backend, frontend, tooling, ci)`.
