"""Structured JSON logging and the request-context middleware (D63/D64, brief l.286, l.399).

`RequestContextMiddleware` is pure ASGI (never `BaseHTTPMiddleware`): it sets the request id in a
`ContextVar`, echoes it as `X-Request-Id` and writes one access record per request with the path
only (query strings carry coordinates, brief l.275). uvicorn's own access log, which prints the
full query string, is disabled by `configure_logging`.
"""

import json
import logging
import re
import sys
import time
import uuid
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import TextIO

from starlette.types import ASGIApp, Message, Receive, Scope, Send

request_id_var: ContextVar[str | None] = ContextVar("skyapi_request_id", default=None)

ACCESS_LOGGER = "skyapi.access"
REQUEST_ID_HEADER = "x-request-id"
_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_EXTRA_FIELDS = ("method", "route", "status", "duration_ms")


class JsonFormatter(logging.Formatter):
    """One JSON object per line: timestamp, level, logger, message, request id, extras."""

    def format(self, record: logging.LogRecord) -> str:
        document: dict[str, object] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=UTC).isoformat(
                timespec="milliseconds"
            ),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        request_id = getattr(record, "request_id", None) or request_id_var.get()
        if request_id is not None:
            document["request_id"] = request_id
        for name in _EXTRA_FIELDS:
            value = getattr(record, name, None)
            if value is not None:
                document[name] = value
        if record.exc_info:
            document["exception"] = self.formatException(record.exc_info)
        return json.dumps(document, ensure_ascii=False, default=str)


class SkyapiLogHandler(logging.StreamHandler[TextIO]):
    """Marker subclass so `configure_logging` replaces only its own handler."""


def configure_logging(level: str) -> None:
    """Install the JSON handler on the root logger (idempotent) and silence uvicorn's access log.

    Foreign handlers (pytest's `caplog`, a developer's own) are left untouched; only a previous
    `SkyapiLogHandler` is replaced. uvicorn's and fastapi-cli's log configs give the `uvicorn`
    logger its own plain-text handler with `propagate = False` (`uvicorn.error` has none and
    propagates to it), so both are re-routed to the root JSON handler: the handlers go, the
    records propagate.
    """
    root = logging.getLogger()
    for handler in list(root.handlers):
        if isinstance(handler, SkyapiLogHandler):
            root.removeHandler(handler)
    handler = SkyapiLogHandler(sys.stderr)
    handler.setFormatter(JsonFormatter())
    root.addHandler(handler)
    root.setLevel(level)
    for name in ("uvicorn", "uvicorn.error"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers.clear()
        uvicorn_logger.propagate = True
    access_logger = logging.getLogger("uvicorn.access")
    access_logger.handlers.clear()
    access_logger.propagate = False
    access_logger.disabled = True


def _request_id(scope: Scope) -> str:
    for name, value in scope.get("headers", []):
        if name == REQUEST_ID_HEADER.encode():
            candidate = value.decode("latin-1")
            if _UUID_RE.match(candidate):
                return candidate.lower()
            break
    return str(uuid.uuid4())


class RequestContextMiddleware:
    """Request id (accepted only when UUID-shaped, else generated) and the JSON access record."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.logger = logging.getLogger(ACCESS_LOGGER)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = _request_id(scope)
        # Starlette's ServerErrorMiddleware sits outside this one: the 500 handler reads the id
        # from the scope state to echo it (`X-Request-Id`) after the ContextVar is gone.
        state = scope.setdefault("state", {})
        state["request_id"] = request_id
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        status = 500

        async def send_wrapper(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = int(message["status"])
                headers = list(message.get("headers", []))
                headers.append((REQUEST_ID_HEADER.encode(), request_id.encode()))
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            # Logged here, while the request id is live; ServerErrorMiddleware renders the
            # problem document afterwards and re-raises for uvicorn.
            self.logger.exception(
                "unhandled exception on %s %s", scope.get("method", "-"), scope.get("path", "-")
            )
            raise
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000.0, 3)
            self.logger.info(
                "%s %s %d",
                scope.get("method", "-"),
                scope.get("path", "-"),
                status,
                extra={
                    "request_id": request_id,
                    "method": scope.get("method"),
                    "route": scope.get("path"),
                    "status": status,
                    "duration_ms": duration_ms,
                },
            )
            request_id_var.reset(token)
