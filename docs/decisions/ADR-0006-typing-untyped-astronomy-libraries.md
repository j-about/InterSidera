# ADR-0006: Typing the untyped astronomy libraries under pyright strict

- Status: Accepted
- Date: 2026-09-03

## Context

The brief requires pyright strict on `backend/src` with "no untyped `Any` leaving a public
function" (l.396). M1 adds the astronomy stack: Skyfield 1.55 and jplephem 2.24 ship no type
information at all; pandas 3.0.5 is typed only through the separate `pandas-stubs` package;
pyarrow 25.0.1 keeps its `py.typed` marker out of the wheel on purpose until its stubs are
complete (apache/arrow GH-49831), so it is untyped for pyright too. In strict mode a missing stub
is an error (`reportMissingTypeStubs`) and every attribute of an untyped module is `Unknown`
(`reportUnknownMemberType`), which would either fail the gate or force `cast` on every Skyfield
call.

## Options considered

1. Set `reportMissingTypeStubs = false` and wrap every Skyfield call in `cast(...)`. Rejected:
   hundreds of casts, no real checking of the calls that matter most.
2. Mark the Skyfield-facing modules `# pyright: basic`. Rejected: the brief asks for strict on
   `src/`, and `astro/` is exactly where type errors hurt.
3. `pandas-stubs` for pandas, hand-written local stubs for the Skyfield and jplephem surface the
   code uses, and no direct pyarrow import. Chosen.

## Decision

- Dev dependency `pandas-stubs>=3.0.5,<3.1` (version scheme `x.y.z.yymmdd`; the stubs are tested
  against pandas 3.0.5 and are pinned to the same major/minor as pandas, bumped together).
- Local stubs in `backend/typings/` (pyright's default `stubPath`): `skyfield/**/*.pyi` and
  `jplephem/*.pyi` declare only the classes and functions the code uses, each with a comment citing
  the Skyfield 1.55 source line. The stub package covers every `skyfield.*` module imported under
  `src/` (a partial stub package falls back to site-packages and still triggers the missing-stub
  error), imports come from concrete modules rather than `skyfield.api` (except `load` for the
  builtin timescale), and `Loader.__call__`/`open`/`download` are deliberately omitted so that any
  code path that would let Skyfield download a file is a type error.
- pyarrow is used only through pandas (`DataFrame.to_parquet(engine="pyarrow")`,
  `pd.read_parquet(engine="pyarrow", filters=...)`), so no pyarrow typing is needed.
- Ruff excludes `typings/` (`extend-exclude`), because the stubs mirror upstream names such as
  `temperature_C` and use `Any` where Skyfield is genuinely dynamic (deviation B-37).
- Where Skyfield returns `float` or `ndarray` depending on the `Time` shape, the stubs declare
  `float | NDArray[np.float64]` and `astro/` narrows once at its boundary.

## Consequences

- `make check` keeps pyright strict on the whole of `src/` with 0 errors.
- The stubs are maintained by hand: a Skyfield upgrade means re-checking the cited lines.
- Deviations recorded as B-37 in `docs/backlog.md`; the stub package carries a one-line MIT
  attribution to Skyfield.

## Revisit trigger

- Skyfield or jplephem publish type information (`py.typed`), or pyarrow ships its stubs: drop the
  corresponding local stubs.
- `pandas-stubs` stops tracking the pandas minor in use: hold both at the last matching pair.
