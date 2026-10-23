"use strict";
// Plain-English figure commands ("remove gridlines", "make Saline red") turned into style settings.
// Runs entirely in the browser. `interpretCommand(text, ctx)` edits ctx.style / ctx.settings in place
// and returns what it changed and which parts it couldn't understand.
(function (global) {
  const STYLE_DEFAULTS = {
    marker_size: 5, line_width: 1.5, font_size: 10, point_alpha: 0.85, bar_width: 0.62, jitter: 0.12,
    width: 4, height: 3.4, grid_alpha: 0.15, tick_length: 3.5, fill_alpha: 0.25,
  };
  const PRESETS = ["clean", "journal", "classic", "minimal", "editorial", "boxed", "typewriter", "soft", "poster", "slides", "neon", "sketch"];
  const PALETTES = [
    [/\bokabe|\bcolou?r[- ]?blind/, "okabe", "Okabe-Ito colorblind-safe palette", false],
    [/\btol\b/, "tol", "Tol bright palette", false],
    [/\bpastels?\b/, "pastel", "Pastel palette", false],
    [/\bgr[ae]y ?scale|\bblack[- ]and[- ]white|\bmonochrome|\bb ?& ?w\b/, "grayscale", "Grayscale palette", false],
    [/\bmuted\b/, "muted", "Muted palette", false],
    [/\bocean\b/, "ocean", "Ocean palette", true],
    [/\bsunset\b/, "sunset", "Sunset palette", true],
    [/\bearth(y| tones?)?\b/, "earth", "Earth palette", true],
    [/\bneon\b/, "neon", "Neon palette", true],
    [/\bdefault colou?rs\b|\bserpentine colou?rs\b|\boriginal colou?rs\b/, "serpentine", "Serpentine palette", false],
  ];
  const AMBIGUOUS_CMAPS = new Set(["blues", "greens", "reds", "purples", "oranges", "greys", "hot", "cool", "spring", "summer", "autumn", "winter", "ocean", "copper", "bone", "rainbow", "terrain", "hsv", "pink"]);
  const FONTS = [
    [/\bpt ?serif\b/, "ptserif", "PT Serif", true],
    [/\bspace ?mono\b/, "spacemono", "Space Mono", true],
    [/\bsans[- ]?serif\b|\bsans\b|\barial\b|\bhelvetica\b/, "sans", "Sans-serif", false],
    [/\bserif\b|\btimes( new roman)?\b/, "serif", "Serif", false],
    [/\bmono(space(d)?)?\b|\bcode font\b/, "mono", "Monospace", false],
    [/\blato\b/, "lato", "Lato", true],
    [/\bfira( sans)?\b/, "fira", "Fira Sans", true],
    [/\bbarlow\b/, "barlow", "Barlow", true],
    [/\bpoppins\b/, "poppins", "Poppins", true],
    [/\bcrimson( text)?\b/, "crimson", "Crimson Text", true],
    [/\bcourier( prime)?\b/, "courier", "Courier Prime", true],
    [/\bcomic( neue| sans)?\b/, "comic", "Comic Neue", true],
  ];
  const KINDS = [
    [/\bbox ?(and|\+|plus|&)? ?violin|\bviolin ?(with|plus|and|\+|&) ?(a )?box/, "boxviolin", "box + violin"],
    [/\brain ?cloud/, "raincloud", "raincloud"],
    [/\bbee ?swarm|\bswarm/, "beeswarm", "beeswarm"],
    [/\bviolin/, "violin", "violin"],
    [/\bbox ?plots?\b|\bbox[- ]and[- ]whiskers?\b|\b(make it|use|switch to|change (it )?to|turn (it )?into|show|as) (a )?box(es)?\b/, "box", "box plot"],
    [/\blollipops?\b/, "lollipop", "lollipop"],
    [/\bstrip ?(plot|chart)s?\b|\bjust (the )?(points|dots)\b|\bonly (the )?(points|dots)\b/, "strip", "strip plot"],
    [/\bscatter ?dot|\bdot ?plots?\b|\bscatter ?plots?\b/, "dot", "scatter dot plot"],
    [/\bmean (±|\+-|\+\/-|plus[- ]minus|and|with) (error|sem|sd)\b|\bmeans? only\b|\bjust (the )?means?\b/, "mean", "mean ± error"],
    [/\bbar ?(chart|graph|plot)s?\b|\b(make it|use|switch to|change (it )?to|back to|turn (it )?into|as) (a )?bars?\b/, "bar", "bar chart"],
  ];
  const MARKERS = [
    [/\bsquares?\b/, "s", "squares"], [/\b(triangles?|triangular)\b/, "^", "triangles"], [/\bdiamonds?\b/, "D", "diamonds"],
    [/\bstars?\b/, "*", "stars"], [/\bcircles?\b|\bround (points|dots|markers)\b/, "o", "circles"], [/\bcross(es)?\b|\bx[- ]?(marks?|markers?)\b/, "X", "crosses"],
    [/\bplus(es)?( signs?)?\b/, "P", "plus signs"], [/\bhexagons?\b/, "h", "hexagons"], [/\bpentagons?\b/, "p", "pentagons"],
  ];
  const HATCHES = [
    [/\bcross ?hatch(ed|ing)?\b/, "x", "crosshatch"], [/\bdots? pattern|\bdotted (fill|bars?|pattern)|\bpolka/, ".", "dots"],
    [/\bgrid pattern|\bchecker/, "+", "grid pattern"], [/\bhorizontal (stripes|lines pattern)/, "-", "horizontal stripes"],
    [/\bvertical (stripes|lines pattern)/, "|", "vertical stripes"], [/\bhatch(ed|ing)?\b|\bstripe[sd]?\b|\bdiagonal lines\b|\bpattern(ed)?\b/, "//", "diagonal stripes"],
  ];
  const NEG = /\b(no|not|remove|hide|without|turn off|get rid of|delete|disable|don'?t|dont|lose|drop|kill|off|none)\b/;
  const SHOW = /\b(show|add|display|turn on|enable|bring back|include|put|with)\b/;
  const STOP = new Set(["make", "the", "a", "an", "group", "groups", "color", "colour", "to", "in", "and", "of", "for", "set", "change", "turn", "bar", "bars", "box", "points", "dots", "line", "lines", "it", "be", "should", "please", "use", "with", "give", "marker", "markers", "pattern", "is", "as", "into", "dashed", "dotted", "solid"]);

  const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  const numOr = (v, d) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : d;
  };
  const toIn = (v, unit) => (/mm/.test(unit || "") ? v / 25.4 : /cm/.test(unit || "") ? v / 2.54 : v);

  const TYPOS = [
    [/\bleg[ae]nd\b|\bledgend\b|\blegened\b/g, "legend"], [/\bverticle\b|\bvertial\b/g, "vertical"], [/\bhoriz(o|a)n?t?al\b|\bhorizantal\b|\bhorizonal\b/g, "horizontal"],
    [/\baxies\b|\baxises\b|\baxis's\b/g, "axes"], [/\blables?\b/g, (m) => (m.endsWith("s") ? "labels" : "label")], [/\btit(el|tle)\b/g, "title"],
    [/\bback ?gr(o|ou)u?nd\b|\bbackround\b|\bbackgroud\b/g, "background"], [/\btransparant\b|\btransparrent\b/g, "transparent"], [/\bthiker\b/g, "thicker"],
    [/\bgrid ?lines?\b|\bgridline\b/g, "gridlines"], [/\bcolou?rs?\b/g, (m) => (m.endsWith("s") ? "colors" : "color")], [/\bcolur\b|\bcoler\b/g, "color"],
    [/\bgr[ae]y\b/g, "gray"], [/\bsignifican(ce|t)\b|\bsignificants?\b/g, (m) => m], [/\bviol(e|i)ne?\b/g, "violin"], [/\bdiamter\b/g, "diameter"],
    [/\berror ?bar\b/g, "error bar"], [/\bpvalues?\b/g, "p values"], [/\bp-values?\b/g, "p values"], [/\bx-axis\b/g, "x axis"], [/\by-axis\b/g, "y axis"],
    [/\bmake (it|them|the figure) (look )?(more )?/g, "make it "],
  ];
  const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, eighteen: 18, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, hundred: 100 };
  // Words the reader knows; a near-miss spelling of one of these is corrected (gridlnes → gridlines).
  const VOCAB = ["gridlines", "legend", "background", "horizontal", "vertical", "title", "label", "labels", "points", "error", "transparent",
    "remove", "change", "bigger", "smaller", "thicker", "thinner", "darker", "lighter", "violin", "raincloud", "beeswarm", "lollipop",
    "boxplot", "colors", "color", "palette", "viridis", "magma", "plasma", "inferno", "cividis", "italic", "italicize", "outline", "outlines",
    "markers", "marker", "squares", "triangles", "diamonds", "circles", "significance", "stars", "baseline", "endpoint", "minutes", "seconds",
    "rotate", "minor", "ticks", "inside", "outside", "logarithmic", "reference", "decimal", "decimals", "export", "download", "rename",
    "reverse", "order", "spearman", "pearson", "nonparametric", "parametric", "paired", "unpaired", "percent", "normalize", "professional",
    "presentation", "everything", "readable", "landscape", "portrait", "orientation", "sideways", "solid", "hollow", "striped", "hatched",
    "dashed", "dotted", "frame", "spines", "floating", "offset", "journal", "poster", "slides", "minimal", "editorial", "font", "serif"];
  // Ordinary words that sit one letter away from a keyword and must never be "corrected".
  const KEEP = new Set(("start starts started first every white black green brown these there their three seven eight after under above below " +
    "about other would could should along again inner outer right lower upper large small short taller wider place space steps scale range " +
    "model mouse notes value values group groups names units shape sizes style theme thick thing curve curves table cells ratio doses plots " +
    "chart graph image while label later legends error point pointy lines limit limits fills filled solids dots minus plus shade shades " +
    "frames order orders panel panels title titles serif sense spine stare starry stack total trace traces width height times color front older sides slide fronts posts tones fonts boxes bolder").split(" "));
  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }
  function correctSpelling(text, protect) {
    return text.replace(/[a-z]{5,}/gi, (w) => {
      const lw = w.toLowerCase();
      if (VOCAB.includes(lw) || KEEP.has(lw) || protect.has(lw)) return w;
      const limit = lw.length >= 8 ? 2 : 1;
      const close = VOCAB.filter((v) => editDistance(lw, v) <= limit);
      return close.length === 1 ? close[0] : w;
    });
  }

  function normalizeInput(text, protectWords) {
    let t = String(text || "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/−/g, "-");
    const lower = t.toLowerCase();
    // Keep user-written text (titles, labels, names) untouched: only fix typos outside quotes.
    if (!/["']/.test(t) && !/\b(title|label|rename|call|legend title|event label|name)\b/.test(lower)) {
      for (const [re, rep] of TYPOS) t = t.replace(new RegExp(re.source, "gi"), (m) => (typeof rep === "function" ? rep(m.toLowerCase()) : rep));
      t = correctSpelling(t, protectWords || new Set());
    }
    t = t.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|eighteen|twenty|thirty|forty|fifty|sixty|hundred)\b(?![- ](sided|column|third|half))/gi,
      (m) => String(NUMBER_WORDS[m.toLowerCase()]));
    return t;
  }

  const hexToRgb = (h) => {
    h = String(h || "#000000").replace("#", "");
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
  };
  const rgbToHex = (a) => "#" + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const lighten = (h, f) => rgbToHex(hexToRgb(h).map((v) => v + (255 - v) * f));
  const darken = (h, f) => rgbToHex(hexToRgb(h).map((v) => v * (1 - f)));

  // "Did you mean" for commands that weren't understood: rank known phrases by shared words.
  function suggestCommands(text, phrases, n = 2) {
    const words = String(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
    if (!words.length) return [];
    return phrases.map((p) => {
      const pw = p.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const hit = pw.filter((w) => words.some((x) => x === w || (x.length > 3 && w.length > 3 && (w.startsWith(x.slice(0, 4)) || x.startsWith(w.slice(0, 4)))))).length;
      return { p, s: hit / Math.sqrt(pw.length) };
    }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.p);
  }

  function splitClauses(text) {
    // Protect phrases containing "and" that are one idea.
    let t = " " + text.trim() + " ";
    const keep = [
      [/\bblack and white\b/gi, "black-and-white"], [/\bbox and violin\b/gi, "box+violin"], [/\bbox and whiskers?\b/gi, "box-and-whisker"],
      [/\bmean and (error|sem|sd)\b/gi, "mean ± $1"], [/\btop and right\b/gi, "top&right"], [/\bleft and bottom\b/gi, "left&bottom"],
      [/\bbottom and left\b/gi, "left&bottom"], [/\bright and top\b/gi, "top&right"], [/\bx and y\b/gi, "x&y"],
    ];
    for (const [re, rep] of keep) t = t.replace(re, rep);
    t = t.replace(/\b((?:re)?order|arrange|sort)\b([^;.]*)/i, (m, verb, rest) => verb + rest.replace(/,/g, " §").replace(/\s+then\s+/g, " § "));
    const verbs = "make|set|use|add|remove|hide|show|change|turn|put|rename|relabel|give|colou?r|switch|increase|decrease|no|title|call|move|apply|start|rotate|tilt|label|draw|plot|flip|bold|get|drop|delete|reverse|thicker|thinner|bigger|smaller|larger|export|download|copy|save|swap|order|reorder|italic|italicize|fix|font|legend|gridlines|grid|background|baseline|endpoint|bins?|ticks|minor|stars|log|dark|light|transparent|horizontal|vertical|solid|hollow|wider|narrower|y axis|x axis|spearman|pearson|paired|unpaired|nonparametric|parametric|lighter|darker|everything";
    const parts = t.split(new RegExp(`\\s*;\\s*|(?<!\\b\\w\\.\\w)\\.\\s+(?=\\S)|\\s+then\\s+|,\\s*(?:and\\s+)?(?=(?:${verbs})\\b|[a-z])|\\s+and\\s+(?=(?:${verbs})\\b)|\\s+also\\s+`, "i"));
    // Drop closing punctuation, but keep abbreviations such as "i.p." or "s.c."
    return parts.map((p) => p.trim()).map((p) => (/\b\w\.\w\.$/.test(p) ? p : p.replace(/[.!?]+$/, ""))).filter(Boolean)
      .map((p) => p.replace(/top&right/g, "top and right").replace(/left&bottom/g, "left and bottom").replace(/x&y/g, "x and y"));
  }

  function findGroup(clause, groups) {
    const lc = clause.toLowerCase();
    let best = null;
    for (const g of groups) {
      for (const nm of [g.name, g.label]) {
        const n = String(nm || "").toLowerCase().trim();
        if (n && lc.includes(n) && (!best || n.length > best.len)) best = { g, len: n.length, text: n };
      }
    }
    if (best) return best;
    const ord = lc.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\b(?= (group|bar|box|one|condition|column|violin|curve|line))/);
    if (ord && groups.length) {
      const idx = { first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, fifth: 4, "5th": 4, last: groups.length - 1 }[ord[1]];
      if (groups[idx]) return { g: groups[idx], len: 0, text: ord[0] };
    }
    // Partial match: score each group by the words it shares with the command.
    const words = lc.split(/[^a-z0-9µ.]+/).filter((w) => w && !STOP.has(w) && (w.length >= 3 || /\d/.test(w)));
    let scored = groups.map((g) => {
      const gw = new Set(String(g.label + " " + g.name).toLowerCase().split(/[^a-z0-9µ.]+/).filter(Boolean));
      return { g, score: words.filter((w) => gw.has(w) || [...gw].some((x) => x.length >= 4 && w.length >= 4 && x.startsWith(w))).length };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    if (scored.length && (scored.length === 1 || scored[0].score > scored[1].score)) return { g: scored[0].g, len: 0, text: "" };
    return null;
  }

  function findColor(text, parseColor) {
    const hex = text.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/i);
    if (hex) return { hex: hex[0], name: hex[0] };
    const words = text.toLowerCase().replace(/[^a-z\s-]/g, " ").split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      for (const n of [3, 2]) {
        if (i + n <= words.length) {
          const joined = words.slice(i, i + n).join("");
          const c = parseColor(joined);
          if (c) return { hex: c, name: words.slice(i, i + n).join(" ") };
        }
      }
    }
    for (const w of words) {
      if (STOP.has(w) || w.length < 3) continue;
      const c = parseColor(w);
      if (c) return { hex: c, name: w };
    }
    return null;
  }

  function interpretCommand(input, ctx) {
    const style = ctx.style;
    const settings = ctx.settings || {};
    const groups = ctx.groups || [];
    const groupPlot = ctx.analysis === "compare" || ctx.analysis === "timecourse";
    const changes = [];
    const unknown = [];
    const say = (msg) => changes.push(msg);
    const cur = (k) => numOr(style[k], STYLE_DEFAULTS[k]);
    const setGroup = (g, key, value) => {
      style.groups = style.groups || {};
      style.groups[g.name] = { ...(style.groups[g.name] || {}), [key]: value };
    };
    const colormaps = (ctx.colormaps || []).map((m) => [m, m.toLowerCase()]);

    let lastMode = null;
    const VERB_START = /^(make|set|use|add|remove|hide|show|change|turn|put|rename|relabel|give|colou?r|switch|increase|decrease|no|call|move|apply|start|rotate|tilt|label|draw|flip|bold|get|drop|delete|reverse|export|download|copy|save|swap|order|reorder|fix|display|include|bring|undo|redo|reset|italic)/i;
    const protect = new Set(groups.flatMap((g) => String(g.name + " " + g.label).toLowerCase().split(/[^a-z]+/)).filter(Boolean));
    // Colour names (coral, salmon, khaki…) are words too
    for (const w of String(input).toLowerCase().match(/[a-z]{5,}/g) || []) if (ctx.parseColor && ctx.parseColor(w)) protect.add(w);
    for (const clause of splitClauses(normalizeInput(input, protect))) {
      let raw = clause.replace(/^(please|can you|could you|i want( to)?|i'?d like( to)?|let'?s|also|and)\s+/i, "").replace(/\s+please$/i, "");
      // "remove the gridlines and legend" → the second part inherits "remove"
      if (lastMode && !VERB_START.test(raw) && !/\d|#/.test(raw) && raw.split(/\s+/).length <= 4) raw = lastMode + " " + raw;
      lastMode = /^(remove|hide|delete|drop|get rid of|no)\b/i.test(raw) ? "remove" : /^(show|add|display|include)\b/i.test(raw) ? "show" : null;
      const c = " " + raw.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'") + " ";
      const neg = NEG.test(c);
      const before = changes.length;
      let colorUsed = false;
      const done = () => changes.length > before;

      // ---- Whole-clause commands
      if (/^\s*(undo|go back|revert)( that| it| last( change)?)?\s*$/.test(c)) { ctx.undo && ctx.undo(); say("Undid the last change"); continue; }
      if (/\b(reset|clear)\b.*\b(style|styling|look|everything|all|figure|formatting)\b|\bstart over\b|\bdefault (style|look)\b/.test(c)) { ctx.resetStyle && ctx.resetStyle(); say("Styling reset to defaults"); continue; }

      if (/^\s*(redo|redo that|do (that|it) again)\s*$/.test(c)) { ctx.redo && ctx.redo(); say("Redid the change"); continue; }

      // Actions: export, copy, save
      {
        const m = c.match(/\b(export|download|save)\b(?: (?:it|this|the figures?|figures?|the plot|the graph|my figure))?(?: (?:as|to|in))?(?: an?)? \.?(png|pdf|svg|tiff?|jpe?g|eps)\b/);
        if (m) { const fmt = { tif: "tiff", jpeg: "jpg" }[m[2]] || m[2]; ctx.action && ctx.action("export", fmt); say("Exporting as " + fmt.toUpperCase()); continue; }
        if (/\bcopy (the |this |my )?(figure|plot|graph|chart|image|it)\b|\bcopy to (the )?clipboard\b/.test(c)) { ctx.action && ctx.action("copy"); say("Copying the figure"); continue; }
        if (/\bsave (the |my |this )?(project|work|analysis|file)\b|^\s*save\s*$/.test(c)) { ctx.action && ctx.action("save"); say("Saving the project"); continue; }
        if (/\b(download|export|get) (the )?(python )?(script|code)\b/.test(c)) { ctx.action && ctx.action("script"); say("Downloading the Python script"); continue; }
      }

      // Overall feel → quick styles
      if (/\b(look|style|feel|vibe|make it|for (a|an|the|my)|ready|like a|like)\b/.test(c) || /^\s*\w+( looking)?\s*$/.test(c)) {
        const vibes = [
          [/\b(professional|publication[- ]ready|publishable|paper|journal|publication|manuscript|scientific|academic|nature|science|cell)\b/, "journal"],
          [/\b(elegant|fancy|magazine|sophisticated|classy|refined|editorial)\b/, "editorial"],
          [/\b(playful|fun|cute|friendly|cartoon|casual|sketchy|hand[- ]?drawn)\b/, "sketch"],
          [/\b(retro|vintage|old[- ]?school|old[- ]fashioned)\b/, "typewriter"],
          [/\b(modern|sleek|minimalist|airy|tufte)\b/, "minimal"],
          [/\b(traditional|prism|graphpad|old[- ]style)\b/, "classic"],
          [/\b(night|glow(ing|y)?|cyber(punk)?|futuristic|electric)\b/, "neon"],
          [/\b(posters?|conference)\b/, "poster"],
          [/\b(slides?|presentation|power ?point|keynote|talk|lecture|projector)\b/, "slides"],
          [/\b(gentle|calm|soothing)\b/, "soft"],
          [/\b(simple|plain|basic|default)\b(?! colors)/, "clean"],
          [/\b(framed|enclosed)\b/, "boxed"],
        ];
        const hit = vibes.find(([re]) => re.test(c));
        if (hit && !/\b(size|width|column|wide|tall|font)\b/.test(c) && ctx.applyPreset && ctx.applyPreset(hit[1])) {
          say(hit[1][0].toUpperCase() + hit[1].slice(1) + " style applied"); continue;
        }
      }

      // Everything at once
      if (/\b(everything|all of it|the whole (figure|thing)|more readable|easier to read|readable|legible)\b/.test(c)) {
        if (/\b(bigger|larger|readable|legible|easier to read)\b/.test(c)) {
          style.font_size = Math.min(40, cur("font_size") + 2); style.marker_size = round(cur("marker_size") * 1.25, 1); style.line_width = round(cur("line_width") * 1.25, 2);
          say("Text, points and lines larger"); continue;
        }
        if (/\bsmaller\b/.test(c)) {
          style.font_size = Math.max(5, cur("font_size") - 2); style.marker_size = round(cur("marker_size") * 0.8, 1); style.line_width = round(Math.max(0.3, cur("line_width") * 0.8), 2);
          say("Text, points and lines smaller"); continue;
        }
        if (/\bbold\b/.test(c)) { style.title_bold = true; style.label_bold = true; style.line_width = round(cur("line_width") * 1.3, 2); say("Bold text and heavier lines"); continue; }
        if (/\bthicker\b/.test(c)) { style.line_width = round(cur("line_width") * 1.4, 2); style.axis_width = round(numOr(style.axis_width, Math.max(0.6, cur("line_width") * 0.6)) * 1.4, 2); say("All lines thicker"); continue; }
      }

      // Italic text (gene and species names)
      if (/\bitalic(s|i[sz]e[ds]?)?\b/.test(c)) {
        const on = !/\b(not|no|un-?italic|remove|regular|upright|normal)\b/.test(c);
        let hit = false;
        if (/\btitle\b/.test(c)) { style.title_italic = on; hit = true; say(on ? "Italic title" : "Title upright"); }
        if (/\b(axis )?labels?\b|\baxis\b/.test(c) && !/\b(tick|group|categor)/.test(c)) { style.label_italic = on; hit = true; say(on ? "Italic axis labels" : "Axis labels upright"); }
        if (/\b(group|tick|category|categor(y|ies)|names?|genes?|species|strains?|x labels)\b/.test(c)) { style.tick_italic = on; hit = true; say(on ? "Italic group and tick labels" : "Group and tick labels upright"); }
        if (!hit) { style.tick_italic = on; say(on ? "Italic group and tick labels" : "Group and tick labels upright"); }
        continue;
      }

      // ---- Analysis settings
      {
        const N = "(-?\\d+(?:\\.\\d+)?)";
        let m;
        if (ctx.analysis === "timecourse") {
          if ((m = c.match(new RegExp(`\\bbaseline\\b[^0-9-]*${N}\\s*(?:to|and|-|–|through)\\s*${N}`)))) { settings.baseline_start = parseFloat(m[1]); settings.baseline_end = parseFloat(m[2]); say(`Baseline window ${m[1]} to ${m[2]} min`); }
          else if ((m = c.match(/\b(last|final) (\d+(\.\d+)?) ?(min|minutes)? (before|of baseline|pre)/)) || (m = c.match(/\bbaseline (is |=|of )?(?:the )?(last )?(\d+(\.\d+)?) ?(min|minutes)\b/))) { const v = parseFloat(m[2] && !isNaN(parseFloat(m[2])) ? m[2] : m[3]); settings.baseline_start = -v; settings.baseline_end = 0; say(`Baseline window ${-v} to 0 min`); }
          if ((m = c.match(new RegExp(`\\bend ?point\\b[^0-9-]*${N}\\s*(?:to|and|-|–|through)\\s*${N}`)))) { settings.endpoint_start = parseFloat(m[1]); settings.endpoint_end = parseFloat(m[2]); say(`Endpoint window ${m[1]} to ${m[2]} min`); }
          else if ((m = c.match(/\b(last|final) (\d+(\.\d+)?) ?(min|minutes)\b/)) && /\b(end ?point|average|mean|summar)/.test(c)) { const end = numOr(settings.window_end, 30); const v = parseFloat(m[2]); settings.endpoint_start = end - v; settings.endpoint_end = end; say(`Endpoint window ${end - v} to ${end} min`); }
          if ((m = c.match(new RegExp(`\\b(?:show|display|time window|display window|window|plot|time range|time axis|x range|zoom (?:in )?(?:to|on))\\b[^0-9-]*${N}\\s*(?:to|and|-|–|through)\\s*${N}`))) && !/\b(baseline|end ?point|y axis)\b/.test(c)) { settings.window_start = parseFloat(m[1]); settings.window_end = parseFloat(m[2]); say(`Showing ${m[1]} to ${m[2]} min`); }
          if ((m = c.match(/\b(\d+(\.\d+)?)\s*(s|sec|secs|seconds?|min|mins|minutes?)?[- ]?bins?\b/)) || (m = c.match(/\bbin(?:s| size| width)?\s*(?:of|to|=|at)?\s*(\d+(\.\d+)?)\s*(s|sec|secs|seconds?|min|mins|minutes?)?/))) {
            let v = parseFloat(m[1]); if (/^min/.test(m[3] || "")) v *= 60; settings.bin = v; say(v ? `Bins of ${v} s` : "No binning");
          } else if (/\bno bin(ning|s)?\b|\bdon'?t bin\b|\bunbinned\b|\braw (data )?points\b/.test(c)) { settings.bin = 0; say("No binning"); }
          if (/\b(%|percent(age)?) (of )?baseline\b|\bnormali[sz]e (it |the data |values )?(to|by|against) (the )?baseline\b|\bas (a )?percent(age)?\b/.test(c)) { settings.norm = "pct"; say("Values as % of baseline"); }
          else if (/\bchange from baseline\b|\bsubtract (the )?baseline\b|\bdelta\b|\bminus baseline\b/.test(c)) { settings.norm = "delta"; say("Values as change from baseline"); }
          else if (/\bfold\b/.test(c)) { settings.norm = "fold"; say("Values as fold of baseline"); }
          else if (/\b(raw|original|absolute|actual) (values|data|units|numbers)\b|\bno normali[sz]ation\b|\bdon'?t normali[sz]e\b|\bun-?normali[sz]ed\b/.test(c)) { settings.norm = "raw"; say("Raw values (no normalization)"); }
          if (/\b(nadir|minimum|lowest( point| value)?|trough)\b/.test(c) && !/\b(y|axis|ymin)\b/.test(c)) { settings.metric = "min"; say("Endpoint: minimum (nadir)"); }
          else if (/\b(peak|maximum|highest( point| value)?)\b/.test(c) && !/\b(y|axis|ymax)\b/.test(c)) { settings.metric = "max"; say("Endpoint: maximum (peak)"); }
          else if (/\b(auc|area under( the)?( curve)?)\b/.test(c)) { settings.metric = "auc"; say("Endpoint: net area under the curve"); }
          else if (/\b(mean|average) (of the )?end ?point\b|\bend ?point (mean|average)\b/.test(c)) { settings.metric = "mean"; say("Endpoint: mean"); }
          if (/\bunpaired\b|\bindependent (groups|animals)\b|\bdon'?t pair\b|\bnot paired\b/.test(c)) { settings.pair_subjects = false; say("Sessions not paired"); }
          else if (/\bpair(ed|ing)?\b.*\b(subjects?|animals?|mice|rats|by subject)\b|\bsame (animals|mice|subjects)\b|\brepeated measures\b|^\s*(make it )?paired\s*$/.test(c)) { settings.pair_subjects = true; say("Sessions paired by subject"); }
          if ((m = raw.match(/\b(?:event label|event name|call the (?:event|injection)|rename (?:the )?(?:injection|event)(?: line| marker| label)?(?: to)?|label the (?:injection|event)(?: line)?(?: as)?)\s*(?:to|as|:|=)?\s*["']?(.+?)["']?\s*$/i))) { settings.event_label = m[1].trim(); say(`Event label: “${settings.event_label}”`); }
          if ((m = c.match(/\btime (column )?(is )?in (seconds|minutes|hours)\b/))) { settings.time_unit = m[3]; say("Time column in " + m[3]); }
        } else if (ctx.analysis === "compare") {
          if (/\bunpaired\b|\bindependent( groups| samples)?\b|\bnot paired\b/.test(c)) { settings.paired = false; say("Unpaired groups"); }
          else if (/\bpaired\b|\brepeated measures\b|\bsame (subjects|animals|mice|patients)\b|\bbefore (and|vs\.?) after\b/.test(c)) { settings.paired = true; settings.layout = "wide"; say("Paired (each row is one subject)"); }
          if (/\bnon[- ]?parametric\b|\bmann[- ]?whitney\b|\bkruskal\b|\brank[- ]based\b|\bwilcoxon\b|\bfriedman\b/.test(c)) { settings.test = "nonparam"; say("Non-parametric test"); }
          else if (/\bparametric\b|\bt[- ]?tests?\b|\banova\b/.test(c)) { settings.test = "param"; say("Parametric test (t-test / ANOVA)"); }
          else if (/\b(automatic|auto) (test|stats|statistics)\b|\bchoose the test\b/.test(c)) { settings.test = "auto"; say("Test chosen automatically"); }
          if (/\b(compare|test)\b.*\b(to|with|against|vs\.?)\b.*\b(control|first( group)?|vehicle|baseline|reference)\b|\bvs\.? (the )?control\b|\bdunnett\b/.test(c)) { settings.posthoc = "control"; say("Each group compared with the first"); }
          else if (/\b(all|every) (pairs?|comparisons)\b|\bpairwise\b|\btukey\b|\bcompare (all|every)( groups)?\b/.test(c)) { settings.posthoc = "all"; say("Every pair of groups compared"); }
          if (/\bwelch\b|\bunequal variances?\b/.test(c)) { settings.equal_var = false; say("Welch's correction on"); }
          else if (/\bequal variances?\b|\bstudent'?s\b/.test(c)) { settings.equal_var = true; say("Equal variances assumed"); }
          if (/\b(%|percent(age)?) (of )?(the )?(control|first group|vehicle|reference)\b|\bnormali[sz]e (it |the data |values )?(to|by|against) (the )?(control|first group|vehicle)\b/.test(c)) { settings.normalize = "pct_control"; say("Values as % of the first group"); }
          else if (/\bfold (of|over|change|vs\.?)\b.*\b(control|first|vehicle)\b|\bfold change\b/.test(c)) { settings.normalize = "fold_control"; say("Values as fold of the first group"); }
          else if (/\bdifference from (the )?(control|first group|vehicle)\b|\bsubtract (the )?(control|vehicle)\b/.test(c)) { settings.normalize = "delta_control"; say("Values as difference from the first group"); }
          else if (/\b(raw|original|actual) (values|data|numbers)\b|\bno normali[sz]ation\b|\bdon'?t normali[sz]e\b/.test(c)) { settings.normalize = "none"; say("Values as entered"); }
          if ((m = c.match(/\bcall (it|the (y|value|measurement)( axis)?)\s+(.+)$/))) { /* handled by labels */ }
        } else if (ctx.analysis === "correlation") {
          if (/\bspearman\b|\brank correlation\b/.test(c)) { settings.method = "spearman"; say("Spearman correlation"); }
          else if (/\bpearson\b|\blinear correlation\b/.test(c)) { settings.method = "pearson"; say("Pearson correlation"); }
          if (/\b(fit|regression|trend|best[- ]fit) ?lines?\b|\b(line of best fit|regression)\b/.test(c)) { settings.fit = !NEG.test(c); say(settings.fit ? "Linear fit shown" : "Linear fit hidden"); }
          if (/\b(confidence|ci) (band|interval|shading|region)\b|\bshaded band\b/.test(c)) { settings.ci = !NEG.test(c); say(settings.ci ? "Confidence band shown" : "Confidence band hidden"); }
          if (/\b(r and p|r value|stats text|correlation text|statistics text|annotation)\b/.test(c)) { settings.annotate = !NEG.test(c); say(settings.annotate ? "r and p printed on the plot" : "r and p not printed"); }
        } else if (ctx.analysis === "dose") {
          if ((m = c.match(/\b(?:fix|lock|constrain|set) (?:the )?bottom(?: of the curve)? (?:at|to|=)\s*(-?\d+(\.\d+)?)/))) { settings.fix_bottom = m[1]; say("Bottom fixed at " + m[1]); }
          if ((m = c.match(/\b(?:fix|lock|constrain|set) (?:the )?top(?: of the curve)? (?:at|to|=)\s*(-?\d+(\.\d+)?)/))) { settings.fix_top = m[1]; say("Top fixed at " + m[1]); }
          if (/\b(unfix|free|don'?t fix|let (it|them) (vary|float))\b/.test(c)) { settings.fix_bottom = ""; settings.fix_top = ""; say("Top and bottom fitted freely"); }
          if ((m = c.match(/\b(ic50|ec50|ed50)\b/)) && /\b(call|label|name|use|it'?s|is)\b/.test(c) && !/\b(line|marker|hide|show)\b/.test(c)) { settings.ec_label = m[1].toUpperCase(); say("Midpoint called " + settings.ec_label); }
          if (/\b(ic50|ec50|ed50|midpoint) (lines?|markers?|guides?)\b/.test(c)) { settings.show_ec50 = !NEG.test(c); say(settings.show_ec50 ? "Midpoint marked" : "Midpoint marker hidden"); }
          if (/\b(every|all|each|individual) (replicates?|points|values)\b/.test(c)) { settings.all_points = !NEG.test(c); say(settings.all_points ? "Every replicate shown" : "Mean ± error shown"); }
        }
        if (done()) continue;
      }

      // ---- Group order
      if (groups.length > 1 && ctx.analysis !== "dose") {
        let m;
        const names = groups.map((g) => g.name);
        const setOrder = (list, msg) => { settings.group_order = list.join(", "); say(msg); };
        if (/\breverse (the )?(group |groups )?order\b|\bflip (the )?order\b|\b(groups )?in reverse( order)?\b/.test(c)) { setOrder(names.slice().reverse(), "Group order reversed"); continue; }
        if ((m = raw.match(/\b(?:re)?order\b(?: the)?(?: groups)?\s*(?:as|to|:|=|like|by)?\s*(.+§.+)$/i)) || (m = raw.match(/\b(?:arrange|sort)\b(?: the)?(?: groups)?\s*(?:as|to|:|=|like)?\s*(.+§.+)$/i))) {
          const wanted = m[1].split("§").map((x) => findGroup(x.trim(), groups)).filter(Boolean).map((f) => f.g.name);
          const list = [...new Set(wanted.concat(names))];
          if (wanted.length) { setOrder(list, "Group order: " + list.join(", ")); continue; }
        }
        if ((m = raw.match(/^(?:put|move|place|show)?\s*(?:the\s+)?(.+?)\s+(first|last|at the (?:start|beginning|front|end|back)|to the (?:start|beginning|front|end|back)|on the (?:left|right)|on top|at the bottom)\s*$/i))) {
          const f = findGroup(m[1], groups);
          if (f) {
            const rest = names.filter((n) => n !== f.g.name);
            const front = /first|start|beginning|front|left|top/.test(m[2]);
            setOrder(front ? [f.g.name, ...rest] : [...rest, f.g.name], `${f.g.label || f.g.name} moved ${front ? "first" : "last"}`); continue;
          }
        }
        if ((m = raw.match(/\bswap (?:the )?(?:order|positions?|places) of (.+?) and (.+)$/i)) || ((m = raw.match(/\bswap (.+?) and (.+)$/i)) && !/colou?rs?/i.test(raw))) {
          const a = findGroup(m[1], groups), b = findGroup(m[2], groups);
          if (a && b && a.g !== b.g) { const list = names.slice(); const i = list.indexOf(a.g.name), j = list.indexOf(b.g.name); [list[i], list[j]] = [list[j], list[i]]; setOrder(list, `${a.g.name} and ${b.g.name} swapped`); continue; }
        }
      }
      // Swap colors
      if (/\bswap\b.*\bcolors?\b|\bcolors?\b.*\bswap(ped)?\b|\bswitch (the )?colors\b/.test(c) && groups.length >= 2) {
        const named = groups.filter((g) => c.includes(g.name.toLowerCase()) || c.includes(String(g.label).toLowerCase()));
        const pair = named.length >= 2 ? named.slice(0, 2) : groups.length === 2 ? groups : null;
        if (pair) {
          const colA = (style.groups?.[pair[0].name] || {}).color || pair[0].color, colB = (style.groups?.[pair[1].name] || {}).color || pair[1].color;
          setGroup(pair[0], "color", colB); setGroup(pair[1], "color", colA); say(`Colors of ${pair[0].name} and ${pair[1].name} swapped`); continue;
        }
      }
      // Lighter / darker groups
      if (/\b(lighter|paler|lighten|brighter|darker|deeper|darken)\b/.test(c) && !/\b(background|grid|text|font|fill|band|lines?\b|title|labels?\b|outline|axes|axis|legend|ticks?\b)/.test(c) && groups.length) {
        const dark = /\b(darker|deeper|darken)\b/.test(c);
        const f = findGroup(raw, groups);
        const targets = f && !/\b(all|every|everything|colors|groups)\b/.test(c) ? [f.g] : groups;
        for (const g of targets) {
          const curC = (style.groups?.[g.name] || {}).color || g.color || "#777777";
          setGroup(g, "color", dark ? darken(curC, 0.28) : lighten(curC, 0.35));
        }
        say(`${targets.length === groups.length && groups.length > 1 ? "All groups" : (targets[0].label || targets[0].name)} ${dark ? "darker" : "lighter"}`); continue;
      }
      // Warmer / cooler / vivid / muted palettes
      if (/\b(warm(er)?|cool(er)?|vivid|vibrant|bright|bold|saturated|punchy|muted|subdued|soft(er)?|earthy|natural)\b/.test(c) && /\b(colors?|palette|tones?|shades|make it|use)\b/.test(c) && !/\b(text|background|grid)\b/.test(c)) {
        const pick = /\bwarm/.test(c) ? ["sunset", "Warmer colors"] : /\bcool/.test(c) ? ["ocean", "Cooler colors"] : /\b(vivid|vibrant|bright|bold|saturated|punchy)\b/.test(c) ? ["tol", "Brighter colors"] : /\b(earthy|natural)\b/.test(c) ? ["earth", "Earthy colors"] : ["muted", "Softer colors"];
        style.palette = pick[0]; say(pick[1]); continue;
      }

      // Title
      if (/\btitle\b/.test(c) && !/\b(legend|axis|x|y)[- ](axis[- ])?title\b/.test(c)) {
        let m;
        if (/\b(left|right|cent(er|re))\b/.test(c) && /\b(align|move|put|position|on the|to the)\b|\b(left|right|cent(er|re))[- ]?(aligned)? title|title (on|to) the/.test(c)) {
          const pos = /left/.test(c) ? "left" : /right/.test(c) ? "right" : "center";
          style.title_align = pos; say("Title position: " + pos); continue;
        }
        if ((m = c.match(/\btitle\b[^0-9]*?(size|font)[^0-9]*?(\d+(\.\d+)?)|\b(\d+(\.\d+)?) ?(pt|points?)? title\b/))) {
          const v = parseFloat(m[2] || m[4]); style.title_size = v; say("Title size: " + v + " pt"); continue;
        }
        if (/\b(bigger|larger|increase)\b/.test(c)) { style.title_size = round(numOr(style.title_size, cur("font_size") * 1.15) * 1.25, 1); say("Title larger"); continue; }
        if (/\b(smaller|decrease)\b/.test(c)) { style.title_size = round(numOr(style.title_size, cur("font_size") * 1.15) * 0.8, 1); say("Title smaller"); continue; }
        if (/\bbold\b/.test(c)) { const on = !/\b(un ?bold|not bold|no bold|normal)\b/.test(c); style.title_bold = on; say(on ? "Bold title" : "Title not bold"); continue; }
        if (neg && !/\bnot\b.*\btitle\b.*\bbut\b/.test(c)) { style.title = ""; say("Title removed"); continue; }
        if ((m = raw.match(/\btitle\b\s*(?:to|as|:|=|saying|that says|reading|of|is)?\s*["']?(.+?)["']?\s*$/i)) && m[1] && !/^(on|at|in)\b/i.test(m[1])) {
          style.title = m[1].trim(); say(`Title: “${style.title}”`); continue;
        }
      }

      // Axis labels
      {
        const m = c.match(/\b(x|y|horizontal|vertical)[- ]?(axis)?[- ]?(label|title|name)s?\b/) || c.match(/\b(label|rename|title)\b.*\b(the )?(x|y)[- ]?axis\b/);
        if (m) {
          const axis = /\b(y|vertical)\b/.test(m[0]) || /\by[- ]?axis/.test(m[0]) ? "y" : "x";
          const key = axis + "label";
          if (/\b(size)\b/.test(c) || /\b(bigger|smaller)\b/.test(c)) { /* falls through to size rules */ }
          else if (/\bbold\b/.test(c)) { style.label_bold = !/\b(not|un ?bold|no)\b/.test(c); say(style.label_bold ? "Bold axis labels" : "Axis labels not bold"); continue; }
          else if (neg) { style[key] = " "; say(axis.toUpperCase() + "-axis label hidden"); continue; }
          else {
            const t = raw.match(/\b(?:x|y|horizontal|vertical)(?:[- ]?axis)?(?:[- ]?(?:label|title|name))?s?\b(?:\s+(?:to|as|is|saying|reading)\b|\s*[:=])?\s*["']?(.+?)["']?\s*$/i);
            if (t && t[1] && !/^(label|title)$/i.test(t[1])) { style[key] = t[1].trim(); say(`${axis.toUpperCase()}-axis label: “${style[key]}”`); continue; }
          }
        }
        if (/\bbold\b/.test(c) && /\b(axis )?labels\b/.test(c) && !/\btick/.test(c)) { style.label_bold = !/\b(not|un ?bold|no)\b/.test(c); say(style.label_bold ? "Bold axis labels" : "Axis labels not bold"); continue; }
      }

      // Rename a group
      {
        let m = raw.match(/\b(?:rename|relabel)\s+(?:the\s+)?(.+?)\s+(?:group\s+)?(?:to|as|into)\s+["']?(.+?)["']?\s*$/i)
          || raw.match(/\bchange the name of\s+(.+?)\s+to\s+["']?(.+?)["']?\s*$/i)
          || raw.match(/\bcall\s+(?:the\s+)?(.+?)\s+(?:group\s+)?(?:to\s+)?["']?(.+?)["']?\s*$/i);
        if (m) {
          const found = findGroup(m[1], groups);
          if (found) { setGroup(found.g, "label", m[2].trim()); say(`${found.g.name} renamed to “${m[2].trim()}”`); continue; }
          if (/^(rename|relabel)/i.test(raw)) { unknown.push(clause + ` (no group called “${m[1]}”)`); continue; }
        }
      }

      // Panel letter
      {
        const m = c.match(/\bpanel (letter|label)\b\s*(?:to|as|:|=|of)?\s*([a-z0-9]{1,3})?\b/) || c.match(/\blabel (it|this|the figure|the panel)\s+([a-z])\b/);
        if (m) {
          if (neg) { style.panel_label = ""; say("Panel letter removed"); }
          else { const v = (m[2] || "A").toUpperCase(); style.panel_label = v; say("Panel letter: " + v); }
          continue;
        }
      }

      // Legend title
      {
        const m = raw.match(/\blegend title\b\s*(?:to|as|:|=)?\s*["']?(.+?)["']?\s*$/i);
        if (m && !NEG.test(" " + m[1] + " ")) { style.legend_title = m[1].trim(); say(`Legend title: “${style.legend_title}”`); continue; }
      }

      // Reference lines
      {
        const m = c.match(/\b(?:reference |ref |threshold |baseline |dashed |dotted |horizontal |vertical |cutoff |cut-off )?line\s*(?:at|on|for)\s*(x|y)?\s*=?\s*(-?\d+(\.\d+)?)/) || c.match(/\b(x|y)\s*=\s*(-?\d+(\.\d+)?)\b/);
        if (m && !/\b(axis|tick)\b/.test(c)) {
          const axis = m[1] || (/\bvertical\b/.test(c) ? "x" : "y");
          const label = raw.match(/\b(?:label(?:l?ed)?|called|saying|named|marked)\s+["']?(.+?)["']?\s*$/i);
          const entry = `${axis}=${m[2]}${label ? ": " + label[1].trim() : ""}`;
          style.ref_lines = [String(style.ref_lines || "").trim(), entry].filter(Boolean).join("; ");
          say("Reference line " + entry); continue;
        }
        if (/\b(diagonal|identity|unity|1:1) line\b|\by ?= ?x\b/.test(c)) {
          if (neg) style.ref_lines = String(style.ref_lines || "").split(";").filter((p) => !/y\s*=\s*x/.test(p)).join(";").trim();
          else style.ref_lines = [String(style.ref_lines || "").trim(), "y=x"].filter(Boolean).join("; ");
          say(neg ? "Identity line removed" : "Identity line y = x added"); continue;
        }
        if (neg && /\b(reference|ref|threshold) lines?\b/.test(c)) { style.ref_lines = ""; say("Reference lines removed"); continue; }
      }

      // ---- Presets
      {
        const m = c.match(new RegExp(`\\b(${PRESETS.join("|")})\\b\\s*(style|look|preset|theme|mode|template)?`));
        if (m && (m[2] || /^\s*(use |apply |make it |switch to |go |try |change to )?(the |a )?\w+( style| look)?\s*$/.test(c)) && !/\bcolou?rs?|palette\b/.test(c) && !/\b(size|column)\b/.test(c)) {
          if (ctx.applyPreset && ctx.applyPreset(m[1])) { say(m[1][0].toUpperCase() + m[1].slice(1) + " style applied"); continue; }
        }
      }

      // ---- Gridlines
      if (/\bgrid ?(lines?)?\b|\bgrids\b/.test(c)) {
        if (neg && !/\b(add|show)\b/.test(c)) { style.grid = "none"; say("Gridlines off"); }
        else {
          if (/\bhorizontal\b|\by\b/.test(c)) style.grid = "y";
          else if (/\bvertical\b|\bx\b/.test(c)) style.grid = "x";
          else if (/\bboth\b|\bfull\b|\bx and y\b/.test(c) || !style.grid || style.grid === "none") style.grid = "both";
          if (/\bdash(ed|es)?\b/.test(c)) style.grid_style = "dashed";
          else if (/\bdot(ted|s)?\b/.test(c)) style.grid_style = "dotted";
          else if (/\bsolid\b/.test(c)) style.grid_style = "solid";
          if (/\b(light(er)?|faint(er)?|subtle|soft(er)?)\b/.test(c)) style.grid_alpha = round(Math.max(0.04, cur("grid_alpha") * 0.6));
          if (/\b(dark(er)?|strong(er)?|bold(er)?|heav(y|ier))\b/.test(c)) style.grid_alpha = round(Math.min(1, cur("grid_alpha") * 1.8));
          const dir = { y: "horizontal", x: "vertical", both: "horizontal and vertical" }[style.grid];
          say(`Gridlines: ${dir}${style.grid_style && style.grid_style !== "solid" ? ", " + style.grid_style : ""}`);
        }
      }

      // ---- Legend
      if (/\blegend\b/.test(c)) {
        let m;
        if (neg && !/\b(frame|box|border)\b/.test(c)) { style.legend = "none"; say("Legend hidden"); }
        else {
          const pos = [[/\boutside\b|\bto the (far )?right of\b/, "outside", "outside, right"], [/\babove\b|\bon top\b(?! (left|right))|\bhorizontal\b/, "outside top", "above the plot"],
            [/\b(top|upper) right\b/, "upper right", "top right"], [/\b(top|upper) left\b/, "upper left", "top left"], [/\b(bottom|lower) right\b/, "lower right", "bottom right"],
            [/\b(bottom|lower) left\b/, "lower left", "bottom left"], [/\bright\b/, "center right", "middle right"], [/\bbest\b|\bautomatic/, "best", "best spot"]];
          for (const [re, val, label] of pos) if (re.test(c)) { style.legend = val; say("Legend: " + label); break; }
          if (/\b(frame|box|border)\b/.test(c)) { style.legend_frame = !neg; say(neg ? "Legend frame removed" : "Legend frame added"); }
          if ((m = c.match(/\b(\d+) col(umn)?s?\b/))) { style.legend_cols = parseInt(m[1], 10); say("Legend columns: " + m[1]); }
          if (!done() && SHOW.test(c)) { if (style.legend === "none") style.legend = "best"; say("Legend shown"); }
        }
      }

      // Legend size
      if (/\blegend\b/.test(c) && /\b(bigger|larger|smaller|tiny|size|font)\b/.test(c)) {
        let m;
        const base = numOr(style.legend_size, cur("font_size") * 0.85);
        if ((m = c.match(/\b(\d+(\.\d+)?)\s*(pt|points?)?/))) { style.legend_size = parseFloat(m[1]); say("Legend text " + style.legend_size + " pt"); }
        else if (/\b(bigger|larger)\b/.test(c)) { style.legend_size = round(base * 1.25, 1); say("Legend text larger"); }
        else if (/\b(smaller|tiny)\b/.test(c)) { style.legend_size = round(base * 0.8, 1); say("Legend text smaller"); }
      }
      // Number of ticks
      {
        let m;
        if ((m = c.match(/\b(\d+)\s*(major )?ticks\b(?! every)/)) && !/\b(every|spacing|step)\b/.test(c)) { const ax = /\bx\b/.test(c) ? "x" : "y"; style[ax + "_nticks"] = parseInt(m[1], 10); say(`About ${m[1]} ${ax.toUpperCase()} ticks`); }
        else if (/\bfewer (y |x )?(ticks|tick marks|numbers)\b|\bless (ticks|numbers on the axis)\b/.test(c)) { const ax = /\bx\b/.test(c) ? "x" : "y"; style[ax + "_nticks"] = 4; say(`Fewer ${ax.toUpperCase()} ticks`); }
        else if (/\bmore (y |x )?(ticks|tick marks|numbers)\b/.test(c)) { const ax = /\bx\b/.test(c) ? "x" : "y"; style[ax + "_nticks"] = 10; say(`More ${ax.toUpperCase()} ticks`); }
      }
      // Fill opacity and outlines
      if (/\b(bars?|boxes|violins?|fill|fills|shapes)\b/.test(c)) {
        if (/\b(more )?(transparent|see[- ]through|faded|lighter|paler)\b/.test(c) && !/\bpoints?|dots\b/.test(c)) { style.fill = "light"; style.fill_alpha = round(Math.max(0.05, cur("fill_alpha") * 0.6)); say("Lighter fill"); }
        else if (/\b(darker|stronger|deeper|more opaque|richer|heavier) (fill|bars|boxes|violins)\b/.test(c)) { style.fill = "light"; style.fill_alpha = round(Math.min(1, cur("fill_alpha") * 1.7)); say("Stronger fill"); }
        if (/\b(outlines?|edges?|borders?)\b/.test(c) && !/\bpoints?|dots|markers\b/.test(c)) {
          if (NEG.test(c)) { style.edge_width = 0; say("No outlines on bars/boxes"); }
          else if (/\b(thicker|bolder|heavier)\b/.test(c)) { style.edge_width = round(numOr(style.edge_width, cur("line_width")) * 1.6, 2); say("Thicker outlines"); }
          else if (/\b(thinner|lighter|finer)\b/.test(c)) { style.edge_width = round(numOr(style.edge_width, cur("line_width")) * 0.6, 2); say("Thinner outlines"); }
        }
      }
      // Figure shape
      if (/\blandscape\b|\bwide(screen)? (figure|format|shape)\b/.test(c)) { const w = Math.max(cur("width"), cur("height")), h = Math.min(cur("width"), cur("height")); style.width = round(Math.max(w, h * 1.4)); style.height = round(h); say("Landscape shape"); }
      else if (/\bportrait\b|\btall (figure|format|shape)\b/.test(c)) { const w = Math.min(cur("width"), cur("height")), h = Math.max(cur("width"), cur("height")); style.width = round(w); style.height = round(Math.max(h, w * 1.3)); say("Portrait shape"); }
      else if (/\bhalf (the )?size\b/.test(c)) { style.width = round(cur("width") * 0.5); style.height = round(cur("height") * 0.5); say("Half size"); }
      else if (/\b(double|twice) (the )?size\b/.test(c)) { style.width = round(Math.min(30, cur("width") * 2)); style.height = round(Math.min(30, cur("height") * 2)); say("Double size"); }

      // ---- Theme and background
      if (/\b(dark|black) (background|mode|theme|bg)\b|\bdark(en)? (it|the figure)\b|\bon (a )?black\b|^\s*dark\s*$/.test(c)) {
        style.theme = "dark"; style.bg_color = ""; style.axes_color = ""; colorUsed = true; say("Dark background");
      } else if (/\b(light|white) (background|mode|theme|bg)\b|^\s*light\s*$/.test(c)) {
        style.theme = "light"; style.bg_color = ""; style.axes_color = ""; colorUsed = true; say("Light background");
      } else if (/\btransparent (background|bg)\b|\bno background\b|\bbackground transparent\b/.test(c)) {
        style.transparent = !/\bnot transparent\b/.test(c); colorUsed = true; say("Transparent background on export");
      } else if (/\b(background|bg)\b/.test(c)) {
        const col = findColor(c.replace(/\bbackground\b/g, ""), ctx.parseColor);
        if (col) {
          if (/\b(plot|inner|axes|plotting) (area|region|background)\b/.test(c)) { style.axes_color = col.hex; say("Plot area: " + col.name); }
          else { style.bg_color = col.hex; say("Background: " + col.name); }
          colorUsed = true;
        }
      }
      if (/\b(text|font|labels?|ink|writing|axis|axes) colou?r\b|\bcolou?r (of )?the (text|labels|axes)\b|\b(make|turn) the (text|labels|writing|axes)\b/.test(c) && !colorUsed) {
        const col = findColor(c.replace(/\b(text|font|labels?|writing|axes)\b/g, ""), ctx.parseColor);
        if (col) { style.ink_color = col.hex; colorUsed = true; say("Text and axes: " + col.name); }
      }

      // ---- Palettes and colormaps
      if (/\breverse\b.*\bcolou?rs?\b|\bcolou?rs?\b.*\brevers(e|ed)\b|\bflip (the )?colou?rs\b|\breverse (the )?(palette|order)\b/.test(c)) {
        style.palette_reverse = !/\b(un-?reverse|normal order|not reversed)\b/.test(c); say(style.palette_reverse ? "Colors reversed" : "Color order normal"); colorUsed = true;
      }
      if (!colorUsed) {
        const ctxWord = /\b(colou?rs?|palette|colormap|colou?r ?map|scheme|cmap|shades)\b/.test(c) || /^\s*(use|try|switch to|apply)\b/.test(c);
        for (const [re, key, label, needsCtx] of PALETTES) {
          if (re.test(c) && (!needsCtx || ctxWord) && !/\bcolou?r ?map|\bcmap\b/.test(c)) { style.palette = key; colorUsed = true; say(label); break; }
        }
        if (!colorUsed) {
          for (const [m, lc] of colormaps) {
            if (new RegExp(`\\b${lc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(c) && (ctxWord || !AMBIGUOUS_CMAPS.has(lc))) {
              style.palette = "cmap:" + m; colorUsed = true; say("Colors: " + m + " colormap"); break;
            }
          }
        }
      }

      // ---- Per-group styling (a clause can name several groups: "Saline blue and Morphine red")
      const named = [];
      for (const g of groups) {
        let at = -1, len = 0;
        for (const nm of [g.name, g.label]) {
          const n = String(nm || "").toLowerCase().trim();
          const i = n ? c.indexOf(n) : -1;
          if (i >= 0 && n.length > len) { at = i; len = n.length; }
        }
        if (at >= 0) named.push({ g, at, len });
      }
      named.sort((a, b) => a.at - b.at);
      const segments = named.length > 1 && !colorUsed
        ? named.map((n, i) => ({ g: n.g, text: n.g.name.toLowerCase(), seg: c.slice(n.at, i + 1 < named.length ? named[i + 1].at : c.length) }))
        : null;
      const found = segments ? segments[0] : (groups.length ? findGroup(raw, groups) : null);
      for (const target of (segments || (found && !colorUsed ? [found] : []))) {
        const found = target;
        const base = target.seg || c;
        const rest = found.text ? base.replace(found.text, " ") : base;
        const col = findColor(rest, ctx.parseColor);
        if (col) { setGroup(found.g, "color", col.hex); say(`${found.g.label || found.g.name} → ${col.name}`); colorUsed = true; }
        for (const [re, val, label] of MARKERS) if (re.test(rest) && !/\b(significance|asterisk)/.test(rest)) { setGroup(found.g, "marker", val); say(`${found.g.label || found.g.name} markers: ${label}`); break; }
        for (const [re, val, label] of HATCHES) if (re.test(rest)) { setGroup(found.g, "hatch", neg ? "" : val); say(`${found.g.label || found.g.name}: ${neg ? "no pattern" : label}`); break; }
        if (/\bdash(ed|es)?\b/.test(rest) && /\bline|dash/.test(rest)) { setGroup(found.g, "linestyle", "--"); say(`${found.g.label || found.g.name}: dashed line`); }
        else if (/\bdotted line\b/.test(rest)) { setGroup(found.g, "linestyle", ":"); say(`${found.g.label || found.g.name}: dotted line`); }
        else if (/\bsolid line\b/.test(rest)) { setGroup(found.g, "linestyle", ""); say(`${found.g.label || found.g.name}: solid line`); }
        if (/\b(reset|automatic|default)\b/.test(rest) && !done()) { delete style.groups[found.g.name]; say(`${found.g.label || found.g.name} back to automatic`); }
      }

      // ---- Plot type and direction
      if (groupPlot) {
        for (const [re, val, label] of KINDS) {
          if (re.test(c) && !(neg && val === "strip")) { style.plot_kind = val; say("Plot type: " + label); break; }
        }
        // "horizontal" only means the layout when it isn't describing gridlines, a legend, lines or labels
        const notLayout = "(?!\\s*(grid|legend|lines?\\b|labels?\\b|stripes|text\\b|axis\\b|ref))";
        if (new RegExp(`\\bhorizontal(ly)?\\b${notLayout}|\\bsideways\\b|\\bon (its|it's) side\\b|\\bflip (it|the (plot|figure|graph|chart|axes))\\b`).test(c) && !/\blegend\b/.test(c)) { style.orientation = "horizontal"; say("Horizontal layout"); }
        else if (new RegExp(`\\bvertical(ly)?\\b${notLayout}|\\bupright\\b`).test(c) && !/\blegend\b/.test(c)) { style.orientation = "vertical"; say("Vertical layout"); }
      } else if (KINDS.some(([re]) => re.test(c))) {
        unknown.push(clause + " (plot types apply to group comparisons and endpoint plots)"); continue;
      }

      // ---- Fill and widths
      if (/\b(solid|filled|fill(ed)? in|opaque) (bars?|boxes|violins?|fills?|shapes|colou?rs)\b|\bfill (them|it|bars) (in|solid)\b|\bmake (the )?(bars?|boxes|violins) solid\b/.test(c)) { style.fill = "solid"; say("Solid fill"); }
      else if (/\b(outlined?|hollow|empty|unfilled)\b|\bno fill\b|\boutline only\b/.test(c) && !/\bpoints?|dots|markers\b/.test(c)) { style.fill = "outline"; say("Outline only"); }
      else if (/\blight(er)? fill\b|\bsoft fill\b|\btransparent fill\b|\bsee[- ]through\b|\bpale (bars?|fill)\b/.test(c)) { style.fill = "light"; say("Light fill"); }
      {
        let m;
        if ((m = c.match(/\bfill (opacity|alpha|transparency)\s*(?:to|of|=)?\s*(\d+(\.\d+)?)\s*(%)?/))) { let v = parseFloat(m[2]); if (m[4] || v > 1) v /= 100; style.fill_alpha = round(v); style.fill = "light"; say("Fill opacity " + style.fill_alpha); }
        if ((m = c.match(/\b(bar|box) width\s*(?:to|of|=)?\s*(\d*\.?\d+)/))) { style.bar_width = Math.min(1, parseFloat(m[2])); say("Bar width " + style.bar_width); }
        else if (/\b(wider|thicker|fatter|broader|chunkier) (bars?|boxes|violins?)\b|\b(bars?|boxes) (wider|thicker|fatter)\b/.test(c)) { style.bar_width = round(Math.min(1, cur("bar_width") + 0.15)); say("Wider bars"); }
        else if (/\b(narrower|thinner|skinnier|slimmer) (bars?|boxes|violins?)\b|\b(bars?|boxes) (narrower|thinner|skinnier)\b/.test(c)) { style.bar_width = round(Math.max(0.1, cur("bar_width") - 0.15)); say("Narrower bars"); }
      }

      // ---- Points
      if (/\b(points?|dots?|data points?|individual (values|points|data)|markers?|symbols?|circles)\b/.test(c) && !/\bon (the )?lines\b/.test(c)) {
        let m;
        if (neg && /\b(points?|dots?|individual)\b/.test(c) && !/\b(outline|edge|border|jitter|spread)\b/.test(c)) { style.show_points = false; say("Individual points hidden"); }
        else if (/\b(show|add|display|include|bring back)\b/.test(c) && !/\b(size|bigger|smaller)\b/.test(c)) { style.show_points = true; say("Individual points shown"); }
        if ((m = c.match(/\b(point|dot|marker|symbol) size\s*(?:to|of|=)?\s*(\d+(\.\d+)?)/)) || (m = c.match(/\b(points?|dots?|markers?)\s*(?:to )?size\s*(\d+(\.\d+)?)/))) { style.marker_size = parseFloat(m[2]); say("Point size " + style.marker_size); }
        else if (/\b(bigger|larger|increase|huge|enlarge)\b/.test(c)) { style.marker_size = round(cur("marker_size") * 1.4, 1); say("Bigger points"); }
        else if (/\b(smaller|tiny|decrease|shrink)\b/.test(c)) { style.marker_size = round(Math.max(0.5, cur("marker_size") * 0.7), 1); say("Smaller points"); }
        if (!found) for (const [re, val, label] of MARKERS) if (re.test(c) && !/\b(significance|asterisk)/.test(c)) { style.point_shape = val; say("Markers: " + label); break; }
        if (/\b(more )?(transparent|faded|faint|see[- ]through)\b/.test(c) && !/\bbackground\b/.test(c)) { style.point_alpha = round(Math.max(0.1, cur("point_alpha") - 0.3)); say("More transparent points"); }
        else if (/\b(opaque|solid|fully visible)\b/.test(c)) { style.point_alpha = 1; say("Opaque points"); }
        if (/\b(outline|edge|border)\b/.test(c)) {
          if (neg) { style.point_edge = "none"; say("No point outlines"); }
          else if (/\bblack\b/.test(c)) { style.point_edge = "#000000"; say("Black point outlines"); }
          else if (/\bwhite\b/.test(c)) { style.point_edge = "#ffffff"; say("White point outlines"); }
          else if (/\bdark(er)?\b/.test(c)) { style.point_edge = "dark"; say("Darker point outlines"); }
          else { style.point_edge = "ink"; say("Point outlines in text color"); }
        }
        if (/\b(spread|scatter|jitter|more jitter)\b/.test(c) && !neg && !/\bplot\b/.test(c)) { style.jitter = round(Math.min(0.45, cur("jitter") + 0.08)); say("Points spread out more"); }
        else if (/\bno jitter\b|\b(in a|on a) (straight )?line\b|\bline (them|the points|the dots) up\b/.test(c)) { style.jitter = 0; say("Points in a straight line"); }
      }

      // ---- Error bars
      if (/\berror ?bars?\b|\berrors?\b|\b(sd|sem|standard deviation|standard error|stdev|confidence intervals?|95 ?%? ?ci|ci)\b|\bcaps?\b/.test(c)) {
        let m;
        if (neg && /\berror/.test(c) && !/\bcaps?\b/.test(c)) { style.error = "none"; say("Error bars hidden"); }
        else {
          if (/\b(sd|standard deviations?|stdev)\b/.test(c)) { style.error = "sd"; say("Error bars: SD"); }
          else if (/\b(sem|standard errors?( of the mean)?)\b/.test(c)) { style.error = "sem"; say("Error bars: SEM"); }
          else if (/\b(95 ?%? ?ci|confidence intervals?|ci)\b/.test(c)) { style.error = "ci95"; say("Error bars: 95% CI"); }
          else if (SHOW.test(c) && style.error === "none") { style.error = "sem"; say("Error bars: SEM"); }
          if (/\b(one[- ]sided|upwards?|only up|up only|outward|above only|top only)\b/.test(c)) { style.error_dir = "up"; say("Error bars: outward only"); }
          else if (/\b(both (ways|directions|sides)|two[- ]sided)\b/.test(c)) { style.error_dir = "both"; say("Error bars: both directions"); }
          if (/\bcaps?\b/.test(c)) {
            if (neg) { style.cap_size = 0; say("No error bar caps"); }
            else if ((m = c.match(/\bcaps?\b[^0-9]*(\d+(\.\d+)?)/))) { style.cap_size = parseFloat(m[1]); say("Cap width " + style.cap_size); }
            else if (/\b(bigger|wider|larger|longer)\b/.test(c)) { style.cap_size = round(numOr(style.cap_size, cur("marker_size") * 0.9) * 1.6, 1); say("Wider caps"); }
            else if (/\b(smaller|narrower|shorter)\b/.test(c)) { style.cap_size = round(numOr(style.cap_size, cur("marker_size") * 0.9) * 0.6, 1); say("Narrower caps"); }
          }
          if (/\b(thicker|bolder|heavier)\b/.test(c)) { style.error_width = round(numOr(style.error_width, cur("line_width")) * 1.5, 2); say("Thicker error bars"); }
          else if (/\b(thinner|lighter|finer)\b/.test(c)) { style.error_width = round(numOr(style.error_width, cur("line_width")) * 0.65, 2); say("Thinner error bars"); }
        }
      }

      // ---- Significance and n
      if (/\b(stars?|asterisks?|significance|p[- ]?values?|brackets?|exact p|ns|non[- ]?significant|not significant)\b/.test(c) && !(found && /\bstars?\b/.test(c) && !/\bsignifican/.test(c))) {
        if (/\b(ns|non[- ]?significant|not significant)\b/.test(c) && !/\bstars?|p[- ]?values?\b/.test(c)) { style.show_ns = !/\b(hide|remove|no|without|don'?t)\b/.test(c); say(style.show_ns ? "Non-significant comparisons marked" : "Only significant comparisons marked"); }
        else if (neg) { style.sig = "none"; say("Significance marks hidden"); }
        else if (/\bp[- ]?values?|exact p\b/.test(c)) { style.sig = "p"; say("Exact p-values"); }
        else if (/\b(stars?|asterisks?)\b/.test(c) && /\b(bigger|larger)\b/.test(c)) { style.sig_size = round(numOr(style.sig_size, cur("font_size")) * 1.3, 1); say("Bigger significance marks"); }
        else if (/\b(stars?|asterisks?)\b/.test(c) && /\b(smaller)\b/.test(c)) { style.sig_size = round(numOr(style.sig_size, cur("font_size")) * 0.8, 1); say("Smaller significance marks"); }
        else if (/\b(stars?|asterisks?|significance|brackets?)\b/.test(c) && groupPlot && !found) { style.sig = "stars"; say("Significance shown as stars"); }
      }
      if (/\b(n|ns|sample sizes?|group sizes?|counts?|number of (animals|subjects|samples|mice|cells))\b/.test(c) && /\b(show|add|display|hide|remove|no|under|below|label)\b/.test(c) && !/\b(non[- ]?significant|not significant)\b/.test(c) && /\b(sample|group size|counts?|number of|\bn\b)/.test(c)) {
        style.show_n = !neg; say(neg ? "n hidden" : "n shown under each group");
      }

      // ---- Axis lines
      {
        const sideWord = /\b(axis|axes|spines?|lines?|borders?|edges?|sides?)\b/;
        const sides = ["top", "right", "left", "bottom"].filter((sd) => new RegExp(`\\b${sd}\\b`).test(c));
        if (/\b(box|frame|border) (around|on) (the )?(plot|figure|graph|chart|it|data)\b|\bfull frame\b|\ball (four |4 )?(axes|axis lines|sides|spines|borders)\b|\bbox(ed)? (it )?in\b|\bclose (the|it) (plot|box)\b/.test(c)) {
          if (neg) { style.spine_top = style.spine_right = false; say("Frame removed (top and right lines off)"); }
          else { style.spine_top = style.spine_right = style.spine_left = style.spine_bottom = true; say("Full frame around the plot"); }
        } else if (sides.length && sideWord.test(c) && !/\blegend\b/.test(c)) {
          for (const sd of sides) style["spine_" + sd] = !neg;
          say(`${sides.join(" and ")} axis line${sides.length > 1 ? "s" : ""} ${neg ? "off" : "on"}`);
        } else if (neg && /\b(all )?(the )?(axes|axis lines|spines)\b/.test(c) && !/\b(label|title|ticks?|grid)\b/.test(c)) {
          style.spine_top = style.spine_right = style.spine_left = style.spine_bottom = false; say("All axis lines off");
        }
        if (/\b(offset|floating|detach(ed)?|separated?|pull(ed)? (away|out)) (the )?(axes|axis|spines)\b|\b(axes|axis lines) (offset|floating|detached)\b/.test(c)) {
          style.offset_axes = neg ? 0 : 8; if (!neg) style.trim_axes = true; say(neg ? "Axes attached" : "Floating, trimmed axes");
        } else if (/\btrim(med)? (the )?(axes|axis|spines)\b/.test(c)) { style.trim_axes = !neg; say(neg ? "Axes not trimmed" : "Axes trimmed to ticks"); }
        if (/\b(hide|remove|no|without|delete|drop) (the )?(x|y)[- ]?axis( line)?\b(?![- ]?(label|title|name))/.test(c)) {
          const sd = /\by[- ]?axis/.test(c) ? "left" : "bottom"; style["spine_" + sd] = false; say((sd === "left" ? "Y" : "X") + "-axis line off");
        } else if (/\b(show|add|bring back) (the )?(x|y)[- ]?axis( line)?\b(?![- ]?(label|title|name))/.test(c)) {
          const sd = /\by[- ]?axis/.test(c) ? "left" : "bottom"; style["spine_" + sd] = true; say((sd === "left" ? "Y" : "X") + "-axis line on");
        }
        if (/\b(thicker|bolder|heavier) (axes|axis lines?|spines)\b|\b(axes|axis lines?|spines) (thicker|bolder|heavier)\b/.test(c)) { style.axis_width = round(numOr(style.axis_width, Math.max(0.6, cur("line_width") * 0.6)) * 1.6, 2); say("Thicker axis lines"); }
        else if (/\b(thinner|lighter|finer) (axes|axis lines?|spines)\b|\b(axes|axis lines?|spines) (thinner|lighter|finer)\b/.test(c)) { style.axis_width = round(numOr(style.axis_width, Math.max(0.6, cur("line_width") * 0.6)) * 0.65, 2); say("Thinner axis lines"); }
      }

      // ---- Ticks
      if (/\bticks?\b|\btick marks?\b/.test(c)) {
        let m;
        if (/\bminor\b/.test(c)) { style.minor_ticks = !neg; say(neg ? "Minor ticks off" : "Minor ticks on"); }
        else if ((m = c.match(/\b(x|y)?[- ]?(axis )?ticks? (?:marks? )?(?:every|spacing(?: of)?|at intervals of|step(?: of)?|of|by)\s*(-?\d+(\.\d+)?)/)) || (m = c.match(/\b()()tick every\s*(-?\d+(\.\d+)?)/))) {
          const axis = m[1] === "x" ? "x" : "y"; style[axis + "tick_step"] = parseFloat(m[3]); say(`${axis.toUpperCase()} ticks every ${m[3]}`);
        }
        else if (/\b(inside|inward|in|into)\b/.test(c) && !/\bincrease\b/.test(c)) { style.tick_dir = "in"; say("Ticks point inward"); }
        else if (/\b(outside|outward|out)\b/.test(c)) { style.tick_dir = "out"; say("Ticks point outward"); }
        else if (/\b(across|both sides|through)\b/.test(c)) { style.tick_dir = "inout"; say("Ticks cross the axis"); }
        else if ((m = c.match(/\btick (length|size)\s*(?:to|of|=)?\s*(\d+(\.\d+)?)/))) { style.tick_length = parseFloat(m[2]); say("Tick length " + m[2]); }
        else if (/\b(longer|bigger)\b/.test(c) && !/\blabels?\b/.test(c)) { style.tick_length = round(cur("tick_length") * 1.6, 1); say("Longer ticks"); }
        else if (/\b(shorter|smaller)\b/.test(c) && !/\blabels?\b/.test(c)) { style.tick_length = round(cur("tick_length") * 0.6, 1); say("Shorter ticks"); }
        else if (neg && !/\blabels?\b/.test(c)) { style.tick_length = 0; say("Tick marks hidden"); }
        else if (/\b(show|add)\b/.test(c) && /\bgroup|categor/.test(c)) { style.cat_ticks = true; say("Tick marks on the group axis"); }
      }
      {
        const m = c.match(/\b(\d) decimals?( places?)?\b|\b(\d) (dp|digits)\b/);
        if (m) { style.y_decimals = parseInt(m[1] || m[3], 10); say("Value axis: " + style.y_decimals + " decimal places"); }
        else if (/\b(no decimals|whole numbers|integers)\b/.test(c)) { style.y_decimals = 0; say("Value axis: whole numbers"); }
      }
      if (/\b(rotate|tilt|angle|slant|diagonal)\b/.test(c) && /\b(labels?|names|text|x|groups?|tick)\b/.test(c) && !/\bline\b/.test(c)) {
        const m = c.match(/(-?\d+)\s*(°|degrees?|deg)?/);
        style.xrot = neg ? 0 : m ? parseInt(m[1], 10) : 45; say(style.xrot ? `X labels rotated ${style.xrot}°` : "X labels straight");
      } else if (/\b(straight|level|unrotate[d]?|horizontal) (x )?(labels|names|text)\b/.test(c)) { style.xrot = 0; say("X labels straight"); }

      // ---- Scales and limits
      if (/\blog(arithmic)?\b|\blog ?scale\b/.test(c)) {
        const on = !/\b(no|not|remove|linear|turn off|without|undo)\b/.test(c);
        if (/\bx\b/.test(c) && ctx.analysis === "correlation") { style.logx = on; say(on ? "Log scale on X" : "Linear X axis"); }
        else { style.logy = on; say(on ? (groupPlot ? "Log scale on the value axis" : "Log scale on Y") : "Linear scale"); }
      } else if (/\blinear (scale|axis|axes)\b/.test(c)) { style.logy = false; style.logx = false; say("Linear scale"); }
      {
        const NUM = "(-?\\d+(?:\\.\\d+)?)";
        const axisOf = (s) => (/\bx\b|\bx[- ]?axis|horizontal axis/.test(s) ? "x" : "y");
        let m;
        if ((m = c.match(new RegExp(`\\b(?:(x|y)[- ]?(?:axis)?|axis|range|scale|limits?)\\b[^0-9-]*?(?:from|between|of|is|=|:)?\\s*${NUM}\\s*(?:to|and|-|–|through)\\s*${NUM}`)))) {
          const ax = m[1] || axisOf(c); style[ax + "min"] = m[2]; style[ax + "max"] = m[3]; say(`${ax.toUpperCase()} axis: ${m[2]} to ${m[3]}`);
        } else if ((m = c.match(new RegExp(`\\b(?:(x|y)[- ]?(?:axis)?\\s+)?(?:max(?:imum)?|upper limit|top|up to|ends? at|limit)\\b(?:\\s+(?:of|at|to|is|=))?\\s*${NUM}`))) && /\b(axis|max|up to|limit|top|ends?)\b/.test(c)) {
          const ax = m[1] || axisOf(c); style[ax + "max"] = m[2]; say(`${ax.toUpperCase()} max: ${m[2]}`);
        } else if ((m = c.match(new RegExp(`\\b(?:(x|y)[- ]?(?:axis)?\\s+)?(?:min(?:imum)?|lower limit|bottom|starts? at|begins? at|from)\\b(?:\\s+(?:of|at|to|is|=))?\\s*${NUM}`))) && /\b(axis|min|start|begin|bottom|lower)\b/.test(c)) {
          const ax = m[1] || axisOf(c); style[ax + "min"] = m[2]; say(`${ax.toUpperCase()} min: ${m[2]}`);
        } else if (/\bstart (the )?(y[- ]?(axis )?)?at (zero|0)\b|\bfrom zero\b|\binclude zero\b/.test(c)) {
          style.ymin = "0"; say("Y axis starts at 0");
        } else if (/\b(auto(matic)?|reset|default) (the )?(x |y )?(axis |axes )?(range|limits?|scale|axis|axes)\b/.test(c)) {
          style.ymin = style.ymax = style.xmin = style.xmax = ""; say("Axis limits automatic");
        }
      }

      // ---- Lines and time-course display
      {
        let m;
        if ((m = c.match(/\bline (width|thickness)\s*(?:to|of|=)?\s*(\d+(\.\d+)?)/))) { style.line_width = parseFloat(m[2]); say("Line width " + m[2]); }
        else if (/\b(thicker|bolder|heavier|thick|fatter) lines?\b|\blines? (thicker|bolder|heavier)\b/.test(c)) { style.line_width = round(cur("line_width") * 1.4, 2); say("Thicker lines"); }
        else if (/\b(thinner|lighter|finer|thin|skinnier) lines?\b|\blines? (thinner|lighter|finer)\b/.test(c)) { style.line_width = round(Math.max(0.2, cur("line_width") * 0.7), 2); say("Thinner lines"); }
        if (/\b(markers?|dots|points|symbols) on (the )?lines?\b|\bline markers\b/.test(c)) { style.line_markers = !neg; say(neg ? "No markers on lines" : "Markers on lines"); }
        if (!found && /\b(dashed|dotted|dash-dot) lines?\b/.test(c) && !/\b(grid|reference|ref)\b/.test(c) && groups.length) {
          const ls = /dash-dot/.test(c) ? "-." : /dotted/.test(c) ? ":" : "--";
          for (const g of groups) setGroup(g, "linestyle", ls);
          say("All lines " + (ls === ":" ? "dotted" : ls === "-." ? "dash-dot" : "dashed"));
        }
        if (ctx.analysis === "timecourse") {
          if (/\b(shading|shaded band|band|ribbon|sem band|error band)\b/.test(c) && neg) { settings.band = "none"; say("No shaded band"); }
          else if (/\berror bars instead\b|\bbars instead of (the )?band\b|\buse error bars\b/.test(c)) { settings.band_style = "bars"; if (settings.band === "none") settings.band = "sem"; say("Spread shown as error bars"); }
          else if (/\b(band|shading|ribbon)\b/.test(c) && SHOW.test(c)) { settings.band_style = "band"; if (settings.band === "none") settings.band = "sem"; say("Spread shown as a band"); }
          if (/\b(individual|each|single) (lines?|traces?|sessions?|animals?|mice|recordings?)\b|\btraces?\b|\bspaghetti\b/.test(c)) { settings.show_traces = !neg; say(neg ? "Individual sessions hidden" : "Individual sessions shown"); }
          if (/\b(event|injection) (line|marker|label)\b|\bmark (the )?(event|injection)\b/.test(c)) { settings.show_event = !neg; say(neg ? "Event line hidden" : "Event line shown"); }
          if (/\bshad(e|ing) (the )?(baseline|endpoint)\b|\b(baseline|endpoint) shad(e|ing)\b/.test(c)) {
            const which = /\bbaseline\b/.test(c) ? "shade_baseline" : "shade_endpoint"; settings[which] = !neg; say((which === "shade_baseline" ? "Baseline" : "Endpoint") + " shading " + (neg ? "off" : "on"));
          }
        }
        if (/\bhatch(ed|ing)?\b|\bstripe[sd]?\b|\bcross ?hatch/.test(c) && !found && groups.length) {
          const h = /\bcross ?hatch/.test(c) ? "x" : "//";
          for (const g of groups) setGroup(g, "hatch", neg ? "" : h);
          say(neg ? "Patterns removed" : "Patterns on all groups");
        }
      }

      // ---- Fonts and text size
      {
        let m;
        const fontCtx = /\b(font|typeface|text|letters|writing|type)\b/.test(c) || /^\s*(use|try|switch to|change to|in)\b/.test(c);
        for (const [re, key, label, unambiguous] of FONTS) {
          if (re.test(c) && (unambiguous || fontCtx) && !(key === "mono" && /\bmonochrome\b/.test(c))) { style.font = key; say("Font: " + label); break; }
        }
        if ((m = c.match(/\btick (label )?(size|font)\s*(?:to|of|=)?\s*(\d+(\.\d+)?)|\btick labels?\s*(?:to )?(\d+(\.\d+)?)\s*(pt|points)?/))) { style.tick_size = parseFloat(m[3] || m[5]); say("Tick label size " + style.tick_size + " pt"); }
        else if ((m = c.match(/\b(axis )?label (size|font)\s*(?:to|of|=)?\s*(\d+(\.\d+)?)/))) { style.label_size = parseFloat(m[3]); say("Axis label size " + style.label_size + " pt"); }
        else if ((m = c.match(/\b(font|text)( size)?\s*(?:to|of|=|at)?\s*(\d+(\.\d+)?)\b|\b(\d+(\.\d+)?) ?(pt|points?) (font|text)\b/))) { style.font_size = parseFloat(m[3] || m[5]); say("Font size " + style.font_size + " pt"); }
        else if (/\b(bigger|larger|increase|enlarge|bump up)\b.*\b(text|font|letters|writing|labels|everything written)\b|\b(text|font|labels|writing)\b.*\b(bigger|larger)\b/.test(c)) { style.font_size = Math.min(40, cur("font_size") + 2); say("Text larger (" + style.font_size + " pt)"); }
        else if (/\b(smaller|decrease|shrink)\b.*\b(text|font|letters|writing|labels)\b|\b(text|font|labels|writing)\b.*\bsmaller\b/.test(c)) { style.font_size = Math.max(5, cur("font_size") - 2); say("Text smaller (" + style.font_size + " pt)"); }
      }

      // ---- Figure size and resolution
      {
        let m;
        const U = "(in(?:ch(?:es)?)?|\"|cm|mm)?";
        if ((m = c.match(new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*${U}\\s*(?:x|by|×)\\s*(\\d+(?:\\.\\d+)?)\\s*${U}`)))) {
          const unit = m[4] || m[2]; style.width = round(toIn(parseFloat(m[1]), unit)); style.height = round(toIn(parseFloat(m[3]), unit)); say(`Size ${style.width} × ${style.height} in`);
        } else {
          if ((m = c.match(new RegExp(`\\bwidth\\s*(?:to|of|=)?\\s*(\\d+(?:\\.\\d+)?)\\s*${U}|\\b(\\d+(?:\\.\\d+)?)\\s*${U}\\s*wide\\b`)))) {
            style.width = round(toIn(parseFloat(m[1] || m[3]), m[2] || m[4])); say(`Width ${style.width} in`);
          }
          if ((m = c.match(new RegExp(`\\bheight\\s*(?:to|of|=)?\\s*(\\d+(?:\\.\\d+)?)\\s*${U}|\\b(\\d+(?:\\.\\d+)?)\\s*${U}\\s*(tall|high)\\b`)))) {
            style.height = round(toIn(parseFloat(m[1] || m[3]), m[2] || m[4])); say(`Height ${style.height} in`);
          }
        }
        const fig = /\b(figure|plot|graph|chart|it|image|everything)\b/.test(c) && !/\b(points?|dots|text|font|bars?|labels?|title|ticks?|markers?|lines?|caps?|stars)\b/.test(c);
        if (!done()) {
          if (/\b(single|one)[- ]column\b|\bjournal (size|width)\b/.test(c)) { style.width = 3.5; style.height = round(Math.min(cur("height"), 3)); say("Single-column width (89 mm)"); }
          else if (/\b(double|two|full)[- ](column|width)\b/.test(c)) { style.width = 7.2; say("Double-column width (183 mm)"); }
          else if (/\bsquare\b/.test(c)) { style.height = cur("width"); say("Square figure"); }
          else if (fig && /\bwider\b/.test(c)) { style.width = round(cur("width") * 1.25); say("Wider figure"); }
          else if (fig && /\bnarrower\b/.test(c)) { style.width = round(cur("width") * 0.8); say("Narrower figure"); }
          else if (fig && /\btaller\b/.test(c)) { style.height = round(cur("height") * 1.25); say("Taller figure"); }
          else if (fig && /\bshorter\b/.test(c)) { style.height = round(cur("height") * 0.8); say("Shorter figure"); }
          else if (fig && /\b(bigger|larger)\b/.test(c)) { style.width = round(cur("width") * 1.25); style.height = round(cur("height") * 1.25); say("Bigger figure"); }
          else if (fig && /\bsmaller\b/.test(c)) { style.width = round(cur("width") * 0.8); style.height = round(cur("height") * 0.8); say("Smaller figure"); }
        }
        if ((m = c.match(/\b(\d{2,4})\s*dpi\b/))) { style.dpi = parseInt(m[1], 10); say("Export resolution " + m[1] + " dpi"); }
      }

      // ---- Colour for everything (no group named, nothing else took the colour)
      if (!colorUsed && !found) {
        const col = findColor(c, ctx.parseColor);
        if (col && /\b(all|every|everything|each|bars?|groups?|points|dots|boxes|violins?|lines?|it|them|curves?|data)\b/.test(c) && !/\b(grid|reference|axis|axes|text|font|title|labels?|background|legend|error|caps?|stars?|asterisks?|brackets?|ticks?)/.test(c)) {
          for (const g of groups) setGroup(g, "color", col.hex);
          say("All groups → " + col.name);
        }
      }

      if (!done()) unknown.push(clause);
    }
    return { changes, unknown };
  }

  global.interpretCommand = interpretCommand;
  global.suggestCommands = suggestCommands;
  global.correctCommandSpelling = (t) => correctSpelling(t, new Set());
  global.splitCommandClauses = splitClauses;
})(typeof window !== "undefined" ? window : globalThis);
