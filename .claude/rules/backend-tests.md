---
paths:
  - "backend/tests/**"
---

# Backend test rules (pytest)

- Markers are declared and strict: `unit`, `api`, `conformance`, `slow`. `make check` runs `pytest -m "not slow"`; `make test` runs everything.
- pytest must not inherit `.env` or the CI environment: the autouse `clean_env` fixture in `conftest.py` deletes every `SKYAPI_*` variable before each test, and fixtures build `Settings(...)` explicitly (`data_dir=tmp_path_factory.mktemp("data")`, `auto_fetch=False`, `ephemeris="de440s.bsp"`). Never rely on ambient env.
- The Makefile passes `--env-file` only on run targets; check and test targets stay hermetic so `make check` passes from a clean clone.
- `de440s.bsp` covers 1849-2150 only: never request a date outside it in a test. Moon-frame tests must include a pre-2426 date (Skyfield #952 regression).
- No network in tests: no de441, no MPCORB, no Nominatim, no Horizons. Use committed fixtures (`tests/fixtures/`) and excerpts under 1 MB with a source/license header.
- `TestClient` is used as a context manager (`with TestClient(app) as client:`) so the lifespan runs; the API is exercised through the client, never by calling route functions directly.
- `filterwarnings = ["error"]`: a third-party warning is fixed at the source or silenced with a targeted `ignore:<message>:<Category>:<module>` entry carrying a comment and a backlog line; never a blanket ignore.
- The OpenAPI snapshot test compares `render_openapi(create_app(settings))` with `docs/openapi.json` and tells the reader to run `make types`.
- Coverage (from M1): >= 90 % on `skyapi/astro` and `skyapi/catalogs`; 100 % on `astro/quaternions.py` and `catalogs/formats.py`. hypothesis property tests for canonicalization, time conversions and the SKYS round-trip.
- Conformance tests assert Horizons tolerances (planets and Moon within 2 arcsec, stars within 1 arcsec) and are marked `conformance`; `slow` for anything that needs the full catalogs.
- `--import-mode=importlib`; `tests/**` may ignore ANN rules, nothing else.
- Never skip, weaken, delete or xfail a test to make a gate pass.
