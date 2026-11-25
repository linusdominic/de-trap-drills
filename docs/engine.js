// Trap Drills: the two engines and the checking rules.
//
// SQL answers run in DuckDB-Wasm and Python answers in Pyodide, both loaded from
// jsDelivr on first use. The checking rules mirror src/trapdrills/sqlcheck.py and
// pycheck.py; tools/browser_check.py runs every drill here and on the command line
// and fails if the two disagree.

export const DUCKDB_WASM = "1.32.0";
export const PYODIDE = "314.0.8";
const ASSETS = "20261126c";
const PY_TIMEOUT_MS = 8000;
const NUMERIC = /^(U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|FLOAT|DOUBLE|REAL|DECIMAL(\(.*\))?)$/;

let runnerSource = "";

// The Python checking code (src/trapdrills/pyrunner.py) arrives inside drills.json.
export function setRunner(source) {
  runnerSource = source;
}

// ---------------------------------------------------------------- SQL engine

let sqlEnginePromise = null;
let sqlQueue = Promise.resolve();
let attachCounter = 0;

export function sqlEngine() {
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

export function runSql(drill, answer, normalise = true) {
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

export const isBlank = (answer) => answer.split("\n").every((line) => !line.trim() || line.trim().startsWith("--"));

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
    pyWorker = new Worker(`py-worker.js?v=${ASSETS}`, { type: "module" });
    pyWorker.onmessage = (event) => {
      const waiting = pyWaiting.get(event.data.id);
      if (!waiting) return;
      pyWaiting.delete(event.data.id);
      clearTimeout(waiting.timer);
      if (event.data.ok) waiting.resolve(event.data.result);
      else waiting.reject(new Error(event.data.error));
    };
    pyReady = pyCall("init", { version: PYODIDE, runner: runnerSource }, 120000).then((info) => {
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

export async function runPython(drill, code) {
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

export const checkDrill = (drill, answer) => (drill.track === "sql" ? checkSql(drill, answer) : checkPython(drill, answer));

// A concept example: one SELECT on its own small dataset, read back as display text.
export function runExample(setup, code) {
  return freshDatabase(async (conn) => {
    if (setup) await conn.query(setup);
    await conn.query(`CREATE TABLE _answer AS ${code}`);
    return readTable(conn, "_answer", false);
  });
}

export const sqlLoaded = () => sqlEnginePromise !== null;
export const pythonInfo = () => pyInfo;
