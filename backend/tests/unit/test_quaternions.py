"""quaternions.py: Hamilton `[x, y, z, w]`, Shepperd conversion, NEU -> ENU, sign continuity.

Pure module, 100 % line coverage required (sky-math.md); property tests with hypothesis.
"""

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from skyapi.astro.quaternions import (
    make_sign_continuous,
    matrix_to_quaternion,
    neu_to_enu,
    quaternion_to_matrix,
    rotate,
    slerp,
)

pytestmark = pytest.mark.unit

finite = st.floats(min_value=-1.0, max_value=1.0, allow_nan=False, allow_infinity=False)


def _normalised(values: list[float]) -> np.ndarray:
    q = np.asarray(values, dtype=np.float64)
    return q / np.linalg.norm(q)


unit_quaternions = (
    st.lists(finite, min_size=4, max_size=4)
    .filter(lambda values: float(np.linalg.norm(values)) > 0.1)
    .map(_normalised)
)
unit_vectors = (
    st.lists(finite, min_size=3, max_size=3)
    .filter(lambda values: float(np.linalg.norm(values)) > 0.1)
    .map(_normalised)
)


def _same_rotation(q: np.ndarray, p: np.ndarray, tol: float = 1e-12) -> bool:
    return abs(abs(float(np.dot(q, p))) - 1.0) < tol


def _axis_angle(axis: tuple[float, float, float], degrees: float) -> np.ndarray:
    half = np.radians(degrees) / 2.0
    unit = np.asarray(axis, dtype=np.float64) / np.linalg.norm(axis)
    return np.concatenate([unit * np.sin(half), [np.cos(half)]])


@settings(max_examples=300, deadline=None)
@given(unit_quaternions)
def test_quaternion_matrix_round_trip(q: np.ndarray) -> None:
    matrix = quaternion_to_matrix(q)
    assert matrix.shape == (3, 3)
    assert np.isclose(np.linalg.det(matrix), 1.0, atol=1e-12)
    assert np.allclose(matrix @ matrix.T, np.eye(3), atol=1e-12)
    back = matrix_to_quaternion(matrix)
    assert _same_rotation(q, back)
    assert np.isclose(np.linalg.norm(back), 1.0, atol=1e-12)


@settings(max_examples=300, deadline=None)
@given(unit_quaternions, unit_vectors)
def test_rotate_matches_matrix_product(q: np.ndarray, v: np.ndarray) -> None:
    assert np.allclose(rotate(q, v), quaternion_to_matrix(q) @ v, atol=1e-12)


@settings(max_examples=100, deadline=None)
@given(
    st.lists(unit_quaternions, min_size=2, max_size=16),
    st.lists(st.booleans(), min_size=16, max_size=16),
)
def test_make_sign_continuous_keeps_rotations_and_fixes_signs(
    quaternions: list[np.ndarray], flips: list[bool]
) -> None:
    batch = np.stack(quaternions)
    signs = np.where(np.asarray(flips[: len(quaternions)]), -1.0, 1.0)
    flipped = batch * signs[:, np.newaxis]
    continuous = make_sign_continuous(flipped)
    dots = np.sum(continuous[1:] * continuous[:-1], axis=1)
    assert np.all(dots >= 0.0)
    assert np.allclose(np.abs(continuous), np.abs(batch))
    assert np.allclose(continuous[0], flipped[0])  # the first sample keeps its sign
    vectors = rotate(continuous, np.array([0.3, -0.4, 0.5]))
    assert np.allclose(vectors, rotate(batch, np.array([0.3, -0.4, 0.5])), atol=1e-12)


@pytest.mark.parametrize(
    "q",
    [
        _axis_angle((0.0, 0.0, 1.0), 0.0),  # w largest
        _axis_angle((1.0, 0.0, 0.0), 180.0),  # x largest
        _axis_angle((0.0, 1.0, 0.0), 180.0),  # y largest
        _axis_angle((0.0, 0.0, 1.0), 180.0),  # z largest
        _axis_angle((1.0, 1.0, 0.0), 179.0),
        _axis_angle((0.0, 1.0, 1.0), 170.0),
    ],
)
def test_every_shepperd_case_round_trips(q: np.ndarray) -> None:
    back = matrix_to_quaternion(quaternion_to_matrix(q))
    assert _same_rotation(q, back)


