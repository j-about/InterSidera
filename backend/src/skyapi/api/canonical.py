"""Canonicalization of the compute-endpoint parameters (D55, brief l.102, l.169, l.172, l.534).

Pure functions: the router hands them the raw query values and receives a frozen `FrameQuery`
or `AltAzQuery` whose fields are what the response echoes and what the frame cache is keyed
on. Coordinates are rounded to 1e-6 degree, elevation to 1 m, `tt` to 1e-8 day; longitudes are
wrapped into [-180, 180); `-0.0` never appears; id lists are split on `,` only, stripped,
de-duplicated and sorted. Every violation is an `InvalidParameterError` (400).
"""

import math
from collections.abc import Iterable

from skyapi.astro.altaz import TargetSyntaxError, parse_target
from skyapi.astro.bodies import BODY_IDS, BODY_TABLE, excluded_body
from skyapi.astro.minor_bodies import MINOR_BODY_ID_PATTERN
from skyapi.astro.observers import EARTH_FRAME_NAME, OBSERVER_IDS, OBSERVER_TABLE
from skyapi.astro.queries import AltAzQuery, FrameQuery
from skyapi.astro.sampling import (
    MAX_FRAME_CELLS,
    MAX_MINOR_BODIES,
    MAX_SAMPLES,
    MAX_STEP_S_CEILING,
    MAX_TARGETS,
    MIN_STEP_S,
    clamp_step,
)
from skyapi.middleware.problem import InvalidParameterError

COORDINATE_DECIMALS = 6
TT_DECIMALS = 8
LAT_RANGE_DEG: tuple[float, float] = (-90.0, 90.0)
ELEV_RANGE_M: tuple[int, int] = (-12000, 100000)
LIST_SEPARATOR = ","


def _finite(value: float, name: str) -> float:
    if not math.isfinite(value):
        raise InvalidParameterError(f"{name} must be a finite number, got {value!r}")
    return value


def canonical_lat(lat: float) -> float:
    """Latitude rounded to 1e-6 degree, then validated within [-90, 90]; never `-0.0`."""
    value = round(_finite(lat, "lat"), COORDINATE_DECIMALS) + 0.0
    if not LAT_RANGE_DEG[0] <= value <= LAT_RANGE_DEG[1]:
        raise InvalidParameterError(
            f"lat must be within [{LAT_RANGE_DEG[0]:g}, {LAT_RANGE_DEG[1]:g}] degrees, got {lat!r}"
        )
    return value


def canonical_lon(lon: float) -> float:
    """East longitude rounded to 1e-6 degree and wrapped into [-180, 180); never `-0.0`."""
    value = round(_finite(lon, "lon"), COORDINATE_DECIMALS)
    value = ((value + 180.0) % 360.0) - 180.0
    return round(value, COORDINATE_DECIMALS) + 0.0


def canonical_elev(elev: float) -> int:
    """Elevation rounded to the metre, validated within [-12000, 100000]."""
    value = round(_finite(elev, "elev"))
    if not ELEV_RANGE_M[0] <= value <= ELEV_RANGE_M[1]:
        raise InvalidParameterError(
            f"elev must be within [{ELEV_RANGE_M[0]}, {ELEV_RANGE_M[1]}] metres, got {elev!r}"
        )
    return value


def canonical_tt(tt: float) -> float:
    """TT Julian Date rounded to 1e-8 day (about 1 ms); never `-0.0`."""
    return round(_finite(tt, "tt"), TT_DECIMALS) + 0.0


def canonical_observer(body: str) -> str:
    """One of `OBSERVER_IDS` (the Sun is never an observer)."""
    if body not in OBSERVER_TABLE:
        raise InvalidParameterError(
            f"unknown observer body {body!r}; valid observers: {', '.join(OBSERVER_IDS)}"
        )
    return body


def split_ids(raw: str, name: str) -> tuple[str, ...]:
    """Split a comma-separated id list: stripped, de-duplicated, sorted.

    An empty list, an empty item, or `+`/whitespace inside an item (another separator) is a
    400: the contract's lists use `,` only (Q24).
    """
    items = [item.strip() for item in raw.split(LIST_SEPARATOR)]
    for item in items:
        if not item:
            raise InvalidParameterError(f"{name}: empty item in the list {raw!r}")
        if "+" in item or any(character.isspace() for character in item):
            raise InvalidParameterError(f"{name}: invalid id {item!r}; separate ids with ',' only")
    return tuple(sorted(set(items)))


