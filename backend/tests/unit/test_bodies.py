"""bodies.py: sample shapes and plausibility, magnitudes, the observer's own body (D36)."""

import numpy as np
import pytest
from skyfield.timelib import Timescale

from skyapi.astro.bodies import (
    BODY_IDS,
    EPHEMERIS_KEYS,
    absolute_magnitude_law,
    body_samples,
    excluded_body,
    moon_magnitude,
    sun_direction,
    sun_magnitude,
)
from skyapi.astro.frames import CoverageError
from skyapi.astro.observers import Observer, build_observer
from skyapi.astro.state import AstroState
from skyapi.astro.time import make_times

pytestmark = pytest.mark.unit

TT0 = 2460000.5


def test_body_table(astro_state: AstroState) -> None:
    assert BODY_IDS == (
        "sun",
        "mercury",
        "venus",
        "earth",
        "moon",
        "mars",
        "jupiter",
        "saturn",
        "uranus",
        "neptune",
        "pluto",
    )
    assert "mars barycenter" in EPHEMERIS_KEYS
    assert "mars" not in EPHEMERIS_KEYS
    bodies = astro_state.bodies
    assert bodies["sun"].kind == "star"
    assert bodies["sun"].radius_km == 695700.0
    assert bodies["moon"].kind == "moon"
    assert bodies["moon"].radius_km == 1737.4
    assert bodies["mars"].radius_km == 3396.19
    assert bodies["mars"].naif_code == 499
    assert bodies["pluto"].kind == "dwarf_planet"
    assert bodies["pluto"].ephemeris_key == "pluto barycenter"
    assert bodies["moon"].step_class == "moon"
    assert bodies["venus"].step_class == "inner_planets"
    assert bodies["earth"].name_key == "bodies.earth"
    for spec in bodies.values():
        assert spec.ephemeris_key in astro_state.eph  # every served key is in the kernel


def test_samples_from_greenwich_are_shaped_and_plausible(
    astro_state: AstroState, greenwich: Observer, ts: Timescale
) -> None:
    t = make_times(ts, TT0, 3600, 8)
    ids = [body_id for body_id in BODY_IDS if body_id != "earth"]
    samples = body_samples(astro_state, greenwich, t, ids)
    assert list(samples) == ids
    for body_id, sample in samples.items():
        assert sample.dir.shape == (8, 3), body_id
        assert np.allclose(np.linalg.norm(sample.dir, axis=1), 1.0, atol=1e-12)
        for name in ("dist_au", "mag", "phase", "diam_deg"):
            values = getattr(sample, name)
            assert values.shape == (8,), (body_id, name)
            assert np.all(np.isfinite(values)), (body_id, name)
        assert np.all(sample.dist_au > 0.0)
        assert np.all((sample.phase >= 0.0) & (sample.phase <= 1.0))
        assert np.all(sample.diam_deg > 0.0)
    assert np.all((samples["moon"].diam_deg > 0.49) & (samples["moon"].diam_deg < 0.56))
    assert np.all((samples["sun"].diam_deg > 0.524) & (samples["sun"].diam_deg < 0.543))
    assert np.all(samples["sun"].phase == 1.0)
    assert np.allclose(samples["sun"].mag, -26.74 + 5.0 * np.log10(samples["sun"].dist_au))
    assert np.all((samples["venus"].mag > -4.9) & (samples["venus"].mag < -3.8))
    assert np.all((samples["jupiter"].mag > -3.0) & (samples["jupiter"].mag < -1.5))
    assert np.all((samples["pluto"].mag > 13.5) & (samples["pluto"].mag < 15.0))
    assert np.all((samples["moon"].mag > -13.0) & (samples["moon"].mag < -5.0))
    assert np.all((samples["moon"].dist_au > 0.0024) & (samples["moon"].dist_au < 0.0028))


