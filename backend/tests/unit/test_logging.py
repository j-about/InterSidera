"""JSON logging (D64) and the access record of `RequestContextMiddleware` (D63, brief l.275)."""

import json
import logging
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from skyapi.middleware.logging import (
    ACCESS_LOGGER,
    JsonFormatter,
    SkyapiLogHandler,
    configure_logging,
    request_id_var,
)

pytestmark = pytest.mark.unit

REQUEST_ID = "0f8fad5b-d9cb-469f-a165-70867728950e"
UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")


def make_record(message: str = "hello %s", *args: object, **extra: object) -> logging.LogRecord:
    record = logging.LogRecord("skyapi.test", logging.INFO, __file__, 1, message, args, None)
    for name, value in extra.items():  # what `logger.info(..., extra={...})` does
        setattr(record, name, value)
    return record


@pytest.fixture
def restore_logging() -> Iterator[None]:
    """Undo what `configure_logging` changes: root level and handler, the uvicorn loggers.

    Only `SkyapiLogHandler` instances are touched on the root logger: pytest swaps its own
    capture handlers in and out around every phase, so restoring the whole handler list would
    resurrect stale ones.
    """
    root = logging.getLogger()
    own_before = [handler for handler in root.handlers if isinstance(handler, SkyapiLogHandler)]
    root_level = root.level
    saved = {
        name: (list(logger.handlers), logger.level, logger.propagate, logger.disabled)
        for name, logger in ((name, logging.getLogger(name)) for name in UVICORN_LOGGERS)
    }
    yield
    for handler in list(root.handlers):
        if isinstance(handler, SkyapiLogHandler) and handler not in own_before:
            root.removeHandler(handler)
    for handler in own_before:
        if handler not in root.handlers:
            root.addHandler(handler)
    root.setLevel(root_level)
    for name, (handlers, level, propagate, disabled) in saved.items():
        logger = logging.getLogger(name)
        logger.handlers[:] = handlers
        logger.setLevel(level)
        logger.propagate = propagate
        logger.disabled = disabled


# ------------------------------------------------------------------------------ JsonFormatter


def test_json_formatter_emits_one_object_per_record_with_the_context_request_id() -> None:
    token = request_id_var.set(REQUEST_ID)
    try:
        line = JsonFormatter().format(
            make_record("hello %s", "world", method="GET", route="/api/v1/health", status=200)
        )
    finally:
        request_id_var.reset(token)

    assert "\n" not in line
    document = json.loads(line)
    assert document == {
        "timestamp": document["timestamp"],
        "level": "INFO",
        "logger": "skyapi.test",
        "message": "hello world",
        "request_id": REQUEST_ID,
        "method": "GET",
        "route": "/api/v1/health",
        "status": 200,
    }
    stamp = datetime.fromisoformat(document["timestamp"])
    assert stamp.tzinfo is not None
    assert stamp.utcoffset() == UTC.utcoffset(None)
    assert document["timestamp"].endswith("+00:00")


def test_json_formatter_prefers_the_record_request_id_and_omits_it_when_unknown() -> None:
    formatter = JsonFormatter()
    assert request_id_var.get() is None

    without = json.loads(formatter.format(make_record("plain")))
    assert "request_id" not in without
    assert "route" not in without

    token = request_id_var.set("ffffffff-ffff-ffff-ffff-ffffffffffff")
    try:
        explicit = json.loads(formatter.format(make_record("tagged", request_id=REQUEST_ID)))
    finally:
        request_id_var.reset(token)
    assert explicit["request_id"] == REQUEST_ID


def test_json_formatter_serialises_exceptions_and_foreign_values() -> None:
    record = make_record("failed", duration_ms=1.5)
    try:
        raise ValueError("kaboom")
    except ValueError:
        import sys

        record.exc_info = sys.exc_info()

    document = json.loads(JsonFormatter().format(record))

    assert document["duration_ms"] == 1.5
    assert "ValueError: kaboom" in document["exception"]
    assert document["level"] == "INFO"


# -------------------------------------------------------------------------- configure_logging


def test_configure_logging_is_idempotent(restore_logging: None) -> None:
    configure_logging("INFO")
    configure_logging("DEBUG")

    root = logging.getLogger()
    own = [handler for handler in root.handlers if isinstance(handler, SkyapiLogHandler)]
    assert len(own) == 1
    assert isinstance(own[0].formatter, JsonFormatter)
    assert root.level == logging.DEBUG


def test_configure_logging_leaves_foreign_handlers_alone(
    restore_logging: None, caplog: pytest.LogCaptureFixture
) -> None:
    root = logging.getLogger()
    foreign = logging.NullHandler()
    root.addHandler(foreign)
    try:
        configure_logging("INFO")

        assert foreign in root.handlers
        with caplog.at_level(logging.INFO, logger="skyapi.test"):
            logging.getLogger("skyapi.test").info("still captured by caplog")
        assert "still captured by caplog" in [record.getMessage() for record in caplog.records]
    finally:
        root.removeHandler(foreign)


def test_configure_logging_silences_uvicorn_access_and_reroutes_uvicorn_to_root(
    restore_logging: None,
) -> None:
    # What uvicorn's (and fastapi-cli's) log config leaves behind before the lifespan runs.
    uvicorn_logger = logging.getLogger("uvicorn")
    uvicorn_logger.addHandler(logging.NullHandler())
    uvicorn_logger.propagate = False
    access_logger = logging.getLogger("uvicorn.access")
    access_logger.addHandler(logging.NullHandler())
    access_logger.propagate = False
    access_logger.disabled = False

    configure_logging("INFO")

    assert access_logger.disabled is True
    assert access_logger.propagate is False
    assert access_logger.handlers == []
    assert uvicorn_logger.handlers == []
    assert uvicorn_logger.propagate is True
    error_logger = logging.getLogger("uvicorn.error")
    assert error_logger.handlers == []
    assert error_logger.propagate is True


# ------------------------------------------------------------------------- the access record


@pytest.mark.api
def test_access_record_carries_the_path_and_never_the_query_string(
    api_client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger=ACCESS_LOGGER):
        response = api_client.get("/api/v1/health?lat=48.85&lon=2.35")

    assert response.status_code == 200
    records = [record for record in caplog.records if record.name == ACCESS_LOGGER]
    assert len(records) == 1
    record = records[0]
    fields = vars(record)
    assert fields["route"] == "/api/v1/health"
    assert fields["method"] == "GET"
    assert fields["status"] == 200
    assert isinstance(fields["duration_ms"], float)
    assert fields["request_id"] == response.headers["x-request-id"]
    assert record.getMessage() == "GET /api/v1/health 200"
    # Every record the API emitted during the request (the `httpx2` client's own line, part of
    # the test harness, naturally carries the URL and is not the API's log).
    api_lines = [
        JsonFormatter().format(record)
        for record in caplog.records
        if record.name.startswith("skyapi")
    ]
    assert api_lines
    for forbidden in ("lat", "lon", "48.85", "2.35", "?"):
        for line in api_lines:
            assert forbidden not in line
