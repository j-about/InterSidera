# Stubs for skyfield 1.55 functions.py (see skyfield/__init__.pyi for the licence header).
# Every matrix helper is an einsum over trailing axes: a (3,3,N) matrix times a (3,N) vector
# gives (3,N); scalar inputs give (3,3) and (3,). Inputs are typed ArrayLike because they are
# handed straight to numpy (einsum, sqrt, arctan2), which converts sequences and numpy scalars;
# this also lets a `Distance.au` (FloatOrArray) be passed without np.asarray().

import numpy as np
from numpy.typing import ArrayLike, NDArray

from .units import FloatOrArray as FloatOrArray

def dots(v: ArrayLike, u: ArrayLike) -> FloatOrArray: ...  # skyfield 1.55 functions.py l.22
def mxv(M: ArrayLike, v: ArrayLike) -> NDArray[np.float64]: ...  # skyfield 1.55 functions.py l.36
def mxm(M1: ArrayLike, M2: ArrayLike) -> NDArray[np.float64]: ...  # skyfield 1.55 functions.py l.40
def mxmxm(
    M1: ArrayLike, M2: ArrayLike, M3: ArrayLike
) -> NDArray[np.float64]: ...  # skyfield 1.55 functions.py l.44
def length_of(xyz: ArrayLike) -> FloatOrArray: ...  # skyfield 1.55 functions.py l.50
def angle_between(
    u: ArrayLike, v: ArrayLike
) -> FloatOrArray: ...  # skyfield 1.55 functions.py l.59
def to_spherical(
    xyz: ArrayLike,
) -> tuple[
    FloatOrArray, FloatOrArray, FloatOrArray
]: ...  # skyfield 1.55 functions.py l.75 (r, theta, phi)
def from_spherical(
    r: FloatOrArray, theta: FloatOrArray, phi: FloatOrArray
) -> NDArray[np.float64]: ...  # skyfield 1.55 functions.py l.112
def rot_x(theta: FloatOrArray) -> NDArray[np.float64]: ...  # skyfield 1.55 functions.py l.132
def rot_y(theta: FloatOrArray) -> NDArray[np.float64]: ...  # skyfield 1.55 functions.py l.139
def rot_z(theta: FloatOrArray) -> NDArray[np.float64]: ...  # skyfield 1.55 functions.py l.146
