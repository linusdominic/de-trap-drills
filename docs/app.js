// Trap Drills: the browser site. No build step and no server.
//
// This file is the pages: paths, concepts, the drill workspace, the mock round and
// the command palette. The engines and the checking rules are in engine.js, the code
// editor in editor.js. Progress is kept in this browser's local storage and nowhere else.

import {
  DUCKDB_WASM,
  PYODIDE,
  checkDrill,
  isBlank,
  pythonInfo,
  runExample,
  runPython,
  runSql,
  setRunner,
  sqlEngine,
  sqlLoaded,
} from "./engine.js?v=20261126c";
import { createEditor, highlight } from "./editor.js?v=20261126c";

const ASSETS = "20261126c";
const STORE = "trapdrills:v2";
const OLD_STORE = "trapdrills:v1";
const SHOWN = 6;

const FAMILY_NOTES = {
  "Duplicates": "The table has more rows than the thing you are counting.",
  "Ties": "Two rows share the value you rank by.",
  "Missing rows": "A day, a month or a group has no rows, and the query quietly skips it.",
  "NULLs": "A comparison with NULL is neither true nor false.",
  "Grain": "Rows are multiplied or mis-weighted before they are aggregated.",
  "Time": "Boundaries, time zones and the order of events.",
  "History": "The value that is true now is not the value that was true then.",
  "Messy input": "The file is not as clean as the example in the spec.",
  "Streams": "The input is read once, arrives out of order, or never ends.",
  "Laziness": "Nothing runs until an action asks for it, and then everything runs again.",
  "Partitions": "The number of tasks, and which rows share one, is not what the code suggests.",
  "Plans": "The optimizer decided something you cannot see in the code. It is in the plan.",
  "Columns": "Columns are matched by position, not by name.",
  "Scheduling": "When a run happens and what period it covers depend on the version and its defaults.",
  "Reruns": "The task does something different the second time it runs.",
  "Parsing": "The DAG file is ordinary Python, and it is imported again and again.",
  "Dependencies": "A skipped task changes what the tasks after it do.",
};

const TRACKS = { sql: "SQL", python: "Python", spark: "Spark", airflow: "Airflow" };

const MOCKS = {
  sql: { label: "SQL round", pick: { sql: 3 }, minutes: 45, text: "Three SQL drills, as in a SQL screen." },
  python: { label: "Python round", pick: { python: 2 }, minutes: 40, text: "Two Python drills, as in a coding screen." },
  mixed: { label: "Mixed round", pick: { sql: 2, python: 1 }, minutes: 45, text: "Two SQL drills and one Python drill." },
  engines: { label: "Spark and Airflow round", pick: { spark: 3, airflow: 2 }, minutes: 15, text: "Five predictions about Spark and Airflow. One attempt each, as when an interviewer asks what a piece of code does." },
};
const mockSize = (spec) => Object.values(spec.pick).reduce((a, b) => a + b, 0);

const stroke = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ICON = {
  check: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 5" ${stroke}/></svg>`,
  arrow: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8h9.5M8.5 4l4 4-4 4" ${stroke}/></svg>`,
  back: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13 8H3.5M7.5 4l-4 4 4 4" ${stroke}/></svg>`,
  book: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 4.2C6.8 3.4 5 3.2 2.5 3.2v8.6c2.5 0 4.3.2 5.5 1 1.2-.8 3-1 5.5-1V3.2c-2.5 0-4.3.2-5.5 1zM8 4.2v8.6" ${stroke}/></svg>`,
  code: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" ${stroke}/></svg>`,
  clock: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="5.5" ${stroke}/><path d="M8 5v3.2l2 1.3" ${stroke}/></svg>`,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const main = $("#main");
const state = {
  data: null,
  drills: [],
  concepts: [],
  paths: [],
  byDrill: new Map(),
  byConcept: new Map(),
  byPath: new Map(),
  conceptsOf: new Map(),
  store: loadStore(),
  filters: { level: "all", track: "all", status: "all" },
};
const cleanup = [];

// ---------------------------------------------------------------- small helpers

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function inline(text) {
  return text
    .split("`")
    .map((part, i) => {
      if (i % 2) return `<code>${esc(part)}</code>`;
      return esc(part).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
    })
    .join("");
}

function proseBlocks(text) {
  let html = "";
  for (const block of text.trim().split(/\n\s*\n/)) {
    // Within a block, consecutive list lines form a list and the rest form paragraphs.
    const groups = [];
    for (const line of block.split("\n")) {
      const kind = /^- /.test(line) ? "ul" : /^\d+\. /.test(line) ? "ol" : "p";
      const last = groups[groups.length - 1];
      if (last && last.kind === kind) last.lines.push(line);
      else groups.push({ kind, lines: [line] });
    }
    for (const group of groups) {
      if (group.kind === "p") html += `<p>${inline(group.lines.join(" "))}</p>`;
      else html += `<${group.kind}>${group.lines.map((l) => `<li>${inline(l.replace(/^(- |\d+\. )/, ""))}</li>`).join("")}</${group.kind}>`;
    }
  }
  return html;
}

const codeBlock = (code, language) => `<pre class="code">${highlight(code.replace(/\n+$/, ""), language === "py" ? "python" : language)}</pre>`;

// The texts use a small subset of Markdown: paragraphs, lists, `code`, **bold**,
// *italic* and fenced code blocks.
function md(text) {
  const parts = text.trim().split(/```(\w*)\n([\s\S]*?)```/);
  let html = "";
  for (let i = 0; i < parts.length; i += 3) {
    if (parts[i].trim()) html += proseBlocks(parts[i]);
    if (i + 2 < parts.length) html += codeBlock(parts[i + 2], parts[i + 1]);
  }
  return html;
}

function loadStore() {
  const blank = { solved: {}, drafts: {}, read: {}, help: {}, path: null, mock: null };
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE) || localStorage.getItem(OLD_STORE) || "{}");
    const store = { ...blank };
    for (const key of ["solved", "drafts", "read", "help"]) if (parsed[key] && typeof parsed[key] === "object") store[key] = parsed[key];
    if (typeof parsed.path === "string") store.path = parsed.path;
    if (parsed.mock && Array.isArray(parsed.mock.ids)) store.mock = parsed.mock;
    return store;
  } catch {
    return blank;
  }
}

function saveStore() {
  try {
    localStorage.setItem(STORE, JSON.stringify(state.store));
  } catch {
    // Private windows and blocked storage: progress just lasts for this visit.
  }
}

