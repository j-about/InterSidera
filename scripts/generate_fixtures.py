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

Reference values: JPL Horizons, Solar System Dynamics Group, https://ssd.jpl.nasa.gov/horizons/
(US Government work, public domain).
"""

from __future__ import annotations

import argparse
import json
import math
import os
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
                "tt": [float(value) for value in t.tt],
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
