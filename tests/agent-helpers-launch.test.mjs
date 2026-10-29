/**
 * Which helper program CanvasTTY hands to agents: the native canvastty-helper where it is built for this platform,
 * the .mjs helpers under Electron-as-Node otherwise (and whenever CANVASTTY_HELPERS=node). The hook commands the launch
 * writes with the native helper must run as the CLI runs them (`/bin/sh -c`), also inside the macOS isolation layer,
 * and CanvasTTY must still recognize them as its own when it recovers a provider's hook file. No agent CLI runs.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { AGENT_HELPERS_ENV, agentHelperLaunches, isOwnLifecycleHookText, nativeHelperPath } from "../src/main/services/agentHelpers.ts";
import { ProviderRuntimeLaunchAdapters } from "../src/main/services/agent-runtime/ProviderRuntimeLaunch.ts";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import { AgentIsolation } from "../src/main/services/isolation/AgentIsolation.ts";
import { DECISION_FAIL_CLOSED_ENV } from "../src/agent-runtime/runtime-protocol.mjs";
import { NATIVE, SKIP_NATIVE } from "./native-helper-harness.mjs";

// macOS locations (POSIX paths) unless a test describes another platform.
const location = (overrides = {}) => ({
  packaged: false, resourcesPath: "/app/Resources", appPath: "/src/canvastty", execPath: "/app/CanvasTTY",
  platform: "darwin", arch: "arm64", environment: {}, isExecutable: () => true, ...overrides
});

test("the native helper is chosen on macOS and Linux when built; Windows, a missing binary and CANVASTTY_HELPERS=node keep the .mjs helpers", () => {
  assert.equal(nativeHelperPath(location()), "/src/canvastty/build/native-helpers/mac-arm64/canvastty-helper");
  assert.equal(nativeHelperPath(location({ platform: "linux", arch: "x64", packaged: true })), "/app/Resources/helpers/canvastty-helper");
  assert.equal(nativeHelperPath(location({ platform: "win32", arch: "x64" })), null);
  // A Windows location has Windows paths; the helper path follows the rules of the platform it describes, whatever
  // the host running this test is.
  assert.equal(nativeHelperPath(location({ platform: "win32", arch: "x64", packaged: true, resourcesPath: "C:\\CanvasTTY\\resources",
    environment: { [AGENT_HELPERS_ENV]: "native" } })), "C:\\CanvasTTY\\resources\\helpers\\canvastty-helper.exe");
  assert.deepEqual(agentHelperLaunches(location({ platform: "win32", packaged: true, resourcesPath: "C:\\CanvasTTY\\resources", execPath: "C:\\CanvasTTY\\CanvasTTY.exe" })).hook,
    { command: "C:\\CanvasTTY\\CanvasTTY.exe", args: ["C:\\CanvasTTY\\resources\\agent-runtime\\hook-helper.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } });
  assert.equal(nativeHelperPath(location({ environment: { [AGENT_HELPERS_ENV]: "node" } })), null);
  assert.equal(nativeHelperPath(location({ isExecutable: () => false })), null);
  assert.equal(nativeHelperPath(location({ platform: "freebsd" })), null);

  const native = agentHelperLaunches(location({ packaged: true }));
  assert.deepEqual(native, {
    native: true,
    browser: { command: "/app/Resources/helpers/canvastty-helper", args: ["mcp-browser"] },
    orchestration: { command: "/app/Resources/helpers/canvastty-helper", args: ["mcp-orchestration"] },
    hook: { command: "/app/Resources/helpers/canvastty-helper", args: ["hook"] },
    permissionGate: { command: "/app/Resources/helpers/canvastty-helper", args: ["permission-gate"] },
    shellCodex: { command: "/app/CanvasTTY", args: ["/app/Resources/agent-runtime/shell-codex.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } }
  });
  const node = agentHelperLaunches(location({ packaged: true, environment: { [AGENT_HELPERS_ENV]: "node" } }));
  assert.deepEqual(node.browser, { command: "/app/CanvasTTY", args: ["/app/Resources/agent-browser/mcp-helper.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } });
  assert.deepEqual(node.permissionGate.args, ["/app/Resources/agent-runtime/permission-gate.mjs"]);
  assert.deepEqual(agentHelperLaunches(location({ isExecutable: () => false })).hook.args, ["/src/canvastty/src/agent-runtime/hook-helper.mjs"]);
});

test("CanvasTTY recognizes its own lifecycle hook commands in either form", () => {
  assert.equal(isOwnLifecycleHookText("'/app/CanvasTTY' '/r/agent-runtime/hook-helper.mjs' 'idle' 'Stop'"), true);
  assert.equal(isOwnLifecycleHookText("'/r/helpers/canvastty-helper' 'hook' 'idle' 'Stop'"), true);
  assert.equal(isOwnLifecycleHookText('"C:\\\\R\\\\helpers\\\\canvastty-helper.exe\\" \\"hook\\" \\"idle\\"'), true);
  assert.equal(isOwnLifecycleHookText("'/r/helpers/canvastty-helper' 'permission-gate' 'pretool'"), false);
  assert.equal(isOwnLifecycleHookText("my-own-hook.sh"), false);
});

test("the launch writes native hook commands (the gate fails closed), and they run through /bin/sh against the real gateway", {
  skip: process.platform === "win32" ? "This launch integration invokes POSIX /bin/sh and uses POSIX hook command quoting." : SKIP_NATIVE
}, async (t) => {
  const base = await realpath(await mkdtemp("/tmp/ctty-nh-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const hook = { command: NATIVE, args: ["hook"] };
  const permissionGate = { command: NATIVE, args: ["permission-gate"] };
  const adapters = new ProviderRuntimeLaunchAdapters({
    helper: hook, permissionGate, runtimeDirectory: join(base, "r"), openCodePluginPath: "/opt/CanvasTTY/opencode-plugin.mjs",
    kimiHomeDirectory: join(base, "kimi"), hermesHomeDirectory: join(base, "hermes"), grokHomeDirectory: join(base, "grok")
  });
  const settings = JSON.parse(adapters.prepare("claude", "t1", true, true).args[1]);
  const gateCommand = settings.hooks.PreToolUse[0].hooks[0].command;
  assert.equal(gateCommand, `${DECISION_FAIL_CLOSED_ENV}='1' '${NATIVE}' 'permission-gate' 'pretool'`);
  const stopCommand = settings.hooks.Stop[0].hooks[0].command;
  assert.equal(stopCommand, `'${NATIVE}' 'hook' 'idle' 'Stop'`);
  assert.equal(isOwnLifecycleHookText(stopCommand), true);

  const runtime = join(base, "u", "lifecycle", "runtime");
  const signals = [];
  const gateway = new RuntimeGateway({
    runtimeDirectory: runtime,
    onSignal: (_id, signal) => signals.push(signal.event),
    onPermissionRequest: async (_id, request) => ({ behavior: "deny", message: `gate saw ${request.toolInput.command}` })
  });
  await gateway.start();
  t.after(() => gateway.close());
  const session = gateway.registerSession("s1", "claude", false, undefined, true);
  const environment = {
    PATH: "/usr/bin:/bin", HOME: base,
    CANVASTTY_RUNTIME_ADDRESS: session.address,
    CANVASTTY_RUNTIME_TERMINAL_SESSION_ID: session.terminalSessionId,
    CANVASTTY_RUNTIME_PROVIDER: "claude",
    CANVASTTY_RUNTIME_CAPABILITY: session.capabilityToken
  };
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, cwd: base });
  // Asynchronous: the gateway answers from this process's event loop.
  const execute = (command, args, options) => new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
  const run = (command) => execute("/bin/sh", ["-c", command], { env: environment });
  const denied = await run(gateCommand);
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, "gate saw ls");
  assert.equal((await run(stopCommand)).stdout, "");
  assert.deepEqual(signals, ["Stop"]);

  // Inside the macOS isolation layer the binary runs and reaches the gateway's socket, as the .mjs helper did.
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    const project = join(base, "p");
    await mkdir(project);
    const userData = join(base, "u");
    await writeFile(join(base, "secret"), "x");
    const isolation = new AgentIsolation({ userDataPath: userData, enabled: () => true, tempRoot: join(base, "t") });
    await mkdir(join(base, "t"), { recursive: true });
    const wrapped = isolation.wrap({ sessionId: "s1", provider: "claude", cwd: project, command: "/bin/sh", args: ["-c", gateCommand], env: environment });
    try {
      const result = await execute(wrapped.command, wrapped.args, { cwd: project, env: wrapped.env });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, "gate saw ls");
    } finally {
      wrapped.cleanup();
    }
  }
});

test("Grok's hook file written with the native helper is recovered as CanvasTTY's own", { skip: SKIP_NATIVE }, async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ctty-nh-grok-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const options = {
    helper: { command: NATIVE, args: ["hook"] }, runtimeDirectory: join(base, "r"), openCodePluginPath: "/opt/CanvasTTY/opencode-plugin.mjs",
    kimiHomeDirectory: join(base, "kimi"), hermesHomeDirectory: join(base, "hermes"), grokHomeDirectory: join(base, "grok")
  };
  new ProviderRuntimeLaunchAdapters(options).prepare("grok", "g1", true, false);
  const path = join(base, "grok", "hooks", "canvastty-runtime-hooks.json");
  assert.match(await readFile(path, "utf8"), /canvastty-helper(?:\.exe)?/u);
  // A crash left the file behind: the next start removes it instead of refusing it as someone else's.
  new ProviderRuntimeLaunchAdapters(options).recoverConfigurations();
  assert.equal(existsSync(path), false);
});
