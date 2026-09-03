"""A local HTTP server for the download tests: files from a directory, misbehaviour on demand.

Every knob of `ServerBehaviour` reproduces one situation the downloader must survive (D31):
servers that ignore `Range`, answer 206 with a wrong `Content-Range` or although `If-Range` no
longer matches, lie about or omit `Content-Length`, compress transparently, serve HTML error pages
with a 200, drop the connection mid-body, or fail transiently. Tests never touch the network.
"""

import gzip
import hashlib
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import cast


@dataclass(frozen=True)
class RequestRecord:
    method: str
    path: str
    headers: dict[str, str]

    @property
    def name(self) -> str:
        return self.path.lstrip("/")


@dataclass
class ServerBehaviour:
    ranges: bool = True
    """Honour `Range` with 206 (and advertise `Accept-Ranges: bytes`)."""
    ignore_range: bool = False
    """Answer 200 with the full body to a `Range` request."""
    ignore_if_range: bool = False
    """Answer 206 although `If-Range` does not match (non-compliant: RFC 9110 13.1.5 says 200)."""
    bad_content_range: bool = False
    """206 whose `Content-Range` starts one byte after the requested offset."""
    omit_content_length: bool = False
    content_length_override: int | None = None
    gzip_encoding: bool = False
    """Compress the body and send `Content-Encoding: gzip`."""
    content_type: str = "application/octet-stream"
    html_pages: set[str] = field(default_factory=set)
    """File names answered with an HTML page and a 200."""
    missing: set[str] = field(default_factory=set)
    """File names answered with an HTML 404 even though the file exists."""
    send_etag: bool = True
    send_last_modified: bool = True
    version: int = 1
    """Bump to change ETag and Last-Modified (the upstream file was regenerated)."""
    fail_first: int = 0
    """Answer 503 to this many requests before behaving."""
    truncate_at: int | None = None
    """Send only this many body bytes to the next request, then close the connection."""
    allow_head: bool = True


class LocalServer:
    """Serves `root` on 127.0.0.1 with an ephemeral port; records every request."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.behaviour = ServerBehaviour()
        self.requests: list[RequestRecord] = []
        self.lock = threading.Lock()
        self._server = _Server(("127.0.0.1", 0), _Handler, self)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def url_for(self, name: str) -> str:
        return f"{self.base_url}/{name}"

    def put(self, name: str, data: bytes) -> Path:
        path = self.root / name
        path.write_bytes(data)
        return path

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    def etag_for(self, name: str) -> str:
        """The ETag the server sends for `name` at the current behaviour version."""
        return _etag((self.root / name).read_bytes(), self.behaviour.version)

    @property
    def last_modified(self) -> str:
        return _last_modified(self.behaviour.version)

    def requests_for(self, name: str) -> list[RequestRecord]:
        with self.lock:
            return [record for record in self.requests if record.name == name]


@contextmanager
def serving(root: Path) -> Iterator[LocalServer]:
    server = LocalServer(root)
    server.start()
    try:
        yield server
    finally:
        server.stop()


def _etag(data: bytes, version: int) -> str:
    return f'"{hashlib.sha1(data).hexdigest()[:16]}-{version}"'


def _last_modified(version: int) -> str:
    return f"Thu, 0{version} Jan 2026 00:00:00 GMT"


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], local: LocalServer
    ) -> None:
        super().__init__(address, handler)
        self.local = local


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        self._handle(head=False)

    def do_HEAD(self) -> None:
        self._handle(head=True)

    def _handle(self, *, head: bool) -> None:
        local = cast(_Server, self.server).local
        behaviour = local.behaviour
        with local.lock:
            local.requests.append(
                RequestRecord(self.command, self.path, dict(self.headers.items()))
            )
            if behaviour.fail_first > 0:
                behaviour.fail_first -= 1
                self._send_text(503, "busy, try again")
                return
            truncate_at = behaviour.truncate_at
            if truncate_at is not None and not head:
                behaviour.truncate_at = None
        if head and not behaviour.allow_head:
            self._send_text(405, "HEAD not allowed")
            return
        name = self.path.lstrip("/")
        path = local.root / name
        if name in behaviour.missing or not path.is_file():
            self._send_html(404)
            return
        if name in behaviour.html_pages:
            self._send_html(200)
            return
        data = path.read_bytes()
        etag = _etag(data, behaviour.version)
        last_modified = _last_modified(behaviour.version)
        status, start = 200, 0
        range_header = self.headers.get("Range")
        if range_header and behaviour.ranges and not behaviour.ignore_range:
            if_range = self.headers.get("If-Range")
            if if_range is None or behaviour.ignore_if_range or if_range in (etag, last_modified):
                start = int(range_header.removeprefix("bytes=").split("-")[0])
                if start >= len(data):
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{len(data)}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
        body = data[start:]
        if behaviour.gzip_encoding:
            body = gzip.compress(body)
        self.send_response(status)
        self.send_header("Content-Type", behaviour.content_type)
        if status == 206:
            first = start + 1 if behaviour.bad_content_range else start
            self.send_header("Content-Range", f"bytes {first}-{len(data) - 1}/{len(data)}")
        if behaviour.gzip_encoding:
            self.send_header("Content-Encoding", "gzip")
        if not behaviour.omit_content_length:
            length = behaviour.content_length_override
            self.send_header("Content-Length", str(len(body) if length is None else length))
        if behaviour.send_etag:
            self.send_header("ETag", etag)
        if behaviour.send_last_modified:
            self.send_header("Last-Modified", last_modified)
        if behaviour.ranges:
            self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        if head:
            return
        if truncate_at is not None:
            self.wfile.write(body[:truncate_at])
            self.wfile.flush()
            self.close_connection = True
            return
        self.wfile.write(body)

    def _send_text(self, status: int, text: str) -> None:
        body = text.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, status: int) -> None:
        body = f"<html><body><h1>{status}</h1><p>InterSidera test server</p></body></html>".encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
