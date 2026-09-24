import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contractsPath = new URL("../src/shared/contracts.ts", import.meta.url);
const preloadPath = new URL("../src/preload/index.ts", import.meta.url);
const ipcPath = new URL("../src/main/ipc/registerIpc.ts", import.meta.url);
const mainPath = new URL("../src/main/index.ts", import.meta.url);

test("window bridge exposes native fullscreen state updates without a renderer toggle", async () => {
  const [contracts, preload, ipc, main] = await Promise.all([
    readFile(contractsPath, "utf8"),
    readFile(preloadPath, "utf8"),
    readFile(ipcPath, "utf8"),
    readFile(mainPath, "utf8")
  ]);

  assert.match(contracts, /fullscreen: boolean/);
  assert.match(contracts, /isMacOS: boolean/);
  assert.match(contracts, /windowState: "window:state"/);
  assert.match(preload, /isMacOS: process\.platform === "darwin"/);
  assert.match(preload, /onState: \(listener\) => subscribe\(IPC\.windowState, listener\)/);
  assert.match(ipc, /createWindowStateObserver<BrowserWindow>/);
  assert.match(ipc, /return observeMainWindow/);
  assert.match(main, /observeMainWindowState = registerIpc\(/);
  assert.match(main, /observeMainWindowState\?\.\(window\)/);
  assert.match(main, /observeMainWindowState\?\.\(null\)/);
  assert.doesNotMatch(contracts, /toggleFullScreen/);
  assert.doesNotMatch(preload, /toggleFullScreen/);
  assert.doesNotMatch(ipc, /windowToggleFullScreen/);
});
