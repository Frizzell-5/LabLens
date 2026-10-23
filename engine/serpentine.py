"""Serpentine analysis engine.

Runs inside the browser (Pyodide web worker) and as an ordinary Python script.
Everything goes through `api(cmd, args_json)`, which returns a JSON string.
"""

import base64
import csv
import io
import json
import logging
import math
import re
import sys
import textwrap
import traceback

import numpy as np
import pandas as pd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402
from matplotlib.colors import to_rgba, to_rgb, to_hex  # noqa: E402
from matplotlib.ticker import FuncFormatter, MultipleLocator, FormatStrFormatter, LogLocator, NullFormatter  # noqa: E402
import scipy  # noqa: E402
from scipy import stats  # noqa: E402
from scipy.optimize import curve_fit  # noqa: E402

logging.getLogger("matplotlib.font_manager").setLevel(logging.ERROR)

ENGINE_VERSION = "0.2.1"


class UserError(Exception):
    """A problem the user can fix (shown as-is in the app)."""


# ----------------------------------------------------------------------------
# Parsing
# ----------------------------------------------------------------------------

_CLOCK = re.compile(r"^-?\d+:\d{1,2}(:\d{1,2})?(\.\d+)?$")
_THOUSANDS = re.compile(r"^-?\d{1,3}(,\d{3})+(\.\d+)?$")
_DEC_COMMA = re.compile(r"^-?\d*,\d+$")
_MISSING = {"", "nan", "na", "n/a", "-", "--", "null", "none", "#n/a", "#value!", "#div/0!", "#num!"}


def _num(cell, comma_decimal=False):
    s = str(cell).strip().replace("−", "-")
    if s.lower() in _MISSING:
        return None
    if s.endswith("%"):
        s = s[:-1].strip()
    if comma_decimal:
        if "," in s:
            s = s.replace(".", "").replace(",", ".")
    elif _THOUSANDS.match(s):
        s = s.replace(",", "")
    elif _DEC_COMMA.match(s):
        s = s.replace(",", ".")
    try:
        v = float(s)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def _clock(cell):
    s = str(cell).strip().replace("−", "-")
    if not _CLOCK.match(s):
        return None
    neg = s.startswith("-")
    try:
        vals = [float(p) for p in s.lstrip("-").split(":")]
    except ValueError:
        return None
    sec = vals[0] * 60 + vals[1] if len(vals) == 2 else vals[0] * 3600 + vals[1] * 60 + vals[2]
    return -sec if neg else sec


def _is_value(cell, comma_decimal):
    return _num(cell, comma_decimal) is not None or _clock(cell) is not None


def read_table(text):
    """Parse pasted or exported text (LabChart Data Pad, Excel, Prism, CSV) into a DataFrame.

    Returns (df, info). Numeric and clock-time columns become floats (clock times in seconds);
    other columns stay text. info["kinds"] maps column -> "number" | "time" | "text".
    """
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    lines = [ln for ln in text.split("\n") if ln.strip() != ""]
    if not lines:
        raise UserError("This table is empty. Paste data or upload a file.")
    sample = "\n".join(lines[:30])
    if "\t" in sample:
        sep, sep_name = "\t", "tab"
    elif sample.count(";") > sample.count(","):
        sep, sep_name = ";", "semicolon"
    else:
        sep, sep_name = ",", "comma"
    comma_decimal = sep == ";"
    rows = list(csv.reader(lines, delimiter=sep))
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]

    # The first row where most cells are values is where the data starts;
    # everything above it (up to 3 rows) is joined into the column names.
    start = None
    for i, r in enumerate(rows[:50]):
        filled = [c for c in r if str(c).strip() != ""]
        if filled and sum(_is_value(c, comma_decimal) for c in filled) >= max(1, 0.5 * len(filled)):
            start = i
            break
    if start is None:
        start = 1 if len(rows) > 1 else 0
    header_rows = rows[max(0, start - 3):start]
    names = []
    for j in range(width):
        bits = [str(h[j]).strip() for h in header_rows if str(h[j]).strip()]
        names.append(" ".join(bits) or "Column %d" % (j + 1))
    seen = {}
    for j, n in enumerate(names):
        if n in seen:
            seen[n] += 1
            names[j] = "%s (%d)" % (n, seen[n])
        else:
            seen[n] = 1

    body = rows[start:]
    cols, kinds = {}, {}
    for j, name in enumerate(names):
        raw = [r[j] for r in body]
        filled = [c for c in raw if str(c).strip().lower() not in _MISSING]
        if not filled:
            continue
        nums = [_num(c, comma_decimal) for c in raw]
        clocks = [_clock(c) for c in raw]
        n_num = sum(x is not None for x in nums)
        n_clock = sum(x is not None for x in clocks)
        if n_clock and (n_clock + n_num) >= 0.6 * len(filled):
            vals = [c if c is not None else (n if n is not None else np.nan) for c, n in zip(clocks, nums)]
            cols[name], kinds[name] = np.array(vals, float), "time"
        elif n_num >= 0.6 * len(filled):
            cols[name], kinds[name] = np.array([x if x is not None else np.nan for x in nums], float), "number"
        else:
            cols[name], kinds[name] = [str(c).strip() for c in raw], "text"
    if not cols:
        raise UserError("No columns with data were found.")
    df = pd.DataFrame(cols)
    value_cols = [c for c in df.columns if kinds[c] != "text"]
    if value_cols:
        keep = df[value_cols].notna().any(axis=1)
        text_cols = [c for c in df.columns if kinds[c] == "text"]
        if text_cols:
            keep |= (df[text_cols] != "").any(axis=1)
        df = df[keep].reset_index(drop=True)
    info = {"kinds": kinds, "separator": sep_name, "header_rows": len(header_rows), "n_rows": len(df)}
    return df, info


def _labels(df, col, info):
    """A column as display strings, so numeric group codes read as 1, 2, 3 rather than 1.0."""
    kind = info["kinds"].get(col)
    if kind == "number":
        return df[col].map(lambda v: _fmt(v) if isinstance(v, float) and math.isfinite(v) else "")
    if kind == "time":
        return df[col].map(lambda v: _fmt_clock(v) if isinstance(v, float) and math.isfinite(v) else "")
    return df[col].astype(str).str.strip()


def inspect(text):
    df, info = read_table(text)
    preview = []
    for _, row in df.head(8).iterrows():
        cells = []
        for c in df.columns:
            v = row[c]
            if info["kinds"][c] == "time" and isinstance(v, float) and np.isfinite(v):
                cells.append(_fmt_clock(v))
            elif isinstance(v, float):
                cells.append("" if not np.isfinite(v) else _fmt(v))
            else:
                cells.append(str(v))
        preview.append(cells)
    return {
        "columns": [{"name": c, "kind": info["kinds"][c]} for c in df.columns],
        "n_rows": info["n_rows"],
        "separator": info["separator"],
        "preview": preview,
    }


def excel_to_tables(b64):
    raw = base64.b64decode(b64)
    try:
        sheets = pd.read_excel(io.BytesIO(raw), sheet_name=None, header=None, dtype=str)
    except Exception as e:
        raise UserError("Couldn't read this Excel file (%s). Try saving it as .xlsx or CSV." % e)
    out = []
    for name, sdf in sheets.items():
        sdf = sdf.dropna(how="all").dropna(axis=1, how="all").fillna("")
        if sdf.empty:
            continue
        out.append({"name": str(name), "text": sdf.to_csv(sep="\t", index=False, header=False)})
    if not out:
        raise UserError("The workbook has no sheets with data.")
    return out


# ----------------------------------------------------------------------------
# Formatting helpers
# ----------------------------------------------------------------------------

def _fmt(x):
    if x is None or not np.isfinite(x):
        return ""
    if x == 0:
        return "0"
    a = abs(x)
    if a >= 1e5 or a < 1e-3:
        return "%.3g" % x
    return "%.4g" % x


def _fmt_clock(sec):
    neg = sec < 0
    sec = abs(sec)
    m, s = divmod(sec, 60)
    h, m = divmod(int(m), 60)
    s_txt = ("%04.1f" % s) if abs(s - round(s)) > 1e-6 else "%02d" % round(s)
    txt = ("%d:%02d:%s" % (h, m, s_txt)) if h else ("%d:%s" % (m, s_txt))
    return "-" + txt if neg else txt


def fmt_p(p):
    if p is None or not np.isfinite(p):
        return "p = n/a"
    if p < 0.0001:
        return "p < 0.0001"
    if p < 0.001:
        return "p = %.4f" % p
    return "p = %.3f" % p


def stars(p):
    if p is None or not np.isfinite(p):
        return "ns"
    for cut, s in ((0.0001, "****"), (0.001, "***"), (0.01, "**"), (0.05, "*")):
        if p < cut:
            return s
    return "ns"


def _r(x, digits=6):
    """Round for JSON output (keeps NaN as None)."""
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return x
    if not np.isfinite(x):
        return None
    if x == 0:
        return 0.0
    return float("%.*g" % (digits, x))


def _holm(ps):
    ps = np.asarray(ps, float)
    n = len(ps)
    adj = np.empty(n)
    running = 0.0
    for rank, idx in enumerate(np.argsort(ps)):
        running = max(running, min(1.0, (n - rank) * ps[idx]))
        adj[idx] = running
    return adj


# ----------------------------------------------------------------------------
# Style
# ----------------------------------------------------------------------------

PALETTES = {
    "serpentine": ["#2F5D8A", "#D1495B", "#E9A23B", "#00798C", "#6B4E9B", "#7A7A7A", "#3E8E41", "#B5651D"],
    "okabe": ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#CC79A7", "#56B4E9", "#F0E442", "#000000"],
    "tol": ["#4477AA", "#EE6677", "#228833", "#CCBB44", "#66CCEE", "#AA3377", "#BBBBBB"],
    "muted": ["#4C72B0", "#DD8452", "#55A868", "#C44E52", "#8172B3", "#937860", "#DA8BC3", "#8C8C8C"],
    "pastel": ["#8DA0CB", "#FC8D62", "#66C2A5", "#E78AC3", "#A6D854", "#FFD92F", "#E5C494", "#B3B3B3"],
    "ocean": ["#023E8A", "#0096C7", "#48CAE4", "#03045E", "#00B4D8", "#90E0EF"],
    "sunset": ["#3D348B", "#F18701", "#7678ED", "#F35B04", "#F7B801", "#9B2226"],
    "earth": ["#5F7161", "#C9A66B", "#8C5E58", "#A3B18A", "#3A5A40", "#DDB892"],
    "neon": ["#00F5D4", "#F15BB5", "#FEE440", "#00BBF9", "#9B5DE5", "#F72585"],
    "grayscale": ["#1F1F1F", "#8A8A8A", "#C4C4C4", "#525252", "#A8A8A8", "#6E6E6E"],
}
QUALITATIVE_CMAPS = {"tab10", "tab20", "tab20b", "tab20c", "Set1", "Set2", "Set3", "Dark2", "Paired",
                     "Accent", "Pastel1", "Pastel2"}

# Fonts that ship with matplotlib, plus web fonts the app downloads into the engine on demand.
FONTS = {
    "sans": ["Arial", "Helvetica", "Liberation Sans", "DejaVu Sans"],
    "serif": ["Times New Roman", "Times", "Liberation Serif", "DejaVu Serif"],
    "mono": ["Menlo", "Consolas", "DejaVu Sans Mono"],
    "lato": ["Lato", "DejaVu Sans"],
    "fira": ["Fira Sans", "DejaVu Sans"],
    "barlow": ["Barlow", "DejaVu Sans"],
    "poppins": ["Poppins", "DejaVu Sans"],
    "ptserif": ["PT Serif", "DejaVu Serif"],
    "crimson": ["Crimson Text", "DejaVu Serif"],
    "courier": ["Courier Prime", "DejaVu Sans Mono"],
    "spacemono": ["Space Mono", "DejaVu Sans Mono"],
    "comic": ["Comic Neue", "DejaVu Sans"],
}

