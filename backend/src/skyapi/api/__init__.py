"""HTTP layer: versioned routers that validate, canonicalize, call `astro/` and serialize.

Routers never import Skyfield (brief repository_layout l.357). `API_VERSION` is the semantic
version of the API contract (brief l.182), exposed by `/meta.api_version`; it changes when the
contract does, together with `docs/openapi.json` and the generated TypeScript types.
"""

API_VERSION = "1.1.0"
