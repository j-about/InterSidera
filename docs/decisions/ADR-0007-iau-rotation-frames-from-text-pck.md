# ADR-0007: IAU rotation frames for planetary observers are computed from the text PCK

- Status: Accepted
- Date: 2026-09-03

## Context

The brief expects observers on Mercury, Venus, Mars, the giant planets and Pluto to use "IAU
frames from the PCK kernel" built by Skyfield from `pck00011.tpc` (`IAU_MARS`, `IAU_JUPITER`, ...;
l.58, l.528). Skyfield 1.55 cannot do that: `PlanetaryConstants.build_frame` (planetarylib.py
l.99-135) resolves text-kernel frame definitions but requires a **binary** PCK segment for the
body and raises `LookupError` otherwise; it never evaluates the `BODYnnn_POLE_RA`, `POLE_DEC`,
`PM` and `NUT_PREC_*` rotation models that the text PCK carries. NAIF publishes binary PCKs only for
the Moon (and a few small bodies), so no Skyfield frame exists for the planets. The Moon keeps its
binary PCK frame `MOON_ME_DE440_ME421` (with the multi-segment workaround of issue #952).

This is the one place where InterSidera computes astronomy outside Skyfield (principle l.41,
accuracy l.262), so it is recorded as a decision.

## Options considered

1. Binary PCKs for the planets. Rejected: NAIF does not publish them.
2. Approximate planetary observers by a body-centred observer (no horizon). Rejected: observers
   on other bodies are an [M] requirement (OBS-5).
3. Implement the IAU/IAG rotation model (Archinal et al. 2018, exactly as encoded in
   `pck00011.tpc`) in `astro/frames.py` as a frame object with the same interface as Skyfield's
   `Frame` (`center`, `rotation_at`, `rotation_and_rate_at`), so `PlanetTopos` works unchanged.
   Chosen.
4. Use the IAU 2009 constants that JPL Horizons uses for planets, for exact Horizons parity.
   Rejected: the brief names `pck00011.tpc` (IAU 2015); the Horizons difference is documented and
   measured instead (R34).

## Decision

`astro/frames.py` reads the rotation model of a body from the parsed text PCK variables:
α = α0 + α1 T + α2 T² + Σ aᵢ sin θᵢ, δ = δ0 + δ1 T + δ2 T² + Σ dᵢ cos θᵢ, W = W0 + W1 d + W2 d² +
Σ wᵢ sin θᵢ, where the nutation-precession angles θᵢ are polynomials of degree
`BODY<bary>_MAX_PHASE_DEGREE` in T (Mars: degree 2, 26 triples; Jupiter and Neptune: degree 1;
Pluto: none). The rotation ICRF -> body-fixed is `rot_z(-W) · rot_x(-(π/2 - δ)) · rot_z(-(π/2 + α))`,
the Euler convention Skyfield applies to binary PCK angles, and the rate matrix reuses Skyfield's
construction with analytic derivatives per day. Frame centres are the ephemeris targets the
observer vector is added to: the barycentre codes 1, 2, 4, 5, 6, 7, 8, 9 (Mercury and Venus have no
moons, so their barycentres coincide with the planets; de440s carries no Mars 4 -> 499 segment and
the Mars barycentre lies within a metre of the planet; the outer-planet offset is a documented
sub-arcsecond approximation, and Pluto carries the `pluto_barycenter` approximation code from the
contract). `pck00011.tpc` encodes Mars' nutation-precession angles as 26 quadratic triples
(`BODY4_MAX_PHASE_DEGREE = 2`).

## Consequences

- Tests: parsing of the phase-degree layout, pole at J2000 for Pluto, Mars pole against Horizons,
  orthonormality, central-difference check of the rate matrix, the acceptance invariant that the
  Mars horizon returns after one sidereal rotation (brief l.569), and the Horizons Jezero cases.
- Horizons uses the IAU 2009 models for planets; IAU 2015 rewrites the Mars pole with a long-period
  term that agrees near J2000 and diverges by arcminutes at 1900 and 2140. Residuals are analysed
  and recorded in `docs/testing.md`; any tolerance other than 2 arcsec for Mars sites becomes a
  backlog row (B-36).
- Recorded as correction B-35 in `docs/backlog.md` and in `docs/plan.md` section 5.

## Amendment (M6, 2026-09-24): the Moon frame from every binary-PCK segment (Skyfield #952)

Recorded here because it is the one sanctioned use of Skyfield private names in the code base
(plan D35, M1; `CLAUDE.md` forbids touching a Skyfield private name outside `astro/loader.py`). `moon_pa_de440_200625.bpc` (12.3 MB, coverage 1549-12-31 to 2650-01-25 TDB) holds
two segments for body 31008 split at 2426; Skyfield 1.55's `PlanetaryConstants.read_binary` keeps
every segment in `_segment_list` but `_segment_map[body]` remembers only the last one, so the
Skyfield-built `MOON_ME_DE440_ME421` frame answered 2426-2650 alone (issues #952 and #960, open on
2026-09-03). `astro/loader.py::build_moon_frame` (l.209-250) is the
only function that reads `pc._segment_list` and calls `pc.build_frame(integer, _segment=segment)`
(`# pyright: ignore[reportPrivateUsage]` on the one line); it builds one Skyfield `Frame` per
segment and wraps them in `astro/frames.py::SegmentedFrame` (l.290), which routes every time
sample to the segment covering it and raises `CoverageError` outside every segment instead of
jplephem's bare `ValueError`. The same function narrows the one `DeprecationWarning` of
`planetarylib.py` l.113 (`matrix.shape = 3, 3` under NumPy 2.5) to that call (backlog B-40).

M6 change (backlog B-52, ADR-0011): the advertised Moon coverage goes through `bpc_coverage` ->
`_coverage_on_grid`, so the TT bounds are shrunk by `COVERAGE_MARGIN_DAYS` and moved inward onto
the API's 1e-8 day grid with `ceil_to_grid` / `floor_to_grid`; the served bounds are
`[2287185.5, 2688975.49999999]`, bit-identical to the pre-M6 values (area D final report,
section 1). Tests: `tests/unit/test_moon_frame.py` (a Moon observer on 2019-12-20, before the
segment boundary; both segments covered; agreement with Skyfield's own
frame on the last segment; a window straddling the boundary; the private names the workaround
relies on still exist) and `tests/unit/test_loader.py::test_bpc_coverage_merges_contiguous_segments`.

## Revisit trigger

- Skyfield gains text-PCK rotation frames: replace `IauRotationFrame` by Skyfield's and keep the
  tests.
- NAIF publishes binary PCKs for the planets.
- Skyfield closes #952/#960 (a public multi-segment frame or a segment-aware `build_frame`):
  drop the two private names and `SegmentedFrame`, keep `test_moon_frame.py` as the regression.
