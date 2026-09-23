import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
import { hasConfiguredRemoteRoute, launchableProviders } from "../src/shared/agentAvailability.ts";

const host = { id: "srv", label: "Server", sshHost: "srv.example" };
const account = (id, provider, hostId) => ({ id, provider, label: id, hostId, binding: { kind: "cli-home", directory: `/tmp/fake-${id}` } });
const noCli = { codex: false, claude: false, qwen: false, kimi: false, opencode: false, hermes: false, grok: false, omp: false, pi: false, cursor: false, minimax: false, devin: false, antigravity: false };

test("a provider without a local CLI stays launchable through a remote account or container command", () => {
  const settings = {
    providerAccounts: [account("remote", "claude", "srv"), account("here", "codex", "local"), account("implicit", "qwen", undefined)],
    containerProfiles: [{ commands: { opencode: "opencode" } }]
  };
  assert.equal(hasConfiguredRemoteRoute(settings, "claude"), true);
  assert.equal(hasConfiguredRemoteRoute(settings, "codex"), false);
  assert.equal(hasConfiguredRemoteRoute(settings, "qwen"), false);
  assert.equal(hasConfiguredRemoteRoute(settings, "opencode"), true);
  const launchable = launchableProviders(["claude", "codex", "qwen", "opencode", "grok"], { ...noCli, grok: true }, settings);
  assert.deepEqual([...launchable].sort(), ["claude", "grok", "opencode"]);
});

test("missing local CLIs hide launcher entries unless a saved remote route exists", async t => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-availability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "settings.json"), JSON.stringify({
    settingsVersion: 24,
    remoteHosts: [host],
    providerAccounts: [account("remote-claude", "claude", "srv")],
    homeLauncherProviders: ["codex", "claude", "grok"]
  }));
  const store = new SettingsStore(root, "en", "darwin", { ...noCli, grok: true });
  const loaded = await store.load();
  assert.deepEqual(loaded.homeLauncherProviders, ["claude", "grok"]);

  const refreshed = await store.setAvailableProviders({ ...noCli });
  assert.deepEqual(refreshed.homeLauncherProviders, ["claude"]);
});
