"""Record what Apache Spark really does in each Spark drill.

    make engines        (needs Java 17 or 21; PySpark, PyArrow and pandas are fetched by uv for this run only)

A Spark drill asks the learner to predict something: a partition count, a plan, a total.
The answer key is not written by hand. Each drill file under drills/spark holds the code
the learner sees (`code`) and a few lines that inspect the result (`measure`). This tool
runs both in a local Spark session, keeps what was printed as the drill's evidence and
takes the value passed to answer(...) as the correct option. results/spark.json is what
the site, the command line and the tests read; none of them needs Spark.

This file is self-contained on purpose: it runs outside the project's environment.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import io
import json
import platform
import re
import subprocess
import tempfile
import tomllib
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results" / "spark.json"
MASTER = "local[4]"


def fingerprint(drill: dict[str, Any]) -> str:
    return hashlib.sha256((drill["code"] + "\n" + drill["measure"]).encode()).hexdigest()[:12]


def main() -> int:
    from pyspark.sql import SparkSession, Window
    from pyspark.sql import functions as F

    root = (
        SparkSession.builder.master(MASTER)
        .appName("trap-drills")
        .config("spark.ui.enabled", "false")
        .config("spark.ui.showConsoleProgress", "false")
        .getOrCreate()
    )
    root.sparkContext.setLogLevel("ERROR")

    def plan_of(frame: Any) -> str:
        """The physical plan, as df.explain() prints it."""
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            frame.explain()
        return re.sub(r"#\d+L?|, \[plan_id=\d+\]", "", buffer.getvalue()).strip()

    def stages_of(action: Any) -> list[tuple[int, int]]:
        """Run an action and return (stage id, number of tasks) for every stage it started."""
        context = root.sparkContext
        group = f"probe-{dt.datetime.now().timestamp()}"
        context.setJobGroup(group, group)
        action()
        tracker = context.statusTracker()
        stages: list[tuple[int, int]] = []
        for job in sorted(tracker.getJobIdsForGroup(group)):
            for stage in sorted(tracker.getJobInfo(job).stageIds):
                info = tracker.getStageInfo(stage)
                # A stage reused from an earlier job is listed again but runs no tasks.
                if info is not None and info.numCompletedTasks and stage not in dict(stages):
                    stages.append((stage, info.numCompletedTasks))
        context.setLocalProperty("spark.jobGroup.id", None)
        return stages

    facts: dict[str, dict[str, str]] = {}
    for path in sorted((ROOT / "drills" / "spark").glob("*.toml")):
        drill = tomllib.loads(path.read_text(encoding="utf-8"))
        drill_id = path.stem.partition("-")[2]
        answers: list[str] = []
        with tempfile.TemporaryDirectory() as tmp:
            namespace = {
                "spark": root.newSession(),  # its own SQL settings, so one drill cannot affect the next
                "F": F,
                "Window": Window,
                "tmp": tmp,
                "plan_of": plan_of,
                "stages_of": stages_of,
                "answer": lambda value, answers=answers: answers.append(str(value)),
            }
            printed = io.StringIO()
            with contextlib.redirect_stdout(printed):
                exec(compile(drill["code"] + "\n" + drill["measure"], str(path), "exec"), namespace)
        if len(answers) != 1:
            raise SystemExit(f"{path.name}: measure must call answer(...) exactly once")
        facts[drill_id] = {
            "value": answers[0],
            "output": printed.getvalue().strip(),
            "hash": fingerprint(drill),
        }
        print(f"{drill_id:32} -> {answers[0]}")

    java = subprocess.run(
        ["java", "-version"], capture_output=True, text=True, check=False
    ).stderr.splitlines()
    result = {
        "date": dt.date.today().isoformat(),
        "engine": "Apache Spark",
        "version": root.version,
        "setup": f"PySpark {root.version}, master {MASTER}, default settings unless the code changes one",
        "python": platform.python_version(),
        "java": java[0] if java else "",
        "facts": facts,
    }
    root.stop()
    RESULTS.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    print(f"\n{len(facts)} Spark drills recorded in {RESULTS.relative_to(ROOT)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