function dataTable(columns, rows, types) {
  const head = columns.map((c, i) => `<th>${esc(c)}${types ? `<small>${esc(types[i].toLowerCase())}</small>` : ""}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((v) => (v === null ? '<td class="null">NULL</td>' : `<td>${esc(v)}</td>`)).join("")}</tr>`)
    .join("");
  return `<table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

const tableCard = (t) =>
  `<div class="table-wrap"><div class="table-name">${esc(t.name)}<span>${t.rows.length} ${t.rows.length === 1 ? "row" : "rows"}</span></div>${dataTable(t.columns, t.rows, t.types)}</div>`;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const meter = (done, total) => `<span class="meter" role="img" aria-label="${done} of ${total} done"><i style="width:${total ? (done / total) * 100 : 0}%"></i></span>`;

// ---------------------------------------------------------------- paths and progress

const flat = (path) => path.stages.flatMap((stage) => stage.steps);
const itemOf = (step) => (step.kind === "drill" ? state.byDrill.get(step.id) : state.byConcept.get(step.id));
const isDone = (step) => Boolean(step.kind === "drill" ? state.store.solved[step.id] : state.store.read[step.id]);
const hrefOf = (step, path) => `#/${step.kind === "drill" ? "d" : "c"}/${step.id}${path ? `/in/${path.id}` : ""}`;

function progressOf(path) {
  const steps = flat(path);
  return { steps, done: steps.filter(isDone).length, total: steps.length, next: steps.find((s) => !isDone(s)) || null };
}

// The path a drill or concept is shown in: the one in the link, else the path the
// learner was last on, else the first path that contains it.
function contextFor(kind, id, explicit) {
  const has = (path) => Boolean(path) && flat(path).some((s) => s.kind === kind && s.id === id);
  if (has(state.byPath.get(explicit))) return state.byPath.get(explicit);
  if (has(state.byPath.get(state.store.path))) return state.byPath.get(state.store.path);
  return state.paths.find(has) || null;
}

function kindBadge(step) {
  if (step.kind === "concept") return `<span class="kind concept">${ICON.book}Concept</span>`;
  const drill = state.byDrill.get(step.id);
  return `<span class="kind drill">${ICON.code}${TRACKS[drill.track]} drill</span>`;
}

function stepRow(step, path, isNext) {
  const item = itemOf(step);
  const done = isDone(step);
  const sub = step.kind === "concept" ? item.summary : `${item.pattern} · trap family: ${item.family}`;
  const level = step.kind === "concept" && item.level === "advanced" ? '<span class="chip quiet">Advanced</span>' : "";
  return `<li><a class="step-row${done ? " done" : ""}${isNext ? " next" : ""}" href="${hrefOf(step, path)}">
    <span class="status" aria-hidden="true">${done ? ICON.check : ""}</span>
    <span class="step-main"><span class="step-top">${kindBadge(step)}${level}${isNext ? '<span class="chip">Next</span>' : ""}</span>
      <span class="step-title">${esc(item.title)}</span><span class="step-sub">${inline(sub)}</span></span>
    <span class="go" aria-hidden="true">${ICON.arrow}</span><span class="sr">${done ? "Done" : "Not done"}</span></a></li>`;
}

function stepBar(path, kind, id) {
  const steps = flat(path);
  const index = steps.findIndex((s) => s.kind === kind && s.id === id);
  const stageIndex = path.stages.findIndex((stage) => stage.steps.includes(steps[index]));
  const previous = steps[index - 1];
  const next = steps[index + 1];
  const dots = path.stages
    .map(
      (stage) =>
        `<span class="dot-group">${stage.steps
          .map((s) => {
            const j = steps.indexOf(s);
            const label = `Step ${j + 1}: ${itemOf(s).title}${isDone(s) ? " (done)" : ""}`;
            return `<a class="dot${isDone(s) ? " done" : ""}${j === index ? " now" : ""}" href="${hrefOf(s, path)}" title="${esc(label)}" aria-label="${esc(label)}"${j === index ? ' aria-current="step"' : ""}></a>`;
          })
          .join("")}</span>`
    )
    .join("");
  return `<nav class="stepbar" aria-label="Where you are in the path">
    <a class="stepbar-path" href="#/path/${path.id}">${ICON.back}<span>${esc(path.title)}</span></a>
    <span class="stepbar-stage">Stage ${stageIndex + 1} of ${path.stages.length}: ${esc(path.stages[stageIndex].title)}</span>
    <span class="dots">${dots}</span>
    <span class="stepbar-count">${index + 1} / ${steps.length}</span>
    <span class="stepbar-nav">
      ${previous ? `<a class="button small" href="${hrefOf(previous, path)}">Previous</a>` : ""}
      ${next ? `<a class="button small" href="${hrefOf(next, path)}">Next</a>` : ""}
    </span>
  </nav>`;
}

function nextLink(path, kind, id, primary = true) {
  const cls = `button${primary ? " primary" : ""}`;
  if (!path) return `<a class="${cls}" href="#/${kind === "drill" ? "drills" : "concepts"}">Back to all ${kind}s</a>`;
  const steps = flat(path);
  const next = steps[steps.findIndex((s) => s.kind === kind && s.id === id) + 1];
  if (!next) return `<a class="${cls}" href="#/path/${path.id}">Last step. Back to ${esc(path.title)}</a>`;
  return `<a class="${cls}" href="${hrefOf(next, path)}"><span class="next-kind">Next ${next.kind}</span>${esc(itemOf(next).title)} ${ICON.arrow}</a>`;
}

// ---------------------------------------------------------------- home

function renderHome() {
  const started = state.paths.some((p) => progressOf(p).done > 0);
  const current = state.byPath.get(state.store.path);
  const resume = current && progressOf(current).next ? current : state.paths.find((p) => progressOf(p).done > 0 && progressOf(p).next);
  const demo = state.byDrill.get("sum-after-dedupe");
  const perTrack = Object.entries(TRACKS)
    .map(([track, name]) => `${state.drills.filter((d) => d.track === track).length} ${name}`)
    .join(", ");
  const advanced = state.concepts.filter((c) => c.level === "advanced").length;

  const primary = resume
    ? `<a class="button primary" href="${hrefOf(progressOf(resume).next, resume)}"><span class="next-kind">Continue ${esc(resume.title)}</span>${esc(itemOf(progressOf(resume).next).title)} ${ICON.arrow}</a>`
    : `<a class="button primary" href="#/path/${state.paths[0].id}"><span class="next-kind">Start here</span>${esc(state.paths[0].title)} ${ICON.arrow}</a>`;

  const cards = state.paths
    .map((path, i) => {
      const p = progressOf(path);
      const concepts = p.steps.filter((s) => s.kind === "concept").length;
      const label = p.done === 0 ? "Not started" : p.done === p.total ? "Complete" : `${p.done} of ${p.total} done`;
      const tag = !started && i === 0 ? '<span class="chip">Start here</span>' : path === resume ? '<span class="chip">In progress</span>' : "";
      return `<a class="card path-card" href="#/path/${path.id}">
        <span class="round">${esc(path.round)}${tag}</span>
        <h3>${esc(path.title)}</h3>
        <p>${esc(path.summary)}</p>
        <span class="path-meta">${plural(concepts, "concept")} · ${plural(p.total - concepts, "drill")}</span>
        <span class="path-foot">${meter(p.done, p.total)}<span>${label}</span></span>
      </a>`;
    })
    .join("");

  main.innerHTML = `
    <section class="hero">
      <div>
        <p class="eyebrow">Interview prep for data engineers</p>
        <h1>Practise on data where the obvious answer <em>fails</em>.</h1>
        <p class="lede">${state.paths.length} paths, one for each round of a data engineering interview. ${state.concepts.length} concept pages with examples that are run, and ${state.drills.length} drills in SQL, Python, Spark and Airflow where the obvious answer is wrong. SQL and Python answers run in your browser against a reference; Spark and Airflow answers are checked against what the real engine was recorded doing.</p>
        <div class="hero-actions">
          ${primary}
          <a class="button" href="#/path/short-list">Short on time? The short list</a>
        </div>
        <p class="hero-keys"><kbd>⌘</kbd><kbd>K</kbd> or <kbd>/</kbd> searches every drill and concept.</p>
      </div>
      <div class="card demo" aria-label="Example of a failed check">
        <div class="demo-head"><span class="chip">${esc(demo.family)}</span>${esc(demo.title)}</div>
        <pre class="code">${highlight(demo.naive.trim(), "sql")}</pre>
        <p class="verdict fail"><b>FAIL</b><span>Right number of rows (3), but 2 of them differ from the reference.</span></p>
        ${dataTable(["customer_id", "expected", "yours"], [["10", "140", "240"], ["12", "65", "225"]])}
      </div>
    </section>

    <h2 class="section-title">Pick the round you are preparing for</h2>
    <p class="section-sub">Each path alternates a concept with the drills that test it. Nothing is locked: skip what you know.</p>
    <div class="path-grid">${cards}</div>

    <h2 class="section-title">How a path works</h2>
    <div class="steps">
      <section class="card step"><span class="n">01</span><h3>Read the idea</h3><p>A concept page explains one idea, shows it on a small dataset with the real output, and lists how interviewers ask about it.</p></section>
      <section class="card step"><span class="n">02</span><h3>Fail the drill, then fix it</h3><p>Write the query or the function. Your answer and a reference answer both run, and you get the rows that differ.</p></section>
      <section class="card step"><span class="n">03</span><h3>Say it out loud</h3><p>Each drill ends with the trap in words and the answer to "now make it fast on a very large table", with measurements.</p></section>
    </div>

    <div class="tools">
      <a class="card tool" href="#/mock"><span class="tool-icon">${ICON.clock}</span><h3>Mock round</h3><p>Two or three drills against a clock, with hints and explanations hidden until you finish.</p></a>
      <a class="card tool" href="#/concepts"><span class="tool-icon">${ICON.book}</span><h3>Concept library</h3><p>${state.concepts.length} pages, ${advanced} of them advanced: pruning, skew, idempotency, late data, change data capture.</p></a>
      <a class="card tool" href="#/drills"><span class="tool-icon">${ICON.code}</span><h3>All drills</h3><p>${perTrack}. Filter by track and by what you have solved.</p></a>
    </div>

    <section class="card local">
      <h2 class="section-title">Run it on your machine, or with a coach</h2>
      <p>The same drills, concepts and paths are in the repository and run from the command line against DuckDB and your own Python. A <code>CLAUDE.md</code> file turns a coding agent into a mock interviewer: it asks one drill at a time, runs your answer and asks the scale follow-up.</p>
      <pre class="code">git clone https://github.com/linusdominic/de-trap-drills
cd de-trap-drills &amp;&amp; uv sync
uv run drills paths
uv run drills start dedupe-latest
uv run drills check dedupe-latest</pre>
      <p class="fineprint">Nothing you type here leaves your browser: answers run in DuckDB-Wasm ${DUCKDB_WASM} and Pyodide ${PYODIDE}, and progress is kept in this browser's local storage.</p>
    </section>`;
}

// ---------------------------------------------------------------- a path

function renderPath(path) {
  state.store.path = path.id;
  saveStore();
  const p = progressOf(path);
  const stages = path.stages
    .map((stage, i) => {
      const done = stage.steps.filter(isDone).length;
      return `<li class="stage">
        <div class="stage-head"><span class="stage-n">${i + 1}</span><div><h2>${esc(stage.title)}</h2><p>${esc(stage.note)}</p></div><span class="stage-count">${done} / ${stage.steps.length}</span></div>
        <ol class="step-list">${stage.steps.map((s) => stepRow(s, path, s === p.next)).join("")}</ol>
      </li>`;
    })
    .join("");
  const action = p.next
    ? `<a class="button primary" href="${hrefOf(p.next, path)}"><span class="next-kind">${p.done ? "Continue" : "Start"}</span>${esc(itemOf(p.next).title)} ${ICON.arrow}</a>`
    : '<span class="chip pass">Path complete</span>';
  main.innerHTML = `
    <div class="page">
      <a class="back" href="#/">${ICON.back} All paths</a>
      <header class="page-head">
        <p class="eyebrow">${esc(path.round)}</p>
        <h1>${esc(path.title)}</h1>
        <p class="lede">${esc(path.summary)}</p>
        <p class="outcome"><b>After this path</b>${esc(path.outcome)}</p>
        <div class="path-progress">${meter(p.done, p.total)}<span>${p.done} of ${p.total} steps done</span>${action}</div>
      </header>
      <ol class="stages">${stages}</ol>
    </div>`;
}

// ---------------------------------------------------------------- measurements

function formatSeconds(seconds) {
  return seconds >= 1 ? `${seconds.toFixed(2)} s` : `${(seconds * 1000).toFixed(seconds < 0.01 ? 1 : 0)} ms`;
}

function measured(experimentId, compact) {
  const scale = state.data.scale;
  const experiment = scale && scale.experiments.find((e) => e.id === experimentId);
  if (!experiment) return "";
  const slowest = Math.max(...experiment.variants.map((v) => v.median_seconds));
  const fastest = Math.min(...experiment.variants.map((v) => v.median_seconds));
  const first = experiment.variants[0].median_seconds;
  const rows = experiment.variants
    .map((v) => {
      const ratio = first / v.median_seconds;
      const label = v === experiment.variants[0] ? "baseline" : ratio >= 1 ? `${ratio.toFixed(ratio >= 10 ? 0 : 1)}x faster` : `${(1 / ratio).toFixed(1)}x slower`;
      const best = v.median_seconds === fastest ? " best" : "";
      const scope = v.comparable ? "" : " <small>(narrower question)</small>";
      return `<div class="measure-row${best}"><span>${esc(v.name)}${scope}</span><span class="bar"><i style="width:${Math.max((v.median_seconds / slowest) * 100, 1).toFixed(1)}%"></i></span><span class="secs">${formatSeconds(v.median_seconds)}</span><span class="ratio">${label}</span></div>`;
    })
    .join("");
  const note = `Median of ${scale.runs} runs on ${scale.rows.toLocaleString("en-US")} rows, DuckDB ${esc(scale.duckdb)}, ${esc(scale.machine.cpu)}, ${scale.date}.`;
  if (compact) {
    return `<div class="measured"><h3>Measured: ${esc(experiment.title.toLowerCase())}</h3><p class="q">${esc(experiment.question)}</p><div class="measure">${rows}</div><p class="measure-note">${note} <a href="#/scale">All experiments</a></p></div>`;
  }
  const sql = experiment.variants.map((v) => `-- ${v.name}\n${v.sql}\n-- plan: ${v.operators.join(" > ")}`).join("\n\n");
  const concept = state.concepts.find((c) => c.experiment === experiment.id);
  const link = concept ? `<p class="measure-note">Concept: <a href="#/c/${concept.id}">${esc(concept.title)}</a></p>` : "";
  return `<section class="card experiment"><h2>${esc(experiment.title)}</h2><p class="q">${esc(experiment.question)}</p><div class="measure">${rows}</div>${link}<details><summary>The queries and their plans</summary><pre class="code">${highlight(sql, "sql")}</pre></details></section>`;
}

function renderScale() {
  const scale = state.data.scale;
  if (!scale) {
    main.innerHTML = '<div class="page"><h1>The scale follow-up</h1><p class="lede">No benchmark results are bundled with this build. Run <code>make scale</code>.</p></div>';
    return;
  }
  const setup = scale.setup;
  main.innerHTML = `
    <div class="page wide">
      <header class="page-head">
        <p class="eyebrow">Measured, not recited</p>
        <h1>"Now make it fast on a big table"</h1>
        <p class="lede">Every interview answer about scale is a claim that can be tested. These are the standard claims, timed on one machine: ${scale.rows.toLocaleString("en-US")} rows of synthetic events in date-partitioned Parquet, queried with DuckDB. Within each group the queries return the same answer, unless one is marked as a narrower question; only the route differs.</p>
        <p><a class="button" href="#/path/make-it-fast">Open the path: Make it fast ${ICON.arrow}</a></p>
      </header>
      <div class="facts">
        <div class="card fact"><b>${(scale.rows / 1e6).toFixed(0)}M</b><span>rows over ${scale.days} daily partitions</span></div>
        <div class="card fact"><b>${(setup.partitioned_mb / 1024).toFixed(1)} GB</b><span>of Parquet on local disk</span></div>
        <div class="card fact"><b>${scale.runs} runs</b><span>per query; the median is shown</span></div>
        <div class="card fact"><b>${esc(scale.machine.cpu)}</b><span>${scale.machine.cores} cores, ${scale.machine.memory_gb} GB, DuckDB ${esc(scale.duckdb)}</span></div>
      </div>
      ${scale.experiments.map((e) => measured(e.id, false)).join("")}
      <p class="fineprint">One machine, one engine, a warm file cache and uniform synthetic data: read the ratios as a demonstration of the mechanism, not as a forecast for a cluster. Writing the sorted copy took ${setup.write_sorted_copy_seconds} s and building the daily summary took ${setup.build_daily_summary_seconds} s; those costs are paid on every load, not on every query. Reproduce with <code>make scale</code>; results are in <code>results/scale.json</code>.</p>
    </div>`;
}

// ---------------------------------------------------------------- a concept

function exampleHtml(example, index) {
  const isSql = example.kind === "sql";
  const data = isSql && example.tables.length
    ? `<details class="ex-data" open><summary>The data <small>${plural(example.tables.length, "table")}</small></summary><div class="ex-tables">${example.tables.map(tableCard).join("")}</div></details>`
    : "";
  const output = isSql
    ? `<p class="out-label">Result <small>${plural(example.result.rows.length, "row")}, as run when this site was built</small></p><div class="table-wrap">${dataTable(example.result.columns, example.result.rows)}</div>`
    : `<p class="out-label">Output <small>as printed when this site was built</small></p><pre class="code plain">${esc(example.output.replace(/\n+$/, ""))}</pre>`;
  return `<section class="card example" data-example="${index}">
    <header class="ex-head"><span class="ex-n">Example ${index + 1}</span><h3>${esc(example.title)}</h3></header>
    ${data}
    <div class="ex-code">${codeBlock(example.code, example.kind)}</div>
    <div class="ex-out" aria-live="polite">${output}</div>
    ${example.note ? `<p class="ex-note">${inline(example.note)}</p>` : ""}
    ${isSql ? '<div class="ex-actions"><button class="button small" type="button" data-edit>Edit and run</button><span class="engine"></span></div>' : ""}
  </section>`;
}

function wireExample(section, example) {
  const button = $("[data-edit]", section);
  if (!button) return;
  button.addEventListener("click", () => {
    const actions = $(".ex-actions", section);
    const out = $(".ex-out", section);
    const note = $(".ex-note", section);
    const original = out.innerHTML;
    actions.innerHTML = '<button class="button small primary" type="button" data-run>Run</button><button class="button small quiet" type="button" data-reset>Reset</button><span class="keys"><kbd>⌘</kbd><kbd>↵</kbd> runs</span><span class="engine"></span>';
    const status = $(".engine", actions);
    const run = async () => {
      $("[data-run]", actions).disabled = true;
      status.textContent = sqlLoaded() ? "Running ..." : `Loading DuckDB-Wasm ${DUCKDB_WASM} (about 5 MB the first time) ...`;
      try {
        const table = await runExample(example.setup, editor.value.trim().replace(/;\s*$/, ""));
        if (note) note.hidden = true; // the note describes the original result
        out.innerHTML = `<p class="out-label">Your result <small>${plural(table.rows.length, "row")}, run in your browser</small></p><div class="table-wrap">${dataTable(table.columns, table.rows.slice(0, 100))}</div>`;
        status.textContent = `DuckDB ${(await sqlEngine()).version} in your browser.`;
      } catch (error) {
        out.innerHTML = `<p class="verdict fail"><b>ERROR</b><span>DuckDB could not run this as one SELECT statement.</span></p><pre class="error">${esc(error.message || error)}</pre>`;
        status.textContent = "";
      }
      $("[data-run]", actions).disabled = false;
    };
    const editor = createEditor($(".ex-code", section), { value: example.code.replace(/\n+$/, ""), language: "sql", label: `Example: ${example.title}`, minLines: 4, onSubmit: run, onRun: run });
    $("[data-run]", actions).addEventListener("click", run);
    $("[data-reset]", actions).addEventListener("click", () => {
      editor.value = example.code.replace(/\n+$/, "");
      out.innerHTML = original;
      if (note) note.hidden = false;
      status.textContent = "";
    });
    editor.focus();
  });
}

function drillLinks(ids, path) {
  return `<ol class="step-list">${ids.map((id) => stepRow({ kind: "drill", id }, path && flat(path).some((s) => s.kind === "drill" && s.id === id) ? path : null, false)).join("")}</ol>`;
}

function renderConcept(concept, path) {
  const read = Boolean(state.store.read[concept.id]);
  const drills = concept.drills.length
    ? `<section class="block"><h2>Practise it</h2><p class="hintline">${concept.drills.length === 1 ? "This drill plants" : "These drills plant"} the trap this page describes.</p>${drillLinks(concept.drills, path)}</section>`
    : "";
  const built = state.data.built;
  main.innerHTML = `
    ${path ? stepBar(path, "concept", concept.id) : ""}
    <article class="page concept">
      ${path ? "" : `<a class="back" href="#/concepts">${ICON.back} All concepts</a>`}
      <header class="page-head">
        <p class="eyebrow"><span>${esc(concept.area)}</span><span class="chip${concept.level === "advanced" ? "" : " quiet"}">${concept.level === "advanced" ? "Advanced" : "Core"}</span>${read ? '<span class="chip pass">Read</span>' : ""}</p>
        <h1>${esc(concept.title)}</h1>
        <p class="lede">${inline(concept.summary)}</p>
      </header>
      <section class="block prose">${md(concept.idea)}</section>
      ${concept.examples.length ? `<section class="block"><h2>See it run</h2>${concept.examples.map(exampleHtml).join("")}</section>` : ""}
      ${concept.experiment ? `<section class="block card measured-card">${measured(concept.experiment, true)}</section>` : ""}
      <section class="block interview">
        <h2>In the interview</h2>
        <div class="iv-grid">
          <div class="card iv"><h3>How it is asked</h3><ul class="asked">${concept.asked.map((q) => `<li>${inline(q)}</li>`).join("")}</ul></div>
          <div class="card iv"><h3>What a strong answer covers</h3><ul class="checks">${concept.answer.map((a) => `<li>${ICON.check}<span>${inline(a)}</span></li>`).join("")}</ul></div>
        </div>
        <h3 class="probe-title">Follow-up questions</h3>
        <p class="hintline">Answer each one out loud first, then open it.</p>
        ${concept.probes.map((p) => `<details class="reveal"><summary>${inline(p.q)}</summary><div class="body"><p>${inline(p.a)}</p></div></details>`).join("")}
      </section>
      ${drills}
      <p class="fineprint provenance">${concept.examples.length ? `The examples on this page were run when the site was built (DuckDB ${esc(built.duckdb)}, Python ${esc(built.python)}), and what they returned is shown as it came out. ` : ""}The prose is not tested. Check anything engine-specific against that engine's documentation before you rely on it.</p>
      <footer class="concept-foot">
        <button class="button${read ? "" : " primary"}" id="mark" type="button">${read ? "Mark as unread" : path ? "Mark as read and continue" : "Mark as read"}</button>
        ${read ? nextLink(path, "concept", concept.id) : ""}
      </footer>
    </article>`;

  $$(".example", main).forEach((section) => wireExample(section, concept.examples[Number(section.dataset.example)]));
  $("#mark").addEventListener("click", () => {
    if (read) delete state.store.read[concept.id];
    else state.store.read[concept.id] = true;
    saveStore();
    if (read || !path) {
      route(false);
      return;
    }
    const steps = flat(path);
    const next = steps[steps.findIndex((s) => s.kind === "concept" && s.id === concept.id) + 1];
    location.hash = next ? hrefOf(next, path) : `#/path/${path.id}`;
  });
}

// ---------------------------------------------------------------- libraries

function chips(name, options, selected) {
  return `<div class="filter" role="group" aria-label="${name}">${options
    .map(([value, label]) => `<button type="button" class="filter-chip" data-filter="${name}" data-value="${value}" aria-pressed="${value === selected}">${label}</button>`)
    .join("")}</div>`;
}

function wireFilters(render) {
  $$("[data-filter]", main).forEach((button) =>
    button.addEventListener("click", () => {
      state.filters[button.dataset.filter] = button.dataset.value;
      render();
    })
  );
}

function renderConcepts() {
  const level = state.filters.level;
  const shown = state.concepts.filter((c) => level === "all" || c.level === level);
  const areas = [...new Set(state.concepts.map((c) => c.area))];
  const groups = areas
    .map((area) => {
      const items = shown.filter((c) => c.area === area);
      if (!items.length) return "";
      const cards = items
        .map(
          (c) => `<a class="card concept-card" href="#/c/${c.id}">
            <span class="step-top"><span class="chip${c.level === "advanced" ? "" : " quiet"}">${c.level === "advanced" ? "Advanced" : "Core"}</span>${state.store.read[c.id] ? `<span class="chip pass">${ICON.check}Read</span>` : ""}</span>
            <h3>${esc(c.title)}</h3><p>${inline(c.summary)}</p>
            <span class="path-meta">${c.examples.length ? plural(c.examples.length, "example") : "No example"} · ${plural(c.drills.length, "drill")}${c.experiment ? " · measured" : ""}</span>
          </a>`
        )
        .join("");
      return `<h2 class="section-title">${esc(area)}</h2><div class="concept-grid">${cards}</div>`;
    })
    .join("");
  const read = state.concepts.filter((c) => state.store.read[c.id]).length;
  main.innerHTML = `
    <div class="page wide">
      <header class="page-head">
        <p class="eyebrow">Concept library</p>
        <h1>${state.concepts.length} ideas an interviewer expects you to explain</h1>
        <p class="lede">Each page has the idea, an example with its real output, the ways the topic is asked, what a strong answer covers, and follow-up questions to answer out loud. ${read} of ${state.concepts.length} read.</p>
        ${chips("level", [["all", "All"], ["core", "Core"], ["advanced", "Advanced"]], level)}
      </header>
      ${groups}
    </div>`;
  wireFilters(renderConcepts);
}

function renderDrills() {
  const { track, status } = state.filters;
  const shown = state.drills.filter(
    (d) => (track === "all" || d.track === track) && (status === "all" || (status === "solved") === Boolean(state.store.solved[d.id]))
  );
  const rows = shown
    .map((d) => {
      const solved = Boolean(state.store.solved[d.id]);
      const concepts = (state.conceptsOf.get(d.id) || []).map((c) => esc(c.title)).join(", ");
      return `<li><a class="step-row${solved ? " done" : ""}" href="#/d/${d.id}">
        <span class="status" aria-hidden="true">${solved ? ICON.check : ""}</span>
        <span class="step-main"><span class="step-top"><span class="kind drill">${ICON.code}${TRACKS[d.track]}</span><span class="chip">${esc(d.family)}</span></span>
          <span class="step-title">${esc(d.title)}</span><span class="step-sub">${esc(d.pattern)}${concepts ? ` · concept: ${concepts}` : ""}</span></span>
        <span class="go" aria-hidden="true">${ICON.arrow}</span><span class="sr">${solved ? "Solved" : "Not solved"}</span></a></li>`;
    })
    .join("");
  const solved = state.drills.filter((d) => state.store.solved[d.id]).length;
  main.innerHTML = `
    <div class="page">
      <header class="page-head">
        <p class="eyebrow">All drills</p>
        <h1>${state.drills.length} drills where the obvious answer is wrong</h1>
        <p class="lede">${solved} of ${state.drills.length} solved. A SQL or Python drill ships with an obvious answer that the test suite proves wrong and a reference answer that it proves right. A Spark or Airflow drill takes its answer from a recorded run of the real engine.</p>
        <div class="filters">
          ${chips("track", [["all", "All"], ...Object.entries(TRACKS)], track)}
          ${chips("status", [["all", "Any status"], ["todo", "To do"], ["solved", "Solved"]], status)}
        </div>
      </header>
      ${rows ? `<ol class="step-list">${rows}</ol>` : '<p class="empty">No drills match these filters.</p>'}
    </div>`;
  wireFilters(renderDrills);
}

// ---------------------------------------------------------------- the drill workspace

function verdictHtml(verdict, drill, headlineOnly) {
  let html = `<p class="verdict ${verdict.passed ? "pass" : "fail"}"><b>${verdict.passed ? "PASS" : "FAIL"}</b><span>${esc(verdict.headline)}</span></p>`;
  if (verdict.error) html += `<pre class="error">${esc(verdict.error)}</pre>`;
  if (headlineOnly) {
    if (!verdict.passed && !verdict.error) {
      html += `<p class="fineprint">In a mock round a failed check does not show ${drill.track === "sql" ? "the differing rows. Use Run to look at your own output" : "which cases fail or why. Test your function against the cases by reading them"}.</p>`;
    }
    return html;
  }
  if (verdict.missing && verdict.missing.length) {
    html += `<p class="diff-label minus">Missing from your result <small>${plural(verdict.missing.length, "row")} the reference returns and yours does not</small></p><div class="table-wrap minus">${dataTable(drill.columns, verdict.missing.slice(0, SHOWN))}</div>`;
  }
  if (verdict.unexpected && verdict.unexpected.length) {
    html += `<p class="diff-label plus">Not expected <small>${plural(verdict.unexpected.length, "row")} yours returns and the reference does not</small></p><div class="table-wrap plus">${dataTable(drill.columns, verdict.unexpected.slice(0, SHOWN))}</div>`;
  }
  if (verdict.cases) {
    html += verdict.cases
      .map((c) =>
        c.ok
          ? `<div class="case-result"><span class="state ok">OK</span>${esc(c.name)}</div>`
          : `<div class="case-result bad"><span class="state bad">FAIL</span>${esc(c.name)}<dl><dt>input</dt><dd>${esc(c.args)}</dd><dt>expected</dt><dd>${esc(c.expected)}</dd><dt>yours</dt><dd>${esc(c.yours)}</dd></dl></div>`
      )
      .join("");
  }
  if (!verdict.passed && !verdict.error) html += '<p class="fineprint">Work out what the difference means before you open a hint below.</p>';
  return html;
}

function helpHtml(drill, level) {
  const concepts = state.conceptsOf.get(drill.id) || [];
  const cards = [
    `<div class="help-card"><h3>A nudge</h3><p><strong>Trap family: ${esc(drill.family)}.</strong> ${esc(FAMILY_NOTES[drill.family])}</p>${
      concepts.length ? `<p>The idea behind it: ${concepts.map((c) => `<a href="#/c/${c.id}">${esc(c.title)}</a>`).join(", ")}.</p>` : ""
    }</div>`,
    `<div class="help-card"><h3>The trap</h3>${md(drill.trap)}</div>`,
    drill.kind === "predict"
      ? `<div class="help-card"><h3>The answer</h3><p>${inline(drill.options.find((o) => o.value === drill.reference).text)}</p>${evidenceHtml(drill)}</div>`
      : `<div class="help-card"><h3>Reference answer</h3>${codeBlock(drill.reference, drill.track)}</div>`,
  ];
  const labels = ["A nudge", "The trap", drill.kind === "predict" ? "The answer" : "Reference answer"];
  const buttons = labels
    .map((label, i) => `<button type="button" class="help-step${i < level ? " open" : ""}" data-level="${i + 1}"${i > level ? " disabled" : ""}><span>${i + 1}</span>${label}</button>`)
    .join("");
  return `<div class="help"><div class="help-head"><b>Stuck?</b><span>Three hints, weakest first. Open only what you need.</span></div><div class="help-steps">${buttons}</div>${cards.slice(0, level).join("")}</div>`;
}

function debriefHtml(drill, path, justPassed) {
  return `<section class="debrief">
    <h2>${justPassed ? "Debrief: say this in the interview" : "Debrief"}</h2>
    <details class="reveal"${justPassed ? " open" : ""}><summary>The trap you avoided</summary><div class="body">${md(drill.trap)}</div></details>
    ${drill.scale ? `<details class="reveal"${justPassed ? " open" : ""}><summary>${drill.kind === "predict" ? "In production" : "The scale follow-up"}</summary><div class="body">${md(drill.scale)}${drill.experiment ? measured(drill.experiment, true) : ""}</div></details>` : ""}
    ${
      drill.kind === "predict"
        ? `<details class="reveal"${justPassed ? "" : " open"}><summary>What the engine printed</summary><div class="body">${evidenceHtml(drill)}</div></details>`
        : `<details class="reveal"><summary>Compare with the reference answer</summary><div class="body">${codeBlock(drill.reference, drill.track)}</div></details>`
    }
    <div class="next-step">${nextLink(path, "drill", drill.id)}</div>
  </section>`;
}

// ---------------------------------------------------------------- predict drills (Spark, Airflow)
// No engine runs in the browser for these. The answer key is what the real engine was
// recorded doing when tools/spark_evidence.py or tools/airflow_evidence.py ran the code.

function checkPredict(drill, value) {
  const option = drill.options.find((o) => o.value === value) || null;
  if (!option) return { passed: false, headline: "Choose one of the options first.", option };
  const passed = option.value === drill.reference;
  return { passed, headline: `That is ${passed ? "" : "not "}what ${drill.evidence.engine} did.`, option };
}

function evidenceHtml(drill) {
  const e = drill.evidence;
  return `<div class="evidence"><p class="out-label">What ${esc(e.engine)} ${esc(e.version)} printed <small>recorded on ${esc(e.date)}</small></p><pre class="code plain">${esc(e.output)}</pre><p class="measure-note">${esc(e.setup)}. The answer key is this run, not a hand-written one; <code>make engines</code> repeats it.</p></div>`;
}

function renderPredict(drill, context) {
  const mock = context.mock || null;
  const path = context.path || null;
  const draftKey = mock ? `mock:${drill.id}` : drill.id;
  const picked = state.store.drafts[draftKey];
  const solved = Boolean(state.store.solved[drill.id]);
  const concepts = state.conceptsOf.get(drill.id) || [];
  const used = mock && mock.results[drill.id] && mock.results[drill.id].attempts > 0;
  const options = drill.options
    .map(
      (o, i) => `<label class="option"><input type="radio" name="prediction" value="${esc(o.value)}"${o.value === picked ? " checked" : ""}${used ? " disabled" : ""}>
        <span class="letter">${"ABCDEFGH"[i]}</span><span class="option-text">${inline(o.text)}</span></label>`
    )
    .join("");
  main.innerHTML = `
    ${mock ? mockBar(mock, context.index) : path ? stepBar(path, "drill", drill.id) : ""}
    <article class="drill predict">
      ${mock || path ? "" : `<a class="back" href="#/drills">${ICON.back} All drills</a>`}
      <header class="drill-head">
        <p class="eyebrow"><span>${TRACKS[drill.track]}</span><span class="sep" aria-hidden="true">/</span><span>${esc(drill.pattern)}</span>${mock ? "" : `<span class="chip">${esc(drill.family)}</span>`}${solved && !mock ? `<span class="chip pass">${ICON.check}Solved</span>` : ""}</p>
        <h1>${esc(drill.title)}</h1>
        ${concepts.length && !mock ? `<p class="drill-concepts">${ICON.book}<span>Concept: ${concepts.map((c) => `<a href="#/c/${c.id}${path && flat(path).some((s) => s.kind === "concept" && s.id === c.id) ? `/in/${path.id}` : ""}">${esc(c.title)}</a>`).join(", ")}</span></p>` : ""}
      </header>
      <div class="cols">
        <section class="brief" aria-label="The situation and the code">
          <h2>The situation</h2>
          ${md(drill.prompt)}
          <h2>The code</h2>
          ${codeBlock(drill.code, "python")}
          <p class="expect">Run on ${esc(drill.evidence.setup)}.</p>
        </section>
        <section class="bench" aria-label="Your prediction">
          <div class="card question">
            <p class="q-label">Predict</p>
            <h2 class="q-text" id="question">${inline(drill.question)}</h2>
            <div class="options" role="radiogroup" aria-labelledby="question">${options}</div>
          </div>
          <div class="actions">
            <button class="button primary" id="check" type="button"${used ? " disabled" : ""}>Check</button>
            <span class="engine">${mock ? "One attempt in a mock round." : `Checked against a recorded run of ${esc(drill.evidence.engine)} ${esc(drill.evidence.version)}.`}</span>
          </div>
          <div id="result" aria-live="polite"></div>
          <div id="after"></div>
        </section>
      </div>
    </article>`;

  const result = $("#result");
  const after = $("#after");
  const radios = $$('input[name="prediction"]', main);

  function drawAfter(justPassed) {
    if (mock) {
      const last = context.index === mock.ids.length - 1;
      after.innerHTML = mock.results[drill.id]
        ? `<div class="next-step">${last ? '<button class="button primary" type="button" data-finish>Finish the round</button>' : `<a class="button primary" href="#/mock/run/${context.index + 2}">Next question ${ICON.arrow}</a>`}</div>`
        : "";
      const finish = $("[data-finish]", after);
      if (finish) finish.addEventListener("click", () => finishMock(false));
      return;
    }
    if (state.store.solved[drill.id]) {
      after.innerHTML = debriefHtml(drill, path, justPassed);
      return;
    }
    const level = state.store.help[drill.id] || 0;
    after.innerHTML = helpHtml(drill, level);
    $$(".help-step", after).forEach((button) =>
      button.addEventListener("click", () => {
        state.store.help[drill.id] = Math.max(level, Number(button.dataset.level));
        saveStore();
        drawAfter(false);
      })
    );
  }

  radios.forEach((radio) =>
    radio.addEventListener("change", () => {
      state.store.drafts[draftKey] = radio.value;
      saveStore();
    })
  );

  $("#check").addEventListener("click", () => {
    const chosen = radios.find((radio) => radio.checked);
    const verdict = checkPredict(drill, chosen ? chosen.value : null);
    let html = `<p class="verdict ${verdict.passed ? "pass" : "fail"}"><b>${verdict.passed ? "PASS" : "FAIL"}</b><span>${esc(verdict.headline)}</span></p>`;
    if (!verdict.option) {
      result.innerHTML = html;
      return;
    }
    $$(".option", main).forEach((label) => label.classList.remove("right", "wrong"));
    chosen.closest(".option").classList.add(verdict.passed ? "right" : "wrong");
    if (mock) {
      mock.results[drill.id] = { attempts: 1, passed: verdict.passed };
      radios.forEach((radio) => (radio.disabled = true));
      $("#check").disabled = true;
      html += '<p class="fineprint">Recorded. The explanation and the evidence are in the debrief when you finish the round.</p>';
    } else {
      html += `<p class="why">${inline(verdict.option.why)}</p>`;
      if (verdict.passed) html += evidenceHtml(drill);
      else html += '<p class="fineprint">Read the code again and choose another option, or open a hint below.</p>';
    }
    result.innerHTML = html;
    if (verdict.passed) state.store.solved[drill.id] = true;
    saveStore();
    updateProgress();
    if (verdict.passed || mock) drawAfter(verdict.passed);
    if (verdict.passed && !mock) $$(".stepbar .dot.now", main).forEach((dot) => dot.classList.add("done"));
  });
  drawAfter(false);
}

// ---------------------------------------------------------------- code drills (SQL, Python)

// context: { path } for a normal visit, or { mock, index } inside a mock round.
function renderDrill(drill, context) {
  if (drill.kind === "predict") {
    renderPredict(drill, context);
    return;
  }
  const mock = context.mock || null;
  const path = context.path || null;
  const isSql = drill.track === "sql";
  const draftKey = mock ? `mock:${drill.id}` : drill.id;
  // A new line after the starter, so typing at the end does not continue its comment.
  const starter = drill.starter.endsWith("\n") ? drill.starter : `${drill.starter}\n`;
  const draft = state.store.drafts[draftKey] ?? starter;
  const solved = Boolean(state.store.solved[drill.id]);
  const concepts = state.conceptsOf.get(drill.id) || [];
  const brief = isSql
    ? `<h2>Return</h2>
       <p class="expect">Columns, in this order: ${drill.columns.map((c) => `<code>${esc(c)}</code>`).join(" ")}. ${drill.ordered ? "Row order matters." : "Row order does not matter."} Column names are not checked.</p>
       <h2>The data</h2>
       ${drill.tables.map(tableCard).join("")}`
    : `<h2>Define</h2>
       <p class="expect">A function called <code>${esc(drill.function)}</code>. It is called once per case and its result is compared with the reference answer's.</p>
       <h2>The cases</h2>
       <ul class="cases">${drill.cases
         .map((c) => `<li><span class="case-name">${esc(c.name)}</span><pre>${esc(c.args)}${c.take ? `\n(the first ${c.take} items of the result are taken)` : ""}</pre></li>`)
         .join("")}</ul>`;
  main.innerHTML = `
    ${mock ? mockBar(mock, context.index) : path ? stepBar(path, "drill", drill.id) : ""}
    <article class="drill">
      ${mock || path ? "" : `<a class="back" href="#/drills">${ICON.back} All drills</a>`}
      <header class="drill-head">
        <p class="eyebrow"><span>${isSql ? "SQL" : "Python"}</span><span class="sep" aria-hidden="true">/</span><span>${esc(drill.pattern)}</span>${mock ? "" : `<span class="chip">${esc(drill.family)}</span>`}${solved && !mock ? `<span class="chip pass">${ICON.check}Solved</span>` : ""}</p>
        <h1>${esc(drill.title)}</h1>
        ${concepts.length && !mock ? `<p class="drill-concepts">${ICON.book}<span>Concept: ${concepts.map((c) => `<a href="#/c/${c.id}${path && flat(path).some((s) => s.kind === "concept" && s.id === c.id) ? `/in/${path.id}` : ""}">${esc(c.title)}</a>`).join(", ")}</span></p>` : ""}
      </header>
      <div class="cols">
        <section class="brief" aria-label="Brief">
          <h2>The brief</h2>
          ${md(drill.prompt)}
          ${brief}
        </section>
        <section class="bench" aria-label="Your answer">
          <div class="ed-frame">
            <div class="ed-bar"><span class="ed-name">answer.${isSql ? "sql" : "py"}</span><span class="keys"><kbd>⌘</kbd><kbd>↵</kbd> check${isSql ? ' · <kbd>⌘</kbd><kbd>⇧</kbd><kbd>↵</kbd> run' : ""} · <kbd>⌘</kbd><kbd>/</kbd> comment</span></div>
            <div id="editor"></div>
          </div>
          <div class="actions">
            <button class="button primary" id="check" type="button">Check</button>
            ${isSql ? '<button class="button" id="run" type="button">Run</button>' : ""}
            <button class="button quiet" id="reset" type="button">Reset</button>
            <span class="engine" id="engine"></span>
          </div>
          <div id="result" aria-live="polite"></div>
          <div id="after"></div>
        </section>
      </div>
    </article>`;

  const result = $("#result");
  const engine = $("#engine");
  const after = $("#after");
  const buttons = [$("#check"), $("#run")].filter(Boolean);
  let saveTimer = null;

  function drawAfter(justPassed) {
    if (mock) {
      const passed = mock.results[drill.id] && mock.results[drill.id].passed;
      const last = context.index === mock.ids.length - 1;
      after.innerHTML = passed
        ? `<div class="next-step">${last ? '<button class="button primary" type="button" data-finish>Finish the round</button>' : `<a class="button primary" href="#/mock/run/${context.index + 2}">Next question ${ICON.arrow}</a>`}</div>`
        : "";
      const finish = $("[data-finish]", after);
      if (finish) finish.addEventListener("click", () => finishMock(false));
      return;
    }
    if (state.store.solved[drill.id]) {
      after.innerHTML = debriefHtml(drill, path, justPassed);
      return;
    }
    const level = state.store.help[drill.id] || 0;
    after.innerHTML = helpHtml(drill, level);
    $$(".help-step", after).forEach((button) =>
      button.addEventListener("click", () => {
        state.store.help[drill.id] = Math.max(level, Number(button.dataset.level));
        saveStore();
        drawAfter(false);
      })
    );
  }

  async function withEngine(work) {
    buttons.forEach((b) => (b.disabled = true));
    const loaded = isSql ? sqlLoaded() : pythonInfo();
    engine.textContent = loaded
      ? "Running ..."
      : isSql
        ? `Loading DuckDB-Wasm ${DUCKDB_WASM} (about 5 MB the first time, then cached) ...`
        : `Loading Pyodide ${PYODIDE} (about 6 MB the first time, then cached) ...`;
    try {
      await work();
      engine.textContent = isSql
        ? `Ran in your browser on DuckDB ${(await sqlEngine()).version}.`
        : `Ran in your browser on Python ${pythonInfo().python} (Pyodide ${pythonInfo().pyodide}).`;
    } catch (error) {
      engine.textContent = "";
      result.innerHTML = `<p class="verdict fail"><b>ERROR</b><span>The ${isSql ? "SQL" : "Python"} engine could not be loaded or stopped responding. Check your connection and try again.</span></p><pre class="error">${esc(error.message || error)}</pre>`;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  const doCheck = () =>
    withEngine(async () => {
      const verdict = await checkDrill(drill, editor.value);
      result.innerHTML = verdictHtml(verdict, drill, Boolean(mock));
      if (mock) {
        const entry = mock.results[drill.id] || { attempts: 0, passed: false };
        mock.results[drill.id] = { attempts: entry.attempts + 1, passed: entry.passed || verdict.passed };
      }
      if (verdict.passed) state.store.solved[drill.id] = true;
      saveStore();
      updateProgress();
      if (verdict.passed || mock) drawAfter(verdict.passed);
      if (verdict.passed && !mock) {
        $$(".stepbar .dot.now", main).forEach((dot) => dot.classList.add("done"));
      }
    });

  const doRun = () =>
    withEngine(async () => {
      if (isBlank(editor.value)) {
        result.innerHTML = '<p class="verdict fail"><b>EMPTY</b><span>Write a query first.</span></p>';
        return;
      }
      try {
        const table = await runSql(drill, editor.value, false);
        const shown = table.rows.slice(0, 100);
        const label = drill.checkQuery ? "The table after your statements" : "Your result";
        result.innerHTML = `<p class="diff-label">${label} <small>${plural(table.rows.length, "row")}${table.rows.length > shown.length ? `, first ${shown.length} shown` : ""}. Not checked yet.</small></p><div class="table-wrap">${dataTable(table.columns, shown)}</div>`;
      } catch (error) {
        result.innerHTML = `<p class="verdict fail"><b>ERROR</b><span>DuckDB could not run the query.</span></p><pre class="error">${esc(error.message || error)}</pre>`;
      }
    });

  const editor = createEditor($("#editor"), {
    value: draft,
    language: isSql ? "sql" : "python",
    label: `Your ${isSql ? "query" : "function"}`,
    minLines: 12,
    onInput: (value) => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        state.store.drafts[draftKey] = value;
        saveStore();
      }, 300);
    },
    onSubmit: doCheck,
    onRun: isSql ? doRun : doCheck,
  });
  cleanup.push(() => clearTimeout(saveTimer));

  $("#check").addEventListener("click", doCheck);
  if (isSql) $("#run").addEventListener("click", doRun);
  $("#reset").addEventListener("click", () => {
    editor.value = starter;
    delete state.store.drafts[draftKey];
    saveStore();
    result.innerHTML = "";
    editor.focus();
  });
  drawAfter(false);
}

