"""Backend accuracy against JPL Horizons (`horizons_cases.json`; brief l.179-181; D37, R34, R37).

Every case (six sites, six TT epochs, ten targets) is evaluated once by the module fixture
`evaluated`; each test asserts one Horizons quantity and prints its residual table (visible
with `-s`). Residuals measured on 2026-09-03 with Skyfield 1.55 and de440s.bsp are quoted in
the docstrings (arcseconds unless noted) so that a change in either model shows; a tolerance is
never loosened against these values (`tests/fixtures/README.md`).

Delta T policy, D37/R37 corrected by the data: Horizons' quantity 30 is TDB - UT1 before 1962
and TDB - UTC afterwards (64.184 s at 2000-01-01T12 = 32.184 + 32 leap seconds, 69.184 s from
2017 on), so injecting it as delta T assumes UT1 = UTC and is wrong by |UT1 - UTC| <= 0.9 s
(0.355 s = 5.3" of azimuth on 2000-01-01). Skyfield's daily IERS table starts on 1973-01-02,
so 1969-07-21 sits on the S15 spline (39.49 s where Horizons used 39.76 s: 3.8" of azimuth).
Hence Earth-site cases at epochs inside Skyfield's observed IERS table (2000-01-01T12,
2024-04-08T18) use the builtin timescale, and Earth-site cases outside it (1900, 1969, 2050,
2140) use a timescale carrying Horizons' constant delta T = quantity 30 - (TDB - TT), which
holds Horizons' UT1 - UTC to |0.03 s| at those epochs (least-squares fits: +0.014, +0.030,
-0.012, -0.014 s). Moon and Mars sites rotate on TDB and always use the builtin timescale.
"""

import json
import math
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from skyfield.api import load
from skyfield.constants import AU_KM
from skyfield.timelib import Time, Timescale

from skyapi.astro import bodies
from skyapi.astro.horizon import equinox_of_date_quaternions, horizon_quaternions
from skyapi.astro.observers import Observer, build_observer
from skyapi.astro.quaternions import rotate
from skyapi.astro.state import AstroState
from skyapi.astro.time import delta_t_coverage

pytestmark = pytest.mark.conformance

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "horizons_cases.json"

ARCSEC_TOLERANCE = 2.0
RANGE_TOLERANCE_AU = 1e-6
ILLUMINATION_TOLERANCE_PCT_POINTS = 0.5
DIAMETER_TOLERANCE_PCT = 0.5
MAGNITUDE_TOLERANCE = 0.5
# Horizons prints the pole with five decimals of a degree (0.036" quantisation); measured
# 0.00-0.02" at every epoch, so no IAU 2009 / IAU 2015 difference is visible for Mars (R34).
POLE_TOLERANCE_ARCSEC = 0.1

DAY_S = 86400.0
# Mean sidereal rotation rate of the Earth, radians per second.
EARTH_ROTATION_RAD_S = 2.0 * math.pi / 86164.0905
EARTH_EQUATORIAL_RADIUS_KM = 6378.137

# The sites the fixture was fetched for (D37); the fixture's own table must agree.
EXPECTED_SITES: Mapping[str, tuple[str, float, float, float]] = {
    "greenwich": ("earth", 51.48, 0.0, 0.0),
    "paris": ("earth", 48.8566, 2.3522, 35.0),
    "sydney": ("earth", -33.8688, 151.2093, 58.0),
    "quito": ("earth", -0.1807, -78.4678, 2850.0),
    "tranquility": ("moon", 0.674, 23.473, 0.0),
    "jezero": ("mars", 18.38, 77.58, 0.0),
}
EXPECTED_FRAMES: Mapping[str, str] = {
    "earth": "ITRS",
    "moon": "MOON_ME_DE440_ME421",
    "mars": "IAU_MARS",
}
EPOCHS_INSIDE_IERS_TABLE = frozenset({"2000-01-01T12:00:00", "2024-04-08T18:00:00"})
EPOCHS_WITH_HORIZONS_DELTA_T = frozenset(
    {"1900-01-01T00:00:00", "1969-07-21T03:00:00", "2050-06-15T00:00:00", "2140-12-31T00:00:00"}
)

