import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import {
  APPROVED_BROWSER_TOOL_NAMES,
  MCP_SERVER_NAME
} from "../src/agent-browser/tool-catalog.mjs";
import {
  KimiTemporaryConfiguration,
  ProviderLaunchAdapters,
  claudeMcpArgs,
  codexMcpArgs,
  recoverKimiConfigurationOnStartup,
  resolveKimiHomeDirectory
} from "../src/main/services/agent-browser/ProviderLaunch.ts";
import {
  HermesTemporaryConfiguration,
  hermesMcpEntry,
  recoverHermesConfigurationOnStartup,
  resolveHermesHomeDirectory
} from "../src/main/services/hermesConfig.ts";

const helper = Object.freeze({
  command: "/opt/CanvasTTY Agent/helper.mjs",
  args: ["--socket", "/tmp/socket with spaces.sock", "--quote=\"yes\""],
  env: { ELECTRON_RUN_AS_NODE: "1" }
});

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
    throw new Error("Provider launch tests do not need a complete snapshot.");
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

async function crashWhileHoldingKimiLock(home) {
  const providerLaunchUrl = new URL(
    "../src/main/services/agent-browser/ProviderLaunch.ts",
    import.meta.url
  ).href;
  const source = [
    `import { KimiTemporaryConfiguration } from ${JSON.stringify(providerLaunchUrl)};`,
    `const helper = ${JSON.stringify(helper)};`,
    `KimiTemporaryConfiguration.begin({`,
    `  homeDirectory: ${JSON.stringify(home)},`,
    "  helper,",
    "  includeMcpEntry: true,",
    "  lockHooks: { beforeRelease() { process.exit(73); } }",
    "});",
    "process.exit(74);"
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const pid = child.pid;
  assert.ok(pid && pid > 0);
  let stderr = "";
  let bytes = 0;
  const consume = (chunk) => {
    bytes += chunk.byteLength;
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_384);
    if (bytes > 64 * 1024) child.kill("SIGKILL");
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  const result = await waitForChild(child, 10_000);
  return { pid, ...result, stderr };
}

async function exitedChildPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid && pid > 0);
  const result = await waitForChild(child, 5_000);
  assert.equal(result.code, 0);
  return pid;
}

function waitForChild(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Kimi lock fixture child timed out."));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function kimiPaths(home) {
  return {
    mcp: join(home, "mcp.json"),
    config: join(home, "config.toml"),
    lock: join(home, ".canvastty-browser.lock"),
    journal: join(home, ".canvastty-browser-recovery.json"),
    backupRoot: join(home, ".canvastty-browser-backups")
  };
}

function hermesPaths(home) {
  return {
    config: join(home, "config.yaml"),
    journal: join(home, ".canvastty-hermes-browser-recovery.json"),
    backupRoot: join(home, ".canvastty-hermes-browser-backups")
  };
}

test("claudeMcpArgs returns one exact per-launch MCP config and permission rule", () => {
  assert.deepEqual(claudeMcpArgs(helper), [
    "--mcp-config",
    "{\"mcpServers\":{\"canvastty_browser\":{\"args\":[\"--socket\",\"/tmp/socket with spaces.sock\",\"--quote=\\\"yes\\\"\"],\"command\":\"/opt/CanvasTTY Agent/helper.mjs\",\"env\":{\"ELECTRON_RUN_AS_NODE\":\"1\"},\"type\":\"stdio\"}}}",
    "--allowedTools",
    "mcp__canvastty_browser__*"
  ]);
});

test("codexMcpArgs returns one complete table that replaces a same-name global server", () => {
  const prefix = `mcp_servers.${MCP_SERVER_NAME}`;
  const expected = [
    "-c",
    `${prefix}={command=${JSON.stringify(helper.command)},args=[${helper.args.map(JSON.stringify).join(",")}],env={\"ELECTRON_RUN_AS_NODE\"=\"1\"},env_vars=[\"CANVASTTY_AGENT_BROWSER_ADDRESS\",\"CANVASTTY_AGENT_ID\",\"CANVASTTY_AGENT_CONNECTION_ID\",\"CANVASTTY_TERMINAL_SESSION_ID\",\"CANVASTTY_AGENT_PROVIDER\",\"CANVASTTY_AGENT_CAPABILITY\"],enabled=true,required=true,default_tools_approval_mode=\"approve\",enabled_tools=[${APPROVED_BROWSER_TOOL_NAMES.map(JSON.stringify).join(",")}],disabled_tools=[]}`
  ];
  assert.deepEqual(codexMcpArgs(helper), expected);
});

