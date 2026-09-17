"""Generate the machine-made conformance fixtures under ``backend/tests/fixtures/``.

Run through the backend environment so that Skyfield is importable::

    uv run --directory backend python ../scripts/generate_fixtures.py horizons --probe
    uv run --directory backend python ../scripts/generate_fixtures.py horizons \\
        --out ../backend/tests/fixtures/horizons_cases.json --raw-dir <scratch directory>

Subcommands:

``horizons``
    Queries the JPL Horizons API (https://ssd.jpl.nasa.gov/api/horizons.api) for reference
    positions of the Sun, Moon, planets and Pluto as seen from a few sites on Earth, the Moon
    and Mars at six TT epochs, and writes ``horizons_cases.json`` (decision D37). It talks to
    the network, so it runs manually (once per milestone at most) and refuses to run when the
    ``CI`` environment variable is set. It follows the SSD API fair-use policy: one request at
    a time, a pause between requests, exponential back-off on 429/503, a hard request cap.

``skyfield``
    Runs our own astronomy core (``skyapi.astro`` on Skyfield and ``de440s.bsp``) and writes the
    three parity fixtures the backend and the M3 frontend tests load: ``skyfield_stars.json``
    (test stars: catalog row, SKYS row, barycentric and apparent directions and the Earth's
    velocity at six epochs), ``skyfield_frames.json`` (three ``/sky/frame``-shaped windows) and
    ``skyfield_refraction.json`` (true -> apparent altitude tables). Local and deterministic
    apart from ``generated_at``; needs the kernel set and ``hip_main.dat`` in ``--data-dir``::

        uv run --directory backend python ../scripts/generate_fixtures.py skyfield \\
            --data-dir ../data --out-dir ../backend/tests/fixtures

``orientation``
    Writes ``device_orientation_cases.json`` (plan D133), the fixture of the frontend's
    orientation-to-camera math (``sky/math/orientation.ts``): an independent plain-Python
    implementation of the W3C Device Orientation rotation matrix (Appendix A), the screen fold,
    the view rule and the compass correction, over the spec's worked examples, closed-form
    geometric poses, 200 seeded round trips, compass-correction cases and gimbal rows. Offline,
    seeded and deterministic apart from ``generated_at``; needs no data directory::

        uv run --directory backend python ../scripts/generate_fixtures.py orientation

Reference values: JPL Horizons, Solar System Dynamics Group, https://ssd.jpl.nasa.gov/horizons/
(US Government work, public domain).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_DIR = REPO_ROOT / "data"
DEFAULT_PCK = DEFAULT_DATA_DIR / "pck00011.tpc"
DEFAULT_FIXTURES_DIR = REPO_ROOT / "backend" / "tests" / "fixtures"
DEFAULT_OUT = DEFAULT_FIXTURES_DIR / "horizons_cases.json"

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
USER_AGENT = "InterSidera fixtures generator (+https://github.com/j-about/InterSidera)"
REQUEST_TIMEOUT_S = 90.0
BACKOFF_S: tuple[float, ...] = (30.0, 60.0, 120.0)
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
MAX_REQUESTS = 80
DEFAULT_PAUSE_S = 1.5

# Every parameter that does not depend on the observer or the target. Values are single-quoted
# as the API documents (``COMMAND='499'``); ``format`` is the API's own switch and is unquoted.
FIXED_PARAMETERS: dict[str, str] = {
    "format": "json",
    "OBJ_DATA": "'NO'",
    "MAKE_EPHEM": "'YES'",
    "EPHEM_TYPE": "'OBSERVER'",
    "TLIST_TYPE": "'JD'",
    "TIME_TYPE": "'TT'",
    "CAL_FORMAT": "'JD'",
    "TIME_DIGITS": "'FRACSEC'",
    "QUANTITIES": "'1,2,4,9,10,13,20,24,30,32,45'",
    "APPARENT": "'AIRLESS'",
    "ANG_FORMAT": "'DEG'",
    "EXTRA_PREC": "'YES'",
    "CSV_FORMAT": "'YES'",
    "REF_SYSTEM": "'ICRF'",
}

# Horizons CSV column label -> fixture field. Labels as returned by API version 1.2 with
# ANG_FORMAT=DEG, EXTRA_PREC=YES, CSV_FORMAT=YES, after runs of underscores (column padding,
# e.g. "R.A.___(ICRF)", "DEC____(ICRF)") are collapsed to one; an unknown label fails the run.
COLUMN_FIELDS: dict[str, str] = {
    "R.A._(ICRF)": "ra_icrf_astrometric_deg",
    "DEC_(ICRF)": "dec_icrf_astrometric_deg",
    "R.A._(a-app)": "ra_apparent_of_date_deg",
    "DEC_(a-app)": "dec_apparent_of_date_deg",
    "Azimuth_(a-app)": "az_deg",
    "Elevation_(a-app)": "el_deg",
    "APmag": "apmag",
    "S-brt": "surface_brightness",
    "Illu%": "illuminated_pct",
    "Ang-diam": "ang_diam_arcsec",
    "delta": "range_au",
    "deldot": "range_rate_km_s",
    "S-T-O": "phase_angle_deg",
    "TDB-UT": "tdb_minus_ut_s",
    "N.Pole-RA": "pole_ra_deg",
    "N.Pole-DC": "pole_dec_deg",
    "RA_(ICRF-a-app)": "ra_icrf_apparent_deg",
    "DEC_(ICRF-a-app)": "dec_icrf_apparent_deg",
}
NOT_AVAILABLE = "n.a."

# TT calendar epochs, all inside de440s (1849-2150); converted to TT Julian Dates with Skyfield.
EPOCHS_TT: tuple[tuple[int, int, int, int], ...] = (
    (1900, 1, 1, 0),
    (1969, 7, 21, 3),
    (2000, 1, 1, 12),
    (2024, 4, 8, 18),
    (2050, 6, 15, 0),
    (2140, 12, 31, 0),
)
PROBE_EPOCH = (2000, 1, 1, 12)

# Horizons COMMAND ids of our body ids. 5..9 are the system barycenters, which is what our
# ephemeris keys point at (D44); 599 is requested once to measure the centre offset.
TARGET_IDS: dict[str, int] = {
    "sun": 10,
    "moon": 301,
    "mercury": 199,
    "venus": 299,
    "earth": 399,
    "mars": 499,
    "jupiter": 5,
    "saturn": 6,
    "uranus": 7,
    "neptune": 8,
    "pluto": 9,
}
EARTH_SITE_TARGETS: tuple[str, ...] = (
    "sun",
    "moon",
    "mercury",
    "venus",
    "mars",
    "jupiter",
    "saturn",
    "uranus",
    "neptune",
    "pluto",
)
JUPITER_CENTER_ID = 599
BARYCENTER_CHECK_OBSERVER = "greenwich"

# Sign applied to our east longitude before it is sent as the CYLINDRICAL "E-long" of a
# non-Earth site (R36, settled by the --probe request). Horizons refuses a positive east
# longitude for IAU west-positive bodies ("Input east-longitude as negative for IAU
# west-positive body #499"), so Mars takes -lon (the manual's "west-longitude - 360" form);
# the Moon is east-positive in Horizons and takes +lon.
CYLINDRICAL_EAST_LONGITUDE_SIGN: dict[int, int] = {301: 1, 499: -1}
LONGITUDE_SIGN_DECISION = (
    "Non-Earth sites are sent as COORD_TYPE=CYLINDRICAL {E-long, DXY km, DZ km} built from our "
    "planetocentric latitude/longitude and the pck00011 triaxial radius. Horizons applies the "
    "body's IAU longitude convention to that E-long: for the Moon (east-positive) our east "
    "longitude is sent unchanged (+23.473); for Mars (west-positive) a positive value is "
    "rejected in-band ('Input east-longitude as negative for IAU west-positive body #499', "
    "probe 1, 2026-09-03) and the negative of our east longitude is sent (-77.58), which "
    "Horizons echoes as the equivalent west longitude 282.42. Probe 2 (jezero -> Sun at JD TT "
    "2451545.0, SITE_COORD='-77.580000,3221.036004,1070.247435') echoed verbatim: "
    "'Center geodetic : 282.42, 18.5833832, 1.5703E-7   {W-lon(deg),Lat(deg),Alt(km)}' | "
    "'Center cylindric: 282.42, 3221.036, 1070.24743    {W-lon(deg),Dxy(km),Dz(km)}' | "
    "'Center pole/equ : IAU_MARS                        {West-longitude positive}' | "
    "'Center radii    : 3396.19, 3396.19, 3376.2 km     {Equator_a, b, pole_c}'. 282.42 W is "
    "77.58 E, the echoed latitude is the planetodetic equivalent of planetocentric 18.38 on "
    "the 3396.19/3376.2 km ellipsoid, and the altitude residual is 1.6e-7 km, so the site is "
    "the one our API defines. A Skyfield check with the IAU 2009 Mars rotation reproduces the "
    "probe's Sun azimuth/elevation for +77.58 E and not for the sign-flipped site."
)


@dataclass(frozen=True)
class Observer:
    """A fixture observer as our API defines it (D44 coordinate kinds)."""

    id: str
    body: str
    center: int
    lat_deg: float
    lon_deg_east: float
    elev_m: float

    @property
    def coord_type(self) -> str:
        return "GEODETIC" if self.center == 399 else "CYLINDRICAL"

    @property
    def targets(self) -> tuple[str, ...]:
        if self.body == "earth":
            return EARTH_SITE_TARGETS
        # Same list minus the observer's own body plus the Earth (the Moon from Mars is
        # already in the Earth-site list).
        others = tuple(t for t in EARTH_SITE_TARGETS if t != self.body)
        return (*others, "earth")


OBSERVERS: tuple[Observer, ...] = (
    Observer("greenwich", "earth", 399, 51.48, 0.00, 0.0),
    Observer("paris", "earth", 399, 48.8566, 2.3522, 35.0),
    Observer("sydney", "earth", 399, -33.8688, 151.2093, 58.0),
    Observer("quito", "earth", 399, -0.1807, -78.4678, 2850.0),
    Observer("tranquility", "moon", 301, 0.674, 23.473, 0.0),
    Observer("jezero", "mars", 499, 18.38, 77.58, 0.0),
)
OBSERVERS_BY_ID: dict[str, Observer] = {observer.id: observer for observer in OBSERVERS}

Radii = tuple[float, float, float]
Triplet = tuple[float, float, float]


class FixtureError(RuntimeError):
    """A fixture cannot be produced; `main` prints the message and exits 1."""


class HorizonsError(FixtureError):
    """A failed or unusable Horizons response (also raised for Horizons' in-band errors)."""


@dataclass(frozen=True)
class SiteCoord:
    """The SITE_COORD triplet as sent, plus what the echo must equal."""

    coord_type: str
    sent: Triplet

    @property
    def text(self) -> str:
        return ",".join(f"{value:.6f}" for value in self.sent)


@dataclass(frozen=True)
class HorizonsTable:
    """One parsed Horizons response."""

    version: str
    header_lines: list[str]
    columns: list[str]
    rows: list[list[str]]

    def header(self, label: str) -> str | None:
        for line in self.header_lines:
            stripped = line.strip()
            if stripped.startswith(label):
                return stripped
        return None

    def require_header(self, label: str) -> str:
        line = self.header(label)
        if line is None:
            raise HorizonsError(f"header line {label!r} missing; header was:\n{self.header_text}")
        return line

    @property
    def header_text(self) -> str:
        return "\n".join(self.header_lines)


# --------------------------------------------------------------------------------------------
# Geometry helpers (site coordinates only; no sky computation happens in this script)
# --------------------------------------------------------------------------------------------


def triaxial_radius_km(lat_deg: float, lon_deg: float, radii: Radii) -> float:
    """Planetocentric surface radius of a triaxial ellipsoid at (lat, lon)."""
    a, b, c = radii
    phi = math.radians(lat_deg)
    lam = math.radians(lon_deg)
    return 1.0 / math.sqrt(
        (math.cos(phi) * math.cos(lam) / a) ** 2
        + (math.cos(phi) * math.sin(lam) / b) ** 2
        + (math.sin(phi) / c) ** 2
    )


def site_coord(observer: Observer, radii: Mapping[int, Radii]) -> SiteCoord:
    """Build the SITE_COORD triplet for an observer (GEODETIC on Earth, CYLINDRICAL elsewhere)."""
    if observer.coord_type == "GEODETIC":
        return SiteCoord(
            "GEODETIC", (observer.lon_deg_east, observer.lat_deg, observer.elev_m / 1000)
        )
    body_radii = radii[observer.center]
    r_km = triaxial_radius_km(observer.lat_deg, observer.lon_deg_east, body_radii)
    r_km += observer.elev_m / 1000
    phi = math.radians(observer.lat_deg)
    lon = CYLINDRICAL_EAST_LONGITUDE_SIGN[observer.center] * observer.lon_deg_east
    return SiteCoord("CYLINDRICAL", (lon, r_km * math.cos(phi), r_km * math.sin(phi)))


def wrapped_difference_deg(a: float, b: float) -> float:
    return (a - b + 180.0) % 360.0 - 180.0


def angular_separation_arcsec(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    """Great-circle separation of two (RA, Dec) pairs in degrees, returned in arcseconds."""
    a1, d1, a2, d2 = (math.radians(v) for v in (ra1, dec1, ra2, dec2))
    x1, y1, z1 = math.cos(d1) * math.cos(a1), math.cos(d1) * math.sin(a1), math.sin(d1)
    x2, y2, z2 = math.cos(d2) * math.cos(a2), math.cos(d2) * math.sin(a2), math.sin(d2)
    cross = math.hypot(y1 * z2 - z1 * y2, z1 * x2 - x1 * z2, x1 * y2 - y1 * x2)
    dot = x1 * x2 + y1 * y2 + z1 * z2
    return math.degrees(math.atan2(cross, dot)) * 3600.0


# --------------------------------------------------------------------------------------------
# Skyfield-backed inputs (timescale and PCK radii); imported lazily so --help needs nothing
# --------------------------------------------------------------------------------------------


def tt_julian_dates(epochs: Sequence[tuple[int, int, int, int]]) -> list[float]:
    from skyfield.api import load  # lazy: only the run needs Skyfield

    ts = load.timescale()  # builtin leap-second and delta-T tables; no download
    return [float(ts.tt(year, month, day, hour).tt) for year, month, day, hour in epochs]


def read_radii(pck_path: Path) -> dict[int, Radii]:
    from skyfield.planetarylib import PlanetaryConstants  # lazy

    constants = PlanetaryConstants()
    with pck_path.open("rb") as handle:
        constants.read_text(handle)
    radii: dict[int, Radii] = {}
    for code in (301, 499):
        a, b, c = (float(v) for v in constants.variables[f"BODY{code}_RADII"])
        radii[code] = (a, b, c)
    return radii


# --------------------------------------------------------------------------------------------
# HTTP and parsing
# --------------------------------------------------------------------------------------------


def build_url(observer: Observer, site: SiteCoord, command: int, jds: Sequence[float]) -> str:
    parameters: dict[str, str] = {
        **FIXED_PARAMETERS,
        "COMMAND": f"'{command}'",
        "CENTER": f"'coord@{observer.center}'",
        "COORD_TYPE": f"'{site.coord_type}'",
        "SITE_COORD": f"'{site.text}'",
        "TLIST": " ".join(f"'{jd!r}'" for jd in jds),
    }
    query = urllib.parse.urlencode(parameters, quote_via=urllib.parse.quote)
    return f"{HORIZONS_URL}?{query}"


def fetch(url: str) -> str:
    """GET one Horizons URL with the fair-use back-off (30 s, 60 s, 120 s) on 429/5xx/network."""
    request = urllib.request.Request(  # https scheme, fixed host
        url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
    )
    attempts = len(BACKOFF_S) + 1
    for attempt in range(attempts):
        last = attempt == attempts - 1
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as response:
                return response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            if exc.code not in RETRY_STATUSES or last:
                raise HorizonsError(f"HTTP {exc.code} from Horizons: {body[:2000]}") from exc
            reason = f"HTTP {exc.code}"
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if last:
                raise HorizonsError(f"network failure talking to Horizons: {exc}") from exc
            reason = f"{type(exc).__name__}: {exc}"
        backoff = BACKOFF_S[attempt]
        print(f"  {reason}; backing off {backoff:.0f} s", file=sys.stderr)
        time.sleep(backoff)
    raise HorizonsError("unreachable: retry loop exhausted")


def _find_marker(lines: Sequence[str], marker: str) -> int:
    for index, line in enumerate(lines):
        if line.strip() == marker:
            return index
    raise HorizonsError(f"marker {marker} missing")


def parse_response(text: str) -> HorizonsTable:
    payload: object = json.loads(text)
    if not isinstance(payload, dict):
        raise HorizonsError(f"response is not a JSON object: {text[:500]}")
    if "error" in payload:
        raise HorizonsError(f"Horizons error: {payload['error']}")
    if "message" in payload and "result" not in payload:
        raise HorizonsError(f"Horizons rejected the request: {payload['message']}")
    signature = payload.get("signature")
    version = str(signature.get("version", "?")) if isinstance(signature, dict) else "?"
    result = payload.get("result")
    if not isinstance(result, str):
        raise HorizonsError(f"response has no textual 'result': {text[:500]}")
    lines = result.splitlines()
    try:
        soe = _find_marker(lines, "$$SOE")
        eoe = _find_marker(lines, "$$EOE")
    except HorizonsError as exc:
        raise HorizonsError(f"no ephemeris table in the response:\n{result[-3000:]}") from exc
    header_lines = lines[:soe]
    column_line = next(
        (
            line
            for line in reversed(header_lines)
            if line.strip() and not line.lstrip().startswith("*")
        ),
        None,
    )
    if column_line is None:
        raise HorizonsError("CSV column header line not found above $$SOE")
    columns = _split_csv(column_line)
    rows = [_split_csv(line) for line in lines[soe + 1 : eoe] if line.strip()]
    for row in rows:
        if len(row) != len(columns):
            raise HorizonsError(f"row has {len(row)} cells for {len(columns)} columns: {row}")
    return HorizonsTable(version, header_lines, columns, rows)


def _split_csv(line: str) -> list[str]:
    cells = [cell.strip() for cell in line.split(",")]
    if cells and cells[-1] == "":
        cells.pop()  # Horizons terminates every CSV line with a comma
    return cells


def row_fields(columns: Sequence[str], row: Sequence[str]) -> dict[str, float | None]:
    """Map one CSV row to fixture fields; ``n.a.`` becomes ``None``; unknown labels fail."""
    fields: dict[str, float | None] = {}
    for name, cell in zip(columns, row, strict=True):
        if name == "":
            continue  # solar/lunar presence flags carry an empty header
        if name.startswith("Date"):
            fields["jd"] = float(cell)
            continue
        key = COLUMN_FIELDS.get(re.sub("_+", "_", name))
        if key is None:
            raise HorizonsError(f"unexpected column {name!r}; columns were {list(columns)}")
        fields[key] = None if cell == NOT_AVAILABLE else float(cell)
    missing = sorted({"jd", *COLUMN_FIELDS.values()} - fields.keys())
    if missing:
        raise HorizonsError(f"columns missing from the table: {missing}; got {list(columns)}")
    return fields


def parse_triplet(line: str) -> Triplet:
    """Read ``Label : a,b,c {units}`` into three floats."""
    body = line.split(":", 1)[1].split("{", 1)[0]
    values = [float(part) for part in body.split(",")]
    if len(values) != 3:
        raise HorizonsError(f"expected three values in {line!r}")
    return (values[0], values[1], values[2])


def check_center_echo(table: HorizonsTable, observer: Observer, site: SiteCoord) -> str:
    """Assert Horizons echoed the site we sent (R36) and return the echoed line verbatim."""
    label = "Center geodetic" if site.coord_type == "GEODETIC" else "Center cylindric"
    line = table.require_header(label)
    echoed = parse_triplet(line)
    sent = site.sent
    problems: list[str] = []
    if abs(wrapped_difference_deg(echoed[0], sent[0])) > 1e-3:
        problems.append(f"longitude {echoed[0]} vs sent {sent[0]}")
    for name, got, want in (("second", echoed[1], sent[1]), ("third", echoed[2], sent[2])):
        if abs(got - want) > 1e-3:
            problems.append(f"{name} value {got} vs sent {want}")
    if problems:
        raise HorizonsError(
            f"{observer.id}: echoed site differs from the request: {problems}\n{line}"
        )
    return line


def match_rows_to_epochs(
    table: HorizonsTable, jds: Sequence[float]
) -> list[tuple[float, dict[str, float | None]]]:
    """Pair every requested TT JD with its row (Horizons sorts TLIST; equality within 1e-6 d)."""
    parsed = [row_fields(table.columns, row) for row in table.rows]
    if len(parsed) != len(jds):
        raise HorizonsError(f"{len(parsed)} rows returned for {len(jds)} requested epochs")
    matched: list[tuple[float, dict[str, float | None]]] = []
    for jd in jds:
        candidates = [f for f in parsed if f["jd"] is not None and abs(f["jd"] - jd) <= 1e-6]
        if len(candidates) != 1:
            raise HorizonsError(f"epoch JD {jd!r} matched {len(candidates)} rows")
        matched.append((jd, candidates[0]))
    return matched


# --------------------------------------------------------------------------------------------
# Session: one request at a time, paced, capped, raw responses kept
# --------------------------------------------------------------------------------------------


@dataclass
class Session:
    pause_s: float
    raw_dir: Path | None
    reuse_raw: bool = False
    request_urls: list[str] = field(default_factory=list)
    replayed: int = 0
    versions: set[str] = field(default_factory=set)
    _last_request: float = field(default=0.0, init=False)

    def query(
        self,
        observer: Observer,
        site: SiteCoord,
        command: int,
        jds: Sequence[float],
        name: str,
    ) -> HorizonsTable:
        url = build_url(observer, site, command, jds)
        raw_path = None if self.raw_dir is None else self.raw_dir / f"{name}.json"
        if self.reuse_raw and raw_path is not None and raw_path.is_file():
            # Fair-use policy: reuse a saved response rather than asking again after a rerun.
            print(
                f"[--] {observer.id:<11} -> {command} (replayed from {raw_path.name})",
                file=sys.stderr,
            )
            self.replayed += 1
            self.request_urls.append(url)
            table = parse_response(raw_path.read_text(encoding="utf-8"))
            self.versions.add(table.version)
            return table
        if len(self.request_urls) - self.replayed >= MAX_REQUESTS:
            raise HorizonsError(f"request cap of {MAX_REQUESTS} reached; refusing to continue")
        elapsed = time.monotonic() - self._last_request
        if self._last_request and elapsed < self.pause_s:
            time.sleep(self.pause_s - elapsed)
        print(f"[{len(self.request_urls) + 1:2d}] {observer.id:<11} -> {command}", file=sys.stderr)
        self._last_request = time.monotonic()
        text = fetch(url)
        self.request_urls.append(url)
        if raw_path is not None:
            raw_path.parent.mkdir(parents=True, exist_ok=True)
            raw_path.write_text(text, encoding="utf-8")
        table = parse_response(text)
        self.versions.add(table.version)
        return table


# --------------------------------------------------------------------------------------------
# The horizons subcommand
# --------------------------------------------------------------------------------------------


def utc_now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run_probe(session: Session, radii: Mapping[int, Radii]) -> int:
    observer = OBSERVERS_BY_ID["jezero"]
    site = site_coord(observer, radii)
    jd = tt_julian_dates([PROBE_EPOCH])[0]
    table = session.query(observer, site, TARGET_IDS["sun"], [jd], name="probe_jezero_10")
    print(f"# Horizons API version {table.version}")
    print(f"# SITE_COORD sent: {site.coord_type} {site.text}")
    print("# --- header (verbatim) ---")
    for line in table.header_lines:
        print(line)
    print("# --- columns ---")
    print(table.columns)
    print("# --- rows ---")
    for row in table.rows:
        print(row)
    print("# --- parsed ---")
    for jd_value, fields in match_rows_to_epochs(table, [jd]):
        print(json.dumps({"tt": jd_value, **fields}, indent=2, sort_keys=True))
    print("# --- echo check ---")
    print(check_center_echo(table, observer, site))
    return 0


def run_horizons(args: argparse.Namespace) -> int:
    if "CI" in os.environ:
        print(
            "generate_fixtures horizons: refusing to run because the CI environment variable is set"
            " (the Horizons fetch is manual; never from CI)",
            file=sys.stderr,
        )
        return 2
    pck: Path = args.pck
    raw_dir: Path | None = args.raw_dir
    radii = read_radii(pck)
    session = Session(pause_s=args.pause, raw_dir=raw_dir, reuse_raw=bool(args.reuse_raw))
    if args.probe:
        return run_probe(session, radii)

    jds = tt_julian_dates(EPOCHS_TT)
    generated_at = utc_now_iso()
    observers_meta: dict[str, dict[str, object]] = {}
    targets_meta: dict[str, dict[str, object]] = {}
    cases: list[dict[str, object]] = []
    barycenter_rows: dict[str, dict[str, object]] = {}

    for observer in OBSERVERS:
        site = site_coord(observer, radii)
        commands = [(target, TARGET_IDS[target]) for target in observer.targets]
        if observer.id == BARYCENTER_CHECK_OBSERVER:
            commands.append(("jupiter_center", JUPITER_CENTER_ID))
        for target, command in commands:
            table = session.query(observer, site, command, jds, name=f"{observer.id}_{command}")
            center_echo = check_center_echo(table, observer, site)
            observers_meta.setdefault(
                observer.id,
                {
                    "body": observer.body,
                    "horizons_center": f"coord@{observer.center}",
                    "lat_deg": observer.lat_deg,
                    "lon_deg_east": observer.lon_deg_east,
                    "elev_m": observer.elev_m,
                    "coord_type": site.coord_type,
                    "site_coord_sent": site.text,
                    "center_echo": center_echo,
                    "geodetic_echo": table.header("Center geodetic"),
                    "cylindric_echo": table.header("Center cylindric"),
                    "radii_echo": table.header("Center radii"),
                    "pole_echo": table.require_header("Center pole/equ"),
                },
            )
            targets_meta.setdefault(
                target,
                {
                    "horizons_id": command,
                    "name_echo": table.header("Target body name"),
                    "radii_echo": table.header("Target radii"),
                    "pole_echo": table.header("Target pole/equ"),
                },
            )
            rows = match_rows_to_epochs(table, jds)
            if target == "jupiter_center":
                barycenter_rows["center"] = {"horizons_id": command, "rows": rows}
                continue
            if observer.id == BARYCENTER_CHECK_OBSERVER and target == "jupiter":
                barycenter_rows["barycenter"] = {"horizons_id": command, "rows": rows}
            for jd, fields in rows:
                case: dict[str, object] = {
                    "observer": observer.id,
                    "target": target,
                    "horizons_id": command,
                    "tt": jd,
                }
                case.update((k, v) for k, v in fields.items() if k != "jd")
                cases.append(case)

    document: dict[str, object] = {
        "source": (
            "JPL Horizons API (https://ssd.jpl.nasa.gov/api/horizons.api), API version "
            + "/".join(sorted(session.versions))
            + " from the response signature; Solar System Dynamics Group, "
            "https://ssd.jpl.nasa.gov/horizons/; US Government work, public domain"
        ),
        "generator": "scripts/generate_fixtures.py horizons",
        "generated_at": generated_at,
        "horizons_version": "/".join(sorted(session.versions)),
        "parameters": dict(FIXED_PARAMETERS),
        "epochs_tt": [
            {"calendar_tt": f"{y:04d}-{m:02d}-{d:02d}T{h:02d}:00:00", "jd_tt": jd}
            for (y, m, d, h), jd in zip(EPOCHS_TT, jds, strict=True)
        ],
        "observers": observers_meta,
        "targets": targets_meta,
        "longitude_sign_decision": LONGITUDE_SIGN_DECISION,
        "cases": cases,
        "case_count": len(cases),
        "barycenter_offset_check": barycenter_offset_check(barycenter_rows, jds),
        "request_urls": list(session.request_urls),
        "request_count": len(session.request_urls),
    }
    out: Path = args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(document, indent=2, sort_keys=True) + "\n"
    out.write_text(text, encoding="utf-8")
    print(
        f"wrote {out} ({len(text):,} bytes, {len(cases)} cases, "
        f"{len(session.request_urls)} requests of which {session.replayed} replayed)",
        file=sys.stderr,
    )
    return 0


def barycenter_offset_check(
    rows: Mapping[str, Mapping[str, object]], jds: Sequence[float]
) -> dict[str, object]:
    """Jupiter system barycenter (5) versus Jupiter centre (599) from Greenwich, per epoch."""
    if set(rows) != {"barycenter", "center"}:
        raise HorizonsError(f"barycenter check incomplete: {sorted(rows)}")
    per_epoch: list[dict[str, object]] = []
    keys = (
        "ra_icrf_astrometric_deg",
        "dec_icrf_astrometric_deg",
        "ra_icrf_apparent_deg",
        "dec_icrf_apparent_deg",
    )
    bary_rows = _rows_of(rows["barycenter"])
    center_rows = _rows_of(rows["center"])
    for jd, (_, bary), (_, center) in zip(jds, bary_rows, center_rows, strict=True):
        entry: dict[str, object] = {"tt": jd}
        for label, fields in (("barycenter", bary), ("center", center)):
            entry[label] = {key: fields[key] for key in keys}
        for kind in ("astrometric", "apparent"):
            values = [
                bary[f"ra_icrf_{kind}_deg"],
                bary[f"dec_icrf_{kind}_deg"],
                center[f"ra_icrf_{kind}_deg"],
                center[f"dec_icrf_{kind}_deg"],
            ]
            if any(v is None for v in values):
                raise HorizonsError(f"barycenter check has n.a. cells at JD {jd!r}")
            ra1, dec1, ra2, dec2 = (float(v) for v in values if v is not None)
            entry[f"separation_{kind}_arcsec"] = round(
                angular_separation_arcsec(ra1, dec1, ra2, dec2), 6
            )
        per_epoch.append(entry)
    return {
        "observer": BARYCENTER_CHECK_OBSERVER,
        "barycenter_horizons_id": TARGET_IDS["jupiter"],
        "center_horizons_id": JUPITER_CENTER_ID,
        "note": (
            "Our 'jupiter' target is the Jupiter system barycenter (Horizons 5, D44); this "
            "records how far Horizons places the planet centre (599) from it on the sky."
        ),
        "per_epoch": per_epoch,
    }


def _rows_of(entry: Mapping[str, object]) -> list[tuple[float, dict[str, float | None]]]:
    rows = entry["rows"]
    if not isinstance(rows, list):
        raise HorizonsError("barycenter rows are not a list")
    return rows


# --------------------------------------------------------------------------------------------
# The skyfield subcommand: our own astronomy core, sampled into committed parity fixtures
# --------------------------------------------------------------------------------------------

SKYFIELD_GENERATOR = "scripts/generate_fixtures.py skyfield"
HIPPARCOS_FILENAME = "hip_main.dat"
# Sampled quantities (unit vectors, quaternions, velocities, distances, magnitudes) are rounded
# to this many significant digits: 1e-12 on a unit vector is 2e-7 arcsec, far below every parity
# tolerance, and the files stay stable across NumPy releases. TT Julian Dates are never rounded
# (12 significant digits of a JD would be a 1 s quantisation).
SIGNIFICANT_DIGITS = 12

# The parity stars (brief l.138-139, D48): a pole star, the two brightest stars, a red supergiant,
# the two largest proper motions / parallaxes, and two A/B-type reference stars.
TEST_STARS: dict[int, str] = {
    11767: "Polaris",
    32349: "Sirius",
    27989: "Betelgeuse",
    87937: "Barnard's Star",
    70890: "Proxima Centauri",
    91262: "Vega",
    65474: "Spica",
}
STAR_EPOCHS_TT: tuple[tuple[int, int, int, int], ...] = (
    (1900, 1, 1, 0),
    (1950, 1, 1, 0),
    (2000, 1, 1, 12),
    (2024, 4, 8, 18),
    (2100, 1, 1, 0),
    (2140, 12, 31, 0),
)
CATALOG_COLUMNS: tuple[str, ...] = (
    "ra_degrees",
    "dec_degrees",
    "ra_mas_per_year",
    "dec_mas_per_year",
    "parallax_mas",
    "epoch_year",
    "magnitude",
)


@dataclass(frozen=True)
class FrameWindow:
    """One `/sky/frame`-shaped window: a fixture observer, a TT start, a step and a count."""

    id: str
    observer_id: str
    tt0: tuple[int, int, int, int]
    step_s: int
    n: int


FRAME_WINDOWS: tuple[FrameWindow, ...] = (
    FrameWindow("greenwich_2024-04-08T18_300s", "greenwich", (2024, 4, 8, 18), 300, 32),
    FrameWindow("tranquility_2000-01-01T12_3600s", "tranquility", (2000, 1, 1, 12), 3600, 8),
    FrameWindow("jezero_2024-04-08T00_3600s", "jezero", (2024, 4, 8, 0), 3600, 8),
)

REFRACTION_ALT_START_DEG = -1.0
REFRACTION_ALT_STOP_DEG = 90.0
REFRACTION_ALT_STEP_DEG = 0.5
REFRACTION_ELEVATIONS_M: tuple[float, ...] = (0.0, 2850.0)


def sig(value: float) -> float:
    """Round one float to `SIGNIFICANT_DIGITS` significant digits (exact for float32 inputs)."""
    return float(f"{value:.{SIGNIFICANT_DIGITS}g}")


def sig_list(values: Sequence[object]) -> list[object]:
    """Round a (nested) list of floats as produced by `ndarray.tolist()`."""
    out: list[object] = []
    for value in values:
        if isinstance(value, list):
            out.append(sig_list(value))
        elif isinstance(value, float):
            out.append(sig(value))
        else:
            raise FixtureError(f"unexpected {type(value).__name__} in a numeric array")
    return out


def calendar_tt(epoch: tuple[int, int, int, int]) -> str:
    year, month, day, hour = epoch
    return f"{year:04d}-{month:02d}-{day:02d}T{hour:02d}:00:00"


def fixture_header(
    generated_at: str, ephemeris: str, parameters: Mapping[str, object]
) -> dict[str, object]:
    import skyfield  # lazy: `--help` and the horizons subcommand need nothing from here

    return {
        "source": f"Skyfield {skyfield.__version__} through skyapi.astro ({ephemeris})",
        "generator": SKYFIELD_GENERATOR,
        "generated_at": generated_at,
        "skyfield_version": skyfield.__version__,
        "parameters": dict(parameters),
    }


def write_fixture(path: Path, document: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # `allow_nan=False`: a NaN magnitude or direction must fail the run, not write invalid JSON.
    text = json.dumps(document, indent=2, sort_keys=True, allow_nan=False) + "\n"
    path.write_text(text, encoding="utf-8")
    print(f"wrote {path} ({len(text):,} bytes)", file=sys.stderr)


def build_star_fixture(state: object, data_dir: Path, generated_at: str) -> dict[str, object]:
    """`skyfield_stars.json`: catalog row, SKYS row and six-epoch directions per test star.

    The SKYS row is produced by the builder's own `star_table_from_hipparcos` on the selected
    rows: the rule is per star, so the values equal the full catalog build's bit for bit.
    """
    import numpy as np
    import pandas as pd
    from skyfield.positionlib import SSB

    from skyapi.astro.stars import hipparcos_star
    from skyapi.astro.state import AstroState
    from skyapi.catalogs.builders import J2000_TT, JULIAN_YEAR_DAYS, star_table_from_hipparcos
    from skyapi.catalogs.readers import read_hipparcos

    if not isinstance(state, AstroState):
        raise FixtureError("build_star_fixture needs an AstroState")
    hip_main = data_dir / HIPPARCOS_FILENAME
    if not hip_main.is_file():
        raise FixtureError(f"{hip_main} is missing: run `make data`")
    hipparcos = read_hipparcos(hip_main)
    missing = [hip for hip in TEST_STARS if hip not in hipparcos.index]
    if missing:
        raise FixtureError(f"test stars missing from {hip_main.name}: {missing}")
    table = star_table_from_hipparcos(hipparcos.loc[list(TEST_STARS)])
    ts = state.ts
    earth = state.eph["earth"]
    times = [ts.tt(*epoch) for epoch in STAR_EPOCHS_TT]
    stars: list[dict[str, object]] = []
    for hip, name in TEST_STARS.items():
        star = hipparcos_star(ts, hipparcos, hip)
        row = hipparcos.loc[hip]
        # Typing only: `hip` is the unique index of the table, so `.loc[hip]` is always a row.
        if not isinstance(row, pd.Series):
            raise FixtureError(f"HIP {hip} is not unique in {hip_main.name}")
        index = int(np.flatnonzero(table.hip == np.uint32(hip))[0])
        samples: list[dict[str, object]] = []
        for epoch, t in zip(STAR_EPOCHS_TT, times, strict=True):
            barycentric = np.asarray(SSB.at(t).observe(star).position.au, dtype=np.float64)
            apparent = np.asarray(
                earth.at(t).observe(star).apparent().position.au, dtype=np.float64
            )
            velocity = np.asarray(earth.at(t).velocity.au_per_d, dtype=np.float64)
            tt = float(t.tt)
            samples.append(
                {
                    "calendar_tt": calendar_tt(epoch),
                    "tt": tt,
                    "years_since_epoch": (tt - J2000_TT) / JULIAN_YEAR_DAYS,
                    "barycentric_dir": sig_list(
                        (barycentric / np.linalg.norm(barycentric)).tolist()
                    ),
                    "apparent_dir": sig_list((apparent / np.linalg.norm(apparent)).tolist()),
                    "earth_velocity_au_d": sig_list(velocity.tolist()),
                }
            )
        stars.append(
            {
                "hip": hip,
                "name": name,
                "catalog": {column: float(row[column]) for column in CATALOG_COLUMNS}
                | {"bv_millimag": int(row["bv_millimag"])},
                "skys": {
                    "dir": sig_list(table.dir[index].astype(np.float64).tolist()),
                    "pm": sig_list(table.pm[index].astype(np.float64).tolist()),
                    "mag_millimag": int(table.mag[index]),
                    "bv_millimag": int(table.bv[index]),
                },
                "samples": samples,
            }
        )
    header = fixture_header(
        generated_at,
        state.ephemeris_name,
        {
            "hipparcos": HIPPARCOS_FILENAME,
            "skys_epoch_tt": J2000_TT,
            "epochs_tt": [calendar_tt(epoch) for epoch in STAR_EPOCHS_TT],
            "barycentric_dir": "SSB.at(t).observe(star), normalised (parallax ignored)",
            "apparent_dir": "earth.at(t).observe(star).apparent(), normalised (geocentric)",
            "earth_velocity_au_d": "earth.at(t).velocity.au_per_d (barycentric)",
            "skys_rule": "dir = p0/|p0|, pm = (p1 - p0)/|p0| per Julian year, float32 (D48)",
            "significant_digits": SIGNIFICANT_DIGITS,
        },
    )
    return {**header, "stars": stars}


def build_frames_fixture(state: object, generated_at: str) -> dict[str, object]:
    """`skyfield_frames.json`: the `/sky/frame` quantities of three windows, one per body kind."""
    import numpy as np

    from skyapi.astro import bodies, horizon
    from skyapi.astro.observers import build_observer
    from skyapi.astro.state import AstroState
    from skyapi.astro.time import make_times

    if not isinstance(state, AstroState):
        raise FixtureError("build_frames_fixture needs an AstroState")
    ts = state.ts
    windows: list[dict[str, object]] = []
    for spec in FRAME_WINDOWS:
        site = OBSERVERS_BY_ID[spec.observer_id]
        observer = build_observer(state, site.body, site.lat_deg, site.lon_deg_east, site.elev_m)
        tt0 = float(ts.tt(*spec.tt0).tt)
        t = make_times(ts, tt0, spec.step_s, spec.n)
        body_ids = [body_id for body_id in bodies.BODY_IDS if body_id != site.body]
        samples = bodies.body_samples(state, observer, t, body_ids)
        windows.append(
            {
                "id": spec.id,
                "observer": site.body,
                "site": {
                    "id": site.id,
                    "lat_deg": site.lat_deg,
                    "lon_deg": site.lon_deg_east,
                    "elev_m": site.elev_m,
                    "frame_name": observer.spec.frame_name,
                    "latitude_kind": observer.spec.latitude_kind,
                },
                "tt0": tt0,
                "calendar_tt0": calendar_tt(spec.tt0),
                "step_s": spec.step_s,
                "n": spec.n,
                # `Time.tt` is typed float-or-array; the window always holds `n` samples.
                "tt": [float(value) for value in np.atleast_1d(np.asarray(t.tt, dtype=np.float64))],
                "horizon_q": sig_list(horizon.horizon_quaternions(observer, t).tolist()),
                "equinox_q": sig_list(horizon.equinox_of_date_quaternions(t).tolist()),
                "observer_velocity_au_d": sig_list(
                    horizon.observer_velocity_au_d(observer, t).tolist()
                ),
                "sun_dir": sig_list(bodies.sun_direction(state, observer, t).tolist()),
                "bodies": {
                    body_id: {
                        "dir": sig_list(sample.dir.tolist()),
                        "dist_au": sig_list(sample.dist_au.tolist()),
                        "mag": sig_list(sample.mag.tolist()),
                        "phase": sig_list(sample.phase.tolist()),
                        "diam_deg": sig_list(sample.diam_deg.tolist()),
                    }
                    for body_id, sample in samples.items()
                },
            }
        )
    header = fixture_header(
        generated_at,
        state.ephemeris_name,
        {
            "kernels": [
                state.ephemeris_name,
                "pck00011.tpc",
                "moon_de440_250416.tf",
                "moon_pa_de440_200625.bpc",
            ],
            "quaternion_layout": "[x, y, z, w], Hamilton, ICRF -> ENU (horizon_q) and ICRF -> "
            "true equator and equinox of date (equinox_q), sign-continuous along the window",
            "dir": "apparent ICRF unit vectors (light-time, aberration, deflection)",
            "significant_digits": SIGNIFICANT_DIGITS,
            "tt": "exact TT Julian Dates (not rounded)",
        },
    )
    return {**header, "windows": windows}


def build_refraction_fixture(state: object, generated_at: str) -> dict[str, object]:
    """`skyfield_refraction.json`: Skyfield's standard-atmosphere true -> apparent altitude."""
    from skyapi.astro.refraction import (
        STANDARD_TEMPERATURE_C,
        refraction_table,
        standard_pressure_mbar,
    )
    from skyapi.astro.state import AstroState

    if not isinstance(state, AstroState):
        raise FixtureError("build_refraction_fixture needs an AstroState")
    count = round((REFRACTION_ALT_STOP_DEG - REFRACTION_ALT_START_DEG) / REFRACTION_ALT_STEP_DEG)
    alts = [REFRACTION_ALT_START_DEG + i * REFRACTION_ALT_STEP_DEG for i in range(count + 1)]
    tables = [
        {
            "elevation_m": elevation,
            "temperature_c": STANDARD_TEMPERATURE_C,
            "pressure_mbar": standard_pressure_mbar(elevation),
            "rows": [
                [alt_true, alt_apparent]
                for alt_true, alt_apparent in refraction_table(alts, elevation)
            ],
        }
        for elevation in REFRACTION_ELEVATIONS_M
    ]
    header = fixture_header(
        generated_at,
        state.ephemeris_name,
        {
            "model": "skyfield.earthlib.refract (Bennett 1982, inverted from the true altitude),"
            " 10 C and 1010 exp(-elevation_m / 9100) mbar, zero below -1 and above 89.9 deg",
            "alt_true_deg": {
                "start": REFRACTION_ALT_START_DEG,
                "stop": REFRACTION_ALT_STOP_DEG,
                "step": REFRACTION_ALT_STEP_DEG,
            },
            "elevations_m": list(REFRACTION_ELEVATIONS_M),
            "rows": "[alt_true_deg, alt_apparent_deg], full precision (not rounded)",
        },
    )
    return {**header, "tables": tables}


def run_skyfield(args: argparse.Namespace) -> int:
    from skyapi.astro.loader import MissingDataError, kernel_paths, load_astro_state

    data_dir: Path = args.data_dir
    out_dir: Path = args.out_dir
    ephemeris: str = args.ephemeris
    try:
        state = load_astro_state(kernel_paths(data_dir, ephemeris))
    except MissingDataError as exc:
        raise FixtureError(f"cannot open the kernel set in {data_dir}: {exc}") from exc
    try:
        if state.moon_frame is None:
            raise FixtureError(f"the two Moon kernels are missing from {data_dir}: run `make data`")
        generated_at = utc_now_iso()
        write_fixture(
            out_dir / "skyfield_stars.json", build_star_fixture(state, data_dir, generated_at)
        )
        write_fixture(out_dir / "skyfield_frames.json", build_frames_fixture(state, generated_at))
        write_fixture(
            out_dir / "skyfield_refraction.json", build_refraction_fixture(state, generated_at)
        )
    finally:
        state.close()
    return 0


# --------------------------------------------------------------------------------------------
# The orientation subcommand (plan D133)
# --------------------------------------------------------------------------------------------
#
# An independent, plain-Python implementation of the W3C Device Orientation rotation matrix
# (Appendix A ``getRotationMatrix``: ``R = Rz(alpha) Rx(beta) Ry(gamma)``, intrinsic Z-X'-Y''),
# the screen fold of the Screen Orientation API (``angle`` counter-clockwise from the natural
# orientation, so the page frame is the device frame turned back by it) and the view rule the
# frontend mirrors in ``sky/math/orientation.ts``: the rear camera looks along device ``-z``,
# the page top is device ``+y``, ``alt = asin(f_U)``, ``az = atan2(f_E, f_N)``, ``roll =
# atan2(u . right0, u . up0)`` with the no-roll basis of ``frames.ts`` (right-handed about the
# view axis, positive when the screen top leans to the user's right); inside the gimbal band
# ``|alt| >= 89.99`` the roll is 0 and the azimuth is the heading of the screen top (nadir) or
# that heading plus 180 (zenith). Earth frame ``[E, N, U]`` (the spec's X East, Y North, Z Up).
# The iOS compass correction rotates the DEVICE rotation about Up (its axes are device axes) and
# the screen fold comes after it. Offline, seeded, no ``--data-dir``: the closed-form poses carry
# hand-derived expectations that the generator re-checks against the matrix before writing
# anything.

ORIENTATION_GENERATOR = "scripts/generate_fixtures.py orientation"
DEFAULT_ORIENTATION_OUT = DEFAULT_FIXTURES_DIR / "device_orientation_cases.json"
ORIENTATION_SEED = 20260917
ORIENTATION_ROUND_TRIPS = 200
ORIENTATION_COMPASS_CASES = 40
# frames.ts MAX_CAMERA_ALT_DEG: the store clamps the camera there, the view rule switches there.
GIMBAL_ALT_DEG = 89.99
CLOSED_FORM_TOLERANCE_DEG = 1e-9
ROUND_TRIP_TOLERANCE_DEG = 1e-7
# Generator self-checks (hand expectation vs matrix; recomposed Euler vs source matrix).
SELF_CHECK_TOLERANCE = 1e-10
# Decomposed Euler angles are rounded to this many decimals (readable fixtures, 1e-12 degrees).
EULER_DECIMALS = 12
# The screen top must have this much horizontal component for a compass case (the heading of a
# nearly vertical axis is ill-conditioned, and CoreLocation's behaviour there is R74).
COMPASS_MIN_HORIZONTAL = 0.1
SQRT_HALF = math.sqrt(0.5)

Vec = tuple[float, float, float]
Mat = tuple[Vec, Vec, Vec]


def _rot_x(deg: float) -> Mat:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return ((1.0, 0.0, 0.0), (0.0, c, -s), (0.0, s, c))


def _rot_y(deg: float) -> Mat:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return ((c, 0.0, s), (0.0, 1.0, 0.0), (-s, 0.0, c))


def _rot_z(deg: float) -> Mat:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return ((c, -s, 0.0), (s, c, 0.0), (0.0, 0.0, 1.0))


def _mat_mul(a: Mat, b: Mat) -> Mat:
    rows: list[Vec] = []
    for i in range(3):
        rows.append(
            (
                a[i][0] * b[0][0] + a[i][1] * b[1][0] + a[i][2] * b[2][0],
                a[i][0] * b[0][1] + a[i][1] * b[1][1] + a[i][2] * b[2][1],
                a[i][0] * b[0][2] + a[i][1] * b[1][2] + a[i][2] * b[2][2],
            )
        )
    return (rows[0], rows[1], rows[2])


def _mat_vec(m: Mat, v: Vec) -> Vec:
    return (
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    )


def _columns(x: Vec, y: Vec, z: Vec) -> Mat:
    """The matrix whose columns are the images of the device axes ``x``, ``y``, ``z``."""
    return ((x[0], y[0], z[0]), (x[1], y[1], z[1]), (x[2], y[2], z[2]))


def _cross(a: Vec, b: Vec) -> Vec:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _wrap_360(deg: float) -> float:
    wrapped = deg - 360.0 * math.floor(deg / 360.0)
    return 0.0 if wrapped >= 360.0 or wrapped <= 0.0 else wrapped


def _wrap_signed_upper(deg: float) -> float:
    """Wrap into ``(-180, 180]`` (the roll and the yaw correction of ``orientation.ts``)."""
    return 180.0 - _wrap_360(180.0 - deg)


def _wrap_signed_lower(deg: float) -> float:
    """Wrap into ``[-180, 180)`` (the W3C ``beta`` range)."""
    return _wrap_360(deg + 180.0) - 180.0


def _azimuth_deg(e: float, n: float) -> float:
    return _wrap_360(math.degrees(math.atan2(e, n)))


def w3c_rotation_matrix(alpha_deg: float, beta_deg: float, gamma_deg: float) -> Mat:
    """Appendix A ``getRotationMatrix`` of the W3C Device Orientation spec, entry by entry."""
    x, y, z = math.radians(beta_deg), math.radians(gamma_deg), math.radians(alpha_deg)
    c_x, c_y, c_z = math.cos(x), math.cos(y), math.cos(z)
    s_x, s_y, s_z = math.sin(x), math.sin(y), math.sin(z)
    return (
        (c_z * c_y - s_z * s_x * s_y, -c_x * s_z, c_y * s_z * s_x + c_z * s_y),
        (c_y * s_z + c_z * s_x * s_y, c_z * c_x, s_z * s_y - c_z * c_y * s_x),
        (-c_x * s_y, s_x, c_x * c_y),
    )


def page_matrix(
    alpha_deg: float, beta_deg: float, gamma_deg: float, screen_angle_deg: float
) -> Mat:
    """Device rotation with the screen fold: ``R Rz(-angle)`` maps page axes to ENU."""
    return _mat_mul(w3c_rotation_matrix(alpha_deg, beta_deg, gamma_deg), _rot_z(-screen_angle_deg))


def euler_from_matrix(r: Mat) -> tuple[float, float, float]:
    """The W3C triple (alpha [0, 360), beta [-180, 180), gamma [-90, 90)) of a rotation matrix.

    From the spec matrix: ``R[2][1] = sin beta``, ``R[2][0] = -cos beta sin gamma``, ``R[2][2] =
    cos beta cos gamma``, ``R[0][1] = -cos beta sin alpha``, ``R[1][1] = cos beta cos alpha``. The
    sign of ``cos beta`` is chosen so that ``cos gamma >= 0``; on the ``cos gamma = 0`` seam
    ``gamma = -90`` is taken (90 is outside the range). At ``cos beta = 0`` (the phone exactly
    upright) only ``alpha + gamma`` (beta 90) or ``alpha - gamma`` (beta -90) is determined and
    ``gamma = 0`` is written.
    """
    s_x = r[2][1]
    norm = math.hypot(r[2][0], r[2][2])
    if norm < 1e-12:
        beta = 90.0 if s_x > 0 else -90.0
        alpha = _wrap_360(math.degrees(math.atan2(r[1][0], r[0][0])))
        return alpha, beta, 0.0
    sign = 1.0 if r[2][2] > 1e-12 else (-1.0 if r[2][2] < -1e-12 else math.copysign(1.0, r[2][0]))
    beta = math.degrees(math.atan2(s_x, sign * norm))
    gamma = math.degrees(math.atan2(-r[2][0] * sign, r[2][2] * sign))
    alpha = math.degrees(math.atan2(-r[0][1] * sign, r[1][1] * sign))
    return _wrap_360(alpha), _wrap_signed_lower(beta), gamma


def rounded_euler(r: Mat) -> tuple[float, float, float]:
    """Decompose, round to ``EULER_DECIMALS`` and check that the triple recomposes to ``r``."""
    alpha, beta, gamma = (round(v, EULER_DECIMALS) for v in euler_from_matrix(r))
    if gamma >= 90.0:
        raise FixtureError(f"gamma {gamma} left the W3C range after rounding")
    back = w3c_rotation_matrix(alpha, beta, gamma)
    error = max(abs(back[i][j] - r[i][j]) for i in range(3) for j in range(3))
    if error > SELF_CHECK_TOLERANCE:
        raise FixtureError(f"Euler decomposition does not recompose (error {error:.3e})")
    return alpha, beta, gamma


@dataclass(frozen=True)
class ViewPose:
    forward: Vec
    up: Vec
    az: float
    alt: float
    roll: float


def view_from_page_matrix(m: Mat) -> ViewPose:
    """The frontend's view rule on a page -> ENU matrix (``orientation.ts::viewFromPose``)."""
    forward = _mat_vec(m, (0.0, 0.0, -1.0))
    up = _mat_vec(m, (0.0, 1.0, 0.0))
    alt = math.degrees(math.asin(max(-1.0, min(1.0, forward[2]))))
    if abs(alt) >= GIMBAL_ALT_DEG:
        top_az = _azimuth_deg(up[0], up[1])
        az = _wrap_360(top_az + 180.0) if alt > 0 else top_az
        return ViewPose(forward, up, az, alt, 0.0)
    az = _azimuth_deg(forward[0], forward[1])
    a = math.radians(az)
    right0: Vec = (math.cos(a), -math.sin(a), 0.0)
    up0 = _cross(right0, forward)
    roll = _wrap_signed_upper(math.degrees(math.atan2(_dot(up, right0), _dot(up, up0))))
    return ViewPose(forward, up, az, alt, roll)


def page_basis(az_deg: float, alt_deg: float, roll_deg: float) -> Mat:
    """The page -> ENU matrix of a camera pose: columns right, up, ``-forward`` (device z)."""
    alt, az, roll = math.radians(alt_deg), math.radians(az_deg), math.radians(roll_deg)
    forward: Vec = (math.cos(alt) * math.sin(az), math.cos(alt) * math.cos(az), math.sin(alt))
    right0: Vec = (math.cos(az), -math.sin(az), 0.0)
    up0 = _cross(right0, forward)
    c, s = math.cos(roll), math.sin(roll)
    right: Vec = (
        right0[0] * c - up0[0] * s,
        right0[1] * c - up0[1] * s,
        right0[2] * c - up0[2] * s,
    )
    up: Vec = (up0[0] * c + right0[0] * s, up0[1] * c + right0[1] * s, up0[2] * c + right0[2] * s)
    return _columns(right, up, (-forward[0], -forward[1], -forward[2]))


def _angle_error(a: float, b: float) -> float:
    """Distance between two angles in degrees, modulo 360."""
    return abs(_wrap_signed_lower(a - b))


def _check_pose(case_id: str, computed: ViewPose, expected: ViewPose) -> None:
    errors = [abs(computed.forward[i] - expected.forward[i]) for i in range(3)] + [
        abs(computed.up[i] - expected.up[i]) for i in range(3)
    ]
    errors += [
        _angle_error(computed.az, expected.az),
        abs(computed.alt - expected.alt),
        _angle_error(computed.roll, expected.roll),
    ]
    worst = max(errors)
    if worst > SELF_CHECK_TOLERANCE:
        raise FixtureError(f"closed-form case {case_id}: hand expectation off by {worst:.3e}")


def _case_document(
    case_id: str,
    euler: tuple[float, float, float],
    screen_angle: float,
    expected: ViewPose,
    note: str,
) -> dict[str, object]:
    computed = view_from_page_matrix(page_matrix(*euler, screen_angle))
    _check_pose(case_id, computed, expected)
    return {
        "id": case_id,
        "alpha": euler[0],
        "beta": euler[1],
        "gamma": euler[2],
        "screen_angle": screen_angle,
        "forward_enu": list(expected.forward),
        "up_enu": list(expected.up),
        "az": expected.az,
        "alt": expected.alt,
        "roll": expected.roll,
        "tolerance_deg": CLOSED_FORM_TOLERANCE_DEG,
        "note": note,
    }


def case_from_euler(
    case_id: str,
    euler: tuple[float, float, float],
    screen_angle: float,
    expected: ViewPose,
    note: str,
) -> dict[str, object]:
    return _case_document(case_id, euler, screen_angle, expected, note)


def case_from_matrix(
    case_id: str, device: Mat, screen_angle: float, expected: ViewPose, note: str
) -> dict[str, object]:
    """A pose built by composing elementary rotations; the W3C triple comes from decomposition."""
    return _case_document(case_id, rounded_euler(device), screen_angle, expected, note)


UP: Vec = (0.0, 0.0, 1.0)
DOWN: Vec = (0.0, 0.0, -1.0)
NORTH: Vec = (0.0, 1.0, 0.0)
EAST: Vec = (1.0, 0.0, 0.0)
SOUTH: Vec = (0.0, -1.0, 0.0)
WEST: Vec = (-1.0, 0.0, 0.0)
CARDINALS: tuple[tuple[str, float, Vec], ...] = (
    ("north", 0.0, NORTH),
    ("east", 90.0, EAST),
    ("south", 180.0, SOUTH),
    ("west", 270.0, WEST),
)


def closed_form_cases() -> list[dict[str, object]]:
    cases: list[dict[str, object]] = []
    # 1. The spec's worked examples (A.1, "held vertical" and "top of the screen to the right").
    cases.append(
        case_from_euler(
            "spec-flat-top-west",
            (90.0, 0.0, 0.0),
            0.0,
            ViewPose(DOWN, WEST, 270.0, -90.0, 0.0),
            "W3C A.1: device flat, top pointing west, alpha 90 -> compass heading 270",
        )
    )
    cases.append(
        case_from_euler(
            "spec-upright-north",
            (0.0, 90.0, 0.0),
            0.0,
            ViewPose(NORTH, UP, 0.0, 0.0, 0.0),
            "W3C: held vertical, top up, beta 90; the rear camera looks north",
        )
    )
    cases.append(
        case_from_euler(
            "spec-upright-east",
            (270.0, 90.0, 0.0),
            0.0,
            ViewPose(EAST, UP, 90.0, 0.0, 0.0),
            "W3C alpha is counter-clockwise from above: 270 turns the camera to the east",
        )
    )
    # "A user facing a compass heading of alpha degrees ... top of the screen pointing to their
    # right": {270 - alpha, 0, 90}, read with screen.orientation.angle 270 (turned clockwise).
    heading = 200.0
    cases.append(
        case_from_euler(
            "spec-landscape-top-right-heading200",
            (270.0 - heading, 0.0, 90.0),
            270.0,
            ViewPose(
                (math.sin(math.radians(heading)), math.cos(math.radians(heading)), 0.0),
                UP,
                heading,
                0.0,
                0.0,
            ),
            "W3C: heading alpha with the screen top to the right is {270 - alpha, 0, 90}; the"
            " fold (angle 270) brings the page top back up, az = heading",
        )
    )
    # 2. Cardinal uprights (alpha = 360 - az, beta 90) and flat poses with the top at each point.
    for name, az, direction in CARDINALS:
        alpha = _wrap_360(360.0 - az)
        cases.append(
            case_from_euler(
                f"upright-{name}",
                (alpha, 90.0, 0.0),
                0.0,
                ViewPose(direction, UP, az, 0.0, 0.0),
                "upright portrait, camera horizontal",
            )
        )
        cases.append(
            case_from_euler(
                f"nadir-top-{name}",
                (alpha, 0.0, 0.0),
                0.0,
                ViewPose(DOWN, direction, az, -90.0, 0.0),
                "flat, screen up: the camera looks at the ground, az = heading of the screen top",
            )
        )
        # Screen down = Rx(180), which sends the device top to the south; Rz(180 - az) then
        # turns it toward `direction`.
        alpha_zenith = _wrap_360(180.0 - az)
        cases.append(
            case_from_matrix(
                f"zenith-top-{name}",
                _mat_mul(_rot_z(alpha_zenith), _rot_x(180.0)),
                0.0,
                ViewPose(UP, direction, _wrap_360(az + 180.0), 90.0, 0.0),
                "screen down: the camera looks at the zenith, az = heading of the top + 180",
            )
        )
    # 3. Landscapes: device turned counter-clockwise (right edge up) or clockwise (left edge up),
    #    read with the matching screen angle and with none (the roll then shows the raw turn).
    ccw = w3c_rotation_matrix(90.0, 0.0, -90.0)
    cw = _mat_mul(_rot_z(270.0), _rot_y(90.0))
    cases.append(
        case_from_euler(
            "landscape-ccw-north-angle90",
            (90.0, 0.0, -90.0),
            90.0,
            ViewPose(NORTH, UP, 0.0, 0.0, 0.0),
            "turned counter-clockwise, screen.orientation.angle 90 folds the page top back up",
        )
    )
    cases.append(
        case_from_euler(
            "landscape-ccw-north-angle0",
            (90.0, 0.0, -90.0),
            0.0,
            ViewPose(NORTH, WEST, 0.0, 0.0, -90.0),
            "the same device pose read without the screen fold: the device top points west",
        )
    )
    cases.append(
        case_from_matrix(
            "landscape-cw-north-angle270",
            cw,
            270.0,
            ViewPose(NORTH, UP, 0.0, 0.0, 0.0),
            "turned clockwise (angle 270 counter-clockwise); W3C triple on the gamma = -90 seam",
        )
    )
    cases.append(
        case_from_matrix(
            "landscape-cw-north-angle0",
            cw,
            0.0,
            ViewPose(NORTH, EAST, 0.0, 0.0, 90.0),
            "the same pose without the fold: the device top points east, roll +90",
        )
    )
    cases.append(
        case_from_euler(
            "landscape-cw-north-raw-gamma90",
            (270.0, 0.0, 90.0),
            270.0,
            ViewPose(NORTH, UP, 0.0, 0.0, 0.0),
            "the out-of-range twin of landscape-cw-north-angle270 (gamma 90): same rotation",
        )
    )
    cases.append(
        case_from_euler(
            "landscape-ccw-east-angle90",
            (0.0, 0.0, -90.0),
            90.0,
            ViewPose(EAST, UP, 90.0, 0.0, 0.0),
            "turned counter-clockwise facing east, the fold applied",
        )
    )
    if view_from_page_matrix(ccw).roll != -90.0:
        raise FixtureError("landscape sanity check failed")
    # 4. Rolls about the view axis of the upright phone facing north: an intrinsic rotation about
    #    device z by -roll (the view axis is -z), so Rx(90) Rz(-roll).
    for roll in (30.0, -30.0, 90.0, -90.0):
        r = math.radians(roll)
        cases.append(
            case_from_matrix(
                f"upright-north-roll{roll:+.0f}",
                _mat_mul(_rot_x(90.0), _rot_z(-roll)),
                0.0,
                ViewPose(NORTH, (math.sin(r), 0.0, math.cos(r)), 0.0, 0.0, roll),
                "screen top leaning to the user's right for a positive roll",
            )
        )
    # 5. 45 degree tilts.
    cases.append(
        case_from_euler(
            "tilt-north-down45",
            (0.0, 45.0, 0.0),
            0.0,
            ViewPose((0.0, SQRT_HALF, -SQRT_HALF), (0.0, SQRT_HALF, SQRT_HALF), 0.0, -45.0, 0.0),
            "half way between flat and upright: the camera looks 45 degrees down",
        )
    )
    cases.append(
        case_from_euler(
            "tilt-north-up45",
            (0.0, 135.0, 0.0),
            0.0,
            ViewPose((0.0, SQRT_HALF, SQRT_HALF), (0.0, -SQRT_HALF, SQRT_HALF), 0.0, 45.0, 0.0),
            "leaning back: the camera looks 45 degrees up",
        )
    )
    cases.append(
        case_from_euler(
            "tilt-east-up45",
            (270.0, 135.0, 0.0),
            0.0,
            ViewPose((SQRT_HALF, 0.0, SQRT_HALF), (-SQRT_HALF, 0.0, SQRT_HALF), 90.0, 45.0, 0.0),
            "leaning back facing east",
        )
    )
    cases.append(
        case_from_euler(
            "upright-gamma-yaw45",
            (0.0, 90.0, 45.0),
            0.0,
            ViewPose((-SQRT_HALF, SQRT_HALF, 0.0), UP, 315.0, 0.0, 0.0),
            "at beta 90 gamma turns about the vertical: Rx(90) Ry(g) = Rz(g) Rx(90)",
        )
    )
    cos30, sin30 = math.cos(math.radians(30.0)), math.sin(math.radians(30.0))
    cases.append(
        case_from_matrix(
            "tilt-north-up45-roll+30",
            _mat_mul(_rot_x(135.0), _rot_z(-30.0)),
            0.0,
            ViewPose(
                (0.0, SQRT_HALF, SQRT_HALF),
                (sin30, -cos30 * SQRT_HALF, cos30 * SQRT_HALF),
                0.0,
                45.0,
                30.0,
            ),
            "leaning back 45 degrees with the top leaning 30 degrees to the right",
        )
    )
    return cases


def round_trip_cases(rng: random.Random) -> list[dict[str, object]]:
    """Random camera poses -> W3C triple -> the same pose (``|alt| <= 89``, every screen angle)."""
    cases: list[dict[str, object]] = []
    for index in range(ORIENTATION_ROUND_TRIPS):
        az = 360.0 * rng.random()
        alt = -89.0 + 178.0 * rng.random()
        roll = -180.0 + 360.0 * rng.random()
        screen_angle = 90.0 * float(int(4 * rng.random()) % 4)
        device = _mat_mul(page_basis(az, alt, roll), _rot_z(screen_angle))
        euler = rounded_euler(device)
        computed = view_from_page_matrix(page_matrix(*euler, screen_angle))
        worst = max(
            _angle_error(computed.az, az),
            abs(computed.alt - alt),
            _angle_error(computed.roll, roll),
        )
        if worst > SELF_CHECK_TOLERANCE * 1e3:
            raise FixtureError(f"round trip {index}: {worst:.3e} degrees")
        cases.append(
            {
                "alpha": euler[0],
                "beta": euler[1],
                "gamma": euler[2],
                "screen_angle": screen_angle,
                "az": az,
                "alt": alt,
                "roll": roll,
                "tolerance_deg": ROUND_TRIP_TOLERANCE_DEG,
            }
        )
    return cases


def compass_cases(rng: random.Random) -> list[dict[str, object]]:
    """A true pose seen through an arbitrary yaw (iOS relative alpha) at a random screen angle,
    plus the compass heading of the device top (CoreLocation's default axis) and of the rear
    axis; the expected view is the true pose once the correction ``qz(heading(axis) - compass)``
    is applied to the DEVICE rotation, before the screen fold: the compass axes are device axes,
    so the headings come from the true device matrix and a correction applied after the fold
    would be wrong whenever ``screen_angle != 0``."""
    cases: list[dict[str, object]] = []
    while len(cases) < ORIENTATION_COMPASS_CASES:
        az = 360.0 * rng.random()
        alt = -80.0 + 160.0 * rng.random()
        roll = -180.0 + 360.0 * rng.random()
        yaw_offset = 360.0 * rng.random()
        screen_angle = 90.0 * float(int(4 * rng.random()) % 4)
        true_device = _mat_mul(page_basis(az, alt, roll), _rot_z(screen_angle))
        top = _mat_vec(true_device, (0.0, 1.0, 0.0))
        back = _mat_vec(true_device, (0.0, 0.0, -1.0))
        if math.hypot(top[0], top[1]) < COMPASS_MIN_HORIZONTAL:
            continue
        heading_top = _azimuth_deg(top[0], top[1])
        heading_back = _azimuth_deg(back[0], back[1])
        relative = _mat_mul(_rot_z(yaw_offset), true_device)
        euler = rounded_euler(relative)
        for axis, heading in (((0.0, 1.0, 0.0), heading_top), ((0.0, 0.0, -1.0), heading_back)):
            rel = w3c_rotation_matrix(*euler)
            rotated = _mat_vec(rel, axis)
            correction = _azimuth_deg(rotated[0], rotated[1]) - heading
            corrected_device = _mat_mul(_rot_z(correction), rel)
            computed = view_from_page_matrix(_mat_mul(corrected_device, _rot_z(-screen_angle)))
            worst = max(
                _angle_error(computed.az, az),
                abs(computed.alt - alt),
                _angle_error(computed.roll, roll),
            )
            if worst > SELF_CHECK_TOLERANCE * 1e3:
                raise FixtureError(f"compass case {len(cases)}: {worst:.3e} degrees")
        cases.append(
            {
                "alpha_rel": euler[0],
                "beta": euler[1],
                "gamma": euler[2],
                "screen_angle": screen_angle,
                "yaw_offset_deg": yaw_offset,
                "compass_heading_top": heading_top,
                "compass_heading_back": heading_back,
                "az": az,
                "alt": alt,
                "roll": roll,
                "tolerance_deg": ROUND_TRIP_TOLERANCE_DEG,
            }
        )
    return cases


def gimbal_rows() -> list[dict[str, object]]:
    """Approaches to the nadir (beta from 0) and the zenith (beta from 180) for two headings: the
    rows inside the band (|alt| >= 89.99) use the screen-top rule, the others the general rule,
    and the sequence must be continuous."""
    rows: list[dict[str, object]] = []
    for alpha in (0.0, 90.0):
        for region, betas in (
            ("nadir", (0.0, 0.005, 0.02, 0.5)),
            ("zenith", (180.0, 179.995, 179.98, 179.5)),
        ):
            for beta in betas:
                # 180 is outside the W3C range and becomes -180; the others are written as is.
                beta_w3c = beta if beta < 180.0 else _wrap_signed_lower(beta)
                pose = view_from_page_matrix(page_matrix(alpha, beta_w3c, 0.0, 0.0))
                rows.append(
                    {
                        "region": region,
                        "alpha": alpha,
                        "beta": beta_w3c,
                        "gamma": 0.0,
                        "screen_angle": 0.0,
                        "in_band": abs(pose.alt) >= GIMBAL_ALT_DEG,
                        "az": pose.az,
                        "alt": pose.alt,
                        "roll": pose.roll,
                        "tolerance_deg": CLOSED_FORM_TOLERANCE_DEG,
                    }
                )
    return rows


def _check_matrix_against_product(rng: random.Random) -> None:
    """The transcribed spec matrix equals ``Rz(alpha) Rx(beta) Ry(gamma)`` (generator self-test)."""
    for _ in range(500):
        alpha, beta, gamma = (
            360.0 * rng.random(),
            -180.0 + 360.0 * rng.random(),
            -90.0 + 180.0 * rng.random(),
        )
        spec = w3c_rotation_matrix(alpha, beta, gamma)
        product = _mat_mul(_mat_mul(_rot_z(alpha), _rot_x(beta)), _rot_y(gamma))
        error = max(abs(spec[i][j] - product[i][j]) for i in range(3) for j in range(3))
        if error > 1e-12:
            raise FixtureError(f"spec matrix differs from the rotation product by {error:.3e}")


def build_orientation_fixture(generated_at: str) -> dict[str, object]:
    rng = random.Random(ORIENTATION_SEED)
    _check_matrix_against_product(rng)
    return {
        "source": (
            "W3C Device Orientation and Motion (Appendix A worked example and getRotationMatrix,"
            " R = Rz(alpha) Rx(beta) Ry(gamma)), W3C Screen Orientation (angle counter-clockwise"
            " from natural); geometric construction of the expected poses"
        ),
        "generator": ORIENTATION_GENERATOR,
        "generated_at": generated_at,
        "parameters": {
            "seed": ORIENTATION_SEED,
            "round_trips": ORIENTATION_ROUND_TRIPS,
            "compass_cases": ORIENTATION_COMPASS_CASES,
            "gimbal_alt_deg": GIMBAL_ALT_DEG,
            "closed_form_tolerance_deg": CLOSED_FORM_TOLERANCE_DEG,
            "round_trip_tolerance_deg": ROUND_TRIP_TOLERANCE_DEG,
            "euler_decimals": EULER_DECIMALS,
        },
        "conventions": {
            "device": "x right, y top, z out of the screen; the rear camera looks along -z",
            "earth": "[E, N, U]; azimuth from north through east",
            "screen_angle": (
                "screen.orientation.angle, counter-clockwise from natural;"
                " page = device turned back by it"
            ),
            "roll": (
                "right-handed about the view axis, positive when the screen top leans to the"
                " user's right, (-180, 180]"
            ),
            "gimbal": (
                "|alt| >= 89.99: roll 0, az = heading of the screen top (nadir)"
                " or heading + 180 (zenith)"
            ),
        },
        "cases": closed_form_cases(),
        "round_trips": round_trip_cases(rng),
        "compass_cases": compass_cases(rng),
        "gimbal_rows": gimbal_rows(),
    }


def run_orientation(args: argparse.Namespace) -> int:
    out: Path = args.out
    write_fixture(out, build_orientation_fixture(utc_now_iso()))
    return 0


# CLI
# --------------------------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="generate_fixtures.py",
        description="Generate the conformance fixtures under backend/tests/fixtures/.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    horizons = subparsers.add_parser(
        "horizons",
        help="fetch JPL Horizons reference values (network; manual; refuses to run when CI is set)",
    )
    horizons.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output JSON path")
    horizons.add_argument(
        "--probe",
        action="store_true",
        help="send a single request (jezero -> Sun, 2000-01-01T12 TT), print the raw header, exit",
    )
    horizons.add_argument(
        "--pause",
        type=float,
        default=DEFAULT_PAUSE_S,
        help=f"seconds between requests (default {DEFAULT_PAUSE_S}; fair-use minimum 1.5)",
    )
    horizons.add_argument(
        "--raw-dir",
        type=Path,
        default=None,
        help="directory that receives every raw response (never committed)",
    )
    horizons.add_argument(
        "--reuse-raw",
        action="store_true",
        help="parse a response already saved in --raw-dir instead of requesting it again",
    )
    horizons.add_argument(
        "--pck",
        type=Path,
        default=DEFAULT_PCK,
        help="text PCK with BODY301_RADII and BODY499_RADII (default data/pck00011.tpc)",
    )
    horizons.set_defaults(handler=run_horizons)

    skyfield = subparsers.add_parser(
        "skyfield",
        help="write the Skyfield parity fixtures from skyapi.astro (local, deterministic)",
    )
    skyfield.add_argument(
        "--data-dir",
        type=Path,
        default=DEFAULT_DATA_DIR,
        help="directory holding the kernel set and hip_main.dat (default data/)",
    )
    skyfield.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_FIXTURES_DIR,
        help="directory that receives skyfield_*.json (default backend/tests/fixtures/)",
    )
    skyfield.add_argument(
        "--ephemeris", default="de440s.bsp", help="ephemeris file name (default de440s.bsp)"
    )
    skyfield.set_defaults(handler=run_skyfield)

    orientation = subparsers.add_parser(
        "orientation",
        help="write the device-orientation fixture from the W3C matrix (offline, seeded)",
    )
    orientation.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_ORIENTATION_OUT,
        help="output JSON path (default backend/tests/fixtures/device_orientation_cases.json)",
    )
    orientation.set_defaults(handler=run_orientation)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "horizons" and args.pause < DEFAULT_PAUSE_S:
        print(f"--pause must be at least {DEFAULT_PAUSE_S} s (fair-use policy)", file=sys.stderr)
        return 2
    try:
        return int(args.handler(args))
    except FixtureError as exc:
        print(f"generate_fixtures: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
