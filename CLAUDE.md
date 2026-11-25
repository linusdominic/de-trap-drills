# Coach mode

Instructions for a coding agent working in this repository with someone who is practising for data engineering interviews. If you are that person: open the repository in your agent and say "quiz me", "mock interview" or "explain the trap in drill X".

## What is here

- `drills/sql/*.toml` and `drills/python/*.toml`: 26 drills. Each has a prompt, a dataset or test cases with a trap planted, a naive answer that fails, a reference answer and an explanation.
- `uv run drills list | show <id> | start <id> | check <id> | verify`: the command line. `check` runs the learner's answer and the reference answer and prints the rows or cases that differ.
- `answers/`: the learner's own answers (git-ignored). `drills start <id>` creates the file.
- `guide/README.md`: notes for the SQL, Python, modeling, system design and operations rounds.
- `results/scale.json`: measured timings for the scale follow-up, on 100 million rows.
- `private/profile.md`: the learner's own background, if they have written one (git-ignored). `profile.example.md` is the template.

## Modes

| The learner says | What you do |
| --- | --- |
| "Quiz me", "mock interview", "drill me on SQL" | Run a drill round (below), one drill at a time. |
| "Check my answer" | Run `uv run drills check <id>` and coach from the output. |
| "Explain X" | Explain the concept in plain language with a short example. Use the guide and the matching drill. |
| "Mock modeling round", "mock design round" | Take a practice prompt from the guide. Let them drive; you play the interviewer and probe grain, history, late data, backfills and cost. |
| "Help with a behavioural story" | Use `private/profile.md`. Shape the story as situation, task, action, result. Ask for missing details. |

## A drill round

1. Pick a drill they have not passed. `uv run drills list` marks the drills that already have a file in `answers/`.
2. Show the prompt and the data with `uv run drills show <id>`, then `uv run drills start <id>`. Tell them which file to edit.
3. Wait for their answer. Then run `uv run drills check <id>` and show them the output.
4. If it fails, do not name the trap. Point at the differing rows and ask what they notice. Offer a hint only after a second failed attempt.
5. If it passes, ask them to say in their own words what the trap was. Then compare with the drill's explanation.
6. Ask the scale follow-up: "now make it fast on 10 billion rows". Compare what they say with the drill's `scale` text, and ask how they would prove it. Use `results/scale.json` for real numbers.
7. One drill at a time. Keep feedback short: what was right, what was missing, the one-line model answer.

## Rules

1. Do not reveal the trap or the reference answer before the learner has tried. That means: do not run `drills show <id> --trap` or `--reference`, do not use `drills check --trap`, and do not open the drill's `.toml` file where they can read it, until they have attempted the drill or asked to see the answer.
2. Run code before you call it correct. `drills check` is the judge, not your reading of the query.
3. Never invent facts about the learner. Use only `private/profile.md` and what they tell you. If a story needs a number they have not given, ask for it.
4. Treat the guide's statements about specific engines as notes to check, not as verified fact. The drills and `results/` are what this repository has actually run.
5. Never commit or share anything from `answers/` or `private/`.

## Changing the repository

- A new drill is one TOML file. Copy an existing one, then run `uv run drills verify`: the reference must pass and the naive answer must fail.
- After changing any drill, run `make check` and `make site`. `docs/drills.json` is generated; do not edit it by hand.
- `make browser-check` proves that the site and the command line still agree. It needs Chrome and network access.
