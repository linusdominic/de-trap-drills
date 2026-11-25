# Trap Drills. Run `make help` for the list.

SHELL := /bin/bash
UV ?= uv
RUN := $(UV) run --python 3.12
PORT ?= 8791

.DEFAULT_GOAL := help
.PHONY: help setup list verify test lint format site serve browser-check scale check

help: ## Show this list
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  make %-15s %s\n", $$1, $$2}'

setup: ## Install Python 3.12 and the pinned dependencies with uv
	$(UV) sync --python 3.12
	@echo; echo "Setup done. Next: uv run drills list"

list: ## List every drill
	$(RUN) drills list

verify: ## Every reference answer must pass and every naive answer must fail
	$(RUN) drills verify

test: ## Unit tests
	$(RUN) pytest -q

lint: ## ruff and mypy
	$(RUN) ruff check .
	$(RUN) ruff format --check .
	$(RUN) mypy

format: ## Format the Python code
	$(RUN) ruff format .
	$(RUN) ruff check --fix .

site: ## Rebuild docs/drills.json from the drill files and results/scale.json
	$(RUN) drills build-site

serve: site ## Serve the browser site at http://127.0.0.1:$(PORT)
	$(RUN) python -m http.server $(PORT) --bind 127.0.0.1 --directory docs

browser-check: site ## Run every drill in headless Chrome and compare with the command line
	$(RUN) python tools/browser_check.py

scale: ## Re-run the scale benchmark (100 million rows, about 4 GB of scratch disk)
	$(RUN) python tools/scale_bench.py
	$(RUN) drills build-site

check: lint test verify ## Everything CI runs
	$(RUN) drills build-site --check
