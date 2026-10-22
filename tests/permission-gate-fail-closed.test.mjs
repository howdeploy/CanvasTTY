/**
 * The decision hook fails closed. A session launched with the decision hook (base protection on, or a decision plugin
 * applies) must not run a shell or file-writing call CanvasTTY could not check: every way the check can fail (no
 * socket, refused, no answer in time, an unreadable answer, the gateway's own failure) is a deny with one message for
 * the model. A gate started without the launch's fail-closed flag keeps the old behavior: nothing printed, the CLI goes
 * on. The real gate runs as a process; the sockets are fakes or the real gateway. No agent CLI runs here.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENT_RUNTIME_ENV, DECISION_FAIL_CLOSED_ENV, OPENCODE_DECISIONS_ENV, OPENCODE_DECISION_READS_ENV, RUNTIME_PROTOCOL_VERSION, permissionGateTimings
} from "../src/agent-runtime/runtime-protocol.mjs";
import { FAIL_CLOSED_MESSAGE, parseDecision } from "../src/agent-runtime/permission-gate.mjs";
import { createOpenCodeDecisions } from "../src/agent-runtime/opencode-decisions.mjs";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import { ProviderRuntimeLaunchAdapters } from "../src/main/services/agent-runtime/ProviderRuntimeLaunch.ts";
import { AgentRuntimeBridge } from "../src/main/services/agent-runtime/AgentRuntimeBridge.ts";
import { DecisionHooks } from "../src/main/services/DecisionHooks.ts";

const POSIX = { skip: process.platform === "win32" ? "Unix sockets." : false };
const GATE = fileURLToPath(new URL("../src/agent-runtime/permission-gate.mjs", import.meta.url));
const PROVIDERS = ["claude", "codex", "qwen"];
const root = await mkdtemp(join(tmpdir(), "canvastty-fail-closed-"));
process.on("exit", () => { void rm(root, { recursive: true, force: true }); });
let serial = 0;
const socketPath = () => join(root, `s${serial++}.sock`);

/** The tool call each CLI sends for `sudo rm -rf /`, in its own shape. */
function hookInput(provider) {
  if (provider === "qwen") return { hook_event_name: "PreToolUse", tool_name: "run_shell_command", tool_input: { command: "sudo rm -rf /" }, cwd: root };
  return { hook_event_name: "PreToolUse", session_id: "x", tool_name: "Bash", tool_input: { command: "sudo rm -rf /" }, cwd: root };
}

function runGate({ address, provider, failClosed, input = JSON.stringify(hookInput(provider)), identity = true, token = "c".repeat(43), sessionId = "t" }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [GATE, "pretool"], {
      env: {
        PATH: process.env.PATH, HOME: root,
        ...(failClosed ? { [DECISION_FAIL_CLOSED_ENV]: "1" } : {}),
        ...(identity ? {
          [AGENT_RUNTIME_ENV.address]: address,
          [AGENT_RUNTIME_ENV.terminalSessionId]: sessionId,
          [AGENT_RUNTIME_ENV.provider]: provider,
          [AGENT_RUNTIME_ENV.capabilityToken]: token
        } : {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (code) => resolve({ code, output: stdout.trim() ? JSON.parse(stdout) : null, ms: Date.now() - started }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/** A socket that reads the request line and then does `behave(socket, request)`. */
async function fakeGateway(behave) {
  const path = socketPath();
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) behave(socket, JSON.parse(buffer.slice(0, newline)));
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));
  return { path, close: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }) };
}

/** A Unix socket file whose listener is gone: connecting to it is refused. */
async function staleSocket() {
  const path = socketPath();
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(path)}, () => process.stdout.write("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  return path;
}

function assertDenied(result, label) {
  assert.equal(result.code, 0, label);
  assert.deepEqual(result.output, {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: FAIL_CLOSED_MESSAGE }
  }, label);
}

function assertUnchanged(result, label) {
  assert.deepEqual({ code: result.code, output: result.output }, { code: 0, output: null }, label);
}

const reply = (request, extra) => `${JSON.stringify({ v: RUNTIME_PROTOCOL_VERSION, type: "permission_decision", requestId: request.requestId, ...extra })}\n`;

const MALFORMED = {
  "not JSON": () => "garbage\n",
  "another request's answer": () => reply({ requestId: "someone-else" }, { behavior: "allow" }),
  "an unknown behavior": (request) => reply(request, { behavior: "maybe" }),
  "a wrong protocol version": (request) => `${JSON.stringify({ v: 99, type: "permission_decision", requestId: request.requestId, behavior: "allow" })}\n`,
  "closed without an answer": null,
  "over the size bound without a newline": () => "x".repeat(70 * 1024)
};

