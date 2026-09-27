"""Latency benchmark of the InterSidera API against a running server (decision D67).

Measures the budgets of ``docs/brief.xml`` l.256 (``/sky/frame`` p95 < 150 ms for n = 32 with
the default body set, < 400 ms with 100 minor bodies; catalogs served from prebuilt files in
< 50 ms; ``/minor-bodies/search`` < 50 ms) as required by the M2 milestone (brief l.457) and
records them in ``docs/testing.md`` "Budgets". Standard library only.

Start the server first, from the repository root, on the production code path (no reload) with
the rate limiter effectively disabled so that the benchmark measures the API, not the limiter::

    SKYAPI_RATE_LIMIT_RPS=1000000 SKYAPI_RATE_LIMIT_BURST=1000000 \\
        uv run --directory backend --env-file ../.env fastapi run --port 8000

Wait until ``GET /api/v1/health`` answers ``ready`` (or ``degraded``), then run::

    uv run --directory backend python ../scripts/bench_api.py [--scenario frame ...] [--json]

Scenarios (``--scenario`` is repeatable; default: all):

``frame``
    ``/sky/frame`` with n = 32, the default bodies and Greenwich as the observer; every request
    carries a distinct ``tt`` spread over 2026-2030 so the frame cache never hits. Budget:
    p95 < 150 ms.
``frame-cached``
    The same request every time (one ``tt``): the frame cache answers. No budget, reported.
``frame-minor``
    ``frame`` plus the first 100 ids of ``/minor-bodies/defaults`` in ``minor=``. The first
    request is reported separately as "cold" (orbit rows read from Parquet; cold only on the
    first run after the server started); the warm p50/p95 follow. Budget: p95 < 400 ms.
``catalogs``
    The four ``/catalogs/*`` routes, one row each, ``Accept-Encoding: gzip`` requested. Budget:
    p95 < 50 ms per route.
``search``
    ``/minor-bodies/search?q=`` with a rotating list of names. Budget: p95 < 50 ms.

Every request sends ``Accept-Encoding: gzip``, reads the whole body and gunzips it when the
response says ``Content-Encoding: gzip``; the first response of every row is JSON-parsed (or
magic-checked for the SKYS binary) to prove it is valid, and its bytes on the wire fill the
``wire B`` column (the ``frame-minor`` figure of ``docs/testing.md``). Every non-200 status
counts as a failure and is shown in a status histogram. Latencies are wall-clock times of the
complete exchange as seen by the client (connection, request, full body read), not the server's
``Server-Timing``. The exit code is 1 when a budget is missed or a request failed, 2 when the
server is not ready or unreachable.

Memory (decision D145, brief l.256 "< 1 GB per worker excluding the OS page cache"): with
``--pid <n>`` (default: the process whose ``/proc/*/cmdline`` holds ``fastapi run`` and the
base URL's port, on Linux) the script samples ``/proc/<pid>/status`` (``VmRSS``, ``RssAnon``,
``RssFile``, ``RssShmem``, ``VmHWM``) at the start, after each scenario and, with ``--soak
<seconds>``, after that many seconds of mixed ``/sky/frame`` requests (distinct instants and
observers, so the 256-entry frame cache fills), and prints an RSS table. ``VmHWM`` (the
peak resident size) is the figure of record; ``RssAnon + RssShmem`` is the part that excludes
the page cache. That measure has no high-water mark in ``/proc`` and a sample taken after a
scenario misses the transient peak inside it (four concurrent 100-body frames), so a daemon
thread also reads the same file every 50 ms while requests are in flight and the highest
``RssAnon + RssShmem`` it saw is printed with the scenario it happened in. A missing ``/proc``
(not Linux) or an unmatched process prints a note and skips the table; an explicit ``--pid``
is sampled as given, with a warning when its command line is not a ``fastapi run``. The
``/proc/loadavg`` figures at the start and the end of the run are printed under the table (and
carried by ``--json``): the budgets are single-client figures, so a record names its load.
"""

import argparse
import gzip
import json
import math
import statistics
import struct
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import NoReturn

