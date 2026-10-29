import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const repository = fileURLToPath(new URL("../../", import.meta.url));

/** Runs the production browser services with owned temporary storage and fake Electron surfaces. */
export async function browserServiceHarness(t, { platform = "darwin", entry = "BrowserService" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-browser-service-test-"));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  let nextContentsId = 1;
  let nextWindowId = 1;
  const windows = [];
  const browserSession = Object.assign(new EventEmitter(), {
    registerPreloadScript: () => "test-preload",
    unregisterPreloadScript() {},
    setPermissionCheckHandler() {},
    setPermissionRequestHandler() {},
    setDevicePermissionHandler() {}
  });

  class FakeView {
    children = [];
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    visible = false;
    addChildView(view) { this.children = this.children.filter((child) => child !== view); this.children.push(view); }
    removeChildView(view) { this.children = this.children.filter((child) => child !== view); }
    setVisible(visible) { this.visible = visible; }
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds; }
    setBorderRadius() {}
    setBackgroundColor() {}
  }

  class FakeContents extends EventEmitter {
    id = nextContentsId++;
    destroyed = false;
    attached = false;
    url = "";
    loads = [];
    throttled = true;
    zoom = 1;
    session = browserSession;
    commands = [];
    commandHandler = async () => ({});
    debugger = Object.assign(new EventEmitter(), {
      isAttached: () => this.attached,
      attach: () => { this.attached = true; },
      detach: () => { this.attached = false; },
      sendCommand: async (method, params) => {
        this.commands.push({ method, params });
        return this.commandHandler(method, params);
      }
    });
    navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    isDestroyed() { return this.destroyed; }
    isLoading() { return false; }
    getURL() { return this.url; }
    getTitle() { return "Fixture"; }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
    setBackgroundThrottling(throttled) { this.throttled = throttled; }
    getZoomFactor() { return this.zoom; }
    setZoomFactor(zoom) { this.zoom = zoom; }
    send() {}
    async loadURL(url) {
      this.loads.push(url);
      this.url = url;
      this.emit("did-start-navigation", null, url, false, true);
      this.emit("did-navigate", null, url);
      this.emit("did-stop-loading");
    }
    reload() { void this.loadURL(this.url); }
    close() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("destroyed");
    }
    focus() {}
    isCurrentlyAudible() { return false; }
    isBeingCaptured() { return false; }
    isDevToolsOpened() { return false; }
  }

  class FakeContentsView extends FakeView {
    webContents = new FakeContents();
  }

  class FakeWindow extends EventEmitter {
    id = nextWindowId++;
    webContents = new FakeContents();
    contentView = new FakeView();
    visible = true;
    minimized = false;
    destroyed = false;
    constructor(options = {}) {
      super();
      this.options = options;
      this.visible = options.show ?? true;
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isFocused() { return true; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    getContentBounds() { return { x: 0, y: 0, width: 1100, height: 800 }; }
    getContentSize() { return [1100, 800]; }
    loadURL(url) { return this.webContents.loadURL(url); }
    async loadFile(path) { this.loadedFile = path; }
    show() { this.visible = true; this.emit("show"); }
    hide() { this.visible = false; this.emit("hide"); }
    minimize() { this.minimized = true; this.emit("minimize"); }
    restore() { this.minimized = false; this.emit("restore"); }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
      this.webContents.close();
    }
  }

  const electronStub = {
    app: { getPath: () => root }, View: FakeView, WebContentsView: FakeContentsView,
    BrowserWindow: FakeWindow, session: { fromPartition: () => browserSession },
    nativeImage: {}, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) }
  };
  const source = join(repository, "src/main/services", `${entry}.ts`);
  const result = await build({
    entryPoints: [source], bundle: true, platform: "node", format: "cjs", write: false,
    define: { "process.platform": JSON.stringify(platform) }, logLevel: "silent",
    plugins: [{ name: "fake-electron", setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: "module.exports = electronStub;", loader: "js"
      }));
    } }]
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", "__dirname", "electronStub", result.outputFiles[0].text)(
    require, module, module.exports, dirname(source), electronStub
  );
  return { ...module.exports, root, FakeWindow, windows, onCleanup: (cleanup) => cleanups.push(cleanup) };
}

export async function flushBrowser() {
  for (let index = 0; index < 20; index += 1) await new Promise(setImmediate);
}
