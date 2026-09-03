"""refraction.py: Skyfield's standard-atmosphere model as the reference for the client formula."""

import numpy as np
import pytest
from skyfield.timelib import Timescale

from skyapi.astro.observers import Observer
from skyapi.astro.refraction import (
    apparent_altitude_reference,
    refraction_table,
    standard_pressure_mbar,
)
from skyapi.astro.state import AstroState

pytestmark = pytest.mark.unit


def test_refraction_at_the_horizon() -> None:
    # Bennett's formula gives ~34' for an APPARENT altitude of 0 deg; Skyfield's `refract`
    # takes the TRUE altitude, so true 0 deg appears ~29' higher and true -34.5' appears at 0.
    true_zero = apparent_altitude_reference(0.0)
    assert isinstance(true_zero, float)
    assert 28.0 < true_zero * 60.0 < 30.0
    assert abs(apparent_altitude_reference(-34.5 / 60.0)) * 60.0 < 1.0


def test_refraction_is_monotonic_and_vanishes_at_the_zenith() -> None:
    alts = np.linspace(-1.0, 90.0, 912)
    apparent = np.asarray(apparent_altitude_reference(alts))
    assert apparent.shape == alts.shape
    assert np.all(np.diff(apparent) > 0.0)  # apparent altitude increases with true altitude
    lift = apparent - alts
    assert np.all(np.diff(lift[alts > -0.5]) <= 1e-12)  # refraction decreases with altitude
    assert apparent_altitude_reference(89.95) == 89.95
    assert np.isclose(lift[np.searchsorted(alts, 45.0)] * 60.0, 1.0, atol=0.1)  # ~1' at 45 deg


def test_elevation_lowers_the_pressure_and_the_refraction() -> None:
    assert standard_pressure_mbar(0.0) == 1010.0
    assert np.isclose(standard_pressure_mbar(9100.0), 1010.0 / np.e)
    assert apparent_altitude_reference(5.0, elevation_m=3000.0) < apparent_altitude_reference(5.0)


def test_refraction_table_pairs() -> None:
    table = refraction_table([-1.0, 0.0, 45.0, 90.0])
    assert [true for true, _ in table] == [-1.0, 0.0, 45.0, 90.0]
    assert all(isinstance(a, float) and isinstance(b, float) for a, b in table)
    assert table[3] == (90.0, 90.0)


def test_reference_matches_skyfield_altaz_with_standard_atmosphere(
    astro_state: AstroState, greenwich: Observer, ts: Timescale
) -> None:
    t = ts.tt_jd(np.asarray(2460000.5 + np.arange(24) / 24.0, dtype=np.float64))
    apparent = greenwich.vector.at(t).observe(astro_state.eph["sun"]).apparent()
    alt_true, _, _ = apparent.altaz()
    alt_refracted, _, _ = apparent.altaz(temperature_C="standard", pressure_mbar="standard")
    ours = apparent_altitude_reference(np.asarray(alt_true.degrees))
    assert np.allclose(ours, np.asarray(alt_refracted.degrees), atol=1e-9)
