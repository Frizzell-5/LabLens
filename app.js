"use strict";

// ============================================================================
// Small helpers
// ============================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const slug = (s) => (String(s || "serpentine").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "serpentine");
const clone = (o) => JSON.parse(JSON.stringify(o));
const STORE_KEY = "serpentine.project.v1";
const STYLES_KEY = "serpentine.styles.v1";
const SECTIONS_KEY = "serpentine.sections.v1";
const APP_NAMES = ["Serpentine", "LabLens"]; // the app was called LabLens before v0.2.1

// Carry browser-saved work over from the old name, once.
try {
  for (const k of ["project", "styles", "sections"]) {
    const oldKey = "lablens." + k + ".v1";
    const newKey = "serpentine." + k + ".v1";
    if (localStorage.getItem(newKey) === null && localStorage.getItem(oldKey) !== null) localStorage.setItem(newKey, localStorage.getItem(oldKey));
  }
} catch (e) { /* storage unavailable */ }

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || "null");
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return value === undefined ? null : false;
  }
}

function fmtNum(v) {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v !== "number") return String(v);
  if (Number.isInteger(v) && Math.abs(v) < 1e6) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(2);
  return String(parseFloat(v.toPrecision(4)));
}

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2800);
}

function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg || "Copied");
  } catch (e) {
    toast("Your browser blocked copying. Use the download button instead.");
  }
}

// Two-click confirmation on a button (no browser dialogs).
function armConfirm(btn, question, action) {
  if (btn.dataset.armed === "1") {
    btn.dataset.armed = "";
    btn.textContent = btn.dataset.label;
    action();
    return;
  }
  btn.dataset.label = btn.textContent;
  btn.dataset.armed = "1";
  btn.textContent = question;
  setTimeout(() => {
    if (btn.dataset.armed === "1") {
      btn.dataset.armed = "";
      btn.textContent = btn.dataset.label;
    }
  }, 3500);
}

// ============================================================================
// Defaults
// ============================================================================
const DEFAULT_SETTINGS = {
  compare: { dataset: "", layout: "wide", columns: [], value_col: "", group_col: "", group_order: "", y_name: "", paired: false, test: "auto", equal_var: false, posthoc: "all" },
  timecourse: {
    time_col: "", time_unit: "seconds", value_col: "", valid_min: "", valid_max: "", filter_col: "", filter_min: "", filter_max: "",
    bin: 30, baseline_start: -5, baseline_end: 0, window_start: -10, window_end: 30, event_label: "Injection", norm: "pct",
    metric: "mean", endpoint_start: 25, endpoint_end: 30, pair_subjects: false, test: "auto", equal_var: false, posthoc: "all",
    group_order: "", band: "sem", band_style: "band", show_traces: true, show_event: true, shade_baseline: true, shade_endpoint: true,
  },
  correlation: { dataset: "", x_col: "", y_col: "", group_col: "", group_order: "", method: "pearson", fit: true, ci: true, annotate: true },
  dose: { dataset: "", x_col: "", x_unit: "", x_scale: 1, mode: "curves", y_cols: [], curve_name: "Response", fix_bottom: "", fix_top: "", show_ec50: true, all_points: false, ec_label: "" },
};

// Everything about the look of a figure. Quick styles reset these and nothing else.
const LOOK_DEFAULTS = {
  width: 4, height: 3.4, theme: "light", bg_color: "", axes_color: "", ink_color: "",
  font: "sans", font_size: 10, title_size: "", label_size: "", tick_size: "", title_bold: true, label_bold: false, title_align: "center",
  palette: "serpentine", palette_reverse: false,
  bar_width: 0.62, jitter: 0.12, fill: "light", fill_alpha: 0.25, edge_width: "",
  show_points: true, point_shape: "o", marker_size: 5, point_alpha: 0.85, point_edge: "auto", point_edge_width: 0.5,
  line_width: 1.5, axis_width: "", error: "sem", error_dir: "both", cap_size: "", error_width: "",
  line_markers: false, band_alpha: 0.18, trace_alpha: 0.35,
  sig: "stars", show_ns: false, sig_size: "", show_n: false,
  spine_left: true, spine_bottom: true, spine_top: false, spine_right: false,
  offset_axes: 0, trim_axes: false, tick_dir: "out", tick_length: 3.5, minor_ticks: false, cat_ticks: false,
  grid: "none", grid_style: "solid", grid_alpha: 0.15, legend: "best", legend_frame: false, legend_cols: 1,
};
const DEFAULT_STYLE = {
  ...LOOK_DEFAULTS,
  plot_kind: "bar", orientation: "vertical", custom_colors: "", groups: {}, title: "", xlabel: "", ylabel: "", legend_title: "",
  ymin: "", ymax: "", xmin: "", xmax: "", logy: false, logx: false, ytick_step: "", xtick_step: "", y_decimals: "", xrot: 0,
  panel_label: "", ref_lines: "", endpoint_width: "", dpi: 300, transparent: false, custom_rc: "", custom_code: "",
};

const PALETTES = [
  ["serpentine", "Serpentine", ["#2F5D8A", "#D1495B", "#E9A23B", "#00798C", "#6B4E9B", "#7A7A7A"]],
  ["okabe", "Okabe-Ito · colorblind-safe", ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#CC79A7", "#56B4E9"]],
  ["tol", "Tol bright · colorblind-safe", ["#4477AA", "#EE6677", "#228833", "#CCBB44", "#66CCEE", "#AA3377"]],
  ["muted", "Muted", ["#4C72B0", "#DD8452", "#55A868", "#C44E52", "#8172B3", "#937860"]],
  ["pastel", "Pastel", ["#8DA0CB", "#FC8D62", "#66C2A5", "#E78AC3", "#A6D854", "#FFD92F"]],
  ["earth", "Earth", ["#5F7161", "#C9A66B", "#8C5E58", "#A3B18A", "#3A5A40", "#DDB892"]],
  ["ocean", "Ocean", ["#023E8A", "#0096C7", "#48CAE4", "#03045E", "#00B4D8", "#90E0EF"]],
  ["sunset", "Sunset", ["#3D348B", "#F18701", "#7678ED", "#F35B04", "#F7B801", "#9B2226"]],
  ["neon", "Neon", ["#00F5D4", "#F15BB5", "#FEE440", "#00BBF9", "#9B5DE5", "#F72585"]],
  ["grayscale", "Grayscale", ["#1F1F1F", "#8A8A8A", "#C4C4C4", "#525252", "#A8A8A8", "#6E6E6E"]],
];
const COLORMAPS = [
  ["Sequential", ["viridis", "plasma", "inferno", "magma", "cividis", "Blues", "Greens", "Reds", "Purples", "Oranges", "Greys", "YlGnBu", "YlOrRd", "PuBuGn", "RdPu", "BuPu", "copper", "bone"]],
  ["Diverging", ["coolwarm", "RdBu", "RdYlBu", "PiYG", "PRGn", "BrBG", "PuOr", "Spectral", "seismic"]],
  ["Qualitative", ["tab10", "tab20", "Set1", "Set2", "Set3", "Dark2", "Paired", "Accent", "Pastel1", "Pastel2"]],
  ["Cyclic & other", ["twilight", "hsv", "turbo", "rainbow", "terrain", "ocean", "gist_earth", "cubehelix", "spring", "summer", "autumn", "winter", "cool", "hot"]],
];
const FONT_OPTIONS = [
  ["Built in", [["sans", "Sans-serif (Arial / Helvetica style)"], ["serif", "Serif (Times style)"], ["mono", "Monospace"]]],
  ["Web fonts, exact in every export", [["lato", "Lato"], ["fira", "Fira Sans"], ["barlow", "Barlow"], ["poppins", "Poppins"], ["ptserif", "PT Serif"], ["crimson", "Crimson Text"], ["courier", "Courier Prime"], ["spacemono", "Space Mono"], ["comic", "Comic Neue"]]],
];
const MARKERS = [["", "Default"], ["o", "● Circle"], ["s", "■ Square"], ["^", "▲ Triangle"], ["v", "▼ Down triangle"], ["D", "◆ Diamond"], ["d", "♦ Thin diamond"], ["p", "⬟ Pentagon"], ["h", "⬢ Hexagon"], ["*", "★ Star"], ["X", "✖ Cross"], ["P", "✚ Plus"], ["<", "◀ Left"], [">", "▶ Right"]];
const HATCHES = [["", "No pattern"], ["/", "Diagonal ／"], ["\\", "Diagonal ＼"], ["//", "Dense ／"], ["x", "Crosshatch"], ["xx", "Dense crosshatch"], ["+", "Grid"], ["-", "Horizontal lines"], ["|", "Vertical lines"], [".", "Dots"], ["o", "Circles"], ["*", "Stars"]];
const LINESTYLES = [["", "Solid line"], ["--", "Dashed"], [":", "Dotted"], ["-.", "Dash-dot"]];
const PLOT_KINDS = [["bar", "Bar"], ["dot", "Scatter dot"], ["mean", "Mean ± error"], ["box", "Box"], ["violin", "Violin"], ["boxviolin", "Box + violin"], ["raincloud", "Raincloud"], ["beeswarm", "Beeswarm"], ["strip", "Strip"], ["lollipop", "Lollipop"]];

const PRESETS = [
  { name: "Clean", desc: "Balanced default", v: {} },
  { name: "Journal", desc: "1 column, 89 mm", v: { width: 3.5, height: 2.8, font_size: 8, line_width: 1, marker_size: 3.5, palette: "okabe" } },
  { name: "Classic", desc: "Bold black axes", v: { width: 3.6, height: 3.6, font_size: 11, line_width: 2, axis_width: 1.8, tick_length: 6, marker_size: 5.5, palette: "grayscale", fill: "outline", label_bold: true } },
  { name: "Minimal", desc: "Floating axes", v: { font: "fira", palette: "tol", fill: "outline", offset_axes: 8, trim_axes: true, line_width: 1.2, point_edge: "none" } },
  { name: "Editorial", desc: "Serif, left title", v: { font: "crimson", font_size: 11, palette: "earth", fill: "solid", title_align: "left", spine_left: false, grid: "y", grid_style: "dotted", grid_alpha: 0.4, tick_length: 0 } },
  { name: "Boxed", desc: "Full frame, ticks in", v: { font: "ptserif", palette: "muted", spine_top: true, spine_right: true, tick_dir: "in", minor_ticks: true, fill: "light", fill_alpha: 0.35 } },
  { name: "Typewriter", desc: "Mono, grayscale", v: { font: "courier", palette: "grayscale", fill: "outline", line_width: 1.3, point_edge: "ink", point_alpha: 1 } },
  { name: "Soft", desc: "Pastel with grid", v: { width: 4.2, palette: "pastel", fill: "solid", grid: "both", line_width: 1.3, font: "lato" } },
  { name: "Poster", desc: "Large type", v: { width: 6.5, height: 5, font_size: 18, line_width: 2.6, marker_size: 8, palette: "tol", fill: "solid", font: "poppins" } },
  { name: "Slides", desc: "Dark background", v: { width: 6.4, height: 4.2, font_size: 14, line_width: 2, marker_size: 6.5, palette: "tol", theme: "dark", font: "barlow" } },
  { name: "Neon", desc: "Glow on black", v: { theme: "dark", bg_color: "#0B0B12", palette: "neon", fill: "light", fill_alpha: 0.12, line_width: 2, font: "spacemono", point_edge: "none" } },
  { name: "Sketch", desc: "Playful", v: { font: "comic", font_size: 11, palette: "sunset", fill: "light", fill_alpha: 0.35, line_width: 2.2, marker_size: 6, cap_size: 0 } },
];

const CODE_EXAMPLES = [
  ["Custom ticks", "ax.set_yticks([0, 250, 500, 750, 1000])"],
  ["Shade a range", "ax.axhspan(300, 450, color='0.92', zorder=0)"],
  ["Add a note", "ax.text(0.98, 0.95, 'n = 8 mice per group', transform=ax.transAxes, ha='right', fontsize=8)"],
  ["Italic labels", "for t in ax.get_xticklabels():\n    t.set_fontstyle('italic')"],
  ["Arrow", "ax.annotate('peak', xy=(0, 800), xytext=(0.6, 950), arrowprops=dict(arrowstyle='->'))"],
  ["Broken look", "ax.spines['left'].set_linestyle((0, (4, 2)))"],
];

const ANALYSES = [
  { id: "compare", title: "Compare groups", desc: "Control vs treatment, several doses, before vs after. t-tests, ANOVA, non-parametric tests and post-hoc comparisons.",
    icon: '<svg viewBox="0 0 52 40" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 37h45"/><rect x="8" y="14" width="9" height="23" rx="1" fill="currentColor" fill-opacity=".18"/><rect x="22" y="20" width="9" height="17" rx="1" fill="currentColor" fill-opacity=".18"/><rect x="36" y="27" width="9" height="10" rx="1" fill="currentColor" fill-opacity=".18"/><path d="M12.5 7v-3h28v3" stroke-width="1.6"/></svg>' },
  { id: "timecourse", title: "Time course around an event", desc: "Recordings aligned to an injection or stimulus. Binning, baseline normalization, exclusions, endpoint statistics.",
    icon: '<svg viewBox="0 0 52 40" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 37h45"/><path d="M20 4v33" stroke-dasharray="3 3" stroke-width="1.5"/><path d="M4 12l4 1 4-1 4 1 4-1c4 0 5 14 11 17s8 2 12 2 5-1 5-1" stroke-linejoin="round"/></svg>' },
  { id: "correlation", title: "Correlation & regression", desc: "Does one measurement track another? Pearson or Spearman, linear fit and confidence band, by group.",
    icon: '<svg viewBox="0 0 52 40" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 37h45M4 37V3"/><path d="M8 32L46 8" stroke-width="1.6"/><g fill="currentColor" stroke="none"><circle cx="12" cy="27" r="2.4"/><circle cx="19" cy="26" r="2.4"/><circle cx="24" cy="19" r="2.4"/><circle cx="31" cy="20" r="2.4"/><circle cx="37" cy="12" r="2.4"/><circle cx="43" cy="13" r="2.4"/></g></svg>' },
  { id: "dose", title: "Dose-response curve", desc: "Concentration series fitted with a 4-parameter logistic model. EC50 or IC50 with confidence intervals.",
    icon: '<svg viewBox="0 0 52 40" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 37h45M4 37V3"/><path d="M6 8c10 0 13 1 18 12s9 12 22 12" stroke-linejoin="round"/><path d="M24 20v17" stroke-dasharray="2.5 2.5" stroke-width="1.4"/></svg>' },
];

function freshState() {
  return {
    app: "Serpentine",
    version: 2,
    name: "Untitled analysis",
    analysis: "compare",
    step: "analysis",
    rtab: "tables",
    example: null,
    datasets: [],
    active: null,
    settings: clone(DEFAULT_SETTINGS),
    style: clone(DEFAULT_STYLE),
  };
}

let state = freshState();
const inspected = {}; // dataset id -> inspect result {columns, preview, n_rows, separator} | {error}
let lastResult = null;
let engineSource = null;
const openSections = store(SECTIONS_KEY) || {};

// ============================================================================
// Python engine (web worker)
// ============================================================================
const servedFromDisk = location.protocol === "file:";
const worker = servedFromDisk ? null : new Worker("worker.js");
let engineReady = false;
let reqId = 0;
const pending = new Map();
let queuedExample = null;

if (worker) {
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "status") {
      if (!engineReady) {
        setStatus("loading", m.text);
        $("#loading-text").textContent = m.text;
      } else if (!running) {
        setStatus(m.text === "Ready" ? "ready" : "loading", m.text === "Ready" ? "Python ready" : m.text);
      }
    } else if (m.type === "ready") {
      engineReady = true;
      setStatus("ready", "Python ready");
      $("#loading").hidden = true;
      onEngineReady();
    } else if (m.type === "failed") {
      setStatus("failed", "Python didn't load");
      $("#loading-text").textContent = "The Python engine couldn't load: " + m.text + ". Check your internet connection and reload the page.";
      $(".spinner").hidden = true;
    } else if (m.type === "result") {
      const resolve = pending.get(m.id);
      pending.delete(m.id);
      if (resolve) resolve(m.out);
    }
  };
}

