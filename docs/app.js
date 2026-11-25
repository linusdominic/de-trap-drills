// Trap Drills: the browser site. No build step and no server.
//
// SQL answers run in DuckDB-Wasm and Python answers in Pyodide, both loaded from
// jsDelivr on first use. The checking rules mirror src/trapdrills/sqlcheck.py and
// pycheck.py; tools/browser_check.py runs every drill here and on the command line
// and fails if the two disagree.

const DUCKDB_WASM = "1.32.0";
const PYODIDE = "314.0.8";
const STORE = "trapdrills:v1";
const SHOWN = 6;
const PY_TIMEOUT_MS = 8000;
const NUMERIC = /^(U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|FLOAT|DOUBLE|REAL|DECIMAL(\(.*\))?)$/;

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
};

const $ = (selector, root = document) => root.querySelector(selector);
const main = $("#main");
const state = { data: null, drills: [], byId: new Map(), store: loadStore() };

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

// The drill texts use a small subset of Markdown: paragraphs, lists, `code`, **bold**, *italic*.
function md(text) {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split("\n");
      if (lines.every((l) => /^- /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join("")}</ul>`;
      if (lines.every((l) => /^\d+\. /.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\d+\. /, ""))}</li>`).join("")}</ol>`;
      return `<p>${inline(lines.join(" "))}</p>`;
    })
    .join("");
}

function loadStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE) || "{}");
    return { solved: parsed.solved || {}, drafts: parsed.drafts || {} };
  } catch {
    return { solved: {}, drafts: {} };
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

// ---------------------------------------------------------------- SQL engine

let sqlEnginePromise = null;
let sqlQueue = Promise.resolve();
let attachCounter = 0;

function sqlEngine() {
  if (!sqlEnginePromise) {
    sqlEnginePromise = (async () => {
      const duckdb = await import(`https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_WASM}/+esm`);
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(workerUrl);
      const conn = await db.connect();
      const version = (await conn.query("SELECT version() AS v")).getChildAt(0).get(0);
      return { conn, version: String(version) };
    })();
    sqlEnginePromise.catch(() => { sqlEnginePromise = null; });
  }
  return sqlEnginePromise;
}

// Every run gets its own empty database, attached for the run and dropped after it.
// Runs are queued because they share one connection.
function freshDatabase(work) {
  const run = sqlQueue.then(async () => {
    const { conn } = await sqlEngine();
    const name = `run_${++attachCounter}`;
    await conn.query(`ATTACH ':memory:' AS ${name}`);
    await conn.query(`USE ${name}`);
    try {
      return await work(conn);
    } finally {
      await conn.query("USE memory");
      await conn.query(`DETACH ${name}`);
    }
  });
  sqlQueue = run.catch(() => {});
  return run;
}

const quote = (name) => `"${name.replace(/"/g, '""')}"`;

async function readTable(conn, table, normalise) {
  const described = await conn.query(`DESCRIBE ${quote(table)}`);
  const columns = [];
  const types = [];
  for (let i = 0; i < described.numRows; i++) {
    columns.push(String(described.getChildAt(0).get(i)));
    types.push(String(described.getChildAt(1).get(i)));
  }
  const parts = columns.map((name, i) =>
    normalise && NUMERIC.test(types[i])
      ? `regexp_replace(CAST(round(CAST(${quote(name)} AS DOUBLE), 6) AS VARCHAR), '\\.0$', '')`
      : `CAST(${quote(name)} AS VARCHAR)`
  );
  const result = await conn.query(`SELECT ${parts.join(", ")} FROM ${quote(table)} ORDER BY rowid`);
  const rows = [];
  for (let r = 0; r < result.numRows; r++) {
    const row = [];
    for (let c = 0; c < columns.length; c++) {
      const value = result.getChildAt(c).get(r);
      row.push(value === null || value === undefined ? null : value === "-0" ? "0" : String(value));
    }
    rows.push(row);
  }
  return { columns, types, rows };
}

function runSql(drill, answer, normalise = true) {
  return freshDatabase(async (conn) => {
    await conn.query(drill.setup);
    if (drill.checkQuery) {
      await conn.query(answer);
      await conn.query(`CREATE TABLE _answer AS ${drill.checkQuery}`);
    } else {
      await conn.query(`CREATE TABLE _answer AS ${answer}`);
    }
    return readTable(conn, "_answer", normalise);
  });
}

