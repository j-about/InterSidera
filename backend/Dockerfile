# syntax=docker/dockerfile:1
# InterSidera API image: multi-stage with uv, bytecode compiled, locked non-dev sync, non-root,
# healthcheck on /api/v1/health (docs/architecture.md "Deployment"). Data is never baked in.
ARG PYTHON_IMAGE=python:3.14-slim

FROM ${PYTHON_IMAGE} AS builder
COPY --from=ghcr.io/astral-sh/uv:0.12.19 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_NO_PROGRESS=1
WORKDIR /app
# Layer 1: third-party dependencies (cached until uv.lock or pyproject.toml change).
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=.python-version,target=.python-version \
    --mount=type=bind,source=README.md,target=README.md \
    uv sync --locked --no-dev --no-install-project
# Layer 2: the project, built as a wheel by the bundled uv_build (non-editable: no src/ at run time).
COPY pyproject.toml uv.lock .python-version README.md ./
COPY src/ ./src/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable
# Size ladder rungs 3-4 (docs/architecture.md "Deployment"): vendored test suites and the pyarrow
# components the API never loads (Flight, cloud filesystems, ORC, C++ headers, the C++ test module).
# Never the parquet/dataset/compute/acero/substrait libraries: libarrow_python links them.
RUN set -eu; SP=/app/.venv/lib/python3.14/site-packages; \
    rm -rf "$SP/pandas/tests" "$SP/pyarrow/tests"; \
    find "$SP/numpy" -type d -name tests -prune -exec rm -rf {} +; \
    rm -rf "$SP/pyarrow/include" "$SP/pyarrow/includes" \
           "$SP"/pyarrow/*.pxd "$SP"/pyarrow/*.pyx \
           "$SP"/pyarrow/libarrow_flight.so* "$SP"/pyarrow/_flight.cpython-*.so \
           "$SP"/pyarrow/libarrow_python_flight.so* "$SP"/pyarrow/_pyarrow_cpp_tests.cpython-*.so \
           "$SP"/pyarrow/_s3fs.cpython-*.so "$SP"/pyarrow/_gcsfs.cpython-*.so \
           "$SP"/pyarrow/_azurefs.cpython-*.so "$SP"/pyarrow/_hdfs.cpython-*.so \
           "$SP"/pyarrow/_orc.cpython-*.so "$SP"/pyarrow/_dataset_orc.cpython-*.so

FROM ${PYTHON_IMAGE}
# Rung 2: pip and ensurepip are dead weight in a uv-managed image. Rung 5: the IDLE, Tk and turtle
# demo packages of the stdlib (no Tk library is installed in slim; nothing imports them). uid/gid
# 1000 match the development host; compose may override `user:`. passwd (useradd, groupadd) and
# login (/usr/sbin/nologin) are in debian:trixie-slim; adduser is not.
RUN set -eu; \
    rm -rf /usr/local/lib/python3.14/site-packages/pip /usr/local/lib/python3.14/site-packages/pip-*.dist-info \
           /usr/local/lib/python3.14/ensurepip /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.14 \
           /usr/local/lib/python3.14/idlelib /usr/local/lib/python3.14/tkinter /usr/local/lib/python3.14/turtledemo; \
    groupadd --gid 1000 skyapi; \
    useradd --uid 1000 --gid 1000 --no-log-init --no-create-home --shell /usr/sbin/nologin skyapi; \
    mkdir -p /data && chown 1000:1000 /data
WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/pyproject.toml /app/pyproject.toml
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp \
    SKYAPI_DATA_DIR=/data
EXPOSE 8000
USER 1000:1000
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --start-interval=5s --retries=3 \
    CMD ["python", "-c", "import sys, urllib.request as u; sys.exit(0 if u.build_opener(u.ProxyHandler({})).open('http://127.0.0.1:8000/api/v1/health', timeout=4).status == 200 else 1)"]
# Declared after the last RUN: a changed ARG invalidates every following RUN.
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="InterSidera API" \
      org.opencontainers.image.description="FastAPI + Skyfield sky API (skyapi)" \
      org.opencontainers.image.source="https://github.com/j-about/InterSidera" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}"
CMD ["fastapi", "run", "--host", "0.0.0.0", "--port", "8000"]