function call(cmd, args) {
  if (!worker) return Promise.resolve({ error: "The Python engine isn't running." });
  return new Promise((resolve) => {
    const id = ++reqId;
    pending.set(id, resolve);
    worker.postMessage({ id, cmd, args });
  });
}

function setStatus(kind, text) {
  const el = $("#engine-status");
  el.className = "status status-" + kind;
  $(".status-text", el).textContent = text;
}

async function onEngineReady() {
  if (queuedExample) {
    const k = queuedExample;
    queuedExample = null;
    await loadExample(k);
    return;
  }
  await Promise.all(state.datasets.map((d) => inspectNow(d.id)));
  renderPanels();
  runNow();
}

// ---------- Inspect (parse preview) ----------
const inspectTimers = {};
function scheduleInspect(id, delay = 350) {
  clearTimeout(inspectTimers[id]);
  inspectTimers[id] = setTimeout(async () => {
    const before = JSON.stringify(inspected[id]?.columns || null);
    await inspectNow(id);
    renderDataPreview();
    if (JSON.stringify(inspected[id]?.columns || null) !== before) {
      if (state.step === "settings") renderSettings();
      if (state.step === "data") renderData();
    }
    scheduleRun(50);
  }, delay);
}

async function inspectNow(id) {
  const d = state.datasets.find((x) => x.id === id);
  if (!d || !engineReady) return;
  if (!d.text.trim()) {
    inspected[id] = null;
    return;
  }
  const out = await call("inspect", { text: d.text });
  inspected[id] = out.ok || { error: out.error };
}

// ---------- Run ----------
let runTimer = null;
let running = false;
let rerun = false;

function scheduleRun(delay = 320) {
  clearTimeout(runTimer);
  runTimer = setTimeout(runNow, delay);
}

function runArgs() {
  return {
    config: { analysis: state.analysis, settings: state.settings[state.analysis], style: state.style },
    datasets: state.datasets.map((d) => ({ id: d.id, name: d.name, text: d.text, meta: d.meta })),
  };
}

async function runNow() {
  if (!engineReady) return;
  if (running) {
    rerun = true;
    return;
  }
  if (!state.datasets.some((d) => d.text.trim())) {
    renderEmptyStage();
    return;
  }
  running = true;
  $(".stage").classList.add("busy");
  setStatus("running", "Analyzing");
  const out = await call("run", runArgs());
  running = false;
  $(".stage").classList.remove("busy");
  setStatus("ready", "Python ready");
  renderResults(out);
  if (rerun) {
    rerun = false;
    runNow();
  }
}

// ============================================================================
// Persistence and history
// ============================================================================
let saveTimer = null;
let autosaveWarned = false;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!store(STORE_KEY, state) && !autosaveWarned) {
      autosaveWarned = true;
      toast("This project is too big to keep in the browser. Use Save to keep a copy.");
    }
  }, 600);
}

function restore() {
  return adopt(store(STORE_KEY));
}

function adopt(obj) {
  if (!obj || !APP_NAMES.includes(obj.app) || !Array.isArray(obj.datasets)) return false;
  const base = freshState();
  const style = { ...DEFAULT_STYLE, ...(obj.style || {}) };
  // Projects from v0.1 used one "despine" switch and a true/false grid.
  if (obj.style && "despine" in obj.style && !("spine_top" in obj.style)) {
    style.spine_top = style.spine_right = !obj.style.despine;
  }
  if (typeof style.grid === "boolean") style.grid = style.grid ? "both" : "none";
  if (style.palette === "lablens") style.palette = "serpentine";
  delete style.despine;
  if (!style.groups || typeof style.groups !== "object") style.groups = {};
  state = {
    ...base,
    ...obj,
    app: "Serpentine",
    version: 2,
    settings: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, { ...DEFAULT_SETTINGS[k], ...(obj.settings?.[k] || {}) }])),
    style,
  };
  state.datasets = state.datasets.map((d) => ({ id: d.id || uid(), name: d.name || "Table", text: d.text || "", meta: { group: "", subject: "", event: "", exclude: "", ...(d.meta || {}) } }));
  if (!state.datasets.some((d) => d.id === state.active)) state.active = state.datasets[0]?.id || null;
  return true;
}

// Undo history covers analysis choices, settings and style (not the data tables).
const history = { past: [], future: [], timer: null, last: null };
function snapshot() {
  return JSON.stringify({ analysis: state.analysis, settings: state.settings, style: state.style });
}
function recordHistory() {
  clearTimeout(history.timer);
  history.timer = setTimeout(() => {
    const now = snapshot();
    if (history.last !== null && now !== history.last) {
      history.past.push(history.last);
      if (history.past.length > 200) history.past.shift();
      history.future = [];
    }
    history.last = now;
    renderUndo();
  }, 450);
}
function applySnapshot(json) {
  const s = JSON.parse(json);
  state.analysis = s.analysis;
  state.settings = s.settings;
  state.style = s.style;
  history.last = json;
  renderPanels();
  renderUndo();
  autosave();
  scheduleRun(10);
}
function undo() {
  clearTimeout(history.timer);
  const now = snapshot();
  if (history.last !== null && now !== history.last) history.past.push(history.last);
  if (!history.past.length) return;
  history.future.push(now);
  applySnapshot(history.past.pop());
}
function redo() {
  if (!history.future.length) return;
  history.past.push(snapshot());
  applySnapshot(history.future.pop());
}
function renderUndo() {
  $("#btn-undo").disabled = !history.past.length && snapshot() === history.last;
  $("#btn-redo").disabled = !history.future.length;
}

