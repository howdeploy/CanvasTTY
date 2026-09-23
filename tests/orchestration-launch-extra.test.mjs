import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import {
  ORCHESTRATION_MCP_SERVER_NAME,
  ORCHESTRATION_TOOL_NAMES
} from "../src/agent-browser/orchestration-catalog.mjs";
import { MCP_SERVER_NAME } from "../src/agent-browser/tool-catalog.mjs";
import {
  ProviderLaunchAdapters,
  recoverKimiConfigurationOnStartup
} from "../src/main/services/agent-browser/ProviderLaunch.ts";
import {
  hermesMcpEntry,
  hermesOrchestrationEntry,
  recoverHermesConfigurationOnStartup
} from "../src/main/services/hermesConfig.ts";

const helper = Object.freeze({
  command: "/opt/CanvasTTY Agent/helper.mjs",
  args: ["--socket", "/tmp/socket with spaces.sock"],
  env: { ELECTRON_RUN_AS_NODE: "1" }
});

const orchestrationHelper = Object.freeze({
  command: "/opt/CanvasTTY Agent/orchestration-helper.mjs",
  args: ["--bridge", "orchestration"],
  env: { ELECTRON_RUN_AS_NODE: "1" }
});

const OPENCODE_ORCHESTRATION_ENV_NAMES = [
  "CANVASTTY_ORCHESTRATION_ADDRESS",
  "CANVASTTY_ORCHESTRATION_CAPABILITY",
  "CANVASTTY_ORCHESTRATION_CONNECTION_ID",
  "CANVASTTY_TERMINAL_SESSION_ID"
];

const providerClis = Object.freeze({
  get(provider) {
    return Object.freeze({
      state: "available",
      provider,
      executable: `/resolved/${provider}`,
      launcher: "native",
      environment: Object.freeze({ PATH: "/resolved:/usr/bin" }),
      checked: Object.freeze([{ path: `/resolved/${provider}`, result: "selected" }])
    });
  },
  snapshot() {
    throw new Error("Orchestration launch tests do not need a complete snapshot.");
  }
});

async function fixture(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function seedHome(path) {
  await mkdir(path, { recursive: true });
  return path;
}

function opencodeAdapters(root) {
  return new ProviderLaunchAdapters({
    helper,
    orchestrationHelper,
    providerClis,
    runtimeDirectory: join(root, "runtime"),
    hermesHomeDirectory: join(root, "hermes"),
    kimiHomeDirectory: join(root, "kimi"),
    probeKimiPerRunConfig: () => true,
    environment: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: "opencode/kimi-k3",
        mcp: { existing: { type: "remote", url: "https://example.test/mcp" } },
        permission: "ask"
      })
    }
  });
}

