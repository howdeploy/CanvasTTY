import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  AGENT_RUNTIME_ENV,
  CAPTURE_ANSWER_ENV,
  CAPTURE_ANSWER_EXPIRES_AT_ENV
} from "../src/agent-runtime/runtime-protocol.mjs";
import { AgentRuntimeBridge } from "../src/main/services/agent-runtime/AgentRuntimeBridge.ts";
import {
  ProviderRuntimeLaunchAdapters,
  claudeLifecycleArgs,
  codexLifecycleArgs,
  mergeOpenCodeLaunchEnvironment,
  openCodeLifecycleConfig
} from "../src/main/services/agent-runtime/ProviderRuntimeLaunch.ts";

const helper = Object.freeze({
  command: "/opt/CanvasTTY Agent/electron",
  args: ["/opt/CanvasTTY Agent/agent-runtime/hook-helper.mjs"],
  env: { ELECTRON_RUN_AS_NODE: "1" }
});

const pluginRunner = Object.freeze({
  command: "/opt/CanvasTTY Agent/electron",
  args: ["/opt/CanvasTTY Agent/agent-runtime/plugin-hook-runner.mjs"],
  env: { ELECTRON_RUN_AS_NODE: "1" }
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-runtime-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("Claude and Codex receive automatic lifecycle hooks without prompt or response forwarding", () => {
  const claude = claudeLifecycleArgs(helper, "linux");
  assert.equal(claude[0], "--settings");
  const settings = JSON.parse(claude[1]);
  assert.equal(settings.showStatusInTerminalTab, true);
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /working.*UserPromptSubmit/u);
  assert.match(settings.hooks.PermissionRequest[0].hooks[0].command, /needs_approval.*PermissionRequest/u);
  assert.match(settings.hooks.Stop[0].hooks[0].command, /idle.*Stop/u);
  assert.match(settings.hooks.Stop[0].hooks[0].command, /^ELECTRON_RUN_AS_NODE='1' /u);
  assert.equal(JSON.stringify(settings).includes('"prompt":'), false);
  assert.equal(JSON.stringify(settings).includes('"response":'), false);

  const codex = codexLifecycleArgs(helper, "linux");
  assert.ok(codex.includes("-c"));
  assert.ok(codex.some((value) => value.startsWith("hooks.UserPromptSubmit=")));
  assert.ok(codex.some((value) => value.startsWith("hooks.PermissionRequest=")));
  assert.ok(codex.some((value) => value.startsWith("hooks.Stop=")));

  const windowsSettings = JSON.parse(claudeLifecycleArgs(helper, "win32")[1]);
  assert.match(
    windowsSettings.hooks.Stop[0].hooks[0].command,
    /^set "ELECTRON_RUN_AS_NODE=1" && /u
  );
});

test("helper process flags stay scoped to hook commands instead of the agent PTY", async (t) => {
  const root = await fixture(t);
  const launch = adaptersFor(root).prepare("codex", "session-codex");
  assert.equal("ELECTRON_RUN_AS_NODE" in launch.environment, false);
  assert.ok(launch.args.some((value) => value.includes("ELECTRON_RUN_AS_NODE='1'")));
  launch.releaseConfiguration();
});

test("revoking CanvasTTY lifecycle hooks leaves every provider launch unmodified", async (t) => {
  const root = await fixture(t);
  const adapters = adaptersFor(root);
  for (const provider of ["codex", "claude", "qwen", "kimi", "opencode", "hermes", "grok", "omp", "pi", "cursor", "minimax", "devin", "antigravity"]) {
    const launch = adapters.prepare(provider, `session-${provider}`, false);
    assert.deepEqual(launch.args, []);
    assert.deepEqual(launch.environment, {});
    launch.releaseConfiguration();
  }
});

test("providers without a hook adapter never write Grok's shared hook configuration", async (t) => {
  const root = await fixture(t);
  const adapters = adaptersFor(root);
  for (const provider of ["omp", "pi", "cursor", "minimax", "devin", "antigravity"]) {
    const launch = adapters.prepare(provider, `session-${provider}`, true);
    assert.deepEqual(launch.args, [], provider);
    assert.deepEqual(launch.environment, {}, provider);
    await assert.rejects(readFile(join(root, "grok", "hooks", "canvastty-runtime-hooks.json"), "utf8"), /ENOENT/u, provider);
    launch.releaseConfiguration();
  }
});

test("a revoked shared-config launch removes stale hooks held by an older live session", async (t) => {
  const root = await fixture(t);
  const adapters = adaptersFor(root);
  const sharedProviders = [
    ["kimi", join(root, "kimi", "config.toml")],
    ["hermes", join(root, "hermes", "config.yaml")],
    ["grok", join(root, "grok", "hooks", "canvastty-runtime-hooks.json")]
  ];

  for (const [provider, configurationPath] of sharedProviders) {
    const observed = adapters.prepare(provider, `session-${provider}-observed`, true);
    await readFile(configurationPath, "utf8");

    const revoked = adapters.prepare(provider, `session-${provider}-revoked`, false);
    assert.deepEqual(revoked.args, []);
    assert.deepEqual(revoked.environment, {});
    await assert.rejects(readFile(configurationPath, "utf8"), /ENOENT/u);

    revoked.releaseConfiguration();
    observed.releaseConfiguration();
  }
});

test("revoking CanvasTTY lifecycle hooks immediately detaches live capabilities and requires a restart to restore them", async (t) => {
  const root = await fixture(t);
  const statuses = new Map();
  const registrations = [];
  const revocations = [];
  const gateway = {
    registerSession(terminalSessionId, provider) {
      registrations.push(terminalSessionId);
      statuses.set(terminalSessionId, "idle");
      return {
        address: join(root, "agent-runtime.sock"),
        terminalSessionId,
        provider,
        capabilityToken: `token-${terminalSessionId}`
      };
    },
    revokeTerminalSession(terminalSessionId) {
      revocations.push(terminalSessionId);
      statuses.delete(terminalSessionId);
    },
    currentStatus(terminalSessionId) {
      return statuses.get(terminalSessionId) ?? null;
    }
  };
  const bridge = new AgentRuntimeBridge(gateway, runtimeOptionsFor(root));

  const active = bridge.prepareLaunch({
    terminalSessionId: "session-active",
    provider: "codex",
    cwd: root
  });
  assert.equal(active.environment[AGENT_RUNTIME_ENV.terminalSessionId], "session-active");
  assert.equal(active.environment[CAPTURE_ANSWER_ENV], undefined);
  assert.equal(active.environment[CAPTURE_ANSWER_EXPIRES_AT_ENV], undefined);
  assert.equal(bridge.currentStatus("session-active"), "idle");

  const granted = bridge.prepareLaunch({
    terminalSessionId: "session-answer-granted",
    provider: "codex",
    cwd: root,
    answerCaptureGrantExpiresAt: Date.now() + 60_000
  });
  assert.equal(granted.environment[CAPTURE_ANSWER_ENV], "1");
  assert.equal(Number(granted.environment[CAPTURE_ANSWER_EXPIRES_AT_ENV]) > Date.now(), true);

  bridge.setCoreHooksEnabled(false);
  assert.deepEqual(revocations, ["session-active", "session-answer-granted"]);
  assert.equal(bridge.currentStatus("session-active"), null);

  const revoked = bridge.prepareLaunch({
    terminalSessionId: "session-revoked",
    provider: "codex",
    cwd: root
  });
  assert.equal(AGENT_RUNTIME_ENV.address in revoked.environment, false);
  assert.deepEqual(revoked.args, []);
  assert.deepEqual(registrations, ["session-active", "session-answer-granted"]);

  bridge.setCoreHooksEnabled(true);
  assert.equal(bridge.currentStatus("session-revoked"), null);
  assert.deepEqual(registrations, ["session-active", "session-answer-granted"]);

  const restarted = bridge.prepareLaunch({
    terminalSessionId: "session-restarted",
    provider: "codex",
    cwd: root
  });
  assert.equal(restarted.environment[AGENT_RUNTIME_ENV.terminalSessionId], "session-restarted");
  assert.deepEqual(registrations, ["session-active", "session-answer-granted", "session-restarted"]);

  active.cleanup();
  granted.cleanup();
  revoked.cleanup();
  restarted.cleanup();
});

test("trusted plugin hooks remain independent from CanvasTTY status hooks", async (t) => {
  const root = await fixture(t);
  const registrations = [{
    key: "com.example.lifecycle-audit:audit",
    events: ["prompt-submit", "after-tool"]
  }];
  const adapters = adaptersFor(root, undefined, {
    runner: pluginRunner,
    registryPath: join(root, "lifecycle", "plugin-hooks.json"),
    list: (provider) => provider === "codex" || provider === "opencode" ? registrations : []
  });

  const codex = adapters.prepare("codex", "session-codex", false);
  const promptHook = codex.args.find((value) => value.startsWith("hooks.UserPromptSubmit="));
  const toolHook = codex.args.find((value) => value.startsWith("hooks.PostToolUse="));
  assert.match(promptHook, /^hooks\.UserPromptSubmit=\[\{hooks=\[\{type="command",command=/u);
  assert.match(promptHook, /plugin-hook-runner\.mjs/u);
  assert.match(promptHook, /ELECTRON_RUN_AS_NODE='1'/u);
  assert.equal(codex.environment.CANVASTTY_PLUGIN_HOOK_TERMINAL_SESSION_ID, "session-codex");
  assert.doesNotMatch(promptHook, /hook-helper\.mjs/u);
  assert.match(toolHook, /plugin-hook-runner\.mjs/u);
  assert.equal(codex.args.some((value) => value.startsWith("hooks.SessionStart=")), false);

  const opencode = adapters.prepare("opencode", "session-opencode", false);
  assert.equal(opencode.environment.CANVASTTY_LIFECYCLE_HOOKS_ENABLED, "0");
  assert.equal(opencode.environment.CANVASTTY_PLUGIN_HOOK_TERMINAL_SESSION_ID, "session-opencode");
  assert.deepEqual(JSON.parse(opencode.environment.CANVASTTY_PLUGIN_HOOK_SESSION), registrations);
  assert.equal(
    JSON.parse(opencode.environment.OPENCODE_CONFIG_CONTENT).plugin.includes(
      pathToFileURL(join(root, "opencode-plugin.mjs")).href
    ),
    true
  );
});

test("semantic plugin hooks map to the provider's native lifecycle boundaries", async (t) => {
  const root = await fixture(t);
  const registrations = [{
    key: "com.example.lifecycle-audit:audit",
    events: [
      "session-start",
      "prompt-submit",
      "permission-request",
      "permission-result",
      "after-tool",
      "stop",
      "session-end"
    ]
  }];
  const adapters = adaptersFor(root, undefined, {
    runner: pluginRunner,
    registryPath: join(root, "lifecycle", "plugin-hooks.json"),
    list: (provider) => ["qwen", "kimi", "hermes"].includes(provider) ? registrations : []
  });

  const qwen = adapters.prepare("qwen", "session-qwen-semantic", false);
  const qwenConfig = JSON.parse(await readFile(qwen.environment.QWEN_CODE_SYSTEM_SETTINGS_PATH, "utf8"));
  assert.match(qwenConfig.hooks.SessionEnd[0].hooks[0].command, /'qwen' 'session-end' 'SessionEnd'/u);
  assert.equal("PermissionResult" in qwenConfig.hooks, false);

  const kimi = adapters.prepare("kimi", "session-kimi-semantic", false);
  const kimiConfig = await readFile(join(root, "kimi", "config.toml"), "utf8");
  assert.match(kimiConfig, /event = "UserPromptSubmit"\ncommand = .*'kimi' 'prompt-submit' 'UserPromptSubmit'/u);
  assert.match(kimiConfig, /event = "PostToolUse"\ncommand = .*'kimi' 'after-tool' 'PostToolUse'/u);
  assert.doesNotMatch(kimiConfig, /'prompt-submit' 'TurnStarted'/u);

  const hermes = adapters.prepare("hermes", "session-hermes-semantic", false);
  const hermesConfig = parseYaml(await readFile(join(root, "hermes", "config.yaml"), "utf8"));
  assert.match(hermesConfig.hooks.post_tool_call[0].command, /'hermes' 'after-tool' 'post_tool_call'/u);
  assert.match(hermesConfig.hooks.on_session_end[0].command, /'hermes' 'stop' 'on_session_end'/u);
  assert.match(hermesConfig.hooks.on_session_finalize[0].command, /'hermes' 'session-end' 'on_session_finalize'/u);

  qwen.releaseConfiguration();
  kimi.releaseConfiguration();
  hermes.releaseConfiguration();
});

test("shared provider hook overlays stay session-neutral while each PTY carries its own session id", async (t) => {
  const root = await fixture(t);
  const registrations = [{
    key: "com.example.lifecycle-audit:audit",
    events: ["prompt-submit"]
  }];
  const adapters = adaptersFor(root, undefined, {
    runner: pluginRunner,
    registryPath: join(root, "lifecycle", "plugin-hooks.json"),
    list: (provider) => provider === "kimi" ? registrations : []
  });

  const first = adapters.prepare("kimi", "session-kimi-one", false);
  const configurationPath = join(root, "kimi", "config.toml");
  const firstConfiguration = await readFile(configurationPath, "utf8");
  const second = adapters.prepare("kimi", "session-kimi-two", false);
  const secondConfiguration = await readFile(configurationPath, "utf8");

  assert.equal(firstConfiguration, secondConfiguration);
  assert.doesNotMatch(firstConfiguration, /session-kimi-(?:one|two)/u);
  assert.equal(first.environment.CANVASTTY_PLUGIN_HOOK_TERMINAL_SESSION_ID, "session-kimi-one");
  assert.equal(second.environment.CANVASTTY_PLUGIN_HOOK_TERMINAL_SESSION_ID, "session-kimi-two");

  first.releaseConfiguration();
  second.releaseConfiguration();
  await assert.rejects(readFile(configurationPath, "utf8"), /ENOENT/u);
});

test("OpenCode lifecycle plugin merges with browser MCP inline config", () => {
  const pluginPath = "/opt/CanvasTTY/agent-runtime/opencode-plugin.mjs";
  const runtime = {
    OPENCODE_CONFIG_CONTENT: openCodeLifecycleConfig(
      JSON.stringify({ model: "provider/model", plugin: ["file:///existing.mjs"] }),
      pluginPath
    )
  };
  const browser = {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: "provider/model",
      mcp: { canvastty_browser: { type: "local" } },
      permission: { canvastty_browser: "allow" }
    })
  };
  const merged = JSON.parse(mergeOpenCodeLaunchEnvironment(browser, runtime).OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(merged.mcp, { canvastty_browser: { type: "local" } });
  assert.deepEqual(merged.permission, { canvastty_browser: "allow" });
  assert.deepEqual(merged.plugin, [
    "file:///existing.mjs",
    pathToFileURL(pluginPath).href
  ]);
});

test("Qwen uses a private per-session settings file and removes it on cleanup", async (t) => {
  const root = await fixture(t);
  const systemSettingsPath = join(root, "qwen-system-settings.json");
  await writeFile(systemSettingsPath, JSON.stringify({
    theme: "user-theme",
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "existing-hook" }] }] }
  }));
  const adapters = adaptersFor(root, systemSettingsPath);
  const launch = adapters.prepare("qwen", "session-qwen");
  const path = launch.environment.QWEN_CODE_SYSTEM_SETTINGS_PATH;
  const config = JSON.parse(await readFile(path, "utf8"));
  assert.equal(config.theme, "user-theme");
  assert.equal(config.hooks.UserPromptSubmit[0].hooks[0].command, "existing-hook");
  assert.match(config.hooks.UserPromptSubmit[1].hooks[0].command, /working.*UserPromptSubmit/u);
  assert.equal(config.hooks.UserPromptSubmit[1].hooks[0].timeout, 3000);
  launch.releaseConfiguration();
  await assert.rejects(readFile(path, "utf8"), /ENOENT/u);
});

