import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { startupPageUrl } from "../src/main/startupPage.ts";

const mainPath = new URL("../src/main/index.ts", import.meta.url);

/** startApplication from the main entry, run against stubs: the order of its startup steps is what is tested. */
async function startApplicationWith(context) {
  const source = await readFile(mainPath, "utf8");
  const start = source.slice(source.indexOf("async function startApplication"), source.indexOf("function buildProviderCliRegistry"));
  return runInNewContext(`${stripTypeScriptTypes(start)}; startApplication`, context);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

test("Mac window close keeps the renderer; quit and other platforms still close normally", async () => {
  const source = await readFile(mainPath, "utf8");
  const create = source.slice(source.indexOf("function createWindow"), source.indexOf("function shellWindowGone"));
  for (const [platform, quitting, hidden] of [["darwin", false, true], ["darwin", true, false], ["linux", false, false], ["win32", false, false]]) {
    class Window extends EventEmitter {
      hidden = false;
      webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
      hide() { this.hidden = true; }
    }
    const context = {
      process: { platform }, app: { isPackaged: true }, BrowserWindow: Window,
      shutdownRunning: quitting, shutdownComplete: false,
      mainWindow: null, mainWindowClosing: false, appSurfaceReady: false,
      appIcon: null, __dirname: "/tmp", join: (...parts) => parts.join("/"),
      mainWindowChromeOptions: () => ({}), markMainBoot() {}, observeMainWindowState: null,
      canvasNavigationInput: null, browserService: null, attachEditContextMenu() {}
    };
    const createWindow = runInNewContext(`${stripTypeScriptTypes(create)}; createWindow`, context);
    const window = createWindow();
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    window.emit("close", event);
    assert.equal(event.defaultPrevented, hidden, `${platform}, quitting=${quitting}`);
    assert.equal(window.hidden, hidden);
    assert.equal(context.mainWindowClosing, !hidden);
    assert.equal(context.mainWindow, window);
  }
});

test("Dock activation raises the retained Mac window even with a plugin window open", async () => {
  const source = await readFile(mainPath, "utf8");
  const activate = source.slice(source.indexOf('  app.on("activate"'), source.indexOf("  // The rejected second launch"));
  const app = new EventEmitter();
  app.isReady = () => true;
  const calls = [];
  const context = {
    app, process: { platform: "darwin" }, shutdownRunning: false, shutdownComplete: false,
    mainWindow: { isDestroyed: () => false, isMinimized: () => true,
      restore: () => calls.push("restore"), show: () => calls.push("show"), focus: () => calls.push("focus") },
    BrowserWindow: { getAllWindows: () => ["plugin window"] },
    startApplication: () => calls.push("startup")
  };
  runInNewContext(activate, context);
  app.emit("activate");
  assert.deepEqual(calls, ["restore", "show", "focus"]);
  calls.length = 0;
  context.shutdownRunning = true;
  app.emit("activate");
  assert.deepEqual(calls, []);
});

function startupContext(events, overrides = {}) {
  const gate = {
    failed: null,
    settled: false,
    fail(error) { this.failed = error; events.push(`gate failed ${error.message}`); },
    settle() { this.settled = true; events.push("gate settled"); }
  };
  const context = {
    Error,
    startupRunning: false,
    shutdownRunning: false,
    shutdownComplete: false,
    servicesReady: false,
    appSurfaceReady: false,
    installMacMenu: null,
    pendingMenuUpdateCheck: false,
    checkUpdatesFromMenu: null,
    mainWindow: null,
    process: { env: {} },
    shellWindowGone: () => false,
    createWindow: () => { events.push("window"); return {}; },
    ipcGate: gate,
    ipcReadinessGate: () => gate,
    markMainBoot: () => undefined,
    mainBootMarks: () => [],
    diagnostics: { record: () => undefined },
    initializeServices: async (ipc) => { events.push(ipc === gate ? "services (gated)" : "services"); },
    loadApplicationSurface: async () => { events.push("surface"); },
    runStartupSmokes: async () => { events.push("smokes"); },
    showStartupFailure: async (_window, error) => { events.push(`failure ${error.message}`); },
    ...overrides
  };
  return { context, gate };
}

test("the application surface loads while services start, and its IPC goes through the readiness gate", async () => {
  const events = [];
  const services = deferred();
  const surface = deferred();
  const { context, gate } = startupContext(events, {
    initializeServices: (ipc) => { events.push(ipc === gate ? "services (gated)" : "services"); return services.promise; },
    loadApplicationSurface: () => { events.push("surface"); return surface.promise; }
  });
  const startApplication = await startApplicationWith(context);
  const startup = startApplication();
  await turn();
  // Both started, neither finished: the renderer no longer waits for every service before it loads.
  assert.deepEqual(events, ["window", "services (gated)", "surface"]);
  surface.resolve();
  await turn();
  assert.deepEqual(events, ["window", "services (gated)", "surface"], "nothing is reported before the services settle");
  services.resolve();
  await startup;
  assert.deepEqual(events, ["window", "services (gated)", "surface", "gate settled", "smokes"]);
  assert.equal(context.startupRunning, false);
});

test("a service failure is shown only after the surface load settled, and waiting calls fail with it", async () => {
  // The failure page replaces the surface: navigating over a page that is still loading reports that page's
  // ERR_ABORTED late, and Electron's load promise takes it as its own. So the failure waits for the surface.
  const events = [];
  const surface = deferred();
  const { context, gate } = startupContext(events, {
    initializeServices: async () => { events.push("services"); throw new Error("gateway could not start"); },
    loadApplicationSurface: () => { events.push("surface"); return surface.promise; }
  });
  const startApplication = await startApplicationWith(context);
  const startup = startApplication();
  await turn();
  await turn();
  assert.deepEqual(events, ["window", "services", "surface"]);
  surface.resolve();
  await startup;
  assert.deepEqual(events, ["window", "services", "surface", "gate failed gateway could not start", "failure gateway could not start"]);
  assert.equal(gate.settled, false);

  // A surface that failed to load on a live window is a startup failure too.
  events.length = 0;
  context.initializeServices = async () => { events.push("services"); };
  context.loadApplicationSurface = async () => { events.push("surface"); throw new Error("renderer bundle missing"); };
  await startApplication();
  assert.deepEqual(events, ["window", "services", "surface", "gate settled", "failure renderer bundle missing"]);
});

test("closing during startup stops quietly, with no failure page", async () => {
  const events = [];
  let gone = false;
  const { context } = startupContext(events, {
    shellWindowGone: () => gone,
    initializeServices: async () => { events.push("services"); gone = true; throw new Error("Object has been destroyed"); }
  });
  const startApplication = await startApplicationWith(context);
  await startApplication();
  assert.deepEqual(events, ["window", "services", "surface"]);
  assert.equal(context.startupRunning, false);

  // A quit already under way never starts anything.
  events.length = 0;
  gone = false;
  context.shutdownRunning = true;
  await startApplication();
  assert.deepEqual(events, []);
});

test("a restart after the services are up loads the surface without starting them again", async () => {
  const events = [];
  const { context } = startupContext(events, { servicesReady: true, ipcGate: null });
  const startApplication = await startApplicationWith(context);
  await startApplication();
  assert.deepEqual(events, ["window", "surface", "smokes"]);
});

test("loading the application surface removes the startup page from browser history", async () => {
  const source = await readFile(mainPath, "utf8");
  const body = source.slice(
    source.indexOf("async function loadApplicationSurface"),
    source.indexOf("async function runStartupSmokes(")
  );

  assert.match(body, /navigationHistory\.clear\(\)/);
  assert.ok(
    body.indexOf("navigationHistory.clear()") > body.lastIndexOf("await window.load"),
    "history is cleared only after the application surface finishes loading"
  );
});

test("dependencies only some paths need are not imported when the main process starts", async () => {
  // Each costs its import time on every launch (electron-updater about 30 ms): they load
  // through lazyRequire on first use. The smoke runners are test code behind env flags.
  const lazy = ["electron-updater", "yaml", "secure-remote-password/client.js", "secure-remote-password/server.js", "@xterm/headless"];
  const root = new URL("../src/main/", import.meta.url);
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".ts"));
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /await import\("\.\/services\/updates\/ElectronUpdaterAdapter"\)/);
  assert.doesNotMatch(main, /^import\s+(?!type\b)[^;]*?from\s+"\.\/services\/updates\/(?:ElectronUpdaterAdapter|AwaitedNsisUpdater)"/gmu);
  const lazyUpdaterModules = new Set([
    "services/updates/ElectronUpdaterAdapter.ts",
    "services/updates/AwaitedNsisUpdater.ts"
  ]);
  const staticImports = [];
  for (const file of files) {
    if (lazyUpdaterModules.has(file.replaceAll("\\", "/"))) continue;
    const source = await readFile(new URL(file, root), "utf8");
    for (const match of source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gmu)) {
      if (lazy.includes(match[1]) || /ElectronSmoke$/u.test(match[1])) staticImports.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(staticImports, []);
});

