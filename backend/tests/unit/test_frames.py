"""frames.py: IAU rotation models from pck00011.tpc (D44, ADR-0007)."""

import numpy as np
import pytest
from skyfield.timelib import Time, Timescale

from skyapi.astro.frames import (
    IAU_FRAME_CENTERS,
    IauRotationFrame,
    RotationModel,
    frame_center_for,
    read_rotation_model,
)
from skyapi.astro.horizon import horizon_quaternions
from skyapi.astro.observers import Observer
from skyapi.astro.state import AstroState

pytestmark = pytest.mark.unit

MARS_SIDEREAL_DAY_S = 24 * 3600 + 37 * 60 + 22.66


def _det(matrix: np.ndarray) -> np.ndarray:
    return np.linalg.det(np.moveaxis(matrix, -1, 0)) if matrix.ndim == 3 else np.linalg.det(matrix)


def test_max_phase_degree_parsing(astro_state: AstroState) -> None:
    variables = astro_state.pc.variables
    mars = read_rotation_model(variables, 499, 4)
    assert mars.phase_degree == 2
    assert mars.term_count == 26  # 78 values in BODY4_NUT_PREC_ANGLES = 26 triples
    assert mars.nut_prec_angles_deg.shape == (26, 3)
    assert np.isclose(mars.nut_prec_angles_deg[4, 2], 12.711923222)  # the one non-zero quadratic
    assert np.isclose(mars.nut_prec_ra_deg[14], 0.419057)  # 15 amplitudes, padded to 26
    assert np.isclose(mars.nut_prec_dec_deg[19], 1.591274)
    assert np.isclose(mars.nut_prec_pm_deg[25], 0.584542)
    jupiter = read_rotation_model(variables, 599, 5)
    assert jupiter.phase_degree == 1
    assert jupiter.term_count == 15
    assert jupiter.nut_prec_angles_deg.shape == (15, 2)
    neptune = read_rotation_model(variables, 899, 8)
    assert neptune.term_count == 17
    assert np.isclose(neptune.nut_prec_ra_deg[0], 0.70)
    assert np.all(neptune.nut_prec_ra_deg[8:] == 0.0)
    for body, bary in ((999, 9), (299, 2)):
        model = read_rotation_model(variables, body, bary)
        assert model.term_count == 0
        assert model.nut_prec_angles_deg.shape == (0, 2)


def test_pluto_pole_and_meridian_at_j2000_are_the_constants(
    astro_state: AstroState, ts: Timescale
) -> None:
    frame = astro_state.iau_frames["pluto"]
    p = frame.pole_and_meridian_at(ts.tt_jd(2451545.0))
    assert np.isclose(p.ra_deg, 132.993)
    assert np.isclose(p.dec_deg, -6.163)
    assert np.isclose(p.w_deg, 302.695, atol=1e-6)
    assert np.isclose(p.w_rate, 56.3625225)
    assert np.isclose(p.ra_rate, 0.0)
    assert np.isclose(p.dec_rate, 0.0)


def test_mars_pole_at_j2000_carries_the_iau_2015_long_period_terms(
    astro_state: AstroState, ts: Timescale
) -> None:
    p = astro_state.iau_frames["mars"].pole_and_meridian_at(ts.tt_jd(2451545.0))
    # Non-zero trig terms at T = 0 (R34): alpha0 + 0.419057 sin 79.398797 and
    # delta0 + 1.591274 cos 166.325722.
    expected_ra = 317.269202 + 0.419057 * np.sin(np.radians(79.398797))
    expected_dec = 54.432516 + 1.591274 * np.cos(np.radians(166.325722))
    assert np.isclose(p.ra_deg, expected_ra, atol=1e-4)
    assert np.isclose(p.dec_deg, expected_dec, atol=1e-4)
    assert np.isclose(p.w_rate, 350.891982443297, atol=1e-3)
    assert 317.0 < p.ra_deg < 318.0
    assert 52.0 < p.dec_deg < 54.0