test("OpenCode receives one per-launch MCP override without losing existing inline config", () => {
  const adapters = new ProviderLaunchAdapters({
    helper,
    providerClis,
    runtimeDirectory: "/tmp/canvastty-unused-runtime",
    hermesHomeDirectory: "/tmp/canvastty-unused-hermes",
    kimiHomeDirectory: "/tmp/canvastty-unused-kimi",
    environment: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: "opencode/kimi-k3",
        mcp: { existing: { type: "remote", url: "https://example.test/mcp" } },
        permission: "ask"
      })
    }
  });

  const launch = adapters.prepare("opencode", "connection-opencode");
  assert.deepEqual(launch.args, []);
  const config = JSON.parse(launch.environment.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.model, "opencode/kimi-k3");
  assert.deepEqual(config.mcp.existing, { type: "remote", url: "https://example.test/mcp" });
  assert.deepEqual(config.mcp[MCP_SERVER_NAME], {
    type: "local",
    command: [helper.command, ...helper.args],
    enabled: true,
    environment: helper.env
  });
  assert.deepEqual(config.permission, {
    "*": "ask",
    [`${MCP_SERVER_NAME}_*`]: "allow"
  });
  launch.releaseConfiguration();
});

test("OpenCode browser launch rejects malformed inline config instead of replacing it", () => {
  const adapters = new ProviderLaunchAdapters({
    helper,
    providerClis,
    runtimeDirectory: "/tmp/canvastty-unused-runtime",
    hermesHomeDirectory: "/tmp/canvastty-unused-hermes",
    kimiHomeDirectory: "/tmp/canvastty-unused-kimi",
    environment: { OPENCODE_CONFIG_CONTENT: "not-json" }
  });
  assert.throws(() => adapters.prepare("opencode", "connection-opencode"), /must contain valid JSON/u);
});