test("main process acquires the single-instance lock before readiness", async () => {
  const source = await readFile(mainPath, "utf8");
  const lock = source.indexOf("app.requestSingleInstanceLock()");
  const ready = source.indexOf("app.whenReady()");

  assert.notEqual(lock, -1);
  assert.notEqual(ready, -1);
  assert.ok(lock < ready);
  // R4: a rejected second launch raises the window of the running instance
  // instead of exiting silently.
  const handlerStart = source.indexOf('app.on("second-instance"');
  assert.notEqual(handlerStart, -1);
  const secondInstance = source.slice(handlerStart, source.indexOf('app.on("before-quit"'));
  assert.match(secondInstance, /\.restore\(\)/);
  assert.match(secondInstance, /\.show\(\)/);
  assert.match(secondInstance, /\.focus\(\)/);
});

test("background plugin requests never activate the desktop window", async () => {
  const source = await readFile(mainPath, "utf8");
  const launcher = source.slice(
    source.indexOf("function requestPluginLauncher"),
    source.indexOf("function requestPluginCanvas")
  );
  const canvas = source.slice(
    source.indexOf("function requestPluginCanvas"),
    source.indexOf("function broadcastPluginStorageChange")
  );

  for (const route of [launcher, canvas]) {
    assert.match(route, /webContents\.send/);
    assert.doesNotMatch(route, /\.focus\(\)|\.show\(\)|\.restore\(\)/);
  }
});

