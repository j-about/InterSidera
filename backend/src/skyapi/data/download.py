"""Resumable, verified downloads on the standard library (D30, D31; brief l.282, l.305).

Every transfer streams to `<filename>.part` next to a `<filename>.part.json` sidecar (URL, ETag,
Last-Modified, bytes so far). A later attempt resumes with `Range` + `If-Range` when the sidecar
matches, so a file regenerated upstream (MPCORB changes daily) never yields a stale head with a
new tail; a 206 whose validator differs from the sidecar's (a server ignoring `If-Range`) restarts
from byte 0. Nothing reaches `DATA_DIR/<filename>` before the size, content type, minimum size
and SHA-256 checks pass; the final rename is atomic (`os.replace`).
"""

import gzip
import hashlib
import json
import logging
import os
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.message import Message
from http.client import HTTPException, HTTPResponse
from importlib.metadata import version
from pathlib import Path
from typing import Literal, Protocol, cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from skyapi.data.registry import DataFile

logger = logging.getLogger(__name__)

# `(filename, downloaded_bytes, total_bytes_or_0)`: consumed by the CLI printer now and by the
# M2 `/health` bootstrap progress later (D31).
ProgressCallback = Callable[[str, int, int], None]
SleepFunction = Callable[[float], None]

USER_AGENT = f"InterSidera sky-data/{version('skyapi')} (+https://github.com/j-about/InterSidera)"
ATTEMPTS = 5
BACKOFF_SECONDS: tuple[float, ...] = (1.0, 2.0, 4.0, 8.0, 16.0)
TIMEOUT_SECONDS = 60.0
CHUNK_BYTES = 1 << 20
MANIFEST_FILENAME = "manifest.json"
PART_SUFFIX = ".part"
SIDECAR_SUFFIX = ".part.json"


class _Hasher(Protocol):
    """The slice of `hashlib` objects the streaming code needs."""

    def update(self, data: bytes, /) -> None: ...

    def hexdigest(self) -> str: ...


class DownloadError(Exception):
    """A download could not be completed or verified; no final file was written."""


class _TransientError(Exception):
    """This attempt failed but the same URL may work on the next attempt (resume kept)."""


class _RestartError(Exception):
    """The partial file cannot be trusted: discard it and try again from byte 0."""


class _UrlFailedError(Exception):
    """This URL will not work (404, wrong content, hash mismatch): try the next URL."""


@dataclass(frozen=True, slots=True)
class _ResumePoint:
    """A trusted partial file: its length and the validator its sidecar recorded."""

    offset: int
    header: Literal["ETag", "Last-Modified"]
    """The response header the validator came from (ETag whenever the server sent one)."""
    validator: str


