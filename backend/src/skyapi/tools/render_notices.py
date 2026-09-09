"""Render `THIRD_PARTY_NOTICES.md` and the About-screen credits from the data registry.

Brief l.326 (D29, D32, D110): the notices file and the frontend About screen render the same
credits, so both come from `data_files.toml`: `--out` writes the Markdown, `--json` writes
`frontend/src/data/credits.json` (every entry, every key present, `null` when absent), and
`make notices` regenerates both under the same drift gate.

Deterministic by construction: every value comes from `data_files.toml` (`version_or_date` is
static text, never a fetch time), so `make notices` followed by `git diff --exit-code` is a valid
drift gate. Like `dump_openapi`, this tool never constructs `Settings()`: an invalid `SKYAPI_*`
value in the shell must not fail `make check` (D27).
"""

import argparse
import json
from collections.abc import Iterator, Sequence
from pathlib import Path

from skyapi.data.registry import DataFile, Registry, load_registry

TITLE = "# Third-party notices"
INTRO = (
    "This file is generated from the data registry "
    "(`backend/src/skyapi/data/data_files.toml`) by `python -m skyapi.tools.render_notices` "
    "(`make notices`); never edit it by hand. As required by `docs/brief.xml` l.326, it lists "
    "every dataset InterSidera downloads at bootstrap, ships inside its dependencies or uses at "
    "run time, with its source URL, version or date, license and attribution text. The "
    "application code itself is under the MIT license (`LICENSE`). Catalogs derived from "
    "share-alike sources are served under the same license as their source, declared by the API "
    "in `/meta.catalogs.<name>.license` and rendered on the About screen."
)
KIND_LABELS: dict[str, str] = {
    "download": "downloaded by `sky-data fetch` into `DATA_DIR`",
    "builtin": "bundled inside a Python dependency",
    "committed": "factual data authored for this project and committed",
    "runtime_service": "public web service called by the browser at run time",
    "ui_asset": "frontend asset from an npm dependency",
}


def render_notices(registry: Registry) -> str:
    lines: list[str] = [TITLE, "", INTRO, ""]
    for entry in registry.files:
        lines.extend(_section(registry, entry))
    lines.extend(_excerpts_section(registry))
    text = "\n".join(line.rstrip() for line in lines)
    return text.rstrip("\n") + "\n"


def _section(registry: Registry, entry: DataFile) -> Iterator[str]:
    yield f"## {entry.filename} (`{entry.key}`)"
    yield ""
    yield f"- Kind: {entry.kind} ({KIND_LABELS[entry.kind]})"
    if entry.kind == "committed":
        yield f"- Location: `{committed_location(entry)}`"
    if entry.url is not None:
        yield f"- Source: <{entry.url}>"
    if entry.fallback_urls:
        yield "- Fallback sources: " + ", ".join(f"<{url}>" for url in entry.fallback_urls)
    if entry.is_download and entry.gunzip:
        yield "- Stored as: inflated gzip stream"
    yield f"- Version or date: {entry.version_or_date}"
    yield f"- License: {entry.license}"
    if entry.copyright:
        yield f"- Copyright: {entry.copyright}"
    yield f"- Attribution: {entry.attribution}"
    if entry.notes:
        yield f"- Notes: {entry.notes}"
    yield ""
    text = registry.license_text(entry)
    if text is not None:
        yield f"License text (`backend/src/skyapi/data/licenses/{entry.license_file}`):"
        yield ""
        yield "```text"
        yield from text.rstrip("\n").splitlines()
        yield "```"
        yield ""


def committed_location(entry: DataFile) -> str:
    """Repository path of a committed entry: package data unless the filename is already a path."""
    if "/" in entry.filename:
        return entry.filename
    return f"backend/src/skyapi/data/{entry.filename}"


def credits_entries(registry: Registry) -> list[dict[str, object]]:
    """The registry as plain records for the About screen (D110): every key on every entry."""
    return [
        {
            "key": entry.key,
            "filename": entry.filename,
            "kind": entry.kind,
            "url": entry.url,
            "fallback_urls": list(entry.fallback_urls),
            "version_or_date": entry.version_or_date,
            "license": entry.license,
            "copyright": entry.copyright,
            "attribution": entry.attribution,
            "license_text": registry.license_text(entry),
            "notes": entry.notes,
        }
        for entry in registry.files
    ]


def render_credits(registry: Registry) -> str:
    """`credits.json`: a JSON array, two-space indented, UTF-8, one trailing newline."""
    return json.dumps(credits_entries(registry), indent=2, ensure_ascii=False) + "\n"


def _excerpts_section(registry: Registry) -> Iterator[str]:
    yield "## Test excerpts"
    yield ""
    yield (
        "Small excerpts of the datasets above are committed under "
        "`backend/tests/fixtures/excerpts/` for the test suite (brief l.325): each is under "
        "1 MB and carries an in-file header stating its source URL, license and fetch date."
    )
    yield ""
    if not registry.excerpts:
        yield "No excerpt is registered yet."
        yield ""
        return
    for excerpt in registry.excerpts:
        source = registry.by_key(excerpt.source_key)
        yield (
            f"- `{excerpt.path}`: {excerpt.description} (from `{excerpt.source_key}`, "
            f"{source.attribution}; {source.license})"
        )
    yield ""


def main(argv: Sequence[str] | None = None) -> int:
    """CLI: `--out /abs/THIRD_PARTY_NOTICES.md [--json /abs/frontend/src/data/credits.json]`."""
    parser = argparse.ArgumentParser(
        prog="python -m skyapi.tools.render_notices",
        description="Write THIRD_PARTY_NOTICES.md (and the About credits) from the data registry.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="destination path (use an absolute path; `make notices` passes $(CURDIR)/...)",
    )
    parser.add_argument(
        "--json",
        type=Path,
        default=None,
        help="also write the About-screen credits as JSON (frontend/src/data/credits.json)",
    )
    args = parser.parse_args(argv)
    registry = load_registry()
    out: Path = args.out
    out.write_text(render_notices(registry), encoding="utf-8", newline="\n")
    json_out: Path | None = args.json
    if json_out is not None:
        json_out.parent.mkdir(parents=True, exist_ok=True)
        json_out.write_text(render_credits(registry), encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
