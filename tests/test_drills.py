"""Every drill file: the reference answer passes, the naive answer fails for a real reason."""

from __future__ import annotations

import json
import re

import pytest

from trapdrills.cli import check
from trapdrills.model import FAMILIES, PREDICT_TRACKS, ROOT, Drill, load_drills
from trapdrills.predictcheck import check_predict, fingerprint
from trapdrills.pycheck import run_python
from trapdrills.sqlcheck import dataset, run_answer

DRILLS = load_drills()
SQL = [d for d in DRILLS if d.track == "sql"]
PYTHON = [d for d in DRILLS if d.track == "python"]
PREDICT = [d for d in DRILLS if d.kind == "predict"]


def ids(drills: list[Drill]) -> list[str]:
    return [d.id for d in drills]


def test_there_are_drills_in_both_tracks() -> None:
    assert len(SQL) >= 10
    assert len(PYTHON) >= 5
    assert {d.track for d in PREDICT} == set(PREDICT_TRACKS)
    assert len({d.id for d in DRILLS}) == len(DRILLS)


@pytest.mark.parametrize("drill", DRILLS, ids=ids(DRILLS))
def test_reference_passes_and_naive_fails(drill: Drill) -> None:
    assert check(drill, drill.reference).passed
    assert not check(drill, drill.naive).passed


@pytest.mark.parametrize("drill", DRILLS, ids=ids(DRILLS))
def test_texts_are_complete(drill: Drill) -> None:
    assert drill.family in FAMILIES
    assert len(drill.prompt) > 40
    assert len(drill.trap) > 150
    assert drill.scale, "every drill carries a scale follow-up"
    assert "—" not in drill.prompt + drill.trap + drill.scale


@pytest.mark.parametrize("drill", SQL, ids=ids(SQL))
def test_sql_reference_shape(drill: Drill) -> None:
    table = run_answer(drill, drill.reference)
    assert len(table.columns) == len(drill.columns)
    assert table.rows, "a reference answer that returns nothing proves nothing"
    if drill.ordered:
        assert re.search(r"\bORDER BY\b", drill.reference)
        assert "order" in drill.prompt.lower()
    assert dataset(drill), "the setup must create at least one table"


@pytest.mark.parametrize("drill", SQL, ids=ids(SQL))
def test_sql_naive_runs_and_returns_the_wrong_rows(drill: Drill) -> None:
    # The naive answer must be plausible SQL that runs: it fails on its result, not on a typo.
    naive = run_answer(drill, drill.naive)
    assert len(naive.columns) == len(drill.columns)


@pytest.mark.parametrize("drill", PYTHON, ids=ids(PYTHON))
def test_python_cases(drill: Drill) -> None:
    reference = run_python(drill, drill.reference)
    naive = run_python(drill, drill.naive)
    assert all(result.error is None for result in reference)
    passing = [n.error is None and n.output == r.output for r, n in zip(reference, naive, strict=True)]
    assert any(passing), "the naive answer should get the easy case right"
    assert not all(passing)


@pytest.mark.parametrize("drill", PREDICT, ids=ids(PREDICT))
def test_predict_answer_key_comes_from_the_recorded_run(drill: Drill) -> None:
    assert drill.evidence is not None
    # The run on record must be a run of the code that is in the file today.
    assert drill.evidence.hash == fingerprint(drill), "the drill changed after its run. Run: make engines"
    assert drill.evidence.output, "the run printed nothing to show as evidence"
    values = [option.value for option in drill.options]
    assert len(set(values)) == len(values)
    assert values.count(drill.reference) == 1, "exactly one option must match what the engine did"
    assert drill.naive in values, "the obvious answer must be one of the options"
    assert drill.naive != drill.reference, "the obvious answer has to be wrong"
    assert "answer(" in drill.measure
    assert "—" not in drill.question + "".join(option.text + option.why for option in drill.options)


@pytest.mark.parametrize("drill", PREDICT, ids=ids(PREDICT))
def test_predict_accepts_a_letter_or_a_value(drill: Drill) -> None:
    right = next(i for i, option in enumerate(drill.options) if option.value == drill.reference)
    assert check_predict(drill, f"# a comment\n{'ABCDEFGH'[right]}\n").passed
    assert check_predict(drill, "abcdefgh"[right]).passed
    assert not check_predict(drill, "").passed
    assert not check_predict(drill, "Z").passed


def test_experiments_named_by_drills_exist() -> None:
    scale = json.loads((ROOT / "results" / "scale.json").read_text(encoding="utf-8"))
    known = {experiment["id"] for experiment in scale["experiments"]}
    named = {d.experiment for d in DRILLS if d.experiment}
    assert named <= known
    for experiment in scale["experiments"]:
        assert experiment["same_answer"] is True


@pytest.mark.parametrize("drill", SQL, ids=ids(SQL))
def test_sql_reference_is_valid_postgresql_syntax(drill: Drill) -> None:
    # The references are meant to be portable. This only parses them with PostgreSQL's
    # own parser; it does not run them on a PostgreSQL server.
    pglast = pytest.importorskip("pglast")
    pglast.parse_sql(drill.reference)
