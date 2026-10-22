import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configPath = new URL("../electron.vite.config.ts", import.meta.url);
const mainPath = new URL("../src/main/index.ts", import.meta.url);
const releaseWorkflowPath = new URL("../.github/workflows/release.yml", import.meta.url);
const settingsPath = new URL(
  "../src/renderer/src/features/plugins/PluginSettingsSection.tsx",
  import.meta.url
);
const ipcPath = new URL("../src/main/ipc/registerIpc.ts", import.meta.url);
const preloadPath = new URL("../src/preload/index.ts", import.meta.url);

test("GitHub sign-in supports optional build input and both browser routes", async () => {
  const [config, main, releaseWorkflow, settings] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(mainPath, "utf8"),
    readFile(releaseWorkflowPath, "utf8"),
    readFile(settingsPath, "utf8")
  ]);

  assert.match(config, /__CANVASTTY_GITHUB_OAUTH_CLIENT_ID__/);
  assert.match(config, /process\.env\.GITHUB_OAUTH_CLIENT_ID/);
  assert.match(config, /process\.env\.CANVASTTY_GITHUB_CLIENT_ID/);
  assert.match(main, /fetcher: \(input, init\) => net\.fetch\(input, init\)/);
  assert.match(releaseWorkflow, /CANVASTTY_GITHUB_CLIENT_ID: \$\{\{ vars\.CANVASTTY_GITHUB_CLIENT_ID \}\}/);
  assert.doesNotMatch(releaseWorkflow, /Missing repository variable CANVASTTY_GITHUB_CLIENT_ID/);

  assert.match(settings, /runGithubSignIn\("embedded"\)/);
  assert.match(settings, /runGithubSignIn\("external"\)/);
  assert.match(settings, /target === "embedded"\) await onOpenBrowser\(url\)/);
  assert.match(settings, /else await window\.canvasTTY\.githubAuth\.openUrl\(url\)/);
  assert.match(settings, /const url = flow\.verificationUri/);
});

test("a pending GitHub sign-in can be cancelled through the trusted renderer only", async () => {
  const [ipc, preload, settings] = await Promise.all([
    readFile(ipcPath, "utf8"),
    readFile(preloadPath, "utf8"),
    readFile(settingsPath, "utf8")
  ]);
  const start = ipc.indexOf("ipcMain.handle(IPC.githubAuthCancel,");
  assert.notEqual(start, -1);
  const handler = ipc.slice(start, ipc.indexOf("ipcMain.", start + 1));
  assert.match(handler, /assertMainRenderer\(event, getMainWindow\)/);
  assert.match(handler, /githubAuth\.cancelDeviceFlow\(\)/);
  assert.match(preload, /cancel: \(\) => ipcRenderer\.invoke\(IPC\.githubAuthCancel\)/);
  assert.match(settings, /window\.canvasTTY\.githubAuth\.cancel\(\)/);
  assert.match(settings, /githubSigninText\(locale, "cancel"\)/);
});
