// Baseline harness entry (Electron main), copied by scripts/bench/baseline.mjs into a throw-away app folder that
// also holds a copy of src/agent-runtime and src/agent-browser, so app.getAppPath() finds the helpers exactly like
// a development build. Loads BENCH_ROOT/out/main with the bench-runtime shims: windows hidden, off-screen and
// unfocusable, keychain refused, safeStorage off. Runs one mode (shell | opencode | claude) and writes one JSON
// report to BENCH_OUT.
const bootEpoch = Date.now();
const processStartEpoch = bootEpoch - process.uptime() * 1000;
const { app, session } = require("electron");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const { readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const env = process.env;
const MODE = env.BENCH_MODE;
const MAIN = join(env.BENCH_ROOT, "out", "main") + "/";
const SHIMS = join(env.BENCH_ROOT, "scripts", "bench-runtime", "app");
const LADDER = (env.BENCH_LADDER || "1,5,10").split(",").map(Number);
const report = { mode: MODE, errors: [], rendererErrors: [], startup: {}, snapshots: {}, cpu: {}, pan: null, agentLog: null };
const mark = (name) => { report.startup[name] = Date.now() - processStartEpoch; };
mark("bootMs");
const save = () => writeFileSync(env.BENCH_OUT, JSON.stringify(report, null, 1));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const mainUrl = pathToFileURL(MAIN).href;
const electronShim = pathToFileURL(join(SHIMS, "hidden-electron.mjs")).href;
const childProcessShim = pathToFileURL(join(SHIMS, "no-keychain.mjs")).href;
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

let firstWindow = null;
app.on("browser-window-created", (_event, window) => {
  if (!globalThis.__benchHiddenShim) {
    try { window.destroy(); } catch {}
    report.errors.push("ABORT: hidden window shim inactive");
    save();
    app.exit(7);
    return;
  }
  if (!firstWindow) {
    firstWindow = window;
    mark("windowCreatedMs");
    window.webContents.once("did-finish-load", () => mark("firstLoadMs"));
  }
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") report.rendererErrors.push(String(event.message).slice(0, 300));
  });
});