test("Hermes MCP entry passes capabilities through placeholders and exposes only browser tools", () => {
  const entry = hermesMcpEntry(helper);
  assert.equal(entry.command, helper.command);
  assert.deepEqual(entry.args, helper.args);
  assert.equal(entry.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(entry.env.CANVASTTY_AGENT_CAPABILITY, "${CANVASTTY_AGENT_CAPABILITY}");
  assert.equal(entry.env.CANVASTTY_AGENT_PROVIDER, "${CANVASTTY_AGENT_PROVIDER}");
  assert.equal(JSON.stringify(entry).includes("one-time-secret"), false);
  assert.deepEqual(entry.tools, {
    include: [...APPROVED_BROWSER_TOOL_NAMES],
    resources: false,
    prompts: false
  });
  assert.equal(entry.trust, "full");
});

test("HermesTemporaryConfiguration restores config.yaml byte for byte", async (t) => {
  const home = await fixture(t, "canvastty-hermes-exact-");
  const paths = hermesPaths(home);
  const original = Buffer.from("# preserve this comment\nmodel:\n  default: test/model\nmcp_servers:\n  existing:\n    url: https://example.test/mcp\n", "utf8");
  await writeFile(paths.config, original, { mode: 0o640 });
  const originalMode = (await stat(paths.config)).mode & 0o777;

  const temporary = HermesTemporaryConfiguration.begin({ homeDirectory: home, helper });
  const during = parseYaml(await readFile(paths.config, "utf8"));
  assert.equal(during.model.default, "test/model");
  assert.equal(during.mcp_servers.existing.url, "https://example.test/mcp");
  assert.deepEqual(during.mcp_servers[MCP_SERVER_NAME], hermesMcpEntry(helper));
  assert.equal((await stat(paths.config)).mode & 0o777, originalMode);

  temporary.cleanup();
  assert.deepEqual(await readFile(paths.config), original);
  assert.equal((await stat(paths.config)).mode & 0o777, originalMode);
  assert.equal(await exists(paths.journal), false);
  assert.equal(await exists(paths.backupRoot), false);
});

test("HermesTemporaryConfiguration removes config created only for the launch", async (t) => {
  const home = await fixture(t, "canvastty-hermes-absent-");
  const paths = hermesPaths(home);
  const temporary = HermesTemporaryConfiguration.begin({ homeDirectory: home, helper });

  assert.deepEqual(
    parseYaml(await readFile(paths.config, "utf8")).mcp_servers[MCP_SERVER_NAME],
    hermesMcpEntry(helper)
  );
  temporary.cleanup();

  assert.equal(await exists(paths.config), false);
  assert.equal(await exists(paths.journal), false);
  assert.equal(await exists(paths.backupRoot), false);
  assert.deepEqual(await readdir(home), []);
});

test("startup Hermes recovery restores an interrupted launch byte for byte", async (t) => {
  const home = await fixture(t, "canvastty-hermes-recovery-");
  const paths = hermesPaths(home);
  const original = Buffer.from("# exact config\nmodel:\n  default: test/model\n", "utf8");
  await writeFile(paths.config, original, { mode: 0o640 });

  HermesTemporaryConfiguration.begin({ homeDirectory: home, helper });
  assert.equal(await exists(paths.journal), true);
  assert.notDeepEqual(await readFile(paths.config), original);

  recoverHermesConfigurationOnStartup(home);
  assert.deepEqual(await readFile(paths.config), original);
  assert.equal(await exists(paths.journal), false);
  assert.equal(await exists(paths.backupRoot), false);
});

test("Hermes cleanup preserves a concurrent user edit while removing only its own MCP entry", async (t) => {
  const home = await fixture(t, "canvastty-hermes-concurrent-");
  const paths = hermesPaths(home);
  await writeFile(paths.config, "model: test/model\n", { mode: 0o600 });
  const temporary = HermesTemporaryConfiguration.begin({ homeDirectory: home, helper });
  const during = await readFile(paths.config, "utf8");
  await writeFile(paths.config, `${during}display:\n  compact: true\n`, { mode: 0o600 });

  temporary.cleanup();
  const restored = parseYaml(await readFile(paths.config, "utf8"));
  assert.equal(restored.model, "test/model");
  assert.equal(restored.display.compact, true);
  assert.equal("mcp_servers" in restored, false);
});

test("Hermes cleanup fails closed when its MCP entry changes ownership", async (t) => {
  const home = await fixture(t, "canvastty-hermes-ownership-");
  const paths = hermesPaths(home);
  await writeFile(paths.config, "model: test/model\n", { mode: 0o600 });
  const temporary = HermesTemporaryConfiguration.begin({ homeDirectory: home, helper });
  const changed = parseYaml(await readFile(paths.config, "utf8"));
  changed.mcp_servers[MCP_SERVER_NAME].command = "/other/owner";
  await writeFile(paths.config, `${JSON.stringify(changed)}\n`, { mode: 0o600 });

  assert.throws(
    () => temporary.cleanup(),
    /ownership changed before cleanup/u
  );
  assert.equal(await exists(paths.journal), true);
  assert.equal(await exists(paths.backupRoot), true);
  assert.equal(parseYaml(await readFile(paths.config, "utf8")).mcp_servers[MCP_SERVER_NAME].command, "/other/owner");
});

test("Hermes configuration rejects invalid YAML without replacing it", async (t) => {
  const home = await fixture(t, "canvastty-hermes-yaml-");
  const paths = hermesPaths(home);
  const original = "model: [unterminated\n";
  await writeFile(paths.config, original, { mode: 0o600 });

  assert.throws(
    () => HermesTemporaryConfiguration.begin({ homeDirectory: home, helper }),
    /YAML configuration is invalid/u
  );
  assert.equal(await readFile(paths.config, "utf8"), original);
  assert.equal(await exists(paths.journal), false);
  assert.equal(await exists(paths.backupRoot), false);
});

test("Hermes configuration refuses to replace an existing CanvasTTY server", async (t) => {
  const home = await fixture(t, "canvastty-hermes-conflict-");
  const paths = hermesPaths(home);
  const original = `mcp_servers:\n  ${MCP_SERVER_NAME}:\n    command: keep\n`;
  await writeFile(paths.config, original, { mode: 0o600 });
  assert.throws(
    () => HermesTemporaryConfiguration.begin({ homeDirectory: home, helper }),
    /already configured/u
  );
  assert.equal(await readFile(paths.config, "utf8"), original);
});

test("Hermes launch configuration is shared until the final session exits", async (t) => {
  const home = await fixture(t, "canvastty-hermes-shared-");
  const paths = hermesPaths(home);
  const original = "model: test/model\n";
  await writeFile(paths.config, original, { mode: 0o600 });
  const adapters = new ProviderLaunchAdapters({
    helper,
    providerClis,
    hermesHomeDirectory: home,
    kimiHomeDirectory: join(home, "kimi"),
    runtimeDirectory: join(home, "runtime")
  });

  const first = adapters.prepare("hermes", "hermes-1");
  const second = adapters.prepare("hermes", "hermes-2");
  first.releaseConfiguration();
  assert.ok(parseYaml(await readFile(paths.config, "utf8")).mcp_servers[MCP_SERVER_NAME]);
  second.releaseConfiguration();
  assert.equal(await readFile(paths.config, "utf8"), original);
});

test("HERMES_HOME selects the exact writable configuration directory", async (t) => {
  const root = await fixture(t, "canvastty-hermes-home-");
  const nested = join(root, "custom", "hermes");
  assert.equal(resolveHermesHomeDirectory({ HERMES_HOME: nested }), nested);
  assert.throws(
    () => resolveHermesHomeDirectory({ HERMES_HOME: "relative/hermes" }),
    /must be an absolute path/u
  );
  recoverHermesConfigurationOnStartup(nested);
});

test("KIMI_CODE_HOME selects the exact writable configuration directory", async (t) => {
  const root = await fixture(t, "canvastty-kimi-home-");
  const nested = join(root, "custom", "kimi");
  assert.equal(resolveKimiHomeDirectory({ KIMI_CODE_HOME: nested }), nested);
  assert.throws(
    () => resolveKimiHomeDirectory({ KIMI_CODE_HOME: "relative/kimi" }),
    /must be an absolute path/
  );
});

test("helper environment is validated before argv or filesystem artifacts are created", async (t) => {
  const root = await fixture(t, "canvastty-helper-env-");
  const cases = [
    { env: { PATH: "/untrusted" }, message: /not allowed: PATH/ },
    { env: { canvastty_agent_token: "leak" }, message: /reserved key: canvastty_agent_token/ },
    { env: { CANVASTTY_AGENT_SOCKET: "leak" }, message: /reserved key: CANVASTTY_AGENT_SOCKET/ },
    { env: { electron_run_as_node: "1" }, message: /not allowed: electron_run_as_node/ }
  ];

  for (const [index, entry] of cases.entries()) {
    const invalidHelper = { command: helper.command, args: helper.args, env: entry.env };
    assert.throws(() => claudeMcpArgs(invalidHelper), entry.message);
    assert.throws(() => codexMcpArgs(invalidHelper), entry.message);

    const home = join(root, `kimi-${index}`);
    const runtimeDirectory = join(root, `runtime-${index}`);
    assert.throws(() => new ProviderLaunchAdapters({
      helper: invalidHelper,
      providerClis,
      kimiHomeDirectory: home,
      hermesHomeDirectory: join(root, `hermes-adapter-${index}`),
      runtimeDirectory,
      probeKimiPerRunConfig: () => false
    }), entry.message);
    assert.throws(() => KimiTemporaryConfiguration.begin({
      homeDirectory: home,
      helper: invalidHelper,
      includeMcpEntry: true
    }), entry.message);
    assert.throws(() => HermesTemporaryConfiguration.begin({
      homeDirectory: join(root, `hermes-${index}`),
      helper: invalidHelper
    }), entry.message);
    assert.equal(await exists(home), false);
    assert.equal(await exists(join(root, `hermes-${index}`)), false);
    assert.equal(await exists(runtimeDirectory), false);
  }
});

test("KimiTemporaryConfiguration restores pre-existing files byte for byte", async (t) => {
  const home = await fixture(t, "canvastty-kimi-exact-");
  const paths = kimiPaths(home);
  const originalMcp = Buffer.from('{\n  "mcpServers" : { "existing" : {"command":"keep"} },\n  "other": [3, 2, 1]\n}\n', "utf8");
  const originalConfig = Buffer.from('# keep exact spacing\ntheme = "dark"', "utf8");
  await writeFile(paths.mcp, originalMcp, { mode: 0o640 });
  await writeFile(paths.config, originalConfig, { mode: 0o640 });
  const originalMcpMode = (await stat(paths.mcp)).mode & 0o777;
  const originalConfigMode = (await stat(paths.config)).mode & 0o777;

  const temporary = KimiTemporaryConfiguration.begin({
    homeDirectory: home,
    helper,
    includeMcpEntry: true
  });
  assert.notDeepEqual(await readFile(paths.mcp), originalMcp);
  assert.notDeepEqual(await readFile(paths.config), originalConfig);
  assert.equal(JSON.parse(await readFile(paths.mcp, "utf8")).mcpServers[MCP_SERVER_NAME].command, helper.command);
  assert.match(await readFile(paths.config, "utf8"), /mcp__canvastty_browser__\*/);
  assert.equal((await stat(paths.mcp)).mode & 0o777, originalMcpMode);
  assert.equal((await stat(paths.config)).mode & 0o777, originalConfigMode);

  temporary.cleanup();
  assert.deepEqual(await readFile(paths.mcp), originalMcp);
  assert.deepEqual(await readFile(paths.config), originalConfig);
  assert.equal((await stat(paths.mcp)).mode & 0o777, originalMcpMode);
  assert.equal((await stat(paths.config)).mode & 0o777, originalConfigMode);
  assert.equal(await exists(paths.journal), false);
  assert.equal(await exists(paths.backupRoot), false);
});

test("KimiTemporaryConfiguration removes files that were absent before launch", async (t) => {
  const home = await fixture(t, "canvastty-kimi-absent-");
  const paths = kimiPaths(home);
  const temporary = KimiTemporaryConfiguration.begin({
    homeDirectory: home,
    helper,
    includeMcpEntry: true
  });

  assert.equal(await exists(paths.mcp), true);
  assert.equal(await exists(paths.config), true);
  if (process.platform !== "win32") {
    assert.equal((await stat(paths.mcp)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.config)).mode & 0o777, 0o600);
  }
  temporary.cleanup();

  assert.equal(await exists(paths.mcp), false);
  assert.equal(await exists(paths.config), false);
  assert.equal(await exists(paths.journal), false);
  assert.equal(await exists(paths.backupRoot), false);
  assert.deepEqual(await readdir(home), []);
});

