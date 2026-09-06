# ADR-0008: Asynchronous bootstrap in a background thread, with `starting`, `ready` and `degraded` health states

- Status: Accepted
- Date: 2026-09-06

## Context

The brief asks the API to load every data set at startup and to report it through `GET /health`:
`starting` while a file is still being downloaded, with the download progress (l.80, l.112-113);
`ready` once every endpoint answers; `degraded` when optional data (OpenNGC, Stellarium,
d3-celestial, the MPC files) is absent, so that the affected endpoints answer 503 and the others
keep working (l.280). Data files are fetched when `SKYAPI_AUTO_FETCH` is true (l.76), caches are
rebuilt when a source changed (l.282), the readiness budget is 60 s with a warm cache (l.256) and
production runs `fastapi run --workers N` (l.77).

Starlette 1.x has one startup hook, the lifespan (ADR-0003). uvicorn accepts no connection until
the lifespan has yielded, so anything done before `yield` is invisible to clients: a lifespan that
downloads `de441.bsp` (3.3 GB) before yielding would leave `/health` unanswerable for the whole
transfer, and the Docker healthcheck and the frontend splash could not distinguish "still
downloading" from "dead". The M1 `SkyState` composition (`load_astro_state`, `load_catalog_state`,
`load_minor_body_state`) also opens kernel files that must be closed on every path, including a
failure halfway through.

## Options considered

1. **Block the lifespan** until the data is loaded, `/health` answering `ready` or nothing.
   Simplest, but it contradicts brief l.80 (no `starting` with progress) and turns a slow first
   download into a healthcheck failure loop. Rejected.
2. **Background thread with an exclusive `flock`.** The lifespan starts a daemon thread and yields
   at once; the thread runs the stages and publishes one immutable snapshot at a time; an
   advisory `fcntl.flock` on `DATA_DIR/.bootstrap.lock` serialises the download and cache stages
   across worker processes. `/health` reads the snapshot and answers 503 with `Retry-After` while
   `starting`. Chosen.
3. **External readiness file or supervisor**: a separate `sky-data` run prepares `DATA_DIR`, the
   API only loads what is present, and a supervisor (compose healthcheck, systemd, an init
   container) sequences the two. Cleaner for the API process, but the brief makes the API
   self-bootstrapping (l.76) and account-free deployments should stay a single `compose up`.
   Kept as the operator's option (`SKYAPI_AUTO_FETCH=false` plus `sky-data fetch` and
   `build-caches` out of band), not as the design.

## Decision

`skyapi/bootstrap.py` implements option 2 (decision D51):

- `Bootstrap` holds the current `Snapshot(status, sky, progress, detail, missing)` behind a lock;
  a reader takes the reference once, so `ready` or `degraded` is never observed without its
  `SkyState` (the dataclass rejects the inconsistent combinations). The lifespan joins the
  thread at shutdown (a settle event serves other callers and the tests), a cancel event is checked between stages, inside the
  downloader's progress callback and in its interruptible backoff sleep.
- `run_bootstrap(settings, registry, bootstrap)` is the thread body: (1) every default download of
  the registry present (`is_file()` and non-empty; downloads land atomically, so a partial
  transfer never bears the final name), missing files fetched when `SKYAPI_AUTO_FETCH` is true
  with the progress published to `/health`, a missing required file fatal otherwise, a missing
  optional one adding its registry `group` to `missing`; (2) caches loaded from
  `cache/manifest.json` and rebuilt with `build_all` when the manifest is unreadable, a source
  hash changed or an artifact fails verification; both stages under the exclusive lock; (3) the
  astronomical, catalog and minor-body states; (4) the static part of `/meta`; (5) publication of
  `SkyState` as `ready`, or `degraded` when `missing` is non-empty.
- Operational errors (`BootstrapError`: missing file without auto-fetch, failed required download,
  missing cache source, missing cache artifact, missing kernel) are published verbatim as
  `detail`; any other exception keeps its class name in `detail` and its traceback in the log.
  Any `AstroState` opened before the failure is closed. The process stays up.
- The lifespan yields `{"bootstrap", "settings", "limiter", "frame_cache"}` immediately; routes
  reach the state through `get_sky_state(request)`, which raises `DataNotReadyError` (503,
  `Retry-After: 5`) while no `SkyState` is published. At shutdown the lifespan cancels the
  bootstrap, joins the thread (70 s, longer than the downloader's 60 s socket timeout) and closes
  the kernel files.
- `/health` (D52) answers `503` with `Retry-After: 5` and the JSON body while `starting`
  (`progress` present during a download, `detail` after a fatal error), `200` for `ready` and
  `degraded` (`missing` lists the group codes `dso`, `constellations`, `mpc`); never cached.

## Consequences

- A fatal bootstrap error is a **permanent `503 starting` with a `detail`**, not a crash: the
  operator reads the reason from `/health` or the log, fixes the data and restarts. The Docker
  healthcheck (M7) fails on the 503 and restarts the container on its own policy; `make dev`
  shows the reason on the first `curl`. The test helper `wait_ready` fails fast on a `detail`.
- **Multi-worker behaviour**: every worker runs the bootstrap; the first to take
  `DATA_DIR/.bootstrap.lock` downloads and builds, the others block on the lock and then find
  the files present and the caches current, so nothing is fetched or built twice into one
  directory. Each worker loads its own `SkyState` (memory-mapped kernels, shared page cache).
  Readiness is reported per worker: behind uvicorn's process manager a request may reach a
  worker that is still `starting` while another is `ready`; clients honour `Retry-After`.
- **Presence-only file check**: the bootstrap does not hash the data files (`de441.bsp` alone
  would take longer than the readiness budget); integrity is the job of `sky-data verify`, of the
  downloader (size, content type and SHA-256 before the atomic rename) and of the cache builder,
  which hashes every source it reads and every artifact it verifies. A file replaced by hand with
  a corrupt one of the same name is caught by `sky-data verify`, not at startup.
- Degraded mode is data-driven: the `required` flag of the registry entry decides between fatal
  and degraded; the `missing` codes are the registry `group` names, which the frontend maps to
  its own messages (brief l.168: no free text for machine-read states).
- `create_app` performs no I/O (ADR-0003 holds): the registry is loaded in the thread; tests
  inject a registry pointing at a local server through `create_app(settings, registry=...)`.
- Recorded as deviation B-41 in `docs/backlog.md` (the contract lists `status`, `progress?` and
  `version` only; `missing` and `detail` are additive) and as maintainer question 13 in
  `docs/plan.md`.

## Revisit trigger

- uvicorn (or fastapi-cli) gains a pre-startup readiness hook that lets a server answer
  `/health` before the lifespan yields: move the stages back into the lifespan and drop the
  thread and the lock.
- The API runs behind a supervisor with its own readiness probe and data preparation step (an
  init container running `sky-data fetch && sky-data build-caches`): `SKYAPI_AUTO_FETCH=false`
  becomes the default and the download stage can go.