function changed({ run = true, clearExample = false, delay } = {}) {
  if (clearExample && state.example) {
    state.example = null;
    $("#example-badge").hidden = true;
  }
  autosave();
  recordHistory();
  if (run) scheduleRun(delay);
}

// ============================================================================
// Datasets
// ============================================================================
function newDataset(name, text = "", meta = {}) {
  const d = { id: uid(), name, text, meta: { group: "", subject: "", event: "", exclude: "", ...meta } };
  state.datasets.push(d);
  state.active = d.id;
  return d;
}

function activeDataset() {
  return state.datasets.find((d) => d.id === state.active) || state.datasets[0] || null;
}

function nextName() {
  const base = state.analysis === "timecourse" ? "Session" : "Table";
  let n = state.datasets.length + 1;
  while (state.datasets.some((d) => d.name === base + " " + n)) n++;
  return base + " " + n;
}

async function addFiles(files) {
  for (const f of files) {
    const stem = f.name.replace(/\.[^.]+$/, "");
    if (/\.xlsx?$/i.test(f.name)) {
      if (!engineReady) {
        toast("Wait for Python to finish loading, then try again.");
        return;
      }
      toast("Reading " + f.name);
      const out = await call("excel", { b64: bufToB64(await f.arrayBuffer()) });
      if (out.error) {
        toast(out.error);
        continue;
      }
      for (const sh of out.ok) newDataset(out.ok.length > 1 ? stem + " · " + sh.name : stem, sh.text);
    } else {
      newDataset(stem, await f.text());
    }
  }
  state.datasets.forEach((d) => { if (!inspected[d.id]) scheduleInspect(d.id, 10); });
  renderData();
  changed({ clearExample: true });
}

async function loadExample(kind) {
  if (!engineReady) {
    queuedExample = kind;
    state.analysis = kind;
    renderPanels();
    toast("The example will open when Python is ready.");
    return;
  }
  const out = await call("example", { kind });
  if (out.error) return toast(out.error);
  const ex = out.ok;
  state.analysis = kind;
  state.datasets = [];
  ex.datasets.forEach((d) => newDataset(d.name, d.text, d.meta));
  state.active = state.datasets[0]?.id;
  state.settings[kind] = { ...DEFAULT_SETTINGS[kind], ...ex.settings };
  state.style.groups = {};
  state.example = kind;
  state.name = "Example · " + ANALYSES.find((a) => a.id === kind).title;
  $("#example-badge").hidden = false;
  await Promise.all(state.datasets.map((d) => inspectNow(d.id)));
  renderAll();
  changed({ run: false });
  runNow();
}

// ============================================================================
// Form builder
// ============================================================================
const sec = (title, x = {}) => ({ type: "section", title, ...x });
const note = (text) => ({ type: "note", text });
const row = (...fields) => ({ type: "row", fields: fields.filter(Boolean) });
const sel = (key, label, options, x = {}) => ({ type: "select", key, label, options, ...x });
const seg = (key, label, options, x = {}) => ({ type: "seg", key, label, options, ...x });
const tog = (key, label, hint) => ({ type: "toggle", key, label, hint });
const num = (key, label, x = {}) => ({ type: "number", key, label, ...x });
const txt = (key, label, x = {}) => ({ type: "text", key, label, ...x });
const area = (key, label, x = {}) => ({ type: "area", key, label, ...x });
const color = (key, label, x = {}) => ({ type: "color", key, label, ...x });
const col = (key, label, names, x = {}) => ({ type: "select", key, label, options: [["", x.none ? "None" : (x.auto || "Auto")]].concat(names.map((n) => [n, n])), ...x });
const cols = (key, label, names, hint) => ({ type: "checks", key, label, names, hint });

function optionsHTML(options, v) {
  const flat = [];
  const html = options.map((o) => {
    if (Array.isArray(o[1]) && Array.isArray(o[1][0])) {
      o[1].forEach((x) => flat.push(x));
      return `<optgroup label="${esc(o[0])}">${o[1].map(([val, lab]) => `<option value="${esc(val)}"${String(v ?? "") === String(val) ? " selected" : ""}>${esc(lab)}</option>`).join("")}</optgroup>`;
    }
    flat.push(o);
    return `<option value="${esc(o[0])}"${String(v ?? "") === String(o[0]) ? " selected" : ""}>${esc(o[1])}</option>`;
  }).join("");
  const known = flat.some(([val]) => String(val) === String(v ?? ""));
  return html + (v && !known ? `<option value="${esc(v)}" selected>${esc(v)} (not found)</option>` : "");
}

function fieldHTML(f, obj, scope) {
  if (!f) return "";
  const id = `f-${scope}-${f.key}`;
  const hint = f.hint ? `<span class="hint">${esc(f.hint)}</span>` : "";
  const v = obj[f.key];
  switch (f.type) {
    case "note":
      return `<span class="hint">${esc(f.text)}</span>`;
    case "row":
      return `<div class="row${f.fields.length === 3 ? " row-3" : ""}${f.fields.length === 4 ? " row-4" : ""}">${f.fields.map((x) => fieldHTML(x, obj, scope)).join("")}</div>`;
    case "select":
      return `<div class="field"><label for="${id}">${esc(f.label)}</label><select id="${id}" data-key="${f.key}" data-kind="select">${optionsHTML(f.options, v)}</select>${hint}</div>`;
    case "seg":
      return `<div class="field"><span class="field-label">${esc(f.label)}</span><div class="segmented" role="group" aria-label="${esc(f.label)}">${f.options
        .map(([val, lab]) => `<button type="button" id="${id}-${esc(val)}" data-key="${f.key}" data-kind="seg" data-value="${esc(val)}" aria-pressed="${String(v) === String(val)}">${esc(lab)}</button>`)
        .join("")}</div>${hint}</div>`;
    case "chips":
      return `<div class="field"><span class="field-label">${esc(f.label)}</span><div class="chips" role="group" aria-label="${esc(f.label)}">${f.options
        .map(([val, lab]) => `<button type="button" id="${id}-${esc(val)}" data-key="${f.key}" data-kind="seg" data-value="${esc(val)}" aria-pressed="${String(v) === String(val)}">${esc(lab)}</button>`)
        .join("")}</div>${hint}</div>`;
    case "toggle":
      return `<div class="field"><label class="toggle" for="${id}"><span>${esc(f.label)}</span><input type="checkbox" role="switch" id="${id}" data-key="${f.key}" data-kind="toggle"${v ? " checked" : ""}></label>${hint}</div>`;
    case "number":
      return `<div class="field"><label for="${id}">${esc(f.label)}</label><input type="number" step="any" id="${id}" data-key="${f.key}" data-kind="number" value="${esc(v ?? "")}" placeholder="${esc(f.placeholder || "auto")}">${hint}</div>`;
    case "text":
      return `<div class="field"><label for="${id}">${esc(f.label)}</label><input type="text" id="${id}" data-key="${f.key}" data-kind="text" value="${esc(v ?? "")}" placeholder="${esc(f.placeholder || "")}" spellcheck="false">${hint}</div>`;
    case "area":
      return `<div class="field"><label for="${id}">${esc(f.label)}</label><textarea id="${id}" class="code" rows="${f.rows || 4}" data-key="${f.key}" data-kind="text" placeholder="${esc(f.placeholder || "")}" spellcheck="false">${esc(v ?? "")}</textarea>${hint}</div>`;
    case "color": {
      const shown = /^#[0-9a-f]{6}$/i.test(v || "") ? v : (f.auto || "#ffffff");
      return `<div class="field"><span class="field-label">${esc(f.label)}</span><div class="color-field">
        <input type="color" id="${id}" data-key="${f.key}" data-kind="color" value="${esc(shown)}" aria-label="${esc(f.label)}">
        <span class="color-val">${v ? esc(v) : "Automatic"}</span>
        ${v ? `<button type="button" class="btn btn-small" data-clear="${f.key}">Reset</button>` : ""}</div>${hint}</div>`;
    }
    case "checks": {
      const chosen = new Set(v || []);
      const items = f.names.length
        ? f.names.map((n, i) => `<label><input type="checkbox" id="${id}-${i}" data-key="${f.key}" data-kind="check" value="${esc(n)}"${chosen.has(n) ? " checked" : ""}>${esc(n)}</label>`).join("")
        : `<span class="hint">Columns appear here once data is added.</span>`;
      return `<div class="field"><span class="field-label">${esc(f.label)}</span><div class="checks">${items}</div>${hint}</div>`;
    }
    case "presets": {
      const mine = store(STYLES_KEY) || [];
      return `<div class="presets">${PRESETS.map((p, i) => `<button type="button" class="preset" data-preset="${i}"><b>${esc(p.name)}</b><small>${esc(p.desc)}</small></button>`).join("")}</div>
        ${mine.length ? `<span class="field-label">My styles</span><div class="presets">${mine.map((p, i) => `<div class="preset mine"><button type="button" data-mystyle="${i}"><b>${esc(p.name)}</b><small>Saved style</small></button><button type="button" class="x" data-delstyle="${i}" aria-label="Delete ${esc(p.name)}">×</button></div>`).join("")}</div>` : ""}
        <div class="save-style"><input type="text" id="mystyle-name" placeholder="Name this look, e.g. Lab house style" spellcheck="false"><button type="button" class="btn btn-small" id="btn-save-style">Save style</button></div>
        <div class="btn-row"><button type="button" class="btn btn-small" id="btn-export-style">Export style file</button><button type="button" class="btn btn-small" id="btn-import-style">Import style file</button><button type="button" class="btn btn-small btn-danger" id="btn-reset-style">Reset all styling</button><input type="file" id="import-style" accept=".json" hidden></div>
        <span class="hint">A style file carries every look setting, so a whole lab can share one house style.</span>`;
    }
    case "palettes":
      return `<div class="palettes" role="group" aria-label="Color palette">${PALETTES.map(
        ([key, name, colors]) => `<button type="button" class="palette" data-key="palette" data-kind="seg" data-value="${key}" aria-pressed="${obj.palette === key}"><span class="swatches">${colors.map((c) => `<i style="background:${c}"></i>`).join("")}</span><span>${esc(name)}</span></button>`
      ).join("")}</div>
      <div class="field"><label for="f-${scope}-cmap">Or any matplotlib colormap</label><select id="f-${scope}-cmap" data-kind="cmap"><option value="">None selected</option>${COLORMAPS.map(([grp, list]) => `<optgroup label="${esc(grp)}">${list.map((m) => `<option value="cmap:${m}"${obj.palette === "cmap:" + m ? " selected" : ""}>${m}</option>`).join("")}</optgroup>`).join("")}</select></div>`;
    case "groups": {
      const gs = lastResult?.group_styles || [];
      if (!gs.length) return `<span class="hint">Your groups appear here after the first figure is drawn.</span>`;
      const groups = obj.groups || {};
      return `<div class="groups">${gs.map((g, i) => {
        const cur = groups[g.name] || {};
        const gid = `g-${scope}-${i}`;
        return `<div class="group-row">
          <input type="color" id="${gid}-color" data-group="${esc(g.name)}" data-gkey="color" value="${esc(cur.color || g.color)}" aria-label="Color for ${esc(g.name)}">
          <div class="group-main">
            <input type="text" id="${gid}-label" data-group="${esc(g.name)}" data-gkey="label" value="${esc(cur.label || "")}" placeholder="${esc(g.name)}" aria-label="Display name for ${esc(g.name)}" spellcheck="false">
            <div class="group-opts">
              <select id="${gid}-marker" data-group="${esc(g.name)}" data-gkey="marker" aria-label="Marker">${optionsHTML(MARKERS, cur.marker || "")}</select>
              <select id="${gid}-hatch" data-group="${esc(g.name)}" data-gkey="hatch" aria-label="Fill pattern">${optionsHTML(HATCHES, cur.hatch || "")}</select>
              <select id="${gid}-linestyle" data-group="${esc(g.name)}" data-gkey="linestyle" aria-label="Line style">${optionsHTML(LINESTYLES, cur.linestyle || "")}</select>
            </div>
          </div>
          ${Object.keys(cur).length ? `<button type="button" class="btn btn-small" data-group-reset="${esc(g.name)}" title="Back to automatic">Reset</button>` : ""}
        </div>`;
      }).join("")}</div>`;
    }
    case "examples":
      return `<div class="btn-row">${CODE_EXAMPLES.map(([lab], i) => `<button type="button" class="btn btn-small" data-code-example="${i}">${esc(lab)}</button>`).join("")}</div>`;
    default:
      return "";
  }
}

