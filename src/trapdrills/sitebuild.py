"""Build docs/drills.json: everything the browser site needs, in one file.

The output has no timestamps, so `drills build-site --check` can tell whether the
committed file still matches the drill files.
"""

from __future__ import annotations

import json
import re
from typing import Any

from trapdrills import __version__
from trapdrills.model import ROOT, Drill, load_drills
from trapdrills.pycheck import RUNNER
from trapdrills.sqlcheck import dataset

TARGET = ROOT / "docs" / "drills.json"
README = ROOT / "README.md"
SCALE_RESULTS = ROOT / "results" / "scale.json"
BROWSER_RESULTS = ROOT / "results" / "browser-check.json"


def _drill(drill: Drill) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": drill.id,
        "track": drill.track,
        "family": drill.family,
        "pattern": drill.pattern,
        "title": drill.title,
        "prompt": drill.prompt,
        "starter": drill.starter,
        "naive": drill.naive,
        "reference": drill.reference,
        "trap": drill.trap,
        "scale": drill.scale,
        "experiment": drill.experiment,
    }
    if drill.track == "sql":
        entry.update(
            setup=drill.setup,
            columns=list(drill.columns),
            ordered=drill.ordered,
            checkQuery=drill.check_query,
            tables=[
                {
                    "name": name,
                    "columns": list(table.columns),
                    "types": list(table.types),
                    "rows": [list(r) for r in table.rows],
                }
                for name, table in dataset(drill)
            ],
        )
    else:
        entry.update(
            function=drill.function,
            cases=[{"name": c.name, "args": c.args, "take": c.take} for c in drill.cases],
        )
    return entry


def build() -> str:
    scale = json.loads(SCALE_RESULTS.read_text(encoding="utf-8")) if SCALE_RESULTS.exists() else None
    data = {
        "version": __version__,
        "runner": RUNNER.read_text(encoding="utf-8"),
        "scale": scale,
        "drills": [_drill(d) for d in load_drills()],
    }
    return json.dumps(data, indent=1, ensure_ascii=False) + "\n"


def _seconds(seconds: float) -> str:
    if seconds >= 1:
        return f"{seconds:.2f} s"
    return f"{seconds * 1000:.1f} ms" if seconds < 0.01 else f"{seconds * 1000:.0f} ms"


def _ratio(first: float, this: float) -> str:
    ratio = first / this
    if ratio >= 1:
        return f"{ratio:.0f}x faster" if ratio >= 10 else f"{ratio:.1f}x faster"
    return f"{1 / ratio:.1f}x slower"


def scale_block() -> str:
    """The README's results table, written from results/scale.json so the two cannot drift."""
    scale = json.loads(SCALE_RESULTS.read_text(encoding="utf-8"))
    machine = scale["machine"]
    lines = [
        f"Run on {scale['date']}: {scale['rows']:,} rows over {scale['days']} daily partitions "
        f"({scale['setup']['partitioned_mb'] / 1024:.1f} GB of Parquet), DuckDB {scale['duckdb']}, {machine['cpu']}, "
        f"{machine['cores']} cores, {machine['memory_gb']} GB. Median of {scale['runs']} runs.",
        "",
        "| Question | Query | Median | Against the first |",
        "| --- | --- | ---: | --- |",
    ]
    for experiment in scale["experiments"]:
        first = experiment["variants"][0]["median_seconds"]
        for i, variant in enumerate(experiment["variants"]):
            name = variant["name"] + ("" if variant["comparable"] else " (a narrower question)")
            against = "baseline" if i == 0 else _ratio(first, variant["median_seconds"])
            question = experiment["question"] if i == 0 else ""
            lines.append(f"| {question} | {name} | {_seconds(variant['median_seconds'])} | {against} |")
    return "\n".join(lines)


def browser_block() -> str:
    check = json.loads(BROWSER_RESULTS.read_text(encoding="utf-8"))
    agree = sum(
        d["reference_same"]
        and d["naive_same"]
        and d["reference_passes_in_browser"]
        and d["naive_fails_in_browser"]
        for d in check["drills"]
    )
    return (
        f"On {check['date']}, {agree} of {check['drills_checked']} drills gave the same result rows, the same case outputs "
        f"and the same verdicts in {check['browser']} (DuckDB-Wasm {check['duckdb_wasm_package']}, which is DuckDB "
        f"{check['duckdb_in_browser']}; Pyodide {check['pyodide']}, which is Python {check['python_in_browser']}) and on "
        f"the command line (DuckDB {check['duckdb_here']}, Python {check['python_here']})."
    )


def readme(text: str) -> str:
    """Return the README with its generated blocks refreshed from the results files."""
    for name, block in (("scale", scale_block()), ("browser", browser_block())):
        pattern = re.compile(rf"(<!-- {name}:start -->\n).*?(<!-- {name}:end -->)", re.DOTALL)
        match = pattern.search(text)
        if match is None:
            raise ValueError(f"README.md has no <!-- {name}:start --> block")
        text = text[: match.start()] + match.group(1) + block + "\n" + match.group(2) + text[match.end() :]
    return text
