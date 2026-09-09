"""Horizon and equinox-of-date rotations as quaternions, LST and reference alt/az (D49).

`rotation_at` on `GeographicPosition`/`PlanetTopos` is the LEFT-handed north-east-up matrix
(brief l.523): rows are swapped to ENU before the quaternion conversion. Every function takes
one `Time` (scalar or array) and returns `(n, 4)`/`(n, 3)` arrays with `n >= 1`.
"""

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray
from skyfield.framelib import true_equator_and_equinox_of_date
from skyfield.starlib import Star
from skyfield.timelib import Time
from skyfield.toposlib import GeographicPosition
from skyfield.vectorlib import VectorFunction

from skyapi.astro.observers import Observer, ensure_coverage
from skyapi.astro.quaternions import make_sign_continuous, matrix_to_quaternion, neu_to_enu
from skyapi.astro.state import ConstellationMap
from skyapi.astro.time import FloatOrArray

Float64Array = NDArray[np.float64]


def _as_batch(matrix: Float64Array) -> Float64Array:
    """`(3, 3)` -> `(3, 3, 1)`; `(3, 3, N)` unchanged."""
    m = np.asarray(matrix, dtype=np.float64)
    return m[:, :, np.newaxis] if m.ndim == 2 else m


def _samples(vectors: Float64Array) -> Float64Array:
    """Skyfield `(3,)`/`(3, N)` -> `(n, 3)`."""
    return np.asarray(vectors, dtype=np.float64).reshape(3, -1).T


def horizon_quaternions(observer: Observer, t: Time) -> Float64Array:
    """ICRF -> ENU unit quaternions `(n, 4)`, sign-continuous along the window."""
    ensure_coverage(observer, t)
    neu = _as_batch(observer.topos.rotation_at(t))
    return make_sign_continuous(matrix_to_quaternion(neu_to_enu(neu)))


def equinox_of_date_quaternions(t: Time) -> Float64Array:
    """ICRF -> true equator and equinox of date `(n, 4)` (a proper rotation, brief l.532)."""
    matrix = _as_batch(
        np.asarray(true_equator_and_equinox_of_date.rotation_at(t), dtype=np.float64)
    )
    return make_sign_continuous(matrix_to_quaternion(matrix))


def lst_hours(observer: Observer, t: Time) -> FloatOrArray:
    """Local apparent sidereal time in hours (Earth only: other bodies have no equinox of date)."""
    if not isinstance(observer.topos, GeographicPosition):
        raise ValueError("local sidereal time is defined for Earth observers only")
    value = np.asarray(observer.topos.lst_hours_at(t), dtype=np.float64)
    return float(value) if value.ndim == 0 else value


def observer_velocity_au_d(observer: Observer, t: Time) -> Float64Array:
    """Barycentric velocity of the observer in au/day, `(n, 3)` (client-side aberration)."""
    ensure_coverage(observer, t)
    return _samples(np.asarray(observer.vector.at(t).velocity.au_per_d, dtype=np.float64))


@dataclass(frozen=True, slots=True)
class AltAz:
    """Authoritative values for `/sky/altaz`: degrees, hours and au, scalar or `(n,)`."""

    alt_deg: FloatOrArray
    az_deg: FloatOrArray
    ra_icrs_hours: FloatOrArray
    dec_icrs_deg: FloatOrArray
    ra_date_hours: FloatOrArray
    dec_date_deg: FloatOrArray
    distance_au: FloatOrArray
    constellation: str | None = None
    """IAU abbreviation of the containing constellation; set only with a `constellation_map`."""


def _plain(value: object) -> FloatOrArray:
    array = np.asarray(value, dtype=np.float64)
    return float(array) if array.ndim == 0 else array


def altaz_reference(
    observer: Observer,
    target: VectorFunction | Star,
    t: Time,
    *,
    refraction: bool,
    constellation_map: ConstellationMap | None = None,
) -> AltAz:
    """Apparent alt/az, ICRS and of-date RA/Dec and distance of `target` seen by `observer`.

    Refraction uses Skyfield's standard atmosphere and exists for Earth observers only
    (`altaz(temperature_C=...)` needs `GeographicPosition.refract`, brief l.525). With a
    `constellation_map` (scalar `t` only) the row also names the constellation containing the
    apparent position (D114: `/sky/altaz` answers it so no client precesses anything, brief l.62).
    """
    if refraction and not isinstance(observer.topos, GeographicPosition):
        raise ValueError("refraction is available for Earth observers only")
    ensure_coverage(observer, t)
    apparent = observer.vector.at(t).observe(target).apparent()
    if refraction:
        alt, az, distance = apparent.altaz(temperature_C="standard", pressure_mbar="standard")
    else:
        alt, az, distance = apparent.altaz()
    ra_icrs, dec_icrs, _ = apparent.radec()
    ra_date, dec_date, _ = apparent.radec(epoch=t)
    constellation = None if constellation_map is None else str(constellation_map(apparent))
    return AltAz(
        alt_deg=_plain(alt.degrees),
        az_deg=_plain(az.degrees),
        ra_icrs_hours=_plain(ra_icrs.hours),
        dec_icrs_deg=_plain(dec_icrs.degrees),
        ra_date_hours=_plain(ra_date.hours),
        dec_date_deg=_plain(dec_date.degrees),
        distance_au=_plain(distance.au),
        constellation=constellation,
    )