test("KimiTemporaryConfiguration preserves concurrent unrelated edits", async (t) => {
  const home = await fixture(t, "canvastty-kimi-concurrent-");
  const paths = kimiPaths(home);
  const originalConfig = 'theme = "dark"\n';
  await writeFile(paths.mcp, JSON.stringify({
    mcpServers: { existing: { command: "keep" } },
    setting: "original"
  }, null, 2));
  await writeFile(paths.config, originalConfig);

  const temporary = KimiTemporaryConfiguration.begin({
    homeDirectory: home,
    helper,
    includeMcpEntry: true
  });
  const concurrentlyEdited = JSON.parse(await readFile(paths.mcp, "utf8"));
  concurrentlyEdited.mcpServers.unrelated = { command: "added-concurrently" };
  concurrentlyEdited.concurrentTopLevel = { enabled: true };
  await writeFile(paths.mcp, `${JSON.stringify(concurrentlyEdited, null, 2)}\n`);
  await writeFile(paths.config, `${await readFile(paths.config, "utf8")}# concurrent setting\nother = true\n`);

  temporary.cleanup();
  const finalMcp = JSON.parse(await readFile(paths.mcp, "utf8"));
  assert.deepEqual(finalMcp.mcpServers.existing, { command: "keep" });
  assert.deepEqual(finalMcp.mcpServers.unrelated, { command: "added-concurrently" });
  assert.deepEqual(finalMcp.concurrentTopLevel, { enabled: true });
  assert.equal(MCP_SERVER_NAME in finalMcp.mcpServers, false);
  assert.equal(await readFile(paths.config, "utf8"), `${originalConfig}# concurrent setting\nother = true\n`);
});