# Everything about how a figure looks (presets reset these). Content fields such as titles,
# axis limits and per-group settings live in STYLE_DEFAULTS only.
LOOK_DEFAULTS = {
    "width": 4.0, "height": 3.4, "theme": "light", "bg_color": "", "axes_color": "", "ink_color": "",
    "font": "sans", "font_size": 10, "title_size": "", "label_size": "", "tick_size": "",
    "title_bold": True, "label_bold": False, "title_align": "center",
    "palette": "serpentine", "palette_reverse": False,
    "plot_kind": "bar", "orientation": "vertical", "bar_width": 0.62, "jitter": 0.12,
    "fill": "light", "fill_alpha": 0.25, "edge_width": "",
    "show_points": True, "point_shape": "o", "marker_size": 5.0, "point_alpha": 0.85,
    "point_edge": "auto", "point_edge_width": 0.5,
    "line_width": 1.5, "axis_width": "", "error": "sem", "error_dir": "both", "cap_size": "", "error_width": "",
    "line_markers": False, "band_alpha": 0.18, "trace_alpha": 0.35,
    "sig": "stars", "show_ns": False, "sig_size": "", "show_n": False,
    "spine_left": True, "spine_bottom": True, "spine_top": False, "spine_right": False,
    "offset_axes": 0, "trim_axes": False, "tick_dir": "out", "tick_length": 3.5, "minor_ticks": False,
    "cat_ticks": False, "grid": "none", "grid_style": "solid", "grid_alpha": 0.15,
    "legend": "best", "legend_frame": False, "legend_cols": 1,
}
STYLE_DEFAULTS = dict(LOOK_DEFAULTS, **{
    "custom_colors": "", "groups": {}, "title": "", "xlabel": "", "ylabel": "", "legend_title": "",
    "ymin": "", "ymax": "", "xmin": "", "xmax": "", "logy": False, "logx": False,
    "ytick_step": "", "xtick_step": "", "y_decimals": "", "xrot": 0, "panel_label": "", "ref_lines": "",
    "endpoint_width": "", "dpi": 300, "transparent": False, "custom_rc": "", "custom_code": "",
})

NUMERIC = {  # key: (default, low, high); default None means "derived from another setting"
    "width": (4.0, 1.0, 30), "height": (3.4, 1.0, 30), "font_size": (10, 4, 48),
    "title_size": (None, 4, 72), "label_size": (None, 4, 72), "tick_size": (None, 3, 72),
    "line_width": (1.5, 0.1, 12), "axis_width": (None, 0.1, 12), "marker_size": (5.0, 0.5, 40),
    "point_alpha": (0.85, 0, 1), "fill_alpha": (0.25, 0, 1), "bar_width": (0.62, 0.05, 1.0),
    "jitter": (0.12, 0, 0.45), "edge_width": (None, 0, 12), "point_edge_width": (0.5, 0, 6),
    "cap_size": (None, 0, 30), "error_width": (None, 0.1, 12), "sig_size": (None, 4, 72),
    "offset_axes": (0, 0, 60), "tick_length": (3.5, 0, 25), "xrot": (0, -90, 90), "legend_cols": (1, 1, 12),
    "grid_alpha": (0.15, 0, 1), "band_alpha": (0.18, 0, 1), "trace_alpha": (0.35, 0, 1), "dpi": (300, 50, 2400),
    "endpoint_width": (None, 1.0, 30),
}


def _color_or(c, fallback):
    c = (c or "").strip() if isinstance(c, str) else c
    if not c:
        return fallback
    try:
        to_rgb(c)
        return c
    except (ValueError, TypeError):
        return fallback


def _parse_rc(text, notes):
    out = {}
    for line in str(text or "").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        if ":" not in line and "=" not in line:
            notes.append('Matplotlib setting "%s" needs the form key: value.' % line)
            continue
        key, val = re.split(r"\s*[:=]\s*", line, maxsplit=1)
        key = key.strip()
        if key not in matplotlib.rcParams:
            notes.append('"%s" isn\'t a matplotlib setting.' % key)
            continue
        try:
            out[key] = matplotlib.rcParams.validate[key](val.strip().strip("'\""))
        except Exception as e:
            notes.append('Matplotlib setting %s: %s' % (key, e))
    return out


def _style(style):
    raw = dict(style or {})
    # Older projects used a single despine switch and a boolean grid.
    if "despine" in raw and "spine_top" not in raw:
        raw["spine_top"] = raw["spine_right"] = not raw.get("despine", True)
    if isinstance(raw.get("grid"), bool):
        raw["grid"] = "both" if raw["grid"] else "none"
    s = dict(STYLE_DEFAULTS)
    for k, v in raw.items():
        if v is not None:
            s[k] = v
    for k, (default, lo, hi) in NUMERIC.items():
        try:
            v = float(s.get(k))
            s[k] = min(max(v, lo), hi) if math.isfinite(v) else default
        except (TypeError, ValueError):
            s[k] = default
    fs = s["font_size"]
    lw = s["line_width"]
    s["title_size"] = s["title_size"] or fs * 1.15
    s["label_size"] = s["label_size"] or fs
    s["tick_size"] = s["tick_size"] or fs * 0.9
    s["sig_size"] = s["sig_size"] or fs
    s["axis_width"] = s["axis_width"] or max(0.6, lw * 0.6)
    s["edge_width"] = lw if s["edge_width"] is None else s["edge_width"]
    s["error_width"] = s["error_width"] or lw
    s["cap_size"] = s["marker_size"] * 0.9 if s["cap_size"] is None else s["cap_size"]
    dark = s["theme"] == "dark"
    s["fg"] = _color_or(s["ink_color"], "#E6E8EC" if dark else "#1A1D23")
    s["bg"] = _color_or(s["bg_color"], "#15181D" if dark else "#FFFFFF")
    s["ax_bg"] = _color_or(s["axes_color"], s["bg"])
    if not isinstance(s.get("groups"), dict):
        s["groups"] = {}
    s["_notes"] = []
    s["_rc"] = _parse_rc(s.get("custom_rc"), s["_notes"])
    return s


def _colors(s, n):
    n = max(n, 1)
    pal = str(s.get("palette") or "serpentine")
    if pal == "lablens":  # name before the rename
        pal = "serpentine"
    if pal.startswith("cmap:"):
        name = pal[5:]
        try:
            cmap = matplotlib.colormaps[name]
        except KeyError:
            cmap = matplotlib.colormaps["viridis"]
            name = "viridis"
        if name in QUALITATIVE_CMAPS:
            base = [to_hex(cmap(i % cmap.N)) for i in range(n)]
        else:
            base = [to_hex(cmap(x)) for x in (np.linspace(0.12, 0.88, n) if n > 1 else [0.5])]
    else:
        src = PALETTES.get(pal, PALETTES["serpentine"])
        base = [src[i % len(src)] for i in range(n)]
    if s.get("palette_reverse"):
        base = base[::-1]
    custom = [c.strip() for c in re.split(r"[,\s]+", s.get("custom_colors") or "") if c.strip()]
    for i, c in enumerate(custom[:n]):
        base[i] = _color_or(c, base[i])
    return base


def _gstyles(s, names):
    """Per-group colour, marker, hatch, line style and display label."""
    cols = _colors(s, len(names))
    out = []
    for i, nm in enumerate(names):
        g = s["groups"].get(str(nm)) or {}
        if not isinstance(g, dict):
            g = {}
        out.append({
            "name": nm,
            "label": (g.get("label") or "").strip() or str(nm),
            "color": _color_or(g.get("color"), cols[i]),
            "marker": g.get("marker") or s["point_shape"] or "o",
            "hatch": g.get("hatch") or None,
            "ls": g.get("linestyle") or "-",
        })
    return out


def _rc(s):
    fs = s["font_size"]
    tl = s["tick_length"]
    aw = s["axis_width"]
    rc = {
        "font.family": FONTS.get(s.get("font"), FONTS["sans"]),
        "font.size": fs,
        "axes.titlesize": s["title_size"],
        "axes.titleweight": "bold" if s.get("title_bold") else "normal",
        "axes.titlelocation": s["title_align"] if s["title_align"] in ("left", "center", "right") else "center",
        "axes.labelsize": s["label_size"],
        "axes.labelweight": "bold" if s.get("label_bold") else "normal",
        "xtick.labelsize": s["tick_size"],
        "ytick.labelsize": s["tick_size"],
        "legend.fontsize": fs * 0.85,
        "legend.title_fontsize": fs * 0.9,
        "axes.linewidth": aw,
        "xtick.major.width": aw, "ytick.major.width": aw,
        "xtick.minor.width": aw * 0.7, "ytick.minor.width": aw * 0.7,
        "xtick.major.size": tl, "ytick.major.size": tl,
        "xtick.minor.size": tl * 0.55, "ytick.minor.size": tl * 0.55,
        "xtick.direction": s["tick_dir"] if s["tick_dir"] in ("in", "out", "inout") else "out",
        "ytick.direction": s["tick_dir"] if s["tick_dir"] in ("in", "out", "inout") else "out",
        "axes.edgecolor": s["fg"], "axes.labelcolor": s["fg"], "text.color": s["fg"],
        "xtick.color": s["fg"], "ytick.color": s["fg"],
        "figure.facecolor": s["bg"], "axes.facecolor": s["ax_bg"], "savefig.facecolor": s["bg"],
        "axes.grid": s["grid"] in ("x", "y", "both"),
        "axes.grid.axis": s["grid"] if s["grid"] in ("x", "y", "both") else "both",
        "grid.color": s["fg"], "grid.alpha": s["grid_alpha"], "grid.linewidth": max(0.4, aw * 0.8),
        "grid.linestyle": {"dashed": "--", "dotted": ":"}.get(s["grid_style"], "-"),
        "axes.axisbelow": True,
        "legend.frameon": bool(s["legend_frame"]), "legend.edgecolor": s["fg"], "legend.facecolor": s["ax_bg"],
        "legend.framealpha": 0.9,
        "hatch.color": s["fg"], "hatch.linewidth": max(0.5, s["line_width"] * 0.5),
        "svg.fonttype": "none", "pdf.fonttype": 42,
    }
    rc.update(s.get("_rc") or {})
    return rc


def register_fonts(paths):
    for p in paths:
        try:
            font_manager.fontManager.addfont(p)
        except Exception:
            pass
    cache = getattr(font_manager.fontManager, "_findfont_cached", None)
    if cache is not None and hasattr(cache, "cache_clear"):
        cache.cache_clear()
    return True


def _new_fig(s, width=None):
    with plt.rc_context(_rc(s)):
        fig, ax = plt.subplots(figsize=(width or s["width"], s["height"]))
    return fig, ax


def _shade(color, amount):
    """amount < 0 darkens, > 0 lightens."""
    r, g, b = to_rgb(color)
    if amount < 0:
        f = 1 + amount
        return (r * f, g * f, b * f)
    return (r + (1 - r) * amount, g + (1 - g) * amount, b + (1 - b) * amount)


def _point_edge(s, face):
    pe = s.get("point_edge") or "auto"
    if pe == "auto":
        return to_rgba(s["bg"], 0.9)
    if pe == "none":
        return "none"
    if pe == "dark":
        return _shade(face, -0.45)
    if pe == "ink":
        return s["fg"]
    return _color_or(pe, to_rgba(s["bg"], 0.9))


# Plain numbers (0.1, 1, 10) on log axes; scientific superscripts read poorly as editable SVG text.
_LOG_FMT = FuncFormatter(lambda v, _: ("%g" % v) if 1e-4 <= v < 1e6 else ("%.0e" % v))


def _limit(get, set_, lo_txt, hi_txt):
    lo, hi = get()
    try:
        lo = float(lo_txt) if str(lo_txt).strip() != "" else lo
    except ValueError:
        pass
    try:
        hi = float(hi_txt) if str(hi_txt).strip() != "" else hi
    except ValueError:
        pass
    if hi > lo:
        set_(lo, hi)