test("Kimi, Hermes, and Grok restore only their temporary hook configuration", async (t) => {
  const root = await fixture(t);
  const kimiHome = join(root, "kimi");
  const hermesHome = join(root, "hermes");
  const grokHome = join(root, "grok");
  await Promise.all([
    mkdir(kimiHome, { recursive: true }),
    mkdir(hermesHome, { recursive: true }),
    mkdir(grokHome, { recursive: true })
  ]);
  const kimiOriginal = "# original kimi\n";
  const hermesOriginal = "model:\n  default: provider/model\n";
  await writeFile(join(kimiHome, "config.toml"), kimiOriginal);
  await writeFile(join(hermesHome, "config.yaml"), hermesOriginal);

  const adapters = new ProviderRuntimeLaunchAdapters({
    helper,
    runtimeDirectory: join(root, "runtime"),
    openCodePluginPath: join(root, "opencode-plugin.mjs"),
    kimiHomeDirectory: kimiHome,
    hermesHomeDirectory: hermesHome,
    grokHomeDirectory: grokHome,
    platform: "linux",
    environment: {}
  });
  const kimi = adapters.prepare("kimi", "session-kimi");
  assert.match(await readFile(join(kimiHome, "config.toml"), "utf8"), /\[\[hooks\]\][\s\S]*TurnStarted/u);
  kimi.releaseConfiguration();
  assert.equal(await readFile(join(kimiHome, "config.toml"), "utf8"), kimiOriginal);

  const hermes = adapters.prepare("hermes", "session-hermes");
  const hermesDuring = parseYaml(await readFile(join(hermesHome, "config.yaml"), "utf8"));
  assert.match(hermesDuring.hooks.pre_llm_call[0].command, /working.*pre_llm_call/u);
  assert.equal("type" in hermesDuring.hooks.pre_llm_call[0], false);
  hermes.releaseConfiguration();
  assert.equal(await readFile(join(hermesHome, "config.yaml"), "utf8"), hermesOriginal);

  const grok = adapters.prepare("grok", "session-grok");
  const grokPath = join(grokHome, "hooks", "canvastty-runtime-hooks.json");
  const grokDuring = JSON.parse(await readFile(grokPath, "utf8"));
  assert.match(grokDuring.hooks.Notification[0].hooks[0].command, /needs_approval.*Notification/u);
  grok.releaseConfiguration();
  await assert.rejects(readFile(grokPath, "utf8"), /ENOENT/u);
});

function adaptersFor(root, qwenSystemSettingsPath, pluginHooks) {
  return new ProviderRuntimeLaunchAdapters(runtimeOptionsFor(root, qwenSystemSettingsPath, pluginHooks));
}

function runtimeOptionsFor(root, qwenSystemSettingsPath, pluginHooks) {
  return {
    helper,
    runtimeDirectory: join(root, "runtime"),
    openCodePluginPath: join(root, "opencode-plugin.mjs"),
    kimiHomeDirectory: join(root, "kimi"),
    hermesHomeDirectory: join(root, "hermes"),
    grokHomeDirectory: join(root, "grok"),
    ...(qwenSystemSettingsPath ? { qwenSystemSettingsPath } : {}),
    ...(pluginHooks ? { pluginHooks } : {}),
    platform: "linux",
    environment: {}
  };
}
