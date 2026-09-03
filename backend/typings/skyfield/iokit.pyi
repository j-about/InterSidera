# Stubs for skyfield 1.55 iokit.py (see skyfield/__init__.pyi for the licence header).

from .timelib import Timescale as Timescale

class Loader:  # skyfield 1.55 iokit.py l.71
    directory: str  # skyfield 1.55 iokit.py l.106
    verbose: bool  # skyfield 1.55 iokit.py l.107
    def __init__(
        self, directory: str, verbose: bool = True, expire: bool = False
    ) -> None: ...  # skyfield 1.55 iokit.py l.105
    # `builtin=True` reads only the bundled iers.npz / delta_t.npz: no file in `directory` is
    # touched and nothing is downloaded (iokit.py l.349-358).
    def timescale(
        self, delta_t: float | None = None, builtin: bool = True
    ) -> Timescale: ...  # skyfield 1.55 iokit.py l.332
    # Deliberately NOT declared, so that any accidental use in skyapi is a pyright error:
    #   __call__ (l.164), path_to (l.149), download (l.276), open (l.302), tle/tle_file (l.233/257).
    # They download files when a name is missing from `directory`; skyapi must never let Skyfield
    # reach the network. Open kernels with `SpiceKernel(path)` and `open(path, "rb")` instead.