// ---- process accounting ----
function psRows() {
  return execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,rss=,time=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
    .trim().split("\n").map((row) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(row);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), cpu: cpuSeconds(match[4]), command: match[5] } : null;
    }).filter(Boolean);
}
function cpuSeconds(value) {
  return value.split(":").map(Number).reduce((total, part) => total * 60 + part, 0);
}
const TYPES = { Browser: "main", Tab: "renderer", GPU: "gpu" };
/** This process and every descendant, each with its kind. */
function tree() {
  const rows = psRows();
  const byParent = new Map();
  const info = new Map(rows.map((row) => [row.pid, row]));
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row.pid);
  }
  const electron = new Map(app.getAppMetrics().map((metric) => [metric.pid, metric.type === "Utility" ? `utility:${metric.serviceName ?? metric.name ?? "?"}` : TYPES[metric.type] ?? `electron:${metric.type}`]));
  const result = new Map();
  const stack = [process.pid];
  while (stack.length) {
    const pid = stack.pop();
    if (result.has(pid) || !info.has(pid)) continue;
    const row = info.get(pid);
    if (/^\/(bin\/ps|usr\/bin\/footprint) /u.test(row.command)) continue; // the harness's own probes
    result.set(pid, { ...row, kind: electron.get(pid) ?? kindOf(row.command) });
    stack.push(...(byParent.get(pid) ?? []));
  }
  return result;
}
function kindOf(command) {
  if (command.includes("fake-agent.mjs")) return "stub-agent";
  if (/^\/usr\/bin\/time |sandbox-exec/u.test(command)) return "wrapper";
  const helper = /(mcp-helper|orchestration-helper|hook-helper|permission-gate|plugin-hook-runner|canvastty-control)\.mjs/u.exec(command);
  if (helper) return /^\/bin\/sh -c/u.test(command) ? "wrapper" : helper[1];
  const native = /canvastty-helper (mcp-browser|mcp-orchestration|permission-gate|hook)\b/u.exec(command);
  if (native) return /^\/bin\/sh -c/u.test(command) ? "wrapper" : `native:${native[1]}`;
  if (command.includes("TerminalOutputHistoryWorker")) return "history-worker";
  if (command.includes("flood.mjs")) return "flood";
  if (/(^|\/)-?(zsh|bash|sh)(\s|$)/u.test(command)) return "shell";
  return `other:${command.split(/\s+/u)[0].split("/").at(-1)}`;
}
/** phys_footprint (MB) of the given pids from /usr/bin/footprint (the number Activity Monitor shows as Memory). */
function footprints(pids) {
  const out = join(env.BENCH_USERDATA, "..", `fp-${process.pid}.json`);
  try {
    execFileSync("/usr/bin/footprint", ["-f", "bytes", "--noCategories", "-j", out, ...pids.flatMap((pid) => ["-p", String(pid)])], { stdio: "ignore", timeout: 30_000 });
    const data = JSON.parse(readFileSync(out, "utf8"));
    return new Map(data.processes.map((entry) => [entry.pid, entry.footprint / 1048576]));
  } catch (error) {
    report.errors.push(`footprint: ${error.message.slice(0, 120)}`);
    return new Map();
  }
}
const r1 = (value) => Math.round(value * 10) / 10;
/** Memory by process kind: count, RSS and phys_footprint (MB), plus heaps. */
async function snapshot(win, label) {
  const processes = tree();
  const fp = footprints([...processes.keys()]);
  const kinds = {};
  for (const [pid, row] of processes) {
    const entry = (kinds[row.kind] ??= { count: 0, rssMb: 0, footprintMb: 0, example: row.command.replace(env.BENCH_USERDATA, "<userData>").slice(0, 200) });
    entry.count += 1;
    entry.rssMb += row.rssKb / 1024;
    entry.footprintMb += fp.get(pid) ?? 0;
  }
  for (const entry of Object.values(kinds)) { entry.rssMb = r1(entry.rssMb); entry.footprintMb = r1(entry.footprintMb); }
  const total = (field) => r1(Object.values(kinds).reduce((sum, entry) => sum + entry[field], 0));
  const heap = await win.webContents.debugger.sendCommand("Runtime.getHeapUsage").catch(() => null);
  const main = process.memoryUsage();
  report.snapshots[label] = {
    kinds,
    total: { count: processes.size, rssMb: total("rssMb"), footprintMb: total("footprintMb") },
    rendererHeapMb: heap ? { used: r1(heap.usedSize / 1048576), total: r1(heap.totalSize / 1048576) } : null,
    mainHeapMb: { used: r1(main.heapUsed / 1048576), total: r1(main.heapTotal / 1048576), external: r1(main.external / 1048576) }
  };
  save();
}
/** CPU % of one core per process kind over the window (kernel time from ps; exited processes are not counted). */
async function cpuWindow(label, seconds, during = async () => undefined) {
  const before = tree();
  const started = Date.now();
  let peak = 0;
  const poll = setInterval(() => {
    let rss = 0;
    for (const row of tree().values()) rss += row.rssKb;
    peak = Math.max(peak, rss / 1024);
  }, 2000);
  await Promise.all([wait(seconds * 1000), during()]);
  clearInterval(poll);
  const elapsed = (Date.now() - started) / 1000;
  const after = tree();
  const kinds = {};
  for (const [pid, row] of after) {
    const previous = before.get(pid)?.cpu ?? 0;
    kinds[row.kind] = (kinds[row.kind] ?? 0) + ((row.cpu - previous) / elapsed) * 100;
  }
  const rounded = Object.fromEntries(Object.entries(kinds).map(([key, value]) => [key, r1(value)]));
  rounded.total = r1(Object.values(kinds).reduce((sum, value) => sum + value, 0));
  report.cpu[label] = { seconds: r1(elapsed), percent: rounded, peakRssMb: Math.round(peak) };
  save();
}
async function rendererTimes(win) {
  const { metrics } = await win.webContents.debugger.sendCommand("Performance.getMetrics");
  const value = (name) => (metrics.find((metric) => metric.name === name)?.value ?? 0) * 1000;
  return { script: value("ScriptDuration"), layout: value("LayoutDuration"), style: value("RecalcStyleDuration"), task: value("TaskDuration") };
}

