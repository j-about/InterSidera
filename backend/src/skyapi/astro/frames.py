"""Body-fixed rotation frames Skyfield 1.55 cannot build itself (D44, D35, ADR-0007).

Two frame classes expose the interface `PlanetTopos` expects from `planetarylib.Frame`
(`center`, `rotation_at(t)`, `rotation_and_rate_at(t)`, rates per day):

- `IauRotationFrame`: the IAU/IAG rotation model (Archinal et al. 2018) read from the text PCK
  `pck00011.tpc` (`BODYnnn_POLE_RA/POLE_DEC/PM/NUT_PREC_*`). Skyfield only builds frames from
  binary PCK segments (planetarylib.py l.126-133) and NAIF publishes none for the planets, so
  this is the one piece of astronomy computed outside Skyfield.
- `SegmentedFrame`: several binary-PCK `Frame`s for one body dispatched by date, the workaround
  for Skyfield issues #952/#960 (`_segment_map` keeps only the last segment per body).

Matrices follow Skyfield: `(3, 3)` for a scalar `Time`, `(3, 3, N)` for an array.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import cast

import numpy as np
from numpy.typing import NDArray
from skyfield.constants import DEG2RAD
from skyfield.functions import mxm, rot_x, rot_z
from skyfield.planetarylib import Frame
from skyfield.timelib import Time

Float64Array = NDArray[np.float64]

J2000_TDB = 2451545.0
DAYS_PER_CENTURY = 36525.0
HALF_PI = np.pi / 2.0

# Ephemeris target each IAU frame is centred on, i.e. the `eph[...]` vector the topos is added
# to (`VectorFunction.__add__` requires `topos.center == vector.target`). DE440-family kernels
# carry no 4 -> 499 segment (de440s has none), so Mars uses its barycenter like the other
# planets; the Mars barycenter sits < 1 m from the planet's centre (Phobos and Deimos).
IAU_FRAME_CENTERS: Mapping[str, int] = MappingProxyType(
    {
        "mercury": 1,
        "venus": 2,
        "mars": 4,
        "jupiter": 5,
        "saturn": 6,
        "uranus": 7,
        "neptune": 8,
        "pluto": 9,
    }
)


class CoverageError(ValueError):
    """A requested time lies outside the data that would answer it; `range_tt` is the valid span."""

    def __init__(self, message: str, range_tt: tuple[float, float]) -> None:
        super().__init__(message)
        self.range_tt = range_tt


def frame_center_for(observer_id: str) -> int:
    """NAIF code of the ephemeris target an IAU-frame observer is attached to."""
    try:
        return IAU_FRAME_CENTERS[observer_id]
    except KeyError:
        raise ValueError(f"{observer_id!r} has no IAU rotation frame") from None


@dataclass(frozen=True, slots=True)
class RotationModel:
    """IAU rotation constants of one body, in degrees (text PCK conventions).

    `pole_ra_deg`/`pole_dec_deg` are `(a0, a1, a2)` with `a1` per Julian century and `a2` per
    century squared; `prime_meridian_deg` is `(W0, W1, W2)` with `W1` per day and `W2` per day
    squared; `nut_prec_angles_deg` holds one polynomial in T (centuries) per row, degree
    `BODY<bary>_MAX_PHASE_DEGREE`; the three amplitude arrays have one entry per angle.
    """

    body_id: int
    pole_ra_deg: Float64Array
    pole_dec_deg: Float64Array
    prime_meridian_deg: Float64Array
    nut_prec_angles_deg: Float64Array
    nut_prec_ra_deg: Float64Array
    nut_prec_dec_deg: Float64Array
    nut_prec_pm_deg: Float64Array

    @property
    def term_count(self) -> int:
        return int(self.nut_prec_angles_deg.shape[0])

    @property
    def phase_degree(self) -> int:
        return int(self.nut_prec_angles_deg.shape[1]) - 1


def _numbers(variables: Mapping[str, object], name: str) -> list[float] | None:
    """Return a text-PCK variable as floats, `None` when absent, `ValueError` when not numeric."""
    value = variables.get(name)
    if value is None:
        return None
    items: list[object] = cast(list[object], value) if isinstance(value, list) else [value]
    out: list[float] = []
    for item in items:
        if isinstance(item, bool) or not isinstance(item, int | float):
            raise ValueError(f"{name} must hold numbers, got {item!r}")
        out.append(float(item))
    return out


def _required(variables: Mapping[str, object], name: str, count: int) -> Float64Array:
    values = _numbers(variables, name)
    if values is None:
        raise KeyError(f"{name} is missing from the text PCK")
    if len(values) not in (count - 1, count):
        raise ValueError(f"{name} must have {count - 1} or {count} coefficients, got {len(values)}")
    padded = np.zeros(count, dtype=np.float64)
    padded[: len(values)] = values
    return padded


def _amplitudes(variables: Mapping[str, object], name: str, term_count: int) -> Float64Array:
    values = _numbers(variables, name)
    if values is None:
        return np.zeros(term_count, dtype=np.float64)
    if len(values) > term_count:
        raise ValueError(f"{name} has {len(values)} amplitudes for {term_count} angles")
    padded = np.zeros(term_count, dtype=np.float64)
    padded[: len(values)] = values
    return padded


def read_rotation_model(
    variables: Mapping[str, object], body_id: int, bary_id: int
) -> RotationModel:
    """Read `BODY<body_id>_*` and `BODY<bary_id>_NUT_PREC_ANGLES` from parsed text-PCK variables.

    `BODY<bary>_MAX_PHASE_DEGREE` (default 1) fixes the number of coefficients per angle:
    pck00011 gives Mars degree 2, so its 78 values are 26 triples, while Jupiter's 30 values are
    15 pairs; Pluto and Venus have no angles at all.
    """
    pole_ra = _required(variables, f"BODY{body_id}_POLE_RA", 3)
    pole_dec = _required(variables, f"BODY{body_id}_POLE_DEC", 3)
    prime_meridian = _required(variables, f"BODY{body_id}_PM", 3)
    degree_values = _numbers(variables, f"BODY{bary_id}_MAX_PHASE_DEGREE")
    degree = 1 if degree_values is None else int(degree_values[0])
    if degree < 1:
        raise ValueError(f"BODY{bary_id}_MAX_PHASE_DEGREE must be >= 1, got {degree}")
    angle_values = _numbers(variables, f"BODY{bary_id}_NUT_PREC_ANGLES") or []
    width = degree + 1
    if len(angle_values) % width:
        raise ValueError(
            f"BODY{bary_id}_NUT_PREC_ANGLES has {len(angle_values)} values,"
            f" not a multiple of {width} (degree {degree})"
        )
    angles = np.asarray(angle_values, dtype=np.float64).reshape(-1, width)
    term_count = angles.shape[0]
    return RotationModel(
        body_id=body_id,
        pole_ra_deg=pole_ra,
        pole_dec_deg=pole_dec,
        prime_meridian_deg=prime_meridian,
        nut_prec_angles_deg=angles,
        nut_prec_ra_deg=_amplitudes(variables, f"BODY{body_id}_NUT_PREC_RA", term_count),
        nut_prec_dec_deg=_amplitudes(variables, f"BODY{body_id}_NUT_PREC_DEC", term_count),
        nut_prec_pm_deg=_amplitudes(variables, f"BODY{body_id}_NUT_PREC_PM", term_count),
    )


@dataclass(frozen=True, slots=True)
class PoleAndMeridian:
    """α, δ, W in degrees and their rates in degrees per day (same shape as the time)."""

    ra_deg: Float64Array
    dec_deg: Float64Array
    w_deg: Float64Array
    ra_rate: Float64Array
    dec_rate: Float64Array
    w_rate: Float64Array


def _polynomial_and_rate(
    coefficients: Float64Array, x: Float64Array
) -> tuple[Float64Array, Float64Array]:
    """Evaluate rows of polynomials (Horner) and their derivatives at `x` (shape `()` or `(N,)`)."""
    rows = coefficients.shape[0]
    shape = (rows,) + (1,) * x.ndim
    value = np.zeros((rows, *x.shape), dtype=np.float64)
    rate = np.zeros_like(value)
    for k in range(coefficients.shape[1] - 1, -1, -1):
        rate = rate * x + value
        value = value * x + coefficients[:, k].reshape(shape)
    return value, rate


class IauRotationFrame:
    """Body-fixed frame from the IAU rotation model, usable wherever Skyfield wants a `Frame`.

    With T Julian centuries and d days of TDB since J2000 (SPICE `pck.req` conventions):
    α = α0 + α1 T + α2 T² + Σ aᵢ sin θᵢ, δ = δ0 + δ1 T + δ2 T² + Σ dᵢ cos θᵢ,
    W = W0 + W1 d + W2 d² + Σ wᵢ sin θᵢ, θᵢ polynomials in T. The ICRF -> body-fixed matrix is
    `rot_z(-W) · rot_x(-(π/2 - δ)) · rot_z(-(π/2 + α))`, the same Euler sequence Skyfield's
    `Frame.rotation_at` applies to binary-PCK angles (planetarylib.py l.169-170).
    """

    def __init__(self, center: int, model: RotationModel) -> None:
        self.center = center
        self.model = model

    def pole_and_meridian_at(self, t: Time) -> PoleAndMeridian:
        """α, δ, W (degrees) and their rates (degrees per day) at `t`."""
        m = self.model
        days = np.asarray(t.tdb, dtype=np.float64) - J2000_TDB
        centuries = days / DAYS_PER_CENTURY
        theta_deg, theta_rate_per_century = _polynomial_and_rate(m.nut_prec_angles_deg, centuries)
        theta = theta_deg * DEG2RAD
        # d(theta)/dd in radians per day, so that a_i cos(theta_i) theta_dot_i is in degrees/day.
        theta_rate = theta_rate_per_century / DAYS_PER_CENTURY * DEG2RAD
        sin_theta = np.sin(theta)
        cos_theta = np.cos(theta)
        a0, a1, a2 = m.pole_ra_deg
        d0, d1, d2 = m.pole_dec_deg
        w0, w1, w2 = m.prime_meridian_deg
        ra = a0 + a1 * centuries + a2 * centuries**2
        ra = ra + np.einsum("i,i...->...", m.nut_prec_ra_deg, sin_theta)
        dec = d0 + d1 * centuries + d2 * centuries**2
        dec = dec + np.einsum("i,i...->...", m.nut_prec_dec_deg, cos_theta)
        w = w0 + w1 * days + w2 * days**2
        w = w + np.einsum("i,i...->...", m.nut_prec_pm_deg, sin_theta)
        ra_rate = (a1 + 2.0 * a2 * centuries) / DAYS_PER_CENTURY
        ra_rate = ra_rate + np.einsum("i,i...->...", m.nut_prec_ra_deg, cos_theta * theta_rate)
        dec_rate = (d1 + 2.0 * d2 * centuries) / DAYS_PER_CENTURY
        dec_rate = dec_rate - np.einsum("i,i...->...", m.nut_prec_dec_deg, sin_theta * theta_rate)
        w_rate = w1 + 2.0 * w2 * days
        w_rate = w_rate + np.einsum("i,i...->...", m.nut_prec_pm_deg, cos_theta * theta_rate)
        return PoleAndMeridian(
            ra_deg=np.asarray(ra, dtype=np.float64),
            dec_deg=np.asarray(dec, dtype=np.float64),
            w_deg=np.asarray(w, dtype=np.float64),
            ra_rate=np.asarray(ra_rate, dtype=np.float64),
            dec_rate=np.asarray(dec_rate, dtype=np.float64),
            w_rate=np.asarray(w_rate, dtype=np.float64),
        )

    @staticmethod
    def _matrix(ra: Float64Array, dec: Float64Array, w: Float64Array) -> Float64Array:
        return mxm(rot_z(-w), mxm(rot_x(-dec), rot_z(-ra)))

    def rotation_at(self, t: Time) -> Float64Array:
        """ICRF -> body-fixed rotation matrix, `(3, 3)` or `(3, 3, N)`."""
        p = self.pole_and_meridian_at(t)
        ra = HALF_PI + p.ra_deg * DEG2RAD
        dec = HALF_PI - p.dec_deg * DEG2RAD
        w = p.w_deg * DEG2RAD
        return self._matrix(ra, dec, w)

    def rotation_and_rate_at(self, t: Time) -> tuple[Float64Array, Float64Array]:
        """Rotation matrix and its time derivative in radians per day.

        Same construction as Skyfield's `Frame.rotation_and_rate_at` (planetarylib.py
        l.181-209) with the binary-PCK angles `ra = π/2 + α`, `dec = π/2 - δ`, `w = W` and rates
        `radot = α̇`, `decdot = -δ̇`, `wdot = Ẅ`; our rates are already per day, so the `DAY_S`
        factor Skyfield applies to jplephem's per-second rates is not applied here.
        """
        p = self.pole_and_meridian_at(t)
        ra = HALF_PI + p.ra_deg * DEG2RAD
        dec = HALF_PI - p.dec_deg * DEG2RAD
        w = p.w_deg * DEG2RAD
        radot = p.ra_rate * DEG2RAD
        decdot = -p.dec_rate * DEG2RAD
        wdot = p.w_rate * DEG2RAD
        rotation = self._matrix(ra, dec, w)
        zero = w * 0.0
        ca = np.cos(w)
        sa = np.sin(w)
        u = np.cos(dec)
        v = -np.sin(dec)
        domega0 = wdot + u * radot
        domega1 = ca * decdot - sa * v * radot
        domega2 = sa * decdot + ca * v * radot
        drdtrt = np.array(
            (
                (zero, domega0, domega2),
                (-domega0, zero, domega1),
                (-domega2, -domega1, zero),
            )
        )
        return rotation, mxm(drdtrt, rotation)


class SegmentedFrame:
    """Binary-PCK frame made of several date-bounded segments for one body (D35).

    Skyfield's `PlanetaryConstants.read_binary` keeps only the last segment per body in
    `_segment_map` (issues #952 and #960), so `moon_pa_de440_200625.bpc`, whose two segments
    split at 2426, would answer only 2426-2650. Each segment becomes its own Skyfield `Frame`
    here and every time sample is routed to the segment covering it; a sample outside every
    segment raises `CoverageError` instead of jplephem's bare `ValueError`.
    """

    def __init__(
        self,
        name: str,
        center: int,
        frames: Sequence[Frame],
        initial_jds: Sequence[float],
        final_jds: Sequence[float],
        range_tt: tuple[float, float],
    ) -> None:
        if not frames or not len(frames) == len(initial_jds) == len(final_jds):
            raise ValueError(
                "frames, initial_jds and final_jds must be non-empty and equal in size"
            )
        initial = np.asarray(initial_jds, dtype=np.float64)
        final = np.asarray(final_jds, dtype=np.float64)
        if np.any(final <= initial):
            raise ValueError(f"{name}: every segment must end after it starts")
        if np.any(np.diff(initial) <= 0.0) or np.any(initial[1:] < final[:-1]):
            raise ValueError(f"{name}: segments must be sorted and non-overlapping")
        self.name = name
        self.center = center
        self.range_tt = range_tt
        self._frames = tuple(frames)
        self._initial = initial
        self._final = final

    @property
    def segment_count(self) -> int:
        return len(self._frames)

    @property
    def tdb_bounds(self) -> tuple[float, float]:
        return float(self._initial[0]), float(self._final[-1])

    def segment_index(self, tdb: NDArray[np.float64]) -> NDArray[np.intp]:
        """Segment index per TDB Julian Date; a shared boundary belongs to the later segment."""
        index = np.searchsorted(self._initial, tdb, side="right") - 1
        clipped = np.clip(index, 0, len(self._frames) - 1)
        outside = (index < 0) | (tdb > self._final[clipped])
        if np.any(outside):
            start, end = self.tdb_bounds
            raise CoverageError(
                f"{self.name} orientation covers TDB JD {start:.1f} to {end:.1f} only",
                self.range_tt,
            )
        return clipped

    def _parts(self, t: Time) -> list[tuple[Frame, Time, NDArray[np.intp] | None]]:
        tdb = np.asarray(t.tdb, dtype=np.float64)
        index = self.segment_index(tdb)
        if tdb.ndim == 0:
            return [(self._frames[int(index)], t, None)]
        parts: list[tuple[Frame, Time, NDArray[np.intp] | None]] = []
        for k in np.unique(index):
            where = np.nonzero(index == k)[0]
            parts.append((self._frames[int(k)], t[where], where))
        return parts

    def rotation_at(self, t: Time) -> Float64Array:
        """ICRF -> body-fixed rotation, `(3, 3)` or `(3, 3, N)`, from the covering segments."""
        parts = self._parts(t)
        frame, sub, where = parts[0]
        if where is None:
            return np.asarray(frame.rotation_at(sub), dtype=np.float64)
        n = int(np.asarray(t.tdb).shape[0])
        rotation = np.empty((3, 3, n), dtype=np.float64)
        for frame, sub, where in parts:
            rotation[:, :, where] = frame.rotation_at(sub)
        return rotation

    def rotation_and_rate_at(self, t: Time) -> tuple[Float64Array, Float64Array]:
        """Rotation and its derivative per day (Skyfield `Frame.rotation_and_rate_at` semantics)."""
        parts = self._parts(t)
        frame, sub, where = parts[0]
        if where is None:
            rotation, rate = frame.rotation_and_rate_at(sub)
            return np.asarray(rotation, dtype=np.float64), np.asarray(rate, dtype=np.float64)
        n = int(np.asarray(t.tdb).shape[0])
        rotation = np.empty((3, 3, n), dtype=np.float64)
        rate = np.empty((3, 3, n), dtype=np.float64)
        for frame, sub, where in parts:
            rotation[:, :, where], rate[:, :, where] = frame.rotation_and_rate_at(sub)
        return rotation, rate
