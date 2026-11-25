# Trap Drills. Run `make help` for the list.

SHELL := /bin/bash
UV ?= uv
RUN := $(UV) run --python 3.12
PORT ?= 8791

.DEFAULT_GOAL := help
.PHONY: help setup list verify test lint format site serve browser-check scale engines check

help: ## Show this list
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  make %-15s %s\n", $$1, $$2}'

setup: ## Install Python 3.12 and the pinned dependencies with uv
	$(UV) sync --python 3.12
	@echo; echo "Setup done. Next: uv run drills list"

list: ## List every drill
	$(RUN) drills list

verify: ## Every reference passes, every naive answer fails, every concept example runs
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

site: ## Rebuild docs/drills.json and the README blocks from the drills, concepts, paths and results
	$(RUN) drills build-site

serve: site ## Serve the browser site at http://127.0.0.1:$(PORT)
	$(RUN) python -m http.server $(PORT) --bind 127.0.0.1 --directory docs

browser-check: site ## Run every drill and concept example in headless Chrome and compare with the command line
	$(RUN) python tools/browser_check.py

scale: ## Re-run the scale benchmark (100 million rows, about 4 GB of scratch disk)
	$(RUN) python tools/scale_bench.py
	$(RUN) drills build-site

engines: ## Re-run the Spark and Airflow drills on the real engines (needs Java 17 or 21 on PATH)
	$(UV) run --no-project --python 3.12 --with pyspark==4.3.0 --with pyarrow --with "pandas<3" python tools/spark_evidence.py
	$(UV) run --no-project --python 3.12 --with apache-airflow==3.4.0 --with time-machine python tools/airflow_evidence.py
	$(RUN) drills build-site

check: lint test verify ## Everything CI runs
	$(RUN) drills build-site --check
