"""Models for `GET /sky/frame` (brief api_contract l.157-169, D56).

Serialised with `exclude_unset=True` (D56): `minor[].samples` is set to `null` explicitly when
the orbit is unreliable, while `time.lst_hours`, `warnings[].params`, `warnings[].range_tt` and
`minor[].name` are simply not set when they do not apply.
"""

from pydantic import BaseModel, ConfigDict, Field

from skyapi.astro.warnings import WarningCode
from skyapi.models.catalogs import MinorBodyKind
from skyapi.models.meta import BodyKind, LatitudeKind

Vec3 = tuple[float, float, float]
Quat = tuple[float, float, float, float]


class _Record(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class WarningModel(_Record):
    """`{ code, params?, range_tt? }`: a closed list of codes, translated by the frontend."""

    code: WarningCode = Field(examples=["delta_t_approximate"])
    params: dict[str, float | int | str] | None = Field(
        default=None, description="Numbers a translation may need.", examples=[{"years": 10000}]
    )
    range_tt: tuple[float, float] | None = Field(
        default=None, description="Valid TT range when one exists."
    )


class FrameObserver(_Record):
    body: str = Field(description="Observer body id.", examples=["earth"])
    lat_deg: float = Field(description="Canonical latitude, degrees.", examples=[48.8566])
    lon_deg: float = Field(description="Canonical east longitude, degrees.", examples=[2.3522])
    elev_m: float = Field(description="Canonical elevation, metres.", examples=[35.0])
    latitude_kind: LatitudeKind
    warnings: list[WarningModel] = Field(
        description="`iau_rotation_approximate`, `pluto_barycenter`."
    )


class FrameTime(_Record):
    tt0: float = Field(description="Canonical TT Julian Date of the first sample.")
    step_s: int = Field(description="Step actually used after clamping, seconds.", examples=[300])
    n: int = Field(description="Number of samples.", examples=[32])
    tt_minus_utc_seconds: float = Field(
        description=("TT - UTC at `tt0` (TT - UT1 before 1972, when the display is labelled UT)."),
        examples=[69.184],
    )
    utc0: str = Field(
        description="`tt0` in UTC, ISO 8601 with astronomical year numbering.",
        examples=["2026-09-06T12:00:00Z"],
    )
    lst_hours: list[float] | None = Field(
        default=None,
        description="Local apparent sidereal time per sample in [0, 24); Earth only.",
    )
    warnings: list[WarningModel] = Field(
        description="`delta_t_approximate`, `proper_motion_extrapolated`."
    )


class QuaternionSeries(_Record):
    q: list[Quat] = Field(
        description="Unit quaternions `[x, y, z, w]` (Hamilton), sign-continuous along the window."
    )


class SamplesModel(_Record):
    dir: list[Vec3] = Field(description="Apparent ICRF unit vectors observer -> body.")
    dist_au: list[float] = Field(description="Distance observer -> body, au.")
    mag: list[float | None] = Field(description="Apparent V magnitude (null when unknown).")
    phase: list[float] = Field(description="Illuminated fraction in [0, 1].")
    diam_deg: list[float] = Field(description="Apparent angular diameter, degrees.")


class FrameBody(_Record):
    id: str = Field(examples=["mars"])
    kind: BodyKind
    samples: SamplesModel
    warnings: list[WarningModel] = Field(description="Empty at API v1.")


class FrameMinorBody(_Record):
    id: str = Field(examples=["a:1"])
    name: str | None = Field(default=None, examples=["Ceres"])
    kind: MinorBodyKind
    samples: SamplesModel | None = Field(
        default=None,
        description="Null when the elements are older than `error_years` (`mpc_unreliable`).",
    )
    elements_epoch_tt: float
    extrapolation_years: float = Field(
        description="Largest distance between the window and the elements epoch, Julian years."
    )
    warnings: list[WarningModel] = Field(description="`mpc_extrapolation`, `mpc_unreliable`.")


class FrameResponse(_Record):
    """One window of `n` samples spaced `step_s` seconds apart: rotations, bodies, minor bodies."""

    observer: FrameObserver
    time: FrameTime
    horizon: QuaternionSeries = Field(description="ICRF -> ENU per sample.")
    equinox_of_date: QuaternionSeries = Field(
        description="ICRF -> true equator and equinox of date per sample."
    )
    observer_velocity_au_d: list[Vec3] = Field(
        description="Barycentric velocity of the observer in ICRF, au/day (client-side aberration)."
    )
    sun_dir: list[Vec3] = Field(description="Apparent ICRF unit vector observer -> Sun.")
    bodies: list[FrameBody]
    minor: list[FrameMinorBody]
