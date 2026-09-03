# Type stubs for Skyfield 1.55 (https://github.com/skyfielders/python-skyfield), which ships no
# type information. Skyfield is Copyright (c) Brandon Rhodes and released under the MIT License;
# these stubs describe its API for pyright strict and are maintained by InterSidera (MIT).
# Only the surface used by skyapi is declared; every declaration cites the 1.55 source line.
#
# Conventions shared by every module of this stub package:
# - `@reify` / `@property` members are declared as plain attributes (they are read, never called).
# - `FloatOrArray` (skyfield/units.pyi) is a float or a float64 ndarray, Skyfield's usual duality.
# - Names that exist only in the stubs (Protocols, the classes behind framelib's singletons) are
#   prefixed with `_` or documented as stub-only: import them under `if TYPE_CHECKING:` only.

VERSION: tuple[int, int]  # skyfield 1.55 __init__.py l.8
__version__: str  # skyfield 1.55 __init__.py l.9