test("OpenCode gains canvastty_agents only when orchestration is requested", async (t) => {
  const root = await fixture(t, "canvastty-opencode-orch-");
  const adapters = opencodeAdapters(root);

  const baseline = adapters.prepare("opencode", "connection-baseline");
  const declined = adapters.prepare("opencode", "connection-declined", { orchestration: false });
  const full = adapters.prepare("opencode", "connection-full", { orchestration: true });

  assert.equal(baseline.environment.OPENCODE_CONFIG_CONTENT.includes(ORCHESTRATION_MCP_SERVER_NAME), false);
  assert.equal(declined.environment.OPENCODE_CONFIG_CONTENT, baseline.environment.OPENCODE_CONFIG_CONTENT);

  const config = JSON.parse(full.environment.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.model, "opencode/kimi-k3");
  assert.deepEqual(config.mcp.existing, { type: "remote", url: "https://example.test/mcp" });
  assert.deepEqual(config.permission, { "*": "ask", [`${MCP_SERVER_NAME}_*`]: "allow" });
  assert.deepEqual(config.mcp[MCP_SERVER_NAME], {
    type: "local",
    command: [helper.command, ...helper.args],
    enabled: true,
    environment: helper.env
  });
  const agents = config.mcp[ORCHESTRATION_MCP_SERVER_NAME];
  assert.deepEqual(agents, {
    type: "local",
    command: [orchestrationHelper.command, ...orchestrationHelper.args],
    enabled: true,
    environment: {
      ELECTRON_RUN_AS_NODE: "1",
      CANVASTTY_ORCHESTRATION_ADDRESS: "{env:CANVASTTY_ORCHESTRATION_ADDRESS}",
      CANVASTTY_ORCHESTRATION_CAPABILITY: "{env:CANVASTTY_ORCHESTRATION_CAPABILITY}",
      CANVASTTY_ORCHESTRATION_CONNECTION_ID: "{env:CANVASTTY_ORCHESTRATION_CONNECTION_ID}",
      CANVASTTY_TERMINAL_SESSION_ID: "{env:CANVASTTY_TERMINAL_SESSION_ID}"
    }
  });
  for (const name of OPENCODE_ORCHESTRATION_ENV_NAMES) {
    assert.equal(agents.environment[name], `{env:${name}}`);
  }

  // The orchestration launch leaves no state behind; the next plain launch is
  // byte-identical to the original baseline.
  full.releaseConfiguration();
  const after = adapters.prepare("opencode", "connection-after");
  assert.equal(after.environment.OPENCODE_CONFIG_CONTENT, baseline.environment.OPENCODE_CONFIG_CONTENT);
});

test("OpenCode rejects an unvalidated orchestration helper before touching config", async (t) => {
  const root = await fixture(t, "canvastty-opencode-orch-invalid-");
  const adapters = new ProviderLaunchAdapters({
    helper,
    orchestrationHelper: { command: orchestrationHelper.command, args: [], env: { PATH: "/untrusted" } },
    providerClis,
    runtimeDirectory: join(root, "runtime"),
    hermesHomeDirectory: join(root, "hermes"),
    kimiHomeDirectory: join(root, "kimi"),
    environment: {}
  });
  assert.throws(
    () => adapters.prepare("opencode", "connection", { orchestration: true }),
    /not allowed: PATH/u
  );
});

test("Kimi per-run config gains canvastty_agents while the baseline stays byte-identical", async (t) => {
  const root = await fixture(t, "canvastty-kimi-perrun-orch-");
  const home = join(root, "kimi-home");
  const runtimeDirectory = join(root, "runtime");
  const adapters = new ProviderLaunchAdapters({
    helper,
    orchestrationHelper,
    providerClis,
    kimiHomeDirectory: home,
    hermesHomeDirectory: join(root, "hermes-home"),
    runtimeDirectory,
    probeKimiPerRunConfig: () => true
  });

  const plain = adapters.prepare("kimi", "connection/plain");
  const plainContent = await readFile(plain.args[1], "utf8");
  plain.releaseConfiguration();
  assert.equal(await exists(plain.args[1]), false);
  assert.equal(plainContent.includes(ORCHESTRATION_MCP_SERVER_NAME), false);

  const full = adapters.prepare("kimi", "connection/full", { orchestration: true });
  const fullContent = await readFile(full.args[1], "utf8");
  const baselineAgain = adapters.prepare("kimi", "connection/baseline-again");
  const baselineContent = await readFile(baselineAgain.args[1], "utf8");
  baselineAgain.releaseConfiguration();

  assert.equal(baselineContent, plainContent);
  const document = JSON.parse(fullContent);
  assert.deepEqual(Object.keys(document.mcpServers).sort(), [ORCHESTRATION_MCP_SERVER_NAME, MCP_SERVER_NAME]);
  assert.equal(document.mcpServers[MCP_SERVER_NAME].command, helper.command);
  assert.deepEqual(document.mcpServers[ORCHESTRATION_MCP_SERVER_NAME], {
    transport: "stdio",
    command: orchestrationHelper.command,
    args: [...orchestrationHelper.args],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    enabled: true,
    enabledTools: [...ORCHESTRATION_TOOL_NAMES]
  });

  // Per-run orchestration and plain launches share the temp config.toml
  // without a capability conflict because the shared state is identical.
  const concurrent = adapters.prepare("kimi", "connection-other");
  full.releaseConfiguration();
  concurrent.releaseConfiguration();
  assert.equal(await exists(join(home, "config.toml")), false);
});