def _finish(ax, s, xlabel="", ylabel="", title="", legend=False, title_pad=None):
    """Labels, scales, limits, ticks and legend. `ax._ll_cat` marks a category axis ('x' or 'y')."""
    cat = getattr(ax, "_ll_cat", None)
    ax.set_xlabel(s["xlabel"] or xlabel)
    ax.set_ylabel(s["ylabel"] or ylabel)
    t = s["title"] or title
    if t:
        ax.set_title(t, pad=title_pad or 10)
    value_axis = "x" if cat == "y" else "y"
    if s["logy"]:
        (ax.set_xscale if value_axis == "x" else ax.set_yscale)("log")
    if s["logx"] and cat is None:
        ax.set_xscale("log")
    for axis, get in ((ax.xaxis, ax.get_xlim), (ax.yaxis, ax.get_ylim)):
        if axis.get_scale() == "log":
            axis.set_major_formatter(_LOG_FMT)
            lo, hi = sorted(get())
            decades = math.log10(hi / lo) if lo > 0 and hi > 0 else 99
            if decades < 1.5:  # few or no powers of ten in view: label 2 and 5 times them as plain numbers
                axis.set_minor_locator(LogLocator(base=10, subs=(2.0, 5.0)))
                axis.set_minor_formatter(_LOG_FMT)
            else:
                axis.set_minor_formatter(NullFormatter())
    if cat != "y":
        _limit(ax.get_ylim, ax.set_ylim, s["ymin"], s["ymax"])
    else:
        _limit(ax.get_ylim, lambda lo, hi: None, "", "")
    if cat != "x":
        _limit(ax.get_xlim, ax.set_xlim, s["xmin"], s["xmax"])
    for key, axis, numeric in (("ytick_step", ax.yaxis, cat != "y"), ("xtick_step", ax.xaxis, cat != "x")):
        try:
            step = float(s[key])
            if numeric and step > 0 and axis.get_scale() == "linear":
                axis.set_major_locator(MultipleLocator(step))
        except (TypeError, ValueError):
            pass
    try:
        dec = int(float(s["y_decimals"]))
        vaxis = ax.xaxis if value_axis == "x" else ax.yaxis
        if 0 <= dec <= 8 and vaxis.get_scale() == "linear":
            vaxis.set_major_formatter(FormatStrFormatter("%%.%df" % dec))
    except (TypeError, ValueError):
        pass
    if s["minor_ticks"]:
        ax.minorticks_on()
        if cat:
            ax.tick_params(axis=cat, which="minor", length=0, width=0)
    if cat and not s["cat_ticks"]:
        ax.tick_params(axis=cat, which="major", length=0)
    if s["xrot"]:
        for lab in ax.get_xticklabels():
            lab.set_rotation(s["xrot"])
            lab.set_ha("right" if 0 < s["xrot"] < 90 else ("left" if -90 < s["xrot"] < 0 else "center"))
            lab.set_rotation_mode("anchor")
    if legend and s["legend"] != "none":
        handles, labels = ax.get_legend_handles_labels()
        if handles:
            kw = {"ncol": int(s["legend_cols"]), "title": s["legend_title"] or None, "frameon": bool(s["legend_frame"])}
            if s["legend"] == "outside":
                ax.legend(loc="center left", bbox_to_anchor=(1.02, 0.5), **kw)
            elif s["legend"] == "outside top":
                kw["ncol"] = max(kw["ncol"], len(handles))
                ax.legend(loc="lower center", bbox_to_anchor=(0.5, 1.02), **kw)
            else:
                ax.legend(loc=s["legend"], **kw)


def _parse_ref_lines(text):
    out = []
    for part in re.split(r"[;\n]", str(text or "")):
        part = part.strip()
        if not part:
            continue
        label = ""
        if ":" in part:
            part, label = [x.strip() for x in part.split(":", 1)]
        m = re.match(r"^([xy])\s*=\s*(x|-?[\d.eE+-]+)$", part.replace(" ", ""))
        if not m:
            raise UserError('Couldn\'t read the reference line "%s". Use y=100, x=0 or y=x.' % part)
        out.append((m.group(1), m.group(2), label))
    return out


def _polish(fig, s, notes):
    """Final pass on every axes: axis lines, offsets, trimming, reference lines, panel letter."""
    for i, ax in enumerate(fig.axes):
        cat = getattr(ax, "_ll_cat", None)
        try:
            for axis, val, label in _parse_ref_lines(s["ref_lines"]):
                kw = dict(color=to_rgba(s["fg"], 0.55), lw=max(0.6, s["line_width"] * 0.6), ls=(0, (4, 3)), zorder=1)
                if val == "x":
                    (x0, x1), (y0, y1) = ax.get_xlim(), ax.get_ylim()
                    lo, hi = max(min(x0, y0), 1e-12) if ax.get_xscale() == "log" else min(x0, y0), max(x1, y1)
                    ax.axline((lo, lo), (hi, hi), **kw)  # two points work on log axes too
                    ax.set_xlim(x0, x1)
                    ax.set_ylim(y0, y1)
                    continue
                v = float(val)
                if axis == "y":
                    ax.axhline(v, **kw)
                    if label:
                        ax.annotate(label, xy=(1, v), xycoords=("axes fraction", "data"), xytext=(-3, 3),
                                    textcoords="offset points", ha="right", va="bottom",
                                    fontsize=s["font_size"] * 0.8, color=to_rgba(s["fg"], 0.75))
                else:
                    ax.axvline(v, **kw)
                    if label:
                        ax.annotate(label, xy=(v, 1), xycoords=("data", "axes fraction"), xytext=(3, -3),
                                    textcoords="offset points", ha="left", va="top",
                                    fontsize=s["font_size"] * 0.8, color=to_rgba(s["fg"], 0.75))
        except UserError as e:
            if i == 0:
                notes.append(str(e))
        for side in ("left", "bottom", "top", "right"):
            sp = ax.spines[side]
            sp.set_visible(bool(s["spine_" + side]))
            sp.set_color(s["fg"])
            if s["offset_axes"]:
                sp.set_position(("outward", s["offset_axes"]))
        if not s["spine_top"] and not s["spine_bottom"]:
            ax.tick_params(axis="x", which="both", bottom=False, top=False)
        elif s["spine_top"] and not s["spine_bottom"]:
            ax.tick_params(axis="x", which="both", bottom=False, top=True, labelbottom=True)
        if not s["spine_left"] and not s["spine_right"]:
            ax.tick_params(axis="y", which="both", left=False, right=False)
        elif s["spine_right"] and not s["spine_left"]:
            ax.tick_params(axis="y", which="both", left=False, right=True, labelleft=True)
        if s["trim_axes"]:
            for which, sides, get, ticks in (("x", ("bottom", "top"), ax.get_xlim, ax.get_xticks),
                                             ("y", ("left", "right"), ax.get_ylim, ax.get_yticks)):
                lo, hi = sorted(get())
                tk = [t for t in ticks() if lo - 1e-9 <= t <= hi + 1e-9]
                if cat == which:
                    tk = [t for t in tk if float(t).is_integer()] or tk
                if len(tk) >= 2:
                    for side in sides:
                        ax.spines[side].set_bounds(min(tk), max(tk))
        if i == 0 and str(s["panel_label"]).strip():
            ax.annotate(str(s["panel_label"]).strip(), xy=(0, 1), xycoords="axes fraction",
                        xytext=(-s["font_size"] * 3.4, s["font_size"] * 0.8), textcoords="offset points",
                        ha="left", va="bottom", fontsize=s["font_size"] * 1.6, fontweight="bold", color=s["fg"])


# ----------------------------------------------------------------------------
# Group plots + statistics
# ----------------------------------------------------------------------------

def _err(v, kind):
    v = v[np.isfinite(v)]
    n = len(v)
    if n < 2 or kind == "none":
        return 0.0
    sd = np.std(v, ddof=1)
    if kind == "sd":
        return sd
    sem = sd / math.sqrt(n)
    if kind == "ci95":
        return sem * stats.t.ppf(0.975, n - 1)
    return sem


ERROR_NAMES = {"sem": "SEM", "sd": "SD", "ci95": "95% CI", "none": ""}
PLOT_KINDS = ("bar", "dot", "mean", "box", "violin", "boxviolin", "raincloud", "beeswarm", "strip", "lollipop")


