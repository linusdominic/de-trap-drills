"""The result of checking one answer, and a plain-text table for the terminal."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class Verdict:
    passed: bool
    headline: str
    lines: tuple[str, ...] = ()

    def text(self) -> str:
        mark = "PASS" if self.passed else "FAIL"
        return "\n".join([f"{mark}  {self.headline}", *self.lines])


def render_table(
    columns: Sequence[str], rows: Sequence[Sequence[str | None]], indent: str = "  "
) -> list[str]:
    """A fixed-width table. NULL is spelled out so it cannot be mistaken for an empty string."""
    cells = [["NULL" if value is None else value for value in row] for row in rows]
    widths = [len(name) for name in columns]
    for row in cells:
        for i, value in enumerate(row):
            if i < len(widths):
                widths[i] = max(widths[i], len(value))
    lines = [indent + "  ".join(name.ljust(widths[i]) for i, name in enumerate(columns)).rstrip()]
    lines.append(indent + "  ".join("-" * width for width in widths))
    for row in cells:
        lines.append(indent + "  ".join(value.ljust(widths[i]) for i, value in enumerate(row)).rstrip())
    return lines
