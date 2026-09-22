import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/renderer/src/App.tsx", import.meta.url);
const contractsPath = new URL("../src/shared/contracts.ts", import.meta.url);
const framePath = new URL("../src/renderer/src/features/plugins/PluginFrame.tsx", import.meta.url);
const ipcPath = new URL("../src/main/ipc/registerIpc.ts", import.meta.url);
const preloadPath = new URL("../src/preload/index.ts", import.meta.url);
const docsPath = new URL("../docs/plugins.md", import.meta.url);

test("browser.open has one permission-gated, awaitable route from every plugin surface", async () => {
  const [app, contracts, frame, ipc, preload, docs] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(contractsPath, "utf8"),
    readFile(framePath, "utf8"),
    readFile(ipcPath, "utf8"),
    readFile(preloadPath, "utf8"),
    readFile(docsPath, "utf8")
  ]);

  assert.match(contracts, /\| "browser:open"/);
  assert.match(contracts, /pluginsOpenBrowser: "plugins:open-browser"/);
  assert.match(contracts, /pluginsBrowserOpenRequested: "plugins:browser-open-requested"/);
  assert.match(contracts, /pluginsBrowserOpenResponded: "plugins:browser-open-responded"/);
  assert.match(preload, /openBrowser:.*IPC\.pluginsOpenBrowser/);
  assert.match(preload, /onBrowserOpenRequested:[\s\S]*?IPC\.pluginsBrowserOpenRequested/);
  assert.match(preload, /completeBrowserOpen:[\s\S]*?IPC\.pluginsBrowserOpenResponded/);

  const frameBrowserOpen = frame.slice(frame.indexOf('if (method === "browser.open")'), frame.indexOf('if (method === "media.pickLibrary")'));
  assert.match(frameBrowserOpen, /requirePermission\(plugin, "browser:open"\)/);
  assert.match(frameBrowserOpen, /await window\.canvasTTY\.plugins\.openBrowser\(pluginId/);
  assert.doesNotMatch(frame, /canvastty:browser-open/);
  assert.doesNotMatch(frameBrowserOpen, /window\.canvasTTY\.browser\.open/);

  assert.match(ipc, /const requestPluginBrowserOpen = async/);
  assert.match(ipc, /plugins\.assertPermission\(pluginId, "browser:open"\)/);
  assert.match(ipc, /normalizePluginBrowserUrl\(value\)/);
  assert.match(ipc, /ipcMain\.handle\(IPC\.pluginsOpenBrowser/);
  const windowHostBrowserOpen = ipc.slice(ipc.indexOf('if (method === "browser.open")'), ipc.indexOf('if (method === "media.pickLibrary")'));
  assert.match(windowHostBrowserOpen, /await requestPluginBrowserOpen\(pluginId, values\.url\)/);
  assert.doesNotMatch(windowHostBrowserOpen, /return browser\.open/);

  const appOpenBrowser = app.slice(app.indexOf("const openBrowser ="), app.indexOf("const closeBrowser ="));
  assert.equal(appOpenBrowser.match(/await browserApi\.open\(url\)/g)?.length, 1);
  assert.match(appOpenBrowser, /await persistSettings\(\{ browserCanvas \}\)/);
  assert.doesNotMatch(appOpenBrowser, /await saveSettings\(\{ browserCanvas \}\)/);
  assert.match(app, /const persistSettings = useCallback\(async/);
  assert.match(app, /const saveSettings = useCallback\(async/);
  assert.match(app, /await persistSettings\(patch\)/);
  assert.match(app, /pluginBrowserOpenQueueRef\.current\.enqueue/);
  assert.match(appOpenBrowser, /onBrowserOpenRequested/);
  assert.match(appOpenBrowser, /completeBrowserOpen/);
  assert.doesNotMatch(app, /canvastty:browser-open/);
  assert.match(docs, /`browser:open` \| `browser\.open`/);
  assert.match(docs, /credentialed URLs/);
});
