// Benchmark harness entry (Electron main): loads the built app from BENCH_ROOT/out/main with hidden windows
// (hidden-electron.mjs), keychain access refused (no-keychain.mjs) and a render counter in the page, then runs
// the scenarios and writes one JSON report to BENCH_OUT. Started by scripts/bench-runtime.mjs.
const { app, session } = require("electron");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const env = process.env;
const MAIN = join(env.BENCH_ROOT, "out", "main") + "/";
const report = { errors: [], rendererErrors: [], scenarios: {} };
const save = () => writeFileSync(env.BENCH_OUT, JSON.stringify(report, null, 1));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const mainUrl = pathToFileURL(MAIN).href;
const electronShim = pathToFileURL(join(__dirname, "hidden-electron.mjs")).href;
const childProcessShim = pathToFileURL(join(__dirname, "no-keychain.mjs")).href;
Module.registerHooks({
  resolve(specifier, context, next) {
    const fromApp = context.parentURL && context.parentURL.startsWith(mainUrl);
    if (fromApp && specifier === "electron") return { url: electronShim, format: "module", shortCircuit: true };
    if (fromApp && (specifier === "node:child_process" || specifier === "child_process")) {
      return { url: childProcessShim, format: "module", shortCircuit: true };
    }
    return next(specifier, context);
  }
});
app.commandLine.appendSwitch("use-mock-keychain");
app.dock?.hide();
app.setPath("userData", env.BENCH_USERDATA);
process.on("uncaughtException", (error) => report.errors.push(`uncaught: ${error.message}`));
process.on("unhandledRejection", (error) => report.errors.push(`rejection: ${error?.message ?? String(error)}`));
app.on("browser-window-created", (_event, window) => {
  if (!globalThis.__benchHiddenShim) {
    try { window.destroy(); } catch {}
    report.errors.push("ABORT: hidden window shim inactive");
    save();
    app.exit(7);
    return;
  }
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") report.rendererErrors.push(String(event.message).slice(0, 300));
  });
});

/** RSS (KB) and cumulative CPU seconds of this process and every descendant, from ps. */
function processTree() {
  const rows = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,rss=,time="], { encoding: "utf8" })
    .trim().split("\n").map((row) => row.trim().split(/\s+/u));
  const byParent = new Map();
  const info = new Map();
  for (const [pid, ppid, rss, time] of rows) {
    info.set(Number(pid), { rss: Number(rss), cpu: cpuSeconds(time) });
    if (!byParent.has(Number(ppid))) byParent.set(Number(ppid), []);
    byParent.get(Number(ppid)).push(Number(pid));
  }
  const tree = new Map();
  const stack = [process.pid];
  while (stack.length) {
    const pid = stack.pop();
    if (tree.has(pid) || !info.has(pid)) continue;
    tree.set(pid, info.get(pid));
    stack.push(...(byParent.get(pid) ?? []));
  }
  return tree;
}
function cpuSeconds(value) {
  const parts = value.split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

const TYPES = { Browser: "main", Tab: "renderer", GPU: "gpu", Utility: "utility" };
/** Per process kind: RSS in MB now, CPU % (of one core) averaged over the window. */
async function sample(seconds, during = async () => undefined) {
  const before = processTree();
  const started = Date.now();
  let peakRssMb = 0;
  const poll = setInterval(() => {
    let total = 0;
    for (const { rss } of processTree().values()) total += rss;
    peakRssMb = Math.max(peakRssMb, total / 1024);
  }, 1000);
  await Promise.all([wait(seconds * 1000), during()]);
  clearInterval(poll);
  const elapsed = (Date.now() - started) / 1000;
  const metrics = app.getAppMetrics();
  const after = processTree();
  const electronPids = new Map(metrics.map((metric) => [metric.pid, TYPES[metric.type] ?? "utility"]));
  const cpu = { main: 0, renderer: 0, gpu: 0, utility: 0, pty: 0 };
  const rss = { main: 0, renderer: 0, gpu: 0, utility: 0, pty: 0 };
  // CPU from the kernel's per-process time (ps), not getAppMetrics: the same clock for every process kind.
  for (const [pid, { rss: kb, cpu: seconds }] of after) {
    const kind = electronPids.get(pid) ?? "pty";
    rss[kind] += kb / 1024;
    cpu[kind] += ((seconds - (before.get(pid)?.cpu ?? 0)) / elapsed) * 100;
  }
  const round = (object) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, Math.round(value * 10) / 10]));
  const total = Object.values(rss).reduce((sum, value) => sum + value, 0);
  const electronTotal = total - rss.pty;
  return { cpu: round(cpu), rssMb: round({ ...rss, electron: electronTotal, total }), peakRssMb: Math.round(peakRssMb) };
}