// Fields are grouped into collapsible sections; open/closed state is remembered per browser.
function renderForm(panel, fields, obj, scope, intro = "", defaultOpen = () => true) {
  const focusId = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.id : null;
  const selStart = focusId && document.activeElement.selectionStart;
  const scrollTop = panel.scrollTop;
  let html = intro;
  let current = null;
  const close = () => (current ? "</div></details>" : "");
  for (const f of fields.filter(Boolean)) {
    if (f.type === "section") {
      html += close();
      const key = scope + ":" + f.title;
      const open = key in openSections ? openSections[key] : defaultOpen(f.title);
      html += `<details class="section" data-sec="${esc(key)}"${open ? " open" : ""}><summary class="section-title">${esc(f.title)}</summary><div class="section-body">`;
      current = f.title;
    } else {
      html += fieldHTML(f, obj, scope);
    }
  }
  html += close();
  panel.innerHTML = html;
  panel.scrollTop = scrollTop;
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      try { if (selStart != null && el.setSelectionRange) el.setSelectionRange(selStart, selStart); } catch (e) { /* not a text field */ }
    }
  }
}

function bindForm(panel, getObj, rerender) {
  panel.addEventListener("toggle", (e) => {
    const d = e.target;
    if (d.matches && d.matches("details[data-sec]")) {
      openSections[d.dataset.sec] = d.open;
      store(SECTIONS_KEY, openSections);
    }
  }, true);
  panel.addEventListener("input", (e) => {
    const el = e.target;
    const obj = getObj();
    if (el.dataset.gkey && (el.dataset.gkey === "label" || el.dataset.gkey === "color")) {
      setGroup(el.dataset.group, el.dataset.gkey, el.value);
      return changed();
    }
    if (!el.dataset.key) return;
    if (el.dataset.kind === "number" || el.dataset.kind === "text") {
      obj[el.dataset.key] = el.value;
      changed({ delay: el.dataset.key === "custom_code" || el.dataset.key === "custom_rc" ? 900 : undefined });
    } else if (el.dataset.kind === "color") {
      obj[el.dataset.key] = el.value;
      const label = el.parentElement.querySelector(".color-val");
      if (label) label.textContent = el.value;
      changed();
    }
  });
  panel.addEventListener("change", (e) => {
    const el = e.target;
    const obj = getObj();
    if (el.dataset.gkey && el.tagName === "SELECT") {
      setGroup(el.dataset.group, el.dataset.gkey, el.value);
      rerender();
      return changed();
    }
    if (el.dataset.gkey === "color" || el.dataset.kind === "color") return rerender();
    if (el.dataset.kind === "cmap") {
      if (el.value) obj.palette = el.value;
      rerender();
      return changed();
    }
    if (!el.dataset.key) return;
    const k = el.dataset.key;
    if (el.dataset.kind === "select") obj[k] = el.value;
    else if (el.dataset.kind === "toggle") obj[k] = el.checked;
    else if (el.dataset.kind === "check") obj[k] = $$(`input[data-key="${k}"]:checked`, panel).map((x) => x.value);
    else return;
    rerender();
    changed();
  });
  panel.addEventListener("click", (e) => {
    const t = e.target;
    const b = t.closest("[data-kind='seg']");
    if (b) {
      getObj()[b.dataset.key] = b.dataset.value;
      rerender();
      return changed();
    }
    const clr = t.closest("[data-clear]");
    if (clr) {
      getObj()[clr.dataset.clear] = "";
      rerender();
      return changed();
    }
    const gr = t.closest("[data-group-reset]");
    if (gr) {
      delete state.style.groups[gr.dataset.groupReset];
      rerender();
      return changed();
    }
    const p = t.closest("[data-preset]");
    if (p) return applyLook(PRESETS[+p.dataset.preset].v, PRESETS[+p.dataset.preset].name);
    const ms = t.closest("[data-mystyle]");
    if (ms) {
      const mine = store(STYLES_KEY) || [];
      const item = mine[+ms.dataset.mystyle];
      if (item) applyLook(item.v, item.name, true);
      return;
    }
    const ds = t.closest("[data-delstyle]");
    if (ds) {
      const mine = store(STYLES_KEY) || [];
      mine.splice(+ds.dataset.delstyle, 1);
      store(STYLES_KEY, mine);
      return rerender();
    }
    if (t.closest("#btn-save-style")) return saveMyStyle();
    if (t.closest("#btn-export-style")) return download(slug(state.name) + "-style.json", JSON.stringify({ app: "Serpentine", kind: "style", style: lookOf(state.style) }, null, 1), "application/json");
    if (t.closest("#btn-import-style")) return $("#import-style").click();
    if (t.closest("#btn-reset-style")) {
      return armConfirm(t.closest("#btn-reset-style"), "Click again to reset", () => {
        state.style = { ...clone(DEFAULT_STYLE), plot_kind: state.style.plot_kind, orientation: state.style.orientation };
        rerender();
        changed();
        toast("All styling reset");
      });
    }
    const ce = t.closest("[data-code-example]");
    if (ce) {
      const snippet = CODE_EXAMPLES[+ce.dataset.codeExample][1];
      state.style.custom_code = (state.style.custom_code ? state.style.custom_code.replace(/\s*$/, "\n") : "") + snippet + "\n";
      rerender();
      return changed();
    }
  });
  panel.addEventListener("change", async (e) => {
    if (e.target.id !== "import-style" || !e.target.files.length) return;
    const f = e.target.files[0];
    e.target.value = "";
    try {
      const obj = JSON.parse(await f.text());
      if (!APP_NAMES.includes(obj.app) || obj.kind !== "style" || typeof obj.style !== "object") throw new Error();
      applyLook(obj.style, f.name.replace(/\.json$/, ""), true);
    } catch (err) {
      toast("That file isn't a Serpentine style file.");
    }
  });
}

function setGroup(name, key, value) {
  const groups = state.style.groups || (state.style.groups = {});
  const g = { ...(groups[name] || {}) };
  if (value) g[key] = value;
  else delete g[key];
  if (Object.keys(g).length) groups[name] = g;
  else delete groups[name];
}

const LOOK_KEYS = Object.keys(LOOK_DEFAULTS).concat(["custom_colors", "custom_rc"]);
function lookOf(style) {
  return Object.fromEntries(LOOK_KEYS.map((k) => [k, style[k]]));
}
function applyLook(v, name, exact = false) {
  Object.assign(state.style, exact ? {} : clone(LOOK_DEFAULTS), v);
  renderStyle();
  changed();
  toast(name + " style applied");
}
function saveMyStyle() {
  const input = $("#mystyle-name");
  const name = (input?.value || "").trim();
  if (!name) {
    input?.focus();
    return toast("Give the style a name first.");
  }
  const mine = (store(STYLES_KEY) || []).filter((s) => s.name !== name);
  mine.push({ name, v: lookOf(state.style) });
  if (!store(STYLES_KEY, mine)) return toast("Couldn't save in this browser. Use Export style file instead.");
  renderStyle();
  toast("Saved “" + name + "”");
}

// ============================================================================
// Column context
// ============================================================================
function columnsFor(dsId) {
  const d = state.datasets.find((x) => x.id === dsId) || state.datasets[0];
  const info = d && inspected[d.id];
  const list = info && info.columns ? info.columns : [];
  return {
    all: list.map((c) => c.name),
    numeric: list.filter((c) => c.kind !== "text").map((c) => c.name),
    time: list.filter((c) => c.kind === "time").map((c) => c.name),
    text: list.filter((c) => c.kind === "text").map((c) => c.name),
    kind: Object.fromEntries(list.map((c) => [c.name, c.kind])),
  };
}

function datasetField() {
  if (state.datasets.length < 2) return null;
  return sel("dataset", "Data table", [["", "First table"]].concat(state.datasets.map((d) => [d.id, d.name])));
}

const TEST_OPTIONS = [["auto", "Automatic (checks normality)"], ["param", "Parametric (t-test / ANOVA)"], ["nonparam", "Non-parametric (rank-based)"]];
const POSTHOC_OPTIONS = [["all", "Compare every pair of groups"], ["control", "Compare each group with the first"]];

