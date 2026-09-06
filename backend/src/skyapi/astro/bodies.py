"""Solar-system body table and per-sample quantities for `/sky/frame` (D36, brief l.165).

Directions are apparent ICRF unit vectors (`.apparent()`: light-time, aberration, deflection)
so bodies and stars share one GPU pipeline. Magnitudes are display-only (0.5 mag tolerance):
Mercury..Neptune through Skyfield's `planetary_magnitude` (Mallama & Hilton 2018), with the
`H + 5 log10(r Δ)` fallback where those polynomials return NaN, and cited formulas for the Sun,
Moon and Pluto.
"""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import TYPE_CHECKING, cast

import numpy as np
from numpy.typing import NDArray
from skyfield.constants import AU_KM
from skyfield.magnitudelib import planetary_magnitude
from skyfield.positionlib import Apparent, Barycentric
from skyfield.timelib import Time
from skyfield.vectorlib import VectorFunction

from skyapi.astro.observers import Observer, ensure_coverage
from skyapi.astro.samples import Samples
from skyapi.astro.sampling import step_class
from skyapi.models.meta import BodyKind

if TYPE_CHECKING:
    from skyapi.astro.state import AstroState

Float64Array = NDArray[np.float64]


@dataclass(frozen=True, slots=True)
class _BodyRow:
    kind: BodyKind
    ephemeris_key: str
    naif_code: int  # PCK code for BODYnnn_RADII (and the rotation model of observers)


# Outer planets and Pluto are served by their barycenters (documented approximation, < 0.1");
# Mars too, because DE440-family kernels carry no Mars-centre segment (see IAU_FRAME_CENTERS).
BODY_TABLE: Mapping[str, _BodyRow] = MappingProxyType(
    {
        "sun": _BodyRow("star", "sun", 10),
        "mercury": _BodyRow("planet", "mercury", 199),
        "venus": _BodyRow("planet", "venus", 299),
        "earth": _BodyRow("planet", "earth", 399),
        "moon": _BodyRow("moon", "moon", 301),
        "mars": _BodyRow("planet", "mars barycenter", 499),
        "jupiter": _BodyRow("planet", "jupiter barycenter", 599),
        "saturn": _BodyRow("planet", "saturn barycenter", 699),
        "uranus": _BodyRow("planet", "uranus barycenter", 799),
        "neptune": _BodyRow("planet", "neptune barycenter", 899),
        "pluto": _BodyRow("dwarf_planet", "pluto barycenter", 999),
    }
)

BODY_IDS: tuple[str, ...] = tuple(BODY_TABLE)
EPHEMERIS_KEYS: tuple[str, ...] = tuple(
    dict.fromkeys(row.ephemeris_key for row in BODY_TABLE.values())
)

# Apparent V magnitude of the Sun at 1 au (Cox, Allen's Astrophysical Quantities, 4th ed., 2000).
SUN_V_AT_1_AU = -26.74
# Allen's phase law for the Moon: V = -12.73 + 1.49 |φ| + 0.043 φ⁴, φ the phase angle in
# radians, at the mean distance 384 400 km (Allen's Astrophysical Quantities).
MOON_MEAN_DISTANCE_KM = 384400.0
# Pluto V(1,0) = -1.0 (Explanatory Supplement to the Astronomical Almanac, as used by Stellarium).
PLUTO_H = -1.0
# Mean opposition V(1,0) used only where `planetary_magnitude` returns NaN (Saturn beyond 6.5°
# phase angle, Neptune beyond 1.9° before 2000): the constant terms of Mallama & Hilton (2018),
# "Computing apparent planetary magnitudes for The Astronomical Almanac", Astron. Comput. 25.
MEAN_OPPOSITION_H: Mapping[str, float] = MappingProxyType(
    {
        "mercury": -0.613,
        "venus": -4.384,
        "earth": -3.99,
        "mars": -1.601,
        "jupiter": -9.395,
        "saturn": -8.914,
        "uranus": -7.110,
        "neptune": -7.00,
    }
)


@dataclass(frozen=True, slots=True)
class BodySpec:
    """Static description of a body, equatorial radius filled from the text PCK at load time."""

    id: str
    kind: BodyKind
    ephemeris_key: str
    naif_code: int
    radius_km: float
    step_class: str
    name_key: str


def _equatorial_radius_km(variables: Mapping[str, object], code: int) -> float:
    value = variables.get(f"BODY{code}_RADII")
    if not isinstance(value, list):
        raise KeyError(f"BODY{code}_RADII is missing from the text PCK")
    items = cast(list[object], value)
    first = items[0] if items else None
    if isinstance(first, bool) or not isinstance(first, int | float) or first <= 0:
        raise ValueError(f"BODY{code}_RADII must start with a positive radius, got {first!r}")
    return float(first)


def build_body_specs(variables: Mapping[str, object]) -> Mapping[str, BodySpec]:
    """Body table with equatorial radii from the text PCK (`pc.variables`)."""
    specs = {
        body_id: BodySpec(
            id=body_id,
            kind=row.kind,
            ephemeris_key=row.ephemeris_key,
            naif_code=row.naif_code,
            radius_km=_equatorial_radius_km(variables, row.naif_code),
            step_class=step_class(body_id),
            name_key=f"bodies.{body_id}",
        )
        for body_id, row in BODY_TABLE.items()
    }
    return MappingProxyType(specs)