test("Kimi fallback config writes and removes the orchestration entry", async (t) => {
  const root = await fixture(t, "canvastty-kimi-fallback-orch-");
  const home = await seedHome(join(root, "kimi-home"));
  await writeFile(join(home, "mcp.json"), '{\n  "mcpServers" : { "existing" : {"command":"keep"} }\n}\n');
  await writeFile(join(home, "config.toml"), 'theme = "dark"\n');
  const originalMcp = await readFile(join(home, "mcp.json"));
  const originalConfig = await readFile(join(home, "config.toml"));

  const adapters = new ProviderLaunchAdapters({
    helper,
    orchestrationHelper,
    providerClis,
    kimiHomeDirectory: home,
    hermesHomeDirectory: join(root, "hermes-home"),
    runtimeDirectory: join(root, "runtime"),
    probeKimiPerRunConfig: () => false
  });

  const launch = adapters.prepare("kimi", "fallback", { orchestration: true });
  const mutated = JSON.parse(await readFile(join(home, "mcp.json"), "utf8"));
  assert.deepEqual(mutated.mcpServers.existing, { command: "keep" });
  assert.equal(mutated.mcpServers[MCP_SERVER_NAME].command, helper.command);
  assert.equal(mutated.mcpServers[ORCHESTRATION_MCP_SERVER_NAME].command, orchestrationHelper.command);
  assert.deepEqual(
    mutated.mcpServers[ORCHESTRATION_MCP_SERVER_NAME].enabledTools,
    [...ORCHESTRATION_TOOL_NAMES]
  );
  // Orchestration tools follow the Claude precedent: exposed but not added to
  // the temporary permission rule block.
  const configToml = await readFile(join(home, "config.toml"), "utf8");
  assert.match(configToml, /mcp__canvastty_browser__\*/u);
  assert.equal(configToml.includes(ORCHESTRATION_MCP_SERVER_NAME), false);

  launch.releaseConfiguration();
  assert.deepEqual(await readFile(join(home, "mcp.json")), originalMcp);
  assert.deepEqual(await readFile(join(home, "config.toml")), originalConfig);
  assert.equal(await exists(join(home, ".canvastty-browser-recovery.json")), false);
  assert.equal(await exists(join(home, ".canvastty-browser-backups")), false);
});

test("Kimi fallback recovery restores both temporary entries byte for byte", async (t) => {
  const root = await fixture(t, "canvastty-kimi-recovery-orch-");
  const home = await seedHome(join(root, "kimi-home"));
  await writeFile(join(home, "mcp.json"), '{"mcpServers":{"keep":{"command":"original"}}}\n');
  await writeFile(join(home, "config.toml"), 'model = "kimi"\n');
  const originalMcp = await readFile(join(home, "mcp.json"));
  const originalConfig = await readFile(join(home, "config.toml"));

  const adapters = new ProviderLaunchAdapters({
    helper,
    orchestrationHelper,
    providerClis,
    kimiHomeDirectory: home,
    hermesHomeDirectory: join(root, "hermes-home"),
    runtimeDirectory: join(root, "runtime"),
    probeKimiPerRunConfig: () => false
  });
  adapters.prepare("kimi", "crashed", { orchestration: true });
  assert.equal(
    JSON.parse(await readFile(join(home, "mcp.json"), "utf8")).mcpServers[ORCHESTRATION_MCP_SERVER_NAME]
      .command,
    orchestrationHelper.command
  );

  recoverKimiConfigurationOnStartup(home);
  assert.deepEqual(await readFile(join(home, "mcp.json")), originalMcp);
  assert.deepEqual(await readFile(join(home, "config.toml")), originalConfig);
  assert.equal(await exists(join(home, ".canvastty-browser-recovery.json")), false);
});

