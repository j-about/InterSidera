"""Settings parsing: prefix, CSV lists, defaults, validation, unknown variables."""

from pathlib import Path

import pytest
from pydantic import ValidationError

from skyapi.settings import Settings, default_settings

pytestmark = pytest.mark.unit


def test_variables_are_read_with_the_skyapi_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SKYAPI_LOG_LEVEL", "DEBUG")

    assert Settings().log_level == "DEBUG"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("a, b", ["a", "b"]),
        (
            "https://localhost:5173,https://example.org/",
            ["https://localhost:5173", "https://example.org/"],
        ),
        (" , ", []),
    ],
)
def test_cors_origins_is_a_comma_separated_list(
    monkeypatch: pytest.MonkeyPatch, raw: str, expected: list[str]
) -> None:
    monkeypatch.setenv("SKYAPI_CORS_ORIGINS", raw)

    assert Settings().cors_origins == expected


def test_defaults_match_the_brief() -> None:
    settings = Settings()

    # Production ephemeris (brief environment l.18); CI and `.env.example` choose de440s.
    assert settings.ephemeris == "de441.bsp"
    # D17: relative to backend/, the CWD of every backend command -> root `data/`.
    assert settings.data_dir == Path("../data")
    assert settings.auto_fetch is True
    assert settings.workers == 1
    assert settings.rate_limit_rps == 20
    assert settings.rate_limit_burst == 40
    assert settings.geocoder_url == "https://nominatim.openstreetmap.org"
    assert settings.geocoder_enabled is True
    assert settings.geocoder_email is None
    assert settings.cors_origins == ["https://localhost:5173"]
    assert settings.log_level == "INFO"


def test_invalid_log_level_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SKYAPI_LOG_LEVEL", "VERBOSE")

    with pytest.raises(ValidationError):
        Settings()


def test_out_of_range_values_are_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SKYAPI_WORKERS", "0")

    with pytest.raises(ValidationError):
        Settings()


def test_unknown_prefixed_variables_are_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SKYAPI_NOT_A_SETTING", "whatever")

    assert Settings().log_level == "INFO"


def test_explicit_arguments_win_over_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SKYAPI_EPHEMERIS", "de441.bsp")

    assert Settings(ephemeris="de440s.bsp").ephemeris == "de440s.bsp"


def test_empty_environment_values_mean_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    # `.env.example` ships `SKYAPI_GEOCODER_EMAIL=`; `env_ignore_empty` turns that into the default.
    monkeypatch.setenv("SKYAPI_GEOCODER_EMAIL", "")
    monkeypatch.setenv("SKYAPI_CORS_ORIGINS", "")

    settings = Settings()

    assert settings.geocoder_email is None
    assert settings.cors_origins == ["https://localhost:5173"]


def test_common_environment_spellings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SKYAPI_AUTO_FETCH", "false")  # CI and playwright.config.ts
    monkeypatch.setenv("SKYAPI_DATA_DIR", "/srv/sky-data")
    monkeypatch.setenv("SKYAPI_GEOCODER_EMAIL", "ops@example.org")

    settings = Settings()

    assert settings.auto_fetch is False
    assert settings.data_dir == Path("/srv/sky-data")
    assert settings.geocoder_email == "ops@example.org"


def test_default_settings_ignore_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SKYAPI_WORKERS", "0")
    monkeypatch.setenv("SKYAPI_LOG_LEVEL", "bogus")

    settings = default_settings()

    assert settings.workers == 1
    assert settings.log_level == "INFO"
