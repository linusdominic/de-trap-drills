"""Concepts and paths: every example runs, every reference resolves, every drill has a home."""

from __future__ import annotations

import json

import pytest

from trapdrills.content import (
    AREAS,
    LEVELS,
    Concept,
    LearningPath,
    load_concepts,
    load_paths,
    run_python_example,
    run_sql_example,
)
from trapdrills.model import ROOT, load_drills

DRILLS = {d.id for d in load_drills()}
CONCEPTS = load_concepts()
PATHS = load_paths()
BY_ID = {c.id: c for c in CONCEPTS}
EXAMPLES = [(c, i) for c in CONCEPTS for i in range(len(c.examples))]


def concept_ids(concepts: list[Concept]) -> list[str]:
    return [c.id for c in concepts]


def test_there_is_content() -> None:
    assert len(CONCEPTS) >= 20
    assert len(PATHS) >= 5
    assert {c.level for c in CONCEPTS} == set(LEVELS)
    assert {c.area for c in CONCEPTS} == set(AREAS)
    assert len({p.id for p in PATHS}) == len(PATHS)


@pytest.mark.parametrize("concept", CONCEPTS, ids=concept_ids(CONCEPTS))
def test_concept_is_complete(concept: Concept) -> None:
    assert len(concept.summary) <= 170, "the summary is one sentence"
    assert len(concept.idea) >= 400
    assert len(concept.asked) >= 2, "say how the topic is asked in an interview"
    assert len(concept.answer) >= 3, "say what a strong answer covers"
    assert len(concept.probes) >= 2, "give at least two follow-up questions with answers"
    assert set(concept.drills) <= DRILLS
    text = " ".join(
        [concept.title, concept.summary, concept.idea, *concept.asked, *concept.answer]
        + [p.q + p.a for p in concept.probes]
        + [e.title + e.note for e in concept.examples]
    )
    assert "—" not in text
    assert concept.idea.count("```") % 2 == 0, "a code fence is not closed"


@pytest.mark.parametrize(("concept", "index"), EXAMPLES, ids=[f"{c.id}-{i + 1}" for c, i in EXAMPLES])
def test_example_runs(concept: Concept, index: int) -> None:
    example = concept.examples[index]
    if example.kind == "sql":
        table = run_sql_example(example)
        assert table.rows, "an example that returns nothing shows nothing"
    else:
        assert run_python_example(example).strip(), "a Python example must print its result"


def test_experiments_named_by_concepts_exist() -> None:
    scale = json.loads((ROOT / "results" / "scale.json").read_text(encoding="utf-8"))
    known = {experiment["id"] for experiment in scale["experiments"]}
    assert {c.experiment for c in CONCEPTS if c.experiment} <= known


def test_every_drill_is_explained_by_a_concept() -> None:
    explained = {drill for c in CONCEPTS for drill in c.drills}
    assert explained == DRILLS


@pytest.mark.parametrize("path", PATHS, ids=[p.id for p in PATHS])
def test_path_steps_resolve(path: LearningPath) -> None:
    assert len(path.stages) >= 2
    assert len(path.summary) <= 200
    seen = set()
    for step in path.steps:
        assert step.id in (BY_ID if step.kind == "concept" else DRILLS), (
            f"{step.kind} '{step.id}' does not exist"
        )
        assert (step.kind, step.id) not in seen, f"{step.id} appears twice in {path.id}"
        seen.add((step.kind, step.id))
    assert "—" not in path.title + path.summary + path.outcome + "".join(
        s.title + s.note for s in path.stages
    )


def test_every_concept_and_drill_is_on_a_path() -> None:
    steps = {(step.kind, step.id) for path in PATHS for step in path.steps}
    assert {i for kind, i in steps if kind == "concept"} == set(BY_ID)
    assert {i for kind, i in steps if kind == "drill"} == DRILLS


def test_a_drill_follows_a_concept_that_explains_it() -> None:
    # Within a path, a drill should not come before every concept that explains it,
    # unless the path has none of those concepts at all (a drills-only path).
    for path in PATHS:
        read: set[str] = set()
        in_path = {step.id for step in path.steps if step.kind == "concept"}
        for step in path.steps:
            if step.kind == "concept":
                read.add(step.id)
                continue
            explaining = {c.id for c in CONCEPTS if step.id in c.drills} & in_path
            assert not explaining or explaining & read, f"{path.id}: {step.id} comes before its concept"
