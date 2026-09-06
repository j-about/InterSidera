"""Model for `GET /sky/altaz` (brief api_contract l.171-172, D58)."""

from pydantic import BaseModel, ConfigDict, Field


class AltAzEntry(BaseModel):
    """Authoritative Skyfield values for one target at one instant."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str = Field(
        description="Target id as requested: `hip:<n>`, `dso:<id>`, a body id, `a:<..>`, `c:<..>`.",
        examples=["hip:32349"],
    )
    alt_deg: float = Field(description="Altitude, degrees (refracted only when requested).")
    az_deg: float = Field(description="Azimuth from north through east, degrees in [0, 360).")
    ra_icrs_deg: float = Field(description="ICRS right ascension, degrees in [0, 360).")
    dec_icrs_deg: float = Field(description="ICRS declination, degrees.")
    ra_date_deg: float = Field(
        description="Right ascension on the true equator and equinox of date, degrees in [0, 360)."
    )
    dec_date_deg: float = Field(description="Declination of date, degrees.")
    dist_au: float | None = Field(
        default=None, description="Distance, au (bodies and minor bodies)."
    )
    mag: float | None = Field(default=None, description="Apparent V magnitude when known.")
    phase: float | None = Field(
        default=None, description="Illuminated fraction (bodies and minor bodies)."
    )
    diam_deg: float | None = Field(
        default=None, description="Apparent angular diameter, degrees (bodies only)."
    )
