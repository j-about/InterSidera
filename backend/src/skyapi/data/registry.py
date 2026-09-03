"""The data registry: every dataset of brief l.303-321 with URL, size, SHA-256 and license (D29).

`data_files.toml` ships inside the package (D28) and is the single source of truth for
`sky-data`, the cache bookkeeping and `THIRD_PARTY_NOTICES.md`. Loading validates the file so a
typo surfaces at `make check` (through the unit tests) rather than at bootstrap time.
"""

import tomllib
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from importlib import resources
from importlib.resources.abc import Traversable
from pathlib import Path
from typing import Literal, get_args

Kind = Literal["download", "builtin", "committed", "runtime_service", "ui_asset"]
Group = Literal[
    "ephemeris",
    "kernels",
    "stars",
    "names",
    "dso",
    "constellations",
    "mpc",
    "earth_orientation",
    "geocoder",
    "sites",
    "ui",
]
Refresh = Literal["never", "rarely", "yearly", "weekly", "when_naif_revises"]

KINDS: frozenset[str] = frozenset(get_args(Kind))
GROUPS: frozenset[str] = frozenset(get_args(Group))
REFRESHES: frozenset[str] = frozenset(get_args(Refresh))

REGISTRY_FILENAME = "data_files.toml"
LICENSES_DIR = "licenses"

_HEX = frozenset("0123456789abcdef")


class RegistryError(Exception):
    """The registry file is invalid or a lookup failed."""


@dataclass(frozen=True, slots=True)
class DataFile:
    """One `[[files]]` entry; see the field reference at the top of `data_files.toml`."""

    key: str
    kind: Kind
    filename: str
    group: Group
    refresh: Refresh
    license: str
    attribution: str
    version_or_date: str
    url: str | None = None
    fallback_urls: tuple[str, ...] = ()
    size_bytes: int = 0
    sha256: str | None = None
    sha256_pending: bool = False
    gunzip: bool = False
    min_size_bytes: int = 0
    required: bool = True
    optional: bool = False
    copyright: str | None = None
    license_file: str | None = None
    notes: str | None = None

    @property
    def is_download(self) -> bool:
        return self.kind == "download"

    @property
    def pinned(self) -> bool:
        """True when the on-disk file must match `sha256` (immutable files, D30)."""
        return self.sha256 is not None

    @property
    def urls(self) -> tuple[str, ...]:
        """Primary URL followed by the fallbacks, in the order the downloader tries them."""
        return (self.url, *self.fallback_urls) if self.url is not None else self.fallback_urls


@dataclass(frozen=True, slots=True)
class Excerpt:
    """A committed test excerpt (brief l.325): listed by the notices, checked by the tests."""

    path: str
    source_key: str
    description: str


@dataclass(frozen=True, slots=True)
class Registry:
    files: tuple[DataFile, ...]
    excerpts: tuple[Excerpt, ...] = ()
    _by_key: Mapping[str, DataFile] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "_by_key", {entry.key: entry for entry in self.files})

    def __iter__(self) -> Iterator[DataFile]:
        return iter(self.files)

    def by_key(self, key: str) -> DataFile:
        try:
            return self._by_key[key]
        except KeyError:
            known = ", ".join(entry.key for entry in self.files)
            raise RegistryError(f"unknown registry key {key!r}; known keys: {known}") from None

    def ephemerides(self) -> list[DataFile]:
        return [entry for entry in self.files if entry.is_download and entry.group == "ephemeris"]

    def downloads(self, ephemeris: str, *, full: bool = False) -> list[DataFile]:
        """The files a default `sky-data fetch` downloads (D32).

        The ephemeris whose `filename` equals `ephemeris` (`SKYAPI_EPHEMERIS`) comes first, then
        every non-ephemeris, non-`optional` download in registry order; `full` appends
        `de441.bsp` when it is not already the selected ephemeris.
        """
        ephemerides = self.ephemerides()
        selected = [entry for entry in ephemerides if entry.filename == ephemeris]
        if not selected:
            known = ", ".join(entry.filename for entry in ephemerides)
            raise RegistryError(
                f"unknown ephemeris {ephemeris!r}: SKYAPI_EPHEMERIS must be one of {known}"
            )
        files = selected + [
            entry
            for entry in self.files
            if entry.is_download and entry.group != "ephemeris" and not entry.optional
        ]
        if full:
            files.extend(
                entry
                for entry in ephemerides
                if entry.filename == "de441.bsp" and entry not in files
            )
        return files

    def license_text(self, entry: DataFile) -> str | None:
        """The packaged license text named by `license_file`, or None."""
        if entry.license_file is None:
            return None
        return _license_path(entry.license_file).read_text(encoding="utf-8")


