"""Constellation lookups over the cached `constellations.json` (brief l.148-150, D45).

The IAU boundaries are stored as `(ra_deg, dec_deg)` rings in 0..360. Point-in-polygon runs in
the unwrapped RA plane: successive vertices never differ by more than 180 degrees of RA, so the
ring is made continuous first; a ring whose RA winds a full turn encloses a pole (Octans, Ursa
Minor) and is closed through that pole before the even-odd test.
"""

from collections.abc import Sequence

import numpy as np
from numpy.typing import NDArray

from skyapi.catalogs.state import CatalogState, CatalogUnavailableError
from skyapi.models.catalogs import ConstellationEntry, ConstellationsResponse


class UnknownConstellationError(LookupError):
    def __init__(self, abbr: str) -> None:
        super().__init__(f"unknown constellation {abbr!r}")
        self.abbr = abbr


def constellation_catalog(state: CatalogState) -> ConstellationsResponse:
    """The loaded constellations, or `CatalogUnavailableError` when the data is missing."""
    if state.constellations is None:
        raise CatalogUnavailableError("constellations")
    return state.constellations


def constellation_by_abbr(state: CatalogState, abbr: str) -> ConstellationEntry:
    for entry in constellation_catalog(state).constellations:
        if entry.abbr == abbr:
            return entry
    raise UnknownConstellationError(abbr)


def unwrap_ring(ring: Sequence[tuple[float, float]]) -> NDArray[np.float64]:
    """Make RA continuous along the ring (no jump above 180 degrees) and drop the closing vertex."""
    vertices = np.asarray(ring, dtype=np.float64)
    if vertices.shape[0] > 1 and np.array_equal(vertices[0], vertices[-1]):
        vertices = vertices[:-1]
    ra = vertices[:, 0].copy()
    steps = np.diff(ra)
    ra[1:] -= 360.0 * np.cumsum(np.round(steps / 360.0))
    return np.column_stack([ra, vertices[:, 1]])


def _even_odd(polygon: NDArray[np.float64], x: float, y: float) -> bool:
    px = polygon[:, 0]
    py = polygon[:, 1]
    qx = np.roll(px, -1)
    qy = np.roll(py, -1)
    straddles = (py > y) != (qy > y)
    denominator = np.where(straddles, qy - py, 1.0)
    x_at_y = px + (y - py) * (qx - px) / denominator
    crossings = straddles & (x < x_at_y)
    return bool(np.count_nonzero(crossings) % 2 == 1)


def ring_contains(ring: Sequence[tuple[float, float]], ra_deg: float, dec_deg: float) -> bool:
    """Even-odd test of one boundary ring, RA wrap and polar rings handled."""
    polygon = unwrap_ring(ring)
    first, last = float(polygon[0, 0]), float(polygon[-1, 0])
    closing = ((first - last + 180.0) % 360.0) - 180.0  # shortest signed step back to the start
    winding = int(np.round((last + closing - first) / 360.0))
    if winding != 0:  # the ring circles a pole: close it through that pole
        pole = 90.0 if float(polygon[:, 1].mean()) > 0.0 else -90.0
        polygon = np.vstack([polygon, [[last + closing, pole], [first, pole]]])
    ra_min = float(polygon[:, 0].min())
    candidate = ra_min + (ra_deg - ra_min) % 360.0
    return any(_even_odd(polygon, candidate + shift, dec_deg) for shift in (-360.0, 0.0, 360.0))


def constellation_at(state: CatalogState, ra_deg: float, dec_deg: float) -> str | None:
    """IAU abbreviation of the constellation containing the ICRS J2000 position, if any."""
    ra = ra_deg % 360.0
    for entry in constellation_catalog(state).constellations:
        rings = entry.boundary_parts if entry.boundary_parts is not None else [entry.boundary]
        if any(ring_contains(ring, ra, dec_deg) for ring in rings):
            return entry.abbr
    return None