def sha256_of(path: Path) -> str:
    """Streamed SHA-256 of a file (never reads a data file into memory at once)."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


@dataclass(frozen=True, slots=True)
class ManifestEntry:
    """What `DATA_DIR/manifest.json` records per registry key (D30)."""

    filename: str
    url: str
    size_bytes: int
    sha256: str
    fetched_at: str
    sha256_download: str | None = None
    last_modified: str | None = None
    etag: str | None = None

    def to_json(self) -> dict[str, object]:
        data: dict[str, object] = {
            "filename": self.filename,
            "url": self.url,
            "size_bytes": self.size_bytes,
            "sha256": self.sha256,
            "fetched_at": self.fetched_at,
        }
        if self.sha256_download is not None:
            data["sha256_download"] = self.sha256_download
        if self.last_modified is not None:
            data["last_modified"] = self.last_modified
        if self.etag is not None:
            data["etag"] = self.etag
        return data

    @classmethod
    def from_json(cls, data: Mapping[str, object]) -> ManifestEntry:
        return cls(
            filename=_json_str(data, "filename"),
            url=_json_str(data, "url"),
            size_bytes=_json_int(data, "size_bytes"),
            sha256=_json_str(data, "sha256"),
            fetched_at=_json_str(data, "fetched_at"),
            sha256_download=_json_opt_str(data, "sha256_download"),
            last_modified=_json_opt_str(data, "last_modified"),
            etag=_json_opt_str(data, "etag"),
        )


@dataclass(slots=True)
class Manifest:
    """`DATA_DIR/manifest.json`: the observed identity of every fetched file."""

    entries: dict[str, ManifestEntry] = field(default_factory=dict[str, ManifestEntry])

    @staticmethod
    def path(data_dir: Path) -> Path:
        return data_dir / MANIFEST_FILENAME

    @classmethod
    def load(cls, data_dir: Path) -> Manifest:
        path = cls.path(data_dir)
        if not path.is_file():
            return cls()
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise DownloadError(f"unreadable manifest {path}: {exc}") from exc
        if not isinstance(document, dict):
            raise DownloadError(f"unreadable manifest {path}: not a JSON object")
        entries: dict[str, ManifestEntry] = {}
        for key, value in cast(dict[object, object], document).items():
            if not isinstance(key, str) or not isinstance(value, dict):
                raise DownloadError(f"unreadable manifest {path}: malformed entry {key!r}")
            try:
                entries[key] = ManifestEntry.from_json(cast(dict[str, object], value))
            except DownloadError as exc:
                raise DownloadError(f"unreadable manifest {path}: entry {key!r}: {exc}") from exc
        return cls(entries)

    def save(self, data_dir: Path) -> None:
        path = self.path(data_dir)
        data = {key: entry.to_json() for key, entry in sorted(self.entries.items())}
        _write_text_atomically(path, json.dumps(data, indent=2, sort_keys=True) + "\n")

    def get(self, key: str) -> ManifestEntry | None:
        return self.entries.get(key)

    def record(self, key: str, result: DownloadResult) -> None:
        self.entries[key] = ManifestEntry(
            filename=result.filename,
            url=result.url,
            size_bytes=result.size_bytes,
            sha256=result.sha256,
            fetched_at=result.fetched_at,
            sha256_download=result.sha256_download,
            last_modified=result.last_modified,
            etag=result.etag,
        )


@dataclass(frozen=True, slots=True)
class DownloadResult:
    key: str
    filename: str
    path: Path
    url: str
    size_bytes: int
    sha256: str
    """SHA-256 of the file as it lies on disk (inflated for gunzip entries)."""
    sha256_download: str | None
    """SHA-256 of the transferred bytes when they differ from the on-disk file (gunzip)."""
    etag: str | None
    last_modified: str | None
    fetched_at: str
    resumed: bool


VerifyStatus = Literal["ok", "missing", "size_mismatch", "sha_mismatch", "unpinned"]


@dataclass(frozen=True, slots=True)
class VerifyResult:
    key: str
    filename: str
    present: bool
    size_ok: bool | None
    """None when neither the registry nor the manifest knows the size."""
    sha_ok: bool | None
    """None when neither the registry nor the manifest knows the hash."""
    status: VerifyStatus
    message: str

    @property
    def ok(self) -> bool:
        """Present with no failed check; `unpinned` counts as ok (recorded on the next fetch)."""
        return self.present and self.size_ok is not False and self.sha_ok is not False


def expected_sha256(file: DataFile, manifest: Manifest) -> str | None:
    """The hash the on-disk file must have: the pin, else the manifest record (D30)."""
    if file.sha256 is not None:
        return file.sha256
    entry = manifest.get(file.key)
    return entry.sha256 if entry is not None else None


def verify_file(file: DataFile, data_dir: Path, manifest: Manifest) -> VerifyResult:
    """Check presence, size and SHA-256 of one downloaded file against the pin or the manifest."""
    path = data_dir / file.filename
    if not path.is_file():
        return VerifyResult(file.key, file.filename, False, None, None, "missing", "missing")
    actual_size = path.stat().st_size
    entry = manifest.get(file.key)
    expected_size = file.size_bytes if file.size_bytes > 0 else None
    if expected_size is None and entry is not None:
        expected_size = entry.size_bytes
    size_ok = None if expected_size is None else actual_size == expected_size
    if size_ok is False:
        message = f"size {actual_size} bytes, expected {expected_size}"
        return VerifyResult(file.key, file.filename, True, False, None, "size_mismatch", message)
    expected_hash = expected_sha256(file, manifest)
    if expected_hash is None:
        return VerifyResult(
            file.key,
            file.filename,
            True,
            size_ok,
            None,
            "unpinned",
            "present, unpinned: sha256 is recorded on the next fetch",
        )
    actual_hash = sha256_of(path)
    if actual_hash != expected_hash:
        source = "pinned" if file.sha256 is not None else "recorded"
        message = f"sha256 {actual_hash[:12]}... differs from the {source} {expected_hash[:12]}..."
        return VerifyResult(file.key, file.filename, True, size_ok, False, "sha_mismatch", message)
    source = "pin" if file.sha256 is not None else "manifest"
    return VerifyResult(
        file.key, file.filename, True, size_ok, True, "ok", f"sha256 matches the {source}"
    )


def probe_unchanged(url: str, entry: ManifestEntry) -> bool:
    """HEAD the URL: True when its validators still equal the recorded ones (used by `update`).

    Any failure (no HEAD support, network error, missing validators) returns False so that the
    caller re-downloads: the probe can only ever save a transfer, never skip a needed one.
    """
    if entry.etag is None and entry.last_modified is None:
        return False
    request = Request(url, method="HEAD", headers=_base_headers())
    try:
        with cast(HTTPResponse, urlopen(request, timeout=TIMEOUT_SECONDS)) as response:
            headers = response.headers
    except HTTPError as exc:
        exc.close()  # HTTPError wraps an open response; closing it avoids a ResourceWarning
        return False
    except URLError, OSError, HTTPException:
        return False
    etag = headers.get("ETag")
    last_modified = headers.get("Last-Modified")
    if entry.etag is not None:
        return etag == entry.etag
    return last_modified == entry.last_modified


def download_file(
    file: DataFile,
    data_dir: Path,
    *,
    progress: ProgressCallback | None = None,
    force: bool = False,
    url: str | None = None,
    sleep: SleepFunction = time.sleep,
) -> DownloadResult:
    """Fetch one registry file into `data_dir` (D31).

    `force` discards any partial transfer; `url` overrides the registry URLs (a single source
    with no fallback); `sleep` is injectable so tests run the backoff schedule instantly.
    """
    if not file.is_download:
        raise DownloadError(f"{file.key} is a {file.kind} entry, not a download")
    data_dir.mkdir(parents=True, exist_ok=True)
    session = _Session(file, data_dir, progress)
    if force:
        session.discard_part()
    urls = (url,) if url is not None else file.urls
    failures: list[str] = []
    for candidate in urls:
        try:
            return _download_from(session, candidate, sleep)
        except _UrlFailedError as exc:
            logger.warning("%s: %s: %s", file.filename, candidate, exc)
            failures.append(f"{candidate}: {exc}")
    raise DownloadError(f"{file.filename}: every source failed: " + "; ".join(failures))


def _download_from(session: _Session, url: str, sleep: SleepFunction) -> DownloadResult:
    reason = ""
    for attempt in range(ATTEMPTS):
        try:
            return session.attempt(url)
        except _RestartError as exc:
            logger.info("%s: %s; restarting from byte 0", session.file.filename, exc)
            session.discard_part()
            reason = str(exc)
        except _TransientError as exc:
            logger.info("%s: %s", session.file.filename, exc)
            reason = str(exc)
        if attempt < ATTEMPTS - 1:
            delay = BACKOFF_SECONDS[attempt]
            logger.info(
                "%s: retrying in %.0f s (%d/%d)",
                session.file.filename,
                delay,
                attempt + 2,
                ATTEMPTS,
            )
            sleep(delay)
    raise _UrlFailedError(f"gave up after {ATTEMPTS} attempts ({reason})")


class _Session:
    """The on-disk state of one download: part file, sidecar, final path."""

    def __init__(self, file: DataFile, data_dir: Path, progress: ProgressCallback | None) -> None:
        self.file = file
        self.final = data_dir / file.filename
        self.part = data_dir / (file.filename + PART_SUFFIX)
        self.sidecar = data_dir / (file.filename + SIDECAR_SUFFIX)
        self.progress = progress

    def discard_part(self) -> None:
        self.part.unlink(missing_ok=True)
        self.sidecar.unlink(missing_ok=True)

    def attempt(self, url: str) -> DownloadResult:
        resume = self._resume_point(url)
        headers = _base_headers()
        offset = 0
        if resume is not None:
            offset = resume.offset
            headers["Range"] = f"bytes={offset}-"
            headers["If-Range"] = resume.validator
        response = _open(Request(url, headers=headers))
        with response:
            status = response.status
            if status == 200 and offset > 0:
                logger.info("%s: server ignored the Range request", self.file.filename)
                offset = 0
            elif status == 206:
                _check_content_range(response.headers, offset)
                if resume is not None:
                    _check_resume_validator(response.headers, resume)
            elif status != 200:
                raise _TransientError(f"unexpected HTTP status {status}")
            _check_headers(self.file, response.headers, status)
            total = _total_length(response.headers, status)
            etag = response.headers.get("ETag")
            last_modified = response.headers.get("Last-Modified")
            resumed = offset > 0
            digest = hashlib.sha256()
            if resumed:
                _rehash(self.part, digest, offset)
            else:
                self.part.unlink(missing_ok=True)
            self._write_sidecar(url, etag, last_modified, offset)
            downloaded = self._stream(response, digest, offset, total)
        if total is not None and downloaded != total:
            self._write_sidecar(url, etag, last_modified, downloaded)
            raise _TransientError(f"connection closed after {downloaded} of {total} bytes")
        if downloaded < self.file.min_size_bytes:
            self.discard_part()
            raise _UrlFailedError(
                f"body of {downloaded} bytes is below the minimum of {self.file.min_size_bytes}"
                " (error page or LFS pointer?)"
            )
        return self._finish(url, digest.hexdigest(), etag, last_modified, resumed)

    def _resume_point(self, url: str) -> _ResumePoint | None:
        """The partial file to resume, or None (the part and its sidecar are then discarded)."""
        if not self.part.is_file() or not self.sidecar.is_file():
            self.discard_part()
            return None
        try:
            sidecar = json.loads(self.sidecar.read_text(encoding="utf-8"))
        except OSError, ValueError:
            self.discard_part()
            return None
        if not isinstance(sidecar, dict):
            self.discard_part()
            return None
        data = cast(dict[str, object], sidecar)
        offset = self.part.stat().st_size
        etag = data.get("etag")
        last_modified = data.get("last_modified")
        if data.get("url") == url and offset > 0:
            if isinstance(etag, str) and etag:
                return _ResumePoint(offset, "ETag", etag)
            if isinstance(last_modified, str) and last_modified:
                return _ResumePoint(offset, "Last-Modified", last_modified)
        # Another URL, an empty part or no validator (a resumed tail could belong to a different
        # upstream version): nothing worth resuming.
        self.discard_part()
        return None

    def _write_sidecar(
        self, url: str, etag: str | None, last_modified: str | None, downloaded: int
    ) -> None:
        data = {"url": url, "etag": etag, "last_modified": last_modified, "bytes": downloaded}
        self.sidecar.write_text(json.dumps(data), encoding="utf-8")

    def _stream(
        self, response: HTTPResponse, digest: _Hasher, offset: int, total: int | None
    ) -> int:
        downloaded = offset
        mode = "ab" if offset > 0 else "wb"
        self._report(downloaded, total)
        try:
            with self.part.open(mode) as handle:
                while True:
                    chunk = response.read(CHUNK_BYTES)
                    if not chunk:
                        break
                    handle.write(chunk)
                    digest.update(chunk)
                    downloaded += len(chunk)
                    self._report(downloaded, total)
        except (HTTPException, OSError) as exc:
            raise _TransientError(f"transfer interrupted after {downloaded} bytes: {exc}") from exc
        return downloaded

    def _report(self, downloaded: int, total: int | None) -> None:
        if self.progress is not None:
            self.progress(self.file.filename, downloaded, total or 0)

    def _finish(
        self,
        url: str,
        transfer_hash: str,
        etag: str | None,
        last_modified: str | None,
        resumed: bool,
    ) -> DownloadResult:
        if self.file.gunzip:
            inflated = self.final.with_name(self.final.name + ".inflating")
            try:
                on_disk_hash = _gunzip(self.part, inflated)
            except (OSError, EOFError, gzip.BadGzipFile) as exc:
                inflated.unlink(missing_ok=True)
                self.discard_part()
                raise _UrlFailedError(f"not a valid gzip stream: {exc}") from exc
            staged = inflated
            sha256_download: str | None = transfer_hash
        else:
            staged = self.part
            on_disk_hash = transfer_hash
            sha256_download = None
        if self.file.sha256 is not None and on_disk_hash != self.file.sha256:
            staged.unlink(missing_ok=True)
            self.discard_part()
            raise _UrlFailedError(
                f"sha256 {on_disk_hash} does not match the pinned {self.file.sha256}"
            )
        size = staged.stat().st_size
        if self.file.size_bytes > 0 and size != self.file.size_bytes:
            staged.unlink(missing_ok=True)
            self.discard_part()
            raise _UrlFailedError(
                f"{size} bytes on disk, the registry expects {self.file.size_bytes}"
            )
        os.replace(staged, self.final)
        self.discard_part()
        logger.info("%s: %d bytes, sha256 %s", self.file.filename, size, on_disk_hash[:12])
        return DownloadResult(
            key=self.file.key,
            filename=self.file.filename,
            path=self.final,
            url=url,
            size_bytes=size,
            sha256=on_disk_hash,
            sha256_download=sha256_download,
            etag=etag,
            last_modified=last_modified,
            fetched_at=utc_now_iso(),
            resumed=resumed,
        )


def _base_headers() -> dict[str, str]:
    # `identity`: a transparently compressed body would make Content-Length incomparable to the
    # registry size and the streamed hash meaningless (D31).
    return {"User-Agent": USER_AGENT, "Accept-Encoding": "identity"}


def _open(request: Request) -> HTTPResponse:
    try:
        return cast(HTTPResponse, urlopen(request, timeout=TIMEOUT_SECONDS))
    except HTTPError as exc:
        exc.close()
        code = exc.code
        if code == 416:
            raise _RestartError(
                "HTTP 416: the partial file is longer than the remote file"
            ) from exc
        if code in (408, 429) or code >= 500:
            raise _TransientError(f"HTTP {code}") from exc
        raise _UrlFailedError(f"HTTP {code}") from exc
    except (URLError, OSError, HTTPException) as exc:
        raise _TransientError(f"connection failed: {exc}") from exc


def _check_content_range(headers: Message, offset: int) -> None:
    content_range = headers.get("Content-Range", "")
    unit, _, spec = content_range.partition(" ")
    first, _, _ = spec.partition("-")
    if unit != "bytes" or not first.isdigit() or int(first) != offset:
        raise _RestartError(
            f"HTTP 206 with Content-Range {content_range!r}, expected bytes {offset}-"
        )


def _check_resume_validator(headers: Message, resume: _ResumePoint) -> None:
    """A 206 must describe the upstream version the partial file came from (RFC 9110 13.1.5).

    `If-Range` asks for the whole file (200) when the validator changed; a server that ignores it
    answers 206 anyway and would splice a new tail onto an old head. The validator the sidecar
    recorded (ETag when the server sent one, else Last-Modified) must equal the one the response
    carries under the same header; a response without that header cannot be checked.
    """
    actual = headers.get(resume.header)
    if actual is not None and actual != resume.validator:
        raise _RestartError(
            f"HTTP 206 with {resume.header} {actual!r}, the partial file has {resume.validator!r}"
        )


def _check_headers(file: DataFile, headers: Message, status: int) -> None:
    encoding = headers.get("Content-Encoding", "identity").strip().lower()
    if encoding not in ("", "identity"):
        raise _UrlFailedError(f"Content-Encoding {encoding!r} refused (identity requested)")
    content_type = headers.get("Content-Type", "").split(";")[0].strip().lower()
    if content_type == "text/html":
        # None of the datasets is HTML: this is an error page served with a 200 or a redirect.
        raise _UrlFailedError("the server answered with an HTML page instead of the data file")
    if status == 200 and file.size_bytes > 0 and not file.gunzip:
        length = headers.get("Content-Length")
        if length is not None and length.strip().isdigit() and int(length) != file.size_bytes:
            raise _UrlFailedError(
                f"Content-Length {int(length)} differs from the registry size {file.size_bytes}"
            )


def _total_length(headers: Message, status: int) -> int | None:
    """Full length of the resource, or None when the server does not say."""
    if status == 206:
        _, _, spec = headers.get("Content-Range", "").partition(" ")
        _, _, complete = spec.partition("/")
        return int(complete) if complete.isdigit() else None
    length = headers.get("Content-Length")
    if length is not None and length.strip().isdigit():
        return int(length)
    return None


def _rehash(part: Path, digest: _Hasher, expected: int) -> None:
    hashed = 0
    with part.open("rb") as handle:
        while chunk := handle.read(CHUNK_BYTES):
            digest.update(chunk)
            hashed += len(chunk)
    if hashed != expected:
        raise _RestartError(f"partial file changed size while resuming ({hashed} != {expected})")


def _gunzip(source: Path, target: Path) -> str:
    digest = hashlib.sha256()
    with gzip.open(source, "rb") as inflated, target.open("wb") as handle:
        while chunk := inflated.read(CHUNK_BYTES):
            handle.write(chunk)
            digest.update(chunk)
    return digest.hexdigest()


def _write_text_atomically(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, path)


def _json_str(data: Mapping[str, object], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str):
        raise DownloadError(f"field {key!r} must be a string")
    return value


def _json_opt_str(data: Mapping[str, object], key: str) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise DownloadError(f"field {key!r} must be a string")
    return value


def _json_int(data: Mapping[str, object], key: str) -> int:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise DownloadError(f"field {key!r} must be an integer")
    return value
