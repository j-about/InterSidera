"""middleware/ratelimit.py: the token bucket under a fake clock, eviction, the client key (D62)."""

import math

import pytest
from fastapi import Request

from skyapi.middleware.problem import RateLimitedError
from skyapi.middleware.ratelimit import (
    IDLE_EVICTION_SECONDS,
    TokenBucketLimiter,
    client_key,
    rate_limited,
)

pytestmark = pytest.mark.unit


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _request(
    client: tuple[str, int] | None, headers: list[tuple[bytes, bytes]] | None = None
) -> Request:
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/v1/sky/frame",
        "query_string": b"",
        "headers": headers or [],
        "client": client,
    }
    return Request(scope)


def test_burst_then_refusal_then_refill_after_one_over_rps() -> None:
    clock = FakeClock()
    limiter = TokenBucketLimiter(rps=2.0, burst=3, clock=clock)
    assert [limiter.acquire("a") for _ in range(3)] == [0.0, 0.0, 0.0]
    # The bucket is empty: one token takes 1 / rps = 0.5 s.
    assert limiter.acquire("a") == pytest.approx(0.5)
    clock.advance(0.25)
    assert limiter.acquire("a") == pytest.approx(0.25)
    clock.advance(0.25)
    assert limiter.acquire("a") == 0.0
    assert limiter.acquire("a") > 0.0
    # Keys are independent buckets.
    assert limiter.acquire("b") == 0.0
    assert len(limiter) == 2


def test_tokens_never_exceed_the_burst() -> None:
    clock = FakeClock()
    limiter = TokenBucketLimiter(rps=10.0, burst=2, clock=clock)
    clock.advance(1000.0)
    assert limiter.acquire("a") == 0.0
    assert limiter.acquire("a") == 0.0
    assert limiter.acquire("a") == pytest.approx(0.1)


def test_retry_after_arithmetic_matches_the_api_test_settings() -> None:
    clock = FakeClock()
    limiter = TokenBucketLimiter(rps=0.01, burst=2, clock=clock)
    request = _request(("203.0.113.9", 4444))
    rate_limited(request, limiter)
    rate_limited(request, limiter)
    with pytest.raises(RateLimitedError) as info:
        rate_limited(request, limiter)
    assert info.value.retry_after == 100
    assert info.value.status == 429
    assert info.value.headers() == {"Retry-After": "100"}
    # Fractional waits round up (a client must never retry too early).
    clock.advance(0.5)
    assert math.ceil(limiter.acquire("203.0.113.9")) == 100
    clock.advance(100.0)
    rate_limited(request, limiter)


def test_idle_buckets_are_evicted_above_max_keys() -> None:
    clock = FakeClock()
    limiter = TokenBucketLimiter(rps=1.0, burst=1, clock=clock, max_keys=3)
    for key in ("a", "b", "c"):
        limiter.acquire(key)
    assert len(limiter) == 3
    clock.advance(IDLE_EVICTION_SECONDS + 1.0)
    limiter.acquire("d")  # the table exceeds max_keys: the three idle buckets go
    assert len(limiter) == 1
    for key in ("e", "f", "g"):
        limiter.acquire(key)
    # Nothing is idle, so the oldest bucket ("d") is dropped to respect the cap.
    assert len(limiter) == 3
    assert limiter.acquire("d") == 0.0  # a fresh bucket again: full burst


def test_client_key_uses_the_peer_address_only() -> None:
    assert client_key(_request(None)) == "unknown"
    assert client_key(_request(("203.0.113.9", 4444))) == "203.0.113.9"
    forwarded = _request(("10.0.0.1", 1), [(b"x-forwarded-for", b"203.0.113.9")])
    assert client_key(forwarded) == "10.0.0.1"


def test_unknown_clients_share_one_bucket() -> None:
    clock = FakeClock()
    limiter = TokenBucketLimiter(rps=1.0, burst=1, clock=clock)
    rate_limited(_request(None), limiter)
    with pytest.raises(RateLimitedError) as info:
        rate_limited(_request(None), limiter)
    assert info.value.retry_after == 1


def test_limiter_rejects_bad_parameters() -> None:
    with pytest.raises(ValueError, match="rps"):
        TokenBucketLimiter(rps=0.0, burst=1)
    with pytest.raises(ValueError, match="burst"):
        TokenBucketLimiter(rps=1.0, burst=0)
