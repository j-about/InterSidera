"""Minor bodies (D42/D43): search index, on-demand Kepler orbits and `/sky/frame` samples.

Only `mpc/index.parquet` stays in memory (brief l.316), as compact numpy arrays: fixed-width ASCII
`S` byte arrays for ids and designations, float64 for magnitudes and epochs, a dict for the ~27 k
names (about 130 MB for the 1.56 M-row index instead of ~300 MB of Python strings). The index
rows are sorted by designation at build time, so prefix queries run `searchsorted` on the array
as loaded. Orbit rows are read from the Parquet tables one at a time and memoised in a per-state
LRU; nothing is module-level.

Ids (brief l.152): `a:<number>` for numbered asteroids, `a:<packed>` for unnumbered ones,
`c:<designation>` with spaces replaced by `_` for comets (`c:1P`, `c:C/1995_O1`).
"""

import re
import threading
from collections import OrderedDict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd
from numpy.typing import NDArray
from skyfield.constants import GM_SUN_DE440_km3_s2
from skyfield.data import mpc
from skyfield.timelib import Time, Timescale
from skyfield.vectorlib import VectorFunction

from skyapi.astro.frames import CoverageError
from skyapi.astro.samples import Samples
from skyapi.astro.time import MPC_ERROR_YEARS, MPC_WARN_YEARS
from skyapi.astro.warnings import SkyWarning
from skyapi.catalogs.artifacts import CachePaths
from skyapi.catalogs.mpc_build import pack_number, read_mpc_parquet
from skyapi.models.catalogs import MinorBodyKind, MinorBodySummary

DAYS_PER_JULIAN_YEAR = 365.25
DEFAULT_SLOPE_G = 0.15  # Bowell et al. 1989: adopted when MPCORB carries no G
DEFAULTS_MAX_H = 9.0  # brief l.155: asteroids with H <= 9 rank first in /minor-bodies/defaults
# (134340) Pluto is in MPCORB with H < 0 but is served as a major body (D36); listing it again
# among the default minor bodies would show two Plutos. It stays searchable.
DEFAULTS_EXCLUDED_IDS: frozenset[bytes] = frozenset({b"a:134340"})
ORBIT_CACHE_SIZE = 256

_ID_RE = re.compile(rb"^[ac]:\S+$")
_NUMBER_RE = re.compile(rb"^\d+$")
_COMET_SHORT_RE = re.compile(rb"^\d+[A-Za-z](?:-[A-Za-z]+)?$")
# Packed provisional designation of an unnumbered asteroid (`K24A00B`): the tail of its id.
_PACKED_PROVISIONAL_RE = re.compile(rb"^[A-Z]\d{2}[A-Z]\d{2}[0-9A-Za-z]$")


class UnknownMinorBodyError(LookupError):
    """No minor body carries the requested id (mapped to a 404 by the M2 handler)."""

    def __init__(self, body_id: str) -> None:
        super().__init__(f"unknown minor body id: {body_id!r}")
        self.body_id = body_id


@dataclass(frozen=True, slots=True)
class MinorBodyRow:
    """Metadata of one orbit row, kept next to its `VectorFunction` in the cache."""

    id: str
    designation: str
    name: str | None
    kind: MinorBodyKind
    elements_epoch_tt: float
    perihelion_tt: float | None
    h_mag: float | None
    slope_g: float | None
    magnitude_g: float | None
    magnitude_k: float | None


@dataclass(frozen=True, slots=True)
class MinorBodyIndex:
    """`mpc/index.parquet` as arrays in row order; rows are sorted by designation bytes."""

    ids: NDArray[np.bytes_]
    designations: NDArray[np.bytes_]  # sorted: prefix search runs `searchsorted` on it directly
    names: dict[int, str]  # row -> name, only for the named objects
    is_comet: NDArray[np.bool_]
    brightness: NDArray[np.float64]  # H for asteroids, g for comets (ranking only), NaN unknown
    elements_epoch_tt: NDArray[np.float64]
    comet_rows: NDArray[np.intp]
    comet_perihelion_tt: NDArray[np.float64]  # aligned with `comet_rows`
    sorted_ids: NDArray[np.bytes_]
    id_order: NDArray[np.intp]  # sorted_ids[i] is ids[id_order[i]]
    searchable_rows: NDArray[np.intp]  # named asteroids and every comet
    searchable_text: NDArray[np.bytes_]  # lower-cased name (asteroid) or designation (comet)

    def __len__(self) -> int:
        return int(self.ids.shape[0])

    def position_of(self, body_id: str) -> int | None:
        """Row of `body_id`, or None."""
        return self.position_of_bytes(body_id.encode("ascii", "ignore"))

    def position_of_bytes(self, key: bytes) -> int | None:
        if not key:
            return None
        at = int(np.searchsorted(self.sorted_ids, key))
        if at < self.sorted_ids.shape[0] and self.sorted_ids[at] == key:
            return int(self.id_order[at])
        return None

    def kind_of(self, row: int) -> MinorBodyKind:
        return "comet" if self.is_comet[row] else "asteroid"

    def summary(self, row: int) -> MinorBodySummary:
        h_mag: float | None = None
        if not self.is_comet[row]:
            value = float(self.brightness[row])
            h_mag = None if np.isnan(value) else value
        return MinorBodySummary(
            id=self.ids[row].decode("ascii"),
            designation=self.designations[row].decode("ascii"),
            name=self.names.get(row),
            kind=self.kind_of(row),
            h_mag=h_mag,
            elements_epoch_tt=float(self.elements_epoch_tt[row]),
        )