def test_batched_shapes_follow_skyfield_layout() -> None:
    batch = np.stack([_axis_angle((0.0, 0.0, 1.0), d) for d in (0.0, 30.0, 90.0, 180.0, 250.0)])
    matrices = quaternion_to_matrix(batch)
    assert matrices.shape == (3, 3, 5)
    back = matrix_to_quaternion(matrices)
    assert back.shape == (5, 4)
    for original, recovered in zip(batch, back, strict=True):
        assert _same_rotation(original, recovered)
    rotated = rotate(batch, np.array([1.0, 0.0, 0.0]))
    assert rotated.shape == (5, 3)
    assert np.allclose(rotated[2], [0.0, 1.0, 0.0], atol=1e-12)  # +90 deg about z: x -> y


def test_neu_to_enu_swaps_rows_and_restores_handedness() -> None:
    north = np.array([0.0, 0.0, 1.0])
    east = np.array([0.0, 1.0, 0.0])
    up = np.array([1.0, 0.0, 0.0])
    neu = np.stack([north, east, up])  # rows north, east, up: a left-handed frame
    assert np.isclose(np.linalg.det(neu), -1.0)
    enu = neu_to_enu(neu)
    assert np.isclose(np.linalg.det(enu), 1.0)
    assert np.array_equal(enu[0], east)
    assert np.array_equal(enu[1], north)
    assert np.array_equal(enu[2], up)
    batched = neu_to_enu(np.stack([neu, neu], axis=-1))
    assert batched.shape == (3, 3, 2)
    assert np.array_equal(batched[:, :, 1], enu)
    with pytest.raises(ValueError, match="determinant"):
        matrix_to_quaternion(neu)


def test_slerp_endpoints_midpoint_and_arrays() -> None:
    q0 = _axis_angle((0.0, 0.0, 1.0), 0.0)
    q1 = _axis_angle((0.0, 0.0, 1.0), 90.0)
    assert np.allclose(slerp(q0, q1, 0.0), q0)
    assert np.allclose(slerp(q0, q1, 1.0), q1)
    assert np.allclose(slerp(q0, q1, 0.5), _axis_angle((0.0, 0.0, 1.0), 45.0))
    many = slerp(q0, q1, np.array([0.0, 0.25, 1.0]))
    assert many.shape == (3, 4)
    assert np.allclose(many[1], _axis_angle((0.0, 0.0, 1.0), 22.5))
    # A vanishing arc falls back to normalised lerp instead of dividing 0 by 0.
    assert np.allclose(slerp(q0, q0, 0.3), q0)
    assert np.all(np.isfinite(slerp(q0, q0 * (1 + 1e-12), 0.7)))


def test_shape_errors() -> None:
    with pytest.raises(ValueError, match="shape"):
        matrix_to_quaternion(np.eye(4))
    with pytest.raises(ValueError, match="shape"):
        quaternion_to_matrix(np.zeros(3))
    with pytest.raises(ValueError, match="shape"):
        neu_to_enu(np.zeros((4, 3)))
    with pytest.raises(ValueError, match="shape"):
        make_sign_continuous(np.zeros(4))
    with pytest.raises(ValueError, match="q must"):
        rotate(np.zeros(3), np.zeros(3))
    with pytest.raises(ValueError, match="v must"):
        rotate(np.array([0.0, 0.0, 0.0, 1.0]), np.zeros(4))
    with pytest.raises(ValueError, match="shape"):
        slerp(np.zeros(3), np.zeros(4), 0.5)


def test_make_sign_continuous_handles_single_and_empty_windows() -> None:
    single = np.array([[0.0, 0.0, 0.0, -1.0]])
    assert np.array_equal(make_sign_continuous(single), single)
    assert make_sign_continuous(np.zeros((0, 4))).shape == (0, 4)