// ---------------------------------------------------------------- mock round

function shuffled(items) {
  const list = [...items];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function startMock(kind) {
  const spec = MOCKS[kind];
  const pick = (track, n) => {
    const pool = state.drills.filter((d) => d.track === track);
    // Drills you have not solved come first, so a mock round is new material when it can be.
    const ordered = [...shuffled(pool.filter((d) => !state.store.solved[d.id])), ...shuffled(pool.filter((d) => state.store.solved[d.id]))];
    return ordered.slice(0, n).map((d) => d.id);
  };
  const ids = Object.entries(spec.pick).flatMap(([track, n]) => pick(track, n));
  for (const id of ids) delete state.store.drafts[`mock:${id}`];
  state.store.mock = { kind, ids, minutes: spec.minutes, startedAt: Date.now(), finishedAt: null, timedOut: false, results: {} };
  saveStore();
  location.hash = "#/mock/run/1";
}

function finishMock(timedOut) {
  const mock = state.store.mock;
  if (!mock || mock.finishedAt) return;
  mock.finishedAt = Date.now();
  mock.timedOut = timedOut;
  saveStore();
  if (location.hash === "#/mock/result") route();
  else location.hash = "#/mock/result";
}

const clock = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

function mockBar(mock, index) {
  const tabs = mock.ids
    .map((id, i) => {
      const passed = mock.results[id] && mock.results[id].passed;
      return `<a class="mock-tab${i === index ? " now" : ""}${passed ? " done" : ""}" href="#/mock/run/${i + 1}"${i === index ? ' aria-current="step"' : ""}>${passed ? ICON.check : ""}Question ${i + 1}</a>`;
    })
    .join("");
  return `<nav class="stepbar mockbar" aria-label="Mock round">
    <span class="stepbar-path">${ICON.clock}<span>Mock: ${esc(MOCKS[mock.kind].label)}</span></span>
    <span class="mock-tabs">${tabs}</span>
    <span class="timer" id="timer" role="timer" aria-label="Time left"></span>
    <span class="stepbar-nav"><button class="button small" type="button" id="finish">Finish</button></span>
  </nav>`;
}

function wireMockBar(mock) {
  const timer = $("#timer");
  const end = mock.startedAt + mock.minutes * 60000;
  const tick = () => {
    const left = end - Date.now();
    timer.textContent = `${clock(left)} left`;
    timer.classList.toggle("low", left < 5 * 60000);
    if (left <= 0) finishMock(true);
  };
  tick();
  const interval = setInterval(tick, 1000);
  cleanup.push(() => clearInterval(interval));
  $("#finish").addEventListener("click", () => finishMock(false));
}

function renderMockSetup() {
  const mock = state.store.mock;
  const running = mock && !mock.finishedAt;
  const options = Object.entries(MOCKS)
    .map(
      ([kind, spec]) => `<section class="card mock-option">
        <h3>${spec.label}</h3><p>${spec.text}</p>
        <p class="path-meta">${plural(mockSize(spec), "drill")} · ${spec.minutes} minutes</p>
        <button class="button primary" type="button" data-mock="${kind}">Start</button>
      </section>`
    )
    .join("");
  main.innerHTML = `
    <div class="page">
      <header class="page-head">
        <p class="eyebrow">Mock round</p>
        <h1>Practise against a clock</h1>
        <p class="lede">A mock round picks drills you have not solved yet, starts a timer, and hides the hints, the trap and the reference answer. You can run your code and check it as often as you like, but a failed check only says that it failed. The debrief comes at the end.</p>
        ${running ? `<p class="resume"><a class="button primary" href="#/mock/run/1">Resume the round in progress ${ICON.arrow}</a> <span class="fineprint">Starting a new one replaces it.</span></p>` : ""}
        ${mock && mock.finishedAt ? '<p class="resume"><a class="button" href="#/mock/result">See your last result</a></p>' : ""}
      </header>
      <div class="mock-grid">${options}</div>
      <p class="fineprint">The lengths are a practice format chosen for this site. Ask your recruiter how long the real rounds are and how many questions to expect.</p>
    </div>`;
  $$("[data-mock]", main).forEach((button) => button.addEventListener("click", () => startMock(button.dataset.mock)));
}

function renderMockResult() {
  const mock = state.store.mock;
  if (!mock) {
    location.hash = "#/mock";
    return;
  }
  if (!mock.finishedAt) {
    location.hash = "#/mock/run/1";
    return;
  }
  const passed = mock.ids.filter((id) => mock.results[id] && mock.results[id].passed).length;
  const rows = mock.ids
    .map((id) => {
      const drill = state.byDrill.get(id);
      const entry = mock.results[id] || { attempts: 0, passed: false };
      const concepts = (state.conceptsOf.get(id) || []).map((c) => `<a href="#/c/${c.id}">${esc(c.title)}</a>`).join(", ");
      return `<section class="card mock-row${entry.passed ? " done" : ""}">
        <span class="status" aria-hidden="true">${entry.passed ? ICON.check : ""}</span>
        <div><h3>${esc(drill.title)}</h3>
          <p class="path-meta">${entry.passed ? "Passed" : entry.attempts ? "Not passed" : "Not attempted"} · ${plural(entry.attempts, "check")} · trap family: ${esc(drill.family)}</p>
          <p>${entry.passed ? "Read the trap and the follow-up to see what you should have said" : "Open the drill: the hints, the trap and the answer are available now"}. ${concepts ? `Concept: ${concepts}.` : ""}</p></div>
        <a class="button small" href="#/d/${id}">Open the drill</a>
      </section>`;
    })
    .join("");
  main.innerHTML = `
    <div class="page">
      <header class="page-head">
        <p class="eyebrow">Mock: ${esc(MOCKS[mock.kind].label)}</p>
        <h1>${passed} of ${mock.ids.length} passed</h1>
        <p class="lede">${mock.timedOut ? `Time ran out at ${mock.minutes} minutes.` : `You finished in ${clock(mock.finishedAt - mock.startedAt)} of ${mock.minutes} minutes.`} A pass means your answer matched the reference answer, or the recorded run of the engine. The debrief below is the part an interviewer scores: can you say why the obvious answer fails?</p>
      </header>
      <div class="mock-rows">${rows}</div>
      <p class="resume"><a class="button primary" href="#/mock">Start another round</a> <a class="button" href="#/">Back to the paths</a></p>
    </div>`;
}

// ---------------------------------------------------------------- command palette

function paletteItems() {
  const pages = [
    ["Paths", "#/", "Page"],
    ["Concept library", "#/concepts", "Page"],
    ["All drills", "#/drills", "Page"],
    ["Scale measurements", "#/scale", "Page"],
    ["Mock round", "#/mock", "Page"],
  ].map(([title, href, kind]) => ({ title, href, kind, text: title.toLowerCase() }));
  return [
    ...pages,
    ...state.paths.map((p) => ({ title: p.title, href: `#/path/${p.id}`, kind: "Path", text: `${p.title} ${p.round} ${p.id}`.toLowerCase() })),
    ...state.concepts.map((c) => ({ title: c.title, href: `#/c/${c.id}`, kind: "Concept", text: `${c.title} ${c.area} ${c.id} ${c.summary}`.toLowerCase() })),
    ...state.drills.map((d) => ({ title: d.title, href: `#/d/${d.id}`, kind: `${TRACKS[d.track]} drill`, text: `${d.title} ${d.pattern} ${d.family} ${d.id}`.toLowerCase() })),
  ];
}

function wirePalette() {
  const dialog = $("#palette");
  const input = $("#palette-input");
  const list = $("#palette-list");
  let items = [];
  let shown = [];
  let active = 0;

  function draw() {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = items.filter((item) => words.every((w) => item.text.includes(w))).slice(0, 40);
    active = Math.min(active, Math.max(shown.length - 1, 0));
    list.innerHTML = shown.length
      ? shown.map((item, i) => `<li role="option" id="palette-${i}" aria-selected="${i === active}" data-i="${i}"><span>${esc(item.title)}</span><small>${esc(item.kind)}</small></li>`).join("")
      : '<li class="none">Nothing matches.</li>';
    input.setAttribute("aria-activedescendant", shown.length ? `palette-${active}` : "");
    const current = $('[aria-selected="true"]', list);
    if (current) current.scrollIntoView({ block: "nearest" });
  }

  function open() {
    if (dialog.open || !state.data) return;
    items = paletteItems();
    input.value = "";
    active = 0;
    dialog.showModal();
    draw();
  }

  function go(item) {
    dialog.close();
    if (item) location.hash = item.href;
  }

  input.addEventListener("input", () => {
    active = 0;
    draw();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      active = (active + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % Math.max(shown.length, 1);
      draw();
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(shown[active]);
    }
  });
  list.addEventListener("click", (event) => {
    const row = event.target.closest("[data-i]");
    if (row) go(shown[Number(row.dataset.i)]);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  $("#search").addEventListener("click", open);
  document.addEventListener("keydown", (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if ((event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey)) {
      event.preventDefault();
      open();
    }
  });
}

// ---------------------------------------------------------------- self-test
// tools/browser_check.py opens ?selftest=1 in headless Chrome. Every reference and
// naive answer and every SQL concept example runs here, and the outcome is posted back
// for comparison with the command line's result.

async function selftest() {
  $(".top").hidden = true;
  main.innerHTML = '<div class="selftest"><h1>Self-test</h1><pre id="log">running ...</pre></div>';
  const log = $("#log");
  const report = { userAgent: navigator.userAgent, duckdbWasm: DUCKDB_WASM, drills: {}, examples: {} };
  try {
    for (const drill of state.drills) {
      const entry = {};
      if (drill.kind === "predict") {
        entry.reference = drill.reference;
        entry.naive = drill.naive;
        entry.referencePasses = checkPredict(drill, drill.reference).passed;
        entry.naivePasses = checkPredict(drill, drill.naive).passed;
        report.drills[drill.id] = entry;
        log.textContent += `\n${entry.referencePasses && !entry.naivePasses ? "ok     " : "PROBLEM"} ${drill.id}`;
        continue;
      }
      if (drill.track === "sql") {
        entry.reference = await runSql(drill, drill.reference).then((t) => t.rows);
        entry.naive = await runSql(drill, drill.naive).then((t) => t.rows, (e) => ({ error: String(e.message || e) }));
      } else {
        entry.reference = await runPython(drill, drill.reference);
        entry.naive = await runPython(drill, drill.naive);
      }
      entry.referencePasses = (await checkDrill(drill, drill.reference)).passed;
      entry.naivePasses = (await checkDrill(drill, drill.naive)).passed;
      report.drills[drill.id] = entry;
      log.textContent += `\n${entry.referencePasses && !entry.naivePasses ? "ok     " : "PROBLEM"} ${drill.id}`;
    }
    for (const concept of state.concepts) {
      for (const [i, example] of concept.examples.entries()) {
        if (example.kind !== "sql") continue;
        const key = `${concept.id}:${i + 1}`;
        report.examples[key] = await runExample(example.setup, example.code).then((t) => t.rows, (e) => ({ error: String(e.message || e) }));
        log.textContent += `\n${Array.isArray(report.examples[key]) ? "ran    " : "PROBLEM"} example ${key}`;
      }
    }
    report.duckdb = (await sqlEngine()).version;
    report.pyodide = pythonInfo();
    log.textContent += `\n\nDuckDB ${report.duckdb}, Pyodide ${report.pyodide.pyodide}, Python ${report.pyodide.python}`;
  } catch (error) {
    report.error = String((error && error.message) || error);
    log.textContent += `\nERROR ${report.error}`;
  }
  try {
    await fetch("__selftest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) });
    log.textContent += "\nreported";
  } catch {
    log.textContent += "\n(no local test server to report to)";
  }
  document.body.dataset.selftest = "done";
}

// ---------------------------------------------------------------- routing

function updateProgress() {
  const solved = state.drills.filter((d) => state.store.solved[d.id]).length;
  $("#progress").innerHTML = `${meter(solved, state.drills.length)}<span>${solved} / ${state.drills.length} drills</span>`;
}

function setNav(name) {
  $$(".top-nav a[data-nav]").forEach((a) => {
    if (a.dataset.nav === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

function route(scroll = true) {
  cleanup.splice(0).forEach((fn) => fn());
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [head, id] = parts;
  const explicit = parts[2] === "in" ? parts[3] : null;
  let nav = "home";
  let title = "Trap Drills: interview prep for data engineers, on data where the obvious answer fails";

  if (head === "path" && state.byPath.has(id)) {
    renderPath(state.byPath.get(id));
    title = `${state.byPath.get(id).title} · Trap Drills`;
  } else if (head === "d" && state.byDrill.has(id)) {
    const drill = state.byDrill.get(id);
    const path = contextFor("drill", id, explicit);
    if (explicit && path && path.id === explicit) state.store.path = explicit;
    renderDrill(drill, { path });
    nav = path ? "home" : "drills";
    title = `${drill.title} · Trap Drills`;
  } else if (head === "c" && state.byConcept.has(id)) {
    const concept = state.byConcept.get(id);
    const path = explicit ? contextFor("concept", id, explicit) : null;
    if (path) state.store.path = path.id;
    renderConcept(concept, path);
    nav = path ? "home" : "concepts";
    title = `${concept.title} · Trap Drills`;
  } else if (head === "concepts") {
    renderConcepts();
    nav = "concepts";
    title = "Concepts · Trap Drills";
  } else if (head === "drills") {
    renderDrills();
    nav = "drills";
    title = "All drills · Trap Drills";
  } else if (head === "scale") {
    renderScale();
    nav = "scale";
    title = "The scale follow-up · Trap Drills";
  } else if (head === "mock") {
    nav = "mock";
    title = "Mock round · Trap Drills";
    const mock = state.store.mock;
    if (id === "run" && mock && !mock.finishedAt) {
      const index = Math.min(Math.max(Number(parts[2] || 1), 1), mock.ids.length) - 1;
      renderDrill(state.byDrill.get(mock.ids[index]), { mock, index });
      wireMockBar(mock);
    } else if (id === "result" || (id === "run" && mock && mock.finishedAt)) {
      renderMockResult();
    } else {
      renderMockSetup();
    }
  } else {
    renderHome();
  }
  saveStore();
  setNav(nav);
  updateProgress();
  document.title = title;
  if (scroll) window.scrollTo(0, 0);
}

$("#theme").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("trapdrills:theme", next);
  } catch {
    // The choice then lasts for this visit only.
  }
});

async function start() {
  try {
    const response = await fetch(`drills.json?v=${ASSETS}`);
    if (!response.ok) throw new Error(`drills.json: HTTP ${response.status}`);
    state.data = await response.json();
  } catch (error) {
    main.innerHTML = `<p class="verdict fail"><b>ERROR</b><span>The drills could not be loaded.</span></p><pre class="error">${esc(error.message || error)}</pre>`;
    return;
  }
  setRunner(state.data.runner);
  state.drills = state.data.drills;
  state.concepts = state.data.concepts;
  state.paths = state.data.paths;
  state.byDrill = new Map(state.drills.map((d) => [d.id, d]));
  state.byConcept = new Map(state.concepts.map((c) => [c.id, c]));
  state.byPath = new Map(state.paths.map((p) => [p.id, p]));
  for (const concept of state.concepts) {
    for (const id of concept.drills) state.conceptsOf.set(id, [...(state.conceptsOf.get(id) || []), concept]);
  }
  if (new URLSearchParams(location.search).has("selftest")) {
    await selftest();
    return;
  }
  wirePalette();
  window.addEventListener("hashchange", () => route());
  route();
}

start();
