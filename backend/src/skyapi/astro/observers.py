"""Observers on Earth, the Moon and the planets (D44, brief l.61, l.528).

Earth uses Skyfield's WGS84 `GeographicPosition` (geodetic latitude). Every other body is a
`PlanetTopos` on a body-fixed frame: `MOON_ME_DE440_ME421` from the frame kernel plus the binary
PCK for the Moon, an `IauRotationFrame` from `pck00011.tpc` for the planets. Latitudes there are
planetocentric and the position sits at the IAU triaxial-ellipsoid radius for that latitude and
longitude plus the elevation (`build_latlon_degrees` rejects non-spherical bodies). The Sun is
never an observer.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import TYPE_CHECKING, cast

import numpy as np
from skyfield.planetarylib import PlanetTopos
from skyfield.timelib import Time
from skyfield.toposlib import GeographicPosition, wgs84
from skyfield.units import Angle, Distance
from skyfield.vectorlib import VectorFunction

from skyapi.astro.frames import CoverageError, IauRotationFrame, SegmentedFrame
from skyapi.astro.time import IAU_ROTATION_RELIABLE_TT
from skyapi.astro.warnings import SkyWarning, WarningCode
from skyapi.models.meta import LatitudeKind

if TYPE_CHECKING:
    from skyapi.astro.state import AstroState

EARTH_FRAME_NAME = "ITRS"
MOON_FRAME_NAME = "MOON_ME_DE440_ME421"


@dataclass(frozen=True, slots=True)
class _ObserverRow:
    ephemeris_key: str
    frame_name: str
    radii_code: int
    latitude_kind: LatitudeKind
    approximation_code: WarningCode | None


# Ephemeris keys are the vectors the topos is added to; planets whose kernels carry only the
# barycenter (Mars in DE440-family kernels, the giant planets) use it (see IAU_FRAME_CENTERS).
OBSERVER_TABLE: Mapping[str, _ObserverRow] = MappingProxyType(
    {
        "earth": _ObserverRow("earth", EARTH_FRAME_NAME, 399, "geodetic", None),
        "moon": _ObserverRow("moon", MOON_FRAME_NAME, 301, "planetocentric", None),
        "mercury": _ObserverRow("mercury barycenter", "IAU_MERCURY", 199, "planetocentric", None),
        "venus": _ObserverRow("venus barycenter", "IAU_VENUS", 299, "planetocentric", None),
        "mars": _ObserverRow("mars barycenter", "IAU_MARS", 499, "planetocentric", None),
        "jupiter": _ObserverRow("jupiter barycenter", "IAU_JUPITER", 599, "planetocentric", None),
        "saturn": _ObserverRow("saturn barycenter", "IAU_SATURN", 699, "planetocentric", None),
        "uranus": _ObserverRow("uranus barycenter", "IAU_URANUS", 799, "planetocentric", None),
        "neptune": _ObserverRow("neptune barycenter", "IAU_NEPTUNE", 899, "planetocentric", None),
        "pluto": _ObserverRow(
            "pluto barycenter", "IAU_PLUTO", 999, "planetocentric", "pluto_barycenter"
        ),
    }
)

OBSERVER_IDS: tuple[str, ...] = tuple(OBSERVER_TABLE)
IAU_OBSERVER_IDS: tuple[str, ...] = tuple(
    observer_id for observer_id, row in OBSERVER_TABLE.items() if row.frame_name.startswith("IAU_")
)


@dataclass(frozen=True, slots=True)
class ObserverSpec:
    """Static description of an observer body, radii filled from the text PCK at load time."""

    id: str
    ephemeris_key: str
    frame_name: str
    radii_km: tuple[float, float, float]
    latitude_kind: LatitudeKind
    approximation_code: WarningCode | None
    name_key: str

    @property
    def uses_iau_frame(self) -> bool:
        return self.frame_name.startswith("IAU_")


class UnknownObserverError(ValueError):
    """The observer id is not one of `OBSERVER_IDS` (the Sun included)."""


class ObserverUnavailableError(ValueError):
    """The observer exists but its orientation data is not loaded (Moon without the kernels)."""


def _radii_km(variables: Mapping[str, object], code: int) -> tuple[float, float, float]:
    value = variables.get(f"BODY{code}_RADII")
    if not isinstance(value, list):
        raise KeyError(f"BODY{code}_RADII is missing from the text PCK")
    items = cast(list[object], value)
    radii = [float(item) for item in items if isinstance(item, int | float)]
    if len(radii) != 3 or min(radii) <= 0.0:
        raise ValueError(f"BODY{code}_RADII must hold three positive numbers, got {value!r}")
    return radii[0], radii[1], radii[2]


def build_observer_specs(variables: Mapping[str, object]) -> Mapping[str, ObserverSpec]:
    """Observer table with radii from the text PCK (`pc.variables`)."""
    specs = {
        observer_id: ObserverSpec(
            id=observer_id,
            ephemeris_key=row.ephemeris_key,
            frame_name=row.frame_name,
            radii_km=_radii_km(variables, row.radii_code),
            latitude_kind=row.latitude_kind,
            approximation_code=row.approximation_code,
            name_key=f"bodies.{observer_id}",
        )
        for observer_id, row in OBSERVER_TABLE.items()
    }
    return MappingProxyType(specs)


def planetocentric_radius_km(
    radii_km: tuple[float, float, float], lat_deg: float, lon_deg: float
) -> float:
    """Distance from the centre to the triaxial ellipsoid surface along (φ, λ) planetocentric.

    r = 1 / sqrt((cos φ cos λ / a)² + (cos φ sin λ / b)² + (sin φ / c)²) with the PCK radii
    `(a, b, c)` (a spheroid has a = b, so λ drops out).
    """
    a, b, c = radii_km
    phi = np.radians(lat_deg)
    lam = np.radians(lon_deg)
    cos_phi = np.cos(phi)
    x = cos_phi * np.cos(lam) / a
    y = cos_phi * np.sin(lam) / b
    z = np.sin(phi) / c
    return float(1.0 / np.sqrt(x * x + y * y + z * z))


@dataclass(frozen=True, slots=True)
class Observer:
    """A located observer: the barycentric vector function and its topos, plus coverage."""

    spec: ObserverSpec
    vector: VectorFunction
    topos: GeographicPosition | PlanetTopos
    lat_deg: float
    lon_deg: float
    elev_m: float
    coverage_tt: tuple[float, float]


def observer_spec(state: AstroState, observer_id: str) -> ObserverSpec:
    """Look an observer up, raising `UnknownObserverError` for the Sun or any unknown id."""
    spec = state.observers.get(observer_id)
    if spec is None:
        raise UnknownObserverError(
            f"unknown observer {observer_id!r}; valid observers: {', '.join(OBSERVER_IDS)}"
        )
    return spec


def observer_coverage(state: AstroState, observer_id: str) -> tuple[float, float]:
    """TT range the observer can be served in: the ephemeris, intersected with the Moon kernel."""
    spec = observer_spec(state, observer_id)
    start, end = state.ephemeris_coverage_tt
    if spec.frame_name == MOON_FRAME_NAME:
        if state.moon_coverage_tt is None:
            raise ObserverUnavailableError(
                "the moon observer needs the Moon frame kernels (.tf and .bpc), not loaded"
            )
        moon_start, moon_end = state.moon_coverage_tt
        start, end = max(start, moon_start), min(end, moon_end)
    return start, end


def _frame_for(state: AstroState, spec: ObserverSpec) -> IauRotationFrame | SegmentedFrame:
    if spec.frame_name == MOON_FRAME_NAME:
        if state.moon_frame is None:
            raise ObserverUnavailableError(
                "the moon observer needs the Moon frame kernels (.tf and .bpc), not loaded"
            )
        return state.moon_frame
    frame = state.iau_frames.get(spec.id)
    if frame is None:
        raise ObserverUnavailableError(f"no rotation frame loaded for {spec.id!r}")
    return frame


def build_observer(
    state: AstroState, observer_id: str, lat_deg: float, lon_deg: float, elev_m: float = 0.0
) -> Observer:
    """Build the observer vector `eph[key] + topos` for a location on the named body."""
    spec = observer_spec(state, observer_id)
    if not -90.0 <= lat_deg <= 90.0:
        raise ValueError(f"latitude must be within [-90, 90] degrees, got {lat_deg}")
    coverage = observer_coverage(state, observer_id)
    body = state.eph[spec.ephemeris_key]
    topos: GeographicPosition | PlanetTopos
    if spec.frame_name == EARTH_FRAME_NAME:
        topos = wgs84.latlon(lat_deg, lon_deg, elevation_m=elev_m)
    else:
        frame = _frame_for(state, spec)
        radius_km = planetocentric_radius_km(spec.radii_km, lat_deg, lon_deg) + elev_m / 1000.0
        topos = PlanetTopos.from_latlon_distance(
            frame, Angle(degrees=lat_deg), Angle(degrees=lon_deg), Distance(km=radius_km)
        )
    return Observer(
        spec=spec,
        vector=body + topos,
        topos=topos,
        lat_deg=lat_deg,
        lon_deg=lon_deg,
        elev_m=elev_m,
        coverage_tt=coverage,
    )


def ensure_coverage(observer: Observer, t: Time) -> None:
    """Raise `CoverageError` when any sample of `t` falls outside the observer's coverage."""
    tt = np.atleast_1d(np.asarray(t.tt, dtype=np.float64))
    start, end = observer.coverage_tt
    if bool(np.any(tt < start) or np.any(tt > end)):
        raise CoverageError(
            f"observer {observer.spec.id!r} is served for TT JD {start:.3f} to {end:.3f} only",
            observer.coverage_tt,
        )


def observer_warnings(spec: ObserverSpec, t: Time) -> list[SkyWarning]:
    """Observer-related warnings: IAU model outside 1800..2200, Pluto barycenter approximation."""
    warnings: list[SkyWarning] = []
    if spec.uses_iau_frame:
        tt = np.atleast_1d(np.asarray(t.tt, dtype=np.float64))
        start, end = IAU_ROTATION_RELIABLE_TT
        if bool(np.any(tt < start) or np.any(tt > end)):
            warnings.append(
                SkyWarning("iau_rotation_approximate", range_tt=IAU_ROTATION_RELIABLE_TT)
            )
    if spec.approximation_code is not None:
        warnings.append(SkyWarning(spec.approximation_code))
    return warnings
