# ADR-0017: API v1 conventions: canonicalization before caching, RFC 9457 problems, content-hash ETags and the middleware order

- Status: Accepted
- Date: 2026-09-24 (records decisions taken at M2 on 2026-09-06, amended at M4 on 2026-09-09 and M6 on 2026-09-23; recording form)

## Context

The api_contract conventions (l.101-108) make every endpoint a stateless, deterministic GET under `/api/v1` with canonicalized query parameters (latitude and longitude to 1e-6 degree, elevation to 1 m, `tt` to 1e-8 day, body lists sorted and de-duplicated), Pydantic v2 models with complete OpenAPI metadata and generated TypeScript types that CI checks for drift, versioned binary responses, the caching headers per endpoint class with a strong content-hash ETag for the catalogs, RFC 9457 problem documents for 400, 404, 422, 429 and 503, an in-memory token bucket per client IP, and GZip above 1 KiB. Canonicalization "must happen before cache lookup and before computation, and the response must echo the canonical values" (l.534); the catalogs are "versioned by a content hash that becomes the ETag; never rebuild them per request" (l.535). The security lines assign the standard headers to nginx (l.274), but at M6 nginx does not exist and the dev and preview proxies pass upstream headers unchanged.

## Options considered

1. Canonicalize inside each router versus one pure, hypothesis-tested module. The module (`api/canonical.py`) was chosen so the cache key, the echo and the computation cannot disagree.
2. FastAPI's `HTTPException` dictionaries versus one `Problem` model with typed `ApiError` subclasses and handlers for validation, routing and 500. The model was chosen (RFC 9457, `type` anchors in `docs/api.md`).
3. Starlette's `FileResponse` ETag (mtime and size) versus the artifact SHA-256 from the cache manifest. The hash was chosen (l.535); our own `If-None-Match` -> 304 because `FileResponse` handles `Range` only.
4. `BaseHTTPMiddleware` versus pure ASGI. Pure ASGI everywhere (the request context, and at M6 the security headers).
5. Per-body minor-body propagation (7.8 ms per body, 780 ms for 100) versus one batched `keplerlib.propagate` and one `observe().apparent()` call. Batched (D69).
6. `async def` compute routes versus plain `def` in the thread pool. Plain `def` (a compute route must never block the event loop).

## Decision

Records plan rows D54 to D65, D68, D69 and the M6 amendments D149, D150 and D166.