// ---- scenario ----
async function scenario(win) {
  const js = (code) => win.webContents.executeJavaScript(code);
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Performance.enable", { timeDomain: "threadTicks" });
  // First interactive frame: the workspace is in the DOM, the preload API answers, and one animation frame ran.
  const deadline = Date.now() + 90_000;
  for (;;) {
    const frame = await js(`(async () => {
      if (!document.querySelector('.workspace')) return null;
      const ok = await (window.canvasTTY?.terminal?.list?.().then(() => true, () => false) ?? false);
      if (!ok) return null;
      return await Promise.race([
        new Promise((resolve) => requestAnimationFrame(() => resolve({ at: performance.timeOrigin + performance.now(), raf: true }))),
        new Promise((resolve) => setTimeout(() => resolve({ at: performance.timeOrigin + performance.now(), raf: false }), 500))
      ]);
    })()`).catch(() => null);
    if (frame) {
      report.startup.interactiveMs = Math.round(frame.at - processStartEpoch);
      report.startup.interactiveViaRaf = frame.raf;
      break;
    }
    if (Date.now() > deadline) throw new Error("the app did not become ready");
    await wait(40);
  }
  report.startup.rendererNav = await js(`(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { domInteractive: Math.round(n.domInteractive), domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) } : null; })()`).catch(() => null);
  save();
  await wait(8000);
  await snapshot(win, "empty");
  await cpuWindow("idleEmpty", 10);

  const provider = MODE === "shell" ? "terminal" : MODE;
  const ids = [];
  const create = async (role = "agent") => {
    const i = ids.length;
    const position = { x: 80 + (i % 4) * 760, y: 120 + Math.floor(i / 4) * 520 };
    const request = { provider, profile: "normal", cwd: env.BENCH_WORK, position, ...(provider === "terminal" ? {} : { role }) };
    const id = await js(`window.canvasTTY.terminal.create(${JSON.stringify(request)}).then((s) => s.id)`);
    ids.push(id);
    return id;
  };
  for (const target of LADDER) {
    while (ids.length < target) await create();
    await wait(Number(env.BENCH_SETTLE_MS || 10_000));
    await snapshot(win, `n${target}`);
  }
  // One orchestrator on top (agent modes): its orchestration helper is the extra cost of delegation.
  if (MODE !== "shell") {
    try {
      await create("orchestrator");
      await wait(Number(env.BENCH_SETTLE_MS || 10_000));
      await snapshot(win, `n${LADDER.at(-1)}+orchestrator`);
    } catch (error) {
      report.errors.push(`orchestrator: ${error.message}`);
    }
  }
  const input = (id, text) => js(`window.canvasTTY.terminal.input(${JSON.stringify(id)}, ${JSON.stringify(text)})`);
  const statuses = async () => js(`window.canvasTTY.terminal.list().then((list) => list.map((s) => s.status + (s.failureDetails ? ':' + s.failureDetails.slice(0, 120) : '')))`).catch((error) => [error.message]);
  report.statusesAfterLadder = await statuses();

  await cpuWindow("idle60", Number(env.BENCH_IDLE_SECONDS || 60));

  if (MODE === "shell") {
    const flood = ids.slice(0, 5);
    const command = `"${env.BENCH_NODE}" "${env.BENCH_FLOOD}" ${env.BENCH_KBPS} ${env.BENCH_LOAD_SECONDS}\r`;
    const bytesBefore = globalThis.__benchIpc.terminalDataBytes;
    for (const id of flood) await input(id, command);
    await wait(1000);
    await cpuWindow("load", Number(env.BENCH_LOAD_SECONDS) - 3);
    await wait(3000);
    report.cpu.load.terminalDataToRendererMb = r1((globalThis.__benchIpc.terminalDataBytes - bytesBefore) / 1048576);
  } else {
    for (const id of ids) await input(id, `churn ${env.BENCH_LOAD_SECONDS} ${env.BENCH_CHURN_PERIOD_MS}\r`);
    await wait(500);
    await cpuWindow("load", Number(env.BENCH_LOAD_SECONDS) - 1);
    await wait(3000);
  }
  report.cpu.load.what = MODE === "shell"
    ? `5 of ${ids.length} shell cards print ${env.BENCH_KBPS} KB/s each`
    : `${ids.length} agents: one turn (busy, Bash tool call, idle) every ${env.BENCH_CHURN_PERIOD_MS} ms, spinner 10 fps`;
  await wait(5000);
  await snapshot(win, "afterLoad");

  // Pan and zoom: a middle-button drag (300 moves, 16 ms apart), then 120 wheel steps (60 zoom in/out with ctrl,
  // 60 pan) dispatched on the canvas.
  const countsBefore = await js("JSON.stringify(window.__benchRenderCounts ?? null)").then(JSON.parse);
  const timesBefore = await rendererTimes(win);
  const cameraBefore = await js("document.querySelector('.workspace')?.innerHTML.length ?? 0");
  const [width, height] = win.getContentSize();
  const x0 = Math.round(width / 2), y0 = Math.round(height / 2);
  const MOVES = 300;
  const WHEELS = 120;
  await cpuWindow("panZoom", 0, async () => {
    win.webContents.sendInputEvent({ type: "mouseDown", x: x0, y: y0, button: "middle", clickCount: 1 });
    for (let i = 1; i <= MOVES; i++) {
      win.webContents.sendInputEvent({ type: "mouseMove", x: x0 + (i % 60) * 4, y: y0 + (i % 30) * 2, button: "middle", modifiers: ["middleButtonDown"] });
      await wait(16);
    }
    win.webContents.sendInputEvent({ type: "mouseUp", x: x0, y: y0, button: "middle", clickCount: 1 });
    for (let i = 0; i < WHEELS; i++) {
      const zoom = i < 60;
      const deltaY = zoom ? (i % 20 < 10 ? -8 : 8) : (i % 2 ? 40 : -40);
      await js(`(() => { const target = document.querySelector('.workspace'); if (!target) return false; const r = target.getBoundingClientRect(); return target.dispatchEvent(new WheelEvent('wheel', { deltaY: ${deltaY}, deltaX: ${zoom ? 0 : 12}, ctrlKey: ${zoom}, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true })); })()`);
      await wait(16);
    }
    await wait(500);
  });
  const countsAfter = await js("JSON.stringify(window.__benchRenderCounts ?? null)").then(JSON.parse);
  const timesAfter = await rendererTimes(win);
  const cameraAfter = await js("document.querySelector('.workspace')?.innerHTML.length ?? 0");
  const events = MOVES + WHEELS;
  report.pan = {
    events,
    domChanged: cameraBefore !== cameraAfter,
    commits: countsBefore && countsAfter ? countsAfter.commits - countsBefore.commits : null,
    componentRendersPerEvent: countsBefore && countsAfter ? r1((countsAfter.rendered - countsBefore.rendered) / events) : null,
    terminalCardRendersPerEvent: countsBefore && countsAfter ? r1((countsAfter.terminalCards - countsBefore.terminalCards) / events) : null,
    // The components rendered most per event (names survive only in unminified builds).
    topRendersPerEvent: countsBefore && countsAfter ? Object.fromEntries(Object.entries(countsAfter.byName)
      .map(([name, count]) => [name, r1((count - (countsBefore.byName[name] ?? 0)) / events)])
      .filter(([, perEvent]) => perEvent > 0).sort((a, b) => b[1] - a[1]).slice(0, 8)) : null,
    rendererMsPerEvent: Object.fromEntries(Object.keys(timesAfter).map((key) => [key, Math.round((timesAfter[key] - timesBefore[key]) / events * 100) / 100]))
  };
  await snapshot(win, "end");
  // Chromium keeps tiles rastered during a gesture in its resource pool for a few seconds after it ends;
  // this snapshot shows what navigation leaves behind once the canvas is still.
  await wait(Number(env.BENCH_SETTLED_MS || 10_000));
  await snapshot(win, "endSettled");
  report.statusesAtEnd = await statuses();

  // Agent-side log: MCP handshakes and hook runs (command hooks with max RSS and CPU from /usr/bin/time -l).
  if (MODE !== "shell") {
    const entries = [];
    for (const name of readdirSync(env.BENCH_WORK)) {
      if (!name.startsWith(".bench-agent-")) continue;
      for (const line of readFileSync(join(env.BENCH_WORK, name), "utf8").split("\n")) if (line) try { entries.push(JSON.parse(line)); } catch {}
    }
    report.agentLog = entries;
  }
}

