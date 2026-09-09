"""`/sky/altaz` composite (D58, brief l.171-172): target syntax and authoritative alt/az values.

Targets are `hip:<number>`, `dso:<id>` (canonical OpenNGC id or Messier alias), a body id,
`a:<number|packed>` or `c:<designation>`. Every value comes from Skyfield through
`altaz_reference`; bodies and minor bodies add the per-sample quantities of `/sky/frame`
(`dist_au`, `mag`, `phase`, `diam_deg`) computed with one `body_samples` call and one batched
`minor_body_samples` call for the whole request. Nothing here imports `api/`.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

import numpy as np
from numpy.typing import NDArray
from skyfield.timelib import Time

from skyapi.astro.bodies import BODY_TABLE, body_samples
from skyapi.astro.dso import dso_star, resolve_dso_id
from skyapi.astro.frames import CoverageError
from skyapi.astro.horizon import AltAz, altaz_reference
from skyapi.astro.minor_bodies import (
    DAYS_PER_JULIAN_YEAR,
    MINOR_BODY_ID_PATTERN,
    MinorBodySamples,
    minor_body_samples,
    orbit_for,
)
from skyapi.astro.observers import Observer, build_observer
from skyapi.astro.queries import AltAzQuery
from skyapi.astro.stars import hipparcos_star
from skyapi.astro.time import MPC_ERROR_YEARS, FloatOrArray
from skyapi.catalogs.state import CatalogUnavailableError
from skyapi.state import SkyState

TargetKind = Literal["hip", "dso", "body", "minor"]

_HIP_RE = re.compile(r"^hip:(\d{1,12})$")
_DSO_RE = re.compile(r"^dso:(\S+)$")
TARGET_SYNTAX = "hip:<number>, dso:<id>, a body id, a:<number> or c:<designation>"


class TargetSyntaxError(ValueError):
    """The target does not follow the contract's syntax (mapped to a 400 by the router)."""

    def __init__(self, raw: str) -> None:
        super().__init__(f"invalid target {raw!r}: expected {TARGET_SYNTAX}")
        self.raw = raw


@dataclass(frozen=True, slots=True)
class Target:
    """A parsed target: `raw` is echoed in the response, `key` is the catalog lookup key."""

    raw: str
    kind: TargetKind
    key: str
    """Body id, minor-body id, DSO id as written, or the Hipparcos number as digits."""


def parse_target(raw: str) -> Target:
    """Classify one target id; anything outside the four syntaxes is a `TargetSyntaxError`."""
    if raw in BODY_TABLE:
        return Target(raw, "body", raw)
    hip = _HIP_RE.match(raw)
    if hip is not None:
        return Target(raw, "hip", hip.group(1))
    dso = _DSO_RE.match(raw)
    if dso is not None:
        return Target(raw, "dso", dso.group(1))
    if MINOR_BODY_ID_PATTERN.match(raw):
        return Target(raw, "minor", raw)
    raise TargetSyntaxError(raw)


@dataclass(frozen=True, slots=True)
class AltAzResult:
    """One `/sky/altaz` row in degrees and au; optional fields are `None` when not applicable."""

    id: str
    alt_deg: float
    az_deg: float
    ra_icrs_deg: float
    dec_icrs_deg: float
    ra_date_deg: float
    dec_date_deg: float
    dist_au: float | None = None
    mag: float | None = None
    phase: float | None = None
    diam_deg: float | None = None
    constellation: str | None = None


def _scalar(value: FloatOrArray) -> float:
    return float(np.asarray(value, dtype=np.float64).reshape(-1)[0])


def _first(values: NDArray[np.float64]) -> float:
    return float(values[0])


def _optional_magnitude(value: float) -> float | None:
    return None if np.isnan(value) else value


def _result(
    raw: str,
    reference: AltAz,
    *,
    dist_au: float | None = None,
    mag: float | None = None,
    phase: float | None = None,
    diam_deg: float | None = None,
) -> AltAzResult:
    return AltAzResult(
        id=raw,
        alt_deg=_scalar(reference.alt_deg),
        az_deg=_scalar(reference.az_deg),
        ra_icrs_deg=_scalar(reference.ra_icrs_hours) * 15.0,
        dec_icrs_deg=_scalar(reference.dec_icrs_deg),
        ra_date_deg=_scalar(reference.ra_date_hours) * 15.0,
        dec_date_deg=_scalar(reference.dec_date_deg),
        dist_au=dist_au,
        mag=None if mag is None else _optional_magnitude(mag),
        phase=phase,
        diam_deg=diam_deg,
        constellation=reference.constellation,
    )