def _swarm_offsets(v, s, n_groups, value_span, horizontal):
    """Beeswarm: nudge points sideways just enough that markers don't overlap."""
    value_len = (s["width"] if horizontal else s["height"]) * 72 * 0.72
    cat_len = (s["height"] if horizontal else s["width"]) * 72 * 0.72
    d_val = s["marker_size"] * 1.08 / value_len * value_span
    d_cat = s["marker_size"] * 1.08 / (cat_len / (n_groups + 0.2))
    offs = np.zeros(len(v))
    placed = []
    for idx in np.argsort(np.where(np.isfinite(v), v, np.inf)):
        val = v[idx]
        if not np.isfinite(val):
            continue
        near = [(pv, po) for pv, po in placed if abs(pv - val) < d_val]
        cand = 0.0
        for k in range(400):
            cand = 0.0 if k == 0 else ((k + 1) // 2) * d_cat * (1 if k % 2 else -1)
            if all(((val - pv) / d_val) ** 2 + ((cand - po) / d_cat) ** 2 >= 1 for pv, po in near):
                break
        offs[idx] = cand
        placed.append((val, cand))
    widest = np.max(np.abs(offs)) if len(offs) else 0
    if widest > 0.42:
        offs *= 0.42 / widest
    return offs


def plot_groups(ax, names, values, s, paired_matrix=None):
    """Draw one category per group. values: list of 1-D arrays. Returns the top of each group."""
    G = _gstyles(s, names)
    n = len(names)
    H = s["orientation"] == "horizontal"
    kind = s["plot_kind"] if s["plot_kind"] in PLOT_KINDS else "bar"
    fg, bg = s["fg"], s["bg"]
    lw, ew, ms, bw = s["line_width"], s["edge_width"], s["marker_size"], s["bar_width"]
    rng = np.random.default_rng(7)
    cats = np.arange(n, dtype=float)
    vals = [np.asarray(v, float) for v in values]
    finite_all = np.concatenate([v[np.isfinite(v)] for v in vals]) if vals else np.array([])
    span = float(np.ptp(finite_all)) * 1.2 if len(finite_all) > 1 and np.ptp(finite_all) > 0 else 1.0

    def XY(c, v):
        return (v, c) if H else (c, v)

    def face(g):
        if s["fill"] == "solid":
            return to_rgba(g["color"], 0.92)
        if s["fill"] == "outline":
            return (0, 0, 0, 0)
        return to_rgba(g["color"], s["fill_alpha"])

    def summary_color(g):
        return fg if s["fill"] == "solid" else g["color"]

    def errbar(c, m, e, color):
        if not e or s["error"] == "none":
            return
        if s["error_dir"] == "up":
            arr = [[0], [e]] if m >= 0 else [[e], [0]]
        else:
            arr = e
        kw = dict(fmt="none", ecolor=color, elinewidth=s["error_width"], capsize=s["cap_size"],
                  capthick=s["error_width"], zorder=4)
        if H:
            ax.errorbar(m, c, xerr=arr, **kw)
        else:
            ax.errorbar(c, m, yerr=arr, **kw)

    show_pts = bool(s["show_points"]) or kind in ("dot", "raincloud", "beeswarm", "strip")
    point_c = []
    for i, v in enumerate(vals):
        center = cats[i] + (0.24 if kind == "raincloud" else 0.0)
        if paired_matrix is not None:
            pc = np.full(len(v), center)
        elif kind == "beeswarm":
            pc = center + _swarm_offsets(v, s, n, span, H)
        else:
            w = 0.05 if kind == "raincloud" else (s["jitter"] * 1.35 if kind in ("dot", "strip") else s["jitter"])
            pc = center + rng.uniform(-w, w, len(v))
        point_c.append(pc)

    tops = []
    half = 0.36 * bw / 0.62
    for i, (v, g) in enumerate(zip(vals, G)):
        fin = v[np.isfinite(v)]
        c = cats[i]
        col = g["color"]
        if not len(fin):
            tops.append(0.0)
            continue
        m = float(np.mean(fin))
        e = _err(fin, s["error"])
        top = [m + e, float(fin.max())]
        if kind == "bar":
            kw = dict(color=face(g), edgecolor=col, linewidth=ew, hatch=g["hatch"], zorder=2)
            if H:
                ax.barh(c, m, height=bw, **kw)
            else:
                ax.bar(c, m, width=bw, **kw)
            errbar(c, m, e, summary_color(g))
        elif kind == "box":
            bp = ax.boxplot([fin], positions=[c], widths=bw * 0.8, patch_artist=True, vert=not H,
                            showfliers=not show_pts, zorder=2)
            for b in bp["boxes"]:
                b.set(facecolor=face(g), edgecolor=col, linewidth=ew, hatch=g["hatch"])
            for part in ("whiskers", "caps"):
                for ln in bp[part]:
                    ln.set(color=col, linewidth=ew)
            for ln in bp["medians"]:
                ln.set(color=summary_color(g), linewidth=max(ew, 0.5) * 1.4)
            for f in bp["fliers"]:
                f.set(marker=g["marker"], markeredgecolor=col, markersize=ms * 0.8)
        elif kind in ("violin", "raincloud", "boxviolin"):
            if len(fin) >= 2 and np.ptp(fin) > 0:
                width = {"violin": 1.2, "raincloud": 1.45, "boxviolin": 1.3}[kind] * bw
                vp = ax.violinplot([fin], positions=[c], widths=width, showextrema=False, vert=not H)
                for body in vp["bodies"]:
                    body.set_facecolor(face(g))
                    body.set_edgecolor(col)
                    body.set_linewidth(max(ew, 0.3) * 0.8)
                    body.set_alpha(None)
                    if g["hatch"]:
                        body.set_hatch(g["hatch"])
                    if kind == "raincloud":
                        verts = body.get_paths()[0].vertices
                        k = 1 if H else 0
                        verts[:, k] = np.minimum(verts[:, k], c)
                    body.set_zorder(2)
            q1, med, q3 = np.percentile(fin, [25, 50, 75])
            if kind == "boxviolin":
                bp = ax.boxplot([fin], positions=[c], widths=0.12 * bw / 0.62, patch_artist=True, vert=not H,
                                showfliers=False, zorder=3)
                for b in bp["boxes"]:
                    b.set(facecolor=bg, edgecolor=fg, linewidth=max(ew, 0.5) * 0.8)
                for part in ("whiskers", "caps"):
                    for ln in bp[part]:
                        ln.set(color=fg, linewidth=max(ew, 0.5) * 0.8)
                for ln in bp["medians"]:
                    ln.set(color=fg, linewidth=max(ew, 0.5) * 1.4)
            else:
                bx = c if kind == "violin" else c + 0.07
                ax.plot(*XY([bx, bx], [q1, q3]), color=fg, linewidth=lw * 2.6, solid_capstyle="butt", zorder=3)
                ax.scatter(*XY([bx], [med]), s=(ms * 1.1) ** 2, color=bg, edgecolor=fg,
                           linewidth=lw * 0.6, zorder=4)
        elif kind == "dot":
            ax.plot(*XY([c - half, c + half], [m, m]), color=summary_color(g), linewidth=lw * 1.6,
                    solid_capstyle="round", zorder=6)
            errbar(c, m, e, summary_color(g))
        elif kind == "mean":
            errbar(c, m, e, col)
            ax.scatter(*XY([c], [m]), s=(ms * 2.0) ** 2, marker=g["marker"], color=col,
                       edgecolor=_point_edge(s, col), linewidth=max(0.5, s["point_edge_width"]), zorder=6)
        elif kind == "lollipop":
            base = 0.0
            if s["logy"]:
                base = float(fin.min()) * 0.5 if fin.min() > 0 else 1e-3
            ax.plot(*XY([c, c], [base, m]), color=col, linewidth=lw * 1.4, zorder=3)
            errbar(c, m, e, col)
            ax.scatter(*XY([c], [m]), s=(ms * 2.2) ** 2, marker=g["marker"], color=col,
                       edgecolor=_point_edge(s, col), linewidth=max(0.5, s["point_edge_width"]), zorder=6)
        elif kind == "beeswarm":
            med = float(np.median(fin))
            ax.plot(*XY([c - half, c + half], [med, med]), color=fg, linewidth=lw * 1.4, zorder=6)
        tops.append(max(top))

    if paired_matrix is not None and n > 1:
        line_c = to_rgba(fg, 0.28)
        for row in paired_matrix:
            ax.plot(*XY([point_c[j][0] for j in range(n)], row), color=line_c,
                    linewidth=max(0.6, lw * 0.6), zorder=3)

    if show_pts:
        for i, (v, g) in enumerate(zip(vals, G)):
            ok = np.isfinite(v)
            pface = _shade(g["color"], -0.35) if s["fill"] == "solid" and kind in ("bar", "box", "lollipop") else g["color"]
            ax.scatter(*XY(point_c[i][ok], v[ok]), s=ms ** 2, marker=g["marker"],
                       color=to_rgba(pface, s["point_alpha"]), edgecolor=_point_edge(s, pface),
                       linewidth=s["point_edge_width"], zorder=5)

    labels = [g["label"] for g in G]
    if not H and not s["xrot"]:
        per_group_pt = s["width"] * 72 * 0.7 / max(1, n)
        chars = max(6, int(per_group_pt / (s["tick_size"] * 0.62)))
        labels = [textwrap.fill(lab, chars, break_long_words=False) for lab in labels]
    if s["show_n"]:
        labels = ["%s\n(n=%d)" % (lab, np.isfinite(v).sum()) for lab, v in zip(labels, vals)]
    if H:
        ax.set_yticks(cats)
        ax.set_yticklabels(labels)
        ax.set_ylim(n - 0.4, -0.6)
    else:
        ax.set_xticks(cats)
        ax.set_xticklabels(labels)
        ax.set_xlim(-0.6, n - 0.4)
    ax._ll_cat = "y" if H else "x"
    if kind in ("bar", "lollipop") and not s["logy"] and len(finite_all) and finite_all.min() >= 0:
        if H:
            ax.set_xlim(left=0)
        else:
            ax.set_ylim(bottom=0)
    return tops


def draw_brackets(ax, comparisons, tops, s):
    """comparisons: list of (i, j, p). Stacks brackets beyond the groups on the value axis."""
    show = [(i, j, p) for i, j, p in comparisons if s["show_ns"] or (p is not None and p < 0.05)]
    if s["sig"] == "none" or not show or not tops:
        return
    H = s["orientation"] == "horizontal"
    log = s["logy"]
    tr = (lambda y: math.log10(max(y, 1e-12))) if log else (lambda y: y)
    inv = (lambda y: 10 ** y) if log else (lambda y: y)
    lo, hi = ax.get_xlim() if H else ax.get_ylim()
    lo_t = tr(lo) if log else lo
    hi_t = tr(max(hi, max(tops)))
    span = (hi_t - lo_t) or 1.0
    gap, tick = span * 0.06, span * 0.025
    text_h = span * (0.075 if s["sig"] == "p" else 0.065) * s["sig_size"] / max(s["font_size"], 1)
    if H and s["sig"] == "stars":
        text_h *= 1.6  # unrotated stars are wider than they are tall
    level = [tr(t) if (t > 0 or not log) else lo_t for t in tops]
    top_used = hi_t
    for i, j, p in sorted(show, key=lambda c: (abs(c[1] - c[0]), c[0])):
        a, b = min(i, j), max(i, j)
        y = max(level[a:b + 1]) + gap
        cs = [a, a, b, b]
        vs = [inv(y - tick), inv(y), inv(y), inv(y - tick)]
        ax.plot(*((vs, cs) if H else (cs, vs)), color=s["fg"], linewidth=max(0.7, s["axis_width"]),
                clip_on=False, zorder=6)
        label = stars(p) if s["sig"] == "stars" else fmt_p(p)
        size = s["sig_size"] * (1.0 if s["sig"] == "stars" else 0.8)
        if H:
            ax.text(inv(y + span * 0.01), (a + b) / 2, label, ha="left", va="center",
                    rotation=-90 if s["sig"] == "p" else 0, fontsize=size, color=s["fg"], zorder=6)
        else:
            ax.text((a + b) / 2, inv(y + span * 0.005), label, ha="center", va="bottom",
                    fontsize=size, color=s["fg"], zorder=6)
        for k in range(a, b + 1):
            level[k] = y + text_h
        top_used = max(top_used, y + text_h + span * 0.02)
    if H and str(s["xmax"]).strip() == "":
        ax.set_xlim(right=inv(top_used))
    elif not H and str(s["ymax"]).strip() == "":
        ax.set_ylim(top=inv(top_used))


def describe(names, values, labels=None):
    cols = ["Group", "n", "Mean", "SD", "SEM", "95% CI low", "95% CI high", "Median", "Q1", "Q3", "Min", "Max"]
    rows = []
    for nm, v in zip(labels or names, values):
        v = np.asarray(v, float)
        v = v[np.isfinite(v)]
        n = len(v)
        if n == 0:
            rows.append([nm, 0] + [None] * 10)
            continue
        m = np.mean(v)
        sd = np.std(v, ddof=1) if n > 1 else np.nan
        sem = sd / math.sqrt(n) if n > 1 else np.nan
        h = sem * stats.t.ppf(0.975, n - 1) if n > 1 else np.nan
        q1, med, q3 = np.percentile(v, [25, 50, 75])
        rows.append([nm, n] + [_r(x) for x in (m, sd, sem, m - h, m + h, med, q1, q3, v.min(), v.max())])
    return {"title": "Descriptive statistics", "columns": cols, "rows": rows}


def _rm_anova(mat):
    n, k = mat.shape
    grand = mat.mean()
    ss_subj = k * ((mat.mean(axis=1) - grand) ** 2).sum()
    ss_cond = n * ((mat.mean(axis=0) - grand) ** 2).sum()
    ss_tot = ((mat - grand) ** 2).sum()
    ss_err = ss_tot - ss_subj - ss_cond
    df1, df2 = k - 1, (n - 1) * (k - 1)
    if ss_err <= 0 or df2 <= 0:
        return np.nan, df1, df2, np.nan
    F = (ss_cond / df1) / (ss_err / df2)
    return F, df1, df2, stats.f.sf(F, df1, df2)


def _article(test):
    return test[0].lower() + test[1:] if test.split(" ")[0] in ("One-way", "Repeated-measures", "Paired") else test


def compare_stats(names, values, paired=False, mode="auto", posthoc="all", equal_var=False):
    """Pick and run the right test. Never raises on awkward data; problems become notes."""
    try:
        return _compare_stats(names, values, paired, mode, posthoc, equal_var)
    except (ValueError, FloatingPointError, ZeroDivisionError, np.linalg.LinAlgError) as e:
        return {"test": "", "line": "", "p": None, "pairs": [], "method": "", "parametric": True, "normality": [],
                "notes": ["The statistical test couldn't be computed for these values (%s). This usually means "
                          "a group has identical values or too few points." % e]}


def _compare_stats(names, values, paired, mode, posthoc, equal_var):
    k = len(names)
    out = {"test": "", "line": "", "p": None, "pairs": [], "notes": [], "method": "", "parametric": True,
           "normality": []}
    vals = [np.asarray(v, float) for v in values]
    if paired:
        mat = np.column_stack(vals)
        complete = np.isfinite(mat).all(axis=1)
        if complete.sum() < len(mat):
            out["notes"].append("%d subject(s) with missing values were left out of the paired test."
                                % (len(mat) - complete.sum()))
        mat = mat[complete]
        vals = [mat[:, j] for j in range(k)]
    else:
        vals = [v[np.isfinite(v)] for v in vals]
    ns = [len(v) for v in vals]
    if k < 2:
        out["notes"].append("Add a second group to run a statistical test.")
        return out
    if min(ns) < 2:
        out["notes"].append("Every group needs at least 2 values for a test.")
        return out
    if all(np.ptp(v) == 0 for v in vals) and len(set(float(v[0]) for v in vals)) == 1:
        out["notes"].append("All values are identical, so there is nothing to test.")
        return out

    norm_sets = [vals[1] - vals[0]] if (paired and k == 2) else vals
    normal = True
    for nm, v in zip(["Differences"] if (paired and k == 2) else names, norm_sets):
        if len(v) >= 3 and np.ptp(v) > 0:
            p = stats.shapiro(v).pvalue
            out["normality"].append((nm, p))
            normal = normal and p > 0.05
        else:
            out["normality"].append((nm, None))
    if mode == "param":
        parametric = True
    elif mode == "nonparam":
        parametric = False
    else:
        parametric = normal
        if min(ns) < 3:
            out["notes"].append("Normality can't be checked with fewer than 3 values per group; a parametric test was used.")
            parametric = True
    out["parametric"] = parametric
    if min(ns) < 5:
        out["notes"].append("Small samples (n < 5 in a group): treat p-values with caution and report individual points.")

    if k == 2:
        a, b = vals
        if paired and parametric:
            r = stats.ttest_rel(b, a)
            d = b - a
            sd = np.std(d, ddof=1)
            dz = np.mean(d) / sd if sd > 0 else np.nan
            out.update(test="Paired t-test", p=r.pvalue,
                       line="t(%d) = %.3f, %s, Cohen's dz = %.2f" % (len(d) - 1, r.statistic, fmt_p(r.pvalue), dz))
        elif paired:
            if np.all(b - a == 0):
                out["notes"].append("Every pair has the same value in both groups, so the Wilcoxon test can't run.")
                return out
            r = stats.wilcoxon(b, a)
            out.update(test="Wilcoxon matched-pairs signed-rank test", p=r.pvalue,
                       line="W = %.1f, %s" % (r.statistic, fmt_p(r.pvalue)))
        elif parametric:
            r = stats.ttest_ind(a, b, equal_var=bool(equal_var))
            n1, n2 = len(a), len(b)
            v1, v2 = np.var(a, ddof=1), np.var(b, ddof=1)
            if equal_var or (v1 == 0 and v2 == 0):
                df = n1 + n2 - 2
            else:
                df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1))
            sp = math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2)) if n1 + n2 > 2 else 0.0
            g = (np.mean(b) - np.mean(a)) / sp * (1 - 3 / (4 * (n1 + n2) - 9)) if sp > 0 else np.nan
            name = "Student's t-test" if equal_var else "Welch's t-test"
            out.update(test=name, p=r.pvalue,
                       line="t(%.1f) = %.3f, %s, Hedges' g = %.2f" % (df, r.statistic, fmt_p(r.pvalue), g))
        else:
            r = stats.mannwhitneyu(a, b, alternative="two-sided")
            out.update(test="Mann-Whitney U test", p=r.pvalue, line="U = %.1f, %s" % (r.statistic, fmt_p(r.pvalue)))
        out["pairs"] = [(0, 1, out["p"])]
        out["method"] = "Groups were compared with a two-sided %s." % _article(out["test"])
        return out

    pairs = [(i, j) for i in range(k) for j in range(i + 1, k)] if posthoc == "all" else [(0, j) for j in range(1, k)]
    if paired:
        mat = np.column_stack(vals)
        if parametric:
            F, df1, df2, p = _rm_anova(mat)
            out.update(test="Repeated-measures one-way ANOVA", p=p,
                       line="F(%d, %d) = %.3f, %s" % (df1, df2, F, fmt_p(p)))
            raw = [stats.ttest_rel(mat[:, j], mat[:, i]).pvalue for i, j in pairs]
            ph_name = "paired t-tests with Holm correction"
        else:
            r = stats.friedmanchisquare(*[mat[:, j] for j in range(k)])
            out.update(test="Friedman test", p=r.pvalue,
                       line="chi2(%d) = %.3f, %s" % (k - 1, r.statistic, fmt_p(r.pvalue)))
            raw = []
            for i, j in pairs:
                d = mat[:, j] - mat[:, i]
                raw.append(1.0 if np.all(d == 0) else stats.wilcoxon(mat[:, j], mat[:, i]).pvalue)
            ph_name = "Wilcoxon signed-rank tests with Holm correction"
        adj = _holm(np.nan_to_num(raw, nan=1.0))
    elif parametric:
        r = stats.f_oneway(*vals)
        N = sum(ns)
        out.update(test="One-way ANOVA", p=r.pvalue,
                   line="F(%d, %d) = %.3f, %s" % (k - 1, N - k, r.statistic, fmt_p(r.pvalue)))
        if posthoc == "all":
            tk = stats.tukey_hsd(*vals)
            adj = [tk.pvalue[i, j] for i, j in pairs]
            ph_name = "Tukey's multiple comparisons test"
        else:
            try:
                dn = stats.dunnett(*vals[1:], control=vals[0])
                adj = list(dn.pvalue)
                ph_name = "Dunnett's test against %s" % names[0]
            except Exception:
                adj = _holm([stats.ttest_ind(vals[j], vals[0], equal_var=False).pvalue for _, j in pairs])
                ph_name = "Welch t-tests against %s with Holm correction" % names[0]
    else:
        r = stats.kruskal(*vals)
        out.update(test="Kruskal-Wallis test", p=r.pvalue,
                   line="H(%d) = %.3f, %s" % (k - 1, r.statistic, fmt_p(r.pvalue)))
        raw = [stats.mannwhitneyu(vals[i], vals[j], alternative="two-sided").pvalue for i, j in pairs]
        adj = _holm(raw)
        ph_name = "pairwise Mann-Whitney U tests with Holm correction"
    out["pairs"] = [(i, j, float(p)) for (i, j), p in zip(pairs, adj)]
    out["posthoc"] = ph_name
    out["method"] = "Groups were compared with a %s followed by %s." % (_article(out["test"]), ph_name)
    return out


