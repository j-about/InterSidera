"""Canonical query objects of the compute endpoints (D55).

`api/canonical.py` builds them from the raw query parameters; `astro/frame.py` and
`astro/altaz.py` consume them. They live in `astro/` so that `astro/` never imports `api/`.
"""

from dataclasses import dataclass


def _join(values: tuple[str, ...]) -> str:
    return ",".join(values)


@dataclass(frozen=True, slots=True)
class FrameQuery:
    """Canonical `/sky/frame` request: rounded coordinates, clamped step, sorted id lists."""

    body: str
    lat_deg: float
    lon_deg: float
    elev_m: int
    tt0: float
    step_s: int
    n: int
    bodies: tuple[str, ...]
    minor: tuple[str, ...]

    def cache_key(self) -> str:
        """Sorted `key=value` pairs: the frame cache key and the canonical query string."""
        items = {
            "bodies": _join(self.bodies),
            "body": self.body,
            "elev": str(self.elev_m),
            "lat": repr(self.lat_deg),
            "lon": repr(self.lon_deg),
            "minor": _join(self.minor),
            "n": str(self.n),
            "step_s": str(self.step_s),
            "tt": repr(self.tt0),
        }
        return "&".join(f"{key}={items[key]}" for key in sorted(items))


@dataclass(frozen=True, slots=True)
class AltAzQuery:
    """Canonical `/sky/altaz` request."""

    body: str
    lat_deg: float
    lon_deg: float
    elev_m: int
    tt: float
    targets: tuple[str, ...]
    refraction: bool
