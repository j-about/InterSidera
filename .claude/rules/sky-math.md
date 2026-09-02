---
paths:
  - "frontend/src/sky/**"
  - "frontend/src/state/url.ts"
  - "backend/src/skyapi/astro/quaternions.py"
  - "backend/src/skyapi/catalogs/formats.py"
---

# Sky mathematics rules (pure modules, 100 % coverage)

- `frontend/src/sky/math/*`, `frontend/src/state/url.ts`, `astro/quaternions.py` and `catalogs/formats.py` are pure and dependency-free: no Babylon, no React, no I/O, no Skyfield, no globals. They carry 100 % line coverage (brief l.294) and their tests load the shared fixtures under `backend/tests/fixtures/`.
- The frontend never computes an astronomical position from first principles (brief l.41). Allowed client-side operations: rotate by the backend horizon quaternion, apply linear proper motion with backend vectors, interpolate backend samples, first-order annual aberration with the backend observer velocity (stars only, c = 173.1446 au/day), and Saemundsson/Bennett refraction on Earth validated against Skyfield within 1 arcmin above -1 degree.
- Quaternions use the Hamilton convention: `v_enu = q * v_icrf * q^-1`, stored `[x, y, z, w]`. Consecutive samples are sign-continuous (positive dot product) so slerp never takes the long way; interpolation renormalises directions.
- Skyfield's altaz matrix is left-handed north-east-up: `quaternions.py` swaps rows x and y (NEU -> ENU) before the matrix-to-quaternion conversion and is tested against `altaz()` azimuth (`atan2(E, N)`) and altitude (`asin(U)`).
- The ENU -> Babylon mapping (left-handed, Y-up: East -> +X, Up -> +Y, North -> +Z; azimuth from north through east, clockwise from above) exists only in `frames.ts` with unit tests for az=0 -> +Z, az=90 -> +X, alt=90 -> +Y.
- Body samples are interpolated with cubic Hermite and Catmull-Rom tangents; the horizon quaternion is slerped on the CPU in float64 and uploaded as one uniform; no rotation accumulation on the GPU.
- Time: TT Julian Date (float64) is canonical; `tt_minus_utc_seconds` from the current frame converts to UTC; proleptic Gregorian with astronomical year numbering; our own Julian Date utilities, never moment/dayjs.
- `state/url.ts`: named parameters per UX-2, defensive parsing (unknown or invalid values fall back to defaults), rounding (coordinates 0.01 deg, alt/az 0.01 deg, fov 0.1 deg, tt 1e-6 day), stable serialization order.
- `formats.py` (SKYS v1): magic `SKYS`, `version u32`, `count u32`, `epoch_tt f64`, `flags u32`, then packed columns `dir f32[3n]`, `pm f32[3n]`, `mag i16[n]`, `bv i16[n]` (32767 unknown), `hip u32[n]`, little-endian, sorted by magnitude ascending; round-trip tested with hypothesis and mirrored byte-for-byte by the TypeScript parser.
- Shaders: GLSL for WebGL2 and WGSL for WebGPU, both implementing the same star rule `dir(t) = normalize(dir + pm * years)`, then aberration, then optional refraction; no point primitives (four vertices per star).
- Babylon imports (in `sky/engine/` only) use `@babylonjs/core/<module>` subpaths; `sky/math` imports nothing from Babylon.
- Fixture parity tolerances: stars <= 1 arcsec, bodies <= 1 arcmin for `step_s <= 3600` and `|speed| <= 3600`, refraction <= 1 arcmin.
