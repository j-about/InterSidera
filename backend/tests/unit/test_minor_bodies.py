"""`astro/minor_bodies.py` on the excerpt-built cache (D42, D43) with de440s."""

import io

import numpy as np
import pytest
from skyfield.constants import AU_KM, GM_SUN_DE440_km3_s2
from skyfield.data import mpc
from skyfield.jpllib import SpiceKernel
from skyfield.timelib import Time
from skyfield.units import Angle
from skyfield.vectorlib import VectorFunction

from skyapi.astro.frames import CoverageError
from skyapi.astro.minor_bodies import (
    MPC_ERROR_YEARS,
    MinorBodyIndex,
    MinorBodyState,
    OrbitCache,
    StackedOrbits,
    UnknownMinorBodyError,
    comet_magnitude,
    defaults,
    hg_magnitude,
    minor_body_samples,
    orbit_for,
    search,
)
from skyapi.astro.state import AstroState
from skyapi.catalogs.mpc_build import mpcorb_body_offset
from support.fixtures_mpc import MpcExcerpts

pytestmark = pytest.mark.unit

CERES_EPOCH_TT = 2461200.5  # K2669 = 2026-06-09.0 TT
YEAR = 365.25


# --------------------------------------------------------------------------- search


def _ids(results: list) -> list[str]:
    return [entry.id for entry in results]


def test_index_shape(mpc_index: MinorBodyIndex) -> None:
    assert len(mpc_index) == 24 + 19
    assert mpc_index.position_of("a:1") is not None
    assert mpc_index.position_of("nope") is None
    assert int(mpc_index.is_comet.sum()) == 19


def test_search_name_substring_is_case_insensitive(mpc_index: MinorBodyIndex) -> None:
    assert _ids(search(mpc_index, "ceres")) == ["a:1"]
    assert _ids(search(mpc_index, "CERES")) == ["a:1"]
    assert _ids(search(mpc_index, "  ceres ")) == ["a:1"]
    ceres = search(mpc_index, "ceres")[0]
    assert ceres.designation == "(1) Ceres"
    assert ceres.name == "Ceres"
    assert ceres.kind == "asteroid"
    assert ceres.h_mag == pytest.approx(3.34)
    assert ceres.elements_epoch_tt == CERES_EPOCH_TT


def test_search_designation_prefix(mpc_index: MinorBodyIndex) -> None:
    results = search(mpc_index, "2024")
    assert len(results) == 5
    assert all(entry.designation.startswith("2024") for entry in results)
    assert all(entry.name is None for entry in results)
    assert all(entry.id.startswith("a:K24") for entry in results)
    assert len(search(mpc_index, "2024", limit=2)) == 2


def test_search_accepts_ids_and_bare_numbers(mpc_index: MinorBodyIndex) -> None:
    assert _ids(search(mpc_index, "a:1")) == ["a:1"]
    assert _ids(search(mpc_index, "433"))[0] == "a:433"
    assert _ids(search(mpc_index, "c:1P")) == ["c:1P"]
    assert _ids(search(mpc_index, "1P"))[0] == "c:1P"
    assert _ids(search(mpc_index, "1p"))[0] == "c:1P"
    assert _ids(search(mpc_index, "c:C/1995_O1")) == ["c:C/1995_O1"]
    packed = search(mpc_index, "2024")[0].id[2:]
    assert _ids(search(mpc_index, packed)) == ["a:" + packed]
    first = search(mpc_index, "1")
    assert first[0].id == "a:1"
    assert len(first) == len(set(_ids(first)))