DEFAULT_BASE_URL = "http://127.0.0.1:8000"
DEFAULT_REQUESTS = 200
DEFAULT_CONCURRENCY = 1  # the budgets are per-request latencies; 4 probes single-worker throughput
DEFAULT_WARMUP = 10
REQUEST_TIMEOUT_S = 120.0
USER_AGENT = "InterSidera bench_api (+https://github.com/j-about/InterSidera)"
SERVER_COMMAND = (
    "SKYAPI_RATE_LIMIT_RPS=1000000 SKYAPI_RATE_LIMIT_BURST=1000000 "
    "uv run --directory backend --env-file ../.env fastapi run --port 8000"
)

SCENARIOS: tuple[str, ...] = ("frame", "frame-cached", "frame-minor", "catalogs", "search")

# Budgets at p95, milliseconds (brief l.256).
FRAME_BUDGET_MS = 150.0
FRAME_MINOR_BUDGET_MS = 400.0
CATALOG_BUDGET_MS = 50.0
SEARCH_BUDGET_MS = 50.0

# Royal Observatory, Greenwich.
GREENWICH_LAT_DEG = 51.4779
GREENWICH_LON_DEG = -0.0015
GREENWICH_ELEV_M = 46
FRAME_N = 32
FRAME_STEP_S = 60
# `tt` of the uncached frames: spread over 2026-01-01..2030-01-01 (TT Julian Dates) so that no
# two requests of a run share a cache key (the frame cache holds 256 entries).
TT_2026_01_01 = 2461041.5
TT_SPAN_DAYS = 1461.0
# The contract's example date (brief l.157), used by every request of `frame-cached`.
TT_CACHED = 2461285.5
MINOR_BODY_COUNT = 100
SEARCH_TERMS: tuple[str, ...] = (
    "ceres",
    "vesta",
    "halley",
    "encke",
    "eros",
    "pallas",
    "juno",
    "hygiea",
)
SKYS_HEADER = struct.Struct("<4sII")  # magic, version, count (then epoch f64 and flags u32)
SKYS_HEADER_BYTES = 24
SKYS_ROW_BYTES = 32
FAILURE_EXCERPT_CHARS = 200
# `/proc/<pid>/status` rows sampled by `--pid` (decision D145), in the order they are printed.
RSS_FIELDS: tuple[str, ...] = ("VmRSS", "RssAnon", "RssFile", "RssShmem", "VmHWM")
# Period of the in-flight `RssAnon + RssShmem` sampler (`RssWatcher`), seconds.
RSS_PEAK_INTERVAL_S = 0.05
# The soak alternates two observers so the frame cache key (observer, tt, n, step, bodies)
# never repeats: Greenwich and a southern site (Cape Town).
SOAK_OBSERVERS: tuple[tuple[float, float, int], ...] = (
    (GREENWICH_LAT_DEG, GREENWICH_LON_DEG, GREENWICH_ELEV_M),
    (-33.9249, 18.4241, 25),
)


@dataclass(frozen=True, slots=True)
class Response:
    """One completed exchange: status 0 means the connection itself failed."""

    status: int
    elapsed_ms: float
    body: bytes
    wire_bytes: int
    encoding: str | None
    server_timing: str | None


@dataclass(frozen=True, slots=True)
class Run:
    """One table row: how to build the i-th URL, how to validate the first body, the budget."""

    name: str
    url_for: Callable[[int], str]
    validate: Callable[[bytes], str]
    budget_ms: float | None
    report_cold: bool = False


@dataclass(slots=True)
class RunResult:
    name: str
    budget_ms: float | None
    timed: int = 0
    latencies_ms: list[float] = field(default_factory=list)
    statuses: Counter[int] = field(default_factory=Counter)
    cold_ms: float | None = None
    validation: str | None = None
    first_failure: str | None = None
    skipped: str | None = None
    server_timing: str | None = None
    #: Bytes on the wire of the first validated response (gzip when the server compressed it).
    wire_bytes: int | None = None

    @property
    def failures(self) -> int:
        return sum(count for status, count in self.statuses.items() if status != 200)

    @property
    def p50_ms(self) -> float | None:
        return statistics.median(self.latencies_ms) if self.latencies_ms else None

    @property
    def p95_ms(self) -> float | None:
        return percentile(self.latencies_ms, 0.95) if self.latencies_ms else None

    @property
    def max_ms(self) -> float | None:
        return max(self.latencies_ms) if self.latencies_ms else None

    @property
    def verdict(self) -> str:
        if self.skipped is not None:
            return "SKIP"
        if self.failures or self.first_failure is not None or not self.latencies_ms:
            return "FAIL"
        p95 = self.p95_ms
        if self.budget_ms is not None and p95 is not None and p95 >= self.budget_ms:
            return "FAIL"
        return "PASS"