def package_root() -> Traversable:
    """The `skyapi.data` package directory (works from a wheel as well as from a checkout)."""
    return resources.files(__package__)


def default_registry_path() -> Traversable:
    return package_root() / REGISTRY_FILENAME


def _license_path(name: str) -> Traversable:
    return package_root() / LICENSES_DIR / name


def load_registry(path: Path | None = None) -> Registry:
    """Parse and validate the registry; `path` overrides the packaged file (tests, `--registry`)."""
    source: Traversable | Path = default_registry_path() if path is None else path
    try:
        raw = source.read_bytes()
    except OSError as exc:
        raise RegistryError(f"cannot read registry {source}: {exc}") from exc
    try:
        document = tomllib.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise RegistryError(f"invalid registry {source}: {exc}") from exc
    return parse_registry(document)


def parse_registry(document: Mapping[str, object]) -> Registry:
    files = tuple(_parse_file(_table(item, "files")) for item in _list(document, "files"))
    excerpts = tuple(
        _parse_excerpt(_table(item, "excerpts")) for item in _list(document, "excerpts")
    )
    _validate(files, excerpts)
    return Registry(files=files, excerpts=excerpts)


def _list(document: Mapping[str, object], name: str) -> list[object]:
    value = document.get(name, [])
    if not isinstance(value, list):
        raise RegistryError(f"[[{name}]] must be an array of tables")
    return list(value)  # pyright: ignore[reportUnknownArgumentType]


def _table(item: object, name: str) -> Mapping[str, object]:
    if not isinstance(item, dict):
        raise RegistryError(f"[[{name}]] entries must be tables")
    table: dict[str, object] = {}
    for key, value in item.items():  # pyright: ignore[reportUnknownVariableType]
        if not isinstance(key, str):
            raise RegistryError(f"[[{name}]] keys must be strings")
        table[key] = value
    return table


class _Fields:
    """Typed access to one TOML table, naming the entry in every error."""

    def __init__(self, table: Mapping[str, object], label: str) -> None:
        self._table = table
        self._label = label

    def str_(self, name: str, *, required: bool = True) -> str | None:
        value = self._table.get(name)
        if value is None:
            if required:
                raise RegistryError(f"{self._label}: missing {name!r}")
            return None
        if not isinstance(value, str):
            raise RegistryError(f"{self._label}: {name!r} must be a string")
        return value

    def required_str(self, name: str) -> str:
        value = self.str_(name)
        assert value is not None
        if not value.strip():
            raise RegistryError(f"{self._label}: {name!r} must not be empty")
        return value

    def int_(self, name: str, default: int) -> int:
        value = self._table.get(name, default)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise RegistryError(f"{self._label}: {name!r} must be a non-negative integer")
        return value

    def bool_(self, name: str, default: bool) -> bool:
        value = self._table.get(name, default)
        if not isinstance(value, bool):
            raise RegistryError(f"{self._label}: {name!r} must be a boolean")
        return value

    def str_list(self, name: str) -> tuple[str, ...]:
        value = self._table.get(name, [])
        if not isinstance(value, list):
            raise RegistryError(f"{self._label}: {name!r} must be an array of strings")
        items: list[str] = []
        for element in value:  # pyright: ignore[reportUnknownVariableType]
            if not isinstance(element, str):
                raise RegistryError(f"{self._label}: {name!r} must be an array of strings")
            items.append(element)
        return tuple(items)

    def choice(self, name: str, allowed: frozenset[str]) -> str:
        value = self.required_str(name)
        if value not in allowed:
            choices = ", ".join(sorted(allowed))
            raise RegistryError(f"{self._label}: {name!r} must be one of {choices}, got {value!r}")
        return value

    def unknown_keys(self, known: frozenset[str]) -> set[str]:
        return set(self._table) - known


_FILE_KEYS = frozenset(
    {
        "key",
        "kind",
        "filename",
        "url",
        "fallback_urls",
        "size_bytes",
        "sha256",
        "sha256_pending",
        "gunzip",
        "min_size_bytes",
        "group",
        "required",
        "optional",
        "refresh",
        "license",
        "copyright",
        "license_file",
        "attribution",
        "version_or_date",
        "notes",
    }
)
_EXCERPT_KEYS = frozenset({"path", "source_key", "description"})


