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
- `docs/api.md` is derived from `docs/openapi.json` plus the SKYS byte-layout table; `docs/data.md` mirrors the data registry (URL, size, SHA-256, license, attribution, refresh); `docs/testing.md` records coverage gates, the manual AR checklist (M5) and measured budgets (M6); `docs/dev-wsl2.md` documents HTTPS dev and phone access.
- `THIRD_PARTY_NOTICES.md` is generated from the data registry (M1), never hand-edited; the About screen renders the same credits.
- No third-party data in git. `backend/data/` may hold only the small factual CSV/TOML files authored for this project (`constellation_names.csv`, `planetary_sites.csv` with citations, `data_files.toml`); test excerpts under 1 MB live in `backend/tests/fixtures/excerpts/` with a source and license header (brief l.325).
- Write in English, concise and factual; markdown with no trailing spaces, fenced code blocks with a language, and tables that render on GitHub.
- Never print or paste data files into docs or context; inspect them with `head -c`, `wc -c` or a Python one-liner.
