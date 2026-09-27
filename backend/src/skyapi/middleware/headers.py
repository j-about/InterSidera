"""Security headers on every API response (plan D149; brief l.274, l.276; backlog B-87).

Pure ASGI (never `BaseHTTPMiddleware`), added to `create_app` outside `CORSMiddleware`, which
answers preflights itself without calling the inner app: placed there, the headers land on
preflights, on problem documents and on 304s alike (D63 amended). Two headers, appended only when
the response does not carry them already: `X-Content-Type-Options: nosniff` (a browser never
re-types a catalog file or a JSON document) and a `Content-Security-Policy` that denies everything
(`default-src 'none'`, no framing, no `<base>`), which is what a document that executes nothing
should declare when a browser opens an API URL directly. The Swagger page (`app.docs_url`) alone,
and only its GET (the HTML document; a 405 problem document on another method is JSON and stays
strict), gets the relaxed policy its jsdelivr assets, inline init script and favicon need (plan
D150: the page is hidden by nginx in production, the API container still serves it).

The brief assigns the headers to nginx (l.274); the API adds these two because the dev and
preview servers proxy `/api` upstream headers unchanged, so nothing else can put `nosniff` on the
API in those stacks (B-87). At M7 nginx adds the full web-tier set on `/api` too; the API's own
values are then a second, identical-or-stricter policy the browser intersects with the first.

Starlette's ServerErrorMiddleware sits outside every user middleware, so the 500 handler of
`middleware/problem.py` adds the same two headers itself through `security_headers()`.
"""

from starlette.types import ASGIApp, Message, Receive, Scope, Send

NOSNIFF_HEADER = "x-content-type-options"
CSP_HEADER = "content-security-policy"

#: Every response but the Swagger page: nothing may load, frame or re-base the document.
API_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
#: The Swagger page (fastapi/openapi/docs.py): the swagger-ui-dist bundle and stylesheet from
#: jsdelivr, FastAPI's inline init script, the favicon from fastapi.tiangolo.com, the `data:`
#: images of the UI and the same-origin `/api/v1/openapi.json` fetch. Never `sandbox`.
DOCS_POLICY = (
    "default-src 'none'; "
    "script-src https://cdn.jsdelivr.net 'unsafe-inline'; "
    "style-src https://cdn.jsdelivr.net 'unsafe-inline'; "
    "img-src https://fastapi.tiangolo.com data:; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; "
    "base-uri 'none'"
)


def security_headers(policy: str = API_POLICY) -> dict[str, str]:
    """The two headers as a response `headers=` mapping (the 500 handler, tests)."""
    return {"X-Content-Type-Options": "nosniff", "Content-Security-Policy": policy}


def _route_path(scope: Scope) -> str:
    """`scope["path"]` without the mount prefix (what Starlette's router matches routes on)."""
    path = str(scope.get("path", ""))
    root_path = str(scope.get("root_path", ""))
    if not root_path or not path.startswith(root_path):
        return path
    if path == root_path:
        return ""
    if path[len(root_path)] == "/":
        return path[len(root_path) :]
    return path


class SecurityHeadersMiddleware:
    """`nosniff` and the deny-all CSP on every response; the docs policy on GET `docs_path`."""

    def __init__(self, app: ASGIApp, *, docs_path: str | None = None) -> None:
        self.app = app
        self.docs_path = docs_path

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        is_docs = (
            self.docs_path is not None
            and scope.get("method") == "GET"
            and _route_path(scope) == self.docs_path
        )
        wanted = security_headers(DOCS_POLICY if is_docs else API_POLICY)

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                present = {name.lower() for name, _ in headers}
                for name, value in wanted.items():
                    key = name.lower().encode("latin-1")
                    if key not in present:
                        headers.append((key, value.encode("latin-1")))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_wrapper)
