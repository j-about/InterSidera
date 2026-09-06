"""Cache headers, conditional GET and the in-memory frame cache (D57, brief l.81, l.105)."""

import threading
from collections import OrderedDict

from fastapi import Request

CACHE_CATALOG = "public, max-age=3600, stale-while-revalidate=86400"
CACHE_COMPUTE = "public, max-age=300"
NO_STORE = "no-store"
# 256 entries of at most ~400 KB (4096 cells, 9-decimal floats) bound the cache near 100 MB,
# well inside the 1 GB per-worker budget (brief l.256).
FRAME_CACHE_SIZE = 256


def etag_header(sha256: str) -> str:
    """Strong ETag: the artifact SHA-256, quoted (bare in `/meta.catalogs.*.etag`)."""
    return f'"{sha256}"'


def not_modified(request: Request, etag: str) -> bool:
    """True when `If-None-Match` names `etag` (or `*`); weak tags compare by opaque value."""
    header = request.headers.get("if-none-match")
    if header is None:
        return False
    for candidate in header.split(","):
        tag = candidate.strip()
        if tag == "*":
            return True
        if tag.startswith("W/"):
            tag = tag[2:]
        if tag == etag:
            return True
    return False


def server_timing(compute_ms: float, *, cache: str | None = None) -> str:
    """`Server-Timing` value: compute time and, for frames, the cache outcome."""
    value = f"compute;dur={compute_ms:.1f}"
    if cache is not None:
        value += f", cache;desc={cache}"
    return value


class FrameCache:
    """Thread-safe LRU of serialised frame responses keyed on the canonical query string."""

    def __init__(self, capacity: int = FRAME_CACHE_SIZE) -> None:
        if capacity < 1:
            raise ValueError("capacity must be at least 1")
        self._capacity = capacity
        self._lock = threading.Lock()
        self._entries: OrderedDict[str, bytes] = OrderedDict()

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)

    def get(self, key: str) -> bytes | None:
        with self._lock:
            value = self._entries.get(key)
            if value is not None:
                self._entries.move_to_end(key)
            return value

    def put(self, key: str, value: bytes) -> None:
        with self._lock:
            self._entries[key] = value
            self._entries.move_to_end(key)
            while len(self._entries) > self._capacity:
                self._entries.popitem(last=False)
