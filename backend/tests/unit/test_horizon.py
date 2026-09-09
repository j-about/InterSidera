"""horizon.py: horizon and equinox quaternions against Skyfield `altaz()` and `radec(epoch=t)`."""

import numpy as np
import pytest
from skyfield.starlib import Star
from skyfield.timelib import Time, Timescale

from skyapi.astro.frames import CoverageError
from skyapi.astro.horizon import (
    altaz_reference,
    equinox_of_date_quaternions,
    horizon_quaternions,
    lst_hours,
    observer_velocity_au_d,
)
from skyapi.astro.observers import Observer, build_observer
from skyapi.astro.quaternions import quaternion_to_matrix, rotate
from skyapi.astro.state import AstroState
from skyapi.astro.time import make_times

pytestmark = pytest.mark.unit

TT0 = 2460000.5
SIRIUS = Star(ra_hours=6.7524777, dec_degrees=-16.7161159)
TARGET_KEYS = ("sun", "moon", "jupiter barycenter", "mars barycenter", "venus", "earth")


def _unit_rows(xyz: object) -> np.ndarray:
    vectors = np.asarray(xyz, dtype=np.float64).reshape(3, -1).T
    return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)


def _wrap(angle: np.ndarray) -> np.ndarray:
    return (angle + np.pi) % (2.0 * np.pi) - np.pi


def _check_altaz_parity(state: AstroState, observer: Observer, t: Time) -> None:
    q = horizon_quaternions(observer, t)
    assert q.shape == (64, 4)
    assert np.allclose(np.linalg.norm(q, axis=1), 1.0, atol=1e-12)
    targets = [state.eph[key] for key in TARGET_KEYS if key != observer.spec.ephemeris_key]
    for target in [*targets, SIRIUS]:
        apparent = observer.vector.at(t).observe(target).apparent()
        alt, az, _ = apparent.altaz()
        enu = rotate(q, _unit_rows(apparent.xyz.au))
        az_ours = np.arctan2(enu[:, 0], enu[:, 1]) % (2.0 * np.pi)
        alt_ours = np.arcsin(np.clip(enu[:, 2], -1.0, 1.0))
        assert np.max(np.abs(_wrap(az_ours - np.asarray(az.radians)))) < 1e-9
        assert np.max(np.abs(alt_ours - np.asarray(alt.radians))) < 1e-9


def test_horizon_quaternion_reproduces_skyfield_altaz_on_earth(
    astro_state: AstroState, greenwich: Observer, ts: Timescale
) -> None:
    _check_altaz_parity(astro_state, greenwich, make_times(ts, TT0, 3600, 64))


def test_horizon_quaternion_reproduces_skyfield_altaz_on_the_moon(
    astro_state: AstroState, tranquility: Observer, ts: Timescale
) -> None:
    _check_altaz_parity(astro_state, tranquility, make_times(ts, TT0, 21600, 64))


def test_horizon_quaternion_reproduces_skyfield_altaz_on_mars(
    astro_state: AstroState, jezero: Observer, ts: Timescale
) -> None:
    _check_altaz_parity(astro_state, jezero, make_times(ts, TT0, 3600, 64))


def test_horizon_quaternions_are_sign_continuous_and_scalar_safe(
    greenwich: Observer, jezero: Observer, ts: Timescale
) -> None:
    for observer, step in ((greenwich, 3600), (jezero, 86400)):
        q = horizon_quaternions(observer, make_times(ts, TT0, step, 64))
        dots = np.sum(q[1:] * q[:-1], axis=1)
        assert np.all(dots > 0.0)
    single = horizon_quaternions(greenwich, ts.tt_jd(TT0))
    assert single.shape == (1, 4)
    assert np.allclose(single[0], horizon_quaternions(greenwich, make_times(ts, TT0, 60, 2))[0])


def test_horizon_quaternion_azimuth_convention(greenwich: Observer, ts: Timescale) -> None:
    # Rotating the zenith back to ICRF and re-rotating it must give ENU up = (0, 0, 1); north lies
    # in the ENU y direction (az = 0) and east along x (az = 90 deg).
    q = horizon_quaternions(greenwich, ts.tt_jd(TT0))[0]
    matrix = quaternion_to_matrix(q)
    up_icrf = matrix.T @ np.array([0.0, 0.0, 1.0])
    assert np.allclose(rotate(q, up_icrf), [0.0, 0.0, 1.0], atol=1e-12)
    north_icrf = matrix.T @ np.array([0.0, 1.0, 0.0])
    enu = rotate(q, north_icrf)
    assert np.isclose(np.arctan2(enu[0], enu[1]), 0.0, atol=1e-12)


