"""Models for `GET /meta` (brief api_contract l.115-129, D60).

`MetaStatic` holds everything that does not change between requests; the bootstrap builds it
once (`skyapi/meta.py`) and the route adds `server_time`.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from skyapi.astro.warnings import WarningCode

LatitudeKind = Literal["geodetic", "planetocentric"]
BodyKind = Literal["star", "planet", "dwarf_planet", "moon"]
ObserverId = Literal[
    "mercury", "venus", "earth", "moon", "mars", "jupiter", "saturn", "uranus", "neptune", "pluto"
]

TtRange = tuple[float, float]


class _Record(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class ServerTime(_Record):
    tt: float = Field(description="Server wall clock as a TT Julian Date.", examples=[2461285.5])
    utc: str = Field(
        description="The same instant in UTC, ISO 8601 with astronomical year numbering.",
        examples=["2026-09-06T12:00:00Z"],
    )
    tt_minus_utc_seconds: float = Field(
        description="TT - UTC at that instant (69.184 s in 2026).", examples=[69.184]
    )


class EphemerisMeta(_Record):
    name: str = Field(description="Ephemeris file in use.", examples=["de441.bsp"])
    coverage_tt: TtRange = Field(
        description="TT Julian Date range the ephemeris serves (light-time margin applied).",
        examples=[[-3100014.5, 8000015.5]],
    )


class ObserverMeta(_Record):
    id: ObserverId = Field(examples=["mars"])
    name_key: str = Field(description="Translation key of the body name.", examples=["bodies.mars"])
    frame: str = Field(
        description="SPICE/IAU frame of the body-fixed coordinates.",
        examples=["IAU_MARS"],
    )
    radii_km: tuple[float, float, float] = Field(
        description="IAU reference ellipsoid radii (a, b, c) in km.",
        examples=[[3396.19, 3396.19, 3376.2]],
    )
    latitude_kind: LatitudeKind = Field(
        description="Geodetic (WGS84, Earth) or planetocentric latitude."
    )
    coverage_tt: TtRange = Field(
        description="TT range this observer can be served in (ephemeris and frame kernels)."
    )
    approximation_code: WarningCode | None = Field(
        default=None,
        description="Set when the observer is approximated (`pluto_barycenter`).",
        examples=["pluto_barycenter"],
    )


class DeltaTCoverageMeta(_Record):
    observed_tt: TtRange = Field(
        description="TT range where delta T comes from historical tables and IERS measurements."
    )
    predicted_until_tt: float = Field(description="End of the IERS Bulletin A predictions.")


class MpcElementsMeta(_Record):
    warn_years: int = Field(
        description="Years from the elements epoch beyond which `mpc_extrapolation` is raised.",
        examples=[2],
    )
    error_years: int = Field(
        description="Years beyond which `mpc_unreliable` is raised and samples are null.",
        examples=[50],
    )


class CoverageMeta(_Record):
    ephemeris_tt: TtRange
    delta_t: DeltaTCoverageMeta
    iau_rotation_reliable_tt: TtRange = Field(
        description="Span the IAU rotation models are fitted to (1800..2200)."
    )
    proper_motion_warning_years: int = Field(examples=[10000])
    mpc_elements: MpcElementsMeta


class BodyMeta(_Record):
    id: str = Field(examples=["jupiter"])
    kind: BodyKind
    name_key: str = Field(examples=["bodies.jupiter"])
    radius_km: float = Field(description="Equatorial radius (IAU), km.", examples=[71492.0])
    step_class: str = Field(
        description="Key of `limits.max_step_s` that bounds `step_s` when this body is requested.",
        examples=["sun_and_outer"],
    )


class StarsCatalogMeta(_Record):
    count: int = Field(examples=[117955])
    version: str = Field(description="Cache format and source hash.", examples=["1-0123456789ab"])
    etag: str = Field(
        description="SHA-256 of `/catalogs/stars` (the header carries it quoted).",
    )
    epoch_tt: float = Field(description="Catalog epoch, TT Julian Date.", examples=[2451545.0])
    magnitude_limit: float = Field(description="Faintest V magnitude in the catalog.")
    license: str
    attribution: str


class DsoCatalogMeta(_Record):
    count: int = Field(examples=[5229])
    version: str
    etag: str
    license: str
    attribution: str


class ConstellationsCatalogMeta(_Record):
    count: int = Field(examples=[88])
    culture: Literal["modern"] = "modern"
    etag: str
    license: str
    attribution: str


class MinorBodiesCatalogMeta(_Record):
    asteroids: int = Field(examples=[1562091])
    comets: int = Field(examples=[957])
    elements_epoch_range_tt: TtRange = Field(
        description="TT range of the orbital-element epochs in the MPC tables."
    )
    license: str
    attribution: str


class CatalogsMeta(_Record):
    stars: StarsCatalogMeta
    dso: DsoCatalogMeta | None = Field(
        default=None, description="Absent while the DSO data is missing (degraded)."
    )
    constellations: ConstellationsCatalogMeta | None = Field(
        default=None, description="Absent while the constellation data is missing (degraded)."
    )
    minor_bodies: MinorBodiesCatalogMeta | None = Field(
        default=None, description="Absent while the MPC data is missing (degraded)."
    )


class GeocoderMeta(_Record):
    enabled: bool
    url: str = Field(examples=["https://nominatim.openstreetmap.org"])
    email: str | None = Field(
        default=None, description="Contact e-mail to send as the Nominatim `email` parameter."
    )
    attribution: str = Field(examples=["Geocoding: (c) OpenStreetMap contributors, via Nominatim"])
    min_interval_ms: int = Field(
        description="Minimum interval between two geocoder requests.", examples=[1000]
    )


class MaxStepMeta(_Record):
    moon: int = Field(examples=[3600])
    inner_planets: int = Field(examples=[21600])
    sun_and_outer: int = Field(examples=[86400])
    minor: int = Field(examples=[86400])


class LimitsMeta(_Record):
    max_samples: int = Field(examples=[64])
    max_minor_bodies: int = Field(examples=[100])
    max_targets: int = Field(examples=[200])
    speeds: list[int] = Field(
        description="Time-lapse speeds offered by the reference frontend (and their negatives).",
        examples=[[1, 10, 60, 600, 3600, 86400, 604800, 2629800, 31557600]],
    )
    max_step_s: MaxStepMeta


class MetaStatic(_Record):
    """Every `/meta` field but `server_time`; built once at bootstrap."""

    api_version: str = Field(
        description="Semantic version of the API contract.", examples=["1.0.0"]
    )
    ephemeris: EphemerisMeta
    observers: list[ObserverMeta]
    coverage: CoverageMeta
    bodies: list[BodyMeta]
    catalogs: CatalogsMeta
    geocoder: GeocoderMeta
    limits: LimitsMeta


class MetaResponse(_Record):
    """Body of `GET /meta`: contract version, server time, coverage, catalogs and limits."""

    api_version: str = Field(
        description="Semantic version of the API contract.", examples=["1.0.0"]
    )
    server_time: ServerTime
    ephemeris: EphemerisMeta
    observers: list[ObserverMeta]
    coverage: CoverageMeta
    bodies: list[BodyMeta]
    catalogs: CatalogsMeta
    geocoder: GeocoderMeta
    limits: LimitsMeta
