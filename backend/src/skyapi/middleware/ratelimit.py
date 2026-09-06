"""Per-client token bucket on the compute endpoints (D62, brief l.107, l.275, l.531).

One limiter per worker process (documented): buckets live in memory, keyed on the client IP,
and are never persisted. Behind a reverse proxy uvicorn must trust the proxy's address
(`--forwarded-allow-ips`) for `request.client.host` to be the real client.
"""

import math
import threading
import time
from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, Request

from skyapi.middleware.problem import RateLimitedError

IDLE_EVICTION_SECONDS = 60.0
MAX_KEYS = 10_000


class TokenBucketLimiter:
    """`rps` tokens per second up to `burst`; `acquire` returns the wait in seconds (0 = ok)."""

    def __init__(
        self,
        rps: float,
        burst: int,
        *,
        clock: Callable[[], float] = time.monotonic,
        max_keys: int = MAX_KEYS,
    ) -> None:
        if rps <= 0 or burst < 1:
            raise ValueError("rps must be positive and burst at least 1")
        self.rps = rps
        self.burst = burst
        self._clock = clock
        self._max_keys = max_keys
        self._lock = threading.Lock()
        self._buckets: dict[str, tuple[float, float]] = {}  # key -> (tokens, updated_at)

    def acquire(self, key: str) -> float:
        now = self._clock()
        with self._lock:
            tokens, updated = self._buckets.get(key, (float(self.burst), now))
            tokens = min(float(self.burst), tokens + (now - updated) * self.rps)
            if tokens >= 1.0:
                self._buckets[key] = (tokens - 1.0, now)
                wait = 0.0
            else:
                self._buckets[key] = (tokens, now)
                wait = (1.0 - tokens) / self.rps
            if len(self._buckets) > self._max_keys:
                self._evict(now)
        return wait

    def _evict(self, now: float) -> None:
        stale = [
            key
            for key, (_, updated) in self._buckets.items()
            if now - updated > IDLE_EVICTION_SECONDS
        ]
        for key in stale:
            del self._buckets[key]
        while len(self._buckets) > self._max_keys:
            oldest = min(self._buckets, key=lambda k: self._buckets[k][1])
            del self._buckets[oldest]

    def __len__(self) -> int:
        with self._lock:
            return len(self._buckets)


def client_key(request: Request) -> str:
    """The bucket key: the peer address uvicorn reports (never a client-supplied header)."""
    client = request.client
    return client.host if client is not None else "unknown"


def get_limiter(request: Request) -> TokenBucketLimiter:
    limiter = getattr(request.state, "limiter", None)
    if not isinstance(limiter, TokenBucketLimiter):
        raise RuntimeError("lifespan did not run")
    return limiter


def rate_limited(
    request: Request, limiter: Annotated[TokenBucketLimiter, Depends(get_limiter)]
) -> None:
    """Dependency of the compute endpoints: 429 with `Retry-After` when the bucket is empty."""
    wait = limiter.acquire(client_key(request))
    if wait > 0.0:
        raise RateLimitedError(retry_after=math.ceil(wait))


RateLimited = Depends(rate_limited)
