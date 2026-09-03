"""Session fixtures for the catalog builders on the committed excerpts (D38, D40).

Activate with `-p support.fixtures_catalogs` (or list the module in `pytest_plugins`). Nothing
here needs a kernel: `SSB.at(t)` only needs the builtin timescale, so `built_caches` runs on any
clone without `make data`.
"""

from pathlib import Path

import pytest

from skyapi.catalogs.artifacts import CachePaths
from skyapi.catalogs.builders import build_constellations, build_dso, build_stars
from skyapi.catalogs.state import CatalogState, load_catalog_state

TESTS_DIR = Path(__file__).resolve().parents[1]
EXCERPTS_DIR = TESTS_DIR / "fixtures" / "excerpts"
CONSTELLATION_NAMES_CSV = TESTS_DIR.parent / "src" / "skyapi" / "data" / "constellation_names.csv"

STELLARIUM_DESCRIPTION_LICENSE_OK = (
    "# Modern\n\n## Introduction\n\nExcerpt written by the test suite.\n\n"
    "## Authors\n\nStellarium's team\n\n"
    "## License\n\nText and data: CC BY-SA 4.0\n\nIllustrations: Free Art License\n"
)


def write_description_md(directory: Path, text: str = STELLARIUM_DESCRIPTION_LICENSE_OK) -> Path:
    """A stand-in for the Stellarium `description.md`: only its `## License` section matters."""
    path = directory / "description.md"
    path.write_text(text, encoding="utf-8")
    return path


def build_excerpt_caches(root: Path) -> CachePaths:
    """Run the three builders on the excerpts into `root` (shared by fixtures and CLI tests)."""
    caches = CachePaths(root=root)
    build_stars(EXCERPTS_DIR / "hip_main_excerpt.dat", EXCERPTS_DIR / "hyg_v44_excerpt.csv", caches)
    build_dso(EXCERPTS_DIR / "NGC_excerpt.csv", EXCERPTS_DIR / "addendum_excerpt.csv", caches)
    build_constellations(
        EXCERPTS_DIR / "stellarium_modern_excerpt.json",
        write_description_md(root),
        EXCERPTS_DIR / "constellations_bounds_excerpt.json",
        CONSTELLATION_NAMES_CSV,
        caches.hipparcos_parquet,
        caches,
    )
    return caches


@pytest.fixture(scope="session")
def excerpts_dir() -> Path:
    return EXCERPTS_DIR


@pytest.fixture(scope="session")
def built_caches(tmp_path_factory: pytest.TempPathFactory) -> CachePaths:
    return build_excerpt_caches(tmp_path_factory.mktemp("cache"))


@pytest.fixture(scope="session")
def catalog_state(built_caches: CachePaths) -> CatalogState:
    return load_catalog_state(built_caches)
