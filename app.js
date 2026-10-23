"use strict";

// ============================================================================
// Small helpers
// ============================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const slug = (s) => (String(s || "lablens").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "lablens");
const STORE_KEY = "lablens.project.v1";

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
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
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
    group_order: "", band: "sem", show_traces: true, show_event: true, shade_baseline: true, shade_endpoint: true,
  },
  correlation: { dataset: "", x_col: "", y_col: "", group_col: "", group_order: "", method: "pearson", fit: true, ci: true, annotate: true },
  dose: { dataset: "", x_col: "", x_unit: "", x_scale: 1, mode: "curves", y_cols: [], curve_name: "Response", fix_bottom: "", fix_top: "", show_ec50: true, all_points: false, ec_label: "" },
};

const DEFAULT_STYLE = {
  width: 4, height: 3.4, font_size: 10, line_width: 1.5, marker_size: 5, point_alpha: 0.85, palette: "lablens",
  custom_colors: "", plot_kind: "bar", error: "sem", fill: "light", show_points: true, sig: "stars", show_ns: false,
  grid: false, despine: true, legend: "best", title: "", xlabel: "", ylabel: "", ymin: "", ymax: "", logy: false,
  xrot: 0, show_n: false, theme: "light", dpi: 300, transparent: false, title_bold: true, font: "sans",
};

const PALETTES = [
  ["lablens", "LabLens", ["#2F5D8A", "#D1495B", "#E9A23B", "#00798C", "#6B4E9B", "#7A7A7A"]],
  ["okabe", "Okabe-Ito · colorblind-safe", ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#CC79A7", "#56B4E9"]],
  ["tol", "Tol bright · colorblind-safe", ["#4477AA", "#EE6677", "#228833", "#CCBB44", "#66CCEE", "#AA3377"]],
  ["muted", "Muted", ["#4C72B0", "#DD8452", "#55A868", "#C44E52", "#8172B3", "#937860"]],
  ["pastel", "Pastel", ["#8DA0CB", "#FC8D62", "#66C2A5", "#E78AC3", "#A6D854", "#FFD92F"]],
  ["ocean", "Ocean", ["#023E8A", "#0096C7", "#48CAE4", "#03045E", "#00B4D8", "#90E0EF"]],
  ["sunset", "Sunset", ["#3D348B", "#F18701", "#7678ED", "#F35B04", "#F7B801", "#9B2226"]],
  ["grayscale", "Grayscale", ["#1F1F1F", "#8A8A8A", "#C4C4C4", "#525252", "#A8A8A8", "#6E6E6E"]],
];

const PRESETS = [
  { name: "Clean", desc: "Balanced default", v: { width: 4, height: 3.4, font_size: 10, line_width: 1.5, marker_size: 5, palette: "lablens", fill: "light", theme: "light", grid: false, despine: true, font: "sans" } },
  { name: "Journal", desc: "1 column, 89 mm", v: { width: 3.5, height: 2.8, font_size: 8, line_width: 1, marker_size: 3.5, palette: "okabe", fill: "light", theme: "light", grid: false, despine: true, font: "sans" } },
  { name: "Classic", desc: "Bold, black & white", v: { width: 3.6, height: 3.6, font_size: 11, line_width: 2, marker_size: 5, palette: "grayscale", fill: "outline", theme: "light", grid: false, despine: true, font: "sans" } },
  { name: "Poster", desc: "Large type", v: { width: 6.5, height: 5, font_size: 18, line_width: 2.6, marker_size: 8, palette: "tol", fill: "solid", theme: "light", grid: false, despine: true } },
  { name: "Slides", desc: "Dark background", v: { width: 6.4, height: 4.2, font_size: 14, line_width: 2, marker_size: 6.5, palette: "tol", fill: "light", theme: "dark", grid: false, despine: true } },
  { name: "Soft", desc: "Pastel with grid", v: { width: 4.2, height: 3.4, font_size: 10, line_width: 1.3, marker_size: 5, palette: "pastel", fill: "solid", theme: "light", grid: true, despine: true } },
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
    app: "LabLens",
    version: 1,
    name: "Untitled analysis",
    analysis: "compare",
    step: "analysis",
    rtab: "tables",
    example: null,
    datasets: [],
    active: null,
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    style: { ...DEFAULT_STYLE },
  };
}