def _hipparcos_magnitude(sky: SkyState, hip: int) -> float:
    values: NDArray[np.float64] = sky.catalogs.hipparcos.loc[[hip], ["magnitude"]].to_numpy(
        dtype=np.float64
    )
    return float(values[0, 0])


def _unreliable(body_id: str, entry: MinorBodySamples) -> CoverageError:
    """An altaz row has no warnings channel and the backend never extrapolates silently.

    Elements beyond `MPC_ERROR_YEARS` answer 422 with `epoch +/- error_years`, the range the
    `mpc_unreliable` warning of `/sky/frame` carries (brief l.52).
    """
    half = MPC_ERROR_YEARS * DAYS_PER_JULIAN_YEAR
    range_tt = (entry.elements_epoch_tt - half, entry.elements_epoch_tt + half)
    return CoverageError(
        f"the orbital elements of {body_id} are {entry.extrapolation_years:.1f} years from the "
        f"requested time: served within TT JD {range_tt[0]:.3f} to {range_tt[1]:.3f} only",
        range_tt,
    )


def _minor_rows(
    sky: SkyState, observer: Observer, t: Time, targets: Sequence[Target], *, refraction: bool
) -> dict[str, AltAzResult]:
    """Rows of the minor-body targets: one batched samples call, one `altaz_reference` each."""
    minor_bodies = sky.minor_bodies
    if minor_bodies is None:
        raise CatalogUnavailableError("mpc")
    batched = minor_body_samples(
        minor_bodies,
        observer.vector,
        t,
        [target.key for target in targets],
        coverage_tt=sky.astro.ephemeris_coverage_tt,
    )
    rows: dict[str, AltAzResult] = {}
    for target in targets:
        entry = batched[target.key]
        samples = entry.samples
        if samples is None:
            raise _unreliable(target.key, entry)
        orbit = orbit_for(minor_bodies, target.key)
        reference = altaz_reference(
            observer,
            orbit.vector,
            t,
            refraction=refraction,
            constellation_map=sky.astro.constellation_at,
        )
        rows[target.raw] = _result(
            target.raw,
            reference,
            dist_au=_first(samples.dist_au),
            mag=_first(samples.mag),
            phase=_first(samples.phase),
        )
    return rows


def compute_altaz(sky: SkyState, query: AltAzQuery) -> list[AltAzResult]:
    """Authoritative alt/az, RA/Dec (ICRS and of date) and distances for every target.

    Results follow the order of `query.targets` (the canonical, sorted list). Lookups raise
    `UnknownStarError`, `UnknownDsoError` or `UnknownMinorBodyError`; a missing optional
    catalog raises `CatalogUnavailableError`; a date outside the data raises `CoverageError`.
    """
    targets = [parse_target(raw) for raw in query.targets]
    astro = sky.astro
    observer = build_observer(astro, query.body, query.lat_deg, query.lon_deg, float(query.elev_m))
    t = astro.ts.tt_jd(query.tt)
    refraction = query.refraction
    body_ids = [target.key for target in targets if target.kind == "body"]
    bodies = body_samples(astro, observer, t, body_ids) if body_ids else {}
    minor_targets = [target for target in targets if target.kind == "minor"]
    minor = (
        _minor_rows(sky, observer, t, minor_targets, refraction=refraction) if minor_targets else {}
    )

    results: list[AltAzResult] = []
    for target in targets:
        if target.kind == "body":
            spec = astro.bodies[target.key]
            reference = altaz_reference(
                observer,
                astro.eph[spec.ephemeris_key],
                t,
                refraction=refraction,
                constellation_map=astro.constellation_at,
            )
            samples = bodies[target.key]
            results.append(
                _result(
                    target.raw,
                    reference,
                    dist_au=_first(samples.dist_au),
                    mag=_first(samples.mag),
                    phase=_first(samples.phase),
                    diam_deg=_first(samples.diam_deg),
                )
            )
        elif target.kind == "hip":
            hip = int(target.key)
            star = hipparcos_star(astro.ts, sky.catalogs.hipparcos, hip)
            reference = altaz_reference(
                observer, star, t, refraction=refraction, constellation_map=astro.constellation_at
            )
            results.append(_result(target.raw, reference, mag=_hipparcos_magnitude(sky, hip)))
        elif target.kind == "dso":
            entry = resolve_dso_id(sky.catalogs, target.key)
            reference = altaz_reference(
                observer,
                dso_star(entry),
                t,
                refraction=refraction,
                constellation_map=astro.constellation_at,
            )
            results.append(_result(target.raw, reference, mag=entry.mag))
        else:
            results.append(minor[target.raw])
    return results