test("fail closed: no socket and a refused socket deny for Claude, Codex and Qwen; without the flag nothing changes", POSIX, async () => {
  const stale = await staleSocket();
  for (const [mode, address] of [["socket missing", join(root, "missing.sock")], ["connection refused", stale]]) {
    for (const provider of PROVIDERS) {
      assertDenied(await runGate({ address, provider, failClosed: true }), `${mode} / ${provider} / on`);
      assertUnchanged(await runGate({ address, provider, failClosed: false }), `${mode} / ${provider} / off`);
    }
  }
});

test("fail closed: an unreadable or missing answer denies; without the flag nothing changes", POSIX, async (t) => {
  for (const [mode, answer] of Object.entries(MALFORMED)) {
    const gateway = await fakeGateway((socket, request) => {
      if (answer === null) return socket.destroy();
      socket.write(answer(request));
    });
    t.after(gateway.close);
    for (const provider of PROVIDERS) {
      assertDenied(await runGate({ address: gateway.path, provider, failClosed: true }), `${mode} / ${provider} / on`);
      assertUnchanged(await runGate({ address: gateway.path, provider, failClosed: false }), `${mode} / ${provider} / off`);
    }
  }
});

test("fail closed: a gateway that never answers is a deny once the helper's deadline passes, well inside the hook timeout", { ...POSIX, timeout: 60_000 }, async (t) => {
  const gateway = await fakeGateway(() => undefined);
  t.after(gateway.close);
  const { helperMs, hookSeconds } = permissionGateTimings();
  const runs = PROVIDERS.flatMap((provider) => [true, false].map(async (failClosed) => ({
    provider, failClosed, result: await runGate({ address: gateway.path, provider, failClosed })
  })));
  for (const { provider, failClosed, result } of await Promise.all(runs)) {
    const label = `timeout / ${provider} / ${failClosed ? "on" : "off"}`;
    if (failClosed) assertDenied(result, label); else assertUnchanged(result, label);
    assert.ok(result.ms >= helperMs - 50, `${label}: waited the helper deadline`);
    assert.ok(result.ms < hookSeconds * 1_000 - 1_000, `${label}: answered before the CLI's own hook timeout`);
  }
});

test("fail closed: the gateway's own failure (handler error, late answer, unknown session) denies where the CLI cannot ask", { ...POSIX, timeout: 60_000 }, async (t) => {
  const runtime = await mkdtemp(join(tmpdir(), "canvastty-fail-closed-gw-"));
  let handler = async () => { throw new Error("broken"); };
  const gateway = new RuntimeGateway({ runtimeDirectory: runtime, onPermissionRequest: (...args) => handler(...args) });
  await gateway.start();
  t.after(async () => { await gateway.close(); await rm(runtime, { recursive: true, force: true }); });
  const sessions = Object.fromEntries(PROVIDERS.map((provider) => [provider, gateway.registerSession(`gw-${provider}`, provider, false, undefined, true)]));
  const call = (provider, failClosed) => runGate({
    address: sessions[provider].address, provider, failClosed, sessionId: sessions[provider].terminalSessionId, token: sessions[provider].capabilityToken
  });
  const failures = {
    "handler throws": async () => { throw new Error("broken"); },
    "handler rejects late": () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 50)),
    "handler answers nonsense": async () => ({ behavior: "sure" }),
    "handler never answers": () => new Promise(() => undefined)
  };
  for (const [mode, failing] of Object.entries(failures)) {
    handler = failing;
    const runs = await Promise.all(PROVIDERS.flatMap((provider) => [true, false].map(async (failClosed) => ({ provider, failClosed, result: await call(provider, failClosed) }))));
    for (const { provider, failClosed, result } of runs) {
      const label = `${mode} / ${provider} / ${failClosed ? "on" : "off"}`;
      // Claude Code can ask the person, and does, with or without the flag.
      if (provider === "claude") assert.equal(result.output?.hookSpecificOutput.permissionDecision, "ask", label);
      else if (failClosed) assertDenied(result, label);
      else assertUnchanged(result, label);
    }
  }
  // A capability the gateway does not know (revoked, or from another run): the socket closes without an answer.
  for (const provider of PROVIDERS) {
    const stranger = { address: sessions[provider].address, provider, sessionId: `gw-${provider}`, token: "x".repeat(43) };
    assertDenied(await runGate({ ...stranger, failClosed: true }), `unknown capability / ${provider} / on`);
    assertUnchanged(await runGate({ ...stranger, failClosed: false }), `unknown capability / ${provider} / off`);
  }
});

