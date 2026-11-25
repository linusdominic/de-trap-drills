"""Drill files: one TOML file per drill under drills/sql and drills/python.

The file name is NN-drill-id.toml. NN only sets the order; the id is the rest.
"""

from __future__ import annotations

import json
import tomllib
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
TRACKS = ("sql", "python")
FAMILIES = (
    "Duplicates",
    "Ties",
    "Missing rows",
    "NULLs",
    "Grain",
    "Time",
    "History",
    "Messy input",
    "Streams",
)
SQL_STARTER = "-- Write your query here\n"


class DrillError(ValueError):
    """A drill file is malformed."""


@dataclass(frozen=True)
class Case:
    """One call of a Python drill's function. args is a JSON array of positional arguments."""

    name: str
    args: str
    take: int | None = None


@dataclass(frozen=True)
class Drill:
    id: str
    number: int
    track: str
    family: str
    pattern: str
    title: str
    prompt: str
    starter: str
    naive: str
    reference: str
    trap: str
    scale: str = ""
    experiment: str | None = None
    # SQL drills
    setup: str = ""
    columns: tuple[str, ...] = ()
    ordered: bool = False
    check_query: str | None = None
    # Python drills
    function: str | None = None
    cases: tuple[Case, ...] = ()

    @property
    def extension(self) -> str:
        return "sql" if self.track == "sql" else "py"


def _text(data: dict[str, Any], key: str, path: Path, *, default: str | None = None) -> str:
    value = data.get(key, default)
    if not isinstance(value, str) or not value.strip():
        raise DrillError(f"{path.name}: '{key}' must be a non-empty string")
    stripped = value.strip()
    return stripped + "\n" if "\n" in stripped else stripped


def load_drill(path: Path, track: str) -> Drill:
    with path.open("rb") as handle:
        data = tomllib.load(handle)
    number, _, drill_id = path.stem.partition("-")
    if not number.isdigit() or not drill_id:
        raise DrillError(f"{path.name}: name the file NN-drill-id.toml")
    family = _text(data, "family", path)
    if family not in FAMILIES:
        raise DrillError(f"{path.name}: unknown family '{family}'")
    experiment = data.get("experiment")
    drill = Drill(
        id=drill_id,
        number=int(number),
        track=track,
        family=family,
        pattern=_text(data, "pattern", path),
        title=_text(data, "title", path),
        prompt=_text(data, "prompt", path),
        starter=_text(data, "starter", path, default=SQL_STARTER if track == "sql" else None),
        naive=_text(data, "naive", path),
        reference=_text(data, "reference", path),
        trap=_text(data, "trap", path),
        scale=_text(data, "scale", path) if "scale" in data else "",
        experiment=experiment if isinstance(experiment, str) else None,
    )
    if track == "sql":
        columns = data.get("columns")
        if not isinstance(columns, list) or not columns or not all(isinstance(c, str) for c in columns):
            raise DrillError(f"{path.name}: 'columns' must list the expected column names")
        check_query = data.get("check_query")
        return replace(
            drill,
            setup=_text(data, "setup", path),
            columns=tuple(columns),
            ordered=bool(data.get("ordered", False)),
            check_query=check_query.strip() if isinstance(check_query, str) else None,
        )
    raw_cases = data.get("cases")
    if not isinstance(raw_cases, list) or not raw_cases:
        raise DrillError(f"{path.name}: a Python drill needs at least one [[cases]] entry")
    cases = []
    for raw in raw_cases:
        args = _text(raw, "args", path)
        if not isinstance(json.loads(args), list):
            raise DrillError(f"{path.name}: case args must be a JSON array of positional arguments")
        take = raw.get("take")
        cases.append(
            Case(name=_text(raw, "name", path), args=args, take=take if isinstance(take, int) else None)
        )
    return replace(drill, function=_text(data, "function", path), cases=tuple(cases))


def load_drills(root: Path = ROOT) -> list[Drill]:
    drills: list[Drill] = []
    for track in TRACKS:
        for path in sorted((root / "drills" / track).glob("*.toml")):
            drills.append(load_drill(path, track))
    ids = [d.id for d in drills]
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        raise DrillError(f"duplicate drill ids: {', '.join(duplicates)}")
    return drills


def get_drill(drill_id: str, root: Path = ROOT) -> Drill:
    drills = load_drills(root)
    for drill in drills:
        if drill.id == drill_id:
            return drill
    close = [d.id for d in drills if drill_id in d.id]
    hint = f" Did you mean: {', '.join(close)}?" if close else " Run 'drills list'."
    raise KeyError(f"No drill called '{drill_id}'.{hint}")