def test_w_advances_at_w1_degrees_per_day(astro_state: AstroState, ts: Timescale) -> None:
    frame = astro_state.iau_frames["jupiter"]
    p0 = frame.pole_and_meridian_at(ts.tt_jd(2460000.5))
    p1 = frame.pole_and_meridian_at(ts.tt_jd(2460001.5))
    assert np.isclose(p1.w_deg - p0.w_deg, 870.536, atol=1e-3)


def test_frames_are_proper_rotations(astro_state: AstroState, ts: Timescale) -> None:
    t = ts.tt_jd(np.asarray(2460000.5 + np.arange(5) * 100.0, dtype=np.float64))
    for observer_id, frame in astro_state.iau_frames.items():
        rotation = frame.rotation_at(t)
        assert rotation.shape == (3, 3, 5), observer_id
        assert np.allclose(_det(rotation), 1.0, atol=1e-12), observer_id
        products = np.einsum("ij...,kj...->ik...", rotation, rotation)
        assert np.allclose(np.moveaxis(products, -1, 0), np.eye(3), atol=1e-12), observer_id
        single = frame.rotation_at(t[0])
        assert single.shape == (3, 3)
        assert np.allclose(single, rotation[:, :, 0])
        assert frame.center == IAU_FRAME_CENTERS[observer_id]


def _central_difference(frame: IauRotationFrame, t: Time, ts: Timescale, h: float) -> np.ndarray:
    plus = ts.tt_jd(t.whole, t.tt_fraction + h)
    minus = ts.tt_jd(t.whole, t.tt_fraction - h)
    # Divide by the TDB span the frame actually saw: `Time.tdb` is a float64 Julian Date whose
    # 4.7e-10 day resolution would otherwise cap the check near 2e-6 for every frame.
    span = float(np.asarray(plus.tdb)) - float(np.asarray(minus.tdb))
    return (frame.rotation_at(plus) - frame.rotation_at(minus)) / span


def test_rotation_rate_matches_central_differences(astro_state: AstroState, ts: Timescale) -> None:
    t = ts.tt_jd(2460000.5)
    for observer_id, frame in astro_state.iau_frames.items():
        rotation, rate = frame.rotation_and_rate_at(t)
        assert np.allclose(rotation, frame.rotation_at(t))
        numeric = _central_difference(frame, t, ts, 1e-4)
        relative = np.linalg.norm(numeric - rate) / np.linalg.norm(rate)
        assert relative < 1e-6, (observer_id, relative)
    window = ts.tt_jd(np.array([2460000.5, 2460001.5, 2460002.5]))
    rotation, rate = astro_state.iau_frames["mars"].rotation_and_rate_at(window)
    assert rotation.shape == rate.shape == (3, 3, 3)


def test_mars_horizon_returns_after_one_sidereal_rotation(jezero: Observer, ts: Timescale) -> None:
    t0 = ts.tt_jd(2460000.5)
    q0 = horizon_quaternions(jezero, t0)[0]
    q1 = horizon_quaternions(
        jezero, ts.tt_jd(t0.whole, t0.tt_fraction + MARS_SIDEREAL_DAY_S / 86400.0)
    )[0]
    angle_deg = np.degrees(2.0 * np.arccos(min(1.0, abs(float(np.dot(q0, q1))))))
    assert angle_deg < 0.1
    q_half = horizon_quaternions(
        jezero, ts.tt_jd(t0.whole, t0.tt_fraction + 0.5 * MARS_SIDEREAL_DAY_S / 86400.0)
    )[0]
    assert np.degrees(2.0 * np.arccos(min(1.0, abs(float(np.dot(q0, q_half)))))) > 90.0


