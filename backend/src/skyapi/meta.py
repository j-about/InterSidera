"""The static part of `GET /meta`, built once by the bootstrap (D60, brief l.115-129).

Everything but `server_time` is known when the data is loaded: coverage ranges from the kernels
and the delta T tables, catalog identities from `cache/manifest.json`, licenses and attributions
from the data registry, limits from `astro/sampling.py`.
"""

import logging
from typing import cast

import numpy as np

from skyapi.api import API_VERSION
from skyapi.astro.minor_bodies import MinorBodyState
from skyapi.astro.observers import ObserverUnavailableError, observer_coverage
from skyapi.astro.sampling import (
    MAX_MINOR_BODIES,
    MAX_SAMPLES,
    MAX_STEP_S,
    MAX_TARGETS,
    SPEEDS,
)
from skyapi.astro.state import AstroState
from skyapi.astro.time import (
    IAU_ROTATION_RELIABLE_TT,
    MPC_ERROR_YEARS,
    MPC_WARN_YEARS,
    PROPER_MOTION_WARNING_YEARS,
    delta_t_coverage,
)
from skyapi.catalogs.state import ArtifactIdentity, CatalogState, CatalogStateError
from skyapi.data.registry import Registry
from skyapi.models.meta import (
    BodyMeta,
    CatalogsMeta,
    ConstellationsCatalogMeta,
    CoverageMeta,
    DeltaTCoverageMeta,
    DsoCatalogMeta,
    EphemerisMeta,
    GeocoderMeta,
    LimitsMeta,
    MaxStepMeta,
    MetaStatic,
    MinorBodiesCatalogMeta,
    MpcElementsMeta,
    ObserverId,
    ObserverMeta,
    StarsCatalogMeta,
)
from skyapi.settings import Settings

logger = logging.getLogger(__name__)

# Brief l.193 (OBS-4): at least one second between two Nominatim requests.
GEOCODER_MIN_INTERVAL_MS = 1000


def _identity(catalogs: CatalogState, name: str) -> ArtifactIdentity:
    identity = catalogs.identities.get(name)
    if identity is None:
        raise CatalogStateError(
            f"cache/manifest.json carries no {name!r} artifact: run `sky-data build-caches`"
        )
    return identity


def _stars_meta(registry: Registry, catalogs: CatalogState) -> StarsCatalogMeta:
    identity = _identity(catalogs, "stars")
    hipparcos = registry.by_key("hipparcos")
    hyg = registry.by_key("hyg")
    limit = identity.meta.get("magnitude_limit")
    magnitude_limit = (
        float(limit)
        if isinstance(limit, int | float) and not isinstance(limit, bool)
        else float(catalogs.stars.mag[-1]) / 1000.0
    )
    # Brief l.311: the derived name index is share-alike, so the stars catalog declares the HYG
    # license; the attribution credits both sources.
    return StarsCatalogMeta(
        count=catalogs.stars.count,
        version=identity.version,
        etag=identity.sha256,
        epoch_tt=catalogs.stars.epoch_tt,
        magnitude_limit=magnitude_limit,
        license=hyg.license,
        attribution=f"{hipparcos.attribution}; {hyg.attribution}",
    )


def _dso_meta(registry: Registry, catalogs: CatalogState) -> DsoCatalogMeta | None:
    if catalogs.dso is None:
        return None
    identity = _identity(catalogs, "dso")
    ngc = registry.by_key("ngc")
    return DsoCatalogMeta(
        count=len(catalogs.dso.entries),
        version=identity.version,
        etag=identity.sha256,
        license=ngc.license,
        attribution=ngc.attribution,
    )


def _constellations_meta(
    registry: Registry, catalogs: CatalogState
) -> ConstellationsCatalogMeta | None:
    if catalogs.constellations is None:
        return None
    identity = _identity(catalogs, "constellations")
    stellarium = registry.by_key("stellarium_modern")
    bounds = registry.by_key("d3_bounds")
    return ConstellationsCatalogMeta(
        count=len(catalogs.constellations.constellations),
        culture=catalogs.constellations.culture,
        etag=identity.sha256,
        license=identity.declared_license or stellarium.license,
        attribution=f"{stellarium.attribution}; {bounds.attribution}",
    )