const isBlank = (answer) => answer.split("\n").every((line) => !line.trim() || line.trim().startsWith("--"));

function counts(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = JSON.stringify(row);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

function minus(a, b) {
  const rows = [];
  for (const [key, n] of a) {
    for (let i = 0; i < n - (b.get(key) || 0); i++) rows.push(JSON.parse(key));
  }
  return rows.sort((x, y) => {
    for (let i = 0; i < x.length; i++) {
      if (x[i] === y[i]) continue;
      if (x[i] === null) return 1;
      if (y[i] === null) return -1;
      return x[i] < y[i] ? -1 : 1;
    }
    return 0;
  });
}

function compareTables(expected, actual, drill) {
  if (actual.columns.length !== expected.columns.length) {
    return {
      passed: false,
      headline: `Expected ${expected.columns.length} columns (${drill.columns.join(", ")}), got ${actual.columns.length} (${actual.columns.join(", ")}).`,
    };
  }
  const want = counts(expected.rows);
  const got = counts(actual.rows);
  const same = drill.ordered
    ? JSON.stringify(expected.rows) === JSON.stringify(actual.rows)
    : want.size === got.size && [...want].every(([key, n]) => got.get(key) === n);
  if (same) return { passed: true, headline: `${actual.rows.length} rows match the reference answer.` };
  const missing = minus(want, got);
  const unexpected = minus(got, want);
  if (!missing.length && !unexpected.length) return { passed: false, headline: "The rows are right but the order is wrong." };
  const headline =
    actual.rows.length === expected.rows.length
      ? `Right number of rows (${actual.rows.length}), but ${unexpected.length} of them differ from the reference.`
      : `Your result has ${actual.rows.length} rows; the reference has ${expected.rows.length}.`;
  return { passed: false, headline, missing, unexpected };
}

async function checkSql(drill, answer) {
  if (isBlank(answer)) return { passed: false, headline: "The answer is empty." };
  const expected = await runSql(drill, drill.reference);
  let actual;
  try {
    actual = await runSql(drill, answer);
  } catch (error) {
    return { passed: false, headline: "DuckDB could not run the answer.", error: String(error.message || error) };
  }
  return compareTables(expected, actual, drill);
}

// ---------------------------------------------------------------- Python engine

let pyWorker = null;
let pyReady = null;
let pyInfo = null;
let pyCalls = 0;
const pyWaiting = new Map();

function pyCall(type, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = ++pyCalls;
    const timer = setTimeout(() => {
      pyWaiting.delete(id);
      reject(new Error("timeout"));
    }, timeoutMs);
    pyWaiting.set(id, { resolve, reject, timer });
    pyWorker.postMessage({ id, type, payload });
  });
}

function pyEngine() {
  if (!pyReady) {
    pyWorker = new Worker("py-worker.js?v=20261126a", { type: "module" });
    pyWorker.onmessage = (event) => {
      const waiting = pyWaiting.get(event.data.id);
      if (!waiting) return;
      pyWaiting.delete(event.data.id);
      clearTimeout(waiting.timer);
      if (event.data.ok) waiting.resolve(event.data.result);
      else waiting.reject(new Error(event.data.error));
    };
    pyReady = pyCall("init", { version: PYODIDE, runner: state.data.runner }, 120000).then((info) => {
      pyInfo = info;
      return info;
    });
    pyReady.catch(stopPython);
  }
  return pyReady;
}

function stopPython() {
  if (pyWorker) pyWorker.terminate();
  pyWorker = null;
  pyReady = null;
}

async function runPython(drill, code) {
  await pyEngine();
  try {
    return await pyCall("run", { code, function: drill.function, cases: drill.cases }, PY_TIMEOUT_MS);
  } catch (error) {
    if (error.message !== "timeout") throw error;
    stopPython(); // the only way to stop a loop; Pyodide reloads on the next run
    const reason = `timed out after ${PY_TIMEOUT_MS / 1000} seconds (an endless loop, or reading an endless stream?)`;
    return drill.cases.map((c) => ({ name: c.name, output: null, error: reason }));
  }
}