@dataclass(frozen=True, slots=True)
class RssSample:
    """One read of `/proc/<pid>/status` (kB per field, as the kernel prints them)."""

    label: str
    kb: dict[str, int]

    def mb(self, field_name: str) -> float:
        return self.kb.get(field_name, 0) / 1024.0


@dataclass(slots=True)
class RssPeak:
    """The highest `RssAnon + RssShmem` the in-flight sampler saw, and where (kB, scenario)."""

    kb: int = 0
    during: str = ""
    reads: int = 0


class RssWatcher:
    """Reads `/proc/<pid>/status` every `RSS_PEAK_INTERVAL_S` on a daemon thread between
    `start(label)` and `stop()`, keeping the peak of the measure brief l.256 names (the page
    cache excluded), which `VmHWM` does not isolate and an after-scenario sample misses."""

    def __init__(self, pid: int) -> None:
        self.pid = pid
        self.peak = RssPeak()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self, label: str) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, args=(label,), daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
            self._thread = None

    def _run(self, label: str) -> None:
        while True:
            sample = read_rss(self.pid, label)
            if sample is not None:
                self.peak.reads += 1
                anon = sample.kb.get("RssAnon", 0) + sample.kb.get("RssShmem", 0)
                if anon > self.peak.kb:
                    self.peak.kb = anon
                    self.peak.during = label
            if self._stop.wait(RSS_PEAK_INTERVAL_S):
                return


def percentile(values: Sequence[float], q: float) -> float:
    """Nearest-rank percentile (no interpolation): the value at rank `ceil(q * n)`."""
    ordered = sorted(values)
    rank = max(1, math.ceil(q * len(ordered)))
    return ordered[rank - 1]