def _ascii_array(column: pd.Series[Any]) -> NDArray[np.bytes_]:
    """Text column -> fixed-width ASCII byte array (NaN -> b"")."""
    values = column.fillna("").to_numpy(dtype=object)
    return np.asarray(values, dtype="S")


def load_minor_body_index(cache: CachePaths) -> MinorBodyIndex:
    table = read_mpc_parquet(cache.mpc_index)
    ids = _ascii_array(table["id"])
    designations = _ascii_array(table["designation"])
    if designations.shape[0] > 1 and not bool(np.all(designations[:-1] <= designations[1:])):
        raise ValueError(f"{cache.mpc_index} is not sorted by designation: rebuild the caches")
    name_values = table["name"].to_numpy(dtype=object)
    named_rows = np.flatnonzero(table["name"].notna().to_numpy())
    names = {int(row): str(name_values[row]) for row in named_rows}
    is_comet = np.asarray(table["kind"].to_numpy(dtype=object) == "comet", dtype=np.bool_)
    h_mag = table["h_mag"].to_numpy(dtype=np.float64)
    magnitude_g = table["magnitude_g"].to_numpy(dtype=np.float64)
    brightness = np.where(is_comet, magnitude_g, h_mag)
    elements_epoch_tt = table["elements_epoch_tt"].to_numpy(dtype=np.float64)
    comet_rows = np.flatnonzero(is_comet).astype(np.intp)
    comet_perihelion_tt = table["perihelion_tt"].to_numpy(dtype=np.float64)[comet_rows]

    id_order = np.argsort(ids, kind="stable").astype(np.intp)
    searchable_rows = np.union1d(named_rows, comet_rows).astype(np.intp)
    searchable_values = [
        designations[row].lower() if is_comet[row] else names[int(row)].lower().encode("ascii")
        for row in searchable_rows
    ]
    searchable_text = (
        np.asarray(searchable_values, dtype="S")
        if searchable_values
        else np.asarray([], dtype="S1")
    )
    return MinorBodyIndex(
        ids=ids,
        designations=designations,
        names=names,
        is_comet=is_comet,
        brightness=brightness,
        elements_epoch_tt=elements_epoch_tt,
        comet_rows=comet_rows,
        comet_perihelion_tt=comet_perihelion_tt,
        sorted_ids=ids[id_order],
        id_order=id_order,
        searchable_rows=searchable_rows,
        searchable_text=searchable_text,
    )


def _prefix_range(sorted_values: NDArray[np.bytes_], prefix: bytes) -> tuple[int, int]:
    """Half-open slice of `sorted_values` whose entries start with `prefix`."""
    width = sorted_values.dtype.itemsize
    if len(prefix) >= width:
        low = int(np.searchsorted(sorted_values, prefix[:width], side="left"))
        high = int(np.searchsorted(sorted_values, prefix[:width], side="right"))
        return low, high
    low = int(np.searchsorted(sorted_values, prefix, side="left"))
    upper = prefix + b"\xff" * (width - len(prefix))
    high = int(np.searchsorted(sorted_values, upper, side="right"))
    return low, high


def _id_candidates(query: bytes) -> list[bytes]:
    if _ID_RE.match(query):
        return [query]
    if _NUMBER_RE.match(query):
        return [b"a:" + query]
    if _COMET_SHORT_RE.match(query):
        return [b"c:" + query.upper()]
    if _PACKED_PROVISIONAL_RE.match(query):
        return [b"a:" + query]
    return []