const SETTINGS_SCHEMA = {
  compare: (s) => {
    const c = columnsFor(s.dataset);
    return [
      sec("Data"),
      datasetField(),
      seg("layout", "Table layout", [["wide", "One column per group"], ["long", "Values + group column"]]),
      s.layout !== "long" && cols("columns", "Groups to include", c.numeric, "Leave all unchecked to use every numeric column."),
      s.layout === "long" && row(col("value_col", "Value column", c.numeric), col("group_col", "Group column", c.all)),
      txt("group_order", "Group order", { placeholder: "e.g. Control, Low, High", hint: "Optional. Groups you leave out keep their table order." }),
      txt("y_name", "Measurement name", { placeholder: "e.g. Tumor volume (mm³)", hint: "Becomes the value-axis label." }),
      sec("Statistics"),
      s.layout !== "long" && tog("paired", "Paired / repeated measures", "Each row is one subject measured in every group."),
      sel("test", "Test", TEST_OPTIONS),
      !(s.paired && s.layout !== "long") && s.test !== "nonparam" && tog("equal_var", "Assume equal variances", "Off applies Welch's correction (recommended)."),
      sel("posthoc", "Multiple comparisons", POSTHOC_OPTIONS, { hint: "Used when there are 3 or more groups." }),
    ];
  },
  timecourse: (s) => {
    const c = columnsFor(null);
    const timeKind = c.kind[s.time_col || c.time[0] || c.numeric[0]];
    return [
      sec("Columns"),
      row(col("time_col", "Time column", c.numeric), col("value_col", "Measurement", c.numeric)),
      timeKind !== "time" && sel("time_unit", "Time column is in", [["seconds", "Seconds"], ["minutes", "Minutes"], ["hours", "Hours"]], { hint: "Clock times like 13:27 are read automatically." }),
      sec("Clean the data"),
      row(num("valid_min", "Ignore values below"), num("valid_max", "Ignore values above")),
      col("filter_col", "Quality column", c.numeric, { none: true, hint: "Optional. Keep only rows where this column is in range, e.g. cycle count of at least 10." }),
      s.filter_col && row(num("filter_min", "Keep if at least"), num("filter_max", "Keep if at most")),
      note("Time ranges to exclude (a loose wire, movement) are set per session in the Data step."),
      sec("Align to the event"),
      row(txt("event_label", "Event name", { placeholder: "Injection" }), num("bin", "Bin size (s)", { hint: "0 = no binning", placeholder: "30" })),
      row(num("baseline_start", "Baseline from (min)"), num("baseline_end", "Baseline to (min)")),
      row(num("window_start", "Show from (min)"), num("window_end", "Show to (min)")),
      sel("norm", "Express values as", [["pct", "% of baseline"], ["delta", "Change from baseline"], ["fold", "Fold of baseline"], ["raw", "Raw values"]]),
      sec("Endpoint"),
      sel("metric", "Summarize each session by", [["mean", "Mean in window"], ["min", "Minimum (nadir)"], ["max", "Maximum (peak)"], ["auc", "Net area under the curve"]]),
      row(num("endpoint_start", "From (min)"), num("endpoint_end", "To (min)")),
      sec("Statistics"),
      tog("pair_subjects", "Pair sessions by subject", "The same animal appears in each group, e.g. saline day and drug day."),
      sel("test", "Test", TEST_OPTIONS),
      !s.pair_subjects && s.test !== "nonparam" && tog("equal_var", "Assume equal variances", "Off applies Welch's correction (recommended)."),
      sel("posthoc", "Multiple comparisons", POSTHOC_OPTIONS),
      txt("group_order", "Group order", { placeholder: "e.g. Saline, Morphine" }),
      sec("Time-course display"),
      row(sel("band", "Spread", [["sem", "Mean ± SEM"], ["sd", "Mean ± SD"], ["none", "None"]]), s.band !== "none" && seg("band_style", "Show as", [["band", "Band"], ["bars", "Error bars"]])),
      tog("show_traces", "Show each session as a thin line"),
      tog("show_event", "Mark the event"),
      tog("shade_baseline", "Shade the baseline window"),
      tog("shade_endpoint", "Shade the endpoint window"),
    ];
  },
  correlation: (s) => {
    const c = columnsFor(s.dataset);
    return [
      sec("Data"),
      datasetField(),
      row(col("x_col", "X column", c.numeric), col("y_col", "Y column", c.numeric)),
      col("group_col", "Color by group", c.all, { none: true }),
      s.group_col && txt("group_order", "Group order"),
      sec("Analysis"),
      seg("method", "Correlation", [["pearson", "Pearson (linear)"], ["spearman", "Spearman (rank)"]]),
      tog("fit", "Draw linear fit"),
      s.fit && tog("ci", "Show 95% confidence band"),
      tog("annotate", "Print r and p on the plot", "Only with a single group."),
    ];
  },
  dose: (s) => {
    const c = columnsFor(s.dataset);
    const xcol = s.x_col || c.numeric[0];
    return [
      sec("Data"),
      datasetField(),
      col("x_col", "Concentration column", c.numeric),
      row(txt("x_unit", "Unit", { placeholder: "e.g. nM" }), num("x_scale", "Multiply by", { placeholder: "1", hint: "Unit conversion" })),
      seg("mode", "Response columns are", [["curves", "Separate curves"], ["replicates", "Replicates of one"]]),
      cols("y_cols", "Response columns", c.numeric.filter((n) => n !== xcol), "Leave all unchecked to use every other numeric column."),
      s.mode === "replicates" && txt("curve_name", "Curve name"),
      sec("Fit"),
      row(num("fix_bottom", "Fix bottom at", { placeholder: "fit" }), num("fix_top", "Fix top at", { placeholder: "fit" })),
      sel("ec_label", "Call the midpoint", [["", "Automatic (EC50 or IC50)"], ["EC50", "EC50"], ["IC50", "IC50"], ["ED50", "ED50"]]),
      tog("show_ec50", "Mark EC50 / IC50 on the curve"),
      tog("all_points", "Show every replicate instead of mean ± error"),
    ];
  },
};

function styleSchema() {
  const s = state.style;
  const a = state.analysis;
  const groupPlot = a === "compare" || a === "timecourse";
  const lines = a === "timecourse" || a === "dose" || a === "correlation";
  const horizontal = groupPlot && s.orientation === "horizontal";
  const mm = (v) => Math.round(parseFloat(v || 0) * 25.4);
  const dark = s.theme === "dark";
  return [
    sec("Quick styles"),
    { type: "presets" },
    groupPlot && sec("Plot type"),
    groupPlot && { type: "chips", key: "plot_kind", label: a === "timecourse" ? "Endpoint plot" : "Plot", options: PLOT_KINDS },
    groupPlot && seg("orientation", "Direction", [["vertical", "Vertical"], ["horizontal", "Horizontal"]]),
    groupPlot && row(num("bar_width", "Bar / box width", { placeholder: "0.62", hint: "0.05 to 1" }), num("jitter", "Point spread", { placeholder: "0.12", hint: "0 = in a line" })),
    groupPlot && seg("fill", "Fill", [["light", "Light"], ["solid", "Solid"], ["outline", "Outline"]]),
    groupPlot && row(s.fill === "light" && num("fill_alpha", "Fill opacity", { placeholder: "0.25" }), num("edge_width", "Outline width", { placeholder: "auto" })),
    sec("Groups"),
    note("Rename any group, or give it its own color, marker, fill pattern and line style."),
    { type: "groups" },
    sec("Colors"),
    { type: "palettes" },
    tog("palette_reverse", "Reverse color order"),
    txt("custom_colors", "Your own colors", { placeholder: "#333333, #D1495B", hint: "Hex codes in group order. They replace palette colors one by one." }),
    seg("theme", "Base", [["light", "Light"], ["dark", "Dark"]]),
    row(color("bg_color", "Figure background", { auto: dark ? "#15181d" : "#ffffff" }), color("axes_color", "Plot area", { auto: dark ? "#15181d" : "#ffffff" })),
    color("ink_color", "Text and axis color", { auto: dark ? "#e6e8ec" : "#1a1d23" }),
    sec("Points and markers"),
    groupPlot && tog("show_points", "Show individual points"),
    sel("point_shape", "Marker", MARKERS.slice(1)),
    row(num("marker_size", "Size", { placeholder: "5" }), num("point_alpha", "Opacity", { placeholder: "0.85", hint: "0 to 1" })),
    row(sel("point_edge", "Outline", [["auto", "Thin, background color"], ["none", "None"], ["dark", "Darker shade"], ["ink", "Text color"], ["#ffffff", "White"], ["#000000", "Black"]]), num("point_edge_width", "Outline width", { placeholder: "0.5" })),
    sec("Lines and error bars"),
    row(num("line_width", "Line width", { placeholder: "1.5" }), num("axis_width", "Axis line width", { placeholder: "auto" })),
    row(sel("error", "Error bars", [["sem", "SEM"], ["sd", "SD"], ["ci95", "95% CI"], ["none", "None"]]), seg("error_dir", "Direction", [["both", "Both"], ["up", "Outward"]])),
    row(num("cap_size", "Cap width", { placeholder: "auto", hint: "0 = no caps" }), num("error_width", "Error bar width", { placeholder: "auto" })),
    lines && tog("line_markers", "Markers on lines"),
    a === "timecourse" && row(num("band_alpha", "Band opacity", { placeholder: "0.18" }), num("trace_alpha", "Session line opacity", { placeholder: "0.35" })),
    a === "correlation" && num("band_alpha", "Confidence band opacity", { placeholder: "0.18" }),
    groupPlot && sec("Significance"),
    groupPlot && sel("sig", "Show results as", [["stars", "Stars (*, **, ***)"], ["p", "Exact p-values"], ["none", "Hide"]]),
    groupPlot && row(tog("show_ns", "Mark non-significant"), num("sig_size", "Text size", { placeholder: "auto" })),
    groupPlot && tog("show_n", "Show n under each group"),
    sec("Text and fonts"),
    sel("font", "Font", FONT_OPTIONS),
    row(num("font_size", "Base size (pt)", { placeholder: "10" }), num("tick_size", "Tick labels", { placeholder: "auto" })),
    txt("title", "Title"),
    seg("title_align", "Title position", [["left", "Left"], ["center", "Center"], ["right", "Right"]]),
    row(num("title_size", "Title size", { placeholder: "auto" }), tog("title_bold", "Bold title")),
    row(txt("xlabel", "X-axis label", { placeholder: "automatic" }), txt("ylabel", "Y-axis label", { placeholder: "automatic" })),
    row(num("label_size", "Axis label size", { placeholder: "auto" }), tog("label_bold", "Bold axis labels")),
    row(num("xrot", "X label angle (°)", { placeholder: "0" }), txt("panel_label", "Panel letter", { placeholder: "e.g. A" })),
    sec("Axes and ticks"),
    { type: "row", fields: [tog("spine_left", "Left"), tog("spine_bottom", "Bottom"), tog("spine_top", "Top"), tog("spine_right", "Right")] },
    note("Which axis lines to draw."),
    row(num("offset_axes", "Offset axes (pt)", { placeholder: "0", hint: "Pulls axis lines away from the data" }), tog("trim_axes", "Trim axes to ticks")),
    seg("tick_dir", "Tick marks", [["out", "Outside"], ["in", "Inside"], ["inout", "Across"]]),
    row(num("tick_length", "Tick length", { placeholder: "3.5" }), tog("minor_ticks", "Minor ticks")),
    groupPlot && tog("cat_ticks", "Tick marks on the group axis"),
    (!groupPlot || !horizontal) && row(num("ymin", "Y min"), num("ymax", "Y max")),
    (!groupPlot || horizontal) && row(num("xmin", "X min"), num("xmax", "X max")),
    groupPlot && horizontal && note("Horizontal plots put values on the x-axis."),
    a === "timecourse" && row(num("ymin", "Y min"), num("ymax", "Y max")),
    row(tog("logy", groupPlot ? "Log scale (values)" : "Log scale Y"), a === "correlation" && tog("logx", "Log scale X")),
    row(num("ytick_step", "Y tick spacing"), num("xtick_step", "X tick spacing")),
    num("y_decimals", "Decimal places on the value axis"),
    sec("Grid and reference lines"),
    seg("grid", "Gridlines", [["none", "None"], ["y", "Horizontal"], ["x", "Vertical"], ["both", "Both"]]),
    s.grid !== "none" && row(sel("grid_style", "Grid line style", [["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"]]), num("grid_alpha", "Grid opacity", { placeholder: "0.15" })),
    txt("ref_lines", "Reference lines", { placeholder: "y=100: Baseline; x=0", hint: "Separate with semicolons. Use y=…, x=… or y=x, with an optional label after a colon." }),
    lines && sec("Legend"),
    lines && sel("legend", "Position", [["best", "Best spot"], ["upper right", "Top right"], ["upper left", "Top left"], ["lower right", "Bottom right"], ["lower left", "Bottom left"], ["center right", "Middle right"], ["outside", "Outside, right"], ["outside top", "Above the plot"], ["none", "Hidden"]]),
    lines && row(num("legend_cols", "Columns", { placeholder: "1" }), tog("legend_frame", "Frame")),
    lines && txt("legend_title", "Legend title"),
    sec("Size and export"),
    row(num("width", "Width (in)", { hint: mm(s.width) + " mm" }), num("height", "Height (in)", { hint: mm(s.height) + " mm" })),
    a === "timecourse" && num("endpoint_width", "Endpoint plot width (in)", { placeholder: "auto" }),
    row(sel("dpi", "PNG / TIFF resolution", [[150, "150 dpi"], [300, "300 dpi"], [600, "600 dpi"], [1200, "1200 dpi"]]), tog("transparent", "Transparent background")),
    sec("Advanced: Python"),
    note("For anything the menus don't cover. This is real matplotlib, running on your computer. Prefer plain English? Type into the command bar above your figure."),
    area("custom_rc", "Matplotlib settings", { rows: 3, placeholder: "lines.solid_capstyle: round\naxes.titlepad: 14", hint: "One rcParams setting per line, as key: value." }),
    area("custom_code", "Your Python code", { rows: 6, placeholder: "# runs after each figure is drawn\n# fig, ax, plt, np and pd are ready to use\nax.set_yticks([0, 50, 100])" }),
    { type: "examples" },
  ];
}

