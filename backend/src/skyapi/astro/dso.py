"""Deep-sky object lookups over the cached OpenNGC subset (brief l.144-146, D47)."""

import re

import numpy as np
from numpy.typing import NDArray
from skyfield.starlib import Star

from skyapi.catalogs.state import CatalogState, CatalogUnavailableError, DsoCatalog
from skyapi.models.catalogs import DsoEntry

_MESSIER = re.compile(r"^M\s*0*(\d+)$", re.IGNORECASE)
_CATALOG_ID = re.compile(r"^([A-Za-z]+)\s*0*(\d+)(.*)$")


class UnknownDsoError(LookupError):
    """No catalog entry matches the requested id."""

    def __init__(self, raw: str) -> None:
        super().__init__(f"unknown deep-sky object {raw!r}")
        self.raw = raw


def canonical_dso_id(raw: str) -> str:
    """`ngc 0224` -> `NGC224`, `ic0080 ned01` -> `IC80_NED01`: the builder's normalisation."""
    match = _CATALOG_ID.match(raw.strip())
    if match is None:
        return raw.strip().replace(" ", "_")
    prefix, number, rest = match.groups()
    return f"{prefix}{int(number)}{rest}".replace(" ", "_")


def dso_catalog(state: CatalogState) -> DsoCatalog:
    """The loaded DSO catalog, or `CatalogUnavailableError` when the data is missing (degraded)."""
    if state.dso is None:
        raise CatalogUnavailableError("dso")
    return state.dso


def resolve_dso_id(state: CatalogState, raw: str) -> DsoEntry:
    """Resolve a canonical id (`NGC7000`) or a Messier alias (`M31`, `M102`) to its entry."""
    catalog = dso_catalog(state)
    messier = _MESSIER.match(raw.strip())
    if messier is not None:
        entry = catalog.messier.get(int(messier.group(1)))
        if entry is not None:
            return entry
        raise UnknownDsoError(raw)
    canonical = canonical_dso_id(raw)
    entry = catalog.by_id.get(canonical)
    if entry is None:
        lowered = canonical.lower()
        entry = next(
            (candidate for key, candidate in catalog.by_id.items() if key.lower() == lowered),
            None,
        )
    if entry is None:
        raise UnknownDsoError(raw)
    return entry


def dso_direction(entry: DsoEntry) -> NDArray[np.float64]:
    """ICRS unit vector `(3,)` of the object's catalog position."""
    ra = np.radians(entry.ra_deg)
    dec = np.radians(entry.dec_deg)
    return np.array([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)])


def dso_star(entry: DsoEntry) -> Star:
    """A scalar `Star` at the catalog's ICRS J2000 position, without proper motion or parallax.

    `observe(star).apparent()` then applies aberration and deflection exactly as Skyfield does
    for any star, which is what `/sky/altaz` reports for `dso:` targets (D58).
    """
    return Star(ra_hours=entry.ra_deg / 15.0, dec_degrees=entry.dec_deg)