def expand_bodies(raw: str, observer_id: str) -> tuple[str, ...]:
    """`all` -> every body but the observer's own; an explicit list is validated and sorted."""
    items = split_ids(raw, "bodies")
    if "all" in items:
        if len(items) > 1:
            raise InvalidParameterError("bodies: 'all' cannot be combined with body ids")
        excluded = excluded_body(observer_id)
        return tuple(sorted(body_id for body_id in BODY_IDS if body_id != excluded))
    unknown = [body_id for body_id in items if body_id not in BODY_TABLE]
    if unknown:
        raise InvalidParameterError(
            f"unknown body ids: {', '.join(unknown)}; valid ids: all, {', '.join(BODY_IDS)}"
        )
    if observer_id in items:
        raise InvalidParameterError(f"cannot observe {observer_id!r} from itself")
    return items


def validate_minor_ids(ids: Iterable[str]) -> tuple[str, ...]:
    """Every id matches `^[ac]:[A-Za-z0-9/_.-]+$`; at most `MAX_MINOR_BODIES` of them."""
    items = tuple(ids)
    invalid = [body_id for body_id in items if MINOR_BODY_ID_PATTERN.match(body_id) is None]
    if invalid:
        raise InvalidParameterError(
            f"minor: invalid ids {', '.join(repr(item) for item in invalid)}; expected "
            "a:<number>, a:<packed designation> or c:<designation>"
        )
    if len(items) > MAX_MINOR_BODIES:
        raise InvalidParameterError(
            f"minor: {len(items)} ids requested, at most {MAX_MINOR_BODIES} allowed"
        )
    return items


def frame_query(
    *,
    body: str,
    lat: float,
    lon: float,
    elev: float,
    tt: float,
    step_s: int,
    n: int,
    bodies: str,
    minor: str | None,
) -> FrameQuery:
    """The canonical `/sky/frame` request: rounded, wrapped, clamped, sorted, capped."""
    observer_id = canonical_observer(body)
    body_ids = expand_bodies(bodies, observer_id)
    minor_ids = validate_minor_ids(split_ids(minor, "minor")) if minor is not None else ()
    if not MIN_STEP_S <= step_s <= MAX_STEP_S_CEILING:
        raise InvalidParameterError(
            f"step_s must be within [{MIN_STEP_S}, {MAX_STEP_S_CEILING}], got {step_s}"
        )
    if not 1 <= n <= MAX_SAMPLES:
        raise InvalidParameterError(f"n must be within [1, {MAX_SAMPLES}], got {n}")
    cells = n * (len(body_ids) + len(minor_ids))
    if cells > MAX_FRAME_CELLS:
        raise InvalidParameterError(
            f"n * (bodies + minor) = {cells} exceeds {MAX_FRAME_CELLS}: request fewer samples "
            "or fewer bodies"
        )
    return FrameQuery(
        body=observer_id,
        lat_deg=canonical_lat(lat),
        lon_deg=canonical_lon(lon),
        elev_m=canonical_elev(elev),
        tt0=canonical_tt(tt),
        step_s=clamp_step(step_s, body_ids, minor_ids),
        n=n,
        bodies=body_ids,
        minor=minor_ids,
    )


def altaz_query(
    *,
    body: str,
    lat: float,
    lon: float,
    elev: float,
    tt: float,
    targets: str,
    refraction: bool,
) -> AltAzQuery:
    """The canonical `/sky/altaz` request; every target is syntax-checked before any compute."""
    observer_id = canonical_observer(body)
    ids = split_ids(targets, "targets")
    if len(ids) > MAX_TARGETS:
        raise InvalidParameterError(
            f"targets: {len(ids)} ids requested, at most {MAX_TARGETS} allowed"
        )
    for raw in ids:
        try:
            target = parse_target(raw)
        except TargetSyntaxError as exc:
            raise InvalidParameterError(str(exc)) from exc
        if target.kind == "body" and target.key == observer_id:
            raise InvalidParameterError(f"cannot observe {observer_id!r} from itself")
    if refraction and OBSERVER_TABLE[observer_id].frame_name != EARTH_FRAME_NAME:
        raise InvalidParameterError(
            f"refraction is available for Earth observers only, not from {observer_id!r}"
        )
    return AltAzQuery(
        body=observer_id,
        lat_deg=canonical_lat(lat),
        lon_deg=canonical_lon(lon),
        elev_m=canonical_elev(elev),
        tt=canonical_tt(tt),
        targets=ids,
        refraction=refraction,
    )