async function checkPython(drill, answer) {
  if (!answer.trim()) return { passed: false, headline: "The answer is empty." };
  const expected = await runPython(drill, drill.reference);
  const actual = await runPython(drill, answer);
  const cases = drill.cases.map((c, i) => ({
    name: c.name,
    args: c.args,
    ok: actual[i].error === null && actual[i].output === expected[i].output,
    expected: expected[i].output ?? expected[i].error,
    yours: actual[i].error ?? actual[i].output,
  }));
  const failed = cases.filter((c) => !c.ok).length;
  return {
    passed: failed === 0,
    headline: failed ? `${failed} of ${cases.length} cases fail.` : `All ${cases.length} cases match the reference answer.`,
    cases,
  };
}

const check = (drill, answer) => (drill.track === "sql" ? checkSql(drill, answer) : checkPython(drill, answer));

// ---------------------------------------------------------------- views

function renderRail(activeId) {
  const group = (track, label) => {
    const drills = state.drills.filter((d) => d.track === track);
    const solved = drills.filter((d) => state.store.solved[d.id]).length;
    const items = drills
      .map((d, i) => {
        const current = d.id === activeId ? ' aria-current="page"' : "";
        const tick = state.store.solved[d.id] ? '<span class="tick" aria-label="solved">✓</span>' : "<span></span>";
        return `<li><a href="#/d/${d.id}"${current}><span class="num">${String(i + 1).padStart(2, "0")}</span><span>${esc(d.title)}</span>${tick}</a></li>`;
      })
      .join("");
    return `<h2><span>${label}</span><span>${solved}/${drills.length}</span></h2><ol>${items}</ol>`;
  };
  $("#rail").innerHTML = group("sql", "SQL") + group("python", "Python");
  const solved = state.drills.filter((d) => state.store.solved[d.id]).length;
  $("#progress").textContent = `${solved} / ${state.drills.length} solved`;
  const active = $('#rail a[aria-current="page"]');
  if (active) active.scrollIntoView({ block: "nearest" });
}

function renderHome() {
  const demo = state.byId.get("sum-after-dedupe");
  const families = Object.keys(FAMILY_NOTES)
    .map((family) => {
      const drills = state.drills.filter((d) => d.family === family);
      if (!drills.length) return "";
      const links = drills
        .map((d) => `<li><span class="track">${d.track === "sql" ? "SQL" : "Py"}</span><a href="#/d/${d.id}">${esc(d.title)}</a></li>`)
        .join("");
      return `<section class="card family"><h3>${esc(family)}<span>${drills.length} ${drills.length === 1 ? "drill" : "drills"}</span></h3><p>${esc(FAMILY_NOTES[family])}</p><ul>${links}</ul></section>`;
    })
    .join("");
  const sql = state.drills.filter((d) => d.track === "sql").length;
  main.innerHTML = `
    <section class="hero">
      <div>
        <p class="eyebrow">${state.drills.length} drills for data engineers</p>
        <h1>The obvious answer <em>fails</em>.</h1>
        <p class="lede">Every dataset here has a trap planted in it: a resent row, a NULL, a missing day, a tie. Write the query or the function, run it in your browser, and see exactly which rows came out wrong.</p>
        <div class="hero-actions">
          <a class="button primary" href="#/d/${state.drills[0].id}">Start the first drill</a>
          <a class="button" href="#/scale">See the scale numbers</a>
        </div>
      </div>
      <div class="card demo" aria-label="Example of a failed check">
        <div class="demo-head"><span class="chip">${esc(demo.family)}</span>${esc(demo.title)}</div>
        <pre>${esc(demo.naive.trim())}</pre>
        <p class="verdict fail"><b>FAIL</b><span>Right number of rows (3), but 2 of them differ from the reference.</span></p>
        ${dataTable(["customer_id", "expected", "yours"], [["10", "140", "240"], ["12", "65", "225"]])}
      </div>
    </section>

    <h2 class="section-title">How a drill works</h2>
    <div class="steps">
      <section class="card step"><span class="n">01</span><h3>Read the brief and the data</h3><p>A short business question and the full contents of the tables. The trap is in the rows, not in the wording.</p></section>
      <section class="card step"><span class="n">02</span><h3>Write it, check it</h3><p>Your answer and a reference answer both run on the dataset. You get PASS, or the rows that are missing and the rows that should not be there.</p></section>
      <section class="card step"><span class="n">03</span><h3>Learn the trap and the scale answer</h3><p>Each drill explains why the obvious answer fails and what to say when asked to make it fast on a very large table.</p></section>
    </div>

    <h2 class="section-title">The traps</h2>
    <div class="families">${families}</div>

    <section class="card local">
      <h2 class="section-title">Run it on your machine, or with a coach</h2>
      <p>The same ${sql} SQL and ${state.drills.length - sql} Python drills run from the command line against DuckDB and your own Python. The repository also carries a <code>CLAUDE.md</code> that turns a coding agent into a mock interviewer: it asks one drill at a time, runs your answer and asks the scale follow-up.</p>
      <pre>git clone https://github.com/linusdominic/de-trap-drills
cd de-trap-drills &amp;&amp; uv sync
uv run drills list
uv run drills start dedupe-latest
uv run drills check dedupe-latest</pre>
      <p class="fineprint">Nothing you type here leaves your browser: answers run in DuckDB-Wasm ${DUCKDB_WASM} and Pyodide ${PYODIDE}, and progress is kept in this browser's local storage.</p>
    </section>`;
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
    return `<h2>Measured: ${esc(experiment.title.toLowerCase())}</h2><div class="measure">${rows}</div><p class="measure-note">${note} <a href="#/scale">All experiments</a></p>`;
  }
  const sql = experiment.variants.map((v) => `-- ${v.name}\n${v.sql}\n-- plan: ${v.operators.join(" > ")}`).join("\n\n");
  return `<section class="card experiment"><h2>${esc(experiment.title)}</h2><p class="q">${esc(experiment.question)}</p><div class="measure">${rows}</div><details><summary>The queries and their plans</summary><pre>${esc(sql)}</pre></details></section>`;
}

