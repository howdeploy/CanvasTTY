// Startup harness entry (Electron main), copied by scripts/bench/startup.mjs into a throw-away app folder. Loads
// BENCH_ROOT/out/main with the bench-runtime shims (windows hidden, off-screen and unfocusable, keychain refused,
// safeStorage off) and runs one phase:
//   seed    — builds the fixed profile: three shell cards, a browser card on a local page and a plugin canvas card,
//             with session restore on; quitting persists them.
//   measure — launches into that profile and records the main- and renderer-side boot marks until the restored
//             terminal is interactive and every restored surface is mounted, then quits.
// Writes one JSON report to BENCH_OUT.
const bootEpoch = Date.now();
const processStartEpoch = bootEpoch - process.uptime() * 1000;
const { app, session } = require("electron");
const Module = require("node:module");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const env = process.env;
const PHASE = env.BENCH_PHASE;
const MAIN = join(env.BENCH_ROOT, "out", "main") + "/";
const SHIMS = join(env.BENCH_ROOT, "scripts", "bench-runtime", "app");
const report = { phase: PHASE, errors: [], rendererErrors: [], main: {}, renderer: {}, surfaces: null, done: false };
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
process.on("uncaughtException", (error) => { report.errors.push(`uncaught: ${error.message}`); if (report.done) { report.valid = false; save(); } });
process.on("unhandledRejection", (error) => { report.errors.push(`rejection: ${error?.message ?? String(error)}`); if (report.done) { report.valid = false; save(); } });

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
  }
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") { report.rendererErrors.push(String(event.message).slice(0, 300)); if (report.done) { report.valid = false; save(); } }
  });
});

async function measure(win) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const deadline = Date.now() + 60_000;
  const wanted = ["firstStableFrame", "homeActionable", "restoredTerminalInteractive"];
  let marks = [];
  for (;;) {
    marks = await js("window.__canvasTTYBootMarks ?? null").catch(() => null) ?? [];
    if (wanted.every((name) => marks.some((mark) => mark.name === name))) break;
    if (Date.now() > deadline) { report.errors.push(`timeout; renderer marks: ${marks.map((mark) => mark.name).join(",")}`); break; }
    await wait(20);
  }
  // Every restored surface on screen: the three terminals, the plugin card and the browser card.
  const surfaceDeadline = Date.now() + 15_000;
  for (;;) {
    report.surfaces = await js(`({
      loading: Boolean(document.querySelector('.loading-screen')),
      terminals: document.querySelectorAll('.terminal-card .xterm').length,
      plugins: document.querySelectorAll('.plugin-canvas-card').length,
      browser: document.querySelectorAll('.browser-card').length
    })`).catch(() => null);
    const s = report.surfaces;
    if (s && !s.loading && s.terminals >= 3 && s.plugins >= 1 && s.browser >= 1) {
      report.main.allSurfacesMounted = Math.round(Date.now() - processStartEpoch);
      break;
    }
    if (Date.now() > surfaceDeadline) { report.errors.push(`surfaces incomplete: ${JSON.stringify(s)}`); break; }
    await wait(20);
  }
  marks = await js("window.__canvasTTYBootMarks ?? []").catch(() => marks);
  for (const mark of marks) report.renderer[mark.name] = Math.round(mark.epochMs - processStartEpoch);
  for (const mark of globalThis.__canvasTTYMainBootMarks ?? []) report.main[mark.name] = mark.atMs;
  if (env.BENCH_FRAMES === "1") {
    const frames = await js("window.__benchFrames ?? []").catch(() => []);
    report.frames = frames.map((entry) => ({ ...entry, atMs: Math.round(entry.epochMs - processStartEpoch), epochMs: undefined }));
  }
  report.visibility = await js("document.visibilityState").catch(() => null);
  // The deferred browser runtime still comes up: its restored tab is back and loaded.
  const browserDeadline = Date.now() + 10_000;
  for (;;) {
    report.browser = await js("window.canvasTTY.browser.getState().then((s) => ({ tabs: s.tabs.length, loading: s.tabs.some((tab) => tab.loading) }))").catch(() => null);
    if ((report.browser?.tabs ?? 0) > 0 && !report.browser.loading) break;
    if (Date.now() > browserDeadline) { report.errors.push(`browser runtime: ${JSON.stringify(report.browser)}`); break; }
    await wait(50);
  }
}

async function seed(win) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const deadline = Date.now() + 60_000;
  while (!(await js("Boolean(document.querySelector('.workspace') && !document.querySelector('.loading-screen'))").catch(() => false))) {
    if (Date.now() > deadline) throw new Error("the app did not become ready");
    await wait(100);
  }
  await js(`window.canvasTTY.settings.update({ sessionRestoreMode: "reopen", browserRestoreTabs: true })`);
  for (let i = 0; i < 3; i++) {
    const request = { provider: "terminal", profile: "normal", cwd: env.BENCH_WORK, position: { x: 1500 + i * 700, y: 100 } };
    await js(`window.canvasTTY.terminal.create(${JSON.stringify(request)}).then((s) => s.id)`);
  }
  await js(`window.canvasTTY.browser.open(${JSON.stringify(env.BENCH_PAGE_URL)})`);
  await js(`window.canvasTTY.settings.update({
    browserCanvas: { position: { x: 1500, y: 700 }, size: { width: 900, height: 600 } },
    pluginCanvas: [{ id: "bench-notes", pluginId: "com.example.studio-kit", contributionId: "notes", title: "Studio notes",
      position: { x: 2500, y: 700 }, size: { width: 680, height: 440 } }]
  })`);
  await wait(3000);
  report.seeded = await js("window.canvasTTY.terminal.list().then((list) => list.length)");
}

app.whenReady().then(() => {
  // --frames: what each frame shows at the content centre (scripts/bench-runtime/app/frame-probe.cjs).
  if (env.BENCH_FRAMES === "1") {
    session.defaultSession.registerPreloadScript({ type: "frame", id: "bench-frame-probe", filePath: join(SHIMS, "frame-probe.cjs") });
  }
  const start = async () => {
    const { BrowserWindow } = require("electron");
    for (let i = 0; i < 400 && !firstWindow; i++) await wait(10);
    const win = firstWindow ?? BrowserWindow.getAllWindows()[0];
    if (!win) { report.errors.push("no window"); save(); app.exit(8); return; }
    report.window = { visible: win.isVisible(), focused: win.isFocused() };
    if (win.isVisible() || win.isFocused()) { report.errors.push("ABORT: window visible or focused"); save(); app.exit(7); return; }
    try {
      if (PHASE === "seed") await seed(win);
      else await measure(win);
    } catch (error) {
      report.errors.push(`${PHASE}: ${error.stack ?? error.message}`);
    }
    report.windowEnd = { visible: win.isVisible(), focused: win.isFocused() };
    report.done = true;
    report.valid = report.errors.length === 0 && report.rendererErrors.length === 0;
    save();
    setTimeout(() => { report.errors.push("forced shutdown after the quit deadline"); report.valid = false; save(); app.exit(1); }, 8000);
    app.quit();
  };
  void start();
});
import(pathToFileURL(join(MAIN, "index.js")).href).catch((error) => {
  report.errors.push(`main import: ${error.message}`);
  save();
  app.exit(9);
});
