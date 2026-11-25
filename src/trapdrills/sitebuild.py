"""Build docs/drills.json: everything the browser site needs, in one file.

Drills, concepts and paths are read from their TOML files. Every concept example is run
here: a SQL example's result rows and a Python example's printed output are stored next
to its code, so the site shows what the code really returned.

The output has no timestamps, so `drills build-site --check` can tell whether the
committed file still matches the drill files.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any

import duckdb

from trapdrills import __version__
from trapdrills.content import (
    Concept,
    Example,
    LearningPath,
    load_concepts,
    load_paths,
    run_python_example,
    run_sql_example,
)
from trapdrills.model import PREDICT_TRACKS, ROOT, TRACK_NAMES, Drill, engine_results, load_drills
from trapdrills.pycheck import RUNNER
from trapdrills.sqlcheck import Table, dataset, tables_of

TARGET = ROOT / "docs" / "drills.json"
README = ROOT / "README.md"
SCALE_RESULTS = ROOT / "results" / "scale.json"
BROWSER_RESULTS = ROOT / "results" / "browser-check.json"


def _table(name: str, table: Table) -> dict[str, Any]:
    return {
        "name": name,
        "columns": list(table.columns),
        "types": list(table.types),
        "rows": [list(r) for r in table.rows],
    }


def _example(example: Example) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "title": example.title,
        "kind": example.kind,
        "code": example.code,
        "note": example.note,
    }
    if example.kind == "sql":
        entry["setup"] = example.setup
        entry["tables"] = (
            [_table(name, table) for name, table in tables_of(example.setup)] if example.setup else []
        )
        entry["result"] = _table("result", run_sql_example(example))
    else:
        entry["output"] = run_python_example(example)
    return entry


def _concept(concept: Concept) -> dict[str, Any]:
    return {
        "id": concept.id,
        "title": concept.title,
        "area": concept.area,
        "level": concept.level,
        "summary": concept.summary,
        "idea": concept.idea,
        "asked": list(concept.asked),
        "answer": list(concept.answer),
        "probes": [{"q": p.q, "a": p.a} for p in concept.probes],
        "examples": [_example(e) for e in concept.examples],
        "drills": list(concept.drills),
        "experiment": concept.experiment,
    }


def _path(path: LearningPath) -> dict[str, Any]:
    return {
        "id": path.id,
        "title": path.title,
        "round": path.round,
        "summary": path.summary,
        "outcome": path.outcome,
        "stages": [
            {
                "title": s.title,
                "note": s.note,
                "steps": [{"kind": step.kind, "id": step.id} for step in s.steps],
            }
            for s in path.stages
        ],
    }


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
    entry["kind"] = drill.kind
    if drill.kind == "predict":
        assert drill.evidence is not None
        entry.update(
            code=drill.code,
            question=drill.question,
            options=[{"value": o.value, "text": o.text, "why": o.why} for o in drill.options],
            evidence={
                "output": drill.evidence.output,
                "engine": drill.evidence.engine,
                "version": drill.evidence.version,
                "setup": drill.evidence.setup,
                "date": drill.evidence.date,
            },
        )
    elif drill.track == "sql":
        entry.update(
            setup=drill.setup,
            columns=list(drill.columns),
            ordered=drill.ordered,
            checkQuery=drill.check_query,
            tables=[_table(name, table) for name, table in dataset(drill)],
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
        # What the concept examples were run on. Minor versions only, so the file is the
        # same on every machine that has the pinned dependencies.
        "built": {
            "duckdb": duckdb.__version__,
            "python": f"{sys.version_info.major}.{sys.version_info.minor}",
        },
        "runner": RUNNER.read_text(encoding="utf-8"),
        "scale": scale,
        "drills": [_drill(d) for d in load_drills()],
        "concepts": [_concept(c) for c in load_concepts()],
        "paths": [_path(p) for p in load_paths()],
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
    text = (
        f"On {check['date']}, {agree} of {check['drills_checked']} drills gave the same result rows, the same case outputs "
        f"and the same verdicts in {check['browser']} (DuckDB-Wasm {check['duckdb_wasm_package']}, which is DuckDB "
        f"{check['duckdb_in_browser']}; Pyodide {check['pyodide']}, which is Python {check['python_in_browser']}) and on "
        f"the command line (DuckDB {check['duckdb_here']}, Python {check['python_here']})."
    )
    predicted = sum(d["track"] in PREDICT_TRACKS for d in check["drills"])
    if predicted:
        text += (
            f" {predicted} of those are Spark and Airflow drills, which run no engine in the browser: for them the "
            "comparison covers the answer key and the verdicts."
        )
    if "examples" in check:
        same = sum(e["same"] for e in check["examples"])
        text += f" {same} of {check['examples_checked']} SQL examples on the concept pages returned the same rows in both."
    return text


def paths_block() -> str:
    """The README's table of paths, written from the TOML files so the counts cannot drift."""
    concepts = load_concepts()
    paths = load_paths()
    advanced = sum(c.level == "advanced" for c in concepts)
    examples = sum(len(c.examples) for c in concepts)
    lines = [
        f"{len(paths)} paths, {len(concepts)} concept pages ({len(concepts) - advanced} core and {advanced} advanced) "
        f"with {examples} examples that are run, and {len(load_drills())} drills.",
        "",
        "| Path | Round | Concepts | Drills | What it covers |",
        "| --- | --- | ---: | ---: | --- |",
    ]
    for path in paths:
        count = sum(step.kind == "concept" for step in path.steps)
        lines.append(
            f"| [{path.title}](paths/{path.number:02d}-{path.id}.toml) | {path.round} | {count} | "
            f"{len(path.steps) - count} | {path.summary} |"
        )
    return "\n".join(lines)


def engines_block() -> str:
    """Which engine versions the Spark and Airflow answer keys were recorded on."""
    lines = []
    for track in PREDICT_TRACKS:
        results = engine_results(track)
        java = f", {results['java']}" if results.get("java") else ""
        lines.append(
            f"- **{TRACK_NAMES[track]}:** {len(results['facts'])} drills recorded on {results['date']} with "
            f"{results['setup']} (Python {results['python']}{java})."
        )
    return "\n".join(lines)


def readme(text: str) -> str:
    """Return the README with its generated blocks refreshed from the content and results files."""
    blocks = (
        ("paths", paths_block()),
        ("engines", engines_block()),
        ("scale", scale_block()),
        ("browser", browser_block()),
    )
    for name, block in blocks:
        pattern = re.compile(rf"(<!-- {name}:start -->\n).*?(<!-- {name}:end -->)", re.DOTALL)
        match = pattern.search(text)
        if match is None:
            raise ValueError(f"README.md has no <!-- {name}:start --> block")
        text = text[: match.start()] + match.group(1) + block + "\n" + match.group(2) + text[match.end() :]
    return text
