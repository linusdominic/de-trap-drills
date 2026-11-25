"""Check a Python answer: run it and the reference on every case and compare outputs."""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from trapdrills.model import Drill
from trapdrills.verdict import Verdict

RUNNER = Path(__file__).with_name("pyrunner.py")
TIMEOUT_SECONDS = 5
SHOWN_CHARS = 400


@dataclass(frozen=True)
class CaseResult:
    name: str
    output: str | None
    error: str | None


def run_python(drill: Drill, code: str, timeout: float = TIMEOUT_SECONDS) -> list[CaseResult]:
    """Run code on every case in a separate, isolated interpreter (-I: no cwd, no user site)."""
    cases = [{"name": c.name, "args": c.args, "take": c.take} for c in drill.cases]
    payload = json.dumps({"code": code, "function": drill.function, "cases": cases})
    process = subprocess.Popen(
        [sys.executable, "-I", "-c", RUNNER.read_text(encoding="utf-8")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    timed_out = False
    try:
        stdout, stderr = process.communicate(payload, timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        process.kill()
        stdout, stderr = process.communicate()
    results = [CaseResult(**json.loads(line)) for line in stdout.splitlines() if line.strip()]
    for case in drill.cases[len(results) :]:
        if timed_out:
            reason = f"timed out after {timeout:g} seconds (an endless loop, or reading an endless stream?)"
        else:
            reason = (stderr.strip().splitlines() or ["the interpreter stopped"])[-1]
        results.append(CaseResult(case.name, None, reason))
    return results


def _short(text: str) -> str:
    return text if len(text) <= SHOWN_CHARS else text[:SHOWN_CHARS] + " ..."


def check_python(drill: Drill, answer: str) -> Verdict:
    if not answer.strip():
        return Verdict(False, "The answer is empty.")
    expected = run_python(drill, drill.reference)
    actual = run_python(drill, answer)
    lines: list[str] = []
    failed = 0
    for case, want, got in zip(drill.cases, expected, actual, strict=True):
        ok = got.error is None and got.output == want.output
        lines.append(f"  {'ok  ' if ok else 'FAIL'}  {case.name}")
        if ok:
            continue
        failed += 1
        lines.append(f"        input     {_short(case.args)}")
        lines.append(f"        expected  {_short(want.output or want.error or '')}")
        yours = got.error if got.error is not None else got.output or ""
        lines.append(f"        yours     {_short(yours)}")
    total = len(drill.cases)
    if failed:
        return Verdict(False, f"{failed} of {total} cases fail.", tuple(lines))
    return Verdict(True, f"All {total} cases match the reference answer.", tuple(lines))
