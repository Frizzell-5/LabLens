// Plain-English command tests. Run: node tests/commands.test.js
require("../commands.js");
const CSS = {red:"#ff0000",green:"#008000",blue:"#0000ff",black:"#000000",white:"#ffffff",gray:"#808080",grey:"#808080",orange:"#ffa500",purple:"#800080",pink:"#ffc0cb",navy:"#000080",teal:"#008080",gold:"#ffd700",yellow:"#ffff00",brown:"#a52a2a",lightblue:"#add8e6",darkred:"#8b0000",darkgreen:"#006400",lightgray:"#d3d3d3",lightgrey:"#d3d3d3",crimson:"#dc143c",coral:"#ff7f50",salmon:"#fa8072",indigo:"#4b0082",skyblue:"#87ceeb",steelblue:"#4682b4",tomato:"#ff6347",maroon:"#800000",olive:"#808000",cyan:"#00ffff",magenta:"#ff00ff",beige:"#f5f5dc",tan:"#d2b48c",darkblue:"#00008b",lightgreen:"#90ee90"};
const parseColor = (w) => CSS[w.toLowerCase()] || null;
const CMAPS = ["viridis","plasma","inferno","magma","cividis","Blues","Greens","Reds","coolwarm","RdBu","Spectral","tab10","Set2","Dark2","turbo","twilight","hot","ocean"];
const groups = [{name:"Saline",label:"Saline",color:"#2f5d8a"},{name:"Morphine",label:"Morphine",color:"#d1495b"}];
const groups3 = [{name:"Vehicle",label:"Vehicle"},{name:"Drug 10 mg/kg",label:"Drug 10 mg/kg"},{name:"Drug 30 mg/kg",label:"Drug 30 mg/kg"}];
let pass=0, fail=0;
function run(cmd, check, opts={}) {
  const style = {grid:"none", legend:"best", groups:{}, palette:"serpentine", ...(opts.style||{})};
  const settings = {band:"sem", ...(opts.settings||{})};
  let preset=null, undone=false, reset=false, action=null, redone=false;
  const res = interpretCommand(cmd, {style, settings, analysis: opts.analysis||"compare", groups: opts.groups||groups, colormaps: CMAPS, parseColor,
    applyPreset:(n)=>{preset=n; return true;}, undo:()=>{undone=true;}, resetStyle:()=>{reset=true;}, redo:()=>{redone=true;}, action:(n,a)=>{action=n+(a?":"+a:"");}});
  let ok; try { ok = check(style, {res, preset, undone, reset, settings, action, redone}); } catch(e) { ok=false; }
  if (ok) pass++; else { fail++; console.log("FAIL:", JSON.stringify(cmd), "\n   changes:", res.changes, "\n   unknown:", res.unknown, "\n   style:", JSON.stringify(Object.fromEntries(Object.entries(style).filter(([k,v])=>!["legend","palette"].includes(k)||v!=={legend:"best",palette:"serpentine"}[k])))); }
}
const G = (s,n) => (s.groups[n]||{});
// gridlines
run("remove gridlines", s=>s.grid==="none", {style:{grid:"both"}});
run("get rid of the grid", s=>s.grid==="none", {style:{grid:"y"}});
run("add horizontal gridlines", s=>s.grid==="y");
run("add gridlines", s=>s.grid==="both");
run("dashed gridlines", s=>s.grid==="both" && s.grid_style==="dashed");
run("make the gridlines lighter", s=>s.grid_alpha<0.15, {style:{grid:"y"}});
// legend
run("hide the legend", s=>s.legend==="none");
run("move the legend to the top left", s=>s.legend==="upper left");
run("put the legend outside", s=>s.legend==="outside");
run("legend above the plot", s=>s.legend==="outside top");
run("add a frame around the legend", s=>s.legend_frame===true);
// title & labels
run("title Tumor growth after treatment", s=>s.title==="Tumor growth after treatment");
run('set the title to "Day 21"', s=>s.title==="Day 21");
run("remove the title", s=>s.title==="", {style:{title:"x"}});
run("title on the left", s=>s.title_align==="left");
run("make the title bigger", s=>s.title_size>11.5);
run("title size 16", s=>s.title_size===16);
run("y axis label Tumor volume (mm³)", s=>s.ylabel==="Tumor volume (mm³)");
run("change the x-axis label to Treatment group", s=>s.xlabel==="Treatment group");
run("hide the x axis label", s=>s.xlabel===" ");
run("bold axis labels", s=>s.label_bold===true);
run("panel letter B", s=>s.panel_label==="B");
// groups
run("make Saline red", s=>G(s,"Saline").color==="#ff0000");
run("color morphine navy", s=>G(s,"Morphine").color==="#000080");
run("Saline light blue and Morphine dark red", s=>G(s,"Saline").color==="#add8e6" && G(s,"Morphine").color==="#8b0000");
run("make saline red, morphine black", s=>G(s,"Saline").color==="#ff0000" && G(s,"Morphine").color==="#000000");
run("make the second group gold", s=>G(s,"Morphine").color==="#ffd700");
run("make drug 30 purple", s=>G(s,"Drug 30 mg/kg").color==="#800080", {groups:groups3});
run("rename Saline to Control", s=>G(s,"Saline").label==="Control");
run("call morphine Opioid", s=>G(s,"Morphine").label==="Opioid");
run("give Morphine square markers", s=>G(s,"Morphine").marker==="s");
run("striped bars for Vehicle", s=>G(s,"Vehicle").hatch==="//", {groups:groups3});
run("crosshatch drug 10", s=>G(s,"Drug 10 mg/kg").hatch==="x", {groups:groups3});
run("dashed line for Morphine", s=>G(s,"Morphine").linestyle==="--", {analysis:"timecourse"});
run("make all the bars black", s=>G(s,"Saline").color==="#000000" && G(s,"Morphine").color==="#000000");
run("use #1b9e77 for saline", s=>G(s,"Saline").color==="#1b9e77");
// palettes
run("use viridis", s=>s.palette==="cmap:viridis");
run("magma colors", s=>s.palette==="cmap:magma");
run("colorblind friendly colors", s=>s.palette==="okabe");
run("black and white", s=>s.palette==="grayscale");
run("use pastel colors", s=>s.palette==="pastel");
run("ocean palette", s=>s.palette==="ocean");
run("reverse the colors", s=>s.palette_reverse===true);
run("use blues colormap", s=>s.palette==="cmap:Blues");
// theme
run("dark background", s=>s.theme==="dark");
run("dark mode", s=>s.theme==="dark");
run("white background", s=>s.theme==="light");
run("make the background beige", s=>s.bg_color==="#f5f5dc");
run("transparent background", s=>s.transparent===true);
run("make the text white", s=>s.ink_color==="#ffffff");
// plot type
run("make it a violin plot", s=>s.plot_kind==="violin");
run("box plot", s=>s.plot_kind==="box");
run("switch to a raincloud", s=>s.plot_kind==="raincloud");
run("beeswarm", s=>s.plot_kind==="beeswarm");
run("box and violin", s=>s.plot_kind==="boxviolin");
run("bar chart", s=>s.plot_kind==="bar", {style:{plot_kind:"violin"}});
run("horizontal", s=>s.orientation==="horizontal");
run("make it horizontal violin plot", s=>s.orientation==="horizontal" && s.plot_kind==="violin");
run("flip it", s=>s.orientation==="horizontal");
run("solid bars", s=>s.fill==="solid");
run("hollow bars", s=>s.fill==="outline");
run("wider bars", s=>s.bar_width>0.62);
run("violin plot", (s,x)=>x.res.unknown.length===1, {analysis:"correlation"});
// points
run("hide the points", s=>s.show_points===false);
run("bigger points", s=>s.marker_size===7);
run("point size 8", s=>s.marker_size===8);
run("use triangle markers", s=>s.point_shape==="^");
run("no outline on the points", s=>s.point_edge==="none");
run("spread the points out", s=>s.jitter>0.12);
run("more transparent points", s=>s.point_alpha<0.85);
// error bars
run("use SD", s=>s.error==="sd");
run("show standard error", s=>s.error==="sem", {style:{error:"sd"}});
run("95% CI error bars", s=>s.error==="ci95");
run("remove error bars", s=>s.error==="none");
run("no caps on error bars", s=>s.cap_size===0 && s.error!=="none");
run("one-sided error bars", s=>s.error_dir==="up");
// significance
run("hide the stars", s=>s.sig==="none");
run("show exact p values", s=>s.sig==="p");
run("show ns", s=>s.show_ns===true);
run("show sample sizes", s=>s.show_n===true);
run("show n under each group", s=>s.show_n===true);
// axes
run("remove the top and right axes", s=>s.spine_top===false && s.spine_right===false, {style:{spine_top:true,spine_right:true}});
run("box around the plot", s=>s.spine_top && s.spine_right && s.spine_left && s.spine_bottom);
run("remove the left axis line", s=>s.spine_left===false);
run("floating axes", s=>s.offset_axes===8 && s.trim_axes===true);
run("ticks inside", s=>s.tick_dir==="in");
run("add minor ticks", s=>s.minor_ticks===true);
run("y ticks every 200", s=>s.ytick_step===200);
run("2 decimal places", s=>s.y_decimals===2);
run("rotate the labels 45 degrees", s=>s.xrot===45);
run("tilt the labels", s=>s.xrot===45);
run("log scale", s=>s.logy===true);
run("log scale on x", s=>s.logx===true, {analysis:"correlation"});
run("y axis from 0 to 1000", s=>s.ymin==="0" && s.ymax==="1000");
run("y max 1200", s=>s.ymax==="1200");
run("start the y axis at zero", s=>s.ymin==="0");
// lines & timecourse
run("thicker lines", s=>s.line_width>1.5);
run("markers on the lines", s=>s.line_markers===true, {analysis:"timecourse"});
run("hide the individual traces", (s,x)=>x.settings.show_traces===false, {analysis:"timecourse"});
run("remove the shading", (s,x)=>x.settings.band==="none", {analysis:"timecourse"});
run("reference line at 100", s=>s.ref_lines==="y=100");
run("add a line at 50 labeled Threshold", s=>s.ref_lines==="y=50: Threshold");
// fonts
run("font size 14", s=>s.font_size===14);
run("bigger text", s=>s.font_size===12);
run("use a serif font", s=>s.font==="serif");
run("Lato", s=>s.font==="lato");
run("change the font to courier", s=>s.font==="courier");
run("tick labels 8", s=>s.tick_size===8);
// size
run("6 by 4 inches", s=>s.width===6 && s.height===4);
run("89 mm wide", s=>Math.abs(s.width-3.5)<0.02);
run("make it bigger", s=>s.width===5 && s.height===4.25);
run("make the figure wider", s=>s.width===5);
run("square", s=>s.height===s.width||s.height===4);
run("600 dpi", s=>s.dpi===600);
// presets / misc
run("use the journal style", (s,x)=>x.preset==="journal");
run("neon", (s,x)=>x.preset==="neon");
run("undo", (s,x)=>x.undone);
run("reset the style", (s,x)=>x.reset);
// combos
run("remove gridlines and make Saline red", s=>s.grid==="none" && G(s,"Saline").color==="#ff0000", {style:{grid:"y"}});
run("horizontal violin, dark background, font size 12, hide the legend", s=>s.orientation==="horizontal"&&s.plot_kind==="violin"&&s.theme==="dark"&&s.font_size===12&&s.legend==="none");
run("remove the top and right axes then add minor ticks", s=>!s.spine_top&&!s.spine_right&&s.minor_ticks, {style:{spine_top:true,spine_right:true}});
// unknowns
run("make it pop", (s,x)=>x.res.unknown.length===1 && x.res.changes.length===0);
run("make the error bars black", (s,x)=>!G(s,"Saline").color && x.res.unknown.length===1);
run("make the axes thicker", s=>s.axis_width>0.9 && !G(s,"Saline").color);
run("make the title red", (s,x)=>!G(s,"Saline").color);
run("make the points bigger and red", s=>s.marker_size===7 && G(s,"Saline").color==="#ff0000");
run("make the morphine points bigger", s=>s.marker_size===7);
run("remove the box around the plot", s=>s.spine_top===false && s.plot_kind===undefined, {style:{spine_top:true,spine_right:true}});
run("thicker error bars", s=>s.error_width>1.5 && s.line_width===undefined);
run("hide the y axis", s=>s.spine_left===false || s.ylabel===" ");
run("no stars", s=>s.sig==="none");
run("show stars", s=>s.sig==="stars", {style:{sig:"none"}});
run("Morphine with star markers", s=>G(s,"Morphine").marker==="*" && s.sig===undefined);
run("make the saline bar outlined", s=>s.fill==="outline");
run("horizontal gridlines", s=>s.grid==="y" && s.orientation===undefined);
run("horizontal legend", s=>s.legend==="outside top" && s.orientation===undefined);
run("a line at 100", s=>s.ref_lines==="y=100");
run("make it look like a Nature paper", (s,x)=>x.preset==="journal");
run("larger font and thicker lines", s=>s.font_size===12 && s.line_width>1.5);
run("Saline and Morphine black", s=>G(s,"Saline").color==="#000000"||G(s,"Morphine").color==="#000000");
run("horizontal violin plot with dashed horizontal gridlines", s=>s.orientation==="horizontal" && s.plot_kind==="violin" && s.grid==="y" && s.grid_style==="dashed");
run("use Poppins and font size 12", s=>s.font==="poppins" && s.font_size===12);
run("horizontal gridlines", s=>s.grid==="y" && s.orientation===undefined);
run("horizontal legend", s=>s.legend==="outside top" && s.orientation===undefined);
run("horizontal line at 50", s=>s.ref_lines==="y=50" && s.orientation===undefined);
run("vertical gridlines", s=>s.grid==="x" && s.orientation===undefined);
run("make it vertical", s=>s.orientation==="vertical", {style:{orientation:"horizontal"}});
run("serif font size 9", s=>s.font==="serif" && s.font_size===9);

