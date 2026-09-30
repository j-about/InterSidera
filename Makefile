SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
MAKEFLAGS += --warn-undefined-variables --no-print-directory
.DEFAULT_GOAL := help
.DELETE_ON_ERROR:
# No .ONESHELL: each recipe line is independent and a failing line must abort the target.

UV ?= uv
FNM ?= fnm
NODE_VERSION_FILE := $(CURDIR)/.node-version
# Every Node invocation goes through fnm with the pinned version file, independent of the
# ambient shell and of FNM_VERSION_FILE_STRATEGY. CI may pass NODE_EXEC= (empty) to use PATH.
NODE_EXEC ?= $(FNM) exec --using=$(NODE_VERSION_FILE)
NPM := $(NODE_EXEC) npm --prefix frontend
NODE := $(NODE_EXEC) node
ENV_FILE := $(CURDIR)/.env
UV_ENV := $(if $(wildcard $(ENV_FILE)),--env-file $(ENV_FILE),)
# --directory (never --project): the working directory must be backend/ for fastapi, pytest,
# ruff and pyright to resolve their configuration.
PY := $(UV) run --directory backend
# Run targets only: load .env when present. Check and test targets never load it (hermetic).
PYRUN := $(UV) run --directory backend $(UV_ENV)
# pyright (PyPI) is a Node wrapper and needs node on PATH.
PYNODE := $(NODE_EXEC) $(UV) run --directory backend
GENERATED := docs/openapi.json frontend/src/api/schema.d.ts THIRD_PARTY_NOTICES.md frontend/src/data/credits.json
# scripts/ lies outside the frontend ESLint base path (ESLint 10 refuses such files), so every
# scripts/*.mjs is gated by `node --check` and prettier (the whole directory).
# Config-free flags: the frontend .prettierrc names the Tailwind plugin, which prettier resolves
# from the working directory (the repo root here).
SCRIPTS_PRETTIER := --no-config --print-width 100 --single-quote
# The pinned pip-audit of `make audit` (plan D151), run through `uv tool run` (what `uvx` aliases)
# rather than added to the dev group: its own tree would enlarge uv.lock and the audited surface.
PIP_AUDIT := pip-audit==2.10.1

.PHONY: help setup data dev dev-api dev-web check check-backend check-frontend check-i18n \
        check-delivery check-contract types notices test e2e build build-e2e audit lighthouse \
        images up down format
# hadolint as a pinned multi-arch image (ghcr avoids Docker Hub's anonymous pull limits); the same
# line in the CI docker job.
HADOLINT := ghcr.io/hadolint/hadolint:v2.15.1
COMPOSE := docker compose

help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | sort | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

setup: ## Install toolchains (Python 3.14, Node 24), dependencies and Playwright browsers
	$(UV) python install 3.14
	$(FNM) install $$(cat $(NODE_VERSION_FILE))
	$(UV) sync --directory backend
	$(NPM) ci
	$(NPM) exec -- playwright install chromium webkit
	@echo "Playwright system libraries are a one-time manual step (needs sudo), from the repository root:"
	@echo '  sudo env "PATH=$$PATH" fnm exec --using=24 npm --prefix frontend exec -- playwright install-deps'
	@test -f $(ENV_FILE) || cp .env.example .env

data: ## Download the data files into DATA_DIR and build the caches (sky-data fetch + build-caches)
	$(PYRUN) sky-data fetch
	$(PYRUN) sky-data build-caches

dev: ## Run the API and the Vite dev server together
	$(MAKE) -j2 dev-api dev-web

dev-api: ## Run the API with reload (http://127.0.0.1:8000/api/v1/health)
	$(PYRUN) fastapi dev

dev-web: ## Run the Vite dev server (https://localhost:5173, proxies /api)
	$(NPM) run dev

check: check-backend check-frontend check-i18n check-delivery check-contract ## Every quality gate (before each commit, and in CI)

check-backend:
	$(UV) lock --check --directory backend
	$(PY) ruff format --check .
	$(PY) ruff check .
	$(PY) ruff format --check --config pyproject.toml ../scripts
	$(PY) ruff check --config pyproject.toml ../scripts
	$(PYNODE) pyright
	$(PYNODE) pyright ../scripts/bench_api.py ../scripts/generate_fixtures.py
	$(PY) pytest -m "not slow" --cov=skyapi.astro --cov=skyapi.catalogs --cov-report=term-missing:skip-covered
	$(PY) coverage report --include='src/skyapi/astro/*' --fail-under=90
	$(PY) coverage report --include='src/skyapi/catalogs/*' --fail-under=90
	$(PY) coverage report --include='src/skyapi/astro/quaternions.py,src/skyapi/catalogs/formats.py' --fail-under=100

check-frontend:
	$(NPM) run typecheck
	$(NPM) run lint
	$(NPM) run test

