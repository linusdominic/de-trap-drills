"""Prove that the browser site and the command line give the same verdicts.

    make browser-check        (needs Google Chrome or Chromium, and network access for
                               the DuckDB-Wasm and Pyodide downloads from jsDelivr)

It serves docs/ on a local port, opens docs/?selftest=1 in headless Chrome and waits
for the page to post back what happened when it ran every reference and naive answer
in DuckDB-Wasm and Pyodide. It then runs the same answers here, with the Python
package, and compares: the normalised result rows of every SQL answer, the output of
every Python case, and the PASS/FAIL verdicts. Rows are compared in order for drills
whose answer is ordered and as a multiset for the rest. Any difference is a failure.
Results are written to results/browser-check.json.

Set CHROME to the browser's path if it is not in a usual place.
"""

from __future__ import annotations

import argparse
import datetime as dt
import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any

import duckdb

from trapdrills.model import ROOT, load_drills
from trapdrills.pycheck import run_python
from trapdrills.sitebuild import TARGET, build
from trapdrills.sqlcheck import run_answer

DOCS = ROOT / "docs"
RESULTS = ROOT / "results" / "browser-check.json"


def find_chrome() -> str:
    candidates = [
        os.environ.get("CHROME"),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        shutil.which("google-chrome"),
        shutil.which("google-chrome-stable"),
        shutil.which("chromium"),
        shutil.which("chromium-browser"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    raise SystemExit("No Chrome or Chromium found; set CHROME to its path.")


class Handler(http.server.SimpleHTTPRequestHandler):
    report: dict[str, Any] | None = None
    received = threading.Event()

    def do_POST(self) -> None:
        if self.path.split("?")[0].endswith("/__selftest"):
            length = int(self.headers.get("Content-Length", "0"))
            Handler.report = json.loads(self.rfile.read(length))
            Handler.received.set()
            self.send_response(204)
        else:
            self.send_response(404)
        self.end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        pass


def browser_report(timeout: float) -> tuple[dict[str, Any], str]:
    chrome = find_chrome()
    version = subprocess.run(
        [chrome, "--version"], capture_output=True, text=True, check=False
    ).stdout.strip()
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(Handler, directory=str(DOCS))
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/?selftest=1"
    with tempfile.TemporaryDirectory() as profile:
        process = subprocess.Popen(
            [
                chrome,
                "--headless=new",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                f"--user-data-dir={profile}",
                url,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            arrived = Handler.received.wait(timeout)
        finally:
            process.terminate()
            try:
                process.wait(10)
            except subprocess.TimeoutExpired:
                process.kill()
            server.shutdown()
    if not arrived or Handler.report is None:
        raise SystemExit(
            f"The page did not report within {timeout:g} s (no network, or the engines failed to load)."
        )
    return Handler.report, version


def local_results() -> dict[str, dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    for drill in load_drills():
        if drill.track == "sql":
            reference: Any = [list(row) for row in run_answer(drill, drill.reference).rows]
            try:
                naive: Any = [list(row) for row in run_answer(drill, drill.naive).rows]
            except duckdb.Error as exc:
                naive = {"error": str(exc)}
        else:
            reference = [
                {"output": r.output, "failed": r.error is not None}
                for r in run_python(drill, drill.reference)
            ]
            naive = [
                {"output": r.output, "failed": r.error is not None} for r in run_python(drill, drill.naive)
            ]
        results[drill.id] = {
            "track": drill.track,
            "ordered": drill.ordered,
            "reference": reference,
            "naive": naive,
        }
    return results


def _in_order(rows: list[list[str | None]]) -> list[list[str | None]]:
    return sorted(rows, key=lambda row: [(value is None, value or "") for value in row])


def same(track: str, ordered: bool, here: Any, there: Any) -> bool:
    if track == "sql":
        if isinstance(here, dict) or isinstance(there, dict):
            return isinstance(here, dict) and isinstance(there, dict)  # both failed to run
        # Without an ORDER BY the two engines may return the same rows in a different order.
        return bool(here == there if ordered else _in_order(here) == _in_order(there))
    # Python: same output per case; error wording may differ between Python versions.
    browser = [{"output": case["output"], "failed": case["error"] is not None} for case in there]
    return bool(here == browser)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--timeout", type=float, default=240)
    args = parser.parse_args()
    if not TARGET.exists() or TARGET.read_text(encoding="utf-8") != build():
        raise SystemExit("docs/drills.json is out of date. Run: drills build-site")

    report, chrome = browser_report(args.timeout)
    if "error" in report:
        raise SystemExit(f"The page failed while running the drills: {report['error']}")
    local = local_results()
    drills = []
    problems = 0
    for drill_id, here in local.items():
        there = report["drills"].get(drill_id)
        entry = {
            "id": drill_id,
            "track": here["track"],
            "reference_same": there is not None
            and same(here["track"], here["ordered"], here["reference"], there["reference"]),
            "naive_same": there is not None
            and same(here["track"], here["ordered"], here["naive"], there["naive"]),
            "reference_passes_in_browser": bool(there and there["referencePasses"]),
            "naive_fails_in_browser": bool(there and not there["naivePasses"]),
        }
        ok = all(value for key, value in entry.items() if key not in ("id", "track"))
        problems += not ok
        print(f"{'ok' if ok else 'PROBLEM':8} {here['track']:6} {drill_id}")
        if not ok:
            print(f"         here : {json.dumps(here)[:600]}\n         there: {json.dumps(there)[:600]}")
        drills.append(entry)

    result = {
        "date": dt.date.today().isoformat(),
        "browser": chrome,
        "duckdb_wasm_package": report["duckdbWasm"],
        "duckdb_in_browser": report["duckdb"],
        "duckdb_here": duckdb.__version__,
        "pyodide": report["pyodide"]["pyodide"],
        "python_in_browser": report["pyodide"]["python"],
        "python_here": ".".join(str(n) for n in sys.version_info[:3]),
        "drills_checked": len(drills),
        "problems": problems,
        "drills": drills,
    }
    RESULTS.parent.mkdir(exist_ok=True)
    RESULTS.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    print(
        f"\n{len(drills)} drills, {problems} problems. Browser: {chrome}; DuckDB {result['duckdb_in_browser']} there, "
        f"{result['duckdb_here']} here; Python {result['python_in_browser']} there, {result['python_here']} here."
    )
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