def test_search_comets_by_name_or_designation(mpc_index: MinorBodyIndex) -> None:
    assert _ids(search(mpc_index, "hale")) == ["c:C/1995_O1"]
    assert _ids(search(mpc_index, "1995 O1")) == ["c:C/1995_O1"]
    assert _ids(search(mpc_index, "halley")) == ["c:1P"]
    halley = search(mpc_index, "halley")[0]
    assert halley.kind == "comet"
    assert halley.h_mag is None
    assert halley.name == "Halley"
    assert _ids(search(mpc_index, "pluto")) == ["a:134340"]
    # Designation prefixes are matched upper-cased (MPC designations proper are upper case).
    assert _ids(search(mpc_index, "c/1995")) == ["c:C/1995_O1"]
    assert _ids(search(mpc_index, "p/2021 n1")) == ["c:P/2021_N1"]
    assert _ids(search(mpc_index, "a/2018"))[0].startswith("c:A/2018")


def test_search_edge_cases(mpc_index: MinorBodyIndex) -> None:
    assert search(mpc_index, "") == []
    assert search(mpc_index, "   ") == []
    assert search(mpc_index, "ceres", limit=0) == []
    assert search(mpc_index, "zzzz-no-such-object") == []
    assert search(mpc_index, "éé") == []


# --------------------------------------------------------------------------- defaults


def test_defaults_ranking(mpc_index: MinorBodyIndex) -> None:
    now = CERES_EPOCH_TT
    results = defaults(mpc_index, now)
    ids = _ids(results)
    # Excerpt asteroids with H <= 9, brightest first: Vesta 3.20, Ceres 3.34, Pallas 4.12.
    # (134340) Pluto (H < 0) is excluded: it is served as a major body.
    assert ids[:3] == ["a:4", "a:1", "a:2"]
    assert "a:134340" not in ids
    comets = results[3:]
    assert comets, "comets with a recent epoch follow the bright asteroids"
    assert all(entry.kind == "comet" for entry in comets)
    assert all(abs(entry.elements_epoch_tt - now) <= 2 * YEAR for entry in comets)
    perihelion = dict(
        zip(mpc_index.comet_rows.tolist(), mpc_index.comet_perihelion_tt.tolist(), strict=True)
    )
    rows = [mpc_index.position_of(entry.id) for entry in comets]
    proximity = [abs(perihelion[row] - now) for row in rows if row is not None]
    assert proximity == sorted(proximity)
    assert len(defaults(mpc_index, now, limit=2)) == 2
    assert _ids(defaults(mpc_index, now, limit=2)) == ["a:4", "a:1"]
    # Far from every epoch no comet qualifies, the asteroids stay.
    far = defaults(mpc_index, now + 40 * YEAR)
    assert _ids(far) == ["a:4", "a:1", "a:2"]


# --------------------------------------------------------------------------- orbits


def _reference_ceres(mpc_excerpts: MpcExcerpts, state: MinorBodyState):
    data = mpc_excerpts.mpcorb.read_bytes()
    frame = mpc.load_mpcorb_dataframe(io.BytesIO(data[mpcorb_body_offset(data) :]))
    row = frame[frame["designation_packed"] == "00001"].iloc[0]
    return state.sun + mpc.mpcorb_orbit(row, state.ts, GM_SUN_DE440_km3_s2)


def test_orbit_for_matches_skyfield_recipe(
    mpc_state: MinorBodyState, mpc_excerpts: MpcExcerpts, de440s_kernel: SpiceKernel
) -> None:
    earth = de440s_kernel["earth"]
    t = mpc_state.ts.tt_jd(CERES_EPOCH_TT + np.array([0.0, 30.0, 200.0]))
    entry = orbit_for(mpc_state, "a:1")
    orbit, row = entry.vector, entry.row
    assert row.designation == "(1) Ceres"
    assert row.name == "Ceres"
    assert row.kind == "asteroid"
    assert row.h_mag == pytest.approx(3.34)
    assert row.slope_g == pytest.approx(0.15)
    assert entry.epoch.epoch_tt == CERES_EPOCH_TT
    assert entry.epoch.position_au.shape == (3,)
    assert entry.epoch.velocity_au_d.shape == (3,)
    assert 2.5 < float(np.linalg.norm(entry.epoch.position_au)) < 3.0  # Ceres: a = 2.77 au
    assert entry.epoch.mu_au3_d2 == pytest.approx(GM_SUN_DE440_km3_s2 * 86400.0**2 / AU_KM**3)
    ours = earth.at(t).observe(orbit).apparent()
    reference = earth.at(t).observe(_reference_ceres(mpc_excerpts, mpc_state)).apparent()
    separation = ours.separation_from(reference)
    assert isinstance(separation, Angle)
    assert np.all(np.asarray(separation.arcseconds()) < 30.0)
    # Sanity: Ceres is between 1.5 and 4.5 au from the Earth.
    assert np.all((np.asarray(ours.distance().au) > 1.5) & (np.asarray(ours.distance().au) < 4.5))


