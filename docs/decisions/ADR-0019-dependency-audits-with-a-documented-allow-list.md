# ADR-0019: Dependency audits with a documented allow-list, outside `make check`

- Status: Accepted
- Date: 2026-09-23 (M6)

## Context

The brief requires "dependency audits in CI (`pip-audit` for Python, `npm audit` for Node) with a documented allow-list for accepted advisories" (l.276), a hermetic `make check` whose command list is fixed (l.421) and one workflow file (l.427). Neither tool was part of the project before M6. The one known finding was a dev-only npm advisory: `js-yaml` 4.3.1 (GHSA-2883-xcg3-v3hh, CVE-2026-84375, CVSS 7.5, published 2026-09-08, fixed in 4.3.2) reached through `openapi-typescript@7.13.0 > @redocly/openapi-core@1.34.19`, where `1.34.20` pins the fixed version inside the declared `^1.34.6` range; `pip-audit` 2.10.1 over the exported lock reported no known vulnerability (plan Context). Facts about the tools: `pip-audit` rejects `-r -` but reads `-r <file>`, its `--ignore-vuln` filters before the JSON output (so a JSON gate could not see what was ignored) and `--strict` fails on skipped rows; `npm audit --json --package-lock-only` reads the lockfile without an install; both exit non-zero on any finding.

## Options considered

1. `pip-audit` as a dev dependency of the backend. Rejected: one more package in `uv.lock` for a tool that never runs inside the project; an exact pin through `uv tool run pip-audit==2.10.1` (the `uvx` form, so the `UV ?= uv` override of the Makefile still governs) fixes the version without the lockfile entry.
2. `pip-audit --ignore-vuln` and `npm audit --audit-level` as the allow-list. Rejected: neither carries a reason or an expiry, `--ignore-vuln` hides the advisory from the JSON, and `--audit-level` accepts whole severity classes.
3. Audits inside `make check`. Rejected (backlog B-86): they need the registries and the OSV service, and their answers change without a commit; a registry outage would break the hermetic gate. `make audit` is its own target and a CI job of its own.
4. `continue-on-error` on the CI job. Rejected (plan R105): an outage should be visible; the weekly schedule re-runs it.
5. The allow-list home (Q73): one JSON file with two halves, `scripts/audit-allowlist.json`, so one reader (`scripts/check_audit.mjs`) validates both. Chosen over a Makefile comment or a `backend/audit-allowlist.txt`.
6. Fixing js-yaml by an allow-list entry versus the lockfile move. The lockfile move (plan D152): `npm --prefix frontend update @redocly/openapi-core --package-lock-only` then `npm ci` landed in the M6 Step 0 refresh, so the allow-list starts empty.

## Decision

Records plan rows D151 and D152 (with backlog B-86, risk R105 and Q73).

- `make audit` (network, outside `make check`; `Makefile` l.121-126): in a temporary directory removed by a `trap`, `$(NPM) audit --json --package-lock-only > $$tmp/npm-audit.json || true`; `$(UV) export --quiet --directory backend --frozen --format requirements.txt --no-emit-project --no-hashes --all-groups -o $$tmp/requirements.txt`; `$(UV) tool run $(PIP_AUDIT) -r $$tmp/requirements.txt --no-deps --strict --disable-pip --progress-spinner off -f json -o $$tmp/pip-audit.json || true` with `PIP_AUDIT := pip-audit==2.10.1`; then `$(NODE) scripts/check_audit.mjs --npm $$tmp/npm-audit.json --python $$tmp/pip-audit.json`. Never `-r -`, never `--ignore-vuln`.
- `scripts/check_audit.mjs` (Node 24 built-ins only; `--allowlist <file>` defaults to `scripts/audit-allowlist.json` and exists for the gate's own tests) fails when: (a) either file is not a report of its tool, a report audited nothing (npm `metadata.dependencies.total` 0 or absent, pip-audit an empty `dependencies` array), an npm report counts vulnerabilities while no `via` array carries an advisory object, or pip-audit skipped a dependency; (b) an advisory is not allow-listed for its package (npm advisories are identified by the GHSA id of their `url`, pip-audit rows by `id` and every alias: PYSEC, CVE, GHSA); (c) an entry is malformed, expired (`expires` before today, UTC), added in the future, or `expires` lies more than 180 days after `added` (an accepted risk is re-examined at least twice a year; an entry is valid through `expires`, inclusive); (d) an entry matches no reported advisory (unused). Ids and package names compare case-insensitively (Python names in their canonical `-` form). The three fail-closed additions of area B (audited nothing, counts without an advisory object, `added` in the future) go beyond the plan's D151 list; every one adds a failure condition. It prints one line per tool, one per accepted entry and a summary.
- `scripts/audit-allowlist.json` is `{ "npm": [], "python": [] }` with entries `{ id, package, reason, added, expires }` (ISO dates). Worked example, the entry js-yaml would have needed before D152 landed: `{ "id": "GHSA-2883-xcg3-v3hh", "package": "js-yaml", "reason": "dev-only transitive of openapi-typescript, a build tool that never ships", "added": "2026-09-23", "expires": "<the M7 date, at most 180 days after added>" }`.
- CI (`.github/workflows/ci.yml`): a fourth job `audit` (`runs-on: ubuntu-latest`, `timeout-minutes: 10`, checkout, setup-node from `.node-version`, setup-uv pinned by SHA; no `npm ci`, no `uv sync`) runs the same four commands; the workflow gains `workflow_dispatch` and `schedule: cron '17 6 * * 1'` (Monday 06:17 UTC), with `if: github.event_name != 'schedule'` on `backend`, `frontend` and `e2e` so the weekly run executes the audit alone.

## Consequences

- Record of 2026-09-23 (area B final report, section 3.1): `npm audit: 462 packages, 0 vulnerabilities`, `pip-audit: 60 packages, 0 vulnerabilities` (175-line export, 63 pinned names, 60 on the Linux marker set, 0 skipped), `audit: 0 advisories (0 accepted), 0 allow-list entries, 0 findings`, exit 0 in 4.1 s on a warm cache.
- The rule matrix of the gate (20 cases: expired, 181 days, exactly 180, unused, malformed, error files, skipped rows, broken JSON, missing file, usage, the three fail-closed shapes) is exercised by hand with `--allowlist` fixtures; a new advisory blocks CI until fixed or allow-listed with a reason and an expiry.
- `pip-audit` warns that `--no-deps` is supported but hashes are encouraged; the export carries no hashes because `uv export --no-hashes` is what the pinned lock reproduces (informational, not a finding).
- The CI job needs neither `node_modules` nor a virtual environment: `--package-lock-only` reads `package-lock.json` and `uv export --frozen` reads `uv.lock`, so a scheduled run costs a checkout and two tool downloads.
- A vulnerability in a dev-only package is still a finding: build-time code ships into `dist/`.

## Revisit trigger

- uv or npm gain a native allow-list format with reasons and expiry; `pip-audit` 3.x changes its JSON shape (the gate fails closed on a shape change, which is the signal); the js-yaml class of fix (a lockfile move inside the range) stops being possible and the first real allow-list entry lands.

Pointers: `.claude/rules/tooling.md`, `docs/testing.md` (the audit record), `README.md` (`make audit`), `docs/plan.md` section 3 (D151, D152), section 8 (R105), section 10 (Q73), `docs/backlog.md` (B-86).
