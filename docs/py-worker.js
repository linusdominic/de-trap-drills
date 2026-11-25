// Runs Python answers in Pyodide, off the main thread, so a runaway answer can be
// stopped by terminating this worker. The checking code is src/trapdrills/pyrunner.py,
// shipped inside drills.json: the same source the command line uses.

let runCases = null;

self.onmessage = async (event) => {
  const { id, type, payload } = event.data;
  try {
    if (type === "init") {
      // Pyodide 314 loads only as an ES module, so this file is started as a module worker.
      const { loadPyodide } = await import(`https://cdn.jsdelivr.net/pyodide/v${payload.version}/full/pyodide.mjs`);
      const pyodide = await loadPyodide();
      const namespace = pyodide.toPy({ __name__: "pyrunner" });
      pyodide.runPython(payload.runner, { globals: namespace });
      runCases = namespace.get("run_cases_json");
      const python = pyodide.runPython("import sys; '.'.join(str(n) for n in sys.version_info[:3])");
      self.postMessage({ id, ok: true, result: { pyodide: pyodide.version, python } });
    } else if (type === "run") {
      const json = runCases(payload.code, payload.function, JSON.stringify(payload.cases));
      self.postMessage({ id, ok: true, result: JSON.parse(json) });
    }
  } catch (error) {
    self.postMessage({ id, ok: false, error: String((error && error.message) || error) });
  }
};