def test_earth_as_a_target_from_the_moon(
    astro_state: AstroState, tranquility: Observer, ts: Timescale
) -> None:
    samples = body_samples(astro_state, tranquility, ts.utc(2019, 12, 20), ["earth", "sun"])
    earth = samples["earth"]
    assert earth.dir.shape == (1, 3)
    assert 1.8 < earth.diam_deg[0] < 2.1
    assert 0.0 <= earth.phase[0] <= 1.0
    assert -18.0 < earth.mag[0] < -10.0
    assert samples["sun"].phase[0] == 1.0


def test_the_observers_own_body_and_unknown_ids_are_rejected(
    astro_state: AstroState, greenwich: Observer, tranquility: Observer, ts: Timescale
) -> None:
    t = ts.tt_jd(TT0)
    with pytest.raises(ValueError, match="from itself"):
        body_samples(astro_state, greenwich, t, ["sun", "earth"])
    with pytest.raises(ValueError, match="from itself"):
        body_samples(astro_state, tranquility, t, ["moon"])
    with pytest.raises(ValueError, match="unknown body ids: vulcan"):
        body_samples(astro_state, greenwich, t, ["sun", "vulcan"])
    assert body_samples(astro_state, greenwich, t, []) == {}


def test_excluded_body() -> None:
    assert excluded_body("earth") == "earth"
    assert excluded_body("moon") == "moon"
    assert excluded_body("pluto") == "pluto"
    assert excluded_body("nowhere") is None


def test_sun_direction(astro_state: AstroState, greenwich: Observer, ts: Timescale) -> None:
    t = make_times(ts, TT0, 3600, 8)
    direction = sun_direction(astro_state, greenwich, t)
    assert direction.shape == (8, 3)
    assert np.allclose(direction, body_samples(astro_state, greenwich, t, ["sun"])["sun"].dir)
    assert sun_direction(astro_state, greenwich, ts.tt_jd(TT0)).shape == (1, 3)


def test_saturn_magnitude_falls_back_where_skyfield_returns_nan(
    astro_state: AstroState, jezero: Observer, ts: Timescale
) -> None:
    # From Mars the Sun-Saturn-observer phase angle exceeds Mallama & Hilton's 6.5 deg limit for
    # part of the Martian year; `planetary_magnitude` returns NaN there and the H + 5 log10(r Δ)
    # law takes over.
    t = ts.tt_jd(np.asarray(TT0 + np.arange(24) * 30.0, dtype=np.float64))
    saturn = astro_state.eph["saturn barycenter"]
    phase_angle = jezero.vector.at(t).observe(saturn).apparent().phase_angle(astro_state.eph["sun"])
    assert np.max(np.asarray(phase_angle.degrees)) > 6.5
    samples = body_samples(astro_state, jezero, t, ["saturn"])["saturn"]
    assert np.all(np.isfinite(samples.mag))
    assert np.all((samples.mag > -1.0) & (samples.mag < 3.0))


def test_magnitude_laws() -> None:
    assert sun_magnitude(np.array([1.0]))[0] == -26.74
    assert np.isclose(sun_magnitude(np.array([10.0]))[0], -21.74)
    assert np.isclose(moon_magnitude(np.array([0.0]), np.array([384400.0]))[0], -12.73)
    quarter = moon_magnitude(np.array([np.pi / 2.0]), np.array([384400.0]))[0]
    assert np.isclose(quarter, -12.73 + 1.49 * np.pi / 2.0 + 0.043 * (np.pi / 2.0) ** 4)
    assert np.isclose(absolute_magnitude_law(-1.0, np.array([1.0]), np.array([1.0]))[0], -1.0)
    assert np.isclose(absolute_magnitude_law(-1.0, np.array([10.0]), np.array([10.0]))[0], 9.0)


def test_body_samples_check_coverage(astro_state: AstroState, ts: Timescale) -> None:
    observer = build_observer(astro_state, "earth", 0.0, 0.0)
    with pytest.raises(CoverageError):
        body_samples(astro_state, observer, ts.tt_jd(observer.coverage_tt[0] - 0.5), ["sun"])
    with pytest.raises(CoverageError):
        sun_direction(astro_state, observer, ts.tt_jd(observer.coverage_tt[1] + 0.5))