def test_orbit_for_comet(mpc_state: MinorBodyState) -> None:
    entry = orbit_for(mpc_state, "c:1P")
    orbit, row = entry.vector, entry.row
    assert row.kind == "comet"
    assert row.name == "Halley"
    assert row.magnitude_g == pytest.approx(5.5)
    assert row.magnitude_k == pytest.approx(3.2)
    assert row.perihelion_tt is not None
    assert row.perihelion_tt > row.elements_epoch_tt  # perihelion 2061, epoch 2026
    assert orbit.center == 0


def test_orbit_for_unnumbered_asteroid(mpc_state: MinorBodyState) -> None:
    body_id = search(mpc_state.index, "2024")[0].id
    assert body_id.startswith("a:K24")
    entry = orbit_for(mpc_state, body_id)
    orbit, row = entry.vector, entry.row
    assert row.kind == "asteroid"
    assert row.name is None
    assert row.designation.startswith("2024")
    assert orbit.center == 0


def test_orbit_for_unknown_id(mpc_state: MinorBodyState) -> None:
    with pytest.raises(UnknownMinorBodyError, match="a:999999999") as info:
        orbit_for(mpc_state, "a:999999999")
    assert info.value.body_id == "a:999999999"
    with pytest.raises(UnknownMinorBodyError):
        orbit_for(mpc_state, "c:C/1995_O1 (Hale-Bopp)")


def test_orbit_cache_hits_on_second_call(mpc_state: MinorBodyState) -> None:
    state = MinorBodyState(
        cache=mpc_state.cache,
        index=mpc_state.index,
        ts=mpc_state.ts,
        sun=mpc_state.sun,
        orbits=OrbitCache(capacity=2),
    )
    first = orbit_for(state, "a:1")
    second = orbit_for(state, "a:1")
    assert second is first
    assert second.vector is first.vector
    assert second.row is first.row
    assert len(state.orbits) == 1
    orbit_for(state, "a:4")
    orbit_for(state, "c:1P")  # evicts the least recently used entry (a:1)
    assert len(state.orbits) == 2
    assert state.orbits.get("a:1") is None
    assert state.orbits.get("a:4") is not None
    third = orbit_for(state, "a:1")
    assert third is not first


def test_orbit_cache_lru_order() -> None:
    cache = OrbitCache(capacity=2)
    cache.put("a", ("orbit-a", "row-a"))  # type: ignore[arg-type]
    cache.put("b", ("orbit-b", "row-b"))  # type: ignore[arg-type]
    assert cache.get("a") is not None  # refresh a
    cache.put("c", ("orbit-c", "row-c"))  # type: ignore[arg-type]
    assert cache.get("b") is None
    assert cache.get("a") is not None
    assert cache.get("c") is not None
    with pytest.raises(ValueError, match="capacity"):
        OrbitCache(capacity=0)


# --------------------------------------------------------------------------- samples


