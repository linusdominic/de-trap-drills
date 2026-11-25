"""Check a predict drill: the learner's choice against what the engine was recorded doing."""

from __future__ import annotations

import hashlib
import string

from trapdrills.model import Drill, Option
from trapdrills.verdict import Verdict


def fingerprint(drill: Drill) -> str:
    """The same hash the evidence tools store, so a drill edited after its run is caught."""
    return hashlib.sha256((drill.code + "\n" + drill.measure).encode()).hexdigest()[:12]


def chosen(drill: Drill, answer: str) -> Option | None:
    """Read the answer: an option letter (A, B, ...) or an option value, on the last line that is not a comment."""
    lines = [
        line.strip() for line in answer.splitlines() if line.strip() and not line.strip().startswith("#")
    ]
    if not lines:
        return None
    text = lines[-1]
    for letter, option in zip(string.ascii_uppercase, drill.options, strict=False):
        if text.upper() == letter or text == option.value:
            return option
    return None


def check_predict(drill: Drill, answer: str) -> Verdict:
    option = chosen(drill, answer)
    if option is None:
        letters = ", ".join(string.ascii_uppercase[: len(drill.options)])
        return Verdict(False, f"Answer with one of the letters {letters}.")
    lines = (f"  You chose: {option.text}", f"  {option.why}")
    if option.value == drill.reference:
        return Verdict(True, "That is what the engine did.", lines)
    return Verdict(False, "That is not what the engine did.", lines)