test("fail closed: a call the gate cannot even read or send is not run", POSIX, async () => {
  const address = join(root, "missing.sock");
  for (const provider of PROVIDERS) {
    const cases = {
      "input over the bound": { input: JSON.stringify({ ...hookInput(provider), tool_input: { command: "x".repeat(600 * 1024) } }) },
      "input that is not JSON": { input: "{nope" },
      "no tool name": { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_input: {} }) },
      "no runtime identity": { identity: false }
    };
    for (const [mode, extra] of Object.entries(cases)) {
      assertDenied(await runGate({ address, provider, failClosed: true, ...extra }), `${mode} / ${provider} / on`);
      assertUnchanged(await runGate({ address, provider, failClosed: false, ...extra }), `${mode} / ${provider} / off`);
    }
  }
});

test("fail closed: normal answers are unchanged, and no verdict still prints nothing", { ...POSIX, timeout: 60_000 }, async (t) => {
  const runtime = await mkdtemp(join(tmpdir(), "canvastty-fail-closed-ok-"));
  let protect = true;
  const decisions = new DecisionHooks({
    baseProtection: () => protect,
    services: () => [],
    call: async () => null,
    session: () => ({ provider: "claude", role: "agent", cwd: root, configDirs: [] }),
    home: root
  });
  const gateway = new RuntimeGateway({ runtimeDirectory: runtime, onPermissionRequest: (id, request, signal) => decisions.decide(id, request, signal) });
  await gateway.start();
  t.after(async () => { await gateway.close(); await rm(runtime, { recursive: true, force: true }); });
  for (const provider of PROVIDERS) {
    const session = gateway.registerSession(`ok-${provider}`, provider, false, undefined, true);
    const call = (command) => runGate({
      address: session.address, provider, failClosed: true, sessionId: session.terminalSessionId, token: session.capabilityToken,
      input: JSON.stringify({ ...hookInput(provider), tool_input: { command } })
    });
    protect = true;
    assertUnchanged(await call("ls"), `ordinary command / ${provider}`);
    const denied = await call("sudo ls");
    assert.equal(denied.output.hookSpecificOutput.permissionDecision, "deny", `base protection / ${provider}`);
    assert.notEqual(denied.output.hookSpecificOutput.permissionDecisionReason, FAIL_CLOSED_MESSAGE, "base protection keeps its own reason");
    // The person turned base protection off while the card runs: CanvasTTY answers "no verdict", and the call runs.
    protect = false;
    assertUnchanged(await call("sudo ls"), `protection off mid-session / ${provider}`);
  }
  assert.deepEqual(parseDecision({ v: RUNTIME_PROTOCOL_VERSION, type: "permission_decision", requestId: "r", behavior: "none" }, "r"), { behavior: "none", message: "", unavailable: false });
});

