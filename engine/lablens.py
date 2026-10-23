"""LabLens analysis engine.

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
import traceback

import numpy as np
import pandas as pd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.colors import to_rgba, to_rgb  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402
import scipy  # noqa: E402
from scipy import stats  # noqa: E402
from scipy.optimize import curve_fit  # noqa: E402

logging.getLogger("matplotlib.font_manager").setLevel(logging.ERROR)

ENGINE_VERSION = "0.1.0"


class UserError(Exception):
    """A problem the user can fix (shown as-is in the app)."""


# ----------------------------------------------------------------------------
# Parsing
# ----------------------------------------------------------------------------

_CLOCK = re.compile(r"^-?\d+:\d{1,2}(:\d{1,2})?(\.\d+)?$")
_MISSING = {"", "nan", "na", "n/a", "-", "--", "null", "none", "#n/a", "#value!", "#div/0!"}


def _num(cell, comma_decimal=False):
    s = str(cell).strip()
    if s.lower() in _MISSING:
        return None
    if comma_decimal:
        s = s.replace(",", ".")
    if s.endswith("%"):
        s = s[:-1]
    try:
        return float(s)
    except ValueError:
        return None


def _clock(cell):
    s = str(cell).strip()
    if not _CLOCK.match(s):
        return None
    neg = s.startswith("-")
    parts = s.lstrip("-").split(":")
    try:
        vals = [float(p) for p in parts]
    except ValueError:
        return None
    if len(vals) == 2:
        sec = vals[0] * 60 + vals[1]
    else:
        sec = vals[0] * 3600 + vals[1] * 60 + vals[2]
    return -sec if neg else sec


def _is_value(cell, comma_decimal):
    return _num(cell, comma_decimal) is not None or _clock(cell) is not None


def read_table(text):
    """Parse pasted or exported text (LabChart Data Pad, Excel, Prism, CSV) into a DataFrame.

    Returns (df, info). Numeric and clock-time columns become floats (clock times in seconds);
    other columns stay text. info["kinds"] maps column -> "number" | "time" | "text".
    """
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
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
    start = 0
    for i, r in enumerate(rows[:50]):
        filled = [c for c in r if str(c).strip() != ""]
        if filled and sum(_is_value(c, comma_decimal) for c in filled) >= max(1, 0.5 * len(filled)):
            start = i
            break
    else:
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
    sheets = pd.read_excel(io.BytesIO(raw), sheet_name=None, header=None, dtype=str)
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
    return ("%.4g" % x)


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
    "lablens": ["#2F5D8A", "#D1495B", "#E9A23B", "#00798C", "#6B4E9B", "#7A7A7A", "#3E8E41", "#B5651D"],
    "okabe": ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#CC79A7", "#56B4E9", "#F0E442", "#000000"],
    "tol": ["#4477AA", "#EE6677", "#228833", "#CCBB44", "#66CCEE", "#AA3377", "#BBBBBB"],
    "muted": ["#4C72B0", "#DD8452", "#55A868", "#C44E52", "#8172B3", "#937860", "#DA8BC3", "#8C8C8C"],
    "pastel": ["#8DA0CB", "#FC8D62", "#66C2A5", "#E78AC3", "#A6D854", "#FFD92F", "#E5C494", "#B3B3B3"],
    "ocean": ["#023E8A", "#0096C7", "#48CAE4", "#03045E", "#00B4D8", "#90E0EF"],
    "sunset": ["#3D348B", "#F18701", "#7678ED", "#F35B04", "#F7B801", "#9B2226"],
    "grayscale": ["#1F1F1F", "#8A8A8A", "#C4C4C4", "#525252", "#A8A8A8", "#6E6E6E"],
}

STYLE_DEFAULTS = {
    "width": 4.0, "height": 3.4, "font_size": 10, "line_width": 1.5, "marker_size": 5.0,
    "point_alpha": 0.85, "palette": "lablens", "custom_colors": "", "plot_kind": "bar",
    "error": "sem", "fill": "light", "show_points": True, "sig": "stars", "show_ns": False,
    "grid": False, "despine": True, "legend": "best", "title": "", "xlabel": "", "ylabel": "",
    "ymin": "", "ymax": "", "logy": False, "xrot": 0, "show_n": False, "theme": "light",
    "dpi": 300, "transparent": False, "title_bold": True, "font": "sans",
}

FONTS = {
    "sans": ["Arial", "Helvetica", "Liberation Sans", "DejaVu Sans"],
    "serif": ["Times New Roman", "Times", "Liberation Serif", "DejaVu Serif"],
    "mono": ["Menlo", "Consolas", "DejaVu Sans Mono"],
}


def _style(style):
    s = dict(STYLE_DEFAULTS)
    for k, v in (style or {}).items():
        if v is not None:
            s[k] = v
    for k in ("width", "height", "font_size", "line_width", "marker_size", "point_alpha", "xrot", "dpi"):
        try:
            s[k] = float(s[k])
        except (TypeError, ValueError):
            s[k] = float(STYLE_DEFAULTS[k])
    s["width"] = min(max(s["width"], 1.5), 20)
    s["height"] = min(max(s["height"], 1.5), 20)
    s["font_size"] = min(max(s["font_size"], 5), 40)
    dark = s["theme"] == "dark"
    s["fg"] = "#E6E8EC" if dark else "#1A1D23"
    s["bg"] = "#15181D" if dark else "#FFFFFF"
    return s


def _colors(s, n):
    base = list(PALETTES.get(s["palette"], PALETTES["lablens"]))
    custom = [c.strip() for c in re.split(r"[,\s]+", s.get("custom_colors") or "") if c.strip()]
    for i, c in enumerate(custom):
        try:
            to_rgb(c)
        except ValueError:
            continue
        if i < len(base):
            base[i] = c
        else:
            base.append(c)
    return [base[i % len(base)] for i in range(max(n, 1))]


def _rc(s):
    fs = s["font_size"]
    lw = s["line_width"]
    return {
        "font.family": FONTS.get(s.get("font"), FONTS["sans"]),
        "font.size": fs,
        "axes.titlesize": fs * 1.15,
        "axes.titleweight": "bold" if s.get("title_bold") else "normal",
        "axes.labelsize": fs,
        "xtick.labelsize": fs * 0.9,
        "ytick.labelsize": fs * 0.9,
        "legend.fontsize": fs * 0.85,
        "axes.linewidth": max(0.6, lw * 0.6),
        "xtick.major.width": max(0.6, lw * 0.6),
        "ytick.major.width": max(0.6, lw * 0.6),
        "axes.edgecolor": s["fg"], "axes.labelcolor": s["fg"], "text.color": s["fg"],
        "xtick.color": s["fg"], "ytick.color": s["fg"],
        "figure.facecolor": s["bg"], "axes.facecolor": s["bg"], "savefig.facecolor": s["bg"],
        "axes.spines.top": not s["despine"], "axes.spines.right": not s["despine"],
        "axes.grid": bool(s["grid"]), "grid.color": s["fg"], "grid.alpha": 0.13, "grid.linewidth": 0.6,
        "axes.axisbelow": True,
        "legend.frameon": False,
        "svg.fonttype": "none", "pdf.fonttype": 42,
    }


def _new_fig(s):
    with plt.rc_context(_rc(s)):
        fig, ax = plt.subplots(figsize=(s["width"], s["height"]))
    return fig, ax


def _shade(color, amount):
    """amount < 0 darkens, > 0 lightens."""
    r, g, b = to_rgb(color)
    if amount < 0:
        f = 1 + amount
        return (r * f, g * f, b * f)
    return (r + (1 - r) * amount, g + (1 - g) * amount, b + (1 - b) * amount)


# Plain numbers (0.1, 1, 10) on log axes; scientific superscripts read poorly as editable SVG text.
_LOG_FMT = FuncFormatter(lambda v, _: ("%g" % v) if 1e-4 <= v < 1e6 else ("%.0e" % v))


def _finish(ax, s, xlabel="", ylabel="", title="", legend=False):
    ax.set_xlabel(s["xlabel"] or xlabel)
    ax.set_ylabel(s["ylabel"] or ylabel)
    t = s["title"] or title
    if t:
        ax.set_title(t, pad=10)
    if s["logy"]:
        ax.set_yscale("log")
        ax.yaxis.set_major_formatter(_LOG_FMT)
    if ax.get_xscale() == "log":
        ax.xaxis.set_major_formatter(_LOG_FMT)
    lo, hi = ax.get_ylim()
    try:
        lo = float(s["ymin"]) if str(s["ymin"]).strip() != "" else lo
    except ValueError:
        pass
    try:
        hi = float(s["ymax"]) if str(s["ymax"]).strip() != "" else hi
    except ValueError:
        pass
    if hi > lo:
        ax.set_ylim(lo, hi)
    if s["xrot"]:
        for lab in ax.get_xticklabels():
            lab.set_rotation(s["xrot"])
            lab.set_ha("right" if 0 < s["xrot"] < 90 else "center")
    if legend and s["legend"] != "none" and ax.get_legend_handles_labels()[0]:
        if s["legend"] == "outside":
            ax.legend(loc="center left", bbox_to_anchor=(1.02, 0.5))
        else:
            ax.legend(loc=s["legend"])


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


def plot_groups(ax, names, values, s, paired_matrix=None):
    """Draw one column per group. values: list of 1-D arrays. Returns the top of each group."""
    colors = _colors(s, len(names))
    kind = s["plot_kind"]
    fg, bg = s["fg"], s["bg"]
    lw = s["line_width"]
    ms = s["marker_size"]
    rng = np.random.default_rng(7)
    xs = np.arange(len(names), dtype=float)
    tops = []
    point_x = []

    def fill_for(c):
        if s["fill"] == "solid":
            return to_rgba(c, 0.9)
        if s["fill"] == "outline":
            return (0, 0, 0, 0)
        return to_rgba(c, 0.25)

    for i, (v, c) in enumerate(zip(values, colors)):
        v = np.asarray(v, float)
        fin = v[np.isfinite(v)]
        x = xs[i]
        m = float(np.mean(fin)) if len(fin) else np.nan
        e = _err(fin, s["error"])
        top = [m + e] if np.isfinite(m) else []
        jitter_w = 0.12 if kind != "dot" else 0.16
        px_center = x
        if kind == "raincloud":
            px_center = x + 0.24
            jitter_w = 0.05
        if paired_matrix is not None:
            jx = np.full(len(v), px_center)
        else:
            jx = px_center + rng.uniform(-jitter_w, jitter_w, len(v))
        point_x.append(jx)

        if len(fin) == 0:
            tops.append(0.0)
            continue
        if kind == "bar":
            ax.bar(x, m, width=0.62, color=fill_for(c), edgecolor=c, linewidth=lw, zorder=2)
            if e:
                ax.errorbar(x, m, yerr=e, fmt="none", ecolor=fg if s["fill"] == "solid" else c,
                            elinewidth=lw, capsize=ms * 0.9, capthick=lw, zorder=4)
        elif kind == "box":
            bp = ax.boxplot([fin], positions=[x], widths=0.5, patch_artist=True,
                            showfliers=not s["show_points"], zorder=2)
            for b in bp["boxes"]:
                b.set(facecolor=fill_for(c), edgecolor=c, linewidth=lw)
            for part in ("whiskers", "caps"):
                for ln in bp[part]:
                    ln.set(color=c, linewidth=lw)
            for ln in bp["medians"]:
                ln.set(color=fg if s["fill"] == "solid" else c, linewidth=lw * 1.4)
            for f in bp["fliers"]:
                f.set(markeredgecolor=c, markersize=ms * 0.8)
        elif kind in ("violin", "raincloud"):
            if len(fin) >= 2 and np.ptp(fin) > 0:
                vp = ax.violinplot([fin], positions=[x], widths=0.75 if kind == "violin" else 0.9,
                                   showextrema=False)
                for body in vp["bodies"]:
                    body.set_facecolor(fill_for(c) if s["fill"] != "outline" else (0, 0, 0, 0))
                    body.set_edgecolor(c)
                    body.set_linewidth(lw * 0.8)
                    body.set_alpha(None)
                    if kind == "raincloud":
                        verts = body.get_paths()[0].vertices
                        verts[:, 0] = np.minimum(verts[:, 0], x)
                    body.set_zorder(2)
            q1, med, q3 = np.percentile(fin, [25, 50, 75])
            bx = x if kind == "violin" else x + 0.07
            ax.plot([bx, bx], [q1, q3], color=fg, linewidth=lw * 2.6, solid_capstyle="butt", zorder=3)
            ax.scatter([bx], [med], s=(ms * 1.1) ** 2, color=bg, edgecolor=fg, linewidth=lw * 0.6, zorder=4)
        elif kind == "dot":
            ax.plot([x - 0.22, x + 0.22], [m, m], color=c if s["fill"] != "solid" else fg,
                    linewidth=lw * 1.6, solid_capstyle="round", zorder=4)
            if e:
                ax.errorbar(x, m, yerr=e, fmt="none", ecolor=c if s["fill"] != "solid" else fg,
                            elinewidth=lw, capsize=ms * 1.2, capthick=lw, zorder=4)
        top.append(float(np.max(fin)))
        tops.append(max(top))

    if paired_matrix is not None and len(names) > 1:
        line_c = to_rgba(fg, 0.28)
        for row in paired_matrix:
            ax.plot([point_x[j][0] for j in range(len(names))], row, color=line_c,
                    linewidth=max(0.6, lw * 0.6), zorder=3)

    if s["show_points"] or kind == "dot" or kind == "raincloud":
        for i, (v, c) in enumerate(zip(values, colors)):
            v = np.asarray(v, float)
            ok = np.isfinite(v)
            face = _shade(c, -0.35) if s["fill"] == "solid" and kind in ("bar", "box") else c
            ax.scatter(point_x[i][ok], v[ok], s=ms ** 2, color=to_rgba(face, s["point_alpha"]),
                       edgecolor=to_rgba(bg, 0.9), linewidth=0.5, zorder=5)

    labels = list(names)
    if s["show_n"]:
        labels = ["%s\n(n=%d)" % (nm, np.isfinite(np.asarray(v, float)).sum()) for nm, v in zip(names, values)]
    ax.set_xticks(xs)
    ax.set_xticklabels(labels)
    ax.set_xlim(-0.6, len(names) - 0.4)
    if s["despine"]:
        ax.tick_params(axis="x", length=0)
    if kind == "bar" and not s["logy"]:
        lo = min([0.0] + [float(np.nanmin(np.asarray(v, float))) for v in values if np.isfinite(v).any()])
        if lo >= 0:
            ax.set_ylim(bottom=0)
    return tops


def draw_brackets(ax, comparisons, tops, s):
    """comparisons: list of (i, j, p). Stacks brackets above the groups."""
    show = [(i, j, p) for i, j, p in comparisons if s["show_ns"] or (p is not None and p < 0.05)]
    if s["sig"] == "none" or not show:
        return
    log = s["logy"]
    tr = (lambda y: math.log10(max(y, 1e-12))) if log else (lambda y: y)
    inv = (lambda y: 10 ** y) if log else (lambda y: y)
    lo, hi = ax.get_ylim()
    lo_t, hi_t = tr(lo) if log else lo, tr(max(hi, max(tops) if tops else hi))
    span = (hi_t - lo_t) or 1.0
    gap, tick = span * 0.06, span * 0.025
    text_h = span * (0.075 if s["sig"] == "p" else 0.065)
    level = [tr(t) if t > 0 or not log else lo_t for t in tops]
    top_used = hi_t
    for i, j, p in sorted(show, key=lambda c: (abs(c[1] - c[0]), c[0])):
        a, b = min(i, j), max(i, j)
        y = max(level[a:b + 1]) + gap
        ax.plot([a, a, b, b], [inv(y - tick), inv(y), inv(y), inv(y - tick)],
                color=s["fg"], linewidth=max(0.7, s["line_width"] * 0.6), clip_on=False, zorder=6)
        label = stars(p) if s["sig"] == "stars" else fmt_p(p)
        ax.text((a + b) / 2, inv(y + span * 0.005), label, ha="center", va="bottom",
                fontsize=s["font_size"] * (1.0 if s["sig"] == "stars" else 0.8), color=s["fg"], zorder=6)
        for k in range(a, b + 1):
            level[k] = y + text_h
        top_used = max(top_used, y + text_h + span * 0.02)
    if str(s["ymax"]).strip() == "":
        ax.set_ylim(top=inv(top_used))


def describe(names, values):
    cols = ["Group", "n", "Mean", "SD", "SEM", "95% CI low", "95% CI high", "Median", "Q1", "Q3", "Min", "Max"]
    rows = []
    for nm, v in zip(names, values):
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


def compare_stats(names, values, paired=False, mode="auto", posthoc="all", equal_var=False):
    """Pick and run the right test. Returns a dict used for text, tables, brackets and methods."""
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

    # Normality (on differences when paired with 2 groups)
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
            dz = np.mean(d) / np.std(d, ddof=1) if np.std(d, ddof=1) > 0 else np.nan
            out.update(test="Paired t-test", p=r.pvalue,
                       line="t(%d) = %.3f, %s, Cohen's dz = %.2f" % (len(d) - 1, r.statistic, fmt_p(r.pvalue), dz))
        elif paired:
            r = stats.wilcoxon(b, a)
            out.update(test="Wilcoxon matched-pairs signed-rank test", p=r.pvalue,
                       line="W = %.1f, %s" % (r.statistic, fmt_p(r.pvalue)))
        elif parametric:
            r = stats.ttest_ind(a, b, equal_var=bool(equal_var))
            n1, n2 = len(a), len(b)
            v1, v2 = np.var(a, ddof=1), np.var(b, ddof=1)
            if equal_var:
                df = n1 + n2 - 2
            else:
                df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1))
            sp = math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2)) if n1 + n2 > 2 else np.nan
            g = (np.mean(b) - np.mean(a)) / sp * (1 - 3 / (4 * (n1 + n2) - 9)) if sp else np.nan
            name = "Student's t-test" if equal_var else "Welch's t-test"
            out.update(test=name, p=r.pvalue,
                       line="t(%.1f) = %.3f, %s, Hedges' g = %.2f" % (df, r.statistic, fmt_p(r.pvalue), g))
        else:
            r = stats.mannwhitneyu(a, b, alternative="two-sided")
            out.update(test="Mann-Whitney U test", p=r.pvalue, line="U = %.1f, %s" % (r.statistic, fmt_p(r.pvalue)))
        out["pairs"] = [(0, 1, out["p"])]
        out["method"] = "Groups were compared with a two-sided %s." % _article(out["test"])
        return out

    # Three or more groups
    pairs = [(i, j) for i in range(k) for j in range(i + 1, k)] if posthoc == "all" else [(0, j) for j in range(1, k)]
    ph_name = ""
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
            raw = [stats.wilcoxon(mat[:, j], mat[:, i]).pvalue for i, j in pairs]
            ph_name = "Wilcoxon signed-rank tests with Holm correction"
        adj = _holm(raw)
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


def _article(test):
    t = test[0].lower() + test[1:] if test.split(" ")[0] in ("One-way", "Repeated-measures", "Paired") else test
    return t


def _methods(s, res, extra=""):
    err = ERROR_NAMES.get(s["error"], "SEM")
    kind = s["plot_kind"]
    if kind in ("box",):
        shown = "Box plots show the median and interquartile range (whiskers 1.5 x IQR)"
    elif kind in ("violin", "raincloud"):
        shown = "Violin plots show the data distribution with median and interquartile range"
    else:
        shown = "Data are shown as mean" + (" +/- %s" % err if err else "")
    if s["show_points"] or kind in ("dot", "raincloud"):
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
    return ("Analyses were performed in LabLens %s (Python %d.%d, NumPy %s, SciPy %s, pandas %s, matplotlib %s)."
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
            raise UserError("Long layout needs a value column and a group column.")
        _need_col(df, vcol, "value")
        _need_col(df, gcol, "group")
        labels = df[gcol].astype(str).str.strip()
        found = [g for g in dict.fromkeys(labels) if g and g.lower() != "nan"]
        names = _order(found, S.get("group_order"))
        values = [pd.to_numeric(df.loc[labels == g, vcol], errors="coerce").to_numpy(float) for g in names]
        ylabel = vcol
    else:
        cols = [c for c in (S.get("columns") or []) if c in df.columns] or _numeric_cols(df, info)
        if not cols:
            raise UserError("No numeric columns found to compare.")
        names = _order(cols, S.get("group_order"))
        values = [pd.to_numeric(df[c], errors="coerce").to_numpy(float) for c in names]
        ylabel = S.get("y_name") or ""
    if not names:
        raise UserError("No groups found.")
    res = compare_stats(names, values, paired=paired, mode=S.get("test", "auto"),
                        posthoc=S.get("posthoc", "all"), equal_var=S.get("equal_var", False))
    fig, ax = _new_fig(s)
    with plt.rc_context(_rc(s)):
        pm = np.column_stack(values) if paired else None
        tops = plot_groups(ax, names, values, s, paired_matrix=pm)
        _finish(ax, s, ylabel=ylabel)
        draw_brackets(ax, res["pairs"], tops, s)
    summary = []
    if res["test"]:
        summary.append({"label": res["test"], "value": res["line"], "p": _r(res["p"])})
    tables = [describe(names, values)] + stats_tables(names, res)
    return {
        "figures": [{"id": "groups", "title": "Group comparison", "fig": fig, "style": s}],
        "tables": tables, "summary": summary, "notes": res["notes"],
        "methods": _methods(s, res),
    }


def _parse_clock_value(text, mult):
    t = str(text or "").strip()
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
        m = re.match(r"^(.+?)\s*(?:-|–|to)\s*(.+)$", part)
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
        return float(v)
    except (TypeError, ValueError):
        return default


NORM_LABELS = {"pct": "% of baseline", "delta": "change from baseline", "fold": "fold of baseline", "raw": ""}


def analysis_timecourse(datasets, S, s):
    sessions = [d for d in datasets if (d.get("text") or "").strip()]
    if not sessions:
        raise UserError("Add at least one recording (Data step). Each table is one session.")
    mult = {"seconds": 1.0, "minutes": 60.0, "hours": 3600.0}.get(S.get("time_unit", "seconds"), 1.0)
    bin_s = _f(S, "bin", 30.0)
    bs, be = _f(S, "baseline_start", -5.0), _f(S, "baseline_end", 0.0)
    ws, we = _f(S, "window_start", -10.0), _f(S, "window_end", 30.0)
    es, ee = _f(S, "endpoint_start", 25.0), _f(S, "endpoint_end", 30.0)
    norm = S.get("norm", "pct")
    metric = S.get("metric", "mean")
    vmin, vmax = _f(S, "valid_min", None), _f(S, "valid_max", None)
    fcol = S.get("filter_col") or ""
    fmin, fmax = _f(S, "filter_min", None), _f(S, "filter_max", None)
    notes = []

    per = []  # dicts: name, group, subject, k (bin idx), v (normalized), base
    tcol = vcol = None
    for d in sessions:
        meta = d.get("meta") or {}
        df, info = read_table(d["text"])
        num = _numeric_cols(df, info)
        times = [c for c in df.columns if info["kinds"][c] == "time"]
        tcol = S.get("time_col") or (times[0] if times else (num[0] if num else None))
        vcol = S.get("value_col") or next((c for c in num if c != tcol), None)
        if tcol not in df.columns or vcol not in df.columns:
            raise UserError('Session "%s" has no column "%s" or "%s". All sessions need the same column names.'
                            % (d.get("name"), tcol, vcol))
        t = df[tcol].to_numpy(float)
        if info["kinds"][tcol] != "time":
            t = t * mult
        v = df[vcol].to_numpy(float)
        ok = np.isfinite(t) & np.isfinite(v)
        if vmin is not None:
            ok &= v >= vmin
        if vmax is not None:
            ok &= v <= vmax
        if fcol and fcol in df.columns:
            fv = pd.to_numeric(df[fcol], errors="coerce").to_numpy(float)
            if fmin is not None:
                ok &= fv >= fmin
            if fmax is not None:
                ok &= fv <= fmax
        for a, b in _parse_ranges(meta.get("exclude"), mult):
            ok &= ~((t >= a) & (t <= b))
        ev = _parse_clock_value(meta.get("event"), mult)
        if ev is None:
            ev = 0.0
            notes.append('"%s" has no event time, so time 0 was used.' % d.get("name"))
        trel = t[ok] - ev
        vv = v[ok]
        step = bin_s if bin_s > 0 else (float(np.median(np.diff(np.sort(trel)))) if len(trel) > 2 else 1.0)
        k = np.floor(trel / step).astype(int)
        binned = pd.Series(vv).groupby(k).mean()
        kk = binned.index.to_numpy()
        bv = binned.to_numpy(float)
        centers = (kk + 0.5) * step / 60.0
        in_base = (centers >= bs) & (centers <= be)
        base = float(np.mean(bv[in_base])) if in_base.any() else np.nan
        if not in_base.any():
            notes.append('"%s" has no data in the baseline window.' % d.get("name"))
        if norm == "pct":
            nv, ref = bv / base * 100.0, 100.0
        elif norm == "fold":
            nv, ref = bv / base, 1.0
        elif norm == "delta":
            nv, ref = bv - base, 0.0
        else:
            nv, ref = bv, base
        per.append({"name": d.get("name") or "Session", "group": (meta.get("group") or "Group").strip(),
                    "subject": (meta.get("subject") or d.get("name") or "").strip(), "k": kk, "v": nv,
                    "centers": centers, "base": base, "ref": ref, "step": step, "event": ev})

    step = per[0]["step"]
    groups = _order(list(dict.fromkeys(p["group"] for p in per)), S.get("group_order"))
    colors = _colors(s, len(groups))

    # Endpoint per session
    for p in per:
        sel = (p["centers"] >= es) & (p["centers"] <= ee) & np.isfinite(p["v"])
        y = p["v"][sel]
        if not len(y):
            p["end"] = np.nan
            continue
        if metric == "min":
            p["end"] = float(np.min(y))
        elif metric == "max":
            p["end"] = float(np.max(y))
        elif metric == "auc":
            x = p["centers"][sel]
            p["end"] = float(np.trapz(y - p["ref"], x)) if len(y) > 1 else np.nan
        else:
            p["end"] = float(np.mean(y))
        if not np.isfinite(p["end"]):
            notes.append('"%s" has no data in the endpoint window.' % p["name"])

    # ---- Time-course figure
    unit = NORM_LABELS.get(norm, "")
    ylabel = "%s (%s)" % (vcol, unit) if unit else vcol
    event_label = S.get("event_label") or "event"
    fig, ax = _new_fig(s)
    lw = s["line_width"]
    tc_rows = []
    with plt.rc_context(_rc(s)):
        if S.get("shade_baseline", True):
            ax.axvspan(bs, be, color=to_rgba(s["fg"], 0.06), lw=0, zorder=0)
        if S.get("shade_endpoint", True):
            ax.axvspan(es, ee, color=to_rgba(colors[min(1, len(colors) - 1)], 0.08), lw=0, zorder=0)
        if norm != "raw":
            ax.axhline(per[0]["ref"], color=to_rgba(s["fg"], 0.35), lw=max(0.6, lw * 0.5), ls=(0, (2, 3)), zorder=1)
        for gi, g in enumerate(groups):
            members = [p for p in per if p["group"] == g]
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
            with np.errstate(all="ignore"):
                n = np.isfinite(mat).sum(axis=1)
                mean = np.nanmean(mat, axis=1)
                sd = np.nanstd(mat, axis=1, ddof=1)
                sem = sd / np.sqrt(n)
            c = colors[gi]
            if S.get("show_traces", True) and len(members) > 1:
                for j in range(len(members)):
                    ax.plot(x, mat[:, j], color=to_rgba(c, 0.35), lw=max(0.5, lw * 0.5), zorder=2)
            band = S.get("band", "sem")
            if band != "none" and len(members) > 1:
                e = sd if band == "sd" else sem
                ax.fill_between(x, mean - e, mean + e, color=to_rgba(c, 0.18), lw=0, zorder=2)
            ax.plot(x, mean, color=c, lw=lw * 1.3, zorder=3, label="%s (n=%d)" % (g, len(members)))
            for xi, m_, s_, n_ in zip(x, mean, sem, n):
                tc_rows.append([g, _r(xi), _r(m_), _r(s_), int(n_)])
        if S.get("show_event", True):
            ax.axvline(0, color=to_rgba(s["fg"], 0.6), lw=max(0.7, lw * 0.6), ls=(0, (4, 3)), zorder=1)
            ax.annotate(event_label, xy=(0, 1), xycoords=("data", "axes fraction"), xytext=(0, 3),
                        textcoords="offset points", ha="center", va="bottom", fontsize=s["font_size"] * 0.85,
                        color=to_rgba(s["fg"], 0.75))
        ax.set_xlim(ws, we)
        ss = dict(s, logy=False)
        _finish(ax, ss, xlabel="Time from %s (min)" % event_label.lower(), ylabel=ylabel, legend=True)

    # ---- Endpoint figure + stats
    paired = bool(S.get("pair_subjects")) and len(groups) > 1
    if paired:
        subjects = [sub for sub in dict.fromkeys(p["subject"] for p in per)
                    if all(any(p["subject"] == sub and p["group"] == g for p in per) for g in groups)]
        dropped = len(set(p["subject"] for p in per)) - len(subjects)
        if dropped:
            notes.append("%d subject(s) without a session in every group were left out of the paired comparison."
                         % dropped)
        values = [np.array([next(p["end"] for p in per if p["subject"] == sub and p["group"] == g)
                            for sub in subjects]) for g in groups]
    else:
        values = [np.array([p["end"] for p in per if p["group"] == g]) for g in groups]
    res = compare_stats(groups, values, paired=paired, mode=S.get("test", "auto"),
                        posthoc=S.get("posthoc", "all"), equal_var=S.get("equal_var", False))
    metric_name = {"mean": "Mean", "min": "Minimum", "max": "Maximum", "auc": "Net AUC"}.get(metric, "Mean")
    end_label = "%s %s, %g to %g min" % (metric_name, unit or vcol, es, ee) if metric != "auc" else \
        "Net AUC vs baseline, %g to %g min" % (es, ee)
    fig2, ax2 = _new_fig(dict(s, width=max(2.4, min(s["width"], 1.1 + 0.9 * len(groups)))))
    s2 = dict(s, width=max(2.4, min(s["width"], 1.1 + 0.9 * len(groups))), title="", xlabel="", logy=False)
    with plt.rc_context(_rc(s2)):
        pm = np.column_stack(values) if paired else None
        tops = plot_groups(ax2, groups, values, s2, paired_matrix=pm)
        if norm != "raw" and metric != "auc":
            ax2.axhline(per[0]["ref"], color=to_rgba(s["fg"], 0.35), lw=max(0.6, lw * 0.5), ls=(0, (2, 3)), zorder=1)
        _finish(ax2, dict(s2, ylabel=""), ylabel=end_label)
        draw_brackets(ax2, res["pairs"], tops, s2)

    sess_rows = [[p["name"], p["group"], p["subject"], _fmt_clock(p["event"]), _r(p["base"]), _r(p["end"])]
                 for p in per]
    tables = [
        {"title": "Sessions", "columns": ["Session", "Group", "Subject", "Event", "Baseline (raw)", end_label],
         "rows": sess_rows},
        describe(groups, values),
    ] + stats_tables(groups, res) + [
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
    }[norm if norm in NORM_LABELS else "pct"]
    extra = ("%s was %s, aligned to the %s, and %s (baseline = mean from %g to %g min). "
             "The endpoint was the %s from %g to %g min after the %s."
             % (vcol, bin_txt, event_label.lower(), norm_txt, bs, be,
                metric_name.lower() if metric != "auc" else "net area under the curve relative to baseline",
                es, ee, event_label.lower()))
    s_meth = dict(s)
    s_meth["error"] = S.get("band", "sem") if S.get("band", "sem") != "none" else s["error"]
    return {
        "figures": [
            {"id": "timecourse", "title": "Time course", "fig": fig, "style": s},
            {"id": "endpoint", "title": "Endpoint", "fig": fig2, "style": s2},
        ],
        "tables": tables, "summary": summary, "notes": notes + res["notes"],
        "methods": _methods(s_meth, res, extra),
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
    gcol = S.get("group_col") or ""
    if gcol and gcol in df.columns:
        labels = df[gcol].astype(str).str.strip()
        groups = _order([g for g in dict.fromkeys(labels) if g and g.lower() != "nan"], S.get("group_order"))
    else:
        labels = pd.Series(["All"] * len(df))
        groups = ["All"]
    method = S.get("method", "pearson")
    colors = _colors(s, len(groups))
    fig, ax = _new_fig(s)
    rows, summary, notes = [], [], []
    lw, ms = s["line_width"], s["marker_size"]
    with plt.rc_context(_rc(s)):
        for gi, g in enumerate(groups):
            sel = labels == g
            x = pd.to_numeric(df.loc[sel, xcol], errors="coerce").to_numpy(float)
            y = pd.to_numeric(df.loc[sel, ycol], errors="coerce").to_numpy(float)
            ok = np.isfinite(x) & np.isfinite(y)
            x, y = x[ok], y[ok]
            c = colors[gi]
            lab = g if len(groups) > 1 else None
            ax.scatter(x, y, s=ms ** 2 * 1.3, color=to_rgba(c, s["point_alpha"]), edgecolor=to_rgba(s["bg"], 0.9),
                       linewidth=0.5, zorder=3, label=lab)
            if len(x) < 3:
                notes.append("%s: need at least 3 points for a correlation." % g)
                continue
            if method == "spearman":
                r, p = stats.spearmanr(x, y)
                rname = "Spearman rho"
            else:
                r, p = stats.pearsonr(x, y)
                rname = "Pearson r"
            lr = stats.linregress(x, y)
            rows.append([g, len(x), _r(r), _r(p), _r(lr.slope), _r(lr.intercept), _r(lr.rvalue ** 2)])
            summary.append({"label": "%s%s" % (rname, " (%s)" % g if len(groups) > 1 else ""),
                            "value": "%s = %.3f, %s, n = %d" % ("rho" if method == "spearman" else "r", r, fmt_p(p), len(x)),
                            "p": _r(p)})
            if S.get("fit", True):
                xx = np.linspace(x.min(), x.max(), 100)
                yy = lr.intercept + lr.slope * xx
                ax.plot(xx, yy, color=c, lw=lw * 1.2, zorder=2)
                if S.get("ci", True) and len(x) > 2:
                    n = len(x)
                    resid = y - (lr.intercept + lr.slope * x)
                    se = math.sqrt(np.sum(resid ** 2) / (n - 2))
                    tval = stats.t.ppf(0.975, n - 2)
                    sxx = np.sum((x - x.mean()) ** 2)
                    band = tval * se * np.sqrt(1 / n + (xx - x.mean()) ** 2 / sxx) if sxx > 0 else 0
                    ax.fill_between(xx, yy - band, yy + band, color=to_rgba(c, 0.15), lw=0, zorder=1)
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
            "tables": tables, "summary": summary, "notes": notes, "methods": meth}


def _four_pl(logx, bottom, top, log_ec50, hill):
    return bottom + (top - bottom) / (1 + 10 ** ((log_ec50 - logx) * hill))


def analysis_dose(datasets, S, s):
    d = _pick_dataset(datasets, S.get("dataset"))
    df, info = read_table(d["text"])
    num = _numeric_cols(df, info)
    xcol = S.get("x_col") or (num[0] if num else None)
    if not xcol:
        raise UserError("Choose the concentration column.")
    _need_col(df, xcol, "concentration")
    ycols = [c for c in (S.get("y_cols") or []) if c in df.columns and c != xcol] or [c for c in num if c != xcol]
    if not ycols:
        raise UserError("Choose at least one response column.")
    mode = S.get("mode", "curves")
    x_all = pd.to_numeric(df[xcol], errors="coerce").to_numpy(float)
    if mode == "replicates":
        curves = [(S.get("curve_name") or "Response", ycols)]
    else:
        curves = [(c, [c]) for c in ycols]
    colors = _colors(s, len(curves))
    fix_bottom, fix_top = _f(S, "fix_bottom", None), _f(S, "fix_top", None)
    scale = _f(S, "x_scale", 1.0)
    unit = S.get("x_unit") or ""
    fig, ax = _new_fig(s)
    rows, summary, notes, guides = [], [], [], []
    lw, ms = s["line_width"], s["marker_size"]
    with plt.rc_context(_rc(s)):
        for ci, (name, cols) in enumerate(curves):
            c = colors[ci]
            Y = np.column_stack([pd.to_numeric(df[cc], errors="coerce").to_numpy(float) for cc in cols])
            x = x_all * scale
            pos = np.isfinite(x) & (x > 0)
            if (~pos & np.isfinite(x)).any():
                notes.append("%s: concentrations of 0 or below can't go on a log axis and were left out." % name)
            xs, Ys = x[pos], Y[pos]
            lx = np.log10(xs)
            px = np.repeat(lx, Ys.shape[1])
            py = Ys.reshape(-1)
            ok = np.isfinite(py)
            px, py = px[ok], py[ok]
            if len(px) == 0:
                continue
            # points: mean +/- error per concentration when replicated
            ux = np.unique(lx)
            means = np.array([np.nanmean(Ys[lx == u]) for u in ux])
            errs = np.array([_err(Ys[lx == u].reshape(-1), s["error"]) for u in ux])
            if Ys.shape[1] > 1 and not S.get("all_points", False):
                ax.errorbar(10 ** ux, means, yerr=errs if s["error"] != "none" else None, fmt="o", color=c,
                            ms=ms * 1.1, mec=s["bg"], mew=0.5, elinewidth=lw * 0.8, capsize=ms * 0.6, zorder=4,
                            label=name)
            else:
                ax.scatter(10 ** px, py, s=ms ** 2 * 1.2, color=to_rgba(c, s["point_alpha"]),
                           edgecolor=to_rgba(s["bg"], 0.9), linewidth=0.5, zorder=4, label=name)
            if len(ux) < 4:
                notes.append("%s: a 4-parameter fit needs at least 4 concentrations." % name)
                continue
            free = ["bottom", "top", "log_ec50", "hill"]
            fixed = {}
            if fix_bottom is not None:
                fixed["bottom"] = fix_bottom
            if fix_top is not None:
                fixed["top"] = fix_top
            free = [f for f in free if f not in fixed]
            slope_sign = np.sign(np.corrcoef(px, py)[0, 1]) or 1.0
            guess = {"bottom": float(np.min(means)), "top": float(np.max(means)),
                     "log_ec50": float(np.median(ux)), "hill": float(slope_sign)}
            if slope_sign < 0:
                guess["bottom"], guess["top"] = float(np.min(means)), float(np.max(means))

            def model(lxv, *params):
                kw = dict(fixed)
                kw.update(dict(zip(free, params)))
                return _four_pl(lxv, kw["bottom"], kw["top"], kw["log_ec50"], kw["hill"])

            try:
                popt, pcov = curve_fit(model, px, py, p0=[guess[f] for f in free], maxfev=20000)
            except Exception:
                notes.append("%s: the curve fit did not converge." % name)
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
            label = S.get("ec_label") or ("IC50" if par["hill"] * (par["top"] - par["bottom"]) < 0 else "EC50")
            xx = np.linspace(ux.min() - 0.3, ux.max() + 0.3, 300)
            ax.plot(10 ** xx, model(xx, *popt), color=c, lw=lw * 1.2, zorder=3)
            guides.append((ec50, (par["top"] + par["bottom"]) / 2, c))
            rows.append([name, label, _r(ec50), _r(lo), _r(hi), _r(par["log_ec50"]), _r(par["hill"]),
                         _r(par["bottom"]), _r(par["top"]), _r(r2), len(px)])
            summary.append({"label": "%s %s" % (name, label),
                            "value": "%s %s (95%% CI %s to %s), Hill slope %.2f, R² = %.3f"
                                     % (_fmt(ec50), unit, _fmt(lo), _fmt(hi), par["hill"], r2), "p": None})
        ax.set_xscale("log")
        if S.get("show_ec50", True):
            lo_y, hi_y = ax.get_ylim()
            for ec50, yhalf, c in guides:
                ax.plot([ec50, ec50], [lo_y, yhalf], color=to_rgba(c, 0.6), lw=max(0.6, lw * 0.6),
                        ls=(0, (3, 3)), zorder=2)
            ax.set_ylim(lo_y, hi_y)
        _finish(ax, s, xlabel="%s%s" % (xcol, " (%s)" % unit if unit else ""), ylabel=ycols[0] if len(curves) == 1 and mode != "replicates" else "Response",
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
    if any(len(cols) > 1 for _, cols in curves):
        meth = "Points show mean +/- %s of replicates. " % ERROR_NAMES.get(s["error"], "SEM") + meth
    return {"figures": [{"id": "dose", "title": "Dose-response", "fig": fig, "style": s}],
            "tables": tables, "summary": summary, "notes": notes, "methods": meth}


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
    _LAST["figures"] = out["figures"]
    figs = [{"id": f["id"], "title": f["title"], "svg": _svg(f["fig"], f["style"])} for f in out["figures"]]
    return {"figures": figs, "tables": out["tables"], "summary": out["summary"], "notes": out["notes"],
            "methods": out["methods"]}


def export_figure(index, fmt, dpi=300, transparent=False):
    if index >= len(_LAST["figures"]):
        raise UserError("Run the analysis first.")
    f = _LAST["figures"][index]
    s = f["style"]
    buf = io.BytesIO()
    with plt.rc_context(_rc(s)):
        f["fig"].savefig(buf, format=fmt, dpi=dpi, bbox_inches="tight", pad_inches=0.08,
                         transparent=bool(transparent), facecolor="none" if transparent else s["bg"])
    return base64.b64encode(buf.getvalue()).decode("ascii")


def versions():
    return {"engine": ENGINE_VERSION, "python": "%d.%d.%d" % sys.version_info[:3], "numpy": np.__version__,
            "scipy": scipy.__version__, "pandas": pd.__version__, "matplotlib": matplotlib.__version__}


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
        for gi, (group, mean_drop) in enumerate((("Saline", 0.0), ("Morphine", 0.40))):
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
                                   int(args.get("dpi", 300)), args.get("transparent", False))
        elif cmd == "excel":
            result = excel_to_tables(args["b64"])
        elif cmd == "example":
            result = example(args["kind"])
        elif cmd == "versions":
            result = versions()
        else:
            raise UserError("Unknown command %s" % cmd)
        return json.dumps({"ok": result}, allow_nan=False, default=_json_default)
    except UserError as e:
        return json.dumps({"error": str(e)})
    except Exception as e:  # unexpected: give the user the message, keep the trace for debugging
        return json.dumps({"error": "Something went wrong: %s" % e, "trace": traceback.format_exc()})


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return _r(float(o))
    if isinstance(o, np.ndarray):
        return [_json_default(x) for x in o.tolist()]
    return str(o)


def cli(config_json, datasets_json, out_dir="lablens_output"):
    """Used by exported scripts: re-runs the analysis and saves figures and tables."""
    import os
    os.makedirs(out_dir, exist_ok=True)
    config = json.loads(config_json)
    datasets = json.loads(datasets_json)
    out = run(config, datasets)
    s = _style(config.get("style"))
    for i, f in enumerate(_LAST["figures"]):
        for fmt in ("png", "pdf", "svg"):
            path = os.path.join(out_dir, "%d_%s.%s" % (i + 1, f["id"], fmt))
            with plt.rc_context(_rc(f["style"])):
                f["fig"].savefig(path, dpi=s["dpi"], bbox_inches="tight", pad_inches=0.08,
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
