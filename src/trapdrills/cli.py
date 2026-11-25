"""The drills command: list, show, start, check, paths, concepts, verify, build-site."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from trapdrills import sitebuild
from trapdrills.content import (
    Concept,
    LearningPath,
    Step,
    load_concepts,
    load_paths,
    run_python_example,
    run_sql_example,
)
from trapdrills.model import ROOT, TRACK_NAMES, TRACKS, Drill, DrillError, get_drill, load_drills
from trapdrills.predictcheck import check_predict
from trapdrills.pycheck import check_python
from trapdrills.sqlcheck import check_sql, dataset
from trapdrills.verdict import Verdict, render_table

ANSWERS = ROOT / "answers"


def check(drill: Drill, answer: str) -> Verdict:
    if drill.kind == "predict":
        return check_predict(drill, answer)
    return check_sql(drill, answer) if drill.track == "sql" else check_python(drill, answer)


def _evidence(drill: Drill) -> str:
    assert drill.evidence is not None
    recorded = drill.evidence
    return f"WHAT {recorded.engine.upper()} {recorded.version} PRINTED ({recorded.date}; {recorded.setup})\n{_indent(recorded.output)}"


def answer_path(drill: Drill) -> Path:
    return ANSWERS / f"{drill.id}.{drill.extension}"


def _indent(text: str) -> str:
    return "\n".join(f"  {line}" if line else "" for line in text.rstrip().splitlines())


def cmd_list(_: argparse.Namespace) -> int:
    drills = load_drills()
    width = max(len(d.id) for d in drills)
    for track in TRACKS:
        print(f"\n{TRACK_NAMES[track].upper()}")
        for drill in (d for d in drills if d.track == track):
            done = "*" if answer_path(drill).exists() else " "
            print(f" {done} {drill.id.ljust(width)}  {drill.family.ljust(12)}  {drill.title}")
    print(f"\n{len(drills)} drills. * = you have a file in answers/. Next: drills show <id>")
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    drill = get_drill(args.id)
    print(f"{drill.title}\n{drill.track} / {drill.pattern} / trap family: {drill.family}\n")
    print(drill.prompt.rstrip())
    if drill.kind == "predict":
        print(f"\n{_indent(drill.code)}\n\n{drill.question}")
        for letter, option in zip("ABCDEFGH", drill.options, strict=False):
            print(f"  {letter}. {option.text}")
    elif drill.track == "sql":
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
    if args.reference and drill.kind == "predict":
        right = next(option for option in drill.options if option.value == drill.reference)
        print(f"\nANSWER\n  {right.text}\n\n{_evidence(drill)}")
    elif args.reference:
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
        if drill.kind == "predict":
            print(f"\n{_evidence(drill)}")
        print(f"\nTHE TRAP YOU AVOIDED\n{_indent(drill.trap)}")
        if drill.scale:
            print(f"\nAT SCALE\n{_indent(drill.scale)}")
    elif args.trap:
        print(f"\nTHE TRAP\n{_indent(drill.trap)}")
    else:
        print(f"\nStuck? drills check {drill.id} --trap")
    return 0 if verdict.passed else 1


def _find[T: (Concept, LearningPath)](items: list[T], item_id: str, what: str) -> T:
    for item in items:
        if item.id == item_id:
            return item
    close = [i.id for i in items if item_id in i.id]
    hint = f" Did you mean: {', '.join(close)}?" if close else f" Run 'drills {what}s'."
    raise KeyError(f"No {what} called '{item_id}'.{hint}")


def cmd_paths(_: argparse.Namespace) -> int:
    paths = load_paths()
    width = max(len(p.id) for p in paths)
    for path in paths:
        concepts = sum(step.kind == "concept" for step in path.steps)
        print(
            f"  {path.id.ljust(width)}  {path.title}  ({concepts} concepts, {len(path.steps) - concepts} drills)"
        )
        print(f"  {' ' * width}  {path.summary}")
    print(f"\n{len(paths)} paths. Next: drills path <id>")
    return 0


def cmd_path(args: argparse.Namespace) -> int:
    path = _find(load_paths(), args.id, "path")
    drills = {d.id: d for d in load_drills()}
    concepts = {c.id: c for c in load_concepts()}

    def line(step: Step) -> str:
        if step.kind == "concept":
            return f"     concept  {step.id:36} {concepts[step.id].title}"
        done = "*" if answer_path(drills[step.id]).exists() else " "
        return f"   {done} drill    {step.id:36} {drills[step.id].title}"

    print(f"{path.title} ({path.round})\n{path.summary}\nAfter this path: {path.outcome}")
    for number, stage in enumerate(path.stages, start=1):
        print(f"\n{number}. {stage.title}\n   {stage.note}")
        print("\n".join(line(step) for step in stage.steps))
    print("\n* = you have a file in answers/. Next: drills concept <id>, or drills show <id>")
    return 0


def cmd_concepts(_: argparse.Namespace) -> int:
    concepts = load_concepts()
    width = max(len(c.id) for c in concepts)
    area = ""
    for concept in concepts:
        if concept.area != area:
            area = concept.area
            print(f"\n{area.upper()}")
        print(f"  {concept.id.ljust(width)}  {concept.level:8}  {concept.title}")
    print(f"\n{len(concepts)} concepts. Next: drills concept <id>")
    return 0


def cmd_concept(args: argparse.Namespace) -> int:
    concept = _find(load_concepts(), args.id, "concept")
    print(
        f"{concept.title}\n{concept.area} / {concept.level}\n\n{concept.summary}\n\n{concept.idea.rstrip()}"
    )
    for number, example in enumerate(concept.examples, start=1):
        print(f"\nEXAMPLE {number}: {example.title}\n{_indent(example.code)}")
        if example.kind == "sql":
            table = run_sql_example(example)
            print("\n".join(render_table(table.columns, table.rows)))
        else:
            print(_indent(run_python_example(example)))
        if example.note:
            print(f"  {example.note}")
    print("\nHOW IT IS ASKED")
    print("\n".join(f"  - {question}" for question in concept.asked))
    print("\nWHAT A STRONG ANSWER COVERS")
    print("\n".join(f"  - {point}" for point in concept.answer))
    if args.probes:
        print("\nFOLLOW-UP QUESTIONS")
        for probe in concept.probes:
            print(f"  Q: {probe.q}\n  A: {probe.a}")
    else:
        print(
            f"\n{len(concept.probes)} follow-up questions with answers: drills concept {concept.id} --probes"
        )
    if concept.drills:
        print(f"\nPractise: {', '.join(concept.drills)}")
    return 0


def cmd_verify(_: argparse.Namespace) -> int:
    """Every reference answer must pass, every naive answer must fail, every example must run."""
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
    examples = 0
    concepts = load_concepts()
    for concept in concepts:
        for number, example in enumerate(concept.examples, start=1):
            examples += 1
            try:
                ran = (
                    bool(run_sql_example(example).rows)
                    if example.kind == "sql"
                    else bool(run_python_example(example).strip())
                )
            except Exception as exc:
                ran = False
                print(f"PROBLEM  concept {concept.id} example {number}: {exc}")
            problems += not ran
    print(
        f"\n{len(drills)} drills, {len(concepts)} concepts with {examples} examples that run, "
        f"{len(load_paths())} paths, {problems} problems."
    )
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
    sub.add_parser("paths", help="the learning paths, one per interview round").set_defaults(run=cmd_paths)
    path = sub.add_parser("path", help="the stages and steps of one path")
    path.add_argument("id")
    path.set_defaults(run=cmd_path)
    sub.add_parser("concepts", help="every concept page, by area").set_defaults(run=cmd_concepts)
    concept = sub.add_parser("concept", help="read one concept, with its examples run")
    concept.add_argument("id")
    concept.add_argument(
        "--probes", action="store_true", help="also print the follow-up questions and answers"
    )
    concept.set_defaults(run=cmd_concept)
    sub.add_parser(
        "verify", help="check every reference passes, every naive answer fails and every example runs"
    ).set_defaults(run=cmd_verify)
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