function formatSeconds(seconds) {
  return seconds >= 1 ? `${seconds.toFixed(2)} s` : `${(seconds * 1000).toFixed(seconds < 0.01 ? 1 : 0)} ms`;
}

function renderScale() {
  const scale = state.data.scale;
  if (!scale) {
    main.innerHTML = '<div class="scale-page"><h1>The scale follow-up</h1><p class="lede">No benchmark results are bundled with this build. Run <code>make scale</code>.</p></div>';
    return;
  }
  const setup = scale.setup;
  main.innerHTML = `
    <div class="scale-page">
      <p class="eyebrow">Measured, not recited</p>
      <h1>"Now make it fast on a big table"</h1>
      <p class="lede">Every interview answer about scale is a claim that can be tested. These are the standard claims, timed on one machine: ${scale.rows.toLocaleString("en-US")} rows of synthetic events in date-partitioned Parquet, queried with DuckDB. Within each group the queries return the same answer, unless one is marked as a narrower question; only the route differs.</p>
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

function renderDrill(drill) {
  const index = state.drills.indexOf(drill);
  const previous = state.drills[index - 1];
  const next = state.drills[index + 1];
  const isSql = drill.track === "sql";
  const draft = state.store.drafts[drill.id] ?? drill.starter;
  const brief = isSql
    ? `<h2>Return</h2>
       <p class="expect">Columns, in this order: ${drill.columns.map((c) => `<code>${esc(c)}</code>`).join(" ")}. ${drill.ordered ? "Row order matters." : "Row order does not matter."} Column names are not checked.</p>
       <h2>The data</h2>
       ${drill.tables
         .map((t) => `<div class="table-wrap"><div class="table-name">${esc(t.name)}<span>${t.rows.length} rows</span></div>${dataTable(t.columns, t.rows, t.types)}</div>`)
         .join("")}`
    : `<h2>Define</h2>
       <p class="expect">A function called <code>${esc(drill.function)}</code>. It is called once per case and its result is compared with the reference answer's.</p>
       <h2>The cases</h2>
       <ul class="cases">${drill.cases
         .map((c) => `<li><span class="case-name">${esc(c.name)}</span><pre>${esc(c.args)}${c.take ? `\n(the first ${c.take} items of the result are taken)` : ""}</pre></li>`)
         .join("")}</ul>`;
  main.innerHTML = `
    <article class="drill">
      <header class="drill-head">
        <p class="eyebrow"><span>${isSql ? "SQL" : "Python"}</span><span class="sep" aria-hidden="true">/</span><span>${esc(drill.pattern)}</span><span class="chip">${esc(drill.family)}</span></p>
        <h1>${esc(drill.title)}</h1>
      </header>
      <div class="cols">
        <section class="brief" aria-label="Brief">
          <h2>The brief</h2>
          ${md(drill.prompt)}
          ${brief}
        </section>
        <section class="bench" aria-label="Your answer">
          <label class="eyebrow" for="editor">Your ${isSql ? "query" : "function"}</label>
          <textarea class="editor" id="editor" spellcheck="false" autocapitalize="off" autocomplete="off">${esc(draft)}</textarea>
          <div class="actions">
            <button class="button primary" id="check" type="button">Check</button>
            ${isSql ? '<button class="button" id="run" type="button">Run</button>' : ""}
            <button class="button quiet" id="reset" type="button">Reset</button>
            <span class="hint"><kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>Enter</kbd> checks</span>
          </div>
          <p class="engine" id="engine"></p>
          <div id="result" aria-live="polite"></div>
          <details class="reveal" id="trap"><summary>What is the trap?</summary><div class="body">${md(drill.trap)}</div></details>
          ${drill.scale ? `<details class="reveal" id="scale"><summary>The scale follow-up</summary><div class="body">${md(drill.scale)}${drill.experiment ? measured(drill.experiment, true) : ""}</div></details>` : ""}
          <details class="reveal" id="reference"><summary>Reference answer</summary><div class="body"><pre>${esc(drill.reference.trim())}</pre></div></details>
        </section>
      </div>
      <nav class="pager" aria-label="Previous and next drill">
        ${previous ? `<a href="#/d/${previous.id}"><span>Previous</span>${esc(previous.title)}</a>` : "<span></span>"}
        ${next ? `<a href="#/d/${next.id}" style="text-align:right"><span>Next</span>${esc(next.title)}</a>` : "<span></span>"}
      </nav>
    </article>`;

  const editor = $("#editor");
  const result = $("#result");
  const engine = $("#engine");
  const buttons = [$("#check"), $("#run")].filter(Boolean);
  let saveTimer = null;

  editor.addEventListener("input", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      state.store.drafts[drill.id] = editor.value;
      saveStore();
    }, 300);
  });
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      $("#check").click();
    } else if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      editor.setRangeText(isSql ? "  " : "    ", editor.selectionStart, editor.selectionEnd, "end");
      editor.dispatchEvent(new Event("input"));
    }
  });
  $("#reset").addEventListener("click", () => {
    editor.value = drill.starter;
    delete state.store.drafts[drill.id];
    saveStore();
    result.innerHTML = "";
    editor.focus();
  });

  async function withEngine(work) {
    buttons.forEach((b) => (b.disabled = true));
    const loaded = isSql ? sqlEnginePromise : pyInfo;
    engine.textContent = loaded
      ? "Running ..."
      : isSql
        ? `Loading DuckDB-Wasm ${DUCKDB_WASM} (about 5 MB to download the first time, then cached) ...`
        : `Loading Pyodide ${PYODIDE} (about 6 MB to download the first time, then cached) ...`;
    try {
      await work();
      engine.textContent = isSql
        ? `Ran in your browser on DuckDB-Wasm ${DUCKDB_WASM} (${(await sqlEngine()).version}).`
        : `Ran in your browser on Pyodide ${pyInfo.pyodide} (Python ${pyInfo.python}).`;
    } catch (error) {
      engine.textContent = "";
      result.innerHTML = `<p class="verdict fail"><b>ERROR</b><span>The ${isSql ? "SQL" : "Python"} engine could not be loaded or stopped responding. Check your connection and try again.</span></p><pre class="error">${esc(error.message || error)}</pre>`;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  $("#check").addEventListener("click", () =>
    withEngine(async () => {
      const verdict = await check(drill, editor.value);
      result.innerHTML = verdictHtml(verdict, drill);
      if (verdict.passed) {
        state.store.solved[drill.id] = true;
        saveStore();
        renderRail(drill.id);
        $("#trap").open = true;
        $("#trap summary").textContent = "The trap you avoided";
        if ($("#scale")) $("#scale").open = true;
      }
    })
  );
  if (isSql) {
    $("#run").addEventListener("click", () =>
      withEngine(async () => {
        if (isBlank(editor.value)) {
          result.innerHTML = '<p class="verdict fail"><b>EMPTY</b><span>Write a query first.</span></p>';
          return;
        }
        try {
          const table = await runSql(drill, editor.value, false);
          const shown = table.rows.slice(0, 100);
          const label = drill.checkQuery ? "The table after your statements" : "Your result";
          result.innerHTML = `<p class="diff-label">${label} <small>${table.rows.length} rows${table.rows.length > shown.length ? `, first ${shown.length} shown` : ""}</small></p><div class="table-wrap">${dataTable(table.columns, shown)}</div>`;
        } catch (error) {
          result.innerHTML = `<p class="verdict fail"><b>ERROR</b><span>DuckDB could not run the query.</span></p><pre class="error">${esc(error.message || error)}</pre>`;
        }
      })
    );
  }
}

function verdictHtml(verdict, drill) {
  let html = `<p class="verdict ${verdict.passed ? "pass" : "fail"}"><b>${verdict.passed ? "PASS" : "FAIL"}</b><span>${esc(verdict.headline)}</span></p>`;
  if (verdict.error) html += `<pre class="error">${esc(verdict.error)}</pre>`;
  if (verdict.missing && verdict.missing.length) {
    html += `<p class="diff-label">Missing from your result <small>${verdict.missing.length} rows the reference returns and yours does not</small></p><div class="table-wrap">${dataTable(drill.columns, verdict.missing.slice(0, SHOWN))}</div>`;
  }
  if (verdict.unexpected && verdict.unexpected.length) {
    html += `<p class="diff-label">Not expected <small>${verdict.unexpected.length} rows yours returns and the reference does not</small></p><div class="table-wrap">${dataTable(drill.columns, verdict.unexpected.slice(0, SHOWN))}</div>`;
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
  if (!verdict.passed && !verdict.error) html += '<p class="fineprint">Work out what the difference means before you open the explanation.</p>';
  return html;
}

// ---------------------------------------------------------------- self-test
// tools/browser_check.py opens ?selftest=1 in headless Chrome. Every reference and
// naive answer runs here and the outcome is posted back for comparison with the
// command line's result.

async function selftest() {
  $("#rail").hidden = true;
  main.innerHTML = '<div class="selftest"><h1>Self-test</h1><pre id="log">running ...</pre></div>';
  const log = $("#log");
  const report = { userAgent: navigator.userAgent, duckdbWasm: DUCKDB_WASM, drills: {} };
  try {
    await selftestDrills(report, log);
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

async function selftestDrills(report, log) {
  for (const drill of state.drills) {
    const entry = {};
    if (drill.track === "sql") {
      entry.reference = await runSql(drill, drill.reference).then((t) => t.rows);
      entry.naive = await runSql(drill, drill.naive).then((t) => t.rows, (e) => ({ error: String(e.message || e) }));
    } else {
      entry.reference = await runPython(drill, drill.reference);
      entry.naive = await runPython(drill, drill.naive);
    }
    entry.referencePasses = (await check(drill, drill.reference)).passed;
    entry.naivePasses = (await check(drill, drill.naive)).passed;
    report.drills[drill.id] = entry;
    log.textContent += `\n${entry.referencePasses && !entry.naivePasses ? "ok     " : "PROBLEM"} ${drill.id}`;
  }
  report.duckdb = (await sqlEngine()).version;
  report.pyodide = pyInfo;
  log.textContent += `\n\nDuckDB ${report.duckdb}, Pyodide ${pyInfo.pyodide}, Python ${pyInfo.python}`;
}

// ---------------------------------------------------------------- routing

function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  const drill = hash.startsWith("d/") ? state.byId.get(hash.slice(2)) : null;
  document.querySelectorAll(".top-nav a[data-nav]").forEach((a) => {
    const on = (a.dataset.nav === "scale") === (hash === "scale");
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  renderRail(drill ? drill.id : null);
  if (drill) {
    renderDrill(drill);
    document.title = `${drill.title} · Trap Drills`;
  } else if (hash === "scale") {
    renderScale();
    document.title = "The scale follow-up · Trap Drills";
  } else {
    renderHome();
    document.title = "Trap Drills: data engineering drills where the obvious answer fails";
  }
  window.scrollTo(0, 0);
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
    const response = await fetch("drills.json?v=20261126a");
    if (!response.ok) throw new Error(`drills.json: HTTP ${response.status}`);
    state.data = await response.json();
  } catch (error) {
    main.innerHTML = `<p class="verdict fail"><b>ERROR</b><span>The drills could not be loaded.</span></p><pre class="error">${esc(error.message || error)}</pre>`;
    return;
  }
  state.drills = state.data.drills;
  state.byId = new Map(state.drills.map((d) => [d.id, d]));
  if (new URLSearchParams(location.search).has("selftest")) {
    await selftest();
    return;
  }
  window.addEventListener("hashchange", route);
  route();
}

start();