test("startup window is visible immediately and failures remain visible", async () => {
  const source = await readFile(mainPath, "utf8");

  assert.match(source, /show: true/);
  // One navigation at startup: the application surface itself, no intermediate startup page to race.
  const createWindow = source.slice(source.indexOf("function createWindow"), source.indexOf("function shellWindowGone"));
  assert.doesNotMatch(createWindow, /loadURL|loadFile/);
  // The failure page still reports a startup that could not complete.
  assert.match(source, /startupPageUrl\(\{ locale: app\.getLocale\(\), isMacOS: process\.platform === "darwin", error: detail \}\)/);
  assert.match(source, /showStartupFailure/);
  assert.doesNotMatch(source, /ready-to-show/);
});

test("services register their IPC in groups: first-frame reads before sessions restore, the rest after", async () => {
  const source = await readFile(mainPath, "utf8");
  const init = source.slice(source.indexOf("async function initializeServices"), source.indexOf("async function loadApplicationSurface"));
  const at = (pattern) => {
    const index = init.search(pattern);
    assert.notEqual(index, -1, String(pattern));
    return index;
  };
  const critical = at(/registerCriticalIpc\(ipc,/);
  assert.ok(at(/settings\.load\(\)/) < critical, "settings are loaded before their handlers exist");
  assert.ok(at(/pluginManager\.load\(\)/) < critical);
  assert.ok(critical < at(/restorePersistedSessions\(\)/), "the first frame's reads do not wait for terminals");
  const core = at(/registerIpc\(ipc,/);
  assert.ok(at(/restorePersistedSessions\(\)/) < core, "terminal:list answers only once sessions are restored");
  assert.ok(at(/await Promise\.all\(\[browserReady, storesLoaded\]\)/) < core, "browser store, secrets, media and GitHub auth load first");
  assert.ok(core < at(/ipc\.handle\(IPC\.evenG2State/), "the companion is the last group");
  assert.ok(at(/await evenG2\.load\(\)/) < at(/ipc\.handle\(IPC\.evenG2State/));
  assert.doesNotMatch(init, /ipcMain\.(handle|on)\(/, "every handler goes through the readiness gate");
});

test("startup failure page escapes diagnostic text", () => {
  const url = startupPageUrl({ locale: "ru", isMacOS: false, error: '<script>alert("x")</script>' });
  const html = decodeURIComponent(url.slice(url.indexOf(",") + 1));

  assert.match(html, /CanvasTTY не удалось запустить/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("macOS startup page reserves space for native traffic lights", () => {
  const url = startupPageUrl({ locale: "en", isMacOS: true });
  const html = decodeURIComponent(url.slice(url.indexOf(",") + 1));

  assert.match(html, /--titlebar-height: 32px;/);
  assert.match(html, /grid-template-rows: var\(--titlebar-height\) 1fr/);
  assert.match(html, /padding-left: 78px/);
  assert.doesNotMatch(html, /traffic-light/);
});
