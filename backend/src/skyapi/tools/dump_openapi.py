"""Write the OpenAPI document to a file for `make types` and the snapshot test.

Brief quality_gates l.422 redirects stdout; D13 uses `--out PATH` instead so the file is
written byte-for-byte by Python (UTF-8, LF) regardless of the shell.
"""

import argparse
import json
from collections.abc import Sequence
from pathlib import Path

from fastapi import FastAPI

from skyapi.main import create_app
from skyapi.settings import default_settings


def render_openapi(app: FastAPI) -> str:
    """Serialize `app.openapi()` deterministically (sorted keys, 2-space indent, LF)."""
    return json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    """CLI: `python -m skyapi.tools.dump_openapi --out /abs/path/docs/openapi.json`."""
    parser = argparse.ArgumentParser(
        prog="python -m skyapi.tools.dump_openapi",
        description="Write the OpenAPI document of the InterSidera Sky API to a file.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="destination path (use an absolute path; `make types` passes $(CURDIR)/docs/...)",
    )
    args = parser.parse_args(argv)
    out: Path = args.out
    # D27: the document is settings-independent, so build the app from code defaults and
    # ignore the environment (an invalid `SKYAPI_*` value in the shell must not fail `make types`);
    # never through the lazily built `skyapi.main.app`.
    app = create_app(default_settings())
    out.write_text(render_openapi(app), encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
