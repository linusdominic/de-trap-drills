"""Record what Apache Airflow really does in each Airflow drill.

    make engines        (Airflow is fetched by uv for this run only)

An Airflow drill asks the learner to predict something: when a run happens, which tasks
are skipped, how often a line of a DAG file runs. The answer key is not written by hand.
Each drill file under drills/airflow holds a DAG file the learner sees (`code`) and a few
lines that inspect it (`measure`). This tool creates a scratch Airflow home with a SQLite
database, puts every DAG file in it, and runs each `measure` against the real library:
the scheduler's own timetable code, the DAG parser, and `airflow dags test`. What was
printed becomes the drill's evidence and the value passed to answer(...) is the correct
option. results/airflow.json is what the site, the command line and the tests read; none
of them needs Airflow.

This file is self-contained on purpose: it runs outside the project's environment.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import io
import json
import os
import platform
import subprocess
import sys
import tempfile
import tomllib
import warnings
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results" / "airflow.json"


def fingerprint(drill: dict[str, Any]) -> str:
    return hashlib.sha256((drill["code"] + "\n" + drill["measure"]).encode()).hexdigest()[:12]


def cli(*args: str) -> str:
    done = subprocess.run(
        [sys.executable, "-m", "airflow", *args], capture_output=True, text=True, env=os.environ, check=False
    )
    return done.stdout


def main() -> int:
    warnings.filterwarnings("ignore")
    drills = {
        path.stem.partition("-")[2]: tomllib.loads(path.read_text(encoding="utf-8"))
        for path in sorted((ROOT / "drills" / "airflow").glob("*.toml"))
    }
    with tempfile.TemporaryDirectory() as home:
        dags = Path(home) / "dags"
        dags.mkdir()
        os.environ.update(
            AIRFLOW_HOME=home,
            AIRFLOW__CORE__DAGS_FOLDER=str(dags),
            AIRFLOW__CORE__LOAD_EXAMPLES="False",
            AIRFLOW__LOGGING__LOGGING_LEVEL="ERROR",
            CALLS_LOG=str(Path(home) / "calls.log"),
        )
        for drill_id, drill in drills.items():
            (dags / f"{drill_id.replace('-', '_')}.py").write_text(drill["code"], encoding="utf-8")
        cli("db", "migrate")
        cli("dags", "reserialize")

        import airflow
        import pendulum
        import time_machine
        from airflow.dag_processing.dagbag import DagBag
        from airflow.models.serialized_dag import SerializedDagModel
        from airflow.timetables.base import TimeRestriction
        from airflow.utils.session import create_session

        def scheduler_dag(dag_id: str) -> Any:
            """The DAG as the scheduler sees it: read back from the metadata database."""
            with create_session() as session:
                return SerializedDagModel.get(dag_id, session=session).dag

        def runs_until(timetable: Any, start: Any, now: str, catchup: bool) -> list[Any]:
            """The runs a scheduler would have created by `now`, for a DAG that was just unpaused."""
            moment = pendulum.parse(now)
            runs: list[Any] = []
            last = None
            with time_machine.travel(moment, tick=False):
                while len(runs) < 1000:
                    info = timetable.next_dagrun_info(
                        last_automated_data_interval=last,
                        restriction=TimeRestriction(earliest=start, latest=None, catchup=catchup),
                    )
                    if info is None or info.run_after > moment:
                        break
                    runs.append(info)
                    last = info.data_interval
            return runs

        def test_run(dag_id: str, logical_date: str) -> dict[str, str]:
            """Run the DAG once with `airflow dags test` and return each task's final state."""
            cli("dags", "test", dag_id, logical_date)
            runs = json.loads(cli("dags", "list-runs", dag_id, "-o", "json"))
            states = json.loads(cli("tasks", "states-for-dag-run", dag_id, runs[0]["run_id"], "-o", "json"))
            return {task["task_id"]: task["state"] for task in states}

        def returned(dag_id: str, task_id: str) -> Any:
            """The value a task returned in the most recent run (its XCom)."""
            from airflow.models.xcom import XComModel

            with create_session() as session:
                row = (
                    session.query(XComModel)
                    .filter_by(dag_id=dag_id, task_id=task_id, key="return_value")
                    .order_by(XComModel.timestamp.desc())
                    .first()
                )
                value = row.value
            if isinstance(value, str):
                with contextlib.suppress(json.JSONDecodeError):
                    return json.loads(value)
            return value

        def parse_all() -> None:
            """Parse every DAG file once, as the DAG processor does on each pass."""
            DagBag(str(dags))

        facts: dict[str, dict[str, str]] = {}
        for drill_id, drill in drills.items():
            answers: list[str] = []
            namespace = {
                "pendulum": pendulum,
                "scheduler_dag": scheduler_dag,
                "runs_until": runs_until,
                "test_run": test_run,
                "returned": returned,
                "parse_all": parse_all,
                "calls_log": Path(os.environ["CALLS_LOG"]),
                "answer": lambda value, answers=answers: answers.append(str(value)),
            }
            printed = io.StringIO()
            with contextlib.redirect_stdout(printed):
                exec(compile(drill["measure"], f"{drill_id}.measure", "exec"), namespace)
            if len(answers) != 1:
                raise SystemExit(f"{drill_id}: measure must call answer(...) exactly once")
            facts[drill_id] = {
                "value": answers[0],
                "output": printed.getvalue().strip(),
                "hash": fingerprint(drill),
            }
            print(f"{drill_id:32} -> {answers[0]}")
        version = airflow.__version__

    result = {
        "date": dt.date.today().isoformat(),
        "engine": "Apache Airflow",
        "version": version,
        "setup": f"Airflow {version}, a new SQLite metadata database, default configuration",
        "python": platform.python_version(),
        "facts": facts,
    }
    RESULTS.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    print(f"\n{len(facts)} Airflow drills recorded in {RESULTS.relative_to(ROOT)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
