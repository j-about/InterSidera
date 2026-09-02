"""Typed FastAPI dependencies giving routes access to the lifespan state (D11)."""

from typing import Annotated

from fastapi import Depends, Request

from skyapi.state import SkyState


def get_sky_state(request: Request) -> SkyState:
    """Return the `SkyState` the lifespan placed in the request scope.

    Starlette exposes the lifespan mapping through `request.state`, a `State` wrapper with
    attribute access only (no `__getitem__`), hence `getattr` rather than a subscript.
    A missing or foreign value means the app was built without its lifespan running
    (e.g. `TestClient` used outside a `with` block), which is a programming error.
    """
    sky = getattr(request.state, "sky", None)
    if not isinstance(sky, SkyState):
        raise RuntimeError("lifespan did not run")
    return sky


SkyStateDep = Annotated[SkyState, Depends(get_sky_state)]
