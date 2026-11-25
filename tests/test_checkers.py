"""The two checkers, on answers that are wrong in specific ways."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from trapdrills import cli, sitebuild
from trapdrills.model import ROOT, DrillError, get_drill, load_drill, load_drills
from trapdrills.pycheck import check_python, run_python
from trapdrills.sqlcheck import NUMERIC, check_sql, run_answer

REVENUE = get_drill("sum-after-dedupe")
TOP_N = get_drill("top-n-ties")
MERGE = get_drill("merge-sorted-streams")
LATEST = get_drill("latest-by-key-late-arrival")


def test_integers_and_floats_compare_equal() -> None:
    answer = REVENUE.reference.replace("SUM(amount) AS revenue", "SUM(amount) * 1.0 AS revenue")
    assert "* 1.0" in answer
    assert check_sql(REVENUE, answer).passed


def test_float_noise_is_ignored_but_a_real_difference_is_not() -> None:
    noisy = REVENUE.reference.replace("SUM(amount) AS revenue", "SUM(amount) + 0.0000001 AS revenue")
    assert check_sql(REVENUE, noisy).passed
    off = REVENUE.reference.replace("SUM(amount) AS revenue", "SUM(amount) + 0.01 AS revenue")
    assert not check_sql(REVENUE, off).passed


def test_whole_numbers_print_without_a_decimal_point() -> None:
    assert ("10", "140") in run_answer(REVENUE, REVENUE.reference).rows


def test_wrong_column_count_names_the_expected_columns() -> None:
    verdict = check_sql(REVENUE, "SELECT customer_id FROM orders")
    assert not verdict.passed
    assert "customer_id, revenue" in verdict.headline


def test_duplicate_rows_are_not_hidden_by_the_comparison() -> None:
    doubled = f"SELECT * FROM ({REVENUE.reference.rstrip().rstrip(';')}) UNION ALL SELECT 11, 50"
    verdict = check_sql(REVENUE, doubled)
    assert not verdict.passed
    assert "4 rows" in verdict.headline


def test_right_rows_in_the_wrong_order_fail_an_ordered_drill() -> None:
    shuffled = TOP_N.reference.replace(
        "ORDER BY city, earnings DESC, driver_id", "ORDER BY city DESC, driver_id DESC"
    )
    verdict = check_sql(TOP_N, shuffled)
    assert not verdict.passed
    assert "order is wrong" in verdict.headline


def test_blank_and_broken_sql() -> None:
    assert check_sql(REVENUE, "-- nothing yet\n").headline == "The answer is empty."
    verdict = check_sql(REVENUE, "SELEC customer_id FROM orders")
    assert not verdict.passed
    assert "could not run" in verdict.headline
    assert verdict.lines


def test_each_run_starts_from_a_clean_database() -> None:
    assert not check_sql(
        REVENUE, "DELETE FROM orders; SELECT customer_id, SUM(amount) FROM orders GROUP BY 1"
    ).passed
    assert check_sql(REVENUE, REVENUE.reference).passed


def test_python_syntax_error_and_missing_function() -> None:
    broken = check_python(MERGE, "def merge_streams(a, b)\n    return a")
    assert not broken.passed
    assert any("SyntaxError" in line for line in broken.lines)
    missing = check_python(MERGE, "def something_else():\n    pass\n")
    assert any("merge_streams" in line for line in missing.lines)


def test_python_endless_loop_times_out() -> None:
    results = run_python(MERGE, "def merge_streams(a, b):\n    while True:\n        pass\n", timeout=1)
    assert all(result.error and "timed out" in result.error for result in results)


def test_python_endless_stream_is_guarded() -> None:
    results = run_python(MERGE, MERGE.naive)
    assert results[-1].error is not None
    assert "never ends" in results[-1].error


def test_python_stream_can_only_be_read_once() -> None:
    twice = "def latest_by_key(records):\n    n = len(list(records))\n    return sorted(records, key=lambda r: r['id'])[:n]\n"
    assert not check_python(LATEST, twice).passed


def test_printing_in_an_answer_does_not_break_the_check() -> None:
    chatty = LATEST.reference.replace("    latest = {}", "    print('debug')\n    latest = {}")
    assert "print('debug')" in chatty
    assert check_python(LATEST, chatty).passed


def test_cli_end_to_end(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["list"]) == 0
    assert cli.main(["show", "not-in-null"]) == 0
    assert "customers" in capsys.readouterr().out
    wrong = tmp_path / "wrong.sql"
    wrong.write_text(get_drill("not-in-null").naive, encoding="utf-8")
    assert cli.main(["check", "not-in-null", str(wrong)]) == 1
    right = tmp_path / "right.sql"
    right.write_text(get_drill("not-in-null").reference, encoding="utf-8")
    assert cli.main(["check", "not-in-null", str(right)]) == 0
    assert "THE TRAP YOU AVOIDED" in capsys.readouterr().out
    assert cli.main(["show", "no-such-drill"]) == 2


def test_malformed_drill_file_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "01-broken.toml"
    path.write_text('title = "x"\nfamily = "Not a family"\n', encoding="utf-8")
    with pytest.raises(DrillError):
        load_drill(path, "sql")


def test_generated_files_are_up_to_date() -> None:
    assert sitebuild.TARGET.read_text(encoding="utf-8") == sitebuild.build(), "run: drills build-site"
    readme = sitebuild.README.read_text(encoding="utf-8")
    assert readme == sitebuild.readme(readme), "run: drills build-site"


def test_readme_counts_match_the_drills() -> None:
    drills = load_drills()
    sql = sum(d.track == "sql" for d in drills)
    readme = sitebuild.README.read_text(encoding="utf-8")
    assert f"{sql} SQL and {len(drills) - sql} Python drills" in readme
    assert f"for all {len(drills)} drills" in readme
    assert f"All {sql} SQL reference answers" in readme
    assert f"the {2 * len(drills)} answers that ship" in readme
    for drill in drills:
        assert f"`{drill.id}`" in readme, f"{drill.id} is missing from the README's table of traps"


def test_site_uses_the_same_numeric_rule_as_the_package() -> None:
    script = (ROOT / "docs" / "app.js").read_text(encoding="utf-8")
    match = re.search(r"const NUMERIC = /(.+)/;", script)
    assert match is not None
    assert match.group(1) == NUMERIC.pattern
    assert "'\\\\.0$'" in script, "the site strips a trailing .0 the same way"