def search(index: MinorBodyIndex, q: str, limit: int = 20) -> list[MinorBodySummary]:
    """Exact id, then designation prefix, then name/comet substring; case-insensitive.

    Accepts `a:`/`c:` ids, bare numbers (`433` -> `a:433`, also the `(433` designation prefix)
    and short comet forms (`1P` -> `c:1P`). MPC designations proper are upper case, so the
    prefix query is upper-cased; names are matched as lower-cased substrings and ranked by
    brightness (H, or g for comets).
    """
    if limit <= 0:
        return []
    query = " ".join(q.split()).encode("ascii", "ignore")
    if not query:
        return []
    rows: list[int] = []
    seen: set[int] = set()

    def add(candidates: Iterable[int]) -> None:
        for row in candidates:
            if len(rows) >= limit:
                return
            if row not in seen:
                seen.add(row)
                rows.append(row)

    for candidate in _id_candidates(query):
        position = index.position_of_bytes(candidate)
        if position is not None:
            add([position])

    prefixes = [query.upper()]
    if _NUMBER_RE.match(query):
        prefixes.append(b"(" + query)
    for prefix in prefixes:
        low, high = _prefix_range(index.designations, prefix)
        add(range(low, min(high, low + limit)))

    if len(rows) < limit and index.searchable_text.shape[0]:
        hits = np.char.find(index.searchable_text, query.lower()) >= 0
        matched = index.searchable_rows[hits]
        if matched.shape[0]:
            brightness = np.nan_to_num(index.brightness[matched], nan=np.inf)
            order = np.lexsort((matched, brightness))
            add(int(row) for row in matched[order][:limit])

    return [index.summary(row) for row in rows[:limit]]


def defaults(index: MinorBodyIndex, now_tt: float, limit: int = 100) -> list[MinorBodySummary]:
    """Brief l.155: asteroids with H <= 9 by H, then comets with a fresh epoch by perihelion."""
    if limit <= 0:
        return []
    with np.errstate(invalid="ignore"):
        bright = np.flatnonzero(~index.is_comet & (index.brightness <= DEFAULTS_MAX_H))
    bright = bright[~np.isin(index.ids[bright], list(DEFAULTS_EXCLUDED_IDS))]
    bright = bright[np.lexsort((bright, index.brightness[bright]))]
    window_days = MPC_WARN_YEARS * DAYS_PER_JULIAN_YEAR
    comet_epochs = index.elements_epoch_tt[index.comet_rows]
    fresh_mask = np.abs(comet_epochs - now_tt) <= window_days
    proximity = np.nan_to_num(np.abs(index.comet_perihelion_tt[fresh_mask] - now_tt), nan=np.inf)
    fresh = index.comet_rows[fresh_mask]
    fresh = fresh[np.lexsort((fresh, proximity))]
    rows = np.concatenate([bright, fresh])[:limit]
    return [index.summary(int(row)) for row in rows]


class OrbitCache:
    """Thread-safe LRU of built orbits, owned by a `MinorBodyState` (never module-level)."""

    def __init__(self, capacity: int = ORBIT_CACHE_SIZE) -> None:
        if capacity < 1:
            raise ValueError("capacity must be at least 1")
        self._capacity = capacity
        self._lock = threading.Lock()
        self._entries: OrderedDict[str, tuple[VectorFunction, MinorBodyRow]] = OrderedDict()

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)

    def get(self, body_id: str) -> tuple[VectorFunction, MinorBodyRow] | None:
        with self._lock:
            entry = self._entries.get(body_id)
            if entry is not None:
                self._entries.move_to_end(body_id)
            return entry

    def put(self, body_id: str, entry: tuple[VectorFunction, MinorBodyRow]) -> None:
        with self._lock:
            self._entries[body_id] = entry
            self._entries.move_to_end(body_id)
            while len(self._entries) > self._capacity:
                self._entries.popitem(last=False)


@dataclass(frozen=True, slots=True)
class MinorBodyState:
    cache: CachePaths
    index: MinorBodyIndex
    ts: Timescale
    sun: VectorFunction
    orbits: OrbitCache = field(default_factory=OrbitCache)


def load_minor_body_state(cache: CachePaths, ts: Timescale, sun: VectorFunction) -> MinorBodyState:
    return MinorBodyState(cache=cache, index=load_minor_body_index(cache), ts=ts, sun=sun)


def _optional_float(value: object) -> float | None:
    if value is None:
        return None
    number = float(value)  # pyright: ignore[reportArgumentType]
    return None if np.isnan(number) else number


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _packed_designation(body_id: str) -> str:
    """`a:433` -> `00433`, `a:K24A00B` -> `K24A00B` (the asteroid table's sort key)."""
    tail = body_id[2:]
    return pack_number(int(tail)) if tail.isdigit() else tail


