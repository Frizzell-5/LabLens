// Runs Python (Pyodide) off the main thread so the interface never freezes.
const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/";
importScripts(PYODIDE_URL + "pyodide.js");

// Web fonts are fetched into the engine the first time a figure uses them, so PNG and PDF
// exports use the real typeface (pinned to one commit of the Google Fonts repository).
const FONT_BASE = "https://cdn.jsdelivr.net/gh/google/fonts@e7db6ca603fd4862010383ff17ffd6cc4ffac1c0/ofl/";
const WEB_FONTS = {
  lato: ["lato/Lato-Regular.ttf", "lato/Lato-Bold.ttf"],
  fira: ["firasans/FiraSans-Regular.ttf", "firasans/FiraSans-Bold.ttf"],
  barlow: ["barlow/Barlow-Regular.ttf", "barlow/Barlow-Bold.ttf"],
  poppins: ["poppins/Poppins-Regular.ttf", "poppins/Poppins-Bold.ttf"],
  ptserif: ["ptserif/PT_Serif-Web-Regular.ttf", "ptserif/PT_Serif-Web-Bold.ttf"],
  crimson: ["crimsontext/CrimsonText-Regular.ttf", "crimsontext/CrimsonText-Bold.ttf"],
  courier: ["courierprime/CourierPrime-Regular.ttf", "courierprime/CourierPrime-Bold.ttf"],
  spacemono: ["spacemono/SpaceMono-Regular.ttf", "spacemono/SpaceMono-Bold.ttf"],
  comic: ["comicneue/ComicNeue-Regular.ttf", "comicneue/ComicNeue-Bold.ttf"],
};

let py = null;
let api = null;
let excelReady = false;
const fontsLoaded = new Set();

function status(text) {
  postMessage({ type: "status", text });
}

const ready = (async () => {
  status("Starting Python");
  py = await loadPyodide({ indexURL: PYODIDE_URL });
  status("Loading NumPy, SciPy, pandas and matplotlib");
  await py.loadPackage(["numpy", "pandas", "scipy", "matplotlib"]);
  const res = await fetch("engine/lablens.py", { cache: "no-cache" });
  if (!res.ok) throw new Error("couldn't load the analysis engine (" + res.status + ")");
  py.FS.writeFile("/home/pyodide/lablens.py", await res.text());
  py.FS.mkdirTree("/home/pyodide/fonts");
  py.runPython("import sys; sys.path.insert(0, '/home/pyodide')");
  api = py.pyimport("lablens").api;
  const versions = JSON.parse(api("versions", "{}")).ok;
  postMessage({ type: "ready", versions });
})().catch((err) => {
  postMessage({ type: "failed", text: String(err && err.message ? err.message : err) });
  throw err;
});

async function ensureFont(key) {
  if (!key || !WEB_FONTS[key] || fontsLoaded.has(key)) return;
  status("Loading font");
  const paths = [];
  for (const file of WEB_FONTS[key]) {
    const res = await fetch(FONT_BASE + file);
    if (!res.ok) continue;
    const path = "/home/pyodide/fonts/" + file.split("/").pop();
    py.FS.writeFile(path, new Uint8Array(await res.arrayBuffer()));
    paths.push(path);
  }
  if (paths.length) api("fonts", JSON.stringify({ paths }));
  fontsLoaded.add(key);
  status("Ready");
}

onmessage = async (event) => {
  const { id, cmd, args } = event.data;
  try {
    await ready;
    if (cmd === "excel" && !excelReady) {
      status("Loading Excel support");
      await py.loadPackage(["openpyxl"]);
      excelReady = true;
      status("Ready");
    }
    if (cmd === "run") {
      try {
        await ensureFont(args && args.config && args.config.style && args.config.style.font);
      } catch (e) {
        status("Ready"); // offline or blocked: the figure falls back to a built-in font
      }
    }
    const out = JSON.parse(api(cmd, JSON.stringify(args || {})));
    postMessage({ type: "result", id, out });
  } catch (err) {
    postMessage({ type: "result", id, out: { error: String(err && err.message ? err.message : err) } });
  }
};
