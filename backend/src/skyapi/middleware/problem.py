"""RFC 9457 errors: typed exceptions and the single handler that renders them (D54, brief l.106).

Routers raise an `ApiError` subclass; FastAPI's validation errors, Starlette's routing errors and
unexpected exceptions are rendered by the same code path, so every error body is an
`application/problem+json` `Problem` document.
"""

import http
import logging
from collections.abc import Mapping
from typing import Any, ClassVar, cast

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response

from skyapi.models.problem import Problem, ProblemError

logger = logging.getLogger(__name__)

PROBLEM_MEDIA_TYPE = "application/problem+json"
# Problem types are documented in docs/api.md under "Problem types" (anchors `problem-<slug>`).
PROBLEM_TYPE_BASE = "https://github.com/j-about/InterSidera/blob/master/docs/api.md#problem-"


def problem_type(slug: str) -> str:
    return PROBLEM_TYPE_BASE + slug


class ApiError(Exception):
    """Base of every error a router raises; subclasses fix `status`, `title` and `slug`."""

    status: ClassVar[int] = 500
    title: ClassVar[str] = "Internal server error"
    slug: ClassVar[str] = "internal-error"

    def __init__(
        self,
        detail: str,
        *,
        errors: list[ProblemError] | None = None,
        range_tt: tuple[float, float] | None = None,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(detail)
        self.detail = detail
        self.errors = errors
        self.range_tt = range_tt
        self.retry_after = retry_after

    def problem(self, instance: str | None) -> Problem:
        return Problem(
            type=problem_type(self.slug),
            title=self.title,
            status=self.status,
            detail=self.detail,
            instance=instance,
            errors=self.errors,
            range_tt=self.range_tt,
        )

    def headers(self) -> dict[str, str]:
        if self.retry_after is None:
            return {}
        return {"Retry-After": str(self.retry_after)}


class InvalidParameterError(ApiError):
    """400: a parameter is malformed, out of bounds or inconsistent with another one."""

    status = 400
    title = "Invalid parameter"
    slug = "invalid-parameter"


class UnknownObjectError(ApiError):
    """404: no catalog object, star, DSO or minor body carries the requested id."""

    status = 404
    title = "Unknown object"
    slug = "unknown-object"


class OutsideCoverageError(ApiError):
    """422: the request leaves the coverage of the ephemeris or of the observer frame."""

    status = 422
    title = "Outside data coverage"
    slug = "outside-coverage"

    def __init__(self, detail: str, range_tt: tuple[float, float]) -> None:
        super().__init__(detail, range_tt=range_tt)


class RateLimitedError(ApiError):
    """429: the client's token bucket is empty; `Retry-After` says when to try again."""

    status = 429
    title = "Rate limited"
    slug = "rate-limited"

    def __init__(self, retry_after: int) -> None:
        wait = max(1, retry_after)
        super().__init__(f"too many requests; retry after {wait} s", retry_after=wait)


class DataNotReadyError(ApiError):
    """503: the data behind the endpoint is loading (`starting`) or missing (`degraded`)."""

    status = 503
    title = "Data not ready"
    slug = "data-not-ready"

    def __init__(self, detail: str, retry_after: int = 5) -> None:
        super().__init__(detail, retry_after=retry_after)


# Every problem type the API emits: slug -> (status, title), for docs/api.md and its test.
PROBLEM_TYPES: Mapping[str, tuple[int, str]] = {
    InvalidParameterError.slug: (InvalidParameterError.status, InvalidParameterError.title),
    UnknownObjectError.slug: (UnknownObjectError.status, UnknownObjectError.title),
    OutsideCoverageError.slug: (OutsideCoverageError.status, OutsideCoverageError.title),
    RateLimitedError.slug: (RateLimitedError.status, RateLimitedError.title),
    DataNotReadyError.slug: (DataNotReadyError.status, DataNotReadyError.title),
    "http-error": (0, "HTTP error (unrouted path, wrong method)"),
    ApiError.slug: (ApiError.status, ApiError.title),
}


def render_problem(problem: Problem, headers: Mapping[str, str] | None = None) -> Response:
    return Response(
        content=problem.model_dump_json(exclude_none=True),
        status_code=problem.status,
        media_type=PROBLEM_MEDIA_TYPE,
        headers=dict(headers) if headers else None,
    )


def _instance(request: Request) -> str:
    # The path only: query strings carry coordinates (brief l.275).
    return request.url.path


async def api_error_handler(request: Request, exc: Exception) -> Response:
    error = cast(ApiError, exc)
    return render_problem(error.problem(_instance(request)), error.headers())


def _validation_errors(exc: RequestValidationError) -> list[ProblemError]:
    errors: list[ProblemError] = []
    for raw in exc.errors():
        item = cast(Mapping[str, Any], raw)
        loc = [part if isinstance(part, int) else str(part) for part in item.get("loc", ())]
        errors.append(
            ProblemError(loc=loc, msg=str(item.get("msg", "")), type=str(item.get("type", "")))
        )
    return errors


async def validation_error_handler(request: Request, exc: Exception) -> Response:
    error = cast(RequestValidationError, exc)
    errors = _validation_errors(error)
    problem = Problem(
        type=problem_type(InvalidParameterError.slug),
        title=InvalidParameterError.title,
        status=400,
        detail=f"{len(errors)} invalid parameter(s)",
        instance=_instance(request),
        errors=errors,
    )
    return render_problem(problem)


async def http_exception_handler(request: Request, exc: Exception) -> Response:
    error = cast(StarletteHTTPException, exc)
    status = error.status_code
    try:
        title = http.HTTPStatus(status).phrase
    except ValueError:
        title = "HTTP error"
    problem = Problem(
        type=problem_type("http-error"),
        title=title,
        status=status,
        detail=str(error.detail) if error.detail else None,
        instance=_instance(request),
    )
    return render_problem(problem, error.headers)


async def unhandled_exception_handler(request: Request, exc: Exception) -> Response:
    # Rendered by Starlette's ServerErrorMiddleware, the outermost layer, which re-raises
    # afterwards (the TestClient still sees the exception, uvicorn logs the traceback). The
    # request-context middleware has already logged the exception with the request id and left
    # the id in the scope state; it is echoed here because that middleware never sees this
    # response. CORS headers are absent on this path (documented in docs/api.md).
    scope_state: Mapping[str, object] = request.scope.get("state") or {}
    request_id = scope_state.get("request_id")
    detail = "unexpected error"
    headers: dict[str, str] = {}
    if isinstance(request_id, str):
        detail = f"unexpected error; request id {request_id} in the server log"
        headers["X-Request-Id"] = request_id
    problem = Problem(
        type=problem_type(ApiError.slug),
        title=ApiError.title,
        status=500,
        detail=detail,
        instance=_instance(request),
    )
    return render_problem(problem, headers)


def register_exception_handlers(app: FastAPI) -> None:
    """The one place error rendering is wired (brief l.398: a single handler)."""
    app.add_exception_handler(ApiError, api_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)


# OpenAPI: the `content` recipe (never `"model":` next to a `content` key, which FastAPI would
# place under the success media type) and `Problem` injected into `components.schemas` by
# `skyapi.main`. Declaring `default` on every route also removes FastAPI's `HTTPValidationError`.
_PROBLEM_CONTENT: dict[str, Any] = {
    PROBLEM_MEDIA_TYPE: {"schema": {"$ref": "#/components/schemas/Problem"}}
}
_DESCRIPTIONS: Mapping[int, str] = {
    400: "Invalid parameter (`errors[]` lists each one).",
    404: "Unknown object.",
    422: "Outside data coverage; `range_tt` carries the valid TT range.",
    429: "Rate limited; retry after `Retry-After` seconds.",
    503: "Data not ready (starting, or degraded for this endpoint); retry after `Retry-After`.",
}


def problem_responses(*statuses: int) -> dict[int | str, dict[str, Any]]:
    """`responses=` entries documenting problem+json answers for the given statuses."""
    responses: dict[int | str, dict[str, Any]] = {
        status: {"description": _DESCRIPTIONS[status], "content": dict(_PROBLEM_CONTENT)}
        for status in statuses
    }
    responses["default"] = {
        "description": "Any other error, as an RFC 9457 problem document.",
        "content": dict(_PROBLEM_CONTENT),
    }
    return responses


def problem_schema_components() -> dict[str, Any]:
    """`Problem` and `ProblemError` schemas for `components.schemas` (D54)."""
    schema = Problem.model_json_schema(
        mode="serialization", ref_template="#/components/schemas/{model}"
    )
    defs = cast(dict[str, Any], schema.pop("$defs", {}))
    components: dict[str, Any] = {name: definition for name, definition in defs.items()}
    components["Problem"] = schema
    return components
