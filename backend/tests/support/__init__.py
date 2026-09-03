"""Test helpers importable as `support.*` (`pythonpath = ["tests"]` in pyproject.toml).

With `--import-mode=importlib` the `tests/` directory is not on `sys.path`, so shared helpers
(local HTTP server, excerpt readers) live in this package instead of `conftest.py`.
"""
