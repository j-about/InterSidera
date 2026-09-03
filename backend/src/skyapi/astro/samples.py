"""Per-body sample arrays shared by planets (`bodies.py`) and minor bodies (`minor_bodies.py`).

Shapes follow the `/sky/frame` contract (brief l.165-166): `n` samples per body.
"""

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray


@dataclass(frozen=True, slots=True)
class Samples:
    """`dir` `(n, 3)` apparent ICRF unit vectors; the other arrays have shape `(n,)`."""

    dir: NDArray[np.float64]
    dist_au: NDArray[np.float64]
    mag: NDArray[np.float64]
    phase: NDArray[np.float64]
    diam_deg: NDArray[np.float64]

    def __post_init__(self) -> None:
        n = self.dir.shape[0]
        if self.dir.shape != (n, 3):
            raise ValueError(f"dir must have shape (n, 3), got {self.dir.shape}")
        for name in ("dist_au", "mag", "phase", "diam_deg"):
            arr: NDArray[np.float64] = getattr(self, name)
            if arr.shape != (n,):
                raise ValueError(f"{name} must have shape ({n},), got {arr.shape}")
