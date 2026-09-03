"""Unit quaternions for the horizon and equinox-of-date rotations (D49, rules/sky-math.md).

Pure NumPy: no Skyfield, no I/O, no globals, 100 % line coverage. Quaternions are stored
`[x, y, z, w]` in the Hamilton convention, `v_rotated = q * v * q^-1`, exactly as the frontend
(`frontend/src/sky/math`) consumes them. Matrices use Skyfield's layout, `(3, 3)` for one sample
and `(3, 3, N)` for N samples (time axis last); quaternion batches are `(N, 4)`.
"""

import numpy as np
from numpy.typing import ArrayLike, NDArray

Float64Array = NDArray[np.float64]

_PROPER_ROTATION_TOLERANCE = 1e-6


def _as_matrix_batch(matrix: ArrayLike, name: str) -> tuple[Float64Array, bool]:
    """Return `(N, 3, 3)` matrices and whether the input was a single `(3, 3)` matrix."""
    m = np.asarray(matrix, dtype=np.float64)
    if m.ndim == 2 and m.shape == (3, 3):
        return m[np.newaxis, :, :], True
    if m.ndim == 3 and m.shape[:2] == (3, 3):
        return np.moveaxis(m, -1, 0), False
    raise ValueError(f"{name} must have shape (3, 3) or (3, 3, N), got {m.shape}")


def _as_quaternion_batch(q: ArrayLike, name: str) -> tuple[Float64Array, bool]:
    """Return `(N, 4)` quaternions and whether the input was a single `(4,)` quaternion."""
    a = np.asarray(q, dtype=np.float64)
    if a.ndim == 1 and a.shape == (4,):
        return a[np.newaxis, :], True
    if a.ndim == 2 and a.shape[1] == 4:
        return a, False
    raise ValueError(f"{name} must have shape (4,) or (N, 4), got {a.shape}")


def matrix_to_quaternion(matrix: ArrayLike) -> Float64Array:
    """Convert proper rotation matrices to unit quaternions `[x, y, z, w]`.

    Shepperd's method (S. W. Shepperd, "Quaternion from rotation matrix", Journal of Guidance
    and Control 1(3), 1978): the four candidate squares `1 + trace` and `1 + 2 R_kk - trace` are
    all evaluated and the largest one is used for each sample, so no division ever loses
    precision and no Python branch depends on the data (vectorised over the sample axis).

    `(3, 3)` -> `(4,)`; `(3, 3, N)` -> `(N, 4)`. Raises `ValueError` for a wrong shape or for a
    matrix that is not a proper rotation (determinant +1), which catches Skyfield's left-handed
    north-east-up matrix when `neu_to_enu` was forgotten.
    """
    m, single = _as_matrix_batch(matrix, "matrix")
    determinant = np.linalg.det(m)
    if np.any(np.abs(determinant - 1.0) > _PROPER_ROTATION_TOLERANCE):
        raise ValueError("matrix must be a proper rotation with determinant +1")
    r00, r01, r02 = m[:, 0, 0], m[:, 0, 1], m[:, 0, 2]
    r10, r11, r12 = m[:, 1, 0], m[:, 1, 1], m[:, 1, 2]
    r20, r21, r22 = m[:, 2, 0], m[:, 2, 1], m[:, 2, 2]
    trace = r00 + r11 + r22
    # Four times the square of each component, in the order (w, x, y, z).
    squares = np.stack(
        [1.0 + trace, 1.0 + r00 - r11 - r22, 1.0 - r00 + r11 - r22, 1.0 - r00 - r11 + r22],
        axis=1,
    )
    biggest = np.argmax(squares, axis=1)
    chosen = np.take_along_axis(squares, biggest[:, np.newaxis], axis=1)[:, 0]
    twice = np.sqrt(np.maximum(chosen, 0.0))  # 2 * |largest component|, >= 1 for a rotation
    half = 0.5 * twice  # the largest component itself, taken positive
    inv = 0.5 / twice  # 1 / (4 * largest component)
    # One candidate per case, every candidate evaluated with the chosen case's `half`/`inv`;
    # only the row matching `biggest` is correct and only that row is kept.
    case_w = np.stack([(r21 - r12) * inv, (r02 - r20) * inv, (r10 - r01) * inv, half], axis=1)
    case_x = np.stack([half, (r01 + r10) * inv, (r02 + r20) * inv, (r21 - r12) * inv], axis=1)
    case_y = np.stack([(r01 + r10) * inv, half, (r12 + r21) * inv, (r02 - r20) * inv], axis=1)
    case_z = np.stack([(r02 + r20) * inv, (r12 + r21) * inv, half, (r10 - r01) * inv], axis=1)
    candidates = np.stack([case_w, case_x, case_y, case_z], axis=1)  # (N, case, component)
    q = candidates[np.arange(m.shape[0]), biggest]
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    return q[0] if single else q


