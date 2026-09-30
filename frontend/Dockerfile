# syntax=docker/dockerfile:1
# InterSidera web image: node:24 build stage, then nginx:stable-alpine-slim serving dist/ with
# frontend/nginx.conf and the rendered templates (docs/architecture.md "Deployment").
ARG NODE_IMAGE=node:24
ARG NGINX_IMAGE=nginx:stable-alpine-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
# `build` (production, default) or `build:e2e` (compose.e2e.yaml only: the window.__sky hook).
ARG BUILD_SCRIPT=build
RUN npm run "$BUILD_SCRIPT" \
    && if [ "$BUILD_SCRIPT" = "build" ] && grep -rl "__sky" dist/assets; then echo "debug hook in production build" >&2; exit 1; fi \
    && rm -rf dist/.vite \
    && find dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.svg' -o -name '*.webmanifest' -o -name '*.html' -o -name '*.json' \) \
         -exec sh -c 'for f; do gzip -9 -k -n "$f" && touch -r "$f" "$f.gz" || exit 1; done' _ {} +

FROM ${NGINX_IMAGE}
# The stock :80 server and welcome pages would compete with ours.
RUN rm -f /etc/nginx/conf.d/default.conf && rm -rf /usr/share/nginx/html/*
COPY nginx.conf /etc/nginx/nginx.conf
COPY nginx/templates/ /etc/nginx/templates/
COPY nginx/sky/ /etc/nginx/sky/
COPY --from=build /app/dist/ /usr/share/nginx/html/
# envsubst substitutes DEFINED variables only (filter ^SKY_): image defaults keep the templates
# renderable; compose overrides them from .env.
ENV SKY_GEOCODER_ORIGIN=https://nominatim.openstreetmap.org \
    SKY_WEB_MODE=http \
    NGINX_ENVSUBST_FILTER=^SKY_ \
    NGINX_ENTRYPOINT_QUIET_LOGS=1
EXPOSE 443
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --start-interval=2s --retries=3 \
    CMD ["wget", "-q", "--spider", "http://127.0.0.1:80/healthz"]
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="InterSidera web" \
      org.opencontainers.image.description="nginx serving the InterSidera SPA and proxying /api" \
      org.opencontainers.image.source="https://github.com/j-about/InterSidera" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}"