def test_equinox_of_date_quaternion_is_proper_and_matches_radec_of_date(
    astro_state: AstroState, greenwich: Observer, ts: Timescale
) -> None:
    t = make_times(ts, TT0, 86400, 16)
    q = equinox_of_date_quaternions(t)
    assert q.shape == (16, 4)
    assert np.all(np.sum(q[1:] * q[:-1], axis=1) > 0.0)
    matrices = quaternion_to_matrix(q)
    assert np.allclose(np.linalg.det(np.moveaxis(matrices, -1, 0)), 1.0, atol=1e-12)
    for target in (astro_state.eph["mars barycenter"], SIRIUS):
        apparent = greenwich.vector.at(t).observe(target).apparent()
        ra, dec, _ = apparent.radec(epoch=t)
        of_date = rotate(q, _unit_rows(apparent.xyz.au))
        ra_ours = np.arctan2(of_date[:, 1], of_date[:, 0]) % (2.0 * np.pi)
        dec_ours = np.arcsin(np.clip(of_date[:, 2], -1.0, 1.0))
        assert np.max(np.abs(_wrap(ra_ours - np.asarray(ra.radians)))) < 1e-9
        assert np.max(np.abs(dec_ours - np.asarray(dec.radians))) < 1e-9
    assert equinox_of_date_quaternions(ts.tt_jd(TT0)).shape == (1, 4)


def test_lst_hours_matches_gast_plus_east_longitude(
    astro_state: AstroState, greenwich: Observer, ts: Timescale
) -> None:
    t = make_times(ts, TT0, 3600, 8)
    paris = build_observer(astro_state, "earth", 48.85, 2.35, 35.0)
    for observer in (greenwich, paris):
        expected = (np.asarray(t.gast) + observer.lon_deg / 15.0) % 24.0
        ours = np.asarray(lst_hours(observer, t))
        assert np.max(np.abs(((ours - expected) + 12.0) % 24.0 - 12.0)) < 1e-6
    assert isinstance(lst_hours(greenwich, ts.tt_jd(TT0)), float)


def test_lst_is_earth_only(jezero: Observer, ts: Timescale) -> None:
    with pytest.raises(ValueError, match="Earth observers only"):
        lst_hours(jezero, ts.tt_jd(TT0))


def test_observer_velocity(greenwich: Observer, jezero: Observer, ts: Timescale) -> None:
    t = make_times(ts, TT0, 3600, 8)
    velocity = observer_velocity_au_d(greenwich, t)
    assert velocity.shape == (8, 3)
    speed = np.linalg.norm(velocity, axis=1)
    assert np.all((speed > 0.0165) & (speed < 0.0180))  # ~29.8 km/s = 0.0172 au/day
    mars_speed = np.linalg.norm(observer_velocity_au_d(jezero, ts.tt_jd(TT0)), axis=1)
    assert mars_speed.shape == (1,)
    assert 0.012 < mars_speed[0] < 0.016  # ~24 km/s


def test_altaz_reference(
    astro_state: AstroState, greenwich: Observer, jezero: Observer, ts: Timescale
) -> None:
    t = ts.tt_jd(TT0 + 0.5)  # 12:00 TT: the Sun is above the horizon in Greenwich
    plain = altaz_reference(greenwich, astro_state.eph["sun"], t, refraction=False)
    refracted = altaz_reference(greenwich, astro_state.eph["sun"], t, refraction=True)
    assert isinstance(plain.alt_deg, float)
    assert plain.az_deg == refracted.az_deg
    assert plain.distance_au == refracted.distance_au
    assert plain.alt_deg > 20.0
    assert refracted.alt_deg > plain.alt_deg
    assert plain.constellation is None  # only with a map (D114)
    named = altaz_reference(
        greenwich,
        astro_state.eph["sun"],
        t,
        refraction=False,
        constellation_map=astro_state.constellation_at,
    )
    assert named.constellation == "Aqr"  # the Sun on 2023-02-25 (TT0 + 0.5) stands in Aquarius
    assert 0.0 <= plain.ra_icrs_hours < 24.0
    assert -90.0 <= plain.dec_icrs_deg <= 90.0
    assert abs(plain.ra_date_hours - plain.ra_icrs_hours) < 0.1  # precession since J2000
    star = altaz_reference(greenwich, SIRIUS, make_times(ts, TT0, 3600, 4), refraction=False)
    assert np.asarray(star.alt_deg).shape == (4,)
    from_mars = altaz_reference(jezero, astro_state.eph["earth"], t, refraction=False)
    assert isinstance(from_mars.alt_deg, float)
    with pytest.raises(ValueError, match="Earth observers only"):
        altaz_reference(jezero, astro_state.eph["earth"], t, refraction=True)


def test_horizon_functions_check_coverage(greenwich: Observer, ts: Timescale) -> None:
    beyond = ts.tt_jd(greenwich.coverage_tt[1] + 0.5)
    with pytest.raises(CoverageError):
        horizon_quaternions(greenwich, beyond)
    with pytest.raises(CoverageError):
        observer_velocity_au_d(greenwich, beyond)