def test_frame_center_for() -> None:
    assert frame_center_for("mars") == 4
    assert frame_center_for("pluto") == 9
    assert frame_center_for("mercury") == 1
    with pytest.raises(ValueError, match="no IAU rotation frame"):
        frame_center_for("earth")


def _synthetic_variables() -> dict[str, object]:
    return {
        "BODY42_POLE_RA": [10.0, -0.1, 0.0],
        "BODY42_POLE_DEC": [80.0, 0.02],  # two coefficients are accepted (padded)
        "BODY42_PM": [30.0, 360.0, 0.0],
        "BODY4_NUT_PREC_ANGLES": [1.0, 2.0, 3.0, 4.0],
        "BODY42_NUT_PREC_RA": [0.5],
    }


def test_read_rotation_model_on_synthetic_variables() -> None:
    model = read_rotation_model(_synthetic_variables(), 42, 4)
    assert isinstance(model, RotationModel)
    assert model.term_count == 2
    assert np.array_equal(model.pole_dec_deg, [80.0, 0.02, 0.0])
    assert np.array_equal(model.nut_prec_ra_deg, [0.5, 0.0])
    assert np.array_equal(model.nut_prec_pm_deg, [0.0, 0.0])
    scalar_degree = _synthetic_variables() | {"BODY4_MAX_PHASE_DEGREE": 1}
    assert read_rotation_model(scalar_degree, 42, 4).phase_degree == 1


@pytest.mark.parametrize(
    ("override", "error", "match"),
    [
        ({"BODY42_POLE_RA": None}, KeyError, "POLE_RA"),
        ({"BODY42_POLE_RA": [1.0]}, ValueError, "coefficients"),
        ({"BODY42_PM": ["x", 1.0, 2.0]}, ValueError, "numbers"),
        ({"BODY4_NUT_PREC_ANGLES": [1.0, 2.0, 3.0]}, ValueError, "multiple"),
        ({"BODY42_NUT_PREC_RA": [0.5, 0.1, 0.2]}, ValueError, "amplitudes"),
        ({"BODY4_MAX_PHASE_DEGREE": 0}, ValueError, "MAX_PHASE_DEGREE"),
    ],
)
def test_read_rotation_model_rejects_malformed_variables(
    override: dict[str, object], error: type[Exception], match: str
) -> None:
    variables = _synthetic_variables()
    for key, value in override.items():
        if value is None:
            del variables[key]
        else:
            variables[key] = value
    with pytest.raises(error, match=match):
        read_rotation_model(variables, 42, 4)


def test_synthetic_frame_rotates_the_pole_to_z_and_advances_w() -> None:
    variables = {
        "BODY42_POLE_RA": [40.0, 0.0, 0.0],
        "BODY42_POLE_DEC": [60.0, 0.0, 0.0],
        "BODY42_PM": [0.0, 90.0, 0.0],
    }
    frame = IauRotationFrame(42, read_rotation_model(variables, 42, 4))

    class _T:
        tdb = 2451545.0

    pole = np.array(
        [
            np.cos(np.radians(60)) * np.cos(np.radians(40)),
            np.cos(np.radians(60)) * np.sin(np.radians(40)),
            np.sin(np.radians(60)),
        ]
    )
    rotation = frame.rotation_at(_T())  # type: ignore[arg-type]
    assert np.allclose(rotation @ pole, [0.0, 0.0, 1.0], atol=1e-12)
    # The node Q at RA alpha + 90 deg lies on the body equator at longitude -W (W = 0 at J2000).
    node = np.array([np.cos(np.radians(130)), np.sin(np.radians(130)), 0.0])
    assert np.allclose(rotation @ node, [1.0, 0.0, 0.0], atol=1e-12)

    class _T1:
        tdb = 2451546.0  # one day later: W = 90 deg, so Q sits at longitude -90 deg

    assert np.allclose(frame.rotation_at(_T1()) @ node, [0.0, -1.0, 0.0], atol=1e-12)  # type: ignore[arg-type]
