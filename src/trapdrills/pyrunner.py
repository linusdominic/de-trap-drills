"""Run one Python answer against a drill's cases and report each case's output.

This file is self-contained on purpose (standard library only, no package imports):
the CLI runs it in a separate interpreter (python -I -c <this source>) and the site
runs the same source inside Pyodide, so both check answers with the same code.

Case arguments are JSON. Two wrappers turn a JSON value into something a list is not:
  {"$stream": [...]}        an iterator over the list: one pass, no len(), no indexing
  {"$endless": [start, step]}  a stream that never ends; it raises after ENDLESS_LIMIT
                               items so a non-lazy answer fails fast instead of hanging
"""

import contextlib
import io
import itertools
import json
import sys

ENDLESS_LIMIT = 100_000


def _endless(start, step):
    for n, value in enumerate(itertools.count(start, step)):
        if n >= ENDLESS_LIMIT:
            raise RuntimeError(
                f"read {ENDLESS_LIMIT} items from a stream that never ends; take items only as you need them"
            )
        yield value


def _build(arg):
    if isinstance(arg, dict) and len(arg) == 1:
        if "$stream" in arg:
            return iter(arg["$stream"])
        if "$endless" in arg:
            return _endless(*arg["$endless"])
    return arg


def _plain(value):
    """Reduce a result to JSON so two answers can be compared as text."""
    if isinstance(value, bool) or value is None or isinstance(value, (str, int)):
        return value
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, dict):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (set, frozenset)):
        return sorted((_plain(item) for item in value), key=repr)
    if hasattr(value, "__iter__"):
        return [_plain(item) for item in value]
    return repr(value)


def run_case(fn, case):
    try:
        args = [_build(arg) for arg in json.loads(case["args"])]
        with contextlib.redirect_stdout(io.StringIO()):
            value = fn(*args)
            if case.get("take") is not None:
                value = list(itertools.islice(iter(value), case["take"]))
            output = json.dumps(_plain(value), sort_keys=True)
        return {"name": case["name"], "output": output, "error": None}
    except (Exception, SystemExit) as exc:
        return {"name": case["name"], "output": None, "error": f"{type(exc).__name__}: {exc}"}


def run_cases(code, function, cases, emit):
    """Call emit(result) once per case, in order."""
    try:
        namespace = {"__name__": "answer"}
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compile(code, "answer.py", "exec"), namespace)
        fn = namespace.get(function)
        if not callable(fn):
            raise NameError(f"define a function called {function}")
    except (Exception, SystemExit) as exc:
        for case in cases:
            emit({"name": case["name"], "output": None, "error": f"{type(exc).__name__}: {exc}"})
        return
    for case in cases:
        emit(run_case(fn, case))


def run_cases_json(code, function, cases_json):
    """The entry point the site calls: JSON in, JSON out."""
    results = []
    run_cases(code, function, json.loads(cases_json), results.append)
    return json.dumps(results)


if __name__ == "__main__":
    payload = json.loads(sys.stdin.read())
    out = sys.stdout

    def _emit(result):
        out.write(json.dumps(result) + "\n")
        out.flush()

    run_cases(payload["code"], payload["function"], payload["cases"], _emit)