def stats_tables(names, res):
    tables = []
    if res.get("normality"):
        tables.append({"title": "Normality (Shapiro-Wilk)", "columns": ["Group", "p", "Looks normal?"],
                       "rows": [[nm, _r(p), "" if p is None else ("Yes" if p > 0.05 else "No")]
                                for nm, p in res["normality"]]})
    if res.get("pairs") and len(names) > 2:
        tables.append({"title": "Multiple comparisons (%s)" % res.get("posthoc", ""),
                       "columns": ["Comparison", "Adjusted p", "Summary"],
                       "rows": [["%s vs %s" % (names[i], names[j]), _r(p), stars(p)] for i, j, p in res["pairs"]]})
    return tables


def _methods(s, res, extra=""):
    err = ERROR_NAMES.get(s["error"], "SEM")
    kind = s["plot_kind"]
    if kind == "box":
        shown = "Box plots show the median and interquartile range (whiskers 1.5 x IQR)"
    elif kind in ("violin", "raincloud", "boxviolin"):
        shown = "Violin plots show the data distribution with median and interquartile range"
    elif kind == "beeswarm":
        shown = "Individual values are shown with the median"
    elif kind == "strip":
        shown = "Individual values are shown"
    else:
        shown = "Data are shown as mean" + (" +/- %s" % err if err else "")
    if (s["show_points"] or kind in ("dot", "raincloud")) and kind not in ("beeswarm", "strip"):
        shown += " with individual values"
    parts = [shown + "."]
    if extra:
        parts.append(extra)
    if res.get("normality"):
        parts.append("Normality was assessed with the Shapiro-Wilk test.")
    if res.get("method"):
        parts.append(res["method"])
    parts.append("P < 0.05 was considered statistically significant.")
    parts.append(_software_line())
    return " ".join(parts)


def _software_line():
    return ("Analyses were performed in Serpentine %s (Python %d.%d, NumPy %s, SciPy %s, pandas %s, matplotlib %s)."
            % (ENGINE_VERSION, sys.version_info[0], sys.version_info[1], np.__version__, scipy.__version__,
               pd.__version__, matplotlib.__version__))


# ----------------------------------------------------------------------------
# Analyses
# ----------------------------------------------------------------------------

def _pick_dataset(datasets, ds_id):
    usable = [d for d in datasets if (d.get("text") or "").strip()]
    if not usable:
        raise UserError("Add a data table first (Data step).")
    for d in usable:
        if d.get("id") == ds_id:
            return d
    return usable[0]


def _numeric_cols(df, info):
    return [c for c in df.columns if info["kinds"][c] in ("number", "time")]


def _need_col(df, col, what):
    if col not in df.columns:
        raise UserError('Choose a %s column (couldn\'t find "%s").' % (what, col))
    return col


def _order(found, order_text):
    wanted = [g.strip() for g in (order_text or "").split(",") if g.strip()]
    ordered = [g for g in wanted if g in found]
    return ordered + [g for g in found if g not in ordered]


def _group_figure(names, values, s, res, paired, ylabel, title="", width=None):
    fig, ax = _new_fig(s, width)
    with plt.rc_context(_rc(s)):
        pm = np.column_stack(values) if paired else None
        tops = plot_groups(ax, names, values, s, paired_matrix=pm)
        H = s["orientation"] == "horizontal"
        _finish(ax, s, xlabel=ylabel if H else "", ylabel="" if H else ylabel, title=title)
        draw_brackets(ax, res["pairs"], tops, s)
    return fig


def analysis_compare(datasets, S, s):
    d = _pick_dataset(datasets, S.get("dataset"))
    df, info = read_table(d["text"])
    layout = S.get("layout", "wide")
    paired = bool(S.get("paired")) and layout == "wide"
    if layout == "long":
        num = _numeric_cols(df, info)
        vcol = S.get("value_col") or (num[0] if num else None)
        text_cols = [c for c in df.columns if info["kinds"][c] == "text"]
        gcol = S.get("group_col") or (text_cols[0] if text_cols else None)
        if not vcol or not gcol:
            raise UserError("The values + group layout needs a value column and a group column.")
        _need_col(df, vcol, "value")
        _need_col(df, gcol, "group")
        if vcol == gcol:
            raise UserError("Pick different columns for the values and the groups.")
        labels = _labels(df, gcol, info)
        found = [g for g in dict.fromkeys(labels) if g and g.lower() != "nan"]
        names = _order(found, S.get("group_order"))
        values = [pd.to_numeric(df.loc[labels == g, vcol], errors="coerce").to_numpy(float) for g in names]
        ylabel = S.get("y_name") or vcol
    else:
        cols = [c for c in (S.get("columns") or []) if c in df.columns and info["kinds"][c] != "text"] \
            or _numeric_cols(df, info)
        if not cols:
            raise UserError("No numeric columns found to compare.")
        names = _order(cols, S.get("group_order"))
        values = [pd.to_numeric(df[c], errors="coerce").to_numpy(float) for c in names]
        ylabel = S.get("y_name") or ""
    if not names:
        raise UserError("No groups found.")
    res = compare_stats(names, values, paired=paired, mode=S.get("test", "auto"),
                        posthoc=S.get("posthoc", "all"), equal_var=S.get("equal_var", False))
    fig = _group_figure(names, values, s, res, paired, ylabel)
    shown = [g["label"] for g in _gstyles(s, names)]
    summary = []
    if res["test"]:
        summary.append({"label": res["test"], "value": res["line"], "p": _r(res["p"])})
    tables = [describe(names, values, shown)] + stats_tables(shown, res)
    return {
        "figures": [{"id": "groups", "title": "Group comparison", "fig": fig, "style": s}],
        "tables": tables, "summary": summary, "notes": res["notes"],
        "methods": _methods(s, res), "groups": names,
    }


def _parse_clock_value(text, mult):
    t = str(text or "").strip().replace("−", "-")
    if not t:
        return None
    c = _clock(t)
    if c is not None:
        return c
    try:
        return float(t) * mult
    except ValueError:
        raise UserError('Couldn\'t read the time "%s". Use mm:ss (e.g. 13:27) or a number.' % t)


def _parse_ranges(text, mult):
    out = []
    for part in re.split(r"[;,]", str(text or "")):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"^(.+?)\s*(?:-|–|—|to)\s*(.+)$", part)
        if not m:
            raise UserError('Couldn\'t read the exclusion "%s". Use start-end, e.g. 8:00-8:50.' % part)
        a, b = _parse_clock_value(m.group(1), mult), _parse_clock_value(m.group(2), mult)
        out.append((min(a, b), max(a, b)))
    return out


def _f(S, key, default):
    v = S.get(key, default)
    if v is None or str(v).strip() == "":
        return default
    try:
        v = float(v)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


NORM_LABELS = {"pct": "% of baseline", "delta": "change from baseline", "fold": "fold of baseline", "raw": ""}