# Horizons' zenith for a user-defined Martian site is the planetodetic normal of the
# 3396.19 / 3376.20 km spheroid (its `Center geodetic` echo reads 18.5833832 for our
# planetocentric 18.38), while `PlanetTopos` uses the planetocentric radial direction (R36).
MARS_EQUATORIAL_RADIUS_KM = 3396.19
MARS_POLAR_RADIUS_KM = 3376.20
JEZERO_PLANETOCENTRIC_LAT_DEG = 18.38
HORIZONS_JEZERO_PLANETODETIC_LAT_DEG = 18.5833832

Case = dict[str, Any]


# --- geometry helpers -------------------------------------------------------------------------


def unit_vector(lon_deg: float, lat_deg: float) -> np.ndarray:
    lon, lat = math.radians(lon_deg), math.radians(lat_deg)
    return np.array([math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)])


def separation_arcsec(u: np.ndarray, v: np.ndarray) -> float:
    cross = float(np.linalg.norm(np.cross(u, v)))
    dot = float(np.dot(u, v))
    return math.degrees(math.atan2(cross, dot)) * 3600.0


def altaz_from_enu(enu: np.ndarray) -> tuple[float, float]:
    """(altitude, azimuth) in degrees from an ENU unit vector; azimuth north through east."""
    alt = math.degrees(math.asin(max(-1.0, min(1.0, float(enu[2])))))
    az = math.degrees(math.atan2(float(enu[0]), float(enu[1]))) % 360.0
    return alt, az


def planetodetic_latitude_deg(lat_centric_deg: float, a_km: float, c_km: float) -> float:
    return math.degrees(math.atan(math.tan(math.radians(lat_centric_deg)) * (a_km / c_km) ** 2))


MARS_ZENITH_TILT_RAD = math.radians(
    planetodetic_latitude_deg(
        JEZERO_PLANETOCENTRIC_LAT_DEG, MARS_EQUATORIAL_RADIUS_KM, MARS_POLAR_RADIUS_KM
    )
    - JEZERO_PLANETOCENTRIC_LAT_DEG
)


def tilt_about_east(enu: np.ndarray, angle_rad: float) -> np.ndarray:
    """Express an ENU vector in the frame whose zenith is tilted towards north by `angle_rad`."""
    east, north, up = (float(component) for component in enu)
    cos_a, sin_a = math.cos(angle_rad), math.sin(angle_rad)
    return np.array([east, cos_a * north - sin_a * up, cos_a * up + sin_a * north])


# --- evaluation --------------------------------------------------------------------------------


@dataclass(frozen=True)
class Evaluated:
    """Our values for one Horizons case, on the timescale the delta T policy selects."""

    case: Case
    observer: str
    body: str
    target: str
    calendar_tt: str
    delta_t_path: str
    apparent_dir: np.ndarray
    apparent_dir_builtin: np.ndarray
    astrometric_dir: np.ndarray
    of_date_dir: np.ndarray
    enu: np.ndarray
    enu_planetocentric: np.ndarray
    dist_au: float
    phase: float
    diam_arcsec: float
    mag: float

    @property
    def horizons_apparent(self) -> np.ndarray:
        return unit_vector(self.case["ra_icrf_apparent_deg"], self.case["dec_icrf_apparent_deg"])

    @property
    def horizons_astrometric(self) -> np.ndarray:
        return unit_vector(
            self.case["ra_icrf_astrometric_deg"], self.case["dec_icrf_astrometric_deg"]
        )

    def altaz_residual_arcsec(self, enu: np.ndarray) -> float:
        alt, az = altaz_from_enu(enu)
        return separation_arcsec(
            unit_vector(az, alt), unit_vector(self.case["az_deg"], self.case["el_deg"])
        )


def horizons_delta_t_seconds(t: Time, case: Case) -> float:
    """Horizons' delta T for an Earth row: quantity 30 minus Skyfield's TDB - TT (a few ms)."""
    tdb_minus_tt = (float(t.tdb) - float(t.tt)) * DAY_S
    return float(case["tdb_minus_ut_s"]) - tdb_minus_tt


def unit_rows(xyz: object) -> np.ndarray:
    vectors = np.asarray(xyz, dtype=np.float64).reshape(3, -1).T
    return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)


@pytest.fixture(scope="module")
def horizons() -> Case:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def calendar_of(horizons: Case) -> Mapping[float, str]:
    return {epoch["jd_tt"]: epoch["calendar_tt"] for epoch in horizons["epochs_tt"]}


