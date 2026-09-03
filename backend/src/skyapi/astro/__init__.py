"""Astronomy core: the only package that imports Skyfield (brief architecture/backend l.82).

`loader.py` owns every Skyfield object and builds the frozen `AstroState`; the other modules
are typed functions that receive that state explicitly and are vectorised over `Time` arrays.
Routers never import from here directly except through the typed function surface.
"""
