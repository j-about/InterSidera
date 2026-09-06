"""Sky invariants through the API (brief l.569): Polaris, the equinox Sun, Tranquility Base, Mars.

Every check goes through `/sky/altaz` and `/sky/frame` on the session `api_client`, with
request shapes that respect the step clamps (`bodies=earth,sun` allows 86400 s steps).
"""

from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from skyapi.astro.quaternions import rotate

pytestmark = pytest.mark.conformance

FRAME = "/api/v1/sky/frame"
ALTAZ = "/api/v1/sky/altaz"
DAY_S = 86400.0


def _altaz(client: TestClient, **params: Any) -> list[dict[str, Any]]:
    response = client.get(ALTAZ, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _frame(client: TestClient, **params: Any) -> dict[str, Any]:
    response = client.get(FRAME, params=params)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize("tt", [2451545.0, 2460000.5, 2488069.5])  # 2000, 2023, 2100
def test_polaris_altitude_from_greenwich_equals_the_latitude_within_one_degree(
    api_client: TestClient, tt: float
) -> None:
    (polaris,) = _altaz(
        api_client, body="earth", lat=51.48, lon=0.0, elev=0.0, tt=tt, targets="hip:11767"
    )
    assert abs(polaris["alt_deg"] - 51.48) < 1.0  # Polaris is about 0.6 deg from the pole


def test_sun_transits_near_the_zenith_at_the_equator_on_the_march_equinox(
    api_client: TestClient,
) -> None:
    # 2025-03-20: the equinox falls at 09:01 UTC; local apparent noon at longitude 0 is about
    # 12:07 UTC (equation of time -7 min). Sample the quarter hour around it every 45 s.
    noon_tt = 2460755.0 + (7.0 * 60.0 + 69.184) / DAY_S  # 12:07 UTC as TT
    grid = noon_tt + np.linspace(-7.5 * 60.0, 7.5 * 60.0, 21) / DAY_S
    altitudes = [
        _altaz(api_client, body="earth", lat=0.0, lon=0.0, elev=0.0, tt=float(tt), targets="sun")[
            0
        ]["alt_deg"]
        for tt in grid
    ]
    assert abs(max(altitudes) - 90.0) < 0.5


def test_from_tranquility_base_the_earth_hangs_still_while_the_sun_circles(
    api_client: TestClient,
) -> None:
    frame = _frame(
        api_client,
        body="moon",
        lat=0.674,
        lon=23.473,
        elev=0.0,
        tt=2460000.5,
        step_s=86400,
        n=30,
        bodies="earth,sun",
    )
    assert frame["time"]["step_s"] == 86400
    q = np.asarray(frame["horizon"]["q"], dtype=np.float64)
    samples = {
        entry["id"]: np.asarray(entry["samples"]["dir"], dtype=np.float64)
        for entry in frame["bodies"]
    }
    earth_enu = rotate(q, samples["earth"])
    sun_enu = rotate(q, samples["sun"])
    # Libration only: the Earth stays within 20 degrees of its first direction in the sky.
    separation = np.degrees(np.arccos(np.clip(earth_enu @ earth_enu[0], -1.0, 1.0)))
    assert np.max(separation) < 20.0
    assert np.max(separation) > 1.0  # but it does librate
    # The Sun sweeps a full circuit of the local sky over the lunar day (29.53 days): the
    # daily steps between consecutive directions add up to more than 300 degrees and the last
    # sample comes back close to the first one. (Azimuth itself is useless at an equatorial
    # site: the Sun rises at 90, crosses the zenith and sets at 270.)
    steps = np.degrees(np.arccos(np.clip(np.sum(sun_enu[1:] * sun_enu[:-1], axis=1), -1.0, 1.0)))
    assert np.all((steps > 8.0) & (steps < 16.0))  # 360 / 29.53 = 12.2 degrees per day
    assert float(np.sum(steps)) > 300.0
    closing = np.degrees(np.arccos(np.clip(float(sun_enu[-1] @ sun_enu[0]), -1.0, 1.0)))
    assert closing < 15.0


def test_mars_horizon_returns_after_one_sidereal_rotation(api_client: TestClient) -> None:
    tt0 = 2460000.5
    sidereal_day_s = 24 * 3600 + 37 * 60 + 23
    params: dict[str, Any] = {
        "body": "mars",
        "lat": 18.38,
        "lon": 77.58,
        "elev": 0.0,
        "n": 1,
        "bodies": "sun",
    }
    first = _frame(api_client, tt=tt0, **params)
    second = _frame(api_client, tt=tt0 + sidereal_day_s / DAY_S, **params)
    q1 = np.asarray(first["horizon"]["q"][0], dtype=np.float64)
    q2 = np.asarray(second["horizon"]["q"][0], dtype=np.float64)
    angle = np.degrees(2.0 * np.arccos(min(1.0, abs(float(np.dot(q1, q2))))))
    assert angle < 0.1
    # Half a rotation later the orientation is far away: the check is not vacuous.
    half = _frame(api_client, tt=tt0 + 0.5 * sidereal_day_s / DAY_S, **params)
    q3 = np.asarray(half["horizon"]["q"][0], dtype=np.float64)
    assert np.degrees(2.0 * np.arccos(min(1.0, abs(float(np.dot(q1, q3)))))) > 90.0
