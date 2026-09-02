# ADR-0002: ESLint 10 with npm overrides for stale peer ranges

- Status: Accepted
- Date: 2026-09-02

## Context

The brief requires ESLint flat config with typescript-eslint (type-aware), eslint-plugin-react-hooks and eslint-plugin-jsx-a11y (l.405), openapi-typescript for generated types (l.103), and "latest stable" versions (l.32).

Verified on 2026-09-02:

- eslint 10.9.1 is the latest stable (10.0.0 shipped 2026-02-06); it is flat-config only and exports `defineConfig`/`globalIgnores` from `eslint/config`.
- typescript-eslint 8.69.0 peers `eslint: ^8.57.0 || ^9.0.0 || ^10.0.0`; eslint-plugin-react-hooks 7.1.1 peers `^10.0.0`. Both fine.
- eslint-plugin-jsx-a11y 6.10.2 (latest, published 2024-10-26, no newer tag) peers `eslint: ^3 || ^4 || ^5 || ^6 || ^7 || ^8 || ^9` without `peerDependenciesMeta`. The request for ESLint 10 support is open as <https://github.com/jsx-eslint/eslint-plugin-jsx-a11y/issues/1075>; the plugin is rule-only and exposes `flatConfigs.recommended`, and is reported to work with ESLint 10.
- openapi-typescript 7.13.0 peers `typescript: ^5.x`, incompatible with the TypeScript 6.0.x pin of ADR-0001.
- npm 11 treats an unsatisfiable non-optional peer as an ERESOLVE error, so `npm ci` fails with either package as declared.

## Options considered

1. `npm install --legacy-peer-deps` (or `legacy-peer-deps=true` in `.npmrc`): silently relaxes every peer in the tree, not just the two known ones, and hides future genuine conflicts. Rejected.
2. ESLint 9.39.5 (the `maintenance` line): conflict-free with all three plugins, but violates the brief's "latest stable" rule for a purely cosmetic gain and would need its own deviation record. Rejected.
3. Drop eslint-plugin-jsx-a11y: violates brief l.405 and the accessibility requirements (UX-4). Rejected.
4. npm `overrides` scoped to the two packages, using `$eslint` / `$typescript` references so the overridden version always equals the one declared in `devDependencies`. Chosen.

## Decision

In `frontend/package.json`:

```json
"overrides": {
  "eslint-plugin-jsx-a11y": { "eslint": "$eslint" },
  "openapi-typescript": { "typescript": "$typescript" }
}
```

ESLint stays at `^10.9.1`. `--legacy-peer-deps` is never used, anywhere.

## Consequences

- Both overrides are precise (one package, one peer each) and self-updating through the `$` references.
- The risk is limited to the two overridden packages misbehaving at runtime; jsx-a11y is rule-only and its flat config is exercised by `npm run lint` on every check, openapi-typescript's output is exercised by `tsc -b` and the drift gate.
- Recorded as deviation B-03 in `docs/backlog.md`. Whether npm 11.19 would have hard-failed or only warned without the overrides is observed at the first install and noted in `docs/plan.md` (M0 amended items).
- `CLAUDE.md` and `.claude/rules/tooling.md` forbid removing the overrides before the trigger fires.

## Revisit trigger

- Remove the `eslint-plugin-jsx-a11y` entry when a release declares an ESLint 10 peer (issue #1075 closed).
- Remove the `openapi-typescript` entry when a release declares a TypeScript 6 (or 7) peer, or when ADR-0001 is superseded and the TypeScript pin changes.
- Re-check both at every milestone's version review (brief l.32) and at M6 hardening.
