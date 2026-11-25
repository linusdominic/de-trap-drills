"""Measure the "now make it fast on a big table" answers instead of asserting them.

    make scale                      (100 million rows; a few GB of scratch disk in .bench/)
    uv run python tools/scale_bench.py --rows 1000000     (a quick smoke run)

It generates one synthetic events table as date-partitioned Parquet, then times a slow
and a fast way of answering the same question, several runs each, and checks that the
variants return the same answer. Results go to results/scale.json, which the README and
the site quote. Nothing here is a claim about a cluster: it is one machine, one engine
(DuckDB), files on local disk and a warm file cache. The scratch data is deleted at the end.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import platform
import shutil
import statistics
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb

ROOT = Path(__file__).resolve().parents[1]
BENCH = ROOT / ".bench"
RESULTS = ROOT / "results" / "scale.json"
DAYS = 100
USERS = 2_000_000


@dataclass(frozen=True)
class Variant:
    name: str
    sql: str
    comparable: bool = True  # False: answers a narrower question on purpose


@dataclass(frozen=True)
class Experiment:
    id: str
    title: str
    question: str
    variants: tuple[Variant, ...]


EXPERIMENTS = (
    Experiment(
        "prune",
        "Filter so the engine can skip data",
        "Count and sum the events of one day out of 100.",
        (
            Variant(
                "text formatting around the column",
                "SELECT COUNT(*), SUM(amount) FROM events WHERE strftime(ts, '%Y-%m-%d') = '2026-02-19'",
            ),
            Variant(
                "date_trunc around the column",
                "SELECT COUNT(*), SUM(amount) FROM events WHERE date_trunc('day', ts) = TIMESTAMP '2026-02-19'",
            ),
            Variant(
                "half-open range on the raw column",
                "SELECT COUNT(*), SUM(amount) FROM events WHERE ts >= TIMESTAMP '2026-02-19' AND ts < TIMESTAMP '2026-02-20'",
            ),
            Variant(
                "filter on the partition column",
                "SELECT COUNT(*), SUM(amount) FROM events WHERE event_date = DATE '2026-02-19'",
            ),
        ),
    ),
    Experiment(
        "dedupe",
        "Keep the latest version of each key",
        "Count the orders and sum their latest amounts (about 1.25 versions per order).",
        (
            Variant(
                "ROW_NUMBER ... rn = 1 over all history",
                "SELECT COUNT(*), SUM(amount) FROM (SELECT amount, ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY ts DESC) AS rn FROM events) WHERE rn = 1",
            ),
            Variant(
                "arg_max ... GROUP BY over all history",
                "SELECT COUNT(*), SUM(amount) FROM (SELECT arg_max(amount, ts) AS amount FROM events GROUP BY order_id)",
            ),
            Variant(
                "ROW_NUMBER over the newest day only",
                "SELECT COUNT(*), SUM(amount) FROM (SELECT amount, ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY ts DESC) AS rn FROM events WHERE event_date = DATE '2026-04-10') WHERE rn = 1",
                comparable=False,
            ),
        ),
    ),
    Experiment(
        "shrink",
        "Aggregate before a dimension join, or after",
        f"Revenue per user segment: events joined to a {USERS:,}-row user table.",
        (
            Variant(
                "join, then aggregate",
                "SELECT u.segment, SUM(e.amount) FROM events AS e JOIN users AS u USING (user_id) GROUP BY u.segment ORDER BY 1",
            ),
            Variant(
                "aggregate per user, then join",
                "WITH per_user AS (SELECT user_id, SUM(amount) AS amount FROM events GROUP BY user_id) "
                "SELECT u.segment, SUM(p.amount) FROM per_user AS p JOIN users AS u USING (user_id) GROUP BY u.segment ORDER BY 1",
            ),
        ),
    ),
    Experiment(
        "precompute",
        "Answer a dashboard from a summary table",
        "Revenue per day and city for the last 30 days.",
        (
            Variant(
                "from the raw events",
                "SELECT event_date, city_id, SUM(amount) FROM events WHERE event_date >= DATE '2026-03-12' GROUP BY ALL ORDER BY ALL",
            ),
            Variant(
                "from a daily summary table",
                "SELECT event_date, city_id, SUM(revenue) FROM daily_city WHERE event_date >= DATE '2026-03-12' GROUP BY ALL ORDER BY ALL",
            ),
        ),
    ),
    Experiment(
        "sorted",
        "Look up one key in sorted and unsorted files",
        "Count and sum the events of a single user.",
        (
            Variant(
                "files ordered by time",
                "SELECT COUNT(*), SUM(amount) FROM events WHERE user_id = 1234567",
            ),
            Variant(
                "a copy sorted by user_id",
                "SELECT COUNT(*), SUM(amount) FROM events_by_user WHERE user_id = 1234567",
            ),
        ),
    ),
)


def machine() -> dict[str, Any]:
    def sysctl(key: str) -> str | None:
        try:
            return subprocess.run(
                ["sysctl", "-n", key], capture_output=True, text=True, check=True
            ).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            return None

    memory = sysctl("hw.memsize")
    return {
        "cpu": sysctl("machdep.cpu.brand_string") or platform.processor() or platform.machine(),
        "cores": os.cpu_count(),
        "memory_gb": round(int(memory) / 2**30) if memory and memory.isdigit() else None,
        "os": f"{platform.system()} {platform.release()}",
    }


def folder_mb(path: Path) -> float:
    files = [path] if path.is_file() else [p for p in path.rglob("*") if p.is_file()]
    return round(sum(p.stat().st_size for p in files) / 2**20, 1)


def operators(con: duckdb.DuckDBPyConnection, sql: str) -> list[str]:
    """The physical operators of the plan, top down, so the results show what the engine really did."""
    tree = json.loads(con.execute(f"EXPLAIN (FORMAT json) {sql}").fetchall()[0][1])
    names: list[str] = []

    def walk(node: dict[str, Any]) -> None:
        names.append(str(node.get("name", "")).strip())
        for child in node.get("children", []):
            walk(child)

    for node in tree if isinstance(tree, list) else [tree]:
        walk(node)
    return names


def timed(con: duckdb.DuckDBPyConnection, sql: str) -> tuple[float, list[tuple[Any, ...]]]:
    start = time.perf_counter()
    rows = con.execute(sql).fetchall()
    return time.perf_counter() - start, rows


def generate(con: duckdb.DuckDBPyConnection, rows: int) -> dict[str, Any]:
    step = DAYS * 86_400_000_000 // rows  # microseconds between consecutive events
    orders = max(rows * 4 // 5, 1)
    events_dir = BENCH / "events"
    start = time.perf_counter()
    con.execute(
        f"""
        COPY (
          SELECT i AS event_id,
                 CAST(hash(i) % {USERS} AS INTEGER) AS user_id,
                 CAST(hash(i + 29) % {orders} AS BIGINT) AS order_id,
                 CAST(hash(i + 7) % 50 AS INTEGER) AS city_id,
                 CAST(hash(i + 13) % 500 AS INTEGER) + 1 AS amount,
                 TIMESTAMP '2026-01-01' + to_microseconds(i * {step}) AS ts,
                 CAST(TIMESTAMP '2026-01-01' + to_microseconds(i * {step}) AS DATE) AS event_date
          FROM range({rows}) AS t(i)
        ) TO '{events_dir}' (FORMAT parquet, PARTITION_BY (event_date))
        """
    )
    partitioned = time.perf_counter() - start
    con.execute(
        f"CREATE VIEW events AS SELECT * FROM read_parquet('{events_dir}/*/*.parquet', hive_partitioning = true)"
    )
    start = time.perf_counter()
    sorted_file = BENCH / "events_by_user.parquet"
    con.execute(f"COPY (SELECT * FROM events ORDER BY user_id) TO '{sorted_file}' (FORMAT parquet)")
    sorting = time.perf_counter() - start
    con.execute(f"CREATE VIEW events_by_user AS SELECT * FROM read_parquet('{sorted_file}')")
    con.execute(
        f"CREATE TABLE users AS SELECT CAST(i AS INTEGER) AS user_id, CAST(hash(i + 3) % 20 AS INTEGER) AS segment FROM range({USERS}) AS t(i)"
    )
    start = time.perf_counter()
    con.execute(
        "CREATE TABLE daily_city AS SELECT event_date, city_id, COUNT(*) AS events, SUM(amount) AS revenue FROM events GROUP BY ALL"
    )
    summary = time.perf_counter() - start
    return {
        "write_partitioned_seconds": round(partitioned, 2),
        "partitioned_mb": folder_mb(events_dir),
        "write_sorted_copy_seconds": round(sorting, 2),
        "sorted_copy_mb": folder_mb(sorted_file),
        "build_daily_summary_seconds": round(summary, 2),
        "daily_summary_rows": con.execute("SELECT COUNT(*) FROM daily_city").fetchall()[0][0],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--rows", type=int, default=100_000_000)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--keep", action="store_true", help="keep .bench/ afterwards")
    parser.add_argument(
        "--no-write", action="store_true", help="print results without writing results/scale.json"
    )
    args = parser.parse_args()

    shutil.rmtree(BENCH, ignore_errors=True)
    (BENCH / "tmp").mkdir(parents=True)
    con = duckdb.connect(":memory:")
    con.execute(f"SET temp_directory = '{BENCH / 'tmp'}'")
    try:
        print(f"generating {args.rows:,} rows ...", flush=True)
        setup = generate(con, args.rows)
        print(json.dumps(setup), flush=True)
        experiments = []
        for experiment in EXPERIMENTS:
            print(f"\n{experiment.id}: {experiment.question}", flush=True)
            variants = []
            answers = []
            for variant in experiment.variants:
                seconds = []
                rows: list[tuple[Any, ...]] = []
                for _ in range(args.runs):
                    elapsed, rows = timed(con, variant.sql)
                    seconds.append(round(elapsed, 4))
                if variant.comparable:
                    answers.append(rows)
                median = round(statistics.median(seconds), 4)
                print(f"  {median:9.4f} s  {variant.name}  {seconds}", flush=True)
                variants.append(
                    {
                        "name": variant.name,
                        "sql": variant.sql,
                        "comparable": variant.comparable,
                        "seconds": seconds,
                        "median_seconds": median,
                        "operators": operators(con, variant.sql),
                    }
                )
            same = all(answer == answers[0] for answer in answers)
            if not same:
                raise SystemExit(f"{experiment.id}: the variants returned different answers")
            first = [str(value) for value in answers[0][0]]
            print(f"  answer: {len(answers[0])} rows, first row {first}", flush=True)
            experiments.append(
                {
                    "id": experiment.id,
                    "title": experiment.title,
                    "question": experiment.question,
                    "same_answer": same,
                    "answer_rows": len(answers[0]),
                    "answer_first_row": first,
                    "variants": variants,
                }
            )
        result = {
            "date": dt.date.today().isoformat(),
            "rows": args.rows,
            "days": DAYS,
            "runs": args.runs,
            "duckdb": duckdb.__version__,
            "threads": con.execute("SELECT current_setting('threads')").fetchall()[0][0],
            "machine": machine(),
            "setup": setup,
            "experiments": experiments,
        }
    finally:
        con.close()
        if not args.keep:
            shutil.rmtree(BENCH, ignore_errors=True)
    if args.no_write:
        print("\n(not written: --no-write)")
    else:
        RESULTS.parent.mkdir(exist_ok=True)
        RESULTS.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
        print(f"\nwrote {RESULTS.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
