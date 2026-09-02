"""Runtime settings, read once from `SKYAPI_*` environment variables (brief l.397).

There is deliberately no `env_file`: `make` passes `--env-file .env` to `uv run` on run
targets only (D9), so `make check`, pytest and CI never read a developer's `.env`.
"""

from pathlib import Path
from typing import Annotated, Literal

from pydantic import BeforeValidator, Field
from pydantic_settings import (
    BaseSettings,
    NoDecode,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)

LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR"]


def _split_csv(value: object) -> object:
    """Turn a comma-separated string into a list of non-empty, stripped items.

    Anything that is not a string (already a list, for example) is returned unchanged so
    that pydantic reports a normal validation error for genuinely wrong types.
    """
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return value


# D18: pydantic-settings JSON-decodes list fields by default; `NoDecode` hands the raw
# environment string to the validator so `SKYAPI_CORS_ORIGINS=a,b` works as documented.
CsvList = Annotated[list[str], NoDecode, BeforeValidator(_split_csv)]


class Settings(BaseSettings):
    """Every `SKYAPI_` variable of the brief with a safe default (`.env.example` mirrors it)."""

    # `env_ignore_empty`: an empty value such as `SKYAPI_GEOCODER_EMAIL=` in `.env` means
    # "unset", so the code default applies instead of an empty string.
    model_config = SettingsConfigDict(
        env_prefix="SKYAPI_", extra="ignore", frozen=True, env_ignore_empty=True
    )

    # D17: every backend command runs with `--directory backend` (CWD = backend/), so the
    # relative default resolves to the gitignored root `data/` directory of the brief's
    # layout, not to the committed `backend/data/` registry files.
    data_dir: Path = Path("../data")
    # Production value (brief environment l.18); `.env.example` and CI select `de440s.bsp`.
    ephemeris: str = "de441.bsp"
    auto_fetch: bool = True
    workers: int = Field(default=1, ge=1)
    rate_limit_rps: float = Field(default=20, gt=0)
    rate_limit_burst: int = Field(default=40, ge=1)
    geocoder_url: str = "https://nominatim.openstreetmap.org"
    geocoder_enabled: bool = True
    geocoder_email: str | None = None
    cors_origins: CsvList = ["https://localhost:5173"]
    log_level: LogLevel = "INFO"


class _DefaultsOnly(Settings):
    """`Settings` that never reads the environment: code defaults only."""

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        return (init_settings,)


def default_settings() -> Settings:
    """Settings built from code defaults alone, whatever `SKYAPI_*` variables are exported.

    For tools where the environment must not matter: `dump_openapi` (D27, the OpenAPI document
    is settings-independent, so `make types` must not fail on an unrelated invalid variable).
    """
    return _DefaultsOnly()