test("launch: the decision hook carries the fail-closed flag; a launch without it has no hook at all", async (t) => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "canvastty-fail-closed-launch-"));
  t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const helper = { command: "/opt/CanvasTTY", args: ["/opt/CanvasTTY/hook-helper.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } };
  const permissionGate = { command: "/opt/CanvasTTY", args: ["/opt/CanvasTTY/permission-gate.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } };
  const options = { platform: "darwin", helper, runtimeDirectory, openCodePluginPath: "/opt/CanvasTTY/opencode-plugin.mjs", permissionGate,
    kimiHomeDirectory: join(runtimeDirectory, "kimi"), hermesHomeDirectory: join(runtimeDirectory, "hermes"), grokHomeDirectory: join(runtimeDirectory, "grok") };
  const adapters = new ProviderRuntimeLaunchAdapters(options);
  const flag = new RegExp(`${DECISION_FAIL_CLOSED_ENV}='1' .*permission-gate\\.mjs' 'pretool'$`, "u");
  const claude = JSON.parse(adapters.prepare("claude", "t1", false, true).args[1]);
  assert.match(claude.hooks.PreToolUse[0].hooks[0].command, flag);
  assert.match(adapters.prepare("codex", "t2", false, true).args.join(" "), new RegExp(`${DECISION_FAIL_CLOSED_ENV}='1'`, "u"));
  const qwen = adapters.prepare("qwen", "t3", false, true);
  assert.match(JSON.parse(await readFile(qwen.environment.QWEN_CODE_SYSTEM_SETTINGS_PATH, "utf8")).hooks.PreToolUse[0].hooks[0].command, flag);
  qwen.releaseConfiguration();
  const windows = new ProviderRuntimeLaunchAdapters({ ...options, platform: "win32", qwenSystemSettingsPath: join(runtimeDirectory, "qwen.json") });
  assert.match(JSON.parse(windows.prepare("claude", "t4", false, true).args[1]).hooks.PreToolUse[0].hooks[0].command, new RegExp(`set "${DECISION_FAIL_CLOSED_ENV}=1"`, "u"));
  // Base protection off and no decision plugin: the launch has no decision hook, so nothing can fail closed.
  const gateway = {
    registerSession: (...args) => ({ address: "/tmp/x.sock", terminalSessionId: args[0], provider: args[1], capabilityToken: "c".repeat(40) }),
    revokeTerminalSession: () => undefined,
    currentStatus: () => null
  };
  const off = new DecisionHooks({ baseProtection: () => false, services: () => [], call: async () => null, session: () => null });
  const bridge = new AgentRuntimeBridge(gateway, { ...options, coreHooksEnabled: true, wantsDecisions: (provider) => off.wanted(provider) });
  const launch = bridge.prepareLaunch({ terminalSessionId: "a", provider: "claude", cwd: root });
  assert.equal(launch.decisions, false);
  assert.equal(JSON.stringify(launch.args).includes(DECISION_FAIL_CLOSED_ENV), false);
  assert.equal(JSON.stringify(launch.args).includes("permission-gate"), false);
  // Base protection off, a decision plugin applies: the fail-closed hook covers shells and writes, never reads.
  const pluginOnly = new DecisionHooks({ baseProtection: () => false, services: () => [{ pluginId: "p", pluginName: "P", serviceId: "s", mayAllow: false }],
    call: async () => null, session: () => null });
  const pluginBridge = new AgentRuntimeBridge(gateway, { ...options, coreHooksEnabled: true, wantsDecisions: (provider) => pluginOnly.wanted(provider),
    decisionReads: () => pluginOnly.checksReads() });
  const pluginLaunch = pluginBridge.prepareLaunch({ terminalSessionId: "b", provider: "claude", cwd: root });
  assert.equal(pluginLaunch.decisions, true);
  assert.equal(JSON.parse(pluginLaunch.args[1]).hooks.PreToolUse[0].matcher, "Bash|Write|Edit|MultiEdit|NotebookEdit");
  const on = new DecisionHooks({ baseProtection: () => true, services: () => [], call: async () => null, session: () => null });
  assert.equal(on.checksReads(), true);
  assert.equal(new DecisionHooks({ baseProtection: () => { throw new Error("settings"); }, services: () => [], call: async () => null, session: () => null }).checksReads(), true,
    "a settings read that fails counts as on");
});

test("OpenCode: with decisions on, a check that cannot be made fails the tool call; ordinary answers are unchanged", async () => {
  const env = {
    [OPENCODE_DECISIONS_ENV]: "1", [AGENT_RUNTIME_ENV.address]: "/tmp/x.sock", [AGENT_RUNTIME_ENV.terminalSessionId]: "t",
    [AGENT_RUNTIME_ENV.provider]: "opencode", [AGENT_RUNTIME_ENV.capabilityToken]: "c".repeat(40)
  };
  const call = [{ tool: "bash", callID: "c1" }, { args: { command: "sudo rm -rf /" } }];
  const failing = {
    "no answer": async () => null,
    "send throws": async () => { throw new Error("ECONNREFUSED"); },
    "the gateway failed": async () => ({ behavior: "ask", message: "", unavailable: true })
  };
  for (const [mode, send] of Object.entries(failing)) {
    await assert.rejects(createOpenCodeDecisions({ env, send }).guard(...call), (error) => error.message === FAIL_CLOSED_MESSAGE, mode);
  }
  for (const behavior of ["none", "ask", "allow"]) {
    await createOpenCodeDecisions({ env, send: async () => ({ behavior, message: "", unavailable: false }) }).guard(...call);
  }
  // Tools that are not checked are never sent and never fail.
  await createOpenCodeDecisions({ env, send: async () => null }).guard({ tool: "webfetch", callID: "c2" }, { args: { url: "https://example.com" } });
  // Base protection off at launch: a read-only file tool is not checked, so it never fails closed.
  await createOpenCodeDecisions({ env, send: async () => null }).guard({ tool: "read", callID: "c3" }, { args: { filePath: "/etc/hosts" } });
  // Base protection on at launch: it is checked (for CanvasTTY's private data), so it fails closed like the others.
  await assert.rejects(createOpenCodeDecisions({ env: { ...env, [OPENCODE_DECISION_READS_ENV]: "1" }, send: async () => null })
    .guard({ tool: "read", callID: "c4" }, { args: { filePath: "/etc/hosts" } }), (error) => error.message === FAIL_CLOSED_MESSAGE);
});

test("the gate script stays importable without side effects (no socket, no stdin read)", async () => {
  const probe = join(root, "import-probe.mjs");
  await writeFile(probe, `import(${JSON.stringify(new URL("../src/agent-runtime/permission-gate.mjs", import.meta.url).href)}).then(() => process.stdout.write("ok"));`);
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [probe, "pretool"], { stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, HOME: root, [DECISION_FAIL_CLOSED_ENV]: "1" } });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.on("close", () => resolve(text));
  });
  assert.equal(out, "ok");
});