let state = freshState();
const inspected = {}; // dataset id -> inspect result {columns, preview, n_rows, separator} | {error}
let lastResult = null;
let engineSource = null;

// ============================================================================
// Python engine (web worker)
// ============================================================================
const worker = new Worker("worker.js");
let engineReady = false;
let reqId = 0;
const pending = new Map();
let queuedExample = null;

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "status") {
    if (!engineReady) {
      setStatus("loading", m.text);
      $("#loading-text").textContent = m.text;
    } else {
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
  } else if (m.type === "result") {
    const resolve = pending.get(m.id);
    pending.delete(m.id);
    if (resolve) resolve(m.out);
  }
};

function call(cmd, args) {
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
// Persistence
// ============================================================================
let saveTimer = null;
let autosaveWarned = false;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      if (!autosaveWarned) {
        autosaveWarned = true;
        toast("This project is too big to keep in the browser. Use Save to keep a copy.");
      }
    }
  }, 600);
}

function restore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return false;
    return adopt(JSON.parse(raw));
  } catch (e) {
    return false;
  }
}

function adopt(obj) {
  if (!obj || obj.app !== "LabLens" || !Array.isArray(obj.datasets)) return false;
  const base = freshState();
  state = {
    ...base,
    ...obj,
    settings: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, { ...DEFAULT_SETTINGS[k], ...(obj.settings?.[k] || {}) }])),
    style: { ...DEFAULT_STYLE, ...(obj.style || {}) },
  };
  state.datasets = state.datasets.map((d) => ({ id: d.id || uid(), name: d.name || "Table", text: d.text || "", meta: { group: "", subject: "", event: "", exclude: "", ...(d.meta || {}) } }));
  if (!state.datasets.some((d) => d.id === state.active)) state.active = state.datasets[0]?.id || null;
  return true;
}

