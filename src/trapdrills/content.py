"""Concepts and learning paths: one TOML file each under concepts/ and paths/.

A concept is a page of explanation with examples that are run, and the questions an
interviewer asks about it. A path is an ordered route through concepts and drills for
one interview round. The file name is NN-id.toml; NN only sets the order.
"""

from __future__ import annotations

import subprocess
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb

from trapdrills.model import ROOT, DrillError
from trapdrills.sqlcheck import Table, read_table

AREAS = (
    "SQL correctness",
    "Time and history",
    "Python",
    "Performance at scale",
    "Spark",
    "Pipeline design",
    "Airflow",
    "Data modeling",
    "The interview",
)
LEVELS = ("core", "advanced")
EXAMPLE_KINDS = ("sql", "python")
STEP_KINDS = {"c": "concept", "d": "drill"}
TIMEOUT_SECONDS = 5


@dataclass(frozen=True)
class Example:
    """Code that is run when the site is built. SQL: one SELECT; Python: a script that prints."""

    title: str
    kind: str
    code: str
    setup: str = ""
    note: str = ""


@dataclass(frozen=True)
class Probe:
    """A follow-up question and the answer to give."""

    q: str
    a: str


@dataclass(frozen=True)
class Concept:
    id: str
    number: int
    title: str
    area: str
    level: str
    summary: str
    idea: str
    asked: tuple[str, ...]
    answer: tuple[str, ...]
    probes: tuple[Probe, ...]
    examples: tuple[Example, ...] = ()
    drills: tuple[str, ...] = ()
    experiment: str | None = None


@dataclass(frozen=True)
class Step:
    kind: str  # "concept" or "drill"
    id: str


@dataclass(frozen=True)
class Stage:
    title: str
    note: str
    steps: tuple[Step, ...]


@dataclass(frozen=True)
class LearningPath:
    id: str
    number: int
    title: str
    round: str
    summary: str
    outcome: str
    stages: tuple[Stage, ...]

    @property
    def steps(self) -> tuple[Step, ...]:
        return tuple(step for stage in self.stages for step in stage.steps)


def _text(data: dict[str, Any], key: str, path: Path, *, required: bool = True) -> str:
    value = data.get(key, "")
    if not isinstance(value, str) or (required and not value.strip()):
        raise DrillError(f"{path.name}: '{key}' must be a non-empty string")
    stripped = value.strip()
    return stripped + "\n" if "\n" in stripped else stripped


def _strings(data: dict[str, Any], key: str, path: Path) -> tuple[str, ...]:
    value = data.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        raise DrillError(f"{path.name}: '{key}' must be a list of strings")
    return tuple(item.strip() for item in value)


def _split_name(path: Path) -> tuple[int, str]:
    number, _, item_id = path.stem.partition("-")
    if not number.isdigit() or not item_id:
        raise DrillError(f"{path.name}: name the file NN-id.toml")
    return int(number), item_id


def load_concept(path: Path) -> Concept:
    with path.open("rb") as handle:
        data = tomllib.load(handle)
    number, concept_id = _split_name(path)
    area = _text(data, "area", path)
    if area not in AREAS:
        raise DrillError(f"{path.name}: unknown area '{area}'")
    level = _text(data, "level", path)
    if level not in LEVELS:
        raise DrillError(f"{path.name}: level must be one of {', '.join(LEVELS)}")
    examples = []
    for raw in data.get("examples", []):
        kind = raw.get("kind", "sql")
        if kind not in EXAMPLE_KINDS:
            raise DrillError(f"{path.name}: example kind must be one of {', '.join(EXAMPLE_KINDS)}")
        examples.append(
            Example(
                title=_text(raw, "title", path),
                kind=kind,
                code=_text(raw, "code", path),
                setup=_text(raw, "setup", path, required=False),
                note=_text(raw, "note", path, required=False),
            )
        )
    experiment = data.get("experiment")
    return Concept(
        id=concept_id,
        number=number,
        title=_text(data, "title", path),
        area=area,
        level=level,
        summary=_text(data, "summary", path),
        idea=_text(data, "idea", path),
        asked=_strings(data, "asked", path),
        answer=_strings(data, "answer", path),
        probes=tuple(Probe(q=_text(p, "q", path), a=_text(p, "a", path)) for p in data.get("probes", [])),
        examples=tuple(examples),
        drills=_strings(data, "drills", path),
        experiment=experiment if isinstance(experiment, str) else None,
    )


def load_concepts(root: Path = ROOT) -> list[Concept]:
    concepts = [load_concept(path) for path in sorted((root / "concepts").glob("*.toml"))]
    ids = [c.id for c in concepts]
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        raise DrillError(f"duplicate concept ids: {', '.join(duplicates)}")
    return concepts


def _step(reference: str, path: Path) -> Step:
    prefix, _, item_id = reference.partition(":")
    if prefix not in STEP_KINDS or not item_id:
        raise DrillError(f"{path.name}: write steps as 'c:concept-id' or 'd:drill-id', not '{reference}'")
    return Step(STEP_KINDS[prefix], item_id)


def load_path(path: Path) -> LearningPath:
    with path.open("rb") as handle:
        data = tomllib.load(handle)
    number, path_id = _split_name(path)
    stages = tuple(
        Stage(
            title=_text(raw, "title", path),
            note=_text(raw, "note", path),
            steps=tuple(_step(reference, path) for reference in _strings(raw, "steps", path)),
        )
        for raw in data.get("stages", [])
    )
    if not stages:
        raise DrillError(f"{path.name}: a path needs at least one [[stages]] entry")
    return LearningPath(
        id=path_id,
        number=number,
        title=_text(data, "title", path),
        round=_text(data, "round", path),
        summary=_text(data, "summary", path),
        outcome=_text(data, "outcome", path),
        stages=stages,
    )


def load_paths(root: Path = ROOT) -> list[LearningPath]:
    return [load_path(path) for path in sorted((root / "paths").glob("*.toml"))]


def run_sql_example(example: Example) -> Table:
    """Run the example's SELECT on a fresh database and read the result back as text."""
    con = duckdb.connect(":memory:")
    try:
        if example.setup:
            con.execute(example.setup)
        con.execute(f"CREATE TABLE _answer AS {example.code}")
        return read_table(con, "_answer", normalise=False)
    finally:
        con.close()


def run_python_example(example: Example) -> str:
    """Run the script in an isolated interpreter and return what it prints."""
    done = subprocess.run(
        [sys.executable, "-I", "-c", example.code],
        capture_output=True,
        text=True,
        timeout=TIMEOUT_SECONDS,
        check=False,
    )
    if done.returncode != 0:
        raise RuntimeError(done.stderr.strip() or f"exit status {done.returncode}")
    return done.stdout