def test_samples_shape_and_direction(mpc_state: MinorBodyState, de440s_kernel: SpiceKernel) -> None:
    earth = de440s_kernel["earth"]
    t = mpc_state.ts.tt_jd(CERES_EPOCH_TT + np.linspace(0.0, 1.5, 4))
    out = minor_body_samples(mpc_state, earth, t, ["a:1", "c:1P"])
    assert set(out) == {"a:1", "c:1P"}
    ceres = out["a:1"]
    assert ceres.name == "Ceres"
    assert ceres.kind == "asteroid"
    assert ceres.elements_epoch_tt == CERES_EPOCH_TT
    assert ceres.extrapolation_years == pytest.approx(1.5 / YEAR)
    assert ceres.warnings == []
    assert ceres.samples is not None
    samples = ceres.samples
    assert samples.dir.shape == (4, 3)
    assert np.allclose(np.linalg.norm(samples.dir, axis=1), 1.0)
    assert samples.dist_au.shape == samples.mag.shape == samples.phase.shape == (4,)
    assert np.all(samples.diam_deg == 0.0)
    assert np.all((samples.phase >= 0.0) & (samples.phase <= 1.0))
    assert np.all(np.isfinite(samples.mag))
    halley = out["c:1P"]
    assert halley.kind == "comet"
    assert halley.samples is not None
    assert np.all(np.isfinite(halley.samples.mag))
    assert np.all(halley.samples.mag > 15.0)  # Halley is ~35 au from the Sun in 2026
    assert np.all(halley.samples.dist_au > 30.0)


def test_samples_scalar_time(mpc_state: MinorBodyState, de440s_kernel: SpiceKernel) -> None:
    t = mpc_state.ts.tt_jd(CERES_EPOCH_TT)
    out = minor_body_samples(mpc_state, de440s_kernel["earth"], t, ["a:4"])
    vesta = out["a:4"].samples
    assert vesta is not None
    assert vesta.dir.shape == (1, 3)
    assert vesta.mag.shape == (1,)


def test_samples_outside_the_ephemeris_coverage_raise_before_any_skyfield_call(
    mpc_state: MinorBodyState, de440s_kernel: SpiceKernel, astro_state: AstroState
) -> None:
    # R35: DE441 `Stack` targets return NaN silently outside their segments, so the coverage is
    # checked up front. de440s covers 1849-2150 (backend-tests rule: never compute outside it):
    # a sample outside is refused before `observer.at(t)` runs, with the coverage as its range.
    coverage = astro_state.ephemeris_coverage_tt
    earth = de440s_kernel["earth"]
    for outside in (coverage[0] - 10.0, coverage[1] + 10.0):
        t = mpc_state.ts.tt_jd(np.array([CERES_EPOCH_TT, outside]))
        with pytest.raises(CoverageError, match="minor bodies are served for TT JD") as info:
            minor_body_samples(mpc_state, earth, t, ["a:1"], coverage_tt=coverage)
        assert info.value.range_tt == coverage
    # Inside the coverage the check changes nothing.
    inside = mpc_state.ts.tt_jd(CERES_EPOCH_TT)
    checked = minor_body_samples(mpc_state, earth, inside, ["a:1"], coverage_tt=coverage)["a:1"]
    unchecked = minor_body_samples(mpc_state, earth, inside, ["a:1"])["a:1"]
    assert checked.samples is not None
    assert unchecked.samples is not None
    assert np.array_equal(checked.samples.dir, unchecked.samples.dir)


def test_ceres_magnitude_near_opposition(
    mpc_state: MinorBodyState, de440s_kernel: SpiceKernel
) -> None:
    # Ceres was at opposition on 2024-07-06 (V ~ 7.3 in the almanacs).
    t = mpc_state.ts.tt(2024, 7, 6)
    out = minor_body_samples(mpc_state, de440s_kernel["earth"], t, ["a:1"])
    samples = out["a:1"].samples
    assert samples is not None
    assert 6.6 <= float(samples.mag[0]) <= 7.5
    assert float(samples.phase[0]) > 0.99
    assert 1.5 < float(samples.dist_au[0]) < 2.5
    assert out["a:1"].extrapolation_years < 2.0
    assert out["a:1"].warnings == []


