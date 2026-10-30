import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as fileSystem from "node:fs/promises";
import * as url from "node:url";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import test from "node:test";
import * as contracts from "../src/shared/contracts.ts";
import { PluginBrowserOpenBroker } from "../src/main/ipc/PluginBrowserOpenBroker.ts";

const ipcPath = new URL("../src/main/ipc/registerIpc.ts", import.meta.url);
const senderGuard = /assertMainRenderer\(event, getMainWindow\)|if \(!?isMainRenderer\(event, getMainWindow\)/;

function handlerSource(source, channel) {
  const registrations = [...source.matchAll(/\bipcMain\.(?:handle|on)\(IPC\.(\w+),/g)];
  const index = registrations.findIndex((match) => match[1] === channel);
  assert.notEqual(index, -1, `${channel} handler is registered`);
  return source.slice(registrations[index].index, registrations[index + 1]?.index ?? source.length);
}

// Load the actual registration modules, as in the existing VM main-service tests.
// Unused service imports and Electron APIs are doubles; sender checks and callbacks are not replaced.
async function ipcModules({ platform = process.platform, shell = {}, terminalFileEditor = {} } = {}) {
  const unusedImports = [
    "../../shared/canvasNavigation", "../windowState", "../services/SkinRegistry",
    "../services/PixelSkinPackRegistry", "../services/providerCliRegistry", "../services/LimitsService",
    "../services/browser/PluginBrowserOpenPolicy", "../../shared/externalUrl", "../services/homeMedia",
    "../services/terminalFileEditor", "../services/materials/materialClipboard.ts", "../services/materials/materialState.ts"
  ];
  const imports = Object.fromEntries(unusedImports.map((name) => [name, {}]));
  Object.assign(imports, {
    electron: { shell }, "node:fs/promises": fileSystem, "node:url": url,
    "../services/terminalFileEditor": terminalFileEditor,
    "../../shared/contracts": contracts, "../../shared/contracts.ts": contracts,
    "./PluginBrowserOpenBroker": { PluginBrowserOpenBroker }
  });
  const load = async (path) => {
    const { code } = transformSync(await readFile(path, "utf8"), { loader: "ts", format: "cjs", target: "es2022" });
    const module = { exports: {} };
    runInNewContext(code, {
      module, exports: module.exports, Error, URL, Buffer, process: { platform }, console, setTimeout, clearTimeout,
      require(name) {
        assert.ok(Object.hasOwn(imports, name), `unexpected IPC module import: ${name}`);
        return imports[name];
      }
    });
    return module.exports;
  };
  const main = await load(ipcPath);
  imports["./registerIpc"] = main;
  const material = await load(new URL("../src/main/ipc/registerMaterialIpc.ts", import.meta.url));
  return { ...main, ...material };
}

function rendererIdentity() {
  const webContents = { mainFrame: {} };
  const window = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  return { window, event };
}

test("privileged browser IPC validates the trusted main renderer", async () => {
  const source = await readFile(ipcPath, "utf8");

  assert.match(source, /function assertMainRenderer/);
  assert.match(source, /event\.sender !== expected\.webContents/);
  assert.match(source, /event\.senderFrame !== expected\.webContents\.mainFrame/);

  for (const channel of [
    "browserGetState",
    "browserOpen",
    "browserClose",
    "browserNewTab",
    "browserSelectTab",
    "browserCloseTab",
    "browserNavigate",
    "browserBack",
    "browserForward",
    "browserReload",
    "browserFocus",
    "browserSetViewport"
  ]) {
    assert.match(handlerSource(source, channel), senderGuard, `${channel} must validate its sender`);
  }
});

test("channels that change settings, plugins, secrets or terminals accept only the main renderer", async () => {
  const source = await readFile(ipcPath, "utf8");
  for (const channel of [
    "settingsUpdate",
    "mediaRead",
    "pluginsPreviewInstall",
    "pluginsInstall",
    "pluginsSetModules",
    "pluginsSetEnabled",
    "pluginsUninstall",
    "pluginsOpenExternal",
    "pluginsSecretsGet",
    "pluginsSecretsSet",
    "pluginsSecretsDelete",
    "providerSecretsStatus",
    "providerSecretsSet",
    "providerSecretsClear",
    "terminalOpenFile",
    "terminalCreate",
    "terminalRestart",
    "terminalInput",
    "terminalDispose",
    // Reads and window-level actions only the app's own renderer asks for.
    "clipboardRead",
    "clipboardWrite",
    "settingsGet",
    "dialogPickDirectory",
    "dialogPickMedia",
    "limitsGet",
    "pluginsOpenCanvas",
    "pluginsOpenWindow",
    "pluginsStorageGet",
    "pluginsStorageSet",
    "pluginsMediaPickLibrary",
    "pluginsMediaListLibraries",
    "pluginsMediaScanLibrary",
    "pluginsMediaRevokeLibrary",
    "pluginsPlaylistsList",
    "pluginsPlaylistsRead",
    "pluginsPlaylistsWrite",
    "pluginsHermesHudStatus",
    "pluginsHermesHudOpen",
    "pluginsHermesHudClose",
    "terminalList",
    "terminalResize",
    "terminalBounds",
    "terminalRename",
    "terminalSetRestore",
    "terminalSetVisible",
    // The frameless window's own controls.
    "windowMinimize",
    "windowToggleMaximize",
    "windowClose",
    "windowGetState"
  ]) {
    assert.match(handlerSource(source, channel), senderGuard, `${channel} must validate its sender`);
  }
});

test("assertMainRenderer accepts only the live owner's main frame", async () => {
  const { assertMainRenderer } = await ipcModules();
  const { window, event } = rendererIdentity();
  assert.doesNotThrow(() => assertMainRenderer(event, () => window));
  for (const [name, input, owner] of [
    ["foreign sender", { ...event, sender: {} }, window],
    ["subframe", { ...event, senderFrame: {} }, window],
    ["missing frame", { ...event, senderFrame: null }, window],
    ["missing window", event, null],
    ["destroyed window", event, { ...window, isDestroyed: () => true }]
  ]) {
    assert.throws(() => assertMainRenderer(input, () => owner), /trusted CanvasTTY renderer/, name);
  }
});

test("registered privileged handlers refuse foreign frames before side effects", async () => {
  const { registerIpc, registerMaterialIpc } = await ipcModules();
  const { window, event } = rendererIdentity();
  const handlers = new Map();
  const listeners = new Map();
  const ipc = {
    handle(channel, callback) {
      assert.equal(handlers.has(channel), false, `duplicate handler: ${channel}`);
      handlers.set(channel, callback);
    },
    on(channel, callback) {
      assert.equal(listeners.has(channel), false, `duplicate listener: ${channel}`);
      listeners.set(channel, callback);
    }
  };
  const calls = [];
  const record = (name) => (...args) => { calls.push([name, ...args]); return name; };
  registerIpc(ipc, {
    getMainWindow: () => window,
    browser: { navigate: record("navigate") },
    terminals: { input: record("input") }
  });
  registerMaterialIpc(ipc, {
    getMainWindow: () => window, materials: { addPaths: record("addPaths") }
  });
  const { IPC } = contracts;
  const point = { x: 1, y: 2 };
  for (const [channel, name, args, fireAndForget] of [
    [IPC.browserNavigate, "navigate", ["tab", "https://example.test/"], false],
    [IPC.terminalInput, "input", ["terminal", "hello\r"], true],
    [IPC.materialsAddPaths, "addPaths", [["/work/design.png"], point], false]
  ]) {
    const callback = (fireAndForget ? listeners : handlers).get(channel);
    assert.equal(typeof callback, "function", `${channel} is actually registered`);
    for (const denied of [{ ...event, sender: {} }, { ...event, senderFrame: {} }]) {
      calls.length = 0;
      if (fireAndForget) await callback(denied, ...args);
      else await assert.rejects(async () => callback(denied, ...args), /trusted CanvasTTY renderer/);
      assert.deepEqual(calls, [], `${channel}: an untrusted frame never reaches the service`);
    }
    calls.length = 0;
    await callback(event, ...args);
    assert.deepEqual(calls, [[name, ...args, ...(fireAndForget ? [false] : [])]], `${channel}: the trusted frame still reaches the service once`);
  }
});

for (const platform of ["linux", "win32", "darwin"]) {
  test(`${platform} completes both file-opening IPC calls and preserves shell errors`, { timeout: 1_000 }, async () => {
    const calls = [];
    let failure = "";
    const path = platform === "win32" ? "C:\\Users\\Тест\\report #.md" : "/tmp/Тест #?.md";
    const shell = {
      async openExternal(value) { calls.push(["external", value]); if (failure) throw new Error(failure); },
      openPath(value) {
        calls.push(["path", value]);
        return platform === "linux" ? new Promise(() => {}) : Promise.resolve(failure);
      }
    };
    const { registerIpc } = await ipcModules({ platform, shell,
      terminalFileEditor: { resolveTerminalFilePath: async () => path } });
    const { window, event } = rendererIdentity();
    const handlers = new Map();
    registerIpc({ handle: (channel, handler) => handlers.set(channel, handler), on() {} }, {
      getMainWindow: () => window, terminals: { getMetadata: () => ({ cwd: "/work" }) },
      mascots: { errorLog: async () => path }
    });
    for (const channel of [contracts.IPC.terminalOpenFile, contracts.IPC.mascotsOpenLog]) {
      calls.length = 0;
      failure = "";
      await handlers.get(channel)(event, "session", "report.md");
      assert.deepEqual(calls, [platform === "linux" ? ["external", url.pathToFileURL(path).href] : ["path", path]]);
      failure = "No associated application";
      await assert.rejects(() => handlers.get(channel)(event, "session", "report.md"), /No associated application/);
    }
  });
}
