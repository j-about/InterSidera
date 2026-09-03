"""Session fixtures for the astronomy core: `AstroState`, timescale, observers.

`tests/conftest.py` imports these fixtures by name (fixture modules are wired there, never through
`pytest_plugins` in a nested conftest) and provides the `kernels_dir` fixture they depend on: the
directory of the verified test kernels, `<repo>/data` or `INTERSIDERA_TEST_DATA_DIR`, the one
ambient variable tests may read (deliberately not `SKYAPI_`-prefixed so `clean_env` leaves it
alone). Nothing here downloads; only `kernels_dir` in `conftest.py` may.
"""

from collections.abc import Iterator
from pathlib import Path

import pytest
from skyfield.timelib import Timescale

from skyapi.astro.loader import kernel_paths, load_astro_state
from skyapi.astro.observers import Observer, build_observer
from skyapi.astro.state import AstroState

TEST_EPHEMERIS = "de440s.bsp"


@pytest.fixture(scope="session")
def astro_state(kernels_dir: Path) -> Iterator[AstroState]:
    state = load_astro_state(kernel_paths(kernels_dir, TEST_EPHEMERIS))
    yield state
    # Closing the kernels here keeps the ResourceWarning of a collected open file (fatal under
    # `filterwarnings = error`) out of the last test's teardown.
    state.close()


@pytest.fixture(scope="session")
def ts(astro_state: AstroState) -> Timescale:
    return astro_state.ts


@pytest.fixture(scope="session")
def greenwich(astro_state: AstroState) -> Observer:
    """Royal Observatory, Greenwich (WGS84 geodetic)."""
    return build_observer(astro_state, "earth", 51.48, 0.0, 0.0)


@pytest.fixture(scope="session")
def tranquility(astro_state: AstroState) -> Observer:
    """Tranquility Base, Moon (planetocentric, MOON_ME_DE440_ME421)."""
    return build_observer(astro_state, "moon", 0.674, 23.473, 0.0)


@pytest.fixture(scope="session")
def jezero(astro_state: AstroState) -> Observer:
    """Jezero crater, Mars (planetocentric, IAU_MARS)."""
    return build_observer(astro_state, "mars", 18.38, 77.58, 0.0)
