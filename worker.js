// Runs Python (Pyodide) off the main thread so the interface never freezes.
const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/";
importScripts(PYODIDE_URL + "pyodide.js");

let py = null;
let api = null;
let excelReady = false;

function status(text) {
  postMessage({ type: "status", text });
}

const ready = (async () => {
  status("Starting Python");
  py = await loadPyodide({ indexURL: PYODIDE_URL });
  status("Loading NumPy, SciPy, pandas and matplotlib");
  await py.loadPackage(["numpy", "pandas", "scipy", "matplotlib"]);
  const src = await (await fetch("engine/lablens.py", { cache: "no-cache" })).text();
  py.FS.writeFile("/home/pyodide/lablens.py", src);
  py.runPython("import sys; sys.path.insert(0, '/home/pyodide')");
  api = py.pyimport("lablens").api;
  const versions = JSON.parse(api("versions", "{}")).ok;
  postMessage({ type: "ready", versions });
})().catch((err) => {
  postMessage({ type: "failed", text: String(err && err.message ? err.message : err) });
  throw err;
});

onmessage = async (event) => {
  const { id, cmd, args } = event.data;
  try {
    await ready;
    if (cmd === "excel" && !excelReady) {
      status("Loading Excel support");
      await py.loadPackage(["openpyxl"]);
      excelReady = true;
      postMessage({ type: "status", text: "Ready" });
    }
    const out = JSON.parse(api(cmd, JSON.stringify(args || {})));
    postMessage({ type: "result", id, out });
  } catch (err) {
    postMessage({ type: "result", id, out: { error: String(err && err.message ? err.message : err) } });
  }
};