test("startup Kimi recovery restores an interrupted journal through an injected home", async (t) => {
  const home = await fixture(t, "canvastty-kimi-recovery-");
  const paths = kimiPaths(home);
  const originalMcp = Buffer.from('{"mcpServers":{"keep":{"command":"original"}}}\n', "utf8");
  const originalConfig = Buffer.from('model = "kimi"\n# exact tail\n', "utf8");
  await writeFile(paths.mcp, originalMcp);
  await writeFile(paths.config, originalConfig);

  KimiTemporaryConfiguration.begin({
    homeDirectory: home,
    helper,
    includeMcpEntry: true
  });
  assert.equal(await exists(paths.journal), true);

  recoverKimiConfigurationOnStartup(home);
  assert.deepEqual(await readFile(paths.mcp), originalMcp);
  assert.deepEqual(await readFile(paths.config), originalConfig);
  assert.equal(await exists(paths.journal), false);
  assert.equal(await exists(paths.backupRoot), false);
});

test("Kimi cleanup fails closed on a missing end marker and retains recovery state", async (t) => {
  const home = await fixture(t, "canvastty-kimi-partial-marker-");
  const paths = kimiPaths(home);
  const originalMcp = '{"mcpServers":{"keep":{"command":"original"}}}\n';
  const originalConfig = 'model = "kimi"\n';
  await writeFile(paths.mcp, originalMcp);
  await writeFile(paths.config, originalConfig);

  const temporary = KimiTemporaryConfiguration.begin({
    homeDirectory: home,
    helper,
    includeMcpEntry: true
  });
  const mutatedConfig = await readFile(paths.config, "utf8");
  const ownershipId = mutatedConfig.match(/permission begin: ([0-9a-f-]{36})/)?.[1];
  assert.ok(ownershipId);
  const endMarker = `# CanvasTTY temporary browser permission end: ${ownershipId}`;
  const brokenConfig = mutatedConfig.replace(`${endMarker}\n`, "");
  await writeFile(paths.config, brokenConfig);

  assert.throws(
    () => temporary.cleanup(),
    /permission markers are incomplete or ambiguous/
  );
  assert.equal(await exists(paths.journal), true);
  assert.equal(await exists(paths.backupRoot), true);
  assert.equal(MCP_SERVER_NAME in JSON.parse(await readFile(paths.mcp, "utf8")).mcpServers, true);

  await writeFile(paths.config, `${brokenConfig}${endMarker}\n`);
  temporary.cleanup();
  assert.equal(await readFile(paths.mcp, "utf8"), originalMcp);
  assert.equal(await readFile(paths.config, "utf8"), originalConfig);
  assert.equal(await exists(paths.journal), false);
  assert.equal(await exists(paths.backupRoot), false);
});