@pytest.fixture(scope="module")
def sites(astro_state: AstroState, horizons: Case) -> Mapping[str, Observer]:
    return {
        site_id: build_observer(
            astro_state, meta["body"], meta["lat_deg"], meta["lon_deg_east"], meta["elev_m"]
        )
        for site_id, meta in horizons["observers"].items()
    }


@pytest.fixture(scope="module")
def evaluated(
    astro_state: AstroState,
    horizons: Case,
    calendar_of: Mapping[float, str],
    sites: Mapping[str, Observer],
) -> list[Evaluated]:
    ts = astro_state.ts
    observed_start, observed_end = delta_t_coverage(ts).iers_daily_tt
    horizons_timescales: dict[float, Timescale] = {}
    out: list[Evaluated] = []
    for case in horizons["cases"]:
        observer = sites[case["observer"]]
        body = horizons["observers"][case["observer"]]["body"]
        target = case["target"]
        tt = float(case["tt"])
        t_builtin = ts.tt_jd(tt)
        inside_table = observed_start <= tt <= observed_end
        if body == "earth" and not inside_table:
            if tt not in horizons_timescales:
                horizons_timescales[tt] = load.timescale(
                    delta_t=horizons_delta_t_seconds(t_builtin, case)
                )
            t = horizons_timescales[tt].tt_jd(tt)
            path = "horizons_delta_t"
        else:
            t = t_builtin
            path = "skyfield"
        sample = bodies.body_samples(astro_state, observer, t, [target])[target]
        sample_builtin = (
            sample
            if t is t_builtin
            else bodies.body_samples(astro_state, observer, t_builtin, [target])[target]
        )
        ephemeris_key = astro_state.bodies[target].ephemeris_key
        astrometric = observer.vector.at(t).observe(astro_state.eph[ephemeris_key])
        apparent_dir = sample.dir[0]
        enu = rotate(horizon_quaternions(observer, t)[0], apparent_dir)
        out.append(
            Evaluated(
                case=case,
                observer=case["observer"],
                body=body,
                target=target,
                calendar_tt=calendar_of[tt],
                delta_t_path=path,
                apparent_dir=apparent_dir,
                apparent_dir_builtin=sample_builtin.dir[0],
                astrometric_dir=unit_rows(astrometric.xyz.au)[0],
                of_date_dir=rotate(equinox_of_date_quaternions(t)[0], apparent_dir),
                enu=tilt_about_east(enu, MARS_ZENITH_TILT_RAD) if body == "mars" else enu,
                enu_planetocentric=enu,
                dist_au=float(sample.dist_au[0]),
                phase=float(sample.phase[0]),
                diam_arcsec=float(sample.diam_deg[0]) * 3600.0,
                mag=float(sample.mag[0]),
            )
        )
    return out


# --- reporting ---------------------------------------------------------------------------------


def report(
    title: str,
    rows: Iterable[Evaluated],
    value: Callable[[Evaluated], float],
    unit: str,
    key: Callable[[Evaluated], tuple[str, str]] = lambda e: (e.observer, e.target),
) -> float:
    """Print a compact max-per-key table (shown with `-s`) and return the overall maximum."""
    table: dict[tuple[str, str], dict[str, float]] = {}
    for row in rows:
        table.setdefault(key(row), {})[row.calendar_tt[:10]] = value(row)
    epochs = sorted({epoch for cells in table.values() for epoch in cells})
    print(f"\n{title} ({unit}); columns {', '.join(epochs)}")
    overall = 0.0
    for (first, second), cells in sorted(table.items()):
        line = " ".join(f"{cells[e]:9.4f}" if e in cells else "        -" for e in epochs)
        worst = max(abs(v) for v in cells.values())
        overall = max(overall, worst)
        print(f"  {first:<11} {second:<8} {line}   max {worst:.4f}")
    print(f"  overall max {overall:.4f} {unit}")
    return overall


def by_target(evaluated: Iterable[Evaluated], *targets: str) -> list[Evaluated]:
    return [e for e in evaluated if e.target in targets]


# --- fixture premises --------------------------------------------------------------------------


def test_fixture_sites_are_the_documented_observers(
    horizons: Case, sites: Mapping[str, Observer]
) -> None:
    assert set(sites) == set(EXPECTED_SITES)
    for site_id, (body, lat, lon, elev) in EXPECTED_SITES.items():
        meta = horizons["observers"][site_id]
        assert (meta["body"], meta["lat_deg"], meta["lon_deg_east"], meta["elev_m"]) == (
            body,
            lat,
            lon,
            elev,
        )
        observer = sites[site_id]
        assert observer.spec.id == body
        assert observer.spec.frame_name == EXPECTED_FRAMES[body]
        assert (observer.lat_deg, observer.lon_deg, observer.elev_m) == (lat, lon, elev)