def _read_row(state: MinorBodyState, body_id: str, row: int) -> pd.Series[Any]:
    filters: list[tuple[str, str, object]] = [("id", "==", body_id)]
    if state.index.is_comet[row]:
        path = state.cache.mpc_comets
    else:
        path = state.cache.mpc_asteroids
        # The asteroid table is sorted by `designation_packed`, so this predicate lets pyarrow
        # skip every row group but one from the statistics (D43).
        filters.insert(0, ("designation_packed", "==", _packed_designation(body_id)))
    table = read_mpc_parquet(path, filters)
    if len(table) != 1:
        raise UnknownMinorBodyError(body_id)
    return table.iloc[0]


def orbit_for(state: MinorBodyState, body_id: str) -> tuple[VectorFunction, MinorBodyRow]:
    """`sun + Kepler orbit` for `body_id` (memoised) and the row metadata."""
    cached = state.orbits.get(body_id)
    if cached is not None:
        return cached
    row_index = state.index.position_of(body_id)
    if row_index is None:
        raise UnknownMinorBodyError(body_id)
    series = _read_row(state, body_id, row_index)
    kind = state.index.kind_of(row_index)
    if kind == "comet":
        orbit = mpc.comet_orbit(series, state.ts, GM_SUN_DE440_km3_s2)
        h_mag = None
        slope_g = None
        magnitude_g = _optional_float(series["magnitude_g"])
        magnitude_k = _optional_float(series["magnitude_k"])
        perihelion_tt = _optional_float(series["perihelion_tt"])
    else:
        orbit = mpc.mpcorb_orbit(series, state.ts, GM_SUN_DE440_km3_s2)
        h_mag = _optional_float(series["magnitude_H"])
        slope_g = _optional_float(series["magnitude_G"])
        magnitude_g = None
        magnitude_k = None
        perihelion_tt = None
    meta = MinorBodyRow(
        id=body_id,
        designation=str(series["designation"]),
        name=_optional_text(series["name"]),
        kind=kind,
        elements_epoch_tt=float(series["elements_epoch_tt"]),
        perihelion_tt=perihelion_tt,
        h_mag=h_mag,
        slope_g=slope_g,
        magnitude_g=magnitude_g,
        magnitude_k=magnitude_k,
    )
    entry = (state.sun + orbit, meta)
    state.orbits.put(body_id, entry)
    return entry


@dataclass(frozen=True, slots=True)
class MinorBodySamples:
    """One `minor[]` entry of `/sky/frame` (brief l.166): `samples` is None when unreliable."""

    samples: Samples | None
    elements_epoch_tt: float
    extrapolation_years: float
    warnings: list[SkyWarning]
    name: str | None
    kind: MinorBodyKind


def hg_magnitude(
    h_mag: float,
    slope_g: float,
    r_au: NDArray[np.float64],
    delta_au: NDArray[np.float64],
    phase_angle_rad: NDArray[np.float64],
) -> NDArray[np.float64]:
    """IAU H-G system (Bowell et al. 1989, Asteroids II, p. 549).

    V = H + 5 log10(r Δ) - 2.5 log10((1 - G) Φ1 + G Φ2), Φ1 = exp(-3.33 tan^0.63(α/2)),
    Φ2 = exp(-1.87 tan^1.22(α/2)).
    """
    half_tan = np.tan(phase_angle_rad / 2.0)
    phi1 = np.exp(-3.33 * np.power(half_tan, 0.63))
    phi2 = np.exp(-1.87 * np.power(half_tan, 1.22))
    with np.errstate(divide="ignore", invalid="ignore"):
        return (
            h_mag
            + 5.0 * np.log10(r_au * delta_au)
            - 2.5 * np.log10((1.0 - slope_g) * phi1 + slope_g * phi2)
        )


def comet_magnitude(
    magnitude_g: float,
    magnitude_k: float,
    r_au: NDArray[np.float64],
    delta_au: NDArray[np.float64],
) -> NDArray[np.float64]:
    """Total comet magnitude m = g + 5 log10 Δ + 2.5 k log10 r (MPC CometEls g/k convention)."""
    with np.errstate(divide="ignore", invalid="ignore"):
        return magnitude_g + 5.0 * np.log10(delta_au) + 2.5 * magnitude_k * np.log10(r_au)