def quaternion_to_matrix(q: ArrayLike) -> Float64Array:
    """Convert unit quaternions `[x, y, z, w]` to rotation matrices (Skyfield layout).

    `(4,)` -> `(3, 3)`; `(N, 4)` -> `(3, 3, N)`. The input is renormalised first.
    """
    a, single = _as_quaternion_batch(q, "q")
    a = a / np.linalg.norm(a, axis=1, keepdims=True)
    x, y, z, w = a[:, 0], a[:, 1], a[:, 2], a[:, 3]
    matrix = np.array(
        (
            (1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - w * z), 2.0 * (x * z + w * y)),
            (2.0 * (x * y + w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - w * x)),
            (2.0 * (x * z - w * y), 2.0 * (y * z + w * x), 1.0 - 2.0 * (x * x + y * y)),
        )
    )
    return matrix[:, :, 0] if single else matrix


def neu_to_enu(matrix: ArrayLike) -> Float64Array:
    """Turn Skyfield's left-handed north-east-up matrix into the right-handed ENU matrix.

    `GeographicPosition.rotation_at` and `PlanetTopos.rotation_at` return rows (north, east,
    up) with determinant -1 (brief pitfalls l.523); swapping the first two rows gives rows
    (east, north, up) with determinant +1. Works on `(3, 3)` and `(3, 3, N)` and returns a copy.
    """
    m = np.asarray(matrix, dtype=np.float64)
    if m.ndim not in (2, 3) or m.shape[:2] != (3, 3):
        raise ValueError(f"matrix must have shape (3, 3) or (3, 3, N), got {m.shape}")
    return m[[1, 0, 2]]


def make_sign_continuous(q: ArrayLike) -> Float64Array:
    """Flip the sign of samples so consecutive quaternions have a positive dot product.

    `q` and `-q` are the same rotation; choosing the sign along the window keeps slerp on the
    short arc (brief l.58). The first sample keeps its sign. Input `(N, 4)`, returns a copy.
    """
    a = np.array(q, dtype=np.float64)
    if a.ndim != 2 or a.shape[1] != 4:
        raise ValueError(f"q must have shape (N, 4), got {a.shape}")
    dots = np.sum(a[1:] * a[:-1], axis=1)
    # sign_i = product of sign(q_j . q_j+1) for j < i, computed from the original samples.
    signs = np.cumprod(np.where(dots < 0.0, -1.0, 1.0))
    a[1:] *= signs[:, np.newaxis]
    return a


def rotate(q: ArrayLike, v: ArrayLike) -> Float64Array:
    """Rotate vectors by quaternions: `q * v * q^-1` (Hamilton).

    `q` is `(4,)` or `(N, 4)`, `v` is `(3,)` or `(N, 3)`; NumPy broadcasting rules apply and the
    result has the broadcast shape `(3,)` or `(N, 3)`.
    """
    qa = np.asarray(q, dtype=np.float64)
    va = np.asarray(v, dtype=np.float64)
    if qa.ndim not in (1, 2) or qa.shape[-1] != 4:
        raise ValueError(f"q must have shape (4,) or (N, 4), got {qa.shape}")
    if va.ndim not in (1, 2) or va.shape[-1] != 3:
        raise ValueError(f"v must have shape (3,) or (N, 3), got {va.shape}")
    axis = qa[..., :3]
    w = qa[..., 3:4]
    # v' = v + 2 w (u x v) + 2 u x (u x v), with t = 2 (u x v).
    t = 2.0 * np.cross(axis, va)
    return va + w * t + np.cross(axis, t)


def slerp(q0: ArrayLike, q1: ArrayLike, u: ArrayLike) -> Float64Array:
    """Spherical linear interpolation between two unit quaternions at fraction(s) `u`.

    No sign flip is applied: callers keep their samples sign-continuous, so the arc between
    consecutive samples is already the short one. `u` scalar -> `(4,)`, `u` `(M,)` -> `(M, 4)`.
    """
    a = np.asarray(q0, dtype=np.float64)
    b = np.asarray(q1, dtype=np.float64)
    if a.shape != (4,) or b.shape != (4,):
        raise ValueError(f"q0 and q1 must have shape (4,), got {a.shape} and {b.shape}")
    fraction = np.asarray(u, dtype=np.float64)
    cos_omega = float(np.clip(np.dot(a, b), -1.0, 1.0))
    omega = np.arccos(cos_omega)
    sin_omega = np.sin(omega)
    # Where the arc is (nearly) zero the sines cancel to 0/0: fall back to normalised lerp.
    tiny = sin_omega < 1e-9
    safe_sin = np.where(tiny, 1.0, sin_omega)
    weight0 = np.where(tiny, 1.0 - fraction, np.sin((1.0 - fraction) * omega) / safe_sin)
    weight1 = np.where(tiny, fraction, np.sin(fraction * omega) / safe_sin)
    out = weight0[..., np.newaxis] * a + weight1[..., np.newaxis] * b
    return out / np.linalg.norm(out, axis=-1, keepdims=True)