test("Kimi cleanup fails closed on duplicate ownership markers", async (t) => {
  const home = await fixture(t, "canvastty-kimi-ambiguous-marker-");
  const paths = kimiPaths(home);
  const temporary = KimiTemporaryConfiguration.begin({
    homeDirectory: home,
    helper,
    includeMcpEntry: true
  });
  const mutatedConfig = await readFile(paths.config, "utf8");
  const beginMarker = mutatedConfig.match(/# CanvasTTY temporary browser permission begin: [0-9a-f-]{36}/)?.[0];
  assert.ok(beginMarker);
  await writeFile(paths.config, `${beginMarker}\n${mutatedConfig}`);

  assert.throws(
    () => temporary.cleanup(),
    /permission markers are incomplete or ambiguous/
  );
  assert.equal(await exists(paths.journal), true);
  assert.equal(await exists(paths.backupRoot), true);
  assert.equal(MCP_SERVER_NAME in JSON.parse(await readFile(paths.mcp, "utf8")).mcpServers, true);
});

test("Kimi crash recovery reclaims a strict lock from a dead real child", async (t) => {
  const home = await fixture(t, "canvastty-kimi-crashed-child-");
  const paths = kimiPaths(home);
  const originalMcp = '{"mcpServers":{"keep":{"command":"original"}}}\n';
  const originalConfig = 'model = "kimi"\n';
  await writeFile(paths.mcp, originalMcp);
  await writeFile(paths.config, originalConfig);

  const crashed = await crashWhileHoldingKimiLock(home);
  assert.equal(crashed.code, 73, crashed.stderr);
  const staleLock = JSON.parse(await readFile(paths.lock, "utf8"));
  assert.equal(staleLock.pid, crashed.pid);
  assert.match(staleLock.nonce, /^[0-9a-f]{32}$/u);
  assert.equal(await exists(paths.journal), true);

  recoverKimiConfigurationOnStartup(home);
  assert.equal(await readFile(paths.mcp, "utf8"), originalMcp);
  assert.equal(await readFile(paths.config, "utf8"), originalConfig);
  assert.equal(await exists(paths.lock), false);
  assert.equal(await exists(paths.journal), false);
  assert.equal(await exists(paths.backupRoot), false);
});

test("Kimi crash recovery retains a strict lock whose owner is live", async (t) => {
  const home = await fixture(t, "canvastty-kimi-live-lock-");
  const paths = kimiPaths(home);
  const lockContent = `${JSON.stringify({
    version: 1,
    pid: process.pid,
    createdAt: Date.now(),
    nonce: "a".repeat(32)
  })}\n`;
  await writeFile(paths.lock, lockContent, { flag: "wx", mode: 0o600 });

  assert.throws(
    () => KimiTemporaryConfiguration.recover(home),
    /Another CanvasTTY process is updating Kimi configuration/
  );
  assert.equal(await readFile(paths.lock, "utf8"), lockContent);
  assert.deepEqual(await readdir(home), [".canvastty-browser.lock"]);
});

test("Kimi crash recovery rejects invalid or foreign lock files", async (t) => {
  const home = await fixture(t, "canvastty-kimi-foreign-lock-");
  const paths = kimiPaths(home);
  const lockContent = `${JSON.stringify({
    version: 1,
    pid: process.pid,
    createdAt: Date.now(),
    nonce: "foreign-owner"
  })}\n`;
  await writeFile(paths.lock, lockContent, { flag: "wx", mode: 0o600 });

  assert.throws(
    () => KimiTemporaryConfiguration.recover(home),
    /lock is invalid or foreign/
  );
  assert.equal(await readFile(paths.lock, "utf8"), lockContent);
});

test("Kimi stale-lock reclaim retains a replacement created during verification", async (t) => {
  const home = await fixture(t, "canvastty-kimi-reclaim-race-");
  const paths = kimiPaths(home);
  const deadPid = await exitedChildPid();
  const staleLock = `${JSON.stringify({
    version: 1,
    pid: deadPid,
    createdAt: Date.now() - 1_000,
    nonce: "b".repeat(32)
  })}\n`;
  const replacement = `${JSON.stringify({
    version: 1,
    pid: process.pid,
    createdAt: Date.now(),
    nonce: "c".repeat(32)
  })}\n`;
  await writeFile(paths.lock, staleLock, { flag: "wx", mode: 0o600 });

  assert.throws(() => KimiTemporaryConfiguration.begin({
    homeDirectory: home,
    helper,
    includeMcpEntry: true,
    lockHooks: {
      beforeReclaim(path) {
        unlinkSync(path);
        writeFileSync(path, replacement, { flag: "wx", mode: 0o600 });
      }
    }
  }), /lock changed during stale recovery/);

  assert.equal(await readFile(paths.lock, "utf8"), replacement);
  assert.deepEqual(await readdir(home), [".canvastty-browser.lock"]);
});

test("Kimi lock release retains a lock when its nonce changes", async (t) => {
  const home = await fixture(t, "canvastty-kimi-lock-nonce-");
  const paths = kimiPaths(home);
  const foreignLock = `${JSON.stringify({
    version: 1,
    pid: process.pid,
    createdAt: Date.now(),
    nonce: "replacement-owner"
  })}\n`;

  assert.throws(() => KimiTemporaryConfiguration.begin({
    homeDirectory: home,
    helper,
    includeMcpEntry: true,
    lockHooks: {
      beforeRelease(path) {
        writeFileSync(path, foreignLock, "utf8");
      }
    }
  }), /lock ownership changed before release/);

  assert.equal(await readFile(paths.lock, "utf8"), foreignLock);
  assert.equal(await exists(paths.journal), true);
  assert.equal(await exists(paths.backupRoot), true);
});

test("ProviderLaunchAdapters uses only injected temp Kimi paths and reference-counts cleanup", async (t) => {
  const root = await fixture(t, "canvastty-provider-kimi-");
  const home = join(root, "kimi-home");
  const runtimeDirectory = join(root, "runtime");
  const probed = [];
  const adapters = new ProviderLaunchAdapters({
    helper,
    providerClis,
    kimiHomeDirectory: home,
    hermesHomeDirectory: join(root, "hermes-home"),
    runtimeDirectory,
    probeKimiPerRunConfig: (cli) => {
      probed.push(cli.executable);
      return true;
    }
  });

  const first = adapters.prepare("kimi", "connection/one");
  const second = adapters.prepare("kimi", "connection-two");
  assert.deepEqual(probed, ["/resolved/kimi"]);
  assert.equal(first.args[0], "--mcp-config-file");
  assert.equal(second.args[0], "--mcp-config-file");
  assert.equal(first.args[1].startsWith(runtimeDirectory), true);
  assert.equal(first.args[1].includes("connection_one"), true);
  assert.equal(JSON.parse(await readFile(first.args[1], "utf8")).mcpServers[MCP_SERVER_NAME].command, helper.command);
  assert.equal(await exists(join(home, "mcp.json")), false);
  assert.equal(await exists(join(home, "config.toml")), true);

  first.releaseConfiguration();
  assert.equal(await exists(first.args[1]), false);
  assert.equal(await exists(join(home, "config.toml")), true);
  second.releaseConfiguration();
  assert.equal(await exists(second.args[1]), false);
  assert.equal(await exists(join(home, "config.toml")), false);
});

test("ProviderLaunchAdapters fallback adds and removes only temporary Kimi state", async (t) => {
  const root = await fixture(t, "canvastty-provider-kimi-fallback-");
  const home = join(root, "kimi-home");
  const adapters = new ProviderLaunchAdapters({
    helper,
    providerClis,
    kimiHomeDirectory: home,
    hermesHomeDirectory: join(root, "hermes-home"),
    runtimeDirectory: join(root, "runtime"),
    probeKimiPerRunConfig: () => false
  });

  const launch = adapters.prepare("kimi", "fallback");
  assert.deepEqual(launch.args, []);
  assert.equal(JSON.parse(await readFile(join(home, "mcp.json"), "utf8")).mcpServers[MCP_SERVER_NAME].command, helper.command);
  assert.match(await readFile(join(home, "config.toml"), "utf8"), /mcp__canvastty_browser__\*/);
  launch.releaseConfiguration();
  assert.equal(await exists(join(home, "mcp.json")), false);
  assert.equal(await exists(join(home, "config.toml")), false);
});
