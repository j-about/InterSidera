# ADR-0005: Committed factual data files live inside the `skyapi` package

- Status: Accepted
- Date: 2026-09-03

## Context

The brief's repository layout (l.354) puts the small factual files authored for this project
(`data_files.toml`, `constellation_names.csv`, and the planetary site presets) under `backend/data/`,
next to `pyproject.toml` and outside the `src/` tree. `uv_build` packages only the module under
`module-root` (plus an optional `data` directory copied into the wheel's `.data`), so files under
`backend/data/` would not ship in the wheel: the Docker image (M7) would need a second `COPY` and
a settings entry pointing at them, and every loader would depend on the working directory.

The uv build-backend documentation (read 2026-09-03) states that "all data files must either be
under the module root or in the appropriate data directory. Most packages store small data in the
module root alongside the source code."

## Options considered

1. Keep `backend/data/` and add a `SKYAPI_REGISTRY_DIR`-style setting plus a Dockerfile `COPY`.
   Rejected: two data paths, a CWD-dependent default, and one more variable to document.
2. Declare `backend/data/` through `[tool.uv.build-backend] data`. Rejected: the files land in
   the wheel's `.data` tree, not importable through `importlib.resources`.
3. Move the files into `backend/src/skyapi/data/` next to `registry.py` and load them with
   `importlib.resources.files("skyapi.data")`. Chosen.

## Decision

`backend/src/skyapi/data/` holds the registry `data_files.toml`, the license texts rendered into
`THIRD_PARTY_NOTICES.md` (`licenses/*.txt`) and `constellation_names.csv`. The OBS-6 site presets
of M4 are frontend data (`frontend/src/state/presets.ts`, Gazetteer citations in code, registry
key `gazetteer` with the repository path as `filename`, backlog B-57), not a packaged CSV. The
packaged files ship in the wheel automatically; `sky-data` and the API read them
through `importlib.resources`, never through a filesystem path. The root `/data/` directory keeps
its role as the gitignored `DATA_DIR` of downloaded files and caches.

## Consequences

- One source of truth for the registry, no path configuration, identical behaviour in a checkout,
  in the wheel and in the container.
- Deviation from the brief's layout recorded as B-28 in `docs/backlog.md`; `.gitignore` keeps the
  root-anchored `/data/` rule and its comment names the new location.
- `docs/data.md` mirrors the registry; the notices file is generated from it (`make notices`).

## Revisit trigger

- `uv_build` gains a first-class way to include a directory outside the module as importable
  package data, or the brief's layout is revised.

## Amendment (M7)

Plan D169 (ADR-0023), 2026-09-28. The container confirms the decision: `backend/Dockerfile` copies `/app/.venv` (the `skyapi` wheel built by `uv_build`, the packaged `data/` files inside it) and `/app/pyproject.toml` into the final stage and nothing else; no second data path, no `COPY` of a `backend/data/` directory, no settings entry (the M6 hand-off item "`backend/data/` COPY or packaging per the M1 decision (Q16)" closes as "packaging"). The root `data/` directory keeps its role as the gitignored `DATA_DIR`: compose bind-mounts `SKY_DATA_DIR` (default `./data`, tracked as the empty `data/.gitkeep`, backlog B-103) at `/data` and the image sets `SKYAPI_DATA_DIR=/data`; the `.gitignore` rule becomes `/data/*` plus `!/data/.gitkeep`. The decision text above is unchanged.