def test_hg_magnitude_formula() -> None:
    r = np.array([2.77])
    delta = np.array([1.77])
    zero_phase = hg_magnitude(3.34, 0.15, r, delta, np.array([0.0]))
    assert zero_phase[0] == pytest.approx(3.34 + 5 * np.log10(2.77 * 1.77))
    # Fainter with phase angle, monotonic.
    a = hg_magnitude(3.34, 0.15, r, delta, np.radians([10.0]))
    b = hg_magnitude(3.34, 0.15, r, delta, np.radians([20.0]))
    assert zero_phase[0] < a[0] < b[0]


def test_extrapolation_warnings(mpc_state: MinorBodyState, de440s_kernel: SpiceKernel) -> None:
    earth = de440s_kernel["earth"]
    warn = minor_body_samples(
        mpc_state, earth, mpc_state.ts.tt_jd(CERES_EPOCH_TT + 3 * YEAR), ["a:1"]
    )["a:1"]
    assert warn.samples is not None
    assert warn.extrapolation_years == pytest.approx(3.0)
    assert [w.code for w in warn.warnings] == ["mpc_extrapolation"]
    (warning,) = warn.warnings
    assert warning.params == {"years": 3.0}
    assert warning.range_tt == (CERES_EPOCH_TT - 2 * YEAR, CERES_EPOCH_TT + 2 * YEAR)

    bad = minor_body_samples(
        mpc_state, earth, mpc_state.ts.tt_jd(CERES_EPOCH_TT + 60 * YEAR), ["a:1"]
    )["a:1"]
    assert bad.samples is None
    assert bad.extrapolation_years == pytest.approx(60.0)
    assert [w.code for w in bad.warnings] == ["mpc_extrapolation", "mpc_unreliable"]
    assert bad.warnings[1].range_tt == (CERES_EPOCH_TT - 50 * YEAR, CERES_EPOCH_TT + 50 * YEAR)
    assert bad.name == "Ceres"

    # The window is the maximum distance from the epoch over every sample.
    window = mpc_state.ts.tt_jd(CERES_EPOCH_TT + np.array([0.0, 2.5 * YEAR]))
    mixed = minor_body_samples(mpc_state, earth, window, ["a:1"])["a:1"]
    assert mixed.extrapolation_years == pytest.approx(2.5)
    assert [w.code for w in mixed.warnings] == ["mpc_extrapolation"]


# --------------------------------------------------------------------------- batched (D69)


def _reference_samples(
    state: MinorBodyState, observer_vector: VectorFunction, t: Time, body_id: str
) -> dict[str, np.ndarray]:
    """The per-body recipe: one `observe(sun + orbit).apparent()` per body, as before D69."""
    entry = orbit_for(state, body_id)
    observer = observer_vector.at(t)
    apparent = observer.observe(entry.vector).apparent()
    xyz = np.asarray(apparent.xyz.au, dtype=np.float64).reshape(3, -1)
    delta_au = np.linalg.norm(xyz, axis=0)
    phase_angle = np.atleast_1d(np.asarray(apparent.phase_angle(state.sun).radians))
    observer_xyz = np.asarray(observer.xyz.au, dtype=np.float64).reshape(3, -1)
    sun_xyz = np.asarray(state.sun.at(t).xyz.au, dtype=np.float64).reshape(3, -1)
    r_au = np.linalg.norm(observer_xyz + xyz - sun_xyz, axis=0)
    row = entry.row
    if row.kind == "comet":
        if row.magnitude_g is None or row.magnitude_k is None:
            mag = np.full(delta_au.shape, np.nan)
        else:
            mag = comet_magnitude(row.magnitude_g, row.magnitude_k, r_au, delta_au)
    elif row.h_mag is None:
        mag = np.full(delta_au.shape, np.nan)
    else:
        slope = 0.15 if row.slope_g is None else row.slope_g
        mag = hg_magnitude(row.h_mag, slope, r_au, delta_au, phase_angle)
    return {
        "dir": (xyz / delta_au).T,
        "dist_au": delta_au,
        "phase": 0.5 * (1.0 + np.cos(phase_angle)),
        "mag": mag,
    }


