"""The drills command: list, show, start, check, verify, build-site."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from trapdrills import sitebuild
from trapdrills.model import ROOT, Drill, DrillError, get_drill, load_drills
from trapdrills.pycheck import check_python
from trapdrills.sqlcheck import check_sql, dataset
from trapdrills.verdict import Verdict, render_table

ANSWERS = ROOT / "answers"


def check(drill: Drill, answer: str) -> Verdict:
    return check_sql(drill, answer) if drill.track == "sql" else check_python(drill, answer)


def answer_path(drill: Drill) -> Path:
    return ANSWERS / f"{drill.id}.{drill.extension}"


def _indent(text: str) -> str:
    return "\n".join(f"  {line}" if line else "" for line in text.rstrip().splitlines())


def cmd_list(_: argparse.Namespace) -> int:
    drills = load_drills()
    width = max(len(d.id) for d in drills)
    for track in ("sql", "python"):
        print(f"\n{track.upper()}")
        for drill in (d for d in drills if d.track == track):
            done = "*" if answer_path(drill).exists() else " "
            print(f" {done} {drill.id.ljust(width)}  {drill.family.ljust(12)}  {drill.title}")
    print(f"\n{len(drills)} drills. * = you have a file in answers/. Next: drills show <id>")
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    drill = get_drill(args.id)
    print(f"{drill.title}\n{drill.track} / {drill.pattern} / trap family: {drill.family}\n")
    print(drill.prompt.rstrip())
    if drill.track == "sql":
        print(f"\nReturn these columns, in this order: {', '.join(drill.columns)}")
        print("Row order matters." if drill.ordered else "Row order does not matter.")
        for name, table in dataset(drill):
            print(
                f"\n{name} ({', '.join(f'{c} {t}' for c, t in zip(table.columns, table.types, strict=True))})"
            )
            print("\n".join(render_table(table.columns, table.rows)))
    else:
        print(f"\nDefine: {drill.function}")
        for case in drill.cases:
            print(f"  case '{case.name}': {case.args}")
    if args.trap:
        print(f"\nTHE TRAP\n{_indent(drill.trap)}")
        if drill.scale:
            print(f"\nAT SCALE\n{_indent(drill.scale)}")
    if args.reference:
        print(f"\nREFERENCE ANSWER\n{_indent(drill.reference)}")
    if not args.trap and not args.reference:
        print(f"\nNext: drills start {drill.id}")
    return 0


def cmd_start(args: argparse.Namespace) -> int:
    drill = get_drill(args.id)
    path = answer_path(drill)
    if path.exists() and not args.force:
        print(f"{path.relative_to(ROOT)} already exists (use --force to reset it).")
        return 1
    ANSWERS.mkdir(exist_ok=True)
    path.write_text(drill.starter, encoding="utf-8")
    print(f"Wrote {path.relative_to(ROOT)}. Edit it, then run: drills check {drill.id}")
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    drill = get_drill(args.id)
    path = Path(args.file) if args.file else answer_path(drill)
    if not path.exists():
        print(f"No answer at {path}. Run: drills start {drill.id}")
        return 2
    verdict = check(drill, path.read_text(encoding="utf-8"))
    print(verdict.text())
    if verdict.passed:
        print(f"\nTHE TRAP YOU AVOIDED\n{_indent(drill.trap)}")
        if drill.scale:
            print(f"\nAT SCALE\n{_indent(drill.scale)}")
    elif args.trap:
        print(f"\nTHE TRAP\n{_indent(drill.trap)}")
    else:
        print(f"\nStuck? drills check {drill.id} --trap")
    return 0 if verdict.passed else 1


def cmd_verify(_: argparse.Namespace) -> int:
    """Every reference answer must pass and every naive answer must fail."""
    problems = 0
    drills = load_drills()
    for drill in drills:
        reference = check(drill, drill.reference)
        naive = check(drill, drill.naive)
        ok = reference.passed and not naive.passed
        problems += not ok
        state = "ok" if ok else "PROBLEM"
        print(
            f"{state:8} {drill.track:6} {drill.id:36} reference {'passes' if reference.passed else 'FAILS'}, naive {'fails' if not naive.passed else 'PASSES'}"
        )
        if not reference.passed:
            print(reference.text())
    print(f"\n{len(drills)} drills, {problems} problems.")
    return 1 if problems else 0


def cmd_build_site(args: argparse.Namespace) -> int:
    """Refresh the two generated artefacts: docs/drills.json and the result blocks in README.md."""
    readme_now = sitebuild.README.read_text(encoding="utf-8")
    wanted = {sitebuild.TARGET: sitebuild.build(), sitebuild.README: sitebuild.readme(readme_now)}
    stale = [
        path for path, text in wanted.items() if not path.exists() or path.read_text(encoding="utf-8") != text
    ]
    if args.check:
        for path in stale:
            print(f"{path.relative_to(ROOT)} is out of date. Run: drills build-site")
        if not stale:
            print("docs/drills.json and the README result blocks are up to date.")
        return 1 if stale else 0
    for path, text in wanted.items():
        path.write_text(text, encoding="utf-8")
    print(
        f"Wrote docs/drills.json ({len(wanted[sitebuild.TARGET]) / 1024:.0f} KB) and the README result blocks."
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="drills", description="Data engineering drills where the obvious answer fails."
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="every drill, by track").set_defaults(run=cmd_list)
    show = sub.add_parser("show", help="the prompt and the dataset of one drill")
    show.add_argument("id")
    show.add_argument("--trap", action="store_true", help="also explain the trap")
    show.add_argument("--reference", action="store_true", help="also print the reference answer")
    show.set_defaults(run=cmd_show)
    start = sub.add_parser("start", help="create answers/<id>.sql or .py from the starter")
    start.add_argument("id")
    start.add_argument("--force", action="store_true")
    start.set_defaults(run=cmd_start)
    chk = sub.add_parser("check", help="run your answer and compare it with the reference")
    chk.add_argument("id")
    chk.add_argument("file", nargs="?", help="default: answers/<id>.sql or .py")
    chk.add_argument("--trap", action="store_true", help="explain the trap when the answer fails")
    chk.set_defaults(run=cmd_check)
    sub.add_parser("verify", help="check every reference passes and every naive answer fails").set_defaults(
        run=cmd_verify
    )
    build = sub.add_parser("build-site", help="write docs/drills.json and the README result blocks")
    build.add_argument("--check", action="store_true", help="fail if either is out of date")
    build.set_defaults(run=cmd_build_site)
    args = parser.parse_args(argv)
    try:
        return int(args.run(args))
    except (KeyError, DrillError) as exc:
        print(str(exc).strip("'\""), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
