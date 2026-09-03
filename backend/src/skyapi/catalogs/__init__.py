"""Catalog builders (brief l.359): SKYS binary, OpenNGC subset, constellations, MPC caches.

`formats.py` is pure (no I/O, no Skyfield) and 100 % covered; `builders.py` turns the
downloaded source files into the cache artifacts under `DATA_DIR/cache` at build time only
(brief pitfalls l.535: never rebuilt per request).
"""