def test_delta_t_policy_premises(horizons: Case, ts: Timescale) -> None:
    """The facts the policy rests on, so a regenerated fixture or a new Skyfield table shows.

    Skyfield's measured daily IERS table covers 2000-01-01 and 2024-04-08 but neither 1969-07-21
    (it starts 1973-01-02) nor 2050/2140; Horizons' quantity 30 equals TT - UTC to 0.01 s at
    every post-1972 epoch (TDB - UTC, not TDB - UT1), and equals its own TDB - UT1 at 1900,
    where it differs from Skyfield's S15 spline by 0.03 s (-1.944 vs -1.975 s).
    """
    observed_start, observed_end = delta_t_coverage(ts).iers_daily_tt
    inside = {
        epoch["calendar_tt"]
        for epoch in horizons["epochs_tt"]
        if observed_start <= epoch["jd_tt"] <= observed_end
    }
    assert inside == EPOCHS_INSIDE_IERS_TABLE
    assert {
        e["calendar_tt"] for e in horizons["epochs_tt"]
    } - inside == EPOCHS_WITH_HORIZONS_DELTA_T
    for epoch in horizons["epochs_tt"]:
        rows = [c for c in horizons["cases"] if c["tt"] == epoch["jd_tt"]]
        values = [float(c["tdb_minus_ut_s"]) for c in rows]
        assert max(values) - min(values) < 1e-5, epoch["calendar_tt"]
        year, month, day = (int(part) for part in epoch["calendar_tt"][:10].split("-"))
        hour = int(epoch["calendar_tt"][11:13])
        t = ts.tt(year, month, day, hour)
        assert float(t.tt) == pytest.approx(epoch["jd_tt"], abs=1e-9)
        horizons_delta_t = horizons_delta_t_seconds(t, rows[0])
        if year >= 1972:
            tt_minus_utc = (float(ts.utc(year, month, day, hour).tt) - float(t.tt)) * DAY_S
            assert horizons_delta_t == pytest.approx(tt_minus_utc, abs=0.01), epoch["calendar_tt"]
        elif year < 1962:
            assert horizons_delta_t == pytest.approx(float(t.delta_t), abs=0.1), epoch[
                "calendar_tt"
            ]


def test_mars_zenith_tilt_reproduces_the_horizons_planetodetic_echo() -> None:
    detic = planetodetic_latitude_deg(
        JEZERO_PLANETOCENTRIC_LAT_DEG, MARS_EQUATORIAL_RADIUS_KM, MARS_POLAR_RADIUS_KM
    )
    assert detic == pytest.approx(HORIZONS_JEZERO_PLANETODETIC_LAT_DEG, abs=1e-4)
    assert math.degrees(MARS_ZENITH_TILT_RAD) == pytest.approx(0.2034, abs=1e-3)
    zenith = tilt_about_east(np.array([0.0, 0.0, 1.0]), MARS_ZENITH_TILT_RAD)
    assert altaz_from_enu(zenith)[0] == pytest.approx(90.0 - math.degrees(MARS_ZENITH_TILT_RAD))


# --- directions ---------------------------------------------------------------------------------


def test_apparent_icrf_direction_within_2_arcsec(evaluated: list[Evaluated]) -> None:
    """Quantity 45 at every epoch from every site (measured max 0.010", the Moon from Sydney
    at 2140 on Horizons' delta T; Sun, planets and Pluto <= 0.001")."""
    worst = report(
        "quantity 45: apparent ICRF direction",
        evaluated,
        lambda e: separation_arcsec(e.apparent_dir, e.horizons_apparent),
        "arcsec",
    )
    assert worst <= ARCSEC_TOLERANCE


def test_astrometric_icrf_direction_within_2_arcsec(evaluated: list[Evaluated]) -> None:
    """Quantity 1 (`observe()` without `.apparent()`) at every epoch (measured max 0.011")."""
    worst = report(
        "quantity 1: astrometric ICRF direction",
        evaluated,
        lambda e: separation_arcsec(e.astrometric_dir, e.horizons_astrometric),
        "arcsec",
    )
    assert worst <= ARCSEC_TOLERANCE