// ============================================================================
// Rendering: panels
// ============================================================================
function renderSteps() {
  $$(".step").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.step === state.step)));
  ["analysis", "data", "settings", "style"].forEach((s) => ($("#panel-" + s).hidden = s !== state.step));
}

function renderAnalysis() {
  $("#panel-analysis").innerHTML = `
    <p class="panel-intro">What do you want to find out? Pick an analysis, then add your data. Try an example to see how each one works.</p>
    <div class="choice-list">
      ${ANALYSES.map((a) => `
        <div class="choice" role="button" tabindex="0" data-analysis="${a.id}" aria-pressed="${state.analysis === a.id}">
          <span class="choice-icon">${a.icon}</span>
          <div><h3>${esc(a.title)}</h3><p>${esc(a.desc)}</p></div>
          <div class="choice-foot"><button type="button" class="btn btn-small" data-example="${a.id}">Try example</button></div>
        </div>`).join("")}
    </div>
    <p class="fine">Your data stays on this computer. Serpentine runs Python inside your browser, and nothing is uploaded.</p>`;
}

function renderData() {
  const p = $("#panel-data");
  const tc = state.analysis === "timecourse";
  const act = activeDataset();
  const unit = state.settings.timecourse.time_unit || "seconds";
  let html = `<p class="panel-intro">${tc
    ? "Add one table per recording session, for example a LabChart Data Pad export. Then give each session its group, subject and event time."
    : "Paste a table copied from Excel, Prism or LabChart, or upload a CSV, TSV or Excel file. Column names in the first row work best."}</p>
    <div class="drop" id="drop">
      <span>Drop files here, press ⌘V / Ctrl+V anywhere, or</span>
      <span class="btn-row" style="justify-content:center">
        <button type="button" class="btn btn-primary" id="btn-add">Paste a new table</button>
        <button type="button" class="btn" id="btn-upload">Upload files</button>
      </span>
      <input type="file" id="upload-file" multiple accept=".csv,.tsv,.txt,.xlsx,.xls" hidden>
    </div>`;

  if (tc && state.datasets.length) {
    html += `<div class="section-static"><div class="section-title">Sessions</div>
      <div class="table-wrap" style="border:0"><table class="sessions-table">
        <thead><tr><th>Session</th><th>Group</th><th>Subject</th><th>Event</th><th>Exclude</th></tr></thead><tbody>
        ${state.datasets.map((d) => `<tr class="${d.id === state.active ? "active" : ""}">
          <td><button type="button" data-select="${d.id}" title="${esc(d.name)}">${esc(d.name)}${inspected[d.id]?.error ? ' <span class="err">!</span>' : ""}</button></td>
          <td><input type="text" id="m-${d.id}-group" data-meta="group" data-id="${d.id}" value="${esc(d.meta.group)}" placeholder="Saline" spellcheck="false"></td>
          <td><input type="text" id="m-${d.id}-subject" data-meta="subject" data-id="${d.id}" value="${esc(d.meta.subject)}" placeholder="M1" spellcheck="false"></td>
          <td><input type="text" id="m-${d.id}-event" data-meta="event" data-id="${d.id}" value="${esc(d.meta.event)}" placeholder="13:27" spellcheck="false"></td>
          <td><input type="text" id="m-${d.id}-exclude" data-meta="exclude" data-id="${d.id}" value="${esc(d.meta.exclude)}" placeholder="none" spellcheck="false"></td>
        </tr>`).join("")}
      </tbody></table></div>
      <span class="hint">Event: when the injection or stimulus happened, as mm:ss, or as a plain number in the time column's units (now ${esc(unit)}). Exclude: time ranges to drop in recording time, like 8:00-8:50, separated by commas.</span>
    </div>`;
  } else if (state.datasets.length > 1) {
    html += `<div class="ds-tabs">${state.datasets.map((d) => `<button type="button" class="ds-tab" data-select="${d.id}" aria-pressed="${d.id === state.active}">${esc(d.name)}${inspected[d.id]?.error ? ' <span class="err">!</span>' : ""}</button>`).join("")}</div>`;
  }

  if (act) {
    html += `<div class="section-static">
      <div class="section-title">${tc ? "Session data" : "Table"}</div>
      <div class="field"><label for="ds-name">Name</label><input type="text" id="ds-name" value="${esc(act.name)}" spellcheck="false"></div>
      <div class="field"><label for="ds-text">Data</label>
        <textarea id="ds-text" class="data-text" spellcheck="false" rows="9" placeholder="Paste your table here">${esc(act.text)}</textarea></div>
      <div id="ds-preview"></div>
      <div class="btn-row"><button type="button" class="btn btn-small" id="btn-duplicate">Duplicate</button><button type="button" class="btn btn-small btn-danger" id="btn-delete">Delete this table</button></div>
    </div>`;
  }
  p.innerHTML = html;
  renderDataPreview();
}

function renderDataPreview() {
  const box = $("#ds-preview");
  const act = activeDataset();
  if (!box || !act) return;
  const info = inspected[act.id];
  if (!act.text.trim()) {
    box.innerHTML = `<span class="hint">Paste data above. Tab-separated (copied from Excel or LabChart) and comma-separated both work.</span>`;
    return;
  }
  if (!info) {
    box.innerHTML = `<span class="hint">${engineReady ? "Reading…" : "The preview appears once Python is ready."}</span>`;
    return;
  }
  if (info.error) {
    box.innerHTML = `<div class="callout callout-bad">${esc(info.error)}</div>`;
    return;
  }
  box.innerHTML = `
    <div class="parse-line"><span>${info.n_rows} rows · ${info.columns.length} columns · ${esc(info.separator)}-separated</span></div>
    <div class="parse-line">${info.columns.map((c) => `<span class="col-chip">${esc(c.name)} <em>${c.kind}</em></span>`).join("")}</div>
    <div class="table-wrap" style="margin-top:8px"><table class="preview">
      <thead><tr>${info.columns.map((c) => `<th>${esc(c.name)}</th>`).join("")}</tr></thead>
      <tbody>${info.preview.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table></div>`;
}

function renderSettings() {
  const s = state.settings[state.analysis];
  const intro = `<p class="panel-intro">Settings for <b>${esc(ANALYSES.find((a) => a.id === state.analysis).title.toLowerCase())}</b>. The figure updates as you change them.</p>`;
  renderForm($("#panel-settings"), SETTINGS_SCHEMA[state.analysis](s), s, "set", intro);
}

const STYLE_OPEN = new Set(["Quick styles", "Plot type", "Groups", "Colors"]);
function renderStyle() {
  const intro = `<p class="panel-intro">Every part of the figure can be changed. Start from a quick style, then open any section below.</p>`;
  renderForm($("#panel-style"), styleSchema(), state.style, "sty", intro, (title) => STYLE_OPEN.has(title));
}

function renderPanels() {
  renderSteps();
  renderAnalysis();
  renderData();
  renderSettings();
  renderStyle();
}