test("Kimi fallback guard rejects orchestration only when the active config lacks it", async (t) => {
  const root = await fixture(t, "canvastty-kimi-mix-orch-");
  const plainFirst = new ProviderLaunchAdapters({
    helper,
    orchestrationHelper,
    providerClis,
    kimiHomeDirectory: join(root, "kimi-plain-first"),
    hermesHomeDirectory: join(root, "hermes-home"),
    runtimeDirectory: join(root, "runtime"),
    probeKimiPerRunConfig: () => false
  });
  const plain = plainFirst.prepare("kimi", "plain");
  assert.throws(
    () => plainFirst.prepare("kimi", "orchestrator", { orchestration: true }),
    /orchestration cannot be enabled while a temporary Kimi configuration is active/u
  );
  plain.releaseConfiguration();

  const orchestrationFirst = new ProviderLaunchAdapters({
    helper,
    orchestrationHelper,
    providerClis,
    kimiHomeDirectory: join(root, "kimi-orch-first"),
    hermesHomeDirectory: join(root, "hermes-home"),
    runtimeDirectory: join(root, "runtime"),
    probeKimiPerRunConfig: () => false
  });
  const orchestrator = orchestrationFirst.prepare("kimi", "orchestrator", { orchestration: true });
  const subagent = orchestrationFirst.prepare("kimi", "subagent");
  orchestrator.releaseConfiguration();
  assert.equal(
    await exists(join(root, "kimi-orch-first", "mcp.json")),
    true
  );
  subagent.releaseConfiguration();
  assert.equal(await exists(join(root, "kimi-orch-first", "mcp.json")), false);
});

test("Hermes config.yaml gains a placeholder-env orchestration entry and restores exactly", async (t) => {
  const root = await fixture(t, "canvastty-hermes-orch-");
  const home = await seedHome(join(root, "hermes-home"));
  const paths = {
    config: join(home, "config.yaml"),
    journal: join(home, ".canvastty-hermes-browser-recovery.json"),
    backupRoot: join(home, ".canvastty-hermes-browser-backups")
  };
  const original = Buffer.from(
    "# preserve this comment\nmodel:\n  default: test/model\nmcp_servers:\n  existing:\n    url: https://example.test/mcp\n",
    "utf8"
  );
  await writeFile(paths.config, original, { mode: 0o640 });
  const originalMode = (await stat(paths.config)).mode & 0o777;

  const adapters = new ProviderLaunchAdapters({
    helper,
    orchestrationHelper,
    providerClis,
    hermesHomeDirectory: home,
    kimiHomeDirectory: join(root, "kimi-home"),
    runtimeDirectory: join(root, "runtime")
  });

  const baseline = adapters.prepare("hermes", "hermes-baseline");
  const baselineYaml = await readFile(paths.config, "utf8");
  const baselineServers = parseYaml(baselineYaml).mcp_servers;
  assert.deepEqual(Object.keys(baselineServers).sort(), [MCP_SERVER_NAME, "existing"]);
  baseline.releaseConfiguration();
  assert.deepEqual(await readFile(paths.config), original);

  const full = adapters.prepare("hermes", "hermes-full", { orchestration: true });
  const during = parseYaml(await readFile(paths.config, "utf8"));
  assert.equal(during.model.default, "test/model");
  assert.equal(during.mcp_servers.existing.url, "https://example.test/mcp");
  assert.deepEqual(during.mcp_servers[MCP_SERVER_NAME], hermesMcpEntry(helper));
  assert.deepEqual(during.mcp_servers[ORCHESTRATION_MCP_SERVER_NAME], hermesOrchestrationEntry(orchestrationHelper));
  const entry = hermesOrchestrationEntry(orchestrationHelper);
  assert.equal(entry.env.CANVASTTY_ORCHESTRATION_ADDRESS, "${CANVASTTY_ORCHESTRATION_ADDRESS}");
  assert.equal(entry.env.CANVASTTY_ORCHESTRATION_CAPABILITY, "${CANVASTTY_ORCHESTRATION_CAPABILITY}");
  assert.equal(entry.env.CANVASTTY_TERMINAL_SESSION_ID, "${CANVASTTY_TERMINAL_SESSION_ID}");
  assert.equal(JSON.stringify(entry).includes("one-time-secret"), false);
  assert.deepEqual(entry.tools, { include: [...ORCHESTRATION_TOOL_NAMES], resources: false, prompts: false });
  assert.equal(entry.trust, "full");
  assert.equal((await stat(paths.config)).mode & 0o777, originalMode);

  // A plain launch shares the orchestration config rather than failing: the
  // extra entry is inert without the orchestration environment.
  const shared = adapters.prepare("hermes", "hermes-shared");
  full.releaseConfiguration();
  assert.ok(parseYaml(await readFile(paths.config, "utf8")).mcp_servers[MCP_SERVER_NAME]);
  shared.releaseConfiguration();
  assert.deepEqual(await readFile(paths.config), original);
  assert.equal(await exists(paths.journal), false);
  assert.equal(await exists(paths.backupRoot), false);

  // The non-orchestration baseline is byte-stable across launches.
  const baselineAgain = adapters.prepare("hermes", "hermes-baseline-again");
  assert.equal(await readFile(paths.config, "utf8"), baselineYaml);
  baselineAgain.releaseConfiguration();
});