def die(message: str, code: int = 2) -> NoReturn:
    print(f"bench_api: {message}", file=sys.stderr)
    sys.exit(code)


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def fetch(url: str) -> Response:
    """GET `url` with `Accept-Encoding: gzip`; read the whole body; gunzip when encoded."""
    request = urllib.request.Request(
        url, headers={"Accept-Encoding": "gzip", "User-Agent": USER_AGENT}
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as response:
            raw: bytes = response.read()
            status = int(response.status)
            encoding = response.headers.get("Content-Encoding")
            server_timing = response.headers.get("Server-Timing")
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        status = exc.code
        encoding = exc.headers.get("Content-Encoding")
        server_timing = exc.headers.get("Server-Timing")
    except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        reason = getattr(exc, "reason", exc)
        return Response(0, elapsed_ms, str(reason).encode(), 0, None, None)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    body = gzip.decompress(raw) if encoding == "gzip" else raw
    return Response(status, elapsed_ms, body, len(raw), encoding, server_timing)


def validate_json_object(body: bytes, key: str) -> str:
    document = json.loads(body)
    if not isinstance(document, dict) or key not in document:
        raise ValueError(f"expected a JSON object with a {key!r} member")
    return f"JSON object with {len(document)} members"


def validate_json_list(body: bytes) -> str:
    document = json.loads(body)
    if not isinstance(document, list):
        raise ValueError("expected a JSON array")
    return f"JSON array of {len(document)} items"


def validate_skys(body: bytes) -> str:
    """Check the SKYS v1 header (docs/api.md, byte layout) and the exact body length."""
    if len(body) < SKYS_HEADER_BYTES:
        raise ValueError(f"SKYS body too short ({len(body)} B)")
    magic, version, count = SKYS_HEADER.unpack_from(body, 0)
    if magic != b"SKYS" or version != 1:
        raise ValueError(f"bad SKYS header: magic {magic!r}, version {version}")
    expected = SKYS_HEADER_BYTES + SKYS_ROW_BYTES * count
    if len(body) != expected:
        raise ValueError(f"SKYS length {len(body)} B, expected {expected} B for {count} stars")
    return f"SKYS v1, {count:,} stars"


def frame_tt(index: int, total: int) -> float:
    return TT_2026_01_01 + TT_SPAN_DAYS * index / max(1, total)


def frame_url(base_url: str, tt: float, minor: Sequence[str] = ()) -> str:
    params: dict[str, str] = {
        "body": "earth",
        "lat": repr(GREENWICH_LAT_DEG),
        "lon": repr(GREENWICH_LON_DEG),
        "elev": str(GREENWICH_ELEV_M),
        "tt": repr(tt),
        "step_s": str(FRAME_STEP_S),
        "n": str(FRAME_N),
    }
    if minor:
        params["minor"] = ",".join(minor)
    return f"{base_url}/api/v1/sky/frame?{urllib.parse.urlencode(params)}"


def search_url(base_url: str, index: int) -> str:
    query = urllib.parse.urlencode({"q": SEARCH_TERMS[index % len(SEARCH_TERMS)]})
    return f"{base_url}/api/v1/minor-bodies/search?{query}"


def constant_url(url: str) -> Callable[[int], str]:
    return lambda _index: url


def json_object_validator(key: str) -> Callable[[bytes], str]:
    return lambda body: validate_json_object(body, key)


def default_minor_ids(base_url: str) -> tuple[list[str], str | None]:
    """The first `MINOR_BODY_COUNT` ids of `/minor-bodies/defaults`, or a reason to skip."""
    response = fetch(f"{base_url}/api/v1/minor-bodies/defaults")
    if response.status != 200:
        return [], f"/minor-bodies/defaults answered {response.status}: {excerpt(response.body)}"
    try:
        document = json.loads(response.body)
    except ValueError as exc:
        return [], f"/minor-bodies/defaults is not JSON: {exc}"
    if not isinstance(document, list):
        return [], "/minor-bodies/defaults is not a JSON array"
    ids = [str(entry["id"]) for entry in document if isinstance(entry, dict) and "id" in entry]
    if not ids:
        return [], "/minor-bodies/defaults returned no ids"
    return ids[:MINOR_BODY_COUNT], None


def build_runs(base_url: str, scenarios: Sequence[str], total_requests: int) -> list[Run]:
    """Expand the selected scenarios into table rows (`catalogs` is four rows)."""
    runs: list[Run] = []
    for scenario in scenarios:
        if scenario == "frame":
            runs.append(
                Run(
                    "frame",
                    lambda index: frame_url(base_url, frame_tt(index, total_requests)),
                    json_object_validator("horizon"),
                    FRAME_BUDGET_MS,
                )
            )
        elif scenario == "frame-cached":
            runs.append(
                Run(
                    "frame-cached",
                    constant_url(frame_url(base_url, TT_CACHED)),
                    json_object_validator("horizon"),
                    None,
                )
            )
        elif scenario == "frame-minor":
            ids, reason = default_minor_ids(base_url)
            if reason is not None:
                runs.append(Run("frame-minor", constant_url(""), skip_validator(reason), None))
                continue
            name = (
                f"frame-minor ({len(ids)} ids)" if len(ids) != MINOR_BODY_COUNT else "frame-minor"
            )
            runs.append(
                Run(
                    name,
                    lambda index, ids=tuple(ids): frame_url(
                        base_url, frame_tt(index, total_requests), ids
                    ),
                    json_object_validator("minor"),
                    FRAME_MINOR_BUDGET_MS,
                    report_cold=True,
                )
            )
        elif scenario == "catalogs":
            catalogs: tuple[tuple[str, Callable[[bytes], str]], ...] = (
                ("catalogs/stars", validate_skys),
                ("catalogs/stars/index", validate_json_list),
                ("catalogs/dso", validate_json_list),
                ("catalogs/constellations", json_object_validator("constellations")),
            )
            for path, validator in catalogs:
                url = f"{base_url}/api/v1/{path}"
                runs.append(Run(path, constant_url(url), validator, CATALOG_BUDGET_MS))
        elif scenario == "search":
            runs.append(
                Run(
                    "search",
                    lambda index: search_url(base_url, index),
                    validate_json_list,
                    SEARCH_BUDGET_MS,
                )
            )
        else:
            die(f"unknown scenario {scenario!r}")
    return runs


class SkippedRunError(Exception):
    """Raised by the validator of a run that cannot be measured (data missing)."""


def skip_validator(reason: str) -> Callable[[bytes], str]:
    def validate(_body: bytes) -> str:
        raise SkippedRunError(reason)

    return validate


def excerpt(body: bytes) -> str:
    text = body.decode("utf-8", errors="replace").replace("\n", " ")
    return text if len(text) <= FAILURE_EXCERPT_CHARS else text[:FAILURE_EXCERPT_CHARS] + "..."


def execute(run: Run, *, requests: int, concurrency: int, warmup: int) -> RunResult:
    """One validated request, `warmup` untimed requests, then `requests` timed ones."""
    result = RunResult(run.name, run.budget_ms)
    try:
        first_url = run.url_for(0)
        if not first_url:
            run.validate(b"")
        log(
            f"{run.name}: 1 first + {warmup} warmup + {requests} timed requests, "
            f"concurrency {concurrency}"
        )
        first = fetch(first_url)
        record(result, first)
        if first.status == 200:
            try:
                result.validation = run.validate(first.body)
            except ValueError as exc:
                result.first_failure = f"first response is invalid: {exc}"
            result.server_timing = first.server_timing
            result.wire_bytes = first.wire_bytes
            if run.report_cold:
                result.cold_ms = first.elapsed_ms
            result.validation = describe(first, result.validation or "")
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            warm_urls = [run.url_for(index) for index in range(1, 1 + warmup)]
            for response in pool.map(fetch, warm_urls):
                record(result, response)
            timed_urls = [run.url_for(index) for index in range(1 + warmup, 1 + warmup + requests)]
            for response in pool.map(fetch, timed_urls):
                record(result, response)
                result.timed += 1
                if response.status == 200:
                    result.latencies_ms.append(response.elapsed_ms)
    except SkippedRunError as exc:
        result.skipped = str(exc)
    return result


def record(result: RunResult, response: Response) -> None:
    result.statuses[response.status] += 1
    if response.status != 200 and result.first_failure is None:
        where = "connection failed" if response.status == 0 else f"HTTP {response.status}"
        result.first_failure = f"{where}: {excerpt(response.body)}"


def describe(response: Response, validation: str) -> str:
    size = f"{len(response.body):,} B"
    if response.encoding == "gzip":
        size += f" ({response.wire_bytes:,} B gzip on the wire)"
    elif response.encoding:
        size += f" (Content-Encoding: {response.encoding})"
    else:
        size += " (identity)"
    return f"{validation}, {size}" if validation else size


def format_ms(value: float | None) -> str:
    return "-" if value is None else f"{value:.1f}"


def format_budget(value: float | None) -> str:
    return "-" if value is None else f"< {value:.0f}"


def format_bytes(value: int | None) -> str:
    return "-" if value is None else f"{value:,}"


def print_table(results: Sequence[RunResult]) -> None:
    header = (
        f"{'scenario':<24} {'requests':>8} {'failures':>8} {'p50 ms':>8} {'p95 ms':>8} "
        f"{'max ms':>8} {'wire B':>9} {'budget':>7} result"
    )
    print(header)
    print("-" * len(header))
    for result in results:
        print(
            f"{result.name:<24} {result.timed:>8} {result.failures:>8} "
            f"{format_ms(result.p50_ms):>8} {format_ms(result.p95_ms):>8} "
            f"{format_ms(result.max_ms):>8} {format_bytes(result.wire_bytes):>9} "
            f"{format_budget(result.budget_ms):>7} {result.verdict}"
        )
    print()
    for result in results:
        if result.skipped is not None:
            print(f"{result.name}: skipped: {result.skipped}")
            continue
        if result.validation:
            print(f"{result.name}: first response: {result.validation}")
        if result.server_timing:
            print(f"{result.name}: Server-Timing of the first response: {result.server_timing}")
        if result.cold_ms is not None:
            print(f"{result.name}: cold first request {result.cold_ms:.1f} ms")
        if result.failures or result.first_failure:
            histogram = ", ".join(
                f"{'conn' if status == 0 else status}x{count}"
                for status, count in sorted(result.statuses.items())
            )
            print(f"{result.name}: status histogram: {histogram}")
            if result.first_failure:
                print(f"{result.name}: first failure: {result.first_failure}")
            if 429 in result.statuses:
                print(f"{result.name}: hint: the server must run with `{SERVER_COMMAND}`")


def to_json(
    results: Sequence[RunResult],
    health: dict[str, object],
    args: argparse.Namespace,
    rss: Sequence[RssSample],
    soak: SoakResult | None,
    peak: RssPeak | None,
    loadavg: tuple[str | None, str | None],
) -> str:
    runs: list[dict[str, object]] = []
    for result in results:
        runs.append(
            {
                "name": result.name,
                "requests": result.timed,
                "issued": sum(result.statuses.values()),
                "failures": result.failures,
                "p50_ms": round_or_none(result.p50_ms),
                "p95_ms": round_or_none(result.p95_ms),
                "max_ms": round_or_none(result.max_ms),
                "budget_ms": result.budget_ms,
                "result": result.verdict,
                "cold_ms": round_or_none(result.cold_ms),
                "wire_bytes": result.wire_bytes,
                "statuses": {
                    str(status): count for status, count in sorted(result.statuses.items())
                },
                "first_response": result.validation,
                "server_timing": result.server_timing,
                "skipped": result.skipped,
            }
        )
    document: dict[str, object] = {
        "base_url": args.base_url,
        "requests": args.requests,
        "concurrency": args.concurrency,
        "warmup": args.warmup,
        "health": {key: health.get(key) for key in ("status", "version", "missing")},
        "runs": runs,
        "rss": [{"label": sample.label, **sample.kb} for sample in rss],
        "rss_peak": None
        if peak is None or peak.reads == 0
        else {
            "anon_shmem_kb": peak.kb,
            "during": peak.during,
            "reads": peak.reads,
            "interval_s": RSS_PEAK_INTERVAL_S,
        },
        "soak": None
        if soak is None
        else {
            "seconds": round(soak.seconds, 1),
            "requests": soak.requests,
            "failures": soak.failures,
            "distinct_keys": soak.distinct_keys,
        },
        "loadavg": {"start": loadavg[0], "end": loadavg[1]},
        "ok": all(result.verdict != "FAIL" for result in results),
    }
    return json.dumps(document, sort_keys=True)


def round_or_none(value: float | None) -> float | None:
    return None if value is None else round(value, 2)


def cmdline_tokens(pid: int) -> list[str] | None:
    """The argv of `/proc/<pid>/cmdline`, or None when the process is gone (or not Linux)."""
    try:
        argv = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    except OSError:
        return None
    return [token.decode("utf-8", errors="replace") for token in argv if token]


def is_fastapi_run(tokens: Sequence[str]) -> bool:
    """Whether an argv is a `fastapi run` command line (separate tokens, not a shell `-c`)."""
    return any(
        tokens[i].endswith("fastapi") and tokens[i + 1] == "run" for i in range(len(tokens) - 1)
    )


def read_loadavg() -> str | None:
    """The 1, 5 and 15 minute load averages of `/proc/loadavg`, or None off Linux."""
    try:
        fields = Path("/proc/loadavg").read_text(encoding="utf-8").split()
    except OSError:
        return None
    return " ".join(fields[:3]) if len(fields) >= 3 else None


def find_server_pid(port: int) -> int | None:
    """The `fastapi run` process serving `port`, from `/proc/*/cmdline` (Linux; decision D145).

    Both the `uv run ... fastapi run --port N` wrapper and the interpreter it launches match the
    tokens; the interpreter is the one whose `VmRSS` is largest (the wrapper holds no ephemeris).
    """
    proc = Path("/proc")
    if not proc.is_dir():
        return None
    port_tokens = {str(port), f"--port={port}"}
    best: tuple[int, int] | None = None  # (VmRSS kB, pid)
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        tokens = cmdline_tokens(int(entry.name))
        if tokens is None or not is_fastapi_run(tokens):
            continue
        if not port_tokens & set(tokens):
            continue
        sample = read_rss(int(entry.name), "probe")
        if sample is None:
            continue
        candidate = (sample.kb.get("VmRSS", 0), int(entry.name))
        if best is None or candidate > best:
            best = candidate
    return None if best is None else best[1]


def read_rss(pid: int, label: str) -> RssSample | None:
    """`RSS_FIELDS` of `/proc/<pid>/status` in kB, or None when the process is gone."""
    try:
        text = Path(f"/proc/{pid}/status").read_text(encoding="utf-8")
    except OSError:
        return None
    values: dict[str, int] = {}
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        if key in RSS_FIELDS:
            parts = rest.split()
            if parts and parts[0].isdigit():
                values[key] = int(parts[0])
    return RssSample(label, values)


def print_rss(samples: Sequence[RssSample], pid: int, in_flight: RssPeak | None) -> None:
    header = f"{'RSS of pid ' + str(pid):<28} " + " ".join(
        f"{name + ' MB':>12}" for name in RSS_FIELDS
    )
    print(header)
    print("-" * len(header))
    for sample in samples:
        print(f"{sample.label:<28} " + " ".join(f"{sample.mb(name):>12.1f}" for name in RSS_FIELDS))
    peak = max((sample.mb("VmHWM") for sample in samples), default=0.0)
    anon = max((sample.mb("RssAnon") + sample.mb("RssShmem") for sample in samples), default=0.0)
    print()
    print(
        f"figure of record: VmHWM {peak:.1f} MB (peak resident size); "
        f"RssAnon + RssShmem {anon:.1f} MB at most (excludes the page cache; brief l.256 < 1 GB)"
    )
    if in_flight is not None and in_flight.reads > 0:
        period_ms = RSS_PEAK_INTERVAL_S * 1000
        print(
            f"in flight: RssAnon + RssShmem peaked at {in_flight.kb / 1024.0:.1f} MB during "
            f"{in_flight.during} ({in_flight.reads} reads every {period_ms:.0f} ms)"
        )
    print()


def print_loadavg(start: str | None, end: str | None) -> None:
    """The machine's load around the run: the l.256 budgets are read on an idle machine."""
    if start is None and end is None:
        return
    print(
        f"load average (1/5/15 min): {start or '-'} at the start, {end or '-'} at the end "
        "(the budgets are single-client figures: record them from an idle machine)"
    )
    print()


@dataclass(slots=True)
class SoakResult:
    seconds: float
    requests: int = 0
    failures: int = 0
    distinct_keys: int = 0


def soak_url(base_url: str, index: int) -> str:
    """Frame requests that never share a cache key: two observers, distinct instants."""
    lat, lon, elev = SOAK_OBSERVERS[index % len(SOAK_OBSERVERS)]
    tt = TT_2026_01_01 + TT_SPAN_DAYS * ((index * 0.6180339887) % 1.0)
    params: dict[str, str] = {
        "body": "earth",
        "lat": repr(lat),
        "lon": repr(lon),
        "elev": str(elev),
        "tt": repr(round(tt, 6)),
        "step_s": str(FRAME_STEP_S),
        "n": str(FRAME_N),
    }
    return f"{base_url}/api/v1/sky/frame?{urllib.parse.urlencode(params)}"


def soak(base_url: str, seconds: float, concurrency: int) -> SoakResult:
    """Mixed frame requests for `seconds` (decision D145): fills the 256-entry frame cache."""
    result = SoakResult(seconds)
    log(f"soak: mixed /sky/frame requests for {seconds:.0f} s, concurrency {concurrency}")
    deadline = time.perf_counter() + seconds
    urls_seen: set[str] = set()
    index = 0
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        while time.perf_counter() < deadline:
            batch = [soak_url(base_url, index + k) for k in range(concurrency)]
            index += concurrency
            urls_seen.update(batch)
            for response in pool.map(fetch, batch):
                result.requests += 1
                if response.status != 200:
                    result.failures += 1
    result.seconds = seconds
    result.distinct_keys = len(urls_seen)
    log(
        f"soak: {result.requests} requests ({result.distinct_keys} distinct), "
        f"{result.failures} failures"
    )
    return result


def check_health(base_url: str) -> dict[str, object]:
    """Refuse to benchmark unless `/health` says `ready` or `degraded`."""
    response = fetch(f"{base_url}/api/v1/health")
    if response.status == 0:
        die(
            f"cannot reach {base_url}: {excerpt(response.body)}\n"
            f"start the server with:\n  {SERVER_COMMAND}"
        )
    try:
        document = json.loads(response.body)
    except ValueError:
        die(
            f"/api/v1/health answered {response.status} with a non-JSON body: "
            f"{excerpt(response.body)}"
        )
    if not isinstance(document, dict):
        die("/api/v1/health did not answer a JSON object")
    health: dict[str, object] = {str(key): value for key, value in document.items()}
    status = health.get("status")
    if response.status != 200 or status not in ("ready", "degraded"):
        details = [f"status {status!r} (HTTP {response.status})"]
        if health.get("progress") is not None:
            details.append(f"progress {health['progress']}")
        if health.get("detail") is not None:
            details.append(f"detail {health['detail']}")
        die("server is not ready: " + "; ".join(details))
    missing = health.get("missing")
    suffix = f", missing data groups: {missing}" if missing else ""
    log(f"health: {status} (skyapi {health.get('version')}){suffix}")
    return health


def positive_int(text: str) -> int:
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return value


def non_negative_int(text: str) -> int:
    value = int(text)
    if value < 0:
        raise argparse.ArgumentTypeError("must be zero or more")
    return value


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="bench_api.py",
        description="Benchmark the InterSidera API against the budgets of docs/brief.xml l.256.",
        epilog=f"Server: {SERVER_COMMAND}",
    )
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="API origin (no path)")
    parser.add_argument(
        "--requests",
        type=positive_int,
        default=DEFAULT_REQUESTS,
        help="timed requests per row (default %(default)s)",
    )
    parser.add_argument(
        "--concurrency",
        type=positive_int,
        default=DEFAULT_CONCURRENCY,
        help="parallel client threads (default %(default)s)",
    )
    parser.add_argument(
        "--warmup",
        type=non_negative_int,
        default=DEFAULT_WARMUP,
        help="untimed requests before the timed ones (default %(default)s)",
    )
    parser.add_argument(
        "--scenario",
        action="append",
        choices=SCENARIOS,
        help="scenario to run; repeatable (default: all of them)",
    )
    parser.add_argument(
        "--pid",
        type=positive_int,
        default=None,
        help="server process to sample /proc/<pid>/status from (default: the `fastapi run` "
        "process serving the base URL's port; decision D145)",
    )
    parser.add_argument(
        "--soak",
        type=non_negative_int,
        default=0,
        metavar="SECONDS",
        help="after the scenarios, issue mixed /sky/frame requests for this long (fills the "
        "256-entry frame cache), then sample the RSS again (default: no soak)",
    )
    parser.add_argument("--json", action="store_true", help="print one JSON line after the table")
    return parser.parse_args(argv)