def test_batched_samples_match_the_per_body_recipe(
    mpc_state: MinorBodyState, de440s_kernel: SpiceKernel
) -> None:
    # Every excerpt body (24 asteroids, 19 comets: elliptic, hyperbolic and parabolic orbits,
    # epochs from 1947 to 2026) in one stack; bodies beyond MPC_ERROR_YEARS stay `None`.
    ids = [value.decode("ascii") for value in mpc_state.index.ids]
    earth = de440s_kernel["earth"]
    t = mpc_state.ts.tt_jd(CERES_EPOCH_TT + np.linspace(0.0, 3.0, 4))
    batched = minor_body_samples(mpc_state, earth, t, ids)
    assert list(batched) == ids
    reliable = 0
    for body_id in ids:
        result = batched[body_id]
        if result.extrapolation_years > MPC_ERROR_YEARS:
            assert result.samples is None
            continue
        reliable += 1
        assert result.samples is not None
        reference = _reference_samples(mpc_state, earth, t, body_id)
        assert np.allclose(result.samples.dir, reference["dir"], rtol=0.0, atol=1e-9), body_id
        assert np.allclose(result.samples.dist_au, reference["dist_au"], rtol=0.0, atol=1e-9)
        assert np.allclose(result.samples.phase, reference["phase"], rtol=0.0, atol=1e-9)
        assert np.allclose(
            result.samples.mag, reference["mag"], rtol=0.0, atol=1e-9, equal_nan=True
        ), body_id
    assert reliable >= 30
    assert reliable < len(ids)  # the 1947 comet fragment is unreliable at this epoch


def test_batched_samples_with_a_scalar_time_and_duplicate_ids(
    mpc_state: MinorBodyState, de440s_kernel: SpiceKernel
) -> None:
    earth = de440s_kernel["earth"]
    t = mpc_state.ts.tt_jd(CERES_EPOCH_TT)
    out = minor_body_samples(mpc_state, earth, t, ["a:4", "a:1", "a:4"])
    assert list(out) == ["a:4", "a:1"]
    vesta = out["a:4"].samples
    assert vesta is not None
    assert vesta.dir.shape == (1, 3)
    reference = _reference_samples(mpc_state, earth, t, "a:4")
    assert np.allclose(vesta.dir, reference["dir"], atol=1e-9)
    assert minor_body_samples(mpc_state, earth, t, []) == {}


def test_stacked_orbits_shape_checks(mpc_state: MinorBodyState) -> None:
    ceres = orbit_for(mpc_state, "a:1").epoch
    vesta = orbit_for(mpc_state, "a:4").epoch
    stacked = StackedOrbits(mpc_state.sun, [ceres, vesta])
    assert stacked.center == 0
    assert stacked.target is stacked
    assert stacked.count == 2
    t = mpc_state.ts.tt_jd(CERES_EPOCH_TT + np.array([0.0, 1.0, 0.0, 1.0]))
    position, velocity, gcrs, message = stacked._at(t)
    assert position.shape == velocity.shape == (3, 4)
    assert gcrs is None
    assert message is None
    # Orbit 0 occupies the first row of dates, orbit 1 the second: at its epoch each body sits
    # at its cached epoch state plus the Sun.
    sun = np.asarray(mpc_state.sun.at(t).xyz.au)
    assert np.allclose(position[:, 0] - sun[:, 0], ceres.position_au, atol=1e-12)
    assert np.allclose(position[:, 2] - sun[:, 2], vesta.position_au, atol=1e-12)
    with pytest.raises(ValueError, match="multiple of 2"):
        stacked._at(mpc_state.ts.tt_jd(CERES_EPOCH_TT + np.array([0.0, 1.0, 2.0])))
    with pytest.raises(ValueError, match="at least one"):
        StackedOrbits(mpc_state.sun, [])