def _parse_file(table: Mapping[str, object]) -> DataFile:
    key = table.get("key")
    label = f"[[files]] {key!r}" if isinstance(key, str) else "[[files]] entry without key"
    fields = _Fields(table, label)
    if unknown := fields.unknown_keys(_FILE_KEYS):
        raise RegistryError(f"{label}: unknown fields {sorted(unknown)}")
    kind = fields.choice("kind", KINDS)
    group = fields.choice("group", GROUPS)
    refresh = fields.choice("refresh", REFRESHES)
    sha256 = fields.str_("sha256", required=False)
    if sha256 is not None and (len(sha256) != 64 or not set(sha256) <= _HEX):
        raise RegistryError(f"{label}: 'sha256' must be 64 lowercase hex characters")
    entry = DataFile(
        key=fields.required_str("key"),
        kind=_as_kind(kind),
        filename=fields.required_str("filename"),
        group=_as_group(group),
        refresh=_as_refresh(refresh),
        license=fields.required_str("license"),
        attribution=fields.required_str("attribution"),
        version_or_date=fields.required_str("version_or_date"),
        url=fields.str_("url", required=False),
        fallback_urls=fields.str_list("fallback_urls"),
        size_bytes=fields.int_("size_bytes", 0),
        sha256=sha256,
        sha256_pending=fields.bool_("sha256_pending", False),
        gunzip=fields.bool_("gunzip", False),
        min_size_bytes=fields.int_("min_size_bytes", 0),
        required=fields.bool_("required", True),
        optional=fields.bool_("optional", False),
        copyright=fields.str_("copyright", required=False),
        license_file=fields.str_("license_file", required=False),
        notes=fields.str_("notes", required=False),
    )
    _validate_file(entry, label)
    return entry


def _as_kind(value: str) -> Kind:
    assert value in KINDS
    return value  # pyright: ignore[reportReturnType]


def _as_group(value: str) -> Group:
    assert value in GROUPS
    return value  # pyright: ignore[reportReturnType]


def _as_refresh(value: str) -> Refresh:
    assert value in REFRESHES
    return value  # pyright: ignore[reportReturnType]


def _validate_file(entry: DataFile, label: str) -> None:
    if entry.is_download:
        if entry.url is None:
            raise RegistryError(f"{label}: downloads need a 'url'")
        if entry.min_size_bytes <= 0:
            raise RegistryError(f"{label}: downloads need a positive 'min_size_bytes'")
    else:
        if entry.sha256 is not None or entry.sha256_pending or entry.gunzip:
            raise RegistryError(f"{label}: only downloads carry sha256/sha256_pending/gunzip")
        if entry.optional:
            raise RegistryError(f"{label}: 'optional' applies to downloads only")
    for url in entry.urls:
        if not _url_allowed(url):
            raise RegistryError(f"{label}: URLs must use https, got {url!r}")
    if entry.sha256 is not None and entry.sha256_pending:
        raise RegistryError(f"{label}: 'sha256' and 'sha256_pending' are exclusive")
    if entry.sha256 is not None and entry.size_bytes <= 0:
        raise RegistryError(f"{label}: a pinned file needs its exact 'size_bytes'")
    if entry.license_file is not None and not _license_path(entry.license_file).is_file():
        raise RegistryError(
            f"{label}: license_file {entry.license_file!r} not found under skyapi/data/licenses"
        )


def _url_allowed(url: str) -> bool:
    """https everywhere; plain http only towards the loopback host (the tests' local server)."""
    if url.startswith("https://"):
        return True
    host = url.removeprefix("http://").split("/", 1)[0].rsplit(":", 1)[0]
    return url.startswith("http://") and host in ("127.0.0.1", "localhost", "[::1]")


def _parse_excerpt(table: Mapping[str, object]) -> Excerpt:
    path = table.get("path")
    label = f"[[excerpts]] {path!r}" if isinstance(path, str) else "[[excerpts]] entry without path"
    fields = _Fields(table, label)
    if unknown := fields.unknown_keys(_EXCERPT_KEYS):
        raise RegistryError(f"{label}: unknown fields {sorted(unknown)}")
    return Excerpt(
        path=fields.required_str("path"),
        source_key=fields.required_str("source_key"),
        description=fields.required_str("description"),
    )


def _validate(files: tuple[DataFile, ...], excerpts: tuple[Excerpt, ...]) -> None:
    keys = [entry.key for entry in files]
    if len(set(keys)) != len(keys):
        duplicates = sorted({key for key in keys if keys.count(key) > 1})
        raise RegistryError(f"duplicate registry keys: {duplicates}")
    filenames = [entry.filename for entry in files]
    if len(set(filenames)) != len(filenames):
        duplicates = sorted({name for name in filenames if filenames.count(name) > 1})
        raise RegistryError(f"duplicate registry filenames: {duplicates}")
    known = set(keys)
    for excerpt in excerpts:
        if excerpt.source_key not in known:
            raise RegistryError(
                f"[[excerpts]] {excerpt.path!r}: unknown source_key {excerpt.source_key!r}"
            )
    paths = [excerpt.path for excerpt in excerpts]
    if len(set(paths)) != len(paths):
        raise RegistryError("duplicate excerpt paths")