def test_apparent_direction_of_date_within_2_arcsec_from_earth(evaluated: list[Evaluated]) -> None:
    """Quantity 2 through `equinox_of_date_quaternions` (D49), Earth sites only: Horizons
    measures the apparent RA of a non-Earth site from that body's frame. Measured max 0.31"
    at 2140 and 0.24" at 1900 (precession models), <= 0.06" at the four other epochs."""
    rows = [e for e in evaluated if e.body == "earth"]
    worst = report(
        "quantity 2: apparent RA/Dec of date (Earth sites)",
        rows,
        lambda e: separation_arcsec(
            e.of_date_dir,
            unit_vector(e.case["ra_apparent_of_date_deg"], e.case["dec_apparent_of_date_deg"]),
        ),
        "arcsec",
    )
    assert worst <= ARCSEC_TOLERANCE


def test_builtin_timescale_is_enough_except_for_lunar_parallax(evaluated: list[Evaluated]) -> None:
    """With Skyfield's own delta T at every epoch, quantity 45 stays within 2" for the Sun,
    planets and Pluto (measured <= 0.03"), and the Moon's excess from the Earth sites is
    explained by the observer displacement the delta T gap causes: 0.55" at 2050 and 1.7"
    (Greenwich), 1.9" (Paris), 5.9" (Sydney), 15.3" (Quito) at 2140, where Skyfield's parabola
    gives 135.3 s and Horizons holds 69.2 s (16.5' of Earth rotation, 19 km at the equator).
    """
    others = [e for e in evaluated if e.target != "moon"]
    worst = report(
        "quantity 45 on the builtin timescale (Sun, planets, Pluto)",
        others,
        lambda e: separation_arcsec(e.apparent_dir_builtin, e.horizons_apparent),
        "arcsec",
    )
    assert worst <= ARCSEC_TOLERANCE
    moon = [e for e in evaluated if e.target == "moon" and e.body == "earth"]
    report(
        "quantity 45 on the builtin timescale (the Moon from Earth)",
        moon,
        lambda e: separation_arcsec(e.apparent_dir_builtin, e.horizons_apparent),
        "arcsec",
    )
    for e in moon:
        residual = separation_arcsec(e.apparent_dir_builtin, e.horizons_apparent)
        t = load.timescale().tt_jd(float(e.case["tt"]))
        gap_s = abs(float(t.delta_t) - horizons_delta_t_seconds(t, e.case))
        lat = math.radians(EXPECTED_SITES[e.observer][1])
        displacement_km = EARTH_EQUATORIAL_RADIUS_KM * math.cos(lat) * EARTH_ROTATION_RAD_S * gap_s
        parallax_arcsec = math.degrees(displacement_km / (e.dist_au * AU_KM)) * 3600.0
        assert residual <= parallax_arcsec + ARCSEC_TOLERANCE, (e.observer, e.calendar_tt)


# --- horizon -----------------------------------------------------------------------------------


def test_altaz_within_2_arcsec(evaluated: list[Evaluated]) -> None:
    """Quantity 4 (airless) from every site at every epoch, on the timescale the delta T policy
    selects (measured: Earth sites <= 0.47" on the builtin timescale at 2000 and 2024,
    <= 0.58" with Horizons' delta T at 1900, 1969, 2050 and 2140; Tranquility Base <= 0.008";
    Jezero <= 0.001" after the planetodetic tilt).

    Without the policy the Earth-site residuals would be 3.8" at 1969, 35" at 2050 and 991"
    at 2140 (builtin) or 5.7" at 2000 (Horizons' quantity 30, which is TDB - UTC there).
    """
    worst = report(
        "quantity 4: azimuth/elevation, per site and epoch (max over targets)",
        evaluated,
        lambda e: e.altaz_residual_arcsec(e.enu),
        "arcsec",
        key=lambda e: (e.observer, e.delta_t_path),
    )
    assert worst <= ARCSEC_TOLERANCE