function renderAll() {
  $("#project-name").value = state.name;
  $("#example-badge").hidden = !state.example;
  renderPanels();
  $$(".rtab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.rtab === state.rtab)));
  ["tables", "methods", "python"].forEach((t) => ($("#rpanel-" + t).hidden = t !== state.rtab));
  renderUndo();
}

// ============================================================================
// Rendering: results
// ============================================================================
function renderEmptyStage() {
  lastResult = null;
  $("#error-box").hidden = true;
  $("#results").hidden = true;
  $("#command-form").hidden = true;
  $("#figures").innerHTML = `<div class="loading-card" style="margin:40px auto">
    <h2>Add data to see your figure</h2>
    <p class="fine">Go to step 2 and paste a table, or pick an analysis in step 1 and press <b>Try example</b>.</p>
  </div>`;
}

function tableTSV(t) {
  return [t.columns.join("\t")].concat(t.rows.map((r) => r.map((v) => (v === null ? "" : v)).join("\t"))).join("\n");
}
function tableCSV(t) {
  const q = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [t.columns.map(q).join(",")].concat(t.rows.map((r) => r.map(q).join(","))).join("\n");
}

function renderResults(out) {
  const err = $("#error-box");
  if (out.error) {
    err.hidden = false;
    err.innerHTML = `<b>Can't run this analysis yet.</b> ${esc(out.error)}`;
    if (out.trace) console.error(out.trace);
    $("#figures").innerHTML = "";
    $("#results").hidden = true;
    lastResult = null;
    $("#command-form").hidden = true;
    return;
  }
  err.hidden = true;
  const r = out.ok;
  const firstResult = !lastResult;
  const groupsChanged = JSON.stringify(lastResult?.group_styles || null) !== JSON.stringify(r.group_styles || null);
  lastResult = r;
  if (groupsChanged && state.step === "style") renderStyle();
  $("#figures").innerHTML = r.figures.map((f, i) => `
    <figure class="figure-card" style="margin:0">
      <div class="figure-head"><h3>${esc(f.title)}</h3>
        <button type="button" class="btn btn-small" data-copy-fig="${i}" title="Copy as an image to paste into slides or documents">Copy</button>
        <button type="button" class="btn btn-small" data-export="${i}" data-format="png">PNG</button>
        <button type="button" class="btn btn-small" data-export="${i}" data-format="svg">SVG</button>
        <button type="button" class="btn btn-small" data-export="${i}" data-format="pdf">PDF</button>
        <select class="btn btn-small more-formats" data-more="${i}" aria-label="More formats"><option value="">More…</option><option value="tiff">TIFF</option><option value="jpg">JPG</option><option value="eps">EPS</option></select>
      </div>
      <div class="figure-body">${f.svg}</div>
    </figure>`).join("");

  const sum = r.summary.map((s) => `<div class="result-line"><span class="label">${esc(s.label)}</span><span class="value">${esc(s.value)}</span>${
    s.p === null || s.p === undefined ? "" : `<span class="pchip${s.p < 0.05 ? " sig" : ""}">${s.p < 0.05 ? "significant" : "not significant"}</span>`}</div>`).join("");
  const notes = r.notes.length ? `<div class="callout callout-warn"><b>Check:</b><ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>` : "";
  $("#summary").innerHTML = sum + notes;

  $("#rpanel-tables").innerHTML = r.tables.map((t, i) => `
    <div>
      <div class="tbl-head"><h4>${esc(t.title)}</h4>
        <button type="button" class="btn btn-small" data-copy-table="${i}">Copy for Excel</button>
        <button type="button" class="btn btn-small" data-csv="${i}">CSV</button></div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr>${t.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
        <tbody>${t.rows.slice(0, 400).map((row) => `<tr>${row.map((v) => `<td>${esc(fmtNum(v))}</td>`).join("")}</tr>`).join("")}</tbody>
      </table></div>
      ${t.rows.length > 400 ? `<span class="hint">Showing 400 of ${t.rows.length} rows. Download the CSV for all of them.</span>` : ""}
    </div>`).join("");

  $("#rpanel-methods").innerHTML = `
    <p class="methods-text" id="methods-text">${esc(r.methods)}</p>
    <div><button type="button" class="btn btn-small" id="btn-copy-methods">Copy methods text</button></div>
    <span class="hint">A starting point for your methods section. Check it against what you actually did.</span>`;

  $("#rpanel-python").innerHTML = `
    <p class="methods-text">Download a Python script that reproduces this exact analysis: your data, settings and style are built in, including any Python code you added. Anyone can rerun it with <code>pip install numpy scipy pandas matplotlib</code> and <code>python script.py</code>. Useful for reviewers, lab records and going beyond the menus.</p>
    <div><button type="button" class="btn btn-primary btn-small" id="btn-script">Download Python script</button></div>
    <pre class="code-peek">${esc(scriptPeek())}</pre>`;
  $("#results").hidden = false;
  if (firstResult || groupsChanged) renderCommandBar();
  $("#command-form").hidden = false;
}

// ============================================================================
// Exports
// ============================================================================
async function getEngineSource() {
  if (!engineSource) engineSource = await (await fetch("engine/serpentine.py")).text();
  return engineSource;
}

function scriptTail() {
  const a = runArgs();
  return `CONFIG_JSON = ${JSON.stringify(JSON.stringify(a.config, null, 1))}\nDATASETS_JSON = ${JSON.stringify(JSON.stringify(a.datasets))}\n\nif __name__ == "__main__":\n    cli(CONFIG_JSON, DATASETS_JSON, out_dir="serpentine_output")\n`;
}

function scriptPeek() {
  const c = state.settings[state.analysis];
  return [
    `# ${state.name}`,
    `# Analysis: ${ANALYSES.find((a) => a.id === state.analysis).title}`,
    `# Tables: ${state.datasets.length}`,
    `#`,
    `# ... the full Serpentine engine, documented Python ...`,
    ``,
    `CONFIG = {`,
    `    "analysis": "${state.analysis}",`,
    ...Object.entries(c).slice(0, 8).map(([k, v]) => `    "${k}": ${JSON.stringify(v)},`),
    `    ...`,
    `}`,
    ``,
    `cli(CONFIG, DATASETS)  # saves PNG, PDF, SVG and CSV files to ./serpentine_output`,
  ].join("\n");
}

async function downloadScript() {
  const src = await getEngineSource();
  const head = `# -*- coding: utf-8 -*-\n# ${state.name}\n# Generated by Serpentine on ${new Date().toISOString().slice(0, 10)}.\n#\n# Reproduces the analysis exactly: data, settings and figure style are included below.\n# Requirements: pip install numpy scipy pandas matplotlib\n# Run:          python ${slug(state.name)}.py\n# Output:       figures (PNG, PDF, SVG) and tables (CSV) in ./serpentine_output\n# Web fonts such as Lato are used if installed on this computer; otherwise matplotlib's default font.\n\n`;
  download(slug(state.name) + ".py", head + src + "\n\n# ---- This analysis ----\n" + scriptTail(), "text/x-python");
}

const MIME = { png: "image/png", svg: "image/svg+xml", pdf: "application/pdf", tiff: "image/tiff", jpg: "image/jpeg", eps: "application/postscript" };
async function exportFigure(index, format) {
  const out = await call("export", { index, format, dpi: parseInt(state.style.dpi, 10) || 300, transparent: !!state.style.transparent });
  if (out.error) return toast(out.error);
  const fig = lastResult?.figures[index];
  download(`${slug(state.name)}_${fig ? fig.id : index}.${format}`, b64ToBlob(out.ok, MIME[format]));
}

function copyFigure(index) {
  if (!navigator.clipboard || typeof ClipboardItem === "undefined") return toast("This browser can't copy images. Use PNG instead.");
  const blob = call("export", { index, format: "png", dpi: 300, transparent: false }).then((out) => {
    if (out.error) throw new Error(out.error);
    return b64ToBlob(out.ok, "image/png");
  });
  navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
    .then(() => toast("Figure copied. Paste it into slides or a document."))
    .catch(() => toast("Your browser blocked copying the image. Use PNG instead."));
}

function saveProject() {
  download(slug(state.name) + ".serpentine.json", JSON.stringify(state, null, 1), "application/json");
  toast("Project saved to your downloads");
}

// ============================================================================
// Plain-English commands
// ============================================================================
const colorCanvas = document.createElement("canvas").getContext("2d");
function parseColor(word) {
  if (!/^[a-z]+$/i.test(word)) return null;
  colorCanvas.fillStyle = "#010203";
  colorCanvas.fillStyle = word;
  const v = colorCanvas.fillStyle;
  return v !== "#010203" && v.startsWith("#") ? v : null;
}

const commandHistory = [];
let commandIndex = 0;

const COMMAND_HELP = [
  ["Gridlines & legend", ["remove gridlines", "dashed horizontal gridlines", "hide the legend", "legend at the top left"]],
  ["Groups", ["make Saline red", "rename Saline to Control", "square markers for Morphine", "striped bars for Vehicle"]],
  ["Plot type", ["make it a violin plot", "horizontal", "solid bars", "wider bars", "hide the points"]],
  ["Colors", ["use viridis", "colorblind friendly colors", "reverse the colors", "dark background", "make the text white"]],
  ["Text", ["title Day 21", "y axis label Volume (mm³)", "font size 12", "use Lato", "bold axis labels", "panel letter B"]],
  ["Axes", ["remove the top and right axes", "box around the plot", "floating axes", "y axis from 0 to 1000", "log scale", "ticks inside", "rotate the labels 45"]],
  ["Stats marks", ["show exact p values", "hide the stars", "show n under each group", "use SD", "no caps on error bars"]],
  ["Size & more", ["6 by 4 inches", "89 mm wide", "make it bigger", "reference line at 100", "use the journal style", "undo"]],
];

function commandExamples() {
  const g = lastResult?.group_styles?.[0]?.label || "the first group";
  const base = ["remove gridlines", `make ${g} red`, "dark background", "font size 12", "use viridis"];
  if (state.analysis === "compare" || state.analysis === "timecourse") base.splice(2, 0, "horizontal violin plot");
  else base.splice(2, 0, "hide the legend");
  return base;
}

function renderCommandBar() {
  const form = $("#command-form");
  form.hidden = !lastResult;
  if (!lastResult) return;
  $("#command-examples").innerHTML = '<span class="hint" style="align-self:center">Try:</span>' + commandExamples().map((e) => `<button type="button" data-cmd="${esc(e)}">${esc(e)}</button>`).join("");
}

function runCommand(text) {
  text = text.trim();
  if (!text) return;
  commandHistory.push(text);
  commandIndex = commandHistory.length;
  let undid = false;
  const settings = state.settings[state.analysis];
  const before = JSON.stringify(settings);
  const res = interpretCommand(text, {
    style: state.style,
    settings,
    analysis: state.analysis,
    groups: lastResult?.group_styles || [],
    colormaps: COLORMAPS.flatMap(([, list]) => list),
    parseColor,
    applyPreset: (name) => {
      const p = PRESETS.find((x) => x.name.toLowerCase() === name);
      if (!p) return false;
      Object.assign(state.style, clone(LOOK_DEFAULTS), p.v);
      return true;
    },
    resetStyle: () => {
      const keep = { plot_kind: state.style.plot_kind, orientation: state.style.orientation };
      for (const k of Object.keys(state.style)) delete state.style[k];
      Object.assign(state.style, clone(DEFAULT_STYLE), keep);
    },
    undo: () => { undid = true; undo(); },
  });
  const other = res.changes.filter((c) => c !== "Undid the last change");
  if (other.length) {
    if (state.step === "style") renderStyle();
    if (JSON.stringify(settings) !== before && state.step === "settings") renderSettings();
    changed({ delay: 10 });
  }
  const fb = $("#command-feedback");
  fb.innerHTML = res.changes.map((c) => `<span class="cmd-chip">✓ ${esc(c)}</span>`).join("")
    + res.unknown.map((u) => `<span class="cmd-chip miss">Didn't understand “${esc(u)}”. See “What can I say?” or use the Style step.</span>`).join("");
  if (res.changes.length && !res.unknown.length) $("#command-input").value = "";
  if (undid && !other.length) renderUndo();
}

function bindCommandBar() {
  const form = $("#command-form");
  const input = $("#command-input");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    runCommand(input.value);
  });
  form.addEventListener("click", (e) => {
    const ex = e.target.closest("[data-cmd]");
    if (ex) {
      input.value = ex.dataset.cmd;
      runCommand(ex.dataset.cmd);
      return;
    }
    if (e.target.closest("#command-help-btn")) {
      const help = $("#command-help");
      help.hidden = !help.hidden;
      e.target.setAttribute("aria-expanded", String(!help.hidden));
      if (!help.hidden && !help.innerHTML) {
        help.innerHTML = COMMAND_HELP.map(([title, list]) => `<div><b>${esc(title)}</b>${list.map((l) => `<span>${esc(l)}</span>`).join("")}</div>`).join("")
          + `<div><b>Tips</b><span style="font-family:inherit">Combine commands with “and” or commas. Every change can be undone with Undo or ⌘Z.</span></div>`;
      }
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" && commandHistory.length) {
      e.preventDefault();
      commandIndex = Math.max(0, commandIndex - 1);
      input.value = commandHistory[commandIndex];
    } else if (e.key === "ArrowDown" && commandHistory.length) {
      e.preventDefault();
      commandIndex = Math.min(commandHistory.length, commandIndex + 1);
      input.value = commandHistory[commandIndex] || "";
    }
  });
}

