"""Models of the catalog artifacts (brief api_contract l.141-155).

`catalogs/builders.py` validates every record against these models when it writes the cache
files at `sky-data build-caches` time, and the M2 routers serve the same shapes, so the builder
output and the OpenAPI schema cannot drift apart. No route references them at M1, which keeps
`docs/openapi.json` unchanged.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

DsoType = Literal[
    "galaxy", "open_cluster", "globular_cluster", "planetary_nebula", "nebula", "other"
]
MinorBodyKind = Literal["asteroid", "comet"]


class _Record(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class StarNames(_Record):
    """Names of a designated star; every field is optional but at least one is present."""

    proper: str | None = Field(
        default=None,
        description="IAU proper name (HYG `proper`), never translated.",
        examples=["Betelgeuse"],
    )
    bayer: str | None = Field(
        default=None,
        description="Bayer designation: Greek letter, optional superscript, IAU abbreviation.",
        examples=["α Ori"],
    )
    flamsteed: str | None = Field(
        default=None,
        description="Flamsteed designation: number and IAU abbreviation.",
        examples=["58 Ori"],
    )


class StarIndexEntry(_Record):
    """One row of `GET /catalogs/stars/index` (brief l.141-142)."""

    hip: int = Field(ge=1, description="Hipparcos identifier.", examples=[27989])
    names: StarNames
    con: str = Field(
        min_length=3,
        max_length=3,
        description="IAU constellation abbreviation.",
        examples=["Ori"],
    )


class DsoEntry(_Record):
    """One row of `GET /catalogs/dso` (brief l.144-146): an OpenNGC object, J2000."""

    id: str = Field(
        description=(
            "Canonical OpenNGC id: catalog prefix plus number without zero padding, spaces "
            "replaced by `_` (`NGC224`, `IC434`, `Mel22`)."
        ),
        examples=["NGC7000"],
    )
    names: list[str] = Field(
        description="Common names from OpenNGC.", examples=[["North America Nebula"]]
    )
    messier: int | None = Field(
        default=None, ge=1, le=110, description="Messier number.", examples=[31]
    )
    type: DsoType = Field(description="Object class mapped from the OpenNGC type code.")
    ra_deg: float = Field(ge=0.0, lt=360.0, description="ICRS right ascension, degrees.")
    dec_deg: float = Field(ge=-90.0, le=90.0, description="ICRS declination, degrees.")
    mag: float | None = Field(default=None, description="V magnitude, else B magnitude.")
    major_arcmin: float | None = Field(default=None, ge=0.0, description="Major axis, arcminutes.")
    minor_arcmin: float | None = Field(default=None, ge=0.0, description="Minor axis, arcminutes.")
    pa_deg: float | None = Field(
        default=None, ge=0.0, lt=360.0, description="Major-axis position angle, north through east."
    )
    con: str = Field(min_length=3, max_length=3, description="IAU constellation abbreviation.")


class ConstellationLabel(_Record):
    ra_deg: float = Field(ge=0.0, lt=360.0)
    dec_deg: float = Field(ge=-90.0, le=90.0)


class ConstellationEntry(_Record):
    """One constellation of `GET /catalogs/constellations` (brief l.148-150)."""

    abbr: str = Field(min_length=3, max_length=3, examples=["Ori"])
    latin: str = Field(examples=["Orion"])
    genitive: str = Field(examples=["Orionis"])
    lines: list[tuple[int, int]] = Field(
        description="Line segments as pairs of Hipparcos identifiers (Stellarium `modern`).",
    )
    boundary: list[tuple[float, float]] = Field(
        description="IAU boundary polygon, ICRS J2000 `[ra_deg, dec_deg]` vertices, closed ring.",
    )
    boundary_parts: list[list[tuple[float, float]]] | None = Field(
        default=None,
        description=(
            "Every boundary polygon when the constellation has more than one (Serpens); "
            "`boundary` then holds the first part. Absent otherwise."
        ),
    )
    label: ConstellationLabel = Field(description="Suggested label position.")


class ConstellationsResponse(_Record):
    """Body of `GET /catalogs/constellations`."""

    culture: Literal["modern"] = "modern"
    constellations: list[ConstellationEntry]


class MinorBodySummary(_Record):
    """One row of `/minor-bodies/search` and `/minor-bodies/defaults` (brief l.152-155)."""

    id: str = Field(
        description="`a:<number>`, `a:<packed designation>` or `c:<designation>` (URL-safe).",
        examples=["a:1", "c:1P"],
    )
    designation: str = Field(examples=["(1) Ceres"])
    name: str | None = Field(default=None, examples=["Ceres"])
    kind: MinorBodyKind
    h_mag: float | None = Field(default=None, description="Absolute magnitude H (asteroids).")
    elements_epoch_tt: float = Field(description="Epoch of the orbital elements, TT Julian Date.")