def _magnitude(
    row: MinorBodyRow,
    r_au: NDArray[np.float64],
    delta_au: NDArray[np.float64],
    phase_angle_rad: NDArray[np.float64],
) -> NDArray[np.float64]:
    if row.kind == "comet":
        if row.magnitude_g is None or row.magnitude_k is None:
            return np.full(delta_au.shape, np.nan)
        return comet_magnitude(row.magnitude_g, row.magnitude_k, r_au, delta_au)
    if row.h_mag is None:
        return np.full(delta_au.shape, np.nan)
    slope = DEFAULT_SLOPE_G if row.slope_g is None else row.slope_g
    return hg_magnitude(row.h_mag, slope, r_au, delta_au, phase_angle_rad)


def extrapolation_warnings(elements_epoch_tt: float, years: float) -> list[SkyWarning]:
    """`mpc_extrapolation` beyond `MPC_WARN_YEARS`, plus `mpc_unreliable` beyond `MPC_ERROR_YEARS`.

    Both apply beyond 50 years: the frontend reads `mpc_unreliable` as the error state.
    """
    warnings: list[SkyWarning] = []
    params = {"years": round(years, 2)}
    if years > MPC_WARN_YEARS:
        half = MPC_WARN_YEARS * DAYS_PER_JULIAN_YEAR
        warnings.append(
            SkyWarning(
                "mpc_extrapolation",
                params,
                (elements_epoch_tt - half, elements_epoch_tt + half),
            )
        )
    if years > MPC_ERROR_YEARS:
        half = MPC_ERROR_YEARS * DAYS_PER_JULIAN_YEAR
        warnings.append(
            SkyWarning(
                "mpc_unreliable",
                params,
                (elements_epoch_tt - half, elements_epoch_tt + half),
            )
        )
    return warnings


def _as_columns(value: object) -> NDArray[np.float64]:
    """Skyfield `(3,)` or `(3, n)` position -> `(3, n)`."""
    return np.asarray(value, dtype=np.float64).reshape(3, -1)


def minor_body_samples(
    state: MinorBodyState,
    observer_vector: VectorFunction,
    t: Time,
    ids: Sequence[str],
    *,
    coverage_tt: tuple[float, float] | None = None,
) -> dict[str, MinorBodySamples]:
    """Apparent samples of each id from a barycentric observer vector at the times `t`.

    `dir` is the apparent ICRF unit vector, `phase` the illuminated fraction, `diam_deg` 0
    (sizes unknown). Magnitudes follow D36: H-G for asteroids, g/k for comets.

    `coverage_tt` is the ephemeris coverage behind `observer_vector`
    (`AstroState.ephemeris_coverage_tt`): a sample outside it raises `CoverageError` before any
    Skyfield call, because DE441 `Stack` targets return NaN silently outside their segments
    (R35) instead of raising.
    """
    tt = np.atleast_1d(np.asarray(t.tt, dtype=np.float64))
    if coverage_tt is not None:
        start, end = coverage_tt
        if bool(np.any(tt < start) or np.any(tt > end)):
            raise CoverageError(
                f"minor bodies are served for TT JD {start:.3f} to {end:.3f} only", coverage_tt
            )
    n = int(tt.shape[0])
    observer = observer_vector.at(t)
    observer_xyz = _as_columns(observer.xyz.au)
    sun_xyz = _as_columns(state.sun.at(t).xyz.au)
    out: dict[str, MinorBodySamples] = {}
    for body_id in ids:
        orbit, row = orbit_for(state, body_id)
        years = float(np.max(np.abs(tt - row.elements_epoch_tt))) / DAYS_PER_JULIAN_YEAR
        warnings = extrapolation_warnings(row.elements_epoch_tt, years)
        samples: Samples | None = None
        if years <= MPC_ERROR_YEARS:
            apparent = observer.observe(orbit).apparent()
            xyz = _as_columns(apparent.xyz.au)
            delta_au = np.linalg.norm(xyz, axis=0)
            direction = np.ascontiguousarray((xyz / delta_au).T)
            phase_angle = np.atleast_1d(
                np.asarray(apparent.phase_angle(state.sun).radians, dtype=np.float64)
            )
            r_au = np.linalg.norm(observer_xyz + xyz - sun_xyz, axis=0)
            samples = Samples(
                dir=direction,
                dist_au=delta_au,
                mag=_magnitude(row, r_au, delta_au, phase_angle),
                phase=0.5 * (1.0 + np.cos(phase_angle)),
                diam_deg=np.zeros(n, dtype=np.float64),
            )
        out[body_id] = MinorBodySamples(
            samples=samples,
            elements_epoch_tt=row.elements_epoch_tt,
            extrapolation_years=years,
            warnings=warnings,
            name=row.name,
            kind=row.kind,
        )
    return out
