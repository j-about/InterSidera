"""`/sky/frame` composite (D56, brief l.157-169): one vectorised pass per canonical query.

Every Skyfield call runs over the single `Time` array of the window; the router only rounds,
converts and serialises the numpy arrays returned here. Nothing in this module imports `api/`.
"""

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from skyapi.astro.bodies import body_samples, sun_direction
from skyapi.astro.horizon import (
    equinox_of_date_quaternions,
    horizon_quaternions,
    lst_hours,
    observer_velocity_au_d,
)
from skyapi.astro.minor_bodies import MinorBodySamples, minor_body_samples
from skyapi.astro.observers import EARTH_FRAME_NAME, Observer, build_observer, observer_warnings
from skyapi.astro.queries import FrameQuery
from skyapi.astro.samples import Samples
from skyapi.astro.time import make_times, time_reference, time_warnings
from skyapi.astro.warnings import SkyWarning
from skyapi.catalogs.state import CatalogUnavailableError
from skyapi.models.meta import BodyKind
from skyapi.state import SkyState

Float64Array = NDArray[np.float64]


@dataclass(frozen=True, slots=True)
class FrameBodyResult:
    """One `bodies[]` entry; `warnings` is always empty at API v1 (no code applies to bodies)."""

    id: str
    kind: BodyKind
    samples: Samples
    warnings: list[SkyWarning]


@dataclass(frozen=True, slots=True)
class FrameResult:
    """Everything `/sky/frame` serialises, as numpy arrays of `n` samples."""

    observer: Observer
    observer_warnings: list[SkyWarning]
    tt0: float
    step_s: int
    n: int
    tt_minus_utc_seconds: float
    """TT - UTC at the first sample (TT - UT1 before 1972; the flag is not part of the contract)."""
    utc0: str
    lst_hours: Float64Array | None
    """Local apparent sidereal time `(n,)` for Earth observers, `None` elsewhere."""
    time_warnings: list[SkyWarning]
    horizon_q: Float64Array
    equinox_q: Float64Array
    observer_velocity_au_d: Float64Array
    sun_dir: Float64Array
    bodies: list[FrameBodyResult]
    minor: dict[str, MinorBodySamples]
    """In the order of `query.minor`; `samples` is `None` for unreliable elements."""


def compute_frame(sky: SkyState, query: FrameQuery) -> FrameResult:
    """Compute one frame for a canonical query.

    Raises `UnknownObserverError` (400), `ObserverUnavailableError` and
    `CatalogUnavailableError` (503, the Moon kernels or the MPC tables are missing),
    `CoverageError` (422, the window leaves the ephemeris or the observer frame) and
    `UnknownMinorBodyError` (404); the router maps them.
    """
    astro = sky.astro
    minor_bodies = sky.minor_bodies
    if query.minor and minor_bodies is None:
        raise CatalogUnavailableError("mpc")
    observer = build_observer(astro, query.body, query.lat_deg, query.lon_deg, float(query.elev_m))
    t = make_times(astro.ts, query.tt0, query.step_s, query.n)
    horizon_q = horizon_quaternions(observer, t)  # checks the coverage first (422)
    equinox_q = equinox_of_date_quaternions(t)
    velocity = observer_velocity_au_d(observer, t)
    sun_dir = sun_direction(astro, observer, t)
    samples = body_samples(astro, observer, t, query.bodies)
    bodies = [
        FrameBodyResult(
            id=body_id, kind=astro.bodies[body_id].kind, samples=samples[body_id], warnings=[]
        )
        for body_id in query.bodies
    ]
    minor: dict[str, MinorBodySamples] = {}
    if query.minor and minor_bodies is not None:
        minor = minor_body_samples(
            minor_bodies,
            observer.vector,
            t,
            query.minor,
            coverage_tt=astro.ephemeris_coverage_tt,
        )
    lst: Float64Array | None = None
    if observer.spec.frame_name == EARTH_FRAME_NAME:
        lst = np.atleast_1d(np.asarray(lst_hours(observer, t), dtype=np.float64))
    tt_minus_utc, utc0 = time_reference(t)
    return FrameResult(
        observer=observer,
        observer_warnings=observer_warnings(observer.spec, t),
        tt0=query.tt0,
        step_s=query.step_s,
        n=query.n,
        tt_minus_utc_seconds=tt_minus_utc,
        utc0=utc0,
        lst_hours=lst,
        time_warnings=time_warnings(astro.ts, t),
        horizon_q=horizon_q,
        equinox_q=equinox_q,
        observer_velocity_au_d=velocity,
        sun_dir=sun_dir,
        bodies=bodies,
        minor=minor,
    )
