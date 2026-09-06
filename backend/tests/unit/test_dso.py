"""DSO id resolution and directions over the excerpt catalog (brief l.144-146, D47)."""

import numpy as np
import pytest

from skyapi.astro.dso import UnknownDsoError, canonical_dso_id, dso_direction, resolve_dso_id
from skyapi.catalogs.state import CatalogState

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("NGC224", "NGC224"),
        ("NGC0224", "NGC224"),
        ("ngc 0224", "NGC224"),
        (" NGC224 ", "NGC224"),
        ("M31", "NGC224"),
        ("m031", "NGC224"),
        ("M 31", "NGC224"),
        ("M45", "Mel22"),
        ("Mel022", "Mel22"),
        ("M40", "M40"),
        ("M101", "NGC5457"),
        ("M102", "NGC5457"),
        ("NGC7318A", "NGC7318A"),
        ("ngc7318a", "NGC7318A"),
        ("B033", "B33"),
    ],
)
def test_resolve_dso_id(catalog_state: CatalogState, raw: str, expected: str) -> None:
    assert resolve_dso_id(catalog_state, raw).id == expected


@pytest.mark.parametrize("raw", ["NGC9999", "M111", "M0", "IC11", "IC67", "", "Andromeda"])
def test_unknown_dso(catalog_state: CatalogState, raw: str) -> None:
    with pytest.raises(UnknownDsoError):
        resolve_dso_id(catalog_state, raw)
    assert issubclass(UnknownDsoError, LookupError)


def test_canonical_dso_id() -> None:
    assert canonical_dso_id("IC0080 NED01") == "IC80_NED01"
    assert canonical_dso_id("ESO056-115") == "ESO56-115"
    assert canonical_dso_id("weird id") == "weird_id"


def test_dso_direction(catalog_state: CatalogState) -> None:
    andromeda = resolve_dso_id(catalog_state, "M31")
    direction = dso_direction(andromeda)
    assert direction.shape == (3,)
    assert np.linalg.norm(direction) == pytest.approx(1.0, abs=1e-12)
    ra = np.degrees(np.arctan2(direction[1], direction[0])) % 360.0
    dec = np.degrees(np.arcsin(direction[2]))
    assert ra == pytest.approx(andromeda.ra_deg, abs=1e-9)
    assert dec == pytest.approx(andromeda.dec_deg, abs=1e-9)
    assert direction[2] > 0.0  # +41 degrees

    pleiades = dso_direction(resolve_dso_id(catalog_state, "M45"))
    separation = np.degrees(np.arccos(np.clip(np.dot(direction, pleiades), -1.0, 1.0)))
    assert separation == pytest.approx(41.9, abs=0.2)


def test_state_catalog_indexes(catalog_state: CatalogState) -> None:
    dso = catalog_state.dso
    assert dso is not None
    assert len(dso.entries) == len(dso.by_id)
    assert all(dso.by_id[entry.id] is entry for entry in dso.entries)
    assert dso.messier[31] is dso.by_id["NGC224"]
    assert set(dso.messier) == set(range(1, 111))
