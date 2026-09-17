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
# scripts/ lies outside the frontend ESLint base path (ESLint 10 refuses such files), so it is
# gated by `node --check` and prettier (the whole directory, so check_chunks.mjs included).
# Config-free flags: the frontend .prettierrc names the Tailwind plugin, which prettier resolves
# from the working directory (the repo root here).
SCRIPTS_PRETTIER := --no-config --print-width 100 --single-quote

.PHONY: help setup data dev dev-api dev-web check check-backend check-frontend check-i18n \
        check-contract types notices test e2e build build-e2e up down format

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort | \
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

check: check-backend check-frontend check-i18n check-contract ## Every quality gate (before each commit, and in CI)

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
	$(NODE) --check scripts/check_i18n.mjs
	$(NODE) --check scripts/check_chunks.mjs
	$(NPM) exec -- prettier $(SCRIPTS_PRETTIER) --check $(CURDIR)/scripts
	$(NODE) scripts/check_i18n.mjs

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

up: ## docker compose up (arrives in M7)
	@echo "make up: compose.yaml arrives in M7"; exit 2

down: ## docker compose down (arrives in M7)
	@echo "make down: compose.yaml arrives in M7"; exit 2

format: ## Format and auto-fix backend, frontend and scripts/ sources
	$(PY) ruff format .
	$(PY) ruff check --fix .
	$(NPM) run format
	$(NPM) exec -- prettier $(SCRIPTS_PRETTIER) --write $(CURDIR)/scripts
