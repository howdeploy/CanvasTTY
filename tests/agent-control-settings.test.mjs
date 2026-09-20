import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeSettings, SettingsStore } from "../src/main/services/SettingsStore.ts";

const settingsPanelPath = new URL("../src/renderer/src/features/settings/SettingsPanel.tsx", import.meta.url);
const launchDialogPath = new URL("../src/renderer/src/features/launcher/AgentLaunchDialog.tsx", import.meta.url);
const terminalCardPath = new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url);
const mainPath = new URL("../src/main/index.ts", import.meta.url);
const i18nPath = new URL("../src/renderer/src/lib/i18n.ts", import.meta.url);
const appStylesPath = new URL("../src/renderer/src/styles/app.css", import.meta.url);

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-agent-control-settings-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("fresh installs keep the agent orchestration endpoint off", async () => {
  await withStore(async (dir) => {
    const store = new SettingsStore(dir, "en-US");
    await store.load();
    assert.equal(store.get().agentControlEnabled, false);
    const persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(persisted.agentControlEnabled, false);
  });
});

test("the endpoint setting persists in both directions", async () => {
  for (const agentControlEnabled of [true, false]) {
    await withStore(async (dir) => {
      const store = new SettingsStore(dir, "en-US");
      await store.load();
      await store.update({ agentControlEnabled });

      const reloaded = new SettingsStore(dir, "en-US");
      await reloaded.load();
      assert.equal(reloaded.get().agentControlEnabled, agentControlEnabled);
    });
  }
});

test("a malformed value and a profile written before the setting existed both come back off", async () => {
  await withStore(async (dir) => {
    const store = new SettingsStore(dir, "en-US");
    await store.load();
    const persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));

    await writeFile(join(dir, "settings.json"), JSON.stringify({ ...persisted, agentControlEnabled: "yes" }));
    const repaired = new SettingsStore(dir, "en-US");
    await repaired.load();
    assert.equal(repaired.get().agentControlEnabled, false);

    delete persisted.agentControlEnabled;
    await writeFile(join(dir, "settings.json"), JSON.stringify(persisted));
    const migrated = new SettingsStore(dir, "en-US");
    await migrated.load();
    assert.equal(migrated.get().agentControlEnabled, false);
    const rewritten = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    assert.equal(rewritten.agentControlEnabled, false);
  });
});

test("normalizeSettings keeps an explicit boolean and never infers the endpoint from anything else", async () => {
  await withStore(async (dir) => {
    const store = new SettingsStore(dir, "en-US");
    await store.load();
    const fallback = store.get();
    assert.equal(normalizeSettings({ ...fallback, agentControlEnabled: true }, fallback).agentControlEnabled, true);
    assert.equal(normalizeSettings({ ...fallback, agentControlEnabled: 1 }, fallback).agentControlEnabled, false);
    assert.equal(normalizeSettings({ ...fallback, agentControlEnabled: true }, { ...fallback, agentControlEnabled: true }).agentControlEnabled, true);
    assert.equal(normalizeSettings({ ...fallback, agentControlEnabled: "on" }, { ...fallback, agentControlEnabled: true }).agentControlEnabled, true);
  });
});

test("the setting is exposed in Settings → Agents, honoured by the main process, and explained in both locales", async () => {
  const [panel, dialog, card, main, i18n, styles] = await Promise.all([
    readFile(settingsPanelPath, "utf8"),
    readFile(launchDialogPath, "utf8"),
    readFile(terminalCardPath, "utf8"),
    readFile(mainPath, "utf8"),
    readFile(i18nPath, "utf8"),
    readFile(appStylesPath, "utf8")
  ]);

  // Settings UI: the toggle sits in the Agents section, right after the hooks block.
  const agents = panel.indexOf('section === "agents"');
  const toggle = panel.indexOf('label={t(locale, "agentControlEnabled")}');
  const controls = panel.indexOf('{section === "controls" && (');
  assert.ok(agents > 0 && toggle > agents && toggle < controls);
  assert.match(panel, /onChange=\{\(value\) => void onChange\(\{ agentControlEnabled: value === "on" \}\)\}/);

  // Main process: the setting (or the forced flag) decides, at startup and on every settings change.
  assert.match(main, /applyAgentControlSetting\(settings\.get\(\)\.agentControlEnabled\)/);
  assert.match(main, /await applyAgentControlSetting\(next\.agentControlEnabled\)/);
  assert.match(main, /process\.argv\.includes\("--agent-control"\) \|\| process\.env\.CANVASTTY_AGENT_CONTROL === "1"/);
  assert.match(main, /terminalManager\.setControlConnection\(\{ connectionPath: connection, cliPath: agentControlCliPath \}\)/);
  assert.match(main, /terminalManager\?\.setControlConnection\(null\)/);
  assert.match(main, /join\(process\.resourcesPath, "agent-control", "canvastty-control\.mjs"\)/);
  assert.match(main, /join\(app\.getAppPath\(\), "scripts", "canvastty-control\.mjs"\)/);

  // Launch dialog: an explicit role choice, the endpoint-off hint, and an explicit enable button; nothing silent.
  assert.match(dialog, /onLaunch\(provider, profile, cwd, role\)/);
  assert.match(dialog, /const endpointMissing = role === "orchestrator" && !settings\.agentControlEnabled/);
  assert.match(dialog, /disabled=\{busy \|\| endpointMissing\}/);
  assert.match(dialog, /onClick=\{\(\) => void enableEndpoint\(\)\}/);
  assert.doesNotMatch(dialog, /canvasTTY\.settings\.update/, "the dialog persists nothing itself; only the explicit prop does");
  assert.match(dialog, /if \(endpointMissing\) return;/);

  // Card badge.
  assert.match(card, /session\.role === "orchestrator" && \(/);
  assert.match(card, /className="terminal-card__role"/);
  assert.match(styles, /\.terminal-card__role \{/);
  assert.match(styles, /\.role-row \{/);

  for (const key of ["agentControlEnabled", "agentControlEnabledDescription", "roleAgent", "roleOrchestrator", "orchestratorRoleNote", "orchestratorEndpointOff", "enableAgentControl"]) {
    assert.equal(i18n.match(new RegExp(`^  ${key}: "`, "gm"))?.length, 2, `${key} exists in ru and en`);
  }
  assert.match(i18n, /agentControlEnabled: "Agent orchestration endpoint"/);
  assert.match(i18n, /orchestratorRoleNote: "[^"]*CANVASTTY_CONTROL_CONNECTION[^"]*CANVASTTY_CONTROL_CLI/);
});