check-i18n:
	for f in $(wildcard scripts/*.mjs); do $(NODE) --check $$f; done
	$(NPM) exec -- prettier $(SCRIPTS_PRETTIER) --check $(CURDIR)/scripts
	$(NODE) scripts/check_i18n.mjs

# The nginx tree diffed against frontend/security-headers.ts (hermetic: Node and committed files).
check-delivery:
	$(NODE) scripts/check_nginx_headers.mjs

check-contract: types notices
	git ls-files --error-unmatch -- $(GENERATED) >/dev/null
	git diff --exit-code -- $(GENERATED)

types: ## Regenerate docs/openapi.json and frontend/src/api/schema.d.ts
	$(PY) python -m skyapi.tools.dump_openapi --out $(CURDIR)/docs/openapi.json
	$(NPM) run gen:types

notices: ## Regenerate THIRD_PARTY_NOTICES.md and frontend/src/data/credits.json from the data registry
	$(PY) python -m skyapi.tools.render_notices --out $(CURDIR)/THIRD_PARTY_NOTICES.md --json $(CURDIR)/frontend/src/data/credits.json

test: ## Full test suites (pytest including slow and conformance, vitest)
	$(PY) pytest
	$(NPM) run test

e2e: build-e2e ## Playwright end-to-end tests against a locally started stack (the CI project list)
	$(NPM) run e2e -- --project=chromium-desktop --project=chromium-mobile

build: ## Production frontend build (never contains the window.__sky debug hook; AR, XR and WebGPU chunks lazy)
	$(NPM) run build
	! grep -rl "__sky" frontend/dist/assets
	$(NODE) scripts/check_chunks.mjs $(CURDIR)/frontend/dist

build-e2e: ## Test build exposing window.__sky for Playwright (vite build --mode e2e)
	$(NPM) run build:e2e

# Network and time-varying (brief l.276; plan D151; backlog B-86): outside `make check`, mirrored by
# the CI `audit` job. Both audits write JSON into one temporary directory, removed when the recipe
# ends (the `trap`, on failure too); their exit codes are theirs (npm exits 1 on any finding,
# pip-audit on any vulnerability) and scripts/check_audit.mjs reads both reports against
# scripts/audit-allowlist.json.
audit: ## Dependency audits (network): npm audit + pip-audit against scripts/audit-allowlist.json
	tmp=$$(mktemp -d /tmp/intersidera-audit.XXXXXX) && trap 'rm -rf "$$tmp"' EXIT && \
	  ($(NPM) audit --json --package-lock-only > $$tmp/npm-audit.json || true) && \
	  $(UV) export --quiet --directory backend --frozen --format requirements.txt --no-emit-project --no-hashes --all-groups -o $$tmp/requirements.txt && \
	  ($(UV) tool run $(PIP_AUDIT) -r $$tmp/requirements.txt --no-deps --strict --disable-pip --progress-spinner off -f json -o $$tmp/pip-audit.json || true) && \
	  $(NODE) scripts/check_audit.mjs --npm $$tmp/npm-audit.json --python $$tmp/pip-audit.json

# Lighthouse (plan D155) pinned through `npm exec --package=lighthouse@<version>` inside the script,
# never a root `npx`; reports land in reports/lighthouse/ (gitignored).
lighthouse: ## Accessibility audit with Lighthouse (needs the API on 8000 and the e2e preview on 4173: make dev-api, make build-e2e, npm --prefix frontend run preview)
	$(NODE) scripts/lighthouse.mjs

# The CI docker job's twin (Docker and network; never part of `make check`): lint both Dockerfiles,
# validate the compose files, build both images on the machine's architecture and run the checks of
# scripts/check_images.mjs (sizes, user, healthcheck, nginx -t, headers, data-less start).
images: ## Lint, build and check both container images (the CI docker job's twin; needs Docker)
	docker run --rm -i $(HADOLINT) < backend/Dockerfile
	docker run --rm -i $(HADOLINT) < frontend/Dockerfile
	docker build --check -f backend/Dockerfile backend
	docker build --check -f frontend/Dockerfile frontend
	$(COMPOSE) config -q
	$(COMPOSE) -f compose.yaml -f compose.tls.yaml config -q
	$(COMPOSE) -f compose.yaml -f compose.e2e.yaml config -q
	$(COMPOSE) build
	$(NODE) scripts/check_images.mjs --api intersidera-api:local --web intersidera-web:local

# compose reads ./.env itself (no --env-file). --wait returns once api is healthy and web started,
# exits 1 with "dependency failed to start: ... is unhealthy" or "application not healthy after 7m0s".
up: ## Build the images and start the stack (http://127.0.0.1/, health at /api/v1/health)
	@test -f $(ENV_FILE) || echo "make up: no .env: code defaults apply (de441.bsp, auto-fetch of 3.3 GB inside the api container; the api is reported unhealthy after about 6.5 min while the download continues). Run 'docker compose run --rm api sky-data fetch' first or copy .env.example to .env for de440s."
	$(COMPOSE) up --build --detach --wait --wait-timeout 420
	@echo "up: app http://127.0.0.1/  health http://127.0.0.1/api/v1/health  logs: docker compose logs -f api"

down: ## Stop and remove the containers and the network; the data directory is kept (never -v)
	$(COMPOSE) down

format: ## Format and auto-fix backend, frontend and scripts/ sources
	$(PY) ruff format .
	$(PY) ruff check --fix .
	$(NPM) run format
	$(NPM) exec -- prettier $(SCRIPTS_PRETTIER) --write $(CURDIR)/scripts
