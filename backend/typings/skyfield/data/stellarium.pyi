# Stubs for skyfield 1.55 data/stellarium.py (see skyfield/__init__.pyi for the licence header).

from collections.abc import Iterable
from typing import IO, NamedTuple

class StarName(NamedTuple):  # skyfield 1.55 data/stellarium.py l.6
    hip: int
    name: str

# Deprecated constellationship.fab format: iterable of bytes lines.
def parse_constellations(
    lines: Iterable[bytes],
) -> list[tuple[str, list[tuple[int, int]]]]: ...  # skyfield 1.55 data/stellarium.py l.8

# Takes an OPEN FILE (json.load, l.46) of a Stellarium skycultures index.json; returns
# [(3-letter abbreviation from id[-3:], [(hip, hip), ...]), ...].
def parse_constellations_json(
    lines: IO[bytes] | IO[str],
) -> list[tuple[str, list[tuple[int, int]]]]: ...  # skyfield 1.55 data/stellarium.py l.29
def parse_star_names(
    lines: Iterable[bytes],
) -> list[StarName]: ...  # skyfield 1.55 data/stellarium.py l.57
