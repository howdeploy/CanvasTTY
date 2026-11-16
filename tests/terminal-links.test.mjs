import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeExternalUrl } from "../src/shared/externalUrl.ts";

const terminalCardPath = new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url);
const dialogPath = new URL("../src/renderer/src/features/terminal/TerminalLinkDialog.tsx", import.meta.url);
const workspacePath = new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url);
const appPath = new URL("../src/renderer/src/App.tsx", import.meta.url);
const contractsPath = new URL("../src/shared/contracts.ts", import.meta.url);
const preloadPath = new URL("../src/preload/index.ts", import.meta.url);
const ipcPath = new URL("../src/main/ipc/registerIpc.ts", import.meta.url);

test("terminal HTTP(S) links use the preferred browser or the chooser", async () => {
  const [terminal, dialog, workspace, app] = await Promise.all([
    readFile(terminalCardPath, "utf8"),
    readFile(dialogPath, "utf8"),
    readFile(workspacePath, "utf8"),
    readFile(appPath, "utf8")
  ]);

  assert.match(terminal, /new WebLinksAddon/);
  assert.match(terminal, /terminalLinkTarget\(uri, range, terminal\.buffer\.active, terminal\.cols\)/);
  assert.match(terminal, /linkHandler:\s*\{[\s\S]*?activate:\s*\(event, uri, range\)[\s\S]*?onOpenUrlRef\.current\(terminalLinkTarget/);
  assert.match(terminal, /new WebLinksAddon[\s\S]*?onOpenUrlRef\.current\(uri\)/);
  // The card gets a stable callback that calls the workspace's latest onOpenTerminalUrl.
  assert.match(workspace, /openUrl: onOpenTerminalUrl/);
  assert.match(workspace, /onOpenUrl: \(url: string\) => latest\.current!\.openUrl\(url\)/);
  assert.match(app, /onOpenTerminalUrl=\{\(url\) => void openTerminalUrl\(url\)\}/);
  const handler = app.match(/const openTerminalUrl = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0];
  assert.ok(handler);
  assert.match(handler, /const safeUrl = normalizeExternalUrl\(url\)/);
  assert.match(handler, /terminalLinkOpenMode === "canvas"\)\s*\{\s*await openBrowser\(safeUrl\)/);
  assert.match(handler, /terminalLinkOpenMode === "external"\)\s*\{\s*await window\.canvasTTY\.external\.openUrl\(safeUrl\)/);
  assert.match(handler, /else\s*\{\s*setPendingTerminalUrl\(safeUrl\)/);
  assert.match(handler, /catch \(error\)\s*\{\s*showToast/);
  assert.match(dialog, /onOpenCanvas\(url\)/);
  assert.match(dialog, /onOpenExternal\(url\)/);
  assert.match(app, /<TerminalLinkDialog/);
  assert.match(app, /void openBrowser\(url\)/);
  assert.match(app, /window\.canvasTTY\.external\.openUrl\(url\)/);
  assert.match(app, /pendingTerminalUrl === null/);
});

test("system-browser URL bridge is trusted-renderer-only and HTTP(S)-only", async () => {
  const [contracts, preload, ipc] = await Promise.all([
    readFile(contractsPath, "utf8"),
    readFile(preloadPath, "utf8"),
    readFile(ipcPath, "utf8")
  ]);

  assert.match(contracts, /externalOpenUrl: "external:open-url"/);
  assert.match(preload, /openUrl: \(url: string\) => invoke\(IPC\.externalOpenUrl, url\)/);
  const handler = ipc.slice(ipc.indexOf("IPC.externalOpenUrl"), ipc.indexOf("IPC.externalOpenUrl") + 260);
  assert.match(handler, /assertMainRenderer\(event, getMainWindow\)/);
  assert.match(handler, /normalizeExternalUrl\(value\)/);

  assert.equal(normalizeExternalUrl("http://localhost:5173"), "http://localhost:5173/");
  assert.equal(normalizeExternalUrl("https://example.com/path?q=1"), "https://example.com/path?q=1");
  for (const value of [
    "file:///tmp/index.html",
    "javascript:alert(1)",
    "https://user:secret@example.com",
    "not a url",
    `https://example.com/${"x".repeat(2_100)}`
  ]) {
    assert.throws(() => normalizeExternalUrl(value), /External URL|HTTP\(S\)/);
  }
});
