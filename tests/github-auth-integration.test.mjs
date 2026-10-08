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

test("GitHub sign-in keeps optional build input, both browser routes, and trusted cancellation IPC", async () => {
  const [config, main, releaseWorkflow, settings, ipc] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(mainPath, "utf8"),
    readFile(releaseWorkflowPath, "utf8"),
    readFile(settingsPath, "utf8"),
    readFile(ipcPath, "utf8")
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

  const cancelIpcStart = ipc.indexOf("IPC.githubAuthCancel,");
  const cancelIpcHandler = ipc.slice(cancelIpcStart, ipc.indexOf("ipcMain.", cancelIpcStart));
  assert.match(cancelIpcHandler, /assertMainRenderer\(event, getMainWindow\)/);
});
