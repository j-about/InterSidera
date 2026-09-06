"""RFC 9457 problem details (brief api_contract l.106).

Every error answer of the API is a `Problem` document served as `application/problem+json` by
the single handler in `skyapi/middleware/problem.py` (D54). `range_tt` is the one extension
member: the valid TT range that accompanies a 422 "outside data coverage".
"""

from pydantic import BaseModel, ConfigDict, Field


class ProblemError(BaseModel):
    """One invalid input, in pydantic's `loc`/`msg`/`type` vocabulary."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    loc: list[str | int] = Field(
        description="Location of the offending value: `query` and the parameter name.",
        examples=[["query", "n"]],
    )
    msg: str = Field(
        description="Human-readable explanation.",
        examples=["Input should be less than or equal to 64"],
    )
    type: str = Field(
        description="Machine-readable error type (pydantic's error type).",
        examples=["less_than_equal"],
    )


class Problem(BaseModel):
    """RFC 9457 problem document (`type`, `title`, `status`, `detail`, `instance`, `errors[]`)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    type: str = Field(
        description="URI identifying the problem type; every type is documented in docs/api.md.",
        examples=[
            "https://github.com/j-about/InterSidera/blob/master/docs/api.md#problem-invalid-parameter"
        ],
    )
    title: str = Field(
        description="Short summary of the problem type.", examples=["Invalid parameter"]
    )
    status: int = Field(ge=400, le=599, description="HTTP status code.", examples=[400])
    detail: str | None = Field(
        default=None,
        description="Explanation specific to this occurrence.",
        examples=["unknown body ids: vulcan"],
    )
    instance: str | None = Field(
        default=None,
        description="Path of the request (never its query string).",
        examples=["/api/v1/sky/frame"],
    )
    errors: list[ProblemError] | None = Field(
        default=None, description="Per-parameter validation errors (400 only)."
    )
    range_tt: tuple[float, float] | None = Field(
        default=None,
        description="Valid TT Julian Date range when the request fell outside data coverage (422).",
        examples=[[2396758.5, 2506000.5]],
    )