- D54 (problems): `middleware/problem.py` defines the `Problem` model with the `range_tt` extension, `ApiError` subclasses (400 invalid-parameter, 404 unknown-object, 422 outside-coverage, 429 rate-limited, 503 data-not-ready), handlers for `ApiError`, `RequestValidationError` (400), `StarletteHTTPException` and `Exception` (500); `type` = `https://github.com/j-about/InterSidera/blob/master/docs/api.md#problem-<slug>`; the `Problem` schema is injected into `components.schemas` by `create_app`.
- D55 and D68 (canonical form and rounding): `api/canonical.py` (pure, hypothesis-tested; query dataclasses in `astro/queries.py`) rounds, wraps `lon` to `[-180, 180)` without `-0.0`, bounds and clamps `step_s` (echoed), parses `,`-separated sorted lists, caps minor ids at 100 and targets at 200, enforces `n * (bodies + minor) <= 4096`; `cache_key()` is the sorted `key=value` string; JSON values are rounded before serialisation (`tt` 9 decimals, `mag` 3, angles 7 then wrapped).
- D56 to D61 (routes): `/sky/frame` (`astro/frame.py`, 422 only for `CoverageError`, `exclude_unset=True`), the `FrameCache` LRU of 256 serialised responses with `Cache-Control: public, max-age=300` and `Server-Timing: compute;dur=..., cache;desc=hit|miss`, `/sky/altaz` (`astro/altaz.py`; the additive `constellation` field since M4, `api_version` 1.1.0, backlog B-71), the catalogs through `FileResponse` with `ETag` = the artifact SHA-256 and `Cache-Control: public, max-age=3600, stale-while-revalidate=86400`, `/meta` built once at bootstrap plus `server_time` per request, `/minor-bodies/search` and `/defaults` with `max-age=300` and 503 when the MPC caches are absent (B-44).
- D62 to D64 (cross-cutting): the token bucket keyed on `request.client.host` as a dependency of the compute routes with `Retry-After = ceil(wait)`, per worker; JSON logging with the path only (uvicorn's access line is disabled because it carries the query string, B-45); GZip at level 6 excluding `application/octet-stream` (the SKYS, B-46).
- D63 amended by D149 (M6 middleware order): the last `add_middleware` call is the outermost layer; the stack is `RequestContextMiddleware` > `SecurityHeadersMiddleware` > `CORSMiddleware` > `GZipMiddleware` > app (`main.py`; `tests/api/test_middleware.py::test_middleware_stack_order_is_context_headers_cors_gzip`), so preflights, problem documents and 304s carry `X-Request-Id`, `nosniff` and the deny-everything CSP; Starlette's `ServerErrorMiddleware` wraps them all, so the 500 handler adds the request id and the two security headers itself and carries no CORS headers (ADR-0018, backlog B-87).
- D65 and D150 (OpenAPI and docs): tags, descriptions and examples on every field; `info.version` = the package version, `/meta.api_version` = the contract version; `docs_url="/api/v1/docs"` kept (no twelfth `SKYAPI_` variable, l.397) with `swagger_ui_oauth2_redirect_url=None` since M6 (no OAuth flow; FastAPI would otherwise register `/docs/oauth2-redirect` at the root with an inline script the strict policy refuses, B-final report section 1); production hides the page at the edge (B-95).
- D166 (M6 security review verdicts): `HEAD` stays 405 (a `head` operation is a contract change, Q80); request-line and header bounds are nginx defaults at M7; `Server: uvicorn` is hidden by nginx at M7; the rate-limit key behind a proxy relies on `FORWARDED_ALLOW_IPS` (documented in `.env.example`); `X-Request-Id` UUID-only, `FileResponse` paths, `errors[]`, the CORS methods and GZip are kept.

## Consequences

- Every model or route change bumps `api_version` under semver and runs `make types` in the same commit; the additive fields B-41 (`/health.missing`, `detail`), B-42, B-43, B-48 and B-71 are the recorded contract touches; M6 touched no contract (`make types` produced no diff).
- The frame cache and the limiter are per worker; users sharing a canonical query share a cache entry; `Server-Timing` exposes the compute cost.
- `astro/` never imports `api/`; routers never import Skyfield (they validate, canonicalize, call `astro/` and serialize).

## Revisit trigger

- A multi-worker shared cache or a reverse-proxy rate limiter; `/sky/events` ([L]); a maintainer decision on questions 13-15 (the `/health` and `/meta` shapes) or on `HEAD`.

Pointers: `docs/api.md`, `docs/architecture.md` ("API v1"), `.claude/rules/backend.md`, `docs/plan.md` section 3 (the rows above), `docs/backlog.md` (B-41 to B-48, B-71, B-87, B-95).

## Amendment (M7, 2026-09-28)

Plan D185, D188 and D193 (ADR-0024, ADR-0025), 2026-09-28. The D166 verdicts as realised at M7: the request-line and header bounds are nginx's defaults (`large_client_header_buffers 4 8k`): a request line above 8 kB answers 414 at the edge (nginx's inline page with the seven headers and `Connection: close`, measured at 9,035 and 17,035 B), while the bare API accepts such lines (200 at 9,035 and 17,035 B: uvicorn's httptools parser applies no request-line limit; a 9,000-byte header value answers 400), so the bound exists at the edge only. `Server: uvicorn` never reaches a client behind nginx (nginx passes no upstream `Server`; `proxy_hide_header Server` states the intent) and `Server: nginx` remains (`server_tokens off` drops the version; OSS nginx cannot omit the header, plan D193). The rate-limit key behind the proxy: `compose.yaml` sets `FORWARDED_ALLOW_IPS` to `web`'s fixed address `10.213.0.3` alone (never the compose network, whose gateway `10.213.0.1` relays the host's connections and, behind Docker Desktop's userland proxy, every published-port connection; never `*`), so uvicorn walks `X-Forwarded-For` from the right and stops at the address nginx itself appended: a client-supplied entry is never reached and a forged header is keyed like an unforged one; an external proxy whose header must be honoured is appended after that address in `compose.override.yaml` (D188 as amended in the M7 fix pass, ADR-0025 amendment). The decision text above is unchanged.
