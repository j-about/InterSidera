# ADR-0004: Implied tooling dependencies beyond the brief's lists

- Status: Accepted
- Date: 2026-09-02

## Context

The brief enumerates the allowed dependencies (backend l.395, frontend l.405) and states "Nothing else without an ADR". Several packages are not named there but are required for the named ones to install or type-check deterministically, and one is the cost of a test-strictness choice. Verified on 2026-09-02:

- `@testing-library/react` 16.3.3 has the non-optional peer `@testing-library/dom: ^10.0.0`; `@testing-library/jest-dom` 7.0.1 peers `@testing-library/dom: >=10 <11`. Relying on npm's automatic peer installation makes the lockfile depend on the npm version that generated it.
- ESLint 10 flat config needs `@eslint/js` (`js.configs.recommended`) and `globals` (browser/node global sets; `/* eslint-env */` comments were removed in ESLint 10).
- `@types/react` and `@types/react-dom` are peers of `@testing-library/react` and provide the JSX types React 19 no longer bundles; `@types/node` is needed by `tsconfig.node.json` (`types: ["node"]`) because TypeScript 6 defaults `types` to `[]`; it must track Node 24 (`^24.13.3`), not npm `latest` (26.x).
- Starlette 1.6's `TestClient` imports `httpx2` first and falls back to `httpx` 0.x with a `StarletteDeprecationWarning`. The project sets `filterwarnings = ["error"]` so that Python 3.14 and dependency deprecations surface immediately; with that setting every `TestClient` test would fail unless `httpx2` is installed. FastAPI upstream added `httpx2` as a test dependency for exactly this reason (PR #15603). httpx 0.28.1 still arrives through the fastapi extra and is not a dev dependency.
- The create-vite 9.2.0 react-ts scaffold ships `oxlint` + `.oxlintrc.json` (its default linter) and, with `--eslint`, adds `eslint-plugin-react-refresh`; neither is in the brief's list.
- Vitest 4 coverage requires `@vitest/coverage-v8` at the exact vitest version (peer `4.1.11`), not named in l.405; the coverage gate (100 % on `sky/math` and `state/url`) starts at M3.

## Options considered

1. Let npm auto-install peers and omit the type packages: non-deterministic across npm versions and `tsc -b` fails on missing ambient types. Rejected.
2. Drop `filterwarnings = ["error"]` to avoid `httpx2`: hides third-party deprecations on a brand-new Python version, the opposite of the brief's correctness stance. Rejected.
3. Keep the scaffold's `oxlint` as a second linter: two linters with overlapping rules and no brief mandate. Rejected.
4. Add `@vitest/coverage-v8` at M0: no coverage gate exists before M3 and the exact-version peer adds a bump obligation now. Deferred to M3.
5. Declare the required peers and types explicitly, add `httpx2`, remove the scaffold extras. Chosen.

## Decision

Added at M0:

- Frontend `devDependencies`: `@testing-library/dom ^10.4.1`, `@eslint/js ^10.0.1`, `globals ^17.12.0`, `@types/react ^19.2.18`, `@types/react-dom ^19.2.5`, `@types/node ^24.13.3`.
- Backend `[dependency-groups] dev`: `httpx2>=2.12,<3`, together with `[tool.pytest.ini_options] filterwarnings = ["error"]`.

Removed from the scaffold at M0: `oxlint`, `.oxlintrc.json`, `eslint-plugin-react-refresh` (an ADR may reintroduce react-refresh at M4 if HMR export rules prove useful).

Deferred: `@vitest/coverage-v8` exact `4.1.11` is added at M3 with the coverage thresholds; this ADR is amended then (B-22).

## Consequences

- `package-lock.json` and `uv.lock` are reproducible under `npm ci` and `uv sync --locked` regardless of the installer's peer heuristics.
- Two HTTP client libraries (`httpx` 0.28 via the fastapi extra, `httpx2` for tests) coexist in the backend lockfile; only `httpx2` is used by the test suite.
- Any third-party warning that still appears under `filterwarnings = ["error"]` is fixed at the source or silenced with a targeted `ignore:<message>:<Category>:<module>` entry carrying a comment and a backlog line (never a blanket ignore).
- Recorded as deviations B-11, B-15, B-18 and B-22 in `docs/backlog.md`.

## Revisit trigger

- `@testing-library/react` starts declaring `@testing-library/dom` as a regular dependency: drop the explicit entry.
- The fastapi extra switches its `httpx` dependency to `httpx2`, or Starlette drops the fallback warning: drop `httpx2` from the dev group.
- M3: amend this ADR when `@vitest/coverage-v8` is added; any vitest bump must bump it in the same commit.
- A dependency is removed from the brief's lists or a new tool replaces one of these: update this ADR rather than adding an undocumented package.
