"""Check a SQL answer by running it and the reference answer on the drill's dataset.

Each run gets a fresh in-memory DuckDB. The answer's result is stored as a table and
read back as text, with every numeric column cast to DOUBLE, rounded to 6 places and
printed without a trailing ".0", so that 130 and 130.0 compare equal and float noise
does not fail a correct answer.
DuckDB does that normalising itself, which is why the site (DuckDB-Wasm) and this
module agree: docs/app.js builds the same SELECT. tools/browser_check.py proves it.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

import duckdb

from trapdrills.model import Drill
from trapdrills.verdict import Verdict, render_table

NUMERIC = re.compile(r"^(U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|FLOAT|DOUBLE|REAL|DECIMAL(\(.*\))?)$")
SHOWN = 6

Row = tuple[str | None, ...]


@dataclass(frozen=True)
class Table:
    columns: tuple[str, ...]
    types: tuple[str, ...]
    rows: tuple[Row, ...]


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def projection(columns: tuple[str, ...], types: tuple[str, ...], normalise: bool) -> str:
    parts = []
    for name, type_ in zip(columns, types, strict=True):
        column = _quote(name)
        if normalise and NUMERIC.match(type_):
            parts.append(f"regexp_replace(CAST(round(CAST({column} AS DOUBLE), 6) AS VARCHAR), '\\.0$', '')")
        else:
            parts.append(f"CAST({column} AS VARCHAR)")
    return ", ".join(parts)


def read_table(con: duckdb.DuckDBPyConnection, table: str, normalise: bool) -> Table:
    described = con.execute(f"DESCRIBE {_quote(table)}").fetchall()
    columns = tuple(str(row[0]) for row in described)
    types = tuple(str(row[1]) for row in described)
    select = f"SELECT {projection(columns, types, normalise)} FROM {_quote(table)} ORDER BY rowid"
    rows = tuple(
        tuple("0" if value == "-0" else value for value in row) for row in con.execute(select).fetchall()
    )
    return Table(columns, types, rows)


def is_blank(answer: str) -> bool:
    return all(not line.strip() or line.strip().startswith("--") for line in answer.splitlines())


def run_answer(drill: Drill, answer: str, normalise: bool = True) -> Table:
    """Run one answer on a fresh database. Raises duckdb.Error when the SQL fails."""
    con = duckdb.connect(":memory:")
    try:
        con.execute(drill.setup)
        if drill.check_query is not None:
            con.execute(answer)
            con.execute(f"CREATE TABLE _answer AS {drill.check_query}")
        else:
            con.execute(f"CREATE TABLE _answer AS {answer}")
        return read_table(con, "_answer", normalise)
    finally:
        con.close()


def dataset(drill: Drill) -> list[tuple[str, Table]]:
    """The tables the drill's setup creates, in creation order, as display text."""
    return tables_of(drill.setup)


def tables_of(setup: str) -> list[tuple[str, Table]]:
    """The tables a setup script creates, in creation order, as display text."""
    con = duckdb.connect(":memory:")
    try:
        con.execute(setup)
        names = [
            str(row[0])
            for row in con.execute("SELECT table_name FROM duckdb_tables() ORDER BY table_oid").fetchall()
        ]
        return [(name, read_table(con, name, normalise=False)) for name in names]
    finally:
        con.close()


def _sort_key(row: Row) -> tuple[tuple[bool, str], ...]:
    return tuple((value is None, value or "") for value in row)


def compare(expected: Table, actual: Table, drill: Drill) -> Verdict:
    wanted = ", ".join(drill.columns)
    if len(actual.columns) != len(expected.columns):
        return Verdict(
            False,
            f"Expected {len(expected.columns)} columns ({wanted}), got {len(actual.columns)} ({', '.join(actual.columns)}).",
        )
    same = expected.rows == actual.rows if drill.ordered else Counter(expected.rows) == Counter(actual.rows)
    if same:
        return Verdict(True, f"{len(actual.rows)} rows match the reference answer.")
    missing = sorted((Counter(expected.rows) - Counter(actual.rows)).elements(), key=_sort_key)
    unexpected = sorted((Counter(actual.rows) - Counter(expected.rows)).elements(), key=_sort_key)
    if not missing and not unexpected:
        return Verdict(False, "The rows are right but the order is wrong.")
    lines: list[str] = []
    if missing:
        lines.append(f"Missing from your result ({len(missing)} rows, expected but not returned):")
        lines.extend(render_table(drill.columns, missing[:SHOWN]))
    if unexpected:
        lines.append(f"Not expected ({len(unexpected)} rows, returned but wrong):")
        lines.extend(render_table(drill.columns, unexpected[:SHOWN]))
    if len(actual.rows) == len(expected.rows):
        headline = f"Right number of rows ({len(actual.rows)}), but {len(unexpected)} of them differ from the reference."
    else:
        headline = f"Your result has {len(actual.rows)} rows; the reference has {len(expected.rows)}."
    return Verdict(False, headline, tuple(lines))


def check_sql(drill: Drill, answer: str) -> Verdict:
    if is_blank(answer):
        return Verdict(False, "The answer is empty.")
    expected = run_answer(drill, drill.reference)
    try:
        actual = run_answer(drill, answer)
    except duckdb.Error as exc:
        return Verdict(
            False, "DuckDB could not run the answer.", tuple(f"  {line}" for line in str(exc).splitlines())
        )
    return compare(expected, actual, drill)
