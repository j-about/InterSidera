"""InterSidera sky API: a Skyfield-backed, stateless, cacheable GET API (`skyapi`).

The backend is the single astronomical authority ("backend as oracle, client as
propagator", brief architecture/principles). At M0 it exposes `/api/v1/health` only.
"""