// ============================================================================
// Events
// ============================================================================
function isTyping(el) {
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

function bindEvents() {
  $(".steps").addEventListener("click", (e) => {
    const b = e.target.closest(".step");
    if (!b) return;
    state.step = b.dataset.step;
    if (state.step === "settings") renderSettings();
    if (state.step === "style") renderStyle();
    if (state.step === "data") renderData();
    renderSteps();
    autosave();
  });

  $("#project-name").addEventListener("input", (e) => {
    state.name = e.target.value || "Untitled analysis";
    autosave();
  });

  const pa = $("#panel-analysis");
  const pickAnalysis = (id) => {
    state.analysis = id;
    renderAnalysis();
    renderSettings();
    renderStyle();
    changed();
  };
  pa.addEventListener("click", (e) => {
    const ex = e.target.closest("[data-example]");
    if (ex) {
      e.stopPropagation();
      const go = () => loadExample(ex.dataset.example);
      if (state.datasets.length && !state.example) armConfirm(ex, "Replace your tables?", go);
      else go();
      return;
    }
    const c = e.target.closest("[data-analysis]");
    if (c) pickAnalysis(c.dataset.analysis);
  });
  pa.addEventListener("keydown", (e) => {
    const c = e.target.closest("[data-analysis]");
    if (c && (e.key === "Enter" || e.key === " ") && e.target === c) {
      e.preventDefault();
      pickAnalysis(c.dataset.analysis);
    }
  });

  const pd = $("#panel-data");
  pd.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("#btn-add")) {
      newDataset(nextName());
      renderData();
      $("#ds-text")?.focus();
      autosave();
    } else if (t.closest("#btn-upload")) {
      $("#upload-file").click();
    } else if (t.closest("[data-select]")) {
      state.active = t.closest("[data-select]").dataset.select;
      renderData();
      autosave();
    } else if (t.closest("#btn-duplicate")) {
      const act = activeDataset();
      if (!act) return;
      const d = newDataset(act.name + " copy", act.text, { ...act.meta });
      inspected[d.id] = inspected[act.id];
      renderData();
      changed({ clearExample: true });
    } else if (t.closest("#btn-delete")) {
      armConfirm(t.closest("#btn-delete"), "Click again to delete", () => {
        const gone = state.active;
        state.datasets = state.datasets.filter((d) => d.id !== gone);
        delete inspected[gone];
        state.active = state.datasets[0]?.id || null;
        renderData();
        if (state.step === "settings") renderSettings();
        changed({ clearExample: true });
      });
    }
  });
  pd.addEventListener("change", (e) => {
    if (e.target.id === "upload-file" && e.target.files.length) {
      addFiles(Array.from(e.target.files));
      e.target.value = "";
    }
    if (e.target.id === "ds-name") renderData();
  });
  pd.addEventListener("input", (e) => {
    const t = e.target;
    const act = activeDataset();
    if (t.id === "ds-text" && act) {
      act.text = t.value;
      scheduleInspect(act.id);
      changed({ run: false, clearExample: true });
    } else if (t.id === "ds-name" && act) {
      act.name = t.value;
      changed();
    } else if (t.dataset.meta) {
      const d = state.datasets.find((x) => x.id === t.dataset.id);
      if (d) {
        d.meta[t.dataset.meta] = t.value;
        changed({ clearExample: true });
      }
    }
  });
  pd.addEventListener("dragover", (e) => {
    const drop = e.target.closest("#drop");
    if (drop) {
      e.preventDefault();
      drop.classList.add("dragging");
    }
  });
  pd.addEventListener("dragleave", (e) => e.target.closest("#drop")?.classList.remove("dragging"));
  pd.addEventListener("drop", (e) => {
    const drop = e.target.closest("#drop");
    if (!drop) return;
    e.preventDefault();
    drop.classList.remove("dragging");
    if (e.dataTransfer.files.length) addFiles(Array.from(e.dataTransfer.files));
  });

  // Paste anywhere (outside text fields) creates a new table.
  document.addEventListener("paste", (e) => {
    if (isTyping(document.activeElement)) return;
    const text = e.clipboardData?.getData("text/plain");
    if (!text || !text.trim()) return;
    e.preventDefault();
    const d = newDataset(nextName(), text);
    state.step = "data";
    renderSteps();
    renderData();
    scheduleInspect(d.id, 10);
    changed({ run: false, clearExample: true });
    toast("Pasted into " + d.name);
  });

  bindForm($("#panel-settings"), () => state.settings[state.analysis], renderSettings);
  bindForm($("#panel-style"), () => state.style, renderStyle);

  $(".stage").addEventListener("click", (e) => {
    const ex = e.target.closest("[data-export]");
    if (ex) return exportFigure(+ex.dataset.export, ex.dataset.format);
    const cf = e.target.closest("[data-copy-fig]");
    if (cf) return copyFigure(+cf.dataset.copyFig);
    const cp = e.target.closest("[data-copy-table]");
    if (cp && lastResult) return copyText(tableTSV(lastResult.tables[+cp.dataset.copyTable]), "Table copied. Paste it into Excel or Prism.");
    const csv = e.target.closest("[data-csv]");
    if (csv && lastResult) {
      const t = lastResult.tables[+csv.dataset.csv];
      return download(`${slug(state.name)}_${slug(t.title)}.csv`, tableCSV(t), "text/csv");
    }
    if (e.target.closest("#btn-copy-methods") && lastResult) return copyText(lastResult.methods, "Methods text copied");
    if (e.target.closest("#btn-script")) return downloadScript();
    const rt = e.target.closest(".rtab");
    if (rt) {
      state.rtab = rt.dataset.rtab;
      $$(".rtab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.rtab === state.rtab)));
      ["tables", "methods", "python"].forEach((t) => ($("#rpanel-" + t).hidden = t !== state.rtab));
      autosave();
    }
  });
  $(".stage").addEventListener("change", (e) => {
    const m = e.target.closest("[data-more]");
    if (m && m.value) {
      exportFigure(+m.dataset.more, m.value);
      m.value = "";
    }
  });

  $("#btn-undo").addEventListener("click", undo);
  $("#btn-redo").addEventListener("click", redo);
  $("#btn-save").addEventListener("click", saveProject);
  $("#btn-open").addEventListener("click", () => $("#open-file").click());
  $("#open-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      if (!adopt(JSON.parse(await f.text()))) throw new Error();
      Object.keys(inspected).forEach((k) => delete inspected[k]);
      await Promise.all(state.datasets.map((d) => inspectNow(d.id)));
      history.past = [];
      history.future = [];
      history.last = snapshot();
      renderAll();
      autosave();
      runNow();
      toast("Opened " + f.name);
    } catch (err) {
      toast("That file isn't a Serpentine project.");
    }
  });
  $("#btn-new").addEventListener("click", (e) => {
    armConfirm(e.currentTarget, "Discard current?", () => {
      const keepStyle = state.style;
      state = freshState();
      state.style = { ...keepStyle, groups: {} };
      Object.keys(inspected).forEach((k) => delete inspected[k]);
      renderAll();
      renderEmptyStage();
      changed({ run: false });
    });
  });
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveProject();
    } else if (mod && e.key.toLowerCase() === "z" && !isTyping(document.activeElement)) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && e.key.toLowerCase() === "y" && !isTyping(document.activeElement)) {
      e.preventDefault();
      redo();
    }
  });
}

// ============================================================================
// Start
// ============================================================================
bindEvents();
bindCommandBar();
if (!restore()) {
  state.analysis = "timecourse";
  queuedExample = "timecourse";
}
history.last = snapshot();
renderAll();
if (servedFromDisk) {
  setStatus("failed", "Needs the launcher");
  $(".spinner").hidden = true;
  $("#loading h2").textContent = "Start Serpentine with the launcher";
  $("#loading-text").textContent = "Browsers don't let Python run on pages opened straight from a file.";
  $("#loading .fine").innerHTML = "Close this tab and double-click <b>Start Serpentine.command</b> (Mac) or <b>Start Serpentine (Windows).bat</b> in the Serpentine folder. Or use Serpentine online at <a href=\"https://frizzell-5.github.io/Serpentine/app.html\">frizzell-5.github.io/Serpentine</a>.";
}