def _minor_bodies_meta(
    registry: Registry, minor: MinorBodyState | None
) -> MinorBodiesCatalogMeta | None:
    if minor is None:
        return None
    mpcorb = registry.by_key("mpcorb")
    is_comet = minor.index.is_comet
    epochs = minor.index.elements_epoch_tt
    finite = epochs[np.isfinite(epochs)]
    epoch_range = (float(finite.min()), float(finite.max())) if finite.size else (0.0, 0.0)
    return MinorBodiesCatalogMeta(
        asteroids=int(np.count_nonzero(~is_comet)),
        comets=int(np.count_nonzero(is_comet)),
        elements_epoch_range_tt=epoch_range,
        license=mpcorb.license,
        attribution=mpcorb.attribution,
    )


def _observers_meta(astro: AstroState) -> list[ObserverMeta]:
    observers: list[ObserverMeta] = []
    for spec in astro.observers.values():
        try:
            coverage = observer_coverage(astro, spec.id)
        except ObserverUnavailableError as exc:
            logger.warning("observer %s not served: %s", spec.id, exc)
            continue
        observers.append(
            ObserverMeta(
                id=cast(ObserverId, spec.id),
                name_key=spec.name_key,
                frame=spec.frame_name,
                radii_km=spec.radii_km,
                latitude_kind=spec.latitude_kind,
                coverage_tt=coverage,
                approximation_code=spec.approximation_code,
            )
        )
    return observers


def build_meta_static(
    settings: Settings,
    registry: Registry,
    astro: AstroState,
    catalogs: CatalogState,
    minor: MinorBodyState | None,
) -> MetaStatic:
    """Assemble every `/meta` field but `server_time` from the loaded states and the registry."""
    coverage = delta_t_coverage(astro.ts)
    return MetaStatic(
        api_version=API_VERSION,
        ephemeris=EphemerisMeta(name=astro.ephemeris_name, coverage_tt=astro.ephemeris_coverage_tt),
        observers=_observers_meta(astro),
        coverage=CoverageMeta(
            ephemeris_tt=astro.ephemeris_coverage_tt,
            delta_t=DeltaTCoverageMeta(
                observed_tt=coverage.observed_tt, predicted_until_tt=coverage.predicted_until_tt
            ),
            iau_rotation_reliable_tt=IAU_ROTATION_RELIABLE_TT,
            proper_motion_warning_years=PROPER_MOTION_WARNING_YEARS,
            mpc_elements=MpcElementsMeta(warn_years=MPC_WARN_YEARS, error_years=MPC_ERROR_YEARS),
        ),
        bodies=[
            BodyMeta(
                id=spec.id,
                kind=spec.kind,
                name_key=spec.name_key,
                radius_km=spec.radius_km,
                step_class=spec.step_class,
            )
            for spec in astro.bodies.values()
        ],
        catalogs=CatalogsMeta(
            stars=_stars_meta(registry, catalogs),
            dso=_dso_meta(registry, catalogs),
            constellations=_constellations_meta(registry, catalogs),
            minor_bodies=_minor_bodies_meta(registry, minor),
        ),
        geocoder=GeocoderMeta(
            enabled=settings.geocoder_enabled,
            url=settings.geocoder_url,
            email=settings.geocoder_email,
            attribution=registry.by_key("nominatim").attribution,
            min_interval_ms=GEOCODER_MIN_INTERVAL_MS,
        ),
        limits=LimitsMeta(
            max_samples=MAX_SAMPLES,
            max_minor_bodies=MAX_MINOR_BODIES,
            max_targets=MAX_TARGETS,
            speeds=list(SPEEDS),
            max_step_s=MaxStepMeta(
                moon=MAX_STEP_S["moon"],
                inner_planets=MAX_STEP_S["inner_planets"],
                sun_and_outer=MAX_STEP_S["sun_and_outer"],
                minor=MAX_STEP_S["minor"],
            ),
        ),
    )