app.whenReady().then(() => {
  mark("appReadyMs");
  session.defaultSession.registerPreloadScript({ type: "frame", id: "bench-render-counter", filePath: join(SHIMS, "render-counter.cjs") });
  const start = async () => {
    const { BrowserWindow } = require("electron");
    for (let i = 0; i < 200 && !firstWindow; i++) await wait(50);
    const win = firstWindow ?? BrowserWindow.getAllWindows()[0];
    if (!win) { report.errors.push("no window"); save(); app.exit(8); return; }
    report.window = { visible: win.isVisible(), focused: win.isFocused() };
    if (win.isVisible() || win.isFocused()) { report.errors.push("ABORT: window visible or focused"); save(); app.exit(7); return; }
    win.setContentSize(1440, 1000);
    try { await scenario(win); } catch (error) { report.errors.push(`scenario: ${error.stack ?? error.message}`); }
    report.windowEnd = { visible: win.isVisible(), focused: win.isFocused() };
    report.done = true;
    save();
    setTimeout(() => app.exit(0), 8000);
    app.quit();
  };
  void start();
});
import(pathToFileURL(join(MAIN, "index.js")).href).then(() => mark("mainImportedMs")).catch((error) => {
  report.errors.push(`main import: ${error.message}`);
  save();
  app.exit(9);
});
