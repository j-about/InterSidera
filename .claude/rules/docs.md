---
paths:
  - "docs/**"
  - "README.md"
  - "CLAUDE.md"
  - "THIRD_PARTY_NOTICES.md"
  - "backend/data/**"
---

# Documentation and committed data rules

- Documentation changes ship in the same commit as the code they describe (brief l.294, l.504). A milestone commit updates `docs/plan.md` (status, progress log, open questions) and the docs its definition of done names.
- `docs/brief.xml` is the authoritative specification and is never edited. Cite it by line number when a rule is enforced because of it.
- `docs/plan.md` keeps its twelve sections in order: status, environment snapshot, decision register (D1-D27...), deviations from the brief, corrections to the data sources, milestones M0-M7, reserved pins, risks, assumptions, open questions with decisions, questions for the maintainer, progress log. Tick milestone items as they land; append to the log, never rewrite history.
- ADRs live in `docs/decisions/ADR-NNNN-kebab-title.md` with the sections Status, Date, Context, Options considered, Decision, Consequences, Revisit trigger. One ADR per notable decision and per dependency added beyond the brief; superseding an ADR sets its status to "Superseded by ADR-NNNN" instead of editing the decision.
- Every deviation from the brief's wording goes to `docs/backlog.md` with milestone and reason; [L] requirements are listed there and not implemented unless trivial.
- `README.md` is extended, never replaced: the original paragraph stays first. Keep the quickstart accurate to what exists (say which targets arrive later).
- `CLAUDE.md` stays under 150 lines (brief l.499); file-specific rules go to `.claude/rules/*.md`, not to CLAUDE.md.
- `docs/api.md` is derived from `docs/openapi.json` plus the SKYS byte-layout table and documents canonicalization, every endpoint, the problem types (anchors `problem-<slug>`, referenced by the `type` URIs), caching headers, rate limiting, warnings, rounding and degraded mode; `docs/data.md` also describes what happens at API startup; `docs/data.md` mirrors the data registry (URL, size, SHA-256, license, attribution, refresh); `docs/architecture.md` "Time model", "Data flow" and "Frontend" describe the real engine (clock ownership, boot phases, fetch policy, ENU geometry with the reflection matrix, layers, refraction, debug hook) and change with the code; `docs/testing.md` records coverage gates, the frontend parity numbers, the e2e projects and their local outcomes, the fps and catalog-parse measurements (browser, engine kind, resolution, layers, star count, `__sky.fps()` over 10 s), the manual AR checklist (M5) and measured budgets (M6); `docs/dev-wsl2.md` documents HTTPS dev, the Playwright libraries and the Windows-browser check, and phone access.
- `THIRD_PARTY_NOTICES.md` is rendered from the data registry by `python -m skyapi.tools.render_notices --out` (`make notices`), never hand-edited, and gated by `make check`; the About screen renders the same credits. Every registry entry carries license, copyright, attribution and, for BSD/MIT/ISC/CC BY-SA sources, a license text under `backend/src/skyapi/data/licenses/`.
- No third-party data in git. The small factual CSV/TOML files authored for this project (`data_files.toml`, `constellation_names.csv`) live in `backend/src/skyapi/data/` (ADR-0005, deviation B-28 from the brief's `backend/data/`); the OBS-6 site presets are the frontend module `frontend/src/state/presets.ts` with one Gazetteer citation per site and the registry entry `gazetteer` (a `committed` entry whose `filename` is a repository path; B-57); `frontend/src/data/credits.json` is generated with the notices (`render_notices --json`, B-63) and never hand-edited; test excerpts under 1 MB live in `backend/tests/fixtures/excerpts/` with an in-file source and license header (brief l.325) and a `[[excerpts]]` registry entry.
- Write in English, concise and factual; markdown with no trailing spaces, fenced code blocks with a language, and tables that render on GitHub.
- Never print or paste data files into docs or context; inspect them with `head -c`, `wc -c` or a Python one-liner.