def analysis_timecourse(datasets, S, s):
    sessions = [d for d in datasets if (d.get("text") or "").strip()]
    if not sessions:
        raise UserError("Add at least one recording (Data step). Each table is one session.")
    mult = {"seconds": 1.0, "minutes": 60.0, "hours": 3600.0}.get(S.get("time_unit", "seconds"), 1.0)
    bin_s = max(0.0, _f(S, "bin", 30.0))
    bs, be = _f(S, "baseline_start", -5.0), _f(S, "baseline_end", 0.0)
    ws, we = _f(S, "window_start", -10.0), _f(S, "window_end", 30.0)
    es, ee = _f(S, "endpoint_start", 25.0), _f(S, "endpoint_end", 30.0)
    for a, b, what in ((bs, be, "baseline"), (ws, we, "display"), (es, ee, "endpoint")):
        if a >= b:
            raise UserError("The %s window must start before it ends (now %g to %g min)." % (what, a, b))
    norm = S.get("norm", "pct") if S.get("norm") in NORM_LABELS else "pct"
    metric = S.get("metric", "mean")
    vmin, vmax = _f(S, "valid_min", None), _f(S, "valid_max", None)
    fcol = S.get("filter_col") or ""
    fmin, fmax = _f(S, "filter_min", None), _f(S, "filter_max", None)
    notes = []

    per = []
    tcol = vcol = None
    for d in sessions:
        meta = d.get("meta") or {}
        name = d.get("name") or "Session"
        df, info = read_table(d["text"])
        num = _numeric_cols(df, info)
        times = [c for c in df.columns if info["kinds"][c] == "time"]
        tcol = S.get("time_col") or (times[0] if times else (num[0] if num else None))
        vcol = S.get("value_col") or next((c for c in num if c != tcol), None)
        if tcol not in df.columns or vcol not in df.columns:
            raise UserError('Session "%s" has no column "%s" or "%s". All sessions need the same column names.'
                            % (name, tcol, vcol))
        if tcol == vcol:
            raise UserError("The time column and the measurement can't be the same column.")
        t = df[tcol].to_numpy(float)
        if info["kinds"][tcol] != "time":
            t = t * mult
        v = df[vcol].to_numpy(float)
        ok = np.isfinite(t) & np.isfinite(v)
        if vmin is not None:
            ok &= v >= vmin
        if vmax is not None:
            ok &= v <= vmax
        if fcol:
            if fcol in df.columns:
                fv = pd.to_numeric(df[fcol], errors="coerce").to_numpy(float)
                if fmin is not None:
                    ok &= fv >= fmin
                if fmax is not None:
                    ok &= fv <= fmax
            else:
                notes.append('"%s" has no column "%s", so the quality filter was skipped there.' % (name, fcol))
        for a, b in _parse_ranges(meta.get("exclude"), mult):
            ok &= ~((t >= a) & (t <= b))
        ev = _parse_clock_value(meta.get("event"), mult)
        if ev is None:
            ev = 0.0
            notes.append('"%s" has no event time, so time 0 was used.' % name)
        trel = t[ok] - ev
        vv = v[ok]
        if not len(trel):
            notes.append('"%s" has no usable data after filtering.' % name)
            continue
        if bin_s > 0:
            step = bin_s
        else:
            diffs = np.diff(np.unique(trel))
            step = float(np.median(diffs)) if len(diffs) else 1.0
            step = step if step > 0 else 1.0
        k = np.floor(trel / step + 1e-9).astype(int)
        binned = pd.Series(vv).groupby(k).mean()
        kk = binned.index.to_numpy()
        bv = binned.to_numpy(float)
        centers = (kk + 0.5) * step / 60.0
        in_base = (centers >= bs) & (centers <= be)
        base = float(np.mean(bv[in_base])) if in_base.any() else np.nan
        if not in_base.any():
            notes.append('"%s" has no data in the baseline window (%g to %g min).' % (name, bs, be))
        elif norm in ("pct", "fold") and base == 0:
            notes.append('"%s" has a baseline of 0, so it can\'t be expressed relative to baseline.' % name)
            base = np.nan
        with np.errstate(all="ignore"):
            if norm == "pct":
                nv, ref = bv / base * 100.0, 100.0
            elif norm == "fold":
                nv, ref = bv / base, 1.0
            elif norm == "delta":
                nv, ref = bv - base, 0.0
            else:
                nv, ref = bv, base
        per.append({"name": name, "group": (meta.get("group") or "Group").strip() or "Group",
                    "subject": (meta.get("subject") or name).strip(), "k": kk, "v": nv,
                    "centers": centers, "base": base, "ref": ref, "step": step, "event": ev})
    if not per:
        raise UserError("No session has usable data. Check the column choices and filters.")

    step = per[0]["step"]
    if len(set(round(p["step"], 6) for p in per)) > 1:
        notes.append("Sessions have different sampling intervals; set a bin size so they line up.")
    groups = _order(list(dict.fromkeys(p["group"] for p in per)), S.get("group_order"))
    G = _gstyles(s, groups)

    for p in per:
        sel = (p["centers"] >= es) & (p["centers"] <= ee) & np.isfinite(p["v"])
        y = p["v"][sel]
        p["end"] = np.nan
        if len(y):
            if metric == "min":
                p["end"] = float(np.min(y))
            elif metric == "max":
                p["end"] = float(np.max(y))
            elif metric == "auc":
                x = p["centers"][sel]
                ref = p["ref"] if np.isfinite(p["ref"]) else 0.0
                p["end"] = float(np.trapz(y - ref, x)) if len(y) > 1 else np.nan
            else:
                p["end"] = float(np.mean(y))
        if not np.isfinite(p["end"]):
            notes.append('"%s" has no data in the endpoint window (%g to %g min).' % (p["name"], es, ee))

    unit = NORM_LABELS.get(norm, "")
    ylabel = "%s (%s)" % (vcol, unit) if unit else vcol
    event_label = S.get("event_label") or "event"
    band = S.get("band", "sem")
    band_style = S.get("band_style", "band")
    fig, ax = _new_fig(s)
    lw = s["line_width"]
    tc_rows = []
    with plt.rc_context(_rc(s)):
        if S.get("shade_baseline", True):
            ax.axvspan(bs, be, color=to_rgba(s["fg"], 0.06), lw=0, zorder=0)
        if S.get("shade_endpoint", True):
            ax.axvspan(es, ee, color=to_rgba(G[min(1, len(G) - 1)]["color"], 0.08), lw=0, zorder=0)
        if norm != "raw":
            ax.axhline(per[0]["ref"], color=to_rgba(s["fg"], 0.35), lw=max(0.6, lw * 0.5), ls=(0, (2, 3)), zorder=1)
        for g in G:
            members = [p for p in per if p["group"] == g["name"]]
            all_k = sorted(set(np.concatenate([p["k"] for p in members]).tolist()))
            all_k = [k for k in all_k if ws <= (k + 0.5) * step / 60.0 <= we]
            if not all_k:
                continue
            mat = np.full((len(all_k), len(members)), np.nan)
            pos = {k: i for i, k in enumerate(all_k)}
            for j, p in enumerate(members):
                for k, val in zip(p["k"], p["v"]):
                    if k in pos:
                        mat[pos[k], j] = val
            x = (np.array(all_k) + 0.5) * step / 60.0
            with np.errstate(all="ignore"), np.testing.suppress_warnings() as sup:
                sup.filter(RuntimeWarning)
                n = np.isfinite(mat).sum(axis=1)
                mean = np.nanmean(mat, axis=1)
                sd = np.nanstd(mat, axis=1, ddof=1)
                sem = sd / np.sqrt(n)
            c = g["color"]
            if S.get("show_traces", True) and len(members) > 1:
                for j in range(len(members)):
                    ax.plot(x, mat[:, j], color=to_rgba(c, s["trace_alpha"]), lw=max(0.5, lw * 0.5), zorder=2)
            if band != "none" and len(members) > 1:
                e = sd if band == "sd" else sem
                if band_style == "bars":
                    ax.errorbar(x, mean, yerr=e, fmt="none", ecolor=c, elinewidth=s["error_width"] * 0.7,
                                capsize=s["cap_size"] * 0.6, zorder=3)
                else:
                    ax.fill_between(x, mean - e, mean + e, color=to_rgba(c, s["band_alpha"]), lw=0, zorder=2)
            kw = dict(color=c, lw=lw * 1.3, ls=g["ls"], zorder=4, label="%s (n=%d)" % (g["label"], len(members)))
            if s["line_markers"]:
                kw.update(marker=g["marker"], markersize=s["marker_size"] * 0.8, markeredgecolor=_point_edge(s, c),
                          markeredgewidth=s["point_edge_width"])
            ax.plot(x, mean, **kw)
            for xi, m_, s_, n_ in zip(x, mean, sem, n):
                tc_rows.append([g["label"], _r(xi), _r(m_), _r(s_), int(n_)])
        if S.get("show_event", True):
            ax.axvline(0, color=to_rgba(s["fg"], 0.6), lw=max(0.7, lw * 0.6), ls=(0, (4, 3)), zorder=1)
            ax.annotate(event_label, xy=(0, 1), xycoords=("data", "axes fraction"), xytext=(0, 3),
                        textcoords="offset points", ha="center", va="bottom", fontsize=s["font_size"] * 0.85,
                        color=to_rgba(s["fg"], 0.75))
        ax.set_xlim(ws, we)
        _finish(ax, s, xlabel="Time from %s (min)" % event_label.lower(), ylabel=ylabel, legend=True,
                title_pad=s["font_size"] * 2.0 if S.get("show_event", True) else None)

    paired = bool(S.get("pair_subjects")) and len(groups) > 1
    if paired:
        subjects = [sub for sub in dict.fromkeys(p["subject"] for p in per)
                    if all(any(p["subject"] == sub and p["group"] == g for p in per) for g in groups)]
        dropped = len(set(p["subject"] for p in per)) - len(subjects)
        if dropped:
            notes.append("%d subject(s) without a session in every group were left out of the paired comparison."
                         % dropped)
        dupes = [sub for sub in subjects for g in groups
                 if sum(1 for p in per if p["subject"] == sub and p["group"] == g) > 1]
        if dupes:
            notes.append("Subject %s has more than one session in a group; their endpoints were averaged."
                         % ", ".join(sorted(set(dupes))))
        values = [np.array([np.nanmean([p["end"] for p in per if p["subject"] == sub and p["group"] == g])
                            for sub in subjects]) if subjects else np.array([]) for g in groups]
    else:
        values = [np.array([p["end"] for p in per if p["group"] == g]) for g in groups]
    res = compare_stats(groups, values, paired=paired, mode=S.get("test", "auto"),
                        posthoc=S.get("posthoc", "all"), equal_var=S.get("equal_var", False))
    metric_name = {"mean": "Mean", "min": "Minimum", "max": "Maximum", "auc": "Net AUC"}.get(metric, "Mean")
    end_label = ("%s %s, %g to %g min" % (metric_name, unit or vcol, es, ee)) if metric != "auc" else \
        "Net AUC vs baseline, %g to %g min" % (es, ee)
    ep_width = s["endpoint_width"] or max(2.4, min(s["width"], 1.1 + 0.9 * len(groups)))
    if s["orientation"] == "horizontal" and not s["endpoint_width"]:
        ep_width = s["width"]
    s2 = dict(s, width=ep_width, title="", xlabel="", ylabel="", panel_label="", ref_lines="")
    fig2 = _group_figure(groups, values, s2, res, paired, end_label, width=ep_width)
    if norm != "raw" and metric != "auc":
        ax2 = fig2.axes[0]
        with plt.rc_context(_rc(s2)):
            line = ax2.axvline if s["orientation"] == "horizontal" else ax2.axhline
            line(per[0]["ref"], color=to_rgba(s["fg"], 0.35), lw=max(0.6, lw * 0.5), ls=(0, (2, 3)), zorder=1)

    shown = [g["label"] for g in G]
    sess_rows = [[p["name"], p["group"], p["subject"], _fmt_clock(p["event"]), _r(p["base"]), _r(p["end"])]
                 for p in per]
    tables = [
        {"title": "Sessions", "columns": ["Session", "Group", "Subject", "Event", "Baseline (raw)", end_label],
         "rows": sess_rows},
        describe(groups, values, shown),
    ] + stats_tables(shown, res) + [
        {"title": "Time course (group means)", "columns": ["Group", "Time (min)", "Mean", "SEM", "n"],
         "rows": tc_rows},
    ]
    summary = []
    if res["test"]:
        summary.append({"label": "%s: %s" % (res["test"], end_label), "value": res["line"], "p": _r(res["p"])})
    bin_txt = ("averaged in %g-s bins" % step) if bin_s > 0 else "analysed without binning"
    norm_txt = {
        "pct": "expressed as a percentage of each session's baseline",
        "fold": "expressed as fold of each session's baseline",
        "delta": "expressed as change from each session's baseline",
        "raw": "shown in raw units",
    }[norm]
    extra = ("%s was %s, aligned to the %s, and %s (baseline = mean from %g to %g min). "
             "The endpoint was the %s from %g to %g min after the %s."
             % (vcol, bin_txt, event_label.lower(), norm_txt, bs, be,
                metric_name.lower() if metric != "auc" else "net area under the curve relative to baseline",
                es, ee, event_label.lower()))
    s_meth = dict(s)
    s_meth["error"] = band if band != "none" else s["error"]
    return {
        "figures": [
            {"id": "timecourse", "title": "Time course", "fig": fig, "style": s},
            {"id": "endpoint", "title": "Endpoint", "fig": fig2, "style": s2},
        ],
        "tables": tables, "summary": summary, "notes": notes + res["notes"],
        "methods": _methods(s_meth, res, extra), "groups": groups,
    }