def excluded_body(observer_id: str) -> str | None:
    """The body id `bodies=all` must leave out: the observer's own body, matched by our id."""
    return observer_id if observer_id in BODY_TABLE else None


def sun_magnitude(distance_au: Float64Array) -> Float64Array:
    """V = -26.74 + 5 log10(d / 1 au)."""
    return SUN_V_AT_1_AU + 5.0 * np.log10(distance_au)


def moon_magnitude(phase_angle_rad: Float64Array, distance_km: Float64Array) -> Float64Array:
    """Allen's phase law plus the inverse-square distance term relative to 384 400 km."""
    phi = np.abs(phase_angle_rad)
    return (
        -12.73 + 1.49 * phi + 0.043 * phi**4 + 5.0 * np.log10(distance_km / MOON_MEAN_DISTANCE_KM)
    )


def absolute_magnitude_law(h: float, r_au: Float64Array, delta_au: Float64Array) -> Float64Array:
    """V = H + 5 log10(r Δ): no phase term, r heliocentric and Δ observer distances in au."""
    return h + 5.0 * np.log10(r_au * delta_au)


def _vectors(value: object) -> Float64Array:
    """Skyfield `(3,)`/`(3, N)` -> `(3, n)`."""
    return np.asarray(value, dtype=np.float64).reshape(3, -1)


def _body_magnitude(
    spec: BodySpec,
    apparent: Apparent,
    delta_au: Float64Array,
    r_au: Float64Array,
    phase_angle_rad: Float64Array,
) -> Float64Array:
    if spec.id == "sun":
        return sun_magnitude(delta_au)
    if spec.id == "moon":
        return moon_magnitude(phase_angle_rad, delta_au * AU_KM)
    if spec.id == "pluto":
        return absolute_magnitude_law(PLUTO_H, r_au, delta_au)
    magnitude = np.asarray(planetary_magnitude(apparent), dtype=np.float64).reshape(-1)
    fallback = absolute_magnitude_law(MEAN_OPPOSITION_H[spec.id], r_au, delta_au)
    return np.where(np.isnan(magnitude), fallback, magnitude)


def _observe(observer_at: Barycentric, body: VectorFunction) -> Apparent:
    return observer_at.observe(body).apparent()


def body_samples(
    state: AstroState, observer: Observer, t: Time, body_ids: Iterable[str]
) -> dict[str, Samples]:
    """Per-body samples for the window `t`: apparent direction, distance, magnitude, phase, size.

    The observer's own body cannot be a target (brief l.533): `ValueError`. Every Skyfield call
    is vectorised over `t`.
    """
    ids = list(body_ids)
    unknown = [body_id for body_id in ids if body_id not in state.bodies]
    if unknown:
        raise ValueError(f"unknown body ids: {', '.join(unknown)}")
    if observer.spec.id in ids:
        raise ValueError(f"cannot observe {observer.spec.id!r} from itself")
    ensure_coverage(observer, t)
    observer_at = observer.vector.at(t)
    sun = state.eph["sun"]
    sun_from_ssb = _vectors(sun.at(t).xyz.au)
    observer_from_ssb = _vectors(observer_at.xyz.au)
    out: dict[str, Samples] = {}
    for body_id in ids:
        spec = state.bodies[body_id]
        apparent = _observe(observer_at, state.eph[spec.ephemeris_key])
        xyz = _vectors(apparent.xyz.au)
        delta_au = np.linalg.norm(xyz, axis=0)
        direction = (xyz / delta_au).T
        n = delta_au.shape[0]
        if spec.kind == "star":
            phase_angle = np.zeros(n, dtype=np.float64)
            phase = np.ones(n, dtype=np.float64)
            r_au = np.ones(n, dtype=np.float64)
        else:
            # Same vector Skyfield's `phase_angle` uses (positionlib.py l.551-553): the
            # observer -> body vector minus the observer -> Sun vector, no light-time on the Sun.
            body_from_sun = xyz - sun_from_ssb + observer_from_ssb
            r_au = np.linalg.norm(body_from_sun, axis=0)
            phase_angle = np.asarray(apparent.phase_angle(sun).radians, dtype=np.float64).reshape(
                -1
            )
            phase = 0.5 * (1.0 + np.cos(phase_angle))
        diam_deg = np.degrees(2.0 * np.arcsin(np.minimum(spec.radius_km / AU_KM / delta_au, 1.0)))
        out[body_id] = Samples(
            dir=direction,
            dist_au=delta_au,
            mag=_body_magnitude(spec, apparent, delta_au, r_au, phase_angle),
            phase=phase,
            diam_deg=diam_deg,
        )
    return out


def sun_direction(state: AstroState, observer: Observer, t: Time) -> Float64Array:
    """Apparent ICRF unit vector towards the Sun, `(n, 3)` (lighting of body billboards)."""
    ensure_coverage(observer, t)
    xyz = _vectors(_observe(observer.vector.at(t), state.eph["sun"]).xyz.au)
    return (xyz / np.linalg.norm(xyz, axis=0)).T
