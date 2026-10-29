import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ipcPath = new URL("../src/main/ipc/registerIpc.ts", import.meta.url);

test("privileged browser IPC validates an owned top-level renderer", async () => {
  const source = await readFile(ipcPath, "utf8");

  assert.match(source, /function assertMainRenderer/);
  assert.match(source, /event\.sender !== expected\.webContents/);
  assert.match(source, /event\.senderFrame !== expected\.webContents\.mainFrame/);

  assert.match(source, /event\.senderFrame === event\.sender\.mainFrame/);
  assert.match(source, /macBrowserWindows\?\.forRenderer\(event\.sender\)/);
  const guard = source.slice(source.indexOf("const browserForRenderer"), source.indexOf("ipcMain.handle(IPC.browserOpenWindow"));
  assert.match(guard, /assertMainRenderer\(event, getMainWindow\)/, "unknown senders fall back to the strict main-window guard");
  for (const channel of [
    "browserOpenWindow",
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
    const handler = source.slice(source.indexOf(`IPC.${channel}`), source.indexOf(`IPC.${channel}`) + 320);
    assert.match(handler, /browserForRenderer\(event\)/, `${channel} must validate its sender`);
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
    const start = source.indexOf(`IPC.${channel},`);
    assert.notEqual(start, -1, `${channel} handler is registered`);
    const handler = source.slice(start, source.indexOf("ipcMain.", start));
    assert.match(handler, /(assertMainRenderer|isMainRenderer)\(event, getMainWindow\)/, `${channel} must validate its sender`);
  }
});