def analysis_correlation(datasets, S, s):
    d = _pick_dataset(datasets, S.get("dataset"))
    df, info = read_table(d["text"])
    num = _numeric_cols(df, info)
    xcol = S.get("x_col") or (num[0] if num else None)
    ycol = S.get("y_col") or (num[1] if len(num) > 1 else None)
    if not xcol or not ycol:
        raise UserError("Correlation needs two numeric columns.")
    _need_col(df, xcol, "X")
    _need_col(df, ycol, "Y")
    if xcol == ycol:
        raise UserError("Pick two different columns for X and Y.")
    gcol = S.get("group_col") or ""
    if gcol and gcol in df.columns:
        labels = _labels(df, gcol, info)
        groups = _order([g for g in dict.fromkeys(labels) if g and g.lower() != "nan"], S.get("group_order"))
    else:
        labels = pd.Series(["All"] * len(df))
        groups = ["All"]
    method = S.get("method", "pearson")
    G = _gstyles(s, groups)
    fig, ax = _new_fig(s)
    rows, summary, notes = [], [], []
    lw, ms = s["line_width"], s["marker_size"]
    with plt.rc_context(_rc(s)):
        for g in G:
            sel = labels == g["name"]
            x = pd.to_numeric(df.loc[sel, xcol], errors="coerce").to_numpy(float)
            y = pd.to_numeric(df.loc[sel, ycol], errors="coerce").to_numpy(float)
            ok = np.isfinite(x) & np.isfinite(y)
            x, y = x[ok], y[ok]
            c = g["color"]
            ax.scatter(x, y, s=ms ** 2 * 1.3, marker=g["marker"], color=to_rgba(c, s["point_alpha"]),
                       edgecolor=_point_edge(s, c), linewidth=s["point_edge_width"], zorder=3,
                       label=g["label"] if len(groups) > 1 else None)
            if len(x) < 3:
                notes.append("%s: need at least 3 points for a correlation." % g["label"])
                continue
            if np.ptp(x) == 0 or np.ptp(y) == 0:
                notes.append("%s: X or Y doesn't vary, so there is no correlation to measure." % g["label"])
                continue
            if method == "spearman":
                r, p = stats.spearmanr(x, y)
                rname, sym = "Spearman rho", "rho"
            else:
                r, p = stats.pearsonr(x, y)
                rname, sym = "Pearson r", "r"
            lr = stats.linregress(x, y)
            rows.append([g["label"], len(x), _r(r), _r(p), _r(lr.slope), _r(lr.intercept), _r(lr.rvalue ** 2)])
            summary.append({"label": "%s%s" % (rname, " (%s)" % g["label"] if len(groups) > 1 else ""),
                            "value": "%s = %.3f, %s, n = %d" % (sym, r, fmt_p(p), len(x)), "p": _r(p)})
            if S.get("fit", True):
                xx = np.linspace(x.min(), x.max(), 100)
                yy = lr.intercept + lr.slope * xx
                ax.plot(xx, yy, color=c, lw=lw * 1.2, ls=g["ls"], zorder=2)
                if S.get("ci", True) and len(x) > 2:
                    n = len(x)
                    resid = y - (lr.intercept + lr.slope * x)
                    se = math.sqrt(np.sum(resid ** 2) / (n - 2))
                    tval = stats.t.ppf(0.975, n - 2)
                    sxx = np.sum((x - x.mean()) ** 2)
                    band = tval * se * np.sqrt(1 / n + (xx - x.mean()) ** 2 / sxx) if sxx > 0 else 0
                    ax.fill_between(xx, yy - band, yy + band, color=to_rgba(c, s["band_alpha"] * 0.85), lw=0, zorder=1)
        if S.get("annotate", True) and summary and len(groups) == 1:
            ax.text(0.03, 0.97, summary[0]["value"].rsplit(", n =", 1)[0], transform=ax.transAxes, ha="left",
                    va="top", fontsize=s["font_size"] * 0.85)
        _finish(ax, s, xlabel=xcol, ylabel=ycol, legend=len(groups) > 1)
    tables = [{"title": "Correlation and linear fit",
               "columns": ["Group", "n", "r" if method != "spearman" else "rho", "p", "Slope", "Intercept", "R squared"],
               "rows": rows}]
    meth = ("Associations were assessed with %s correlation%s. P < 0.05 was considered statistically significant. %s"
            % ("Spearman's rank" if method == "spearman" else "Pearson's",
               " and an ordinary least-squares linear fit (shaded band: 95% confidence interval)" if S.get("fit", True) else "",
               _software_line()))
    return {"figures": [{"id": "scatter", "title": "Correlation", "fig": fig, "style": s}],
            "tables": tables, "summary": summary, "notes": notes, "methods": meth, "groups": groups}


def _four_pl(logx, bottom, top, log_ec50, hill):
    with np.errstate(over="ignore"):
        return bottom + (top - bottom) / (1 + 10 ** ((log_ec50 - logx) * hill))


def analysis_dose(datasets, S, s):
    d = _pick_dataset(datasets, S.get("dataset"))
    df, info = read_table(d["text"])
    num = _numeric_cols(df, info)
    xcol = S.get("x_col") or (num[0] if num else None)
    if not xcol:
        raise UserError("Choose the concentration column.")
    _need_col(df, xcol, "concentration")
    ycols = [c for c in (S.get("y_cols") or []) if c in df.columns and c != xcol and info["kinds"][c] != "text"] \
        or [c for c in num if c != xcol]
    if not ycols:
        raise UserError("Choose at least one response column.")
    mode = S.get("mode", "curves")
    x_all = pd.to_numeric(df[xcol], errors="coerce").to_numpy(float)
    curves = [(S.get("curve_name") or "Response", ycols)] if mode == "replicates" else [(c, [c]) for c in ycols]
    G = _gstyles(s, [c[0] for c in curves])
    fix_bottom, fix_top = _f(S, "fix_bottom", None), _f(S, "fix_top", None)
    scale = _f(S, "x_scale", 1.0) or 1.0
    unit = S.get("x_unit") or ""
    fig, ax = _new_fig(s)
    rows, summary, notes, guides = [], [], [], []
    lw, ms = s["line_width"], s["marker_size"]
    with plt.rc_context(_rc(s)):
        for g, (name, cols) in zip(G, curves):
            c = g["color"]
            Y = np.column_stack([pd.to_numeric(df[cc], errors="coerce").to_numpy(float) for cc in cols])
            x = x_all * scale
            pos = np.isfinite(x) & (x > 0)
            if (~pos & np.isfinite(x)).any():
                notes.append("%s: concentrations of 0 or below can't go on a log axis and were left out." % g["label"])
            xs, Ys = x[pos], Y[pos]
            lx = np.log10(xs)
            px = np.repeat(lx, Ys.shape[1])
            py = Ys.reshape(-1)
            ok = np.isfinite(py)
            px, py = px[ok], py[ok]
            if len(px) == 0:
                notes.append("%s has no usable values." % g["label"])
                continue
            ux = np.unique(px)
            means = np.array([np.mean(py[px == u]) for u in ux])
            errs = np.array([_err(py[px == u], s["error"]) for u in ux])
            pe = _point_edge(s, c)
            if Ys.shape[1] > 1 and not S.get("all_points", False):
                ax.errorbar(10 ** ux, means, yerr=errs if s["error"] != "none" else None, fmt=g["marker"], color=c,
                            ms=ms * 1.1, mec=pe, mew=s["point_edge_width"], elinewidth=s["error_width"] * 0.8,
                            capsize=s["cap_size"] * 0.7, zorder=4, label=g["label"], ls="none")
            else:
                ax.scatter(10 ** px, py, s=ms ** 2 * 1.2, marker=g["marker"], color=to_rgba(c, s["point_alpha"]),
                           edgecolor=pe, linewidth=s["point_edge_width"], zorder=4, label=g["label"])
            if len(ux) < 4:
                notes.append("%s: a 4-parameter fit needs at least 4 concentrations." % g["label"])
                continue
            fixed = {}
            if fix_bottom is not None:
                fixed["bottom"] = fix_bottom
            if fix_top is not None:
                fixed["top"] = fix_top
            free = [f for f in ("bottom", "top", "log_ec50", "hill") if f not in fixed]
            corr = np.corrcoef(px, py)[0, 1] if np.ptp(py) > 0 else 1.0
            slope_sign = float(np.sign(corr)) or 1.0
            guess = {"bottom": float(np.min(means)), "top": float(np.max(means)),
                     "log_ec50": float(np.median(ux)), "hill": slope_sign}

            def model(lxv, *params, _fixed=fixed, _free=free):
                kw = dict(_fixed)
                kw.update(dict(zip(_free, params)))
                return _four_pl(lxv, kw["bottom"], kw["top"], kw["log_ec50"], kw["hill"])

            try:
                popt, pcov = curve_fit(model, px, py, p0=[guess[f] for f in free], maxfev=20000)
            except Exception:
                notes.append("%s: the curve fit did not converge." % g["label"])
                continue
            par = dict(fixed)
            par.update(dict(zip(free, popt)))
            perr = dict(zip(free, np.sqrt(np.clip(np.diag(pcov), 0, None)))) if np.all(np.isfinite(pcov)) else {}
            pred = model(px, *popt)
            ss_res = np.sum((py - pred) ** 2)
            ss_tot = np.sum((py - py.mean()) ** 2)
            r2 = 1 - ss_res / ss_tot if ss_tot > 0 else np.nan
            dof = max(1, len(px) - len(free))
            tval = stats.t.ppf(0.975, dof)
            se_l = perr.get("log_ec50", np.nan)
            ec50 = 10 ** par["log_ec50"]
            lo, hi = 10 ** (par["log_ec50"] - tval * se_l), 10 ** (par["log_ec50"] + tval * se_l)
            if par["log_ec50"] < ux.min() - 1 or par["log_ec50"] > ux.max() + 1:
                notes.append("%s: the midpoint lies outside the tested range, so treat it as an estimate." % g["label"])
            label = S.get("ec_label") or ("IC50" if par["hill"] * (par["top"] - par["bottom"]) < 0 else "EC50")
            xx = np.linspace(ux.min() - 0.3, ux.max() + 0.3, 300)
            ax.plot(10 ** xx, model(xx, *popt), color=c, lw=lw * 1.2, ls=g["ls"], zorder=3)
            guides.append((ec50, (par["top"] + par["bottom"]) / 2, c))
            rows.append([g["label"], label, _r(ec50), _r(lo), _r(hi), _r(par["log_ec50"]), _r(par["hill"]),
                         _r(par["bottom"]), _r(par["top"]), _r(r2), len(px)])
            summary.append({"label": "%s %s" % (g["label"], label),
                            "value": "%s %s (95%% CI %s to %s), Hill slope %.2f, R² = %.3f"
                                     % (_fmt(ec50), unit, _fmt(lo), _fmt(hi), par["hill"], r2), "p": None})
        ax.set_xscale("log")
        if S.get("show_ec50", True) and guides:
            lo_y, hi_y = ax.get_ylim()
            for ec50, yhalf, c in guides:
                ax.plot([ec50, ec50], [lo_y, yhalf], color=to_rgba(c, 0.6), lw=max(0.6, lw * 0.6),
                        ls=(0, (3, 3)), zorder=2)
            ax.set_ylim(lo_y, hi_y)
        _finish(ax, s, xlabel="%s%s" % (xcol, " (%s)" % unit if unit else ""),
                ylabel=ycols[0] if len(curves) == 1 and mode != "replicates" else "Response",
                legend=len(curves) > 1)
    tables = [{"title": "Four-parameter logistic fit",
               "columns": ["Curve", "Parameter", "Value", "95% CI low", "95% CI high", "log value", "Hill slope",
                           "Bottom", "Top", "R squared", "Points"], "rows": rows}]
    fixed_txt = []
    if fix_bottom is not None:
        fixed_txt.append("bottom fixed at %g" % fix_bottom)
    if fix_top is not None:
        fixed_txt.append("top fixed at %g" % fix_top)
    meth = ("Concentration-response data were fitted with a four-parameter logistic model (variable Hill slope%s) "
            "by nonlinear least squares on log-transformed concentrations. Confidence intervals were derived from the "
            "standard error of log EC50/IC50. %s" % ("; " + ", ".join(fixed_txt) if fixed_txt else "", _software_line()))
    if any(len(cols) > 1 for _, cols in curves) and not S.get("all_points", False):
        meth = "Points show mean +/- %s of replicates. " % ERROR_NAMES.get(s["error"], "SEM") + meth
    return {"figures": [{"id": "dose", "title": "Dose-response", "fig": fig, "style": s}],
            "tables": tables, "summary": summary, "notes": notes, "methods": meth,
            "groups": [c[0] for c in curves]}