def test_mars_altaz_needs_the_planetodetic_zenith(evaluated: list[Evaluated]) -> None:
    """The untilted planetocentric ENU disagrees with Horizons by 159" to 732" (the 0.2034 deg
    latitude difference projected on the sky), the tilted one by <= 0.001" at every epoch from
    1900 to 2140: Horizons rotates Mars with the same model as `pck00011.tpc` (R34)."""
    rows = [e for e in evaluated if e.body == "mars"]
    assert len(rows) == 60
    for e in rows:
        assert e.altaz_residual_arcsec(e.enu_planetocentric) > 100.0, (e.target, e.calendar_tt)
    worst = report(
        "quantity 4 from Jezero after the planetodetic tilt",
        rows,
        lambda e: e.altaz_residual_arcsec(e.enu),
        "arcsec",
    )
    assert worst <= ARCSEC_TOLERANCE


# --- scalar quantities -------------------------------------------------------------------------


def test_range_within_1e6_au(evaluated: list[Evaluated]) -> None:
    """Quantity 20 (measured max 1e-10 au, 15 m, on the policy timescale; on the builtin
    timescale the delta T gap moves the Earth sites by up to 30 km at 2140: 1.9e-7 au)."""
    worst = report(
        "quantity 20: range",
        evaluated,
        lambda e: abs(e.dist_au - float(e.case["range_au"])) * 1e6,
        "micro-au",
    )
    assert worst * 1e-6 <= RANGE_TOLERANCE_AU


def test_illuminated_fraction_within_half_a_point(evaluated: list[Evaluated]) -> None:
    """Quantity 10 where Horizons has it (measured max 0.018 percentage points)."""
    rows = [e for e in evaluated if e.case["illuminated_pct"] is not None]
    assert {e.target for e in rows} == {"sun", "moon", "mercury", "venus", "earth", "mars"}
    worst = report(
        "quantity 10: illuminated fraction",
        rows,
        lambda e: e.phase * 100.0 - float(e.case["illuminated_pct"]),
        "percentage points",
    )
    assert worst <= ILLUMINATION_TOLERANCE_PCT_POINTS


def test_angular_diameter_within_half_a_percent(evaluated: list[Evaluated]) -> None:
    """Quantity 13 where Horizons has it (measured max 0.006 %, the Moon at 2140)."""
    rows = [e for e in evaluated if e.case["ang_diam_arcsec"] is not None]
    worst = report(
        "quantity 13: angular diameter",
        rows,
        lambda e: (e.diam_arcsec / float(e.case["ang_diam_arcsec"]) - 1.0) * 100.0,
        "percent",
    )
    assert worst <= DIAMETER_TOLERANCE_PCT


def test_magnitude_within_half_a_magnitude(evaluated: list[Evaluated]) -> None:
    """Quantity 9 where Horizons has it (measured max 0.095 mag, Mercury from Jezero at 2140;
    the Moon's Allen phase law within 0.044 mag; the Sun within 0.003 mag)."""
    rows = [e for e in evaluated if e.case["apmag"] is not None]
    worst = report(
        "quantity 9: apparent magnitude (ours - Horizons)",
        rows,
        lambda e: e.mag - float(e.case["apmag"]),
        "mag",
    )
    assert worst <= MAGNITUDE_TOLERANCE


def test_mars_pole_matches_horizons(horizons: Case, astro_state: AstroState, ts: Timescale) -> None:
    """Quantity 32 for Mars from Greenwich at every epoch against `IauRotationFrame` (D44).

    Measured 0.00-0.02" (Horizons' five decimals quantise at 0.036"): Horizons serves the Mars
    pole of `pck00011.tpc` (IAU 2015 with its long-period terms, 317.68085/52.88644 at J2000),
    so the R34 concern does not materialise and backlog B-36 stays empty.
    """
    frame = astro_state.iau_frames["mars"]
    rows = [c for c in horizons["cases"] if c["observer"] == "greenwich" and c["target"] == "mars"]
    assert len(rows) == 6
    print("\nquantity 32: Mars north pole (arcsec)")
    for case in rows:
        pole = frame.pole_and_meridian_at(ts.tt_jd(float(case["tt"])))
        ours = unit_vector(float(pole.ra_deg), float(pole.dec_deg))
        theirs = unit_vector(float(case["pole_ra_deg"]), float(case["pole_dec_deg"]))
        residual = separation_arcsec(ours, theirs)
        print(
            f"  {case['tt']:<12} ours {float(pole.ra_deg):.5f} {float(pole.dec_deg):.5f}"
            f"  horizons {case['pole_ra_deg']} {case['pole_dec_deg']}  {residual:.3f}"
        )
        assert residual <= POLE_TOLERANCE_ARCSEC