def resolve_pid(args: argparse.Namespace, base_url: str) -> int | None:
    """`--pid`, or the server process found through the base URL's port; None with a note."""
    if args.pid is not None:
        pid = int(args.pid)
        if read_rss(pid, "probe") is None:
            log(f"rss: no /proc/{pid}/status (not Linux, or no such process): RSS table skipped")
            return None
        tokens = cmdline_tokens(pid)
        if tokens is not None and not is_fastapi_run(tokens):
            # The `uv run` wrapper or a shell prints a 28 MB table without this line.
            log(
                f"rss: warning: pid {pid} is not a `fastapi run` process "
                f"({' '.join(tokens[:4])} ...): sampled as given"
            )
        return pid
    port = urllib.parse.urlsplit(base_url).port or 80
    pid = find_server_pid(port)
    if pid is None:
        log(
            f"rss: no `fastapi run` process serving port {port} found under /proc "
            "(pass --pid): RSS table skipped"
        )
    return pid


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    base_url = str(args.base_url).rstrip("/")
    scenarios: Sequence[str] = args.scenario or SCENARIOS
    health = check_health(base_url)
    load_start = read_loadavg()
    pid = resolve_pid(args, base_url)
    rss: list[RssSample] = []
    watcher = None if pid is None else RssWatcher(pid)

    def sample(label: str) -> None:
        if pid is not None:
            reading = read_rss(pid, label)
            if reading is not None:
                rss.append(reading)

    sample("start")
    total = 1 + int(args.warmup) + int(args.requests)
    runs = build_runs(base_url, scenarios, total)
    results: list[RunResult] = []
    for run in runs:
        if watcher is not None:
            watcher.start(run.name)
        results.append(
            execute(
                run,
                requests=int(args.requests),
                concurrency=int(args.concurrency),
                warmup=int(args.warmup),
            )
        )
        if watcher is not None:
            watcher.stop()
        sample(f"after {run.name}")
    soaked: SoakResult | None = None
    if int(args.soak) > 0:
        if watcher is not None:
            watcher.start("soak")
        soaked = soak(base_url, float(args.soak), int(args.concurrency))
        if watcher is not None:
            watcher.stop()
        sample(f"after soak {int(args.soak)} s")
    load_end = read_loadavg()
    log("")
    print_table(results)
    print_loadavg(load_start, load_end)
    peak = None if watcher is None else watcher.peak
    if pid is not None and rss:
        print_rss(rss, pid, peak)
    if args.json:
        print(to_json(results, health, args, rss, soaked, peak, (load_start, load_end)))
    sys.stdout.flush()
    failed = [result.name for result in results if result.verdict == "FAIL"]
    if failed:
        log(f"bench_api: FAIL ({', '.join(failed)})")
        return 1
    log("bench_api: every budget met, no failed request")
    return 0


if __name__ == "__main__":
    sys.exit(main())
