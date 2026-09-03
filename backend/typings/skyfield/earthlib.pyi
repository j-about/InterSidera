# Stubs for skyfield 1.55 earthlib.py (see skyfield/__init__.pyi for the licence header).

from .units import FloatOrArray as FloatOrArray

# Bennett (1982): refraction in degrees for an APPARENT altitude; 0 outside [-1, 89.9] degrees.
def refraction(
    alt_degrees: FloatOrArray, temperature_C: float, pressure_mbar: float
) -> FloatOrArray: ...  # skyfield 1.55 earthlib.py l.139

# Inverse of refraction(): TRUE altitude in degrees -> apparent altitude in degrees (iterative).
def refract(
    alt_degrees: FloatOrArray, temperature_C: float, pressure_mbar: float
) -> FloatOrArray: ...  # skyfield 1.55 earthlib.py l.150