ANALYSES = {
    "compare": analysis_compare,
    "timecourse": analysis_timecourse,
    "correlation": analysis_correlation,
    "dose": analysis_dose,
}

# ----------------------------------------------------------------------------
# Running + exporting
# ----------------------------------------------------------------------------

_LAST = {"figures": []}


def _svg(fig, s):
    buf = io.StringIO()
    with plt.rc_context(_rc(s)):
        fig.savefig(buf, format="svg", bbox_inches="tight", pad_inches=0.08, facecolor=s["bg"])
    txt = buf.getvalue()
    txt = re.sub(r"<style[^>]*>.*?</style>", "", txt, flags=re.S)  # global * rule would leak into the page
    return txt[txt.find("<svg"):]


def _run_user_code(code, fig, f, notes):
    ns = {"fig": fig, "ax": fig.axes[0] if fig.axes else None, "axes": fig.axes, "plt": plt, "np": np, "pd": pd,
          "matplotlib": matplotlib, "figure_id": f["id"], "style": f["style"]}
    try:
        with plt.rc_context(_rc(f["style"])):
            exec(compile(code, "<your code>", "exec"), ns)
    except Exception as e:
        line = next((fr.lineno for fr in reversed(traceback.extract_tb(e.__traceback__))
                     if fr.filename == "<your code>"), None)
        notes.append("Your Python code (%s figure%s): %s: %s" % (
            f["title"].lower(), ", line %d" % line if line else "", type(e).__name__, e))


def run(config, datasets):
    for f in _LAST["figures"]:
        plt.close(f["fig"])
    _LAST["figures"] = []
    kind = config.get("analysis", "compare")
    fn = ANALYSES.get(kind)
    if fn is None:
        raise UserError("Unknown analysis: %s" % kind)
    s = _style(config.get("style"))
    out = fn(datasets, config.get("settings") or {}, s)
    notes = list(out["notes"]) + list(s["_notes"])
    code = str(s.get("custom_code") or "").strip()
    for f in out["figures"]:
        with plt.rc_context(_rc(f["style"])):
            _polish(f["fig"], f["style"], notes)
        if code:
            _run_user_code(code, f["fig"], f, notes)
    _LAST["figures"] = out["figures"]
    figs = [{"id": f["id"], "title": f["title"], "svg": _svg(f["fig"], f["style"])} for f in out["figures"]]
    groups = [str(g) for g in out.get("groups", [])]
    gs = _gstyles(s, groups)
    return {"figures": figs, "tables": out["tables"], "summary": out["summary"], "notes": notes,
            "methods": out["methods"], "groups": groups,
            "group_styles": [{"name": g["name"], "color": to_hex(g["color"]), "label": g["label"]} for g in gs],
            "colors": {"bg": to_hex(s["bg"]), "fg": to_hex(s["fg"]), "ax_bg": to_hex(s["ax_bg"])}}


def export_figure(index, fmt, dpi=300, transparent=False):
    if index >= len(_LAST["figures"]):
        raise UserError("Run the analysis first.")
    if fmt not in ("png", "svg", "pdf", "jpg", "tiff", "eps"):
        raise UserError("Unknown format %s." % fmt)
    f = _LAST["figures"][index]
    s = f["style"]
    buf = io.BytesIO()
    kw = {}
    if fmt in ("jpg", "tiff", "eps"):
        transparent = False
    if fmt == "jpg":
        kw["pil_kwargs"] = {"quality": 95}
    with plt.rc_context(_rc(s)):
        f["fig"].savefig(buf, format=fmt, dpi=dpi, bbox_inches="tight", pad_inches=0.08,
                         transparent=bool(transparent), facecolor="none" if transparent else s["bg"], **kw)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def versions():
    return {"engine": ENGINE_VERSION, "python": "%d.%d.%d" % sys.version_info[:3], "numpy": np.__version__,
            "scipy": scipy.__version__, "pandas": pd.__version__, "matplotlib": matplotlib.__version__,
            "colormaps": sorted(m for m in matplotlib.colormaps if not m.endswith("_r"))}


# ----------------------------------------------------------------------------
# Example data
# ----------------------------------------------------------------------------

def _tsv(header, rows):
    out = ["\t".join(header)]
    for r in rows:
        out.append("\t".join(str(x) for x in r))
    return "\n".join(out)


def example(kind):
    rng = np.random.default_rng(42)
    if kind == "compare":
        vehicle = rng.normal(812, 140, 8)
        low = rng.normal(640, 150, 8)
        high = rng.normal(395, 120, 8)
        rows = [["%.0f" % a, "%.0f" % b, "%.0f" % c] for a, b, c in zip(vehicle, low, high)]
        return {
            "datasets": [{"name": "Tumor volume, day 21", "text": _tsv(["Vehicle", "Drug 10 mg/kg", "Drug 30 mg/kg"], rows),
                          "meta": {}}],
            "settings": {"layout": "wide", "test": "auto", "posthoc": "all", "y_name": "Tumor volume (mm³)"},
        }
    if kind == "timecourse":
        datasets = []
        for group, mean_drop in (("Saline", 0.0), ("Morphine", 0.40)):
            for m in range(4):
                drop = max(0.0, mean_drop + rng.normal(0, 0.09)) if mean_drop else rng.normal(0, 0.05)
                mouse = "M%d" % (101 + m)
                inj = 600 + int(rng.integers(-90, 120))
                base_vi = rng.normal(48, 5)
                base_rate = rng.normal(190, 15)
                rows = []
                for t in range(0, inj + 30 * 60 + 1, 10):
                    after = max(0.0, (t - inj) / 60.0)
                    effect = drop * (1 - math.exp(-after / 4.0)) * (1 - 0.15 * after / 30.0)
                    vi = base_vi * (1 - effect) * (1 + rng.normal(0, 0.05))
                    rate = base_rate * (1 - effect * 0.35) * (1 + rng.normal(0, 0.04)) - 0.25 * t / 60.0
                    count = int(max(0, rate / 6 + rng.normal(0, 2)))
                    rows.append([_fmt_clock(t), "%.2f" % vi, "%.1f" % rate, count])
                datasets.append({
                    "name": "%s %s" % (group, mouse),
                    "text": _tsv(["Time", "Minute ventilation (mL/min)", "Breathing rate (BPM)", "Cycle count"], rows),
                    "meta": {"group": group, "subject": mouse, "event": _fmt_clock(inj), "exclude": ""},
                })
        return {"datasets": datasets,
                "settings": {"time_col": "Time", "value_col": "Minute ventilation (mL/min)", "bin": 60,
                             "baseline_start": -5, "baseline_end": 0, "window_start": -8, "window_end": 30,
                             "endpoint_start": 25, "endpoint_end": 30, "norm": "pct", "metric": "mean",
                             "pair_subjects": True, "event_label": "Injection", "filter_col": "Cycle count",
                             "filter_min": 10}}
    if kind == "correlation":
        rows = []
        for g, slope in (("Wild type", 2.1), ("Knockout", 3.4)):
            for _ in range(14):
                w = rng.normal(27, 3.2)
                glucose = 60 + slope * w + rng.normal(0, 9)
                rows.append([g, "%.1f" % w, "%.0f" % glucose])
        return {"datasets": [{"name": "Weight vs glucose", "meta": {},
                              "text": _tsv(["Genotype", "Body weight (g)", "Fasting glucose (mg/dL)"], rows)}],
                "settings": {"x_col": "Body weight (g)", "y_col": "Fasting glucose (mg/dL)", "group_col": "Genotype",
                             "method": "pearson", "fit": True, "ci": True}}
    if kind == "dose":
        conc = [0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000, 3000]
        rows = []
        for cval in conc:
            lx = math.log10(cval)
            r = []
            for ic50, hill in ((25.0, 1.1), (180.0, 0.9), (900.0, 1.4)):
                y = 100 / (1 + 10 ** ((lx - math.log10(ic50)) * hill))
                r.append("%.1f" % (y + rng.normal(0, 4)))
            rows.append([cval] + r)
        return {"datasets": [{"name": "Kinase inhibition", "meta": {},
                              "text": _tsv(["Concentration", "Compound A", "Compound B", "Compound C"], rows)}],
                "settings": {"x_col": "Concentration", "mode": "curves", "x_unit": "nM", "show_ec50": True}}
    raise UserError("No example for %s" % kind)


# ----------------------------------------------------------------------------
# Entry points
# ----------------------------------------------------------------------------

def _clean(o):
    """Make any result JSON-safe: NaN/inf become null, numpy types become Python types."""
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return [_clean(v) for v in o.tolist()]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (float, np.floating)):
        return float(o) if math.isfinite(o) else None
    if isinstance(o, (str, int, bool)) or o is None:
        return o
    return str(o)


def api(cmd, args_json):
    """Single entry point for the app. Always returns JSON: {"ok": ...} or {"error": ...}."""
    try:
        args = json.loads(args_json) if args_json else {}
        if cmd == "inspect":
            result = inspect(args["text"])
        elif cmd == "run":
            result = run(args["config"], args["datasets"])
        elif cmd == "export":
            result = export_figure(int(args.get("index", 0)), args.get("format", "png"),
                                   int(float(args.get("dpi", 300) or 300)), args.get("transparent", False))
        elif cmd == "excel":
            result = excel_to_tables(args["b64"])
        elif cmd == "example":
            result = example(args["kind"])
        elif cmd == "fonts":
            result = register_fonts(args.get("paths") or [])
        elif cmd == "versions":
            result = versions()
        else:
            raise UserError("Unknown command %s" % cmd)
        return json.dumps({"ok": _clean(result)}, allow_nan=False)
    except UserError as e:
        return json.dumps({"error": str(e)})
    except Exception as e:  # unexpected: give the user the message, keep the trace for debugging
        return json.dumps({"error": "Something went wrong: %s" % e, "trace": traceback.format_exc()})


def cli(config_json, datasets_json, out_dir="serpentine_output"):
    """Used by exported scripts: re-runs the analysis and saves figures and tables."""
    import os
    os.makedirs(out_dir, exist_ok=True)
    config = json.loads(config_json)
    datasets = json.loads(datasets_json)
    out = run(config, datasets)
    for i, f in enumerate(_LAST["figures"]):
        for fmt in ("png", "pdf", "svg"):
            path = os.path.join(out_dir, "%d_%s.%s" % (i + 1, f["id"], fmt))
            with plt.rc_context(_rc(f["style"])):
                f["fig"].savefig(path, dpi=f["style"]["dpi"], bbox_inches="tight", pad_inches=0.08,
                                 facecolor=f["style"]["bg"])
            print("saved", path)
    for t in out["tables"]:
        name = re.sub(r"[^A-Za-z0-9]+", "_", t["title"]).strip("_").lower()
        path = os.path.join(out_dir, name + ".csv")
        pd.DataFrame(t["rows"], columns=t["columns"]).to_csv(path, index=False)
        print("saved", path)
    for item in out["summary"]:
        print("%s: %s" % (item["label"], item["value"]))
    for n in out["notes"]:
        print("note:", n)
    print()
    print("Methods:", out["methods"])
