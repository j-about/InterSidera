"""Models for `GET /health` (brief api_contract l.112-113)."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

HealthStatus = Literal["starting", "ready", "degraded"]


class DownloadProgress(BaseModel):
    """Progress of the data file currently being downloaded at startup."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    file: str = Field(
        description="File name being downloaded into DATA_DIR.",
        examples=["de440s.bsp"],
    )
    downloaded_bytes: int = Field(
        ge=0,
        description="Bytes received so far.",
        examples=[16777216],
    )
    total_bytes: int = Field(
        ge=0,
        description="Expected size of the file in bytes (0 when the server did not say).",
        examples=[32726016],
    )


class HealthResponse(BaseModel):
    """Readiness report used by the Docker healthcheck and the frontend splash screen."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    status: HealthStatus = Field(
        description=(
            "`starting` while data is being fetched or loaded, `ready` when every endpoint "
            "answers, `degraded` when the API runs with reduced coverage."
        ),
        examples=["ready"],
    )
    progress: DownloadProgress | None = Field(
        default=None,
        description="Download progress; present only while `status` is `starting`.",
        examples=[{"file": "de440s.bsp", "downloaded_bytes": 16777216, "total_bytes": 32726016}],
    )
    version: str = Field(
        description="Version of the `skyapi` package serving the request.",
        examples=["0.1.0"],
    )