/** Renderer main-thread time (ms) by kind, from the DevTools Performance domain. */
async function rendererTimes(win) {
  const { metrics } = await win.webContents.debugger.sendCommand("Performance.getMetrics");
  const value = (name) => (metrics.find((metric) => metric.name === name)?.value ?? 0) * 1000;
  return { script: value("ScriptDuration"), layout: value("LayoutDuration"), style: value("RecalcStyleDuration"), task: value("TaskDuration") };
}
const PAN_MOVES = 300;
const perMove = (after, before, moves) => Object.fromEntries(Object.keys(after).map((key) => [key, Math.round((after[key] - before[key]) / moves * 100) / 100]));

async function scenarios(win) {
  const js = (code) => win.webContents.executeJavaScript(code);
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Performance.enable", { timeDomain: "threadTicks" });
  const terminals = Number(env.BENCH_TERMINALS);
  const floodSeconds = Number(env.BENCH_FLOOD_SECONDS);
  // The window shows a startup page until the services are up; the app is ready once its IPC answers.
  const started = Date.now();
  for (;;) {
    const ready = await js("window.canvasTTY?.terminal?.list?.().then(() => true, () => false) ?? false").catch(() => false);
    if (ready && await js("document.querySelector('.workspace') !== null").catch(() => false)) break;
    if (Date.now() - started > 90_000) {
      report.page = await js("location.href.slice(0, 80) + ' | ' + document.body.innerText.slice(0, 400)").catch((error) => error.message);
      throw new Error("the app did not become ready");
    }
    await wait(250);
  }
  report.readyAfterMs = Date.now() - started;
  // --pan-only: cards and the pan, without the timed load scenarios.
  const panOnly = env.BENCH_PAN_ONLY === "1";
  await wait(panOnly ? 2000 : 8000);
  if (!panOnly) report.scenarios.idle = await sample(10);

  const ids = [];
  for (let i = 0; i < terminals; i++) {
    const position = { x: 80 + (i % 4) * 760, y: 1400 + Math.floor(i / 4) * 520 };
    const taskRelation = i === 1 && ids[0]
      ? `, role: "subagent", parentSessionId: ${JSON.stringify(ids[0])}` : "";
    const created = await js(`window.canvasTTY.terminal.create({ provider: "terminal", profile: "normal", cwd: ${JSON.stringify(env.BENCH_WORK)}, position: ${JSON.stringify(position)}${taskRelation} }).then((s) => s.id)`);
    ids.push(created);
  }
  await wait(panOnly ? 3000 : 8000);
  const edgeDeadline = Date.now() + 15_000;
  let taskEdgeCount = 0;
  while (terminals >= 2 && taskEdgeCount === 0 && Date.now() < edgeDeadline) {
    taskEdgeCount = Number(await js("document.querySelectorAll('.workspace__task-edge').length"));
    if (taskEdgeCount === 0) await wait(50);
  }
  if (terminals >= 2 && taskEdgeCount === 0) throw new Error("the parent-child task edge did not render");
  if (!panOnly) {
    report.scenarios.terminals = await sample(10);

    const command = `"${env.BENCH_NODE}" "${env.BENCH_FLOOD}" ${env.BENCH_KBPS} ${floodSeconds}\r`;
    const ipcStart = globalThis.__benchIpc.terminalDataBytes;
    for (const id of ids) await js(`window.canvasTTY.terminal.input(${JSON.stringify(id)}, ${JSON.stringify(command)})`);
    await wait(3000);
    report.scenarios.flood = await sample(10);
    await wait(Math.max(0, floodSeconds * 1000 - 13_000) + 1500);
    report.scenarios.flood.terminalDataToRendererMb = Math.round((globalThis.__benchIpc.terminalDataBytes - ipcStart) / 1048576 * 10) / 10;
    await wait(10_000);
    report.scenarios.after = await sample(5);
  }

  // Pan: a middle-button drag across the canvas, PAN_MOVES moves ~16 ms apart.
  const countsBefore = await js("JSON.stringify(window.__benchRenderCounts ?? null)").then(JSON.parse);
  const timesBefore = await rendererTimes(win);
  const [width, height] = win.getContentSize();
  const x0 = Math.round(width / 2), y0 = Math.round(height / 2);
  const pan = await sample(0, async () => {
    win.webContents.sendInputEvent({ type: "mouseDown", x: x0, y: y0, button: "middle", clickCount: 1 });
    for (let i = 1; i <= PAN_MOVES; i++) {
      win.webContents.sendInputEvent({ type: "mouseMove", x: x0 + (i % 60) * 4, y: y0 + (i % 30) * 2, button: "middle", modifiers: ["middleButtonDown"] });
      await wait(16);
    }
    win.webContents.sendInputEvent({ type: "mouseUp", x: x0, y: y0, button: "middle", clickCount: 1 });
    await wait(300);
  });
  const countsAfter = await js("JSON.stringify(window.__benchRenderCounts ?? null)").then(JSON.parse);
  const timesAfter = await rendererTimes(win);
  report.scenarios.pan = countsBefore && countsAfter ? {
    moves: PAN_MOVES,
    commits: countsAfter.commits - countsBefore.commits,
    componentRendersPerMove: Math.round((countsAfter.rendered - countsBefore.rendered) / PAN_MOVES * 10) / 10,
    terminalCardRendersPerMove: Math.round((countsAfter.terminalCards - countsBefore.terminalCards) / PAN_MOVES * 10) / 10,
    taskEdgeCount,
    taskEdgeHostUpdatesDuringPan: countsAfter.taskEdgeHosts - countsBefore.taskEdgeHosts,
    taskEdgeHostUpdatesPerMove: Math.round((countsAfter.taskEdgeHosts - countsBefore.taskEdgeHosts) / PAN_MOVES * 100) / 100,
    rendererCpu: pan.cpu.renderer,
    // Renderer main-thread milliseconds per move: JavaScript, style, layout, all tasks.
    rendererMsPerMove: perMove(timesAfter, timesBefore, PAN_MOVES),
    // Most rendered components during the pan (names are minified in a minified build).
    top: Object.entries(countsAfter.byName).map(([name, count]) => [name, count - (countsBefore.byName[name] ?? 0)])
      .filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => `${name}:${count}`).join(" ")
  } : { error: "render counter missing" };
}

app.whenReady().then(() => {
  session.defaultSession.registerPreloadScript({ type: "frame", id: "bench-render-counter", filePath: join(__dirname, "render-counter.cjs") });
  setTimeout(async () => {
    const { BrowserWindow } = require("electron");
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) { report.errors.push("no window"); save(); app.exit(8); return; }
    report.window = { visible: win.isVisible(), focused: win.isFocused() };
    if (win.isVisible() || win.isFocused()) { report.errors.push("ABORT: window visible or focused"); save(); app.exit(7); return; }
    win.setContentSize(1440, 1000);
    try { await scenarios(win); } catch (error) { report.errors.push(`scenario: ${error.message}`); }
    report.windowEnd = { visible: win.isVisible(), focused: win.isFocused() };
    report.done = true;
    save();
    setTimeout(() => app.exit(0), 5000);
    app.quit();
  }, 3000);
});
import(pathToFileURL(join(MAIN, "index.js")).href).catch((error) => {
  report.errors.push(`main import: ${error.message}`);
  save();
  app.exit(9);
});