function changed({ run = true, clearExample = false } = {}) {
  if (clearExample && state.example) {
    state.example = null;
    $("#example-badge").hidden = true;
  }
  autosave();
  if (run) scheduleRun();
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
  return base + " " + (state.datasets.length + 1);
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
  if (state.example) changed({ clearExample: true });
  state.datasets.forEach((d) => { if (!inspected[d.id]) scheduleInspect(d.id, 10); });
  renderData();
  changed();
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
const sec = (title) => ({ type: "section", title });
const note = (text) => ({ type: "note", text });
const row = (...fields) => ({ type: "row", fields: fields.filter(Boolean) });
const sel = (key, label, options, x = {}) => ({ type: "select", key, label, options, ...x });
const seg = (key, label, options, x = {}) => ({ type: "seg", key, label, options, ...x });
const tog = (key, label, hint) => ({ type: "toggle", key, label, hint });
const num = (key, label, x = {}) => ({ type: "number", key, label, ...x });
const txt = (key, label, x = {}) => ({ type: "text", key, label, ...x });
const col = (key, label, names, x = {}) => ({ type: "select", key, label, options: [["", x.none ? "None" : (x.auto || "Auto")]].concat(names.map((n) => [n, n])), ...x });
const cols = (key, label, names, hint) => ({ type: "checks", key, label, names, hint });

function fieldHTML(f, obj, scope) {
  if (!f) return "";
  const id = `f-${scope}-${f.key}`;
  const hint = f.hint ? `<span class="hint">${esc(f.hint)}</span>` : "";
  const v = obj[f.key];
  switch (f.type) {
    case "section":
      return `</div><div class="section"><div class="section-title">${esc(f.title)}</div>`;
    case "note":
      return `<span class="hint">${esc(f.text)}</span>`;
    case "row":
      return `<div class="row${f.fields.length === 3 ? " row-3" : ""}">${f.fields.map((x) => fieldHTML(x, obj, scope)).join("")}</div>`;
    case "select": {
      const opts = f.options.map(([val, lab]) => `<option value="${esc(val)}"${String(v ?? "") === String(val) ? " selected" : ""}>${esc(lab)}</option>`);
      if (v && !f.options.some(([val]) => String(val) === String(v))) opts.push(`<option value="${esc(v)}" selected>${esc(v)} (not found)</option>`);
      return `<div class="field"><label for="${id}">${esc(f.label)}</label><select id="${id}" data-key="${f.key}" data-kind="select">${opts.join("")}</select>${hint}</div>`;
    }
    case "seg":
      return `<div class="field"><span class="field-label">${esc(f.label)}</span><div class="segmented" role="group" aria-label="${esc(f.label)}">${f.options
        .map(([val, lab]) => `<button type="button" id="${id}-${esc(val)}" data-key="${f.key}" data-kind="seg" data-value="${esc(val)}" aria-pressed="${String(v) === String(val)}">${esc(lab)}</button>`)
        .join("")}</div>${hint}</div>`;
    case "toggle":
      return `<div class="field"><label class="toggle" for="${id}"><span>${esc(f.label)}</span><input type="checkbox" role="switch" id="${id}" data-key="${f.key}" data-kind="toggle"${v ? " checked" : ""}></label>${hint}</div>`;
    case "number":
      return `<div class="field"><label for="${id}">${esc(f.label)}</label><input type="number" step="any" id="${id}" data-key="${f.key}" data-kind="number" value="${esc(v ?? "")}" placeholder="${esc(f.placeholder || "auto")}">${hint}</div>`;
    case "text":
      return `<div class="field"><label for="${id}">${esc(f.label)}</label><input type="text" id="${id}" data-key="${f.key}" data-kind="text" value="${esc(v ?? "")}" placeholder="${esc(f.placeholder || "")}" spellcheck="false">${hint}</div>`;
    case "checks": {
      const chosen = new Set(v || []);
      const items = f.names.length
        ? f.names.map((n, i) => `<label><input type="checkbox" id="${id}-${i}" data-key="${f.key}" data-kind="check" value="${esc(n)}"${chosen.has(n) ? " checked" : ""}>${esc(n)}</label>`).join("")
        : `<span class="hint">Columns appear here once data is added.</span>`;
      return `<div class="field"><span class="field-label">${esc(f.label)}</span><div class="checks">${items}</div>${hint}</div>`;
    }
    case "presets":
      return `<div class="presets">${PRESETS.map((p, i) => `<button type="button" class="preset" data-preset="${i}"><b>${esc(p.name)}</b><small>${esc(p.desc)}</small></button>`).join("")}</div>`;
    case "palettes":
      return `<div class="palettes" role="group" aria-label="Color palette">${PALETTES.map(
        ([key, name, colors]) => `<button type="button" class="palette" data-key="palette" data-kind="seg" data-value="${key}" aria-pressed="${v === key || obj.palette === key}"><span class="swatches">${colors.map((c) => `<i style="background:${c}"></i>`).join("")}</span><span>${esc(name)}</span></button>`
      ).join("")}</div>`;
    default:
      return "";
  }
}

function renderForm(panel, fields, obj, scope) {
  const focusId = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.id : null;
  const scrollTop = panel.scrollTop;
  panel.innerHTML = `<div class="section">${fields.filter(Boolean).map((f) => fieldHTML(f, obj, scope)).join("")}</div>`.replace(/<div class="section"><\/div>/g, "");
  panel.scrollTop = scrollTop;
  if (focusId) document.getElementById(focusId)?.focus();
}

// One delegated handler per form panel.
function bindForm(panel, getObj, rerender) {
  panel.addEventListener("input", (e) => {
    const el = e.target;
    if (!el.dataset.key) return;
    const obj = getObj();
    if (el.dataset.kind === "number" || el.dataset.kind === "text") {
      obj[el.dataset.key] = el.value;
      changed();
    }
  });
  panel.addEventListener("change", (e) => {
    const el = e.target;
    if (!el.dataset.key) return;
    const obj = getObj();
    const k = el.dataset.key;
    if (el.dataset.kind === "select") obj[k] = el.value;
    else if (el.dataset.kind === "toggle") obj[k] = el.checked;
    else if (el.dataset.kind === "check") {
      obj[k] = $$(`input[data-key="${k}"]:checked`, panel).map((x) => x.value);
    } else return;
    rerender();
    changed();
  });
  panel.addEventListener("click", (e) => {
    const b = e.target.closest("[data-kind='seg']");
    if (b) {
      getObj()[b.dataset.key] = b.dataset.value;
      rerender();
      changed();
      return;
    }
    const p = e.target.closest("[data-preset]");
    if (p) {
      Object.assign(state.style, PRESETS[+p.dataset.preset].v);
      rerender();
      changed();
      toast(PRESETS[+p.dataset.preset].name + " style applied");
    }
  });
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

function datasetField(s) {
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
      datasetField(s),
      seg("layout", "Table layout", [["wide", "One column per group"], ["long", "Values + group column"]]),
      s.layout !== "long" && cols("columns", "Groups to include", c.numeric, "Leave all unchecked to use every numeric column."),
      s.layout === "long" && row(col("value_col", "Value column", c.numeric), col("group_col", "Group column", c.all)),
      txt("group_order", "Group order", { placeholder: "e.g. Control, Low, High", hint: "Optional. Groups you leave out keep their table order." }),
      txt("y_name", "Measurement name", { placeholder: "e.g. Tumor volume (mm³)", hint: "Becomes the y-axis label." }),
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
      sel("band", "Shaded band", [["sem", "Mean ± SEM"], ["sd", "Mean ± SD"], ["none", "None"]]),
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
      datasetField(s),
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
      datasetField(s),
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
  const groupPlot = state.analysis === "compare" || state.analysis === "timecourse";
  const mm = (v) => Math.round(parseFloat(v || 0) * 25.4);
  return [
    sec("Quick styles"),
    { type: "presets" },
    sec("Plot"),
    groupPlot && sel("plot_kind", state.analysis === "timecourse" ? "Endpoint plot type" : "Plot type", [["bar", "Bar with points"], ["dot", "Scatter dot (mean line)"], ["box", "Box plot"], ["violin", "Violin"], ["raincloud", "Raincloud"]]),
    row(sel("error", "Error bars", [["sem", "SEM"], ["sd", "SD"], ["ci95", "95% CI"], ["none", "None"]]), groupPlot && sel("fill", "Fill", [["light", "Light"], ["solid", "Solid"], ["outline", "Outline"]])),
    groupPlot && tog("show_points", "Show individual points"),
    row(num("marker_size", "Point size"), num("point_alpha", "Point opacity", { hint: "0 to 1" }), num("line_width", "Line width")),
    groupPlot && sec("Significance"),
    groupPlot && sel("sig", "Show results as", [["stars", "Stars (*, **, ***)"], ["p", "Exact p-values"], ["none", "Hide"]]),
    groupPlot && tog("show_ns", "Also mark non-significant (ns)"),
    groupPlot && tog("show_n", "Show n under each group"),
    sec("Colors"),
    { type: "palettes", key: "palette" },
    txt("custom_colors", "Your own colors", { placeholder: "#333333, #D1495B", hint: "Optional hex codes in group order. They replace palette colors one by one." }),
    sec("Text"),
    txt("title", "Title"),
    row(txt("xlabel", "X-axis label", { placeholder: "automatic" }), txt("ylabel", "Y-axis label", { placeholder: "automatic" })),
    row(sel("font", "Font", [["sans", "Sans-serif (Arial)"], ["serif", "Serif (Times)"], ["mono", "Monospace"]]), num("font_size", "Font size (pt)")),
    tog("title_bold", "Bold title"),
    note("SVG keeps text editable in Illustrator or Inkscape. PNG and PDF use a close match of the chosen font."),
    sec("Axes"),
    row(num("ymin", "Y min"), num("ymax", "Y max")),
    row(num("xrot", "X label angle (°)", { placeholder: "0" }), sel("legend", "Legend", [["best", "Best spot"], ["upper right", "Top right"], ["upper left", "Top left"], ["lower right", "Bottom right"], ["lower left", "Bottom left"], ["outside", "Outside, right"], ["none", "Hidden"]])),
    tog("logy", "Log scale y-axis"),
    tog("grid", "Gridlines"),
    tog("despine", "Hide top and right axis lines"),
    sec("Size and export"),
    row(num("width", "Width (in)", { hint: mm(s.width) + " mm" }), num("height", "Height (in)", { hint: mm(s.height) + " mm" })),
    seg("theme", "Background", [["light", "Light"], ["dark", "Dark"]]),
    row(sel("dpi", "PNG resolution", [[150, "150 dpi"], [300, "300 dpi"], [600, "600 dpi"], [1200, "1200 dpi"]]), tog("transparent", "Transparent background")),
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
    <p class="fine">Your data stays on this computer. LabLens runs Python inside your browser, and nothing is uploaded.</p>`;
}

function renderData() {
  const p = $("#panel-data");
  const tc = state.analysis === "timecourse";
  const act = activeDataset();
  let html = `<p class="panel-intro">${tc
    ? "Add one table per recording session, for example a LabChart Data Pad export. Then give each session its group, subject and event time."
    : "Paste a table copied from Excel, Prism or LabChart, or upload a CSV, TSV or Excel file. Column names in the first row work best."}</p>
    <div class="drop" id="drop">
      <span>Drop files here, press ⌘V / Ctrl+V anywhere, or</span>
      <span style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
        <button type="button" class="btn btn-primary" id="btn-add">Paste a new table</button>
        <button type="button" class="btn" id="btn-upload">Upload files</button>
      </span>
      <input type="file" id="upload-file" multiple accept=".csv,.tsv,.txt,.xlsx,.xls" hidden>
    </div>`;

  if (tc && state.datasets.length) {
    html += `<div class="section"><div class="section-title">Sessions</div>
      <div class="table-wrap" style="border:0"><table class="sessions-table">
        <thead><tr><th>Session</th><th>Group</th><th>Subject</th><th>Event</th><th>Exclude</th></tr></thead><tbody>
        ${state.datasets.map((d) => `<tr class="${d.id === state.active ? "active" : ""}">
          <td><button type="button" data-select="${d.id}" title="${esc(d.name)}">${esc(d.name)}</button></td>
          <td><input type="text" id="m-${d.id}-group" data-meta="group" data-id="${d.id}" value="${esc(d.meta.group)}" placeholder="Saline" spellcheck="false"></td>
          <td><input type="text" id="m-${d.id}-subject" data-meta="subject" data-id="${d.id}" value="${esc(d.meta.subject)}" placeholder="M1" spellcheck="false"></td>
          <td><input type="text" id="m-${d.id}-event" data-meta="event" data-id="${d.id}" value="${esc(d.meta.event)}" placeholder="13:27" spellcheck="false"></td>
          <td><input type="text" id="m-${d.id}-exclude" data-meta="exclude" data-id="${d.id}" value="${esc(d.meta.exclude)}" placeholder="none" spellcheck="false"></td>
        </tr>`).join("")}
      </tbody></table></div>
      <span class="hint">Event: when the injection or stimulus happened, as mm:ss or seconds. Exclude: time ranges to drop, separated by commas.</span>
    </div>`;
  } else if (state.datasets.length > 1) {
    html += `<div class="ds-tabs">${state.datasets.map((d) => `<button type="button" class="ds-tab" data-select="${d.id}" aria-pressed="${d.id === state.active}">${esc(d.name)}${inspected[d.id]?.error ? ' <span class="err">!</span>' : ""}</button>`).join("")}</div>`;
  }

  if (act) {
    html += `<div class="section">
      <div class="section-title">${tc ? "Session data" : "Table"}</div>
      <div class="field"><label for="ds-name">Name</label><input type="text" id="ds-name" value="${esc(act.name)}" spellcheck="false"></div>
      <div class="field"><label for="ds-text">Data</label>
        <textarea id="ds-text" class="data-text" spellcheck="false" rows="9" placeholder="Paste your table here">${esc(act.text)}</textarea></div>
      <div id="ds-preview"></div>
      <div><button type="button" class="btn btn-small btn-danger" id="btn-delete">Delete this table</button></div>
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
  const kindName = { number: "number", time: "time", text: "text" };
  box.innerHTML = `
    <div class="parse-line"><span>${info.n_rows} rows · ${info.columns.length} columns · ${esc(info.separator)}-separated</span></div>
    <div class="parse-line">${info.columns.map((c) => `<span class="col-chip">${esc(c.name)} <em>${kindName[c.kind]}</em></span>`).join("")}</div>
    <div class="table-wrap" style="margin-top:8px"><table class="preview">
      <thead><tr>${info.columns.map((c) => `<th>${esc(c.name)}</th>`).join("")}</tr></thead>
      <tbody>${info.preview.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table></div>`;
}

function renderSettings() {
  const s = state.settings[state.analysis];
  const intro = `<p class="panel-intro">Settings for <b>${esc(ANALYSES.find((a) => a.id === state.analysis).title.toLowerCase())}</b>. The figure updates as you change them.</p>`;
  renderForm($("#panel-settings"), SETTINGS_SCHEMA[state.analysis](s), s, "set");
  $("#panel-settings").insertAdjacentHTML("afterbegin", intro);
}

function renderStyle() {
  renderForm($("#panel-style"), styleSchema(), state.style, "sty");
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
}

// ============================================================================
// Rendering: results
// ============================================================================
function renderEmptyStage() {
  lastResult = null;
  $("#error-box").hidden = true;
  $("#results").hidden = true;
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
    return;
  }
  err.hidden = true;
  const r = out.ok;
  lastResult = r;
  $("#figures").innerHTML = r.figures.map((f, i) => `
    <figure class="figure-card" style="margin:0">
      <div class="figure-head"><h3>${esc(f.title)}</h3>
        <button type="button" class="btn btn-small" data-export="${i}" data-format="png">PNG</button>
        <button type="button" class="btn btn-small" data-export="${i}" data-format="svg">SVG</button>
        <button type="button" class="btn btn-small" data-export="${i}" data-format="pdf">PDF</button>
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
    <p class="methods-text">Download a Python script that reproduces this exact analysis: your data, settings and style are built in. Anyone can rerun it with <code>pip install numpy scipy pandas matplotlib</code> and <code>python script.py</code>. Useful for reviewers, lab records and customizing beyond the menus.</p>
    <div><button type="button" class="btn btn-primary btn-small" id="btn-script">Download Python script</button></div>
    <pre class="code-peek">${esc(scriptPeek())}</pre>`;
  $("#results").hidden = false;
}

// ============================================================================
// Exports
// ============================================================================
async function getEngineSource() {
  if (!engineSource) engineSource = await (await fetch("engine/lablens.py")).text();
  return engineSource;
}

function scriptTail() {
  const a = runArgs();
  return `CONFIG_JSON = ${JSON.stringify(JSON.stringify(a.config, null, 1))}\nDATASETS_JSON = ${JSON.stringify(JSON.stringify(a.datasets))}\n\nif __name__ == "__main__":\n    cli(CONFIG_JSON, DATASETS_JSON, out_dir="lablens_output")\n`;
}

function scriptPeek() {
  const c = state.settings[state.analysis];
  const lines = [
    `# ${state.name}`,
    `# Analysis: ${ANALYSES.find((a) => a.id === state.analysis).title}`,
    `# Tables: ${state.datasets.length}`,
    `#`,
    `# ... LabLens engine (about 1,000 lines of documented Python) ...`,
    ``,
    `CONFIG = {`,
    `    "analysis": "${state.analysis}",`,
    ...Object.entries(c).slice(0, 8).map(([k, v]) => `    "${k}": ${JSON.stringify(v)},`),
    `    ...`,
    `}`,
    ``,
    `cli(CONFIG, DATASETS)  # saves PNG, PDF, SVG and CSV files to ./lablens_output`,
  ];
  return lines.join("\n");
}

async function downloadScript() {
  const src = await getEngineSource();
  const head = `# -*- coding: utf-8 -*-\n# ${state.name}\n# Generated by LabLens on ${new Date().toISOString().slice(0, 10)}.\n#\n# Reproduces the analysis exactly: data, settings and figure style are included below.\n# Requirements: pip install numpy scipy pandas matplotlib\n# Run:          python ${slug(state.name)}.py\n# Output:       figures (PNG, PDF, SVG) and tables (CSV) in ./lablens_output\n\n`;
  download(slug(state.name) + ".py", head + src + "\n\n# ---- This analysis ----\n" + scriptTail(), "text/x-python");
}

async function exportFigure(index, format) {
  const out = await call("export", { index, format, dpi: parseInt(state.style.dpi, 10) || 300, transparent: !!state.style.transparent });
  if (out.error) return toast(out.error);
  const types = { png: "image/png", svg: "image/svg+xml", pdf: "application/pdf" };
  const fig = lastResult?.figures[index];
  download(`${slug(state.name)}_${fig ? fig.id : index}.${format}`, b64ToBlob(out.ok, types[format]));
}

function saveProject() {
  download(slug(state.name) + ".lablens.json", JSON.stringify(state, null, 1), "application/json");
  toast("Project saved to your downloads");
}

// ============================================================================
// Events
// ============================================================================
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
    changed({ run: false });
  });

  // Analysis step
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

  // Data step
  const pd = $("#panel-data");
  pd.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("#btn-add")) {
      newDataset(nextName());
      renderData();
      $("#ds-text")?.focus();
      changed({ run: false });
    } else if (t.closest("#btn-upload")) {
      $("#upload-file").click();
    } else if (t.closest("[data-select]")) {
      state.active = t.closest("[data-select]").dataset.select;
      renderData();
      autosave();
    } else if (t.closest("#btn-delete")) {
      armConfirm(t.closest("#btn-delete"), "Click again to delete", () => {
        state.datasets = state.datasets.filter((d) => d.id !== state.active);
        state.active = state.datasets[0]?.id || null;
        renderData();
        changed({ clearExample: true });
      });
    }
  });
  pd.addEventListener("change", (e) => {
    if (e.target.id === "upload-file" && e.target.files.length) addFiles(Array.from(e.target.files));
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
      changed({ clearExample: false });
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
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
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

  // Results
  $(".stage").addEventListener("click", (e) => {
    const ex = e.target.closest("[data-export]");
    if (ex) return exportFigure(+ex.dataset.export, ex.dataset.format);
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

  // Project
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
      renderAll();
      changed();
      toast("Opened " + f.name);
    } catch (err) {
      toast("That file isn't a LabLens project.");
    }
  });
  $("#btn-new").addEventListener("click", (e) => {
    armConfirm(e.currentTarget, "Discard current?", () => {
      const keepStyle = state.style;
      state = freshState();
      state.style = keepStyle;
      state.step = "analysis";
      renderAll();
      renderEmptyStage();
      changed({ run: false });
    });
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveProject();
    }
  });
}

// ============================================================================
// Start
// ============================================================================
bindEvents();
if (!restore()) {
  state.analysis = "timecourse";
  queuedExample = "timecourse";
}
renderAll();
