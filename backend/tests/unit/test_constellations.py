"""Constellation lookups and point-in-polygon over the excerpt boundaries (brief l.148-150, D45)."""

import numpy as np
import pytest

from skyapi.astro.constellations import (
    UnknownConstellationError,
    constellation_at,
    constellation_by_abbr,
    ring_contains,
    unwrap_ring,
)
from skyapi.catalogs.state import CatalogState

pytestmark = pytest.mark.unit

# ICRS J2000 positions (degrees), from the Hipparcos catalogue.
BETELGEUSE = (88.7929, 7.4071)
POLARIS = (37.9546, 89.2641)
DUBHE = (165.9320, 61.7510)
ACRUX = (186.6496, -63.0991)
SCHEDAR = (10.1268, 56.5373)
ETA_SERPENTIS = (275.3275, -2.8988)  # Serpens Cauda
UNUKALHAI = (236.0670, 6.4256)  # alpha Ser, Serpens Caput
ANTARES = (247.3519, -26.4320)  # Sco, not in the excerpt


def test_constellation_by_abbr(catalog_state: CatalogState) -> None:
    orion = constellation_by_abbr(catalog_state, "Ori")
    assert orion.latin == "Orion"
    with pytest.raises(UnknownConstellationError, match="Sco"):
        constellation_by_abbr(catalog_state, "Sco")


@pytest.mark.parametrize(
    ("position", "expected"),
    [
        (BETELGEUSE, "Ori"),
        (POLARIS, "UMi"),
        (DUBHE, "UMa"),
        (ACRUX, "Cru"),
        (SCHEDAR, "Cas"),
        (ETA_SERPENTIS, "Ser"),
        (UNUKALHAI, "Ser"),
        ((359.9, 60.0), "Cas"),  # Cassiopeia straddles RA 0
        ((-0.1, 60.0), "Cas"),  # negative RA wraps
        ((180.0, 89.9), "UMi"),  # next to the pole, opposite Polaris in RA
        (ANTARES, None),
        ((0.0, -89.0), None),  # Octans is not in the excerpt
    ],
)
def test_constellation_at(catalog_state: CatalogState, position, expected) -> None:
    ra, dec = position
    assert constellation_at(catalog_state, ra, dec) == expected


def test_unwrap_ring_makes_ra_continuous() -> None:
    ring = [(350.0, 10.0), (5.0, 10.0), (5.0, 20.0), (350.0, 20.0), (350.0, 10.0)]
    unwrapped = unwrap_ring(ring)
    assert unwrapped.shape == (4, 2)
    assert unwrapped[:, 0].tolist() == [350.0, 365.0, 365.0, 350.0]


def test_ring_contains_across_the_ra_wrap() -> None:
    ring = [(350.0, 10.0), (5.0, 10.0), (5.0, 20.0), (350.0, 20.0), (350.0, 10.0)]
    assert ring_contains(ring, 0.0, 15.0)
    assert ring_contains(ring, 359.0, 15.0)
    assert ring_contains(ring, 4.0, 19.0)
    assert not ring_contains(ring, 10.0, 15.0)
    assert not ring_contains(ring, 0.0, 25.0)
    assert not ring_contains(ring, 180.0, 15.0)


def test_ring_contains_polar_cap() -> None:
    cap = [(ra, 80.0) for ra in np.linspace(0.0, 360.0, 13)[:-1]]
    cap.append(cap[0])
    assert ring_contains(cap, 123.0, 85.0)
    assert ring_contains(cap, 0.0, 89.99)
    assert not ring_contains(cap, 123.0, 75.0)
    assert not ring_contains(cap, 123.0, -85.0)
    south = [(ra, -80.0) for ra in np.linspace(360.0, 0.0, 13)[:-1]]
    south.append(south[0])
    assert ring_contains(south, 200.0, -88.0)
    assert not ring_contains(south, 200.0, -70.0)


def test_serpens_parts_are_disjoint(catalog_state: CatalogState) -> None:
    serpens = constellation_by_abbr(catalog_state, "Ser")
    assert serpens.boundary_parts is not None
    caput, cauda = serpens.boundary_parts
    assert ring_contains(caput, *UNUKALHAI)
    assert not ring_contains(cauda, *UNUKALHAI)
    assert ring_contains(cauda, *ETA_SERPENTIS)
    assert not ring_contains(caput, *ETA_SERPENTIS)
