"""sampling.py: step classes, clamping and the TT window (D50, brief l.70)."""

import numpy as np
import pytest

from skyapi.astro.sampling import MAX_SAMPLES, MAX_STEP_S, clamp_step, step_class, window

pytestmark = pytest.mark.unit


def test_class_table_matches_the_contract() -> None:
    assert dict(MAX_STEP_S) == {
        "moon": 3600,
        "inner_planets": 21600,
        "sun_and_outer": 86400,
        "minor": 86400,
    }
    assert step_class("moon") == "moon"
    assert {step_class(b) for b in ("mercury", "venus", "mars")} == {"inner_planets"}
    assert {
        step_class(b) for b in ("sun", "earth", "jupiter", "saturn", "uranus", "neptune", "pluto")
    } == {"sun_and_outer"}
    with pytest.raises(ValueError, match="unknown body"):
        step_class("vulcan")


@pytest.mark.parametrize(
    ("step_s", "bodies", "minor", "expected"),
    [
        (100_000, ["sun"], [], 86400),
        (100_000, ["sun", "moon"], [], 3600),
        (100_000, ["venus", "jupiter"], [], 21600),
        (10, ["moon"], [], 10),
        (100_000, [], ["a:1"], 86400),
        (100_000, [], [], 100_000),
        (3600, ["moon"], ["c:1P"], 3600),
    ],
)
def test_clamp_step(step_s: int, bodies: list[str], minor: list[str], expected: int) -> None:
    assert clamp_step(step_s, bodies, minor) == expected


def test_clamp_step_rejects_bad_input() -> None:
    with pytest.raises(ValueError, match="step_s"):
        clamp_step(0, ["sun"])
    with pytest.raises(ValueError, match="unknown body"):
        clamp_step(60, ["sun", "vulcan"])


def test_window_values_and_bounds() -> None:
    grid = window(2460000.5, 1800, 4)
    assert np.allclose(grid, 2460000.5 + np.arange(4) * 1800.0 / 86400.0)
    assert window(2460000.5, 1, 1).shape == (1,)
    assert window(2460000.5, 1, MAX_SAMPLES).shape == (MAX_SAMPLES,)
    with pytest.raises(ValueError, match="n must"):
        window(2460000.5, 60, 0)
    with pytest.raises(ValueError, match="n must"):
        window(2460000.5, 60, MAX_SAMPLES + 1)
    with pytest.raises(ValueError, match="step_s"):
        window(2460000.5, 0, 4)