test("Hermes orchestration guard and conflict detection fail closed", async (t) => {
  const root = await fixture(t, "canvastty-hermes-orch-guard-");
  const plainHome = join(root, "plain");
  const plainAdapters = new ProviderLaunchAdapters({
    helper,
    orchestrationHelper,
    providerClis,
    hermesHomeDirectory: plainHome,
    kimiHomeDirectory: join(root, "kimi-home"),
    runtimeDirectory: join(root, "runtime")
  });
  const plain = plainAdapters.prepare("hermes", "plain");
  assert.throws(
    () => plainAdapters.prepare("hermes", "orchestrator", { orchestration: true }),
    /orchestration cannot be enabled while a temporary Hermes configuration is active/u
  );
  plain.releaseConfiguration();

  const conflictHome = await seedHome(join(root, "conflict"));
  await writeFile(
    join(conflictHome, "config.yaml"),
    `mcp_servers:\n  ${ORCHESTRATION_MCP_SERVER_NAME}:\n    command: keep\n`
  );
  const conflictAdapters = new ProviderLaunchAdapters({
    helper,
    orchestrationHelper,
    providerClis,
    hermesHomeDirectory: conflictHome,
    kimiHomeDirectory: join(root, "kimi-home"),
    runtimeDirectory: join(root, "runtime")
  });
  assert.throws(
    () => conflictAdapters.prepare("hermes", "conflict", { orchestration: true }),
    new RegExp(`Hermes MCP server name ${ORCHESTRATION_MCP_SERVER_NAME} is already configured`, "u")
  );
});

test("Hermes startup recovery removes an interrupted orchestration entry", async (t) => {
  const root = await fixture(t, "canvastty-hermes-orch-recovery-");
  const home = await seedHome(join(root, "hermes-home"));
  const original = Buffer.from("# exact config\nmodel:\n  default: test/model\n", "utf8");
  await writeFile(join(home, "config.yaml"), original);

  const adapters = new ProviderLaunchAdapters({
    helper,
    orchestrationHelper,
    providerClis,
    hermesHomeDirectory: home,
    kimiHomeDirectory: join(root, "kimi-home"),
    runtimeDirectory: join(root, "runtime")
  });
  adapters.prepare("hermes", "crashed", { orchestration: true });
  const servers = parseYaml(await readFile(join(home, "config.yaml"), "utf8")).mcp_servers;
  assert.ok(servers[ORCHESTRATION_MCP_SERVER_NAME]);

  recoverHermesConfigurationOnStartup(home);
  assert.deepEqual(await readFile(join(home, "config.yaml")), original);
  assert.equal(await exists(join(home, ".canvastty-hermes-browser-recovery.json")), false);
  assert.equal(await exists(join(home, ".canvastty-hermes-browser-backups")), false);
});
