# ADR-0001: TypeScript 6.0.x until the tooling supports TypeScript 7

- Status: Accepted
- Date: 2026-09-02

## Context

The brief asks for "TypeScript (latest stable)" (l.34) with caret ranges in `package.json` (l.32), and for a type-aware ESLint gate (typescript-eslint, l.405) plus generated API types (openapi-typescript, l.103).

Verified on 2026-09-02:

- npm `latest` for `typescript` is 7.0.2 (published 2026-07-08), the Go-native port. Its package contains no JavaScript compiler and no `tsserver`, only platform binaries and `bin/tsc`. The announcement states: "TypeScript 7.0 does not ship with an API. We expect TypeScript 7.1 to ship with a new (and different) API."
- typescript-eslint 8.69.0 (latest, 2026-08-31) declares the non-optional peer `typescript: >=4.8.4 <6.1.0`; it warns when it detects TypeScript 7 and cannot type-check with it.
- openapi-typescript 7.13.0 (latest) declares the peer `typescript: ^5.x` (it predates TypeScript 6 GA); it uses the compiler API to print types.
- create-vite 9.2.0's own react-ts template pins `typescript: ~6.0.2`.
- The latest 6.x is 6.0.3 (2026-04-16), the final JavaScript-codebase line and the designed bridge to 7.0; i18next 26 and react-i18next 17 accept `^5 || ^6 || ^7`.

## Options considered

1. TypeScript 7.0.2 as the brief's "latest stable" literally suggests: `npm ci` fails with ERESOLVE on typescript-eslint and openapi-typescript, and the type-aware lint gate cannot run. Rejected.
2. TypeScript 7 for `tsc` plus the alias `"typescript": "npm:@typescript/typescript6@^6.0.2"` for tools that need the API (Microsoft's sanctioned coexistence recipe; `@typescript/typescript6` 6.0.2 exists on npm). It doubles the toolchain, is unvalidated against typescript-eslint's module resolution, and the compile-speed gain is irrelevant for this codebase size. Deferred, recorded as the upgrade path.
3. `typescript: ^6.0.3` (caret, per the brief's rule): a hypothetical 6.1.x would satisfy the caret and violate typescript-eslint's `<6.1.0` on the next lockfile refresh, breaking `npm install` on a machine that did nothing wrong. Rejected.
4. `typescript: ~6.0.3` (tilde): the newest release every tool in the chain accepts, frozen at the minor. Chosen.

## Decision

Pin `"typescript": "~6.0.3"` in `frontend/package.json`. openapi-typescript's `^5.x` peer is satisfied through the npm `overrides` entry described in ADR-0002. Do not bump to 7.x and do not widen to a caret until the revisit trigger below fires.

## Consequences

- Deviation from the caret rule (brief l.32), recorded in `docs/backlog.md` (B-01) and `docs/plan.md` section 4.
- The tsconfigs are written TypeScript 6.0-clean (no `baseUrl`, explicit `types` because 6.0 defaults it to `[]`, no deprecated `moduleResolution` values, `erasableSyntaxOnly`), so the later 7.x move is mechanical.
- `CLAUDE.md` and `.claude/rules/tooling.md` forbid bumping TypeScript; a later agent seeing "7.0.2 is latest" must read this ADR first.
- `@types/node` follows the pinned Node major (`^24.13.3`), not npm `latest` (26.x), for the same "track the toolchain, not the tag" reason.

## Revisit trigger

Both of the following are true: typescript-eslint publishes a release whose `typescript` peer admits 7.x (expected after TypeScript 7.1 ships its API), and openapi-typescript declares a compatible peer or is proven to run against TypeScript 7 through the alias recipe. Then bump (or adopt the alias) during a hardening pass (M6 at the earliest), drop the `openapi-typescript -> typescript` override if no longer needed, and mark this ADR "Superseded". Track <https://typescript-eslint.io/users/dependency-versions> and <https://github.com/typescript-eslint/typescript-eslint/releases>.