// ---- v0.4 phrases
const TC = {analysis:"timecourse"}, CMP = {analysis:"compare"}, COR = {analysis:"correlation"}, DOSE = {analysis:"dose", groups:[{name:"A",label:"A"},{name:"B",label:"B"}]};
// typos, number words, carry-over
run("remove the legand", s=>s.legend==="none");
run("make it verticle", s=>s.orientation==="vertical", {style:{orientation:"horizontal"}});
run("font size twelve", s=>s.font_size===12);
run("remove the gridlines and legend", s=>s.grid==="none" && s.legend==="none", {style:{grid:"y"}});
run("hide the stars and the points", s=>s.sig==="none" && s.show_points===false);
run("remove the title, the legend", s=>s.title==="" && s.legend==="none", {style:{title:"x"}});
run("one-sided error bars", s=>s.error_dir==="up");
// vibes
run("make it look professional", (s,x)=>x.preset==="journal");
run("publication ready", (s,x)=>x.preset==="journal");
run("make it playful", (s,x)=>x.preset==="sketch");
run("make it look modern", (s,x)=>x.preset==="minimal");
run("style it for a poster", (s,x)=>x.preset==="poster");
run("for my presentation", (s,x)=>x.preset==="slides");
run("make it look like prism", (s,x)=>x.preset==="classic");
run("make it elegant", (s,x)=>x.preset==="editorial");
run("make it look retro", (s,x)=>x.preset==="typewriter");
run("make it simple", (s,x)=>x.preset==="clean");
// everything / readability
run("make everything bigger", s=>s.font_size===12 && s.marker_size>5 && s.line_width>1.5);
run("make it more readable", s=>s.font_size===12);
run("bold everything", s=>s.title_bold && s.label_bold);
// italic
run("italic title", s=>s.title_italic===true);
run("italicize the group names", s=>s.tick_italic===true);
run("italic axis labels", s=>s.label_italic===true);
run("make the gene names italic", s=>s.tick_italic===true);
// actions
run("export as pdf", (s,x)=>x.action==="export:pdf");
run("download it as a png", (s,x)=>x.action==="export:png");
run("save as tiff", (s,x)=>x.action==="export:tiff");
run("copy the figure", (s,x)=>x.action==="copy");
run("save my project", (s,x)=>x.action==="save");
run("download the python script", (s,x)=>x.action==="script");
run("redo", (s,x)=>x.redone);
// group order and colors
run("put Morphine first", (s,x)=>x.settings.group_order==="Morphine, Saline");
run("move saline to the end", (s,x)=>x.settings.group_order==="Morphine, Saline");
run("reverse the group order", (s,x)=>x.settings.group_order==="Morphine, Saline");
run("order: Drug 30 mg/kg, Vehicle, Drug 10 mg/kg", (s,x)=>x.settings.group_order==="Drug 30 mg/kg, Vehicle, Drug 10 mg/kg", {groups:groups3});
run("reorder the groups to drug 10, drug 30, vehicle", (s,x)=>x.settings.group_order==="Drug 10 mg/kg, Drug 30 mg/kg, Vehicle", {groups:groups3});
run("swap the colors", s=>G(s,"Saline").color==="#d1495b" && G(s,"Morphine").color==="#2f5d8a");
run("swap the order of saline and morphine", (s,x)=>x.settings.group_order==="Morphine, Saline");
run("make morphine lighter", s=>G(s,"Morphine").color && G(s,"Morphine").color!=="#d1495b" && !G(s,"Saline").color);
run("make all the colors darker", s=>G(s,"Saline").color && G(s,"Morphine").color);
run("warmer colors", s=>s.palette==="sunset");
run("make the colors more vibrant", s=>s.palette==="tol");
run("cooler colors", s=>s.palette==="ocean");
// legend size, ticks, fill, outlines, shape
run("make the legend smaller", s=>s.legend_size<8.5);
run("legend font size 7", s=>s.legend_size===7);
run("fewer ticks", s=>s.y_nticks===4);
run("more x ticks", s=>s.x_nticks===10);
run("5 ticks", s=>s.y_nticks===5);
run("make the bars more transparent", s=>s.fill_alpha<0.25);
run("darker fill", s=>s.fill_alpha>0.25);
run("remove the outlines from the bars", s=>s.edge_width===0);
run("landscape", s=>s.width>s.height);
run("portrait", s=>s.height>s.width);
run("half the size", s=>s.width===2);
// timecourse settings
run("baseline from -2 to 0", (s,x)=>x.settings.baseline_start===-2 && x.settings.baseline_end===0, TC);
run("use the last 2 minutes before injection as baseline", (s,x)=>x.settings.baseline_start===-2 && x.settings.baseline_end===0, TC);
run("endpoint 20 to 30", (s,x)=>x.settings.endpoint_start===20 && x.settings.endpoint_end===30, TC);
run("show from -10 to 60", (s,x)=>x.settings.window_start===-10 && x.settings.window_end===60, TC);
run("10 second bins", (s,x)=>x.settings.bin===10, TC);
run("bin size 1 min", (s,x)=>x.settings.bin===60, TC);
run("no binning", (s,x)=>x.settings.bin===0, TC);
run("percent of baseline", (s,x)=>x.settings.norm==="pct", TC);
run("raw values", (s,x)=>x.settings.norm==="raw", TC);
run("change from baseline", (s,x)=>x.settings.norm==="delta", TC);
run("use the nadir", (s,x)=>x.settings.metric==="min", TC);
run("use area under the curve", (s,x)=>x.settings.metric==="auc", TC);
run("pair by subject", (s,x)=>x.settings.pair_subjects===true, TC);
run("unpaired", (s,x)=>x.settings.pair_subjects===false, TC);
run("rename the injection to Morphine i.p.", (s,x)=>x.settings.event_label==="Morphine i.p.", TC);
run("time is in minutes", (s,x)=>x.settings.time_unit==="minutes", TC);
run("baseline -2 to 0 and endpoint 25 to 30", (s,x)=>x.settings.baseline_start===-2 && x.settings.endpoint_start===25, TC);
// compare settings
run("paired", (s,x)=>x.settings.paired===true, CMP);
run("use a nonparametric test", (s,x)=>x.settings.test==="nonparam", CMP);
run("use ANOVA", (s,x)=>x.settings.test==="param", CMP);
run("compare everything to the control", (s,x)=>x.settings.posthoc==="control", CMP);
run("all pairwise comparisons", (s,x)=>x.settings.posthoc==="all", CMP);
run("percent of control", (s,x)=>x.settings.normalize==="pct_control", CMP);
run("normalize to the vehicle", (s,x)=>x.settings.normalize==="pct_control", CMP);
run("fold change", (s,x)=>x.settings.normalize==="fold_control", CMP);
run("welch", (s,x)=>x.settings.equal_var===false, CMP);
// correlation / dose
run("use spearman", (s,x)=>x.settings.method==="spearman", COR);
run("hide the fit line", (s,x)=>x.settings.fit===false, COR);
run("remove the confidence band", (s,x)=>x.settings.ci===false, COR);
run("fix the bottom at 0", (s,x)=>x.settings.fix_bottom==="0", DOSE);
run("fix top at 100", (s,x)=>x.settings.fix_top==="100", DOSE);
run("call it IC50", (s,x)=>x.settings.ec_label==="IC50", DOSE);
run("hide the ec50 lines", (s,x)=>x.settings.show_ec50===false, DOSE);
// things that must NOT change the wrong setting
run("make the gridlines lighter", s=>s.grid_alpha<0.15 && !G(s,"Saline").color, {style:{grid:"y"}});
run("lighter background", (s,x)=>!G(s,"Saline").color);
run("title Morphine first dose", s=>s.title==="Morphine first dose");
run("y axis label 10 second bins", s=>s.ylabel==="10 second bins");

// spelling correction
run("gridlnes off", s=>s.grid==="none", {style:{grid:"y"}});
run("remvoe the legend", s=>s.legend==="none");
run("make it horizonatl", s=>s.orientation==="horizontal");
run("use virdis", s=>s.palette==="cmap:viridis");
run("make Salinee red", s=>G(s,"Saline").color==="#ff0000");
run("title Gridlnes are fun", s=>s.title==="Gridlnes are fun");
run("ticks insde", s=>s.tick_dir==="in");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
