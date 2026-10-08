/**
 * Decision hooks (EP-5): base protection first, then plugin decision services; any deny wins, a timeout or error
 * asks the person, an allow counts only after the separate confirmation. The real permission gate runs against the
 * real runtime gateway; no agent CLI runs. HOME is whatever the test runner's fake HOME is.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AGENT_RUNTIME_ENV, OPENCODE_DECISIONS_ENV, RUNTIME_PROTOCOL_VERSION } from "../src/agent-runtime/runtime-protocol.mjs";
import { buildRequest, hookOutput, parseDecision } from "../src/agent-runtime/permission-gate.mjs";
import { createOpenCodeDecisions, guardedCall } from "../src/agent-runtime/opencode-decisions.mjs";
import { DecisionHooks, TOO_LARGE_MESSAGE, mergeDecisions } from "../src/main/services/DecisionHooks.ts";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import { AgentRuntimeBridge } from "../src/main/services/agent-runtime/AgentRuntimeBridge.ts";
import { ProviderRuntimeLaunchAdapters } from "../src/main/services/agent-runtime/ProviderRuntimeLaunch.ts";
import { PluginManager, validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";

const POSIX = { skip: process.platform === "win32" ? "Unix sockets and POSIX paths." : false };
const GATE = fileURLToPath(new URL("../src/agent-runtime/permission-gate.mjs", import.meta.url));
const example = new URL("../examples/plugins/deny-rm/", import.meta.url);
const exampleManifest = JSON.parse(await readFile(new URL("canvastty.plugin.json", example), "utf8"));
const sha = (value) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-decisions-")));
const home = join(root, "home");
const project = join(root, "project");
await mkdir(join(home, "Downloads"), { recursive: true });
await mkdir(join(project, "build"), { recursive: true });
process.on("exit", () => { void rm(root, { recursive: true, force: true }); });

const service = (pluginId, extra = {}) => ({ pluginId, pluginName: pluginId, serviceId: "guard", mayAllow: false, ...extra });
const answer = (verdict, extra = {}) => ({ verdict, reason: "", service: service("p"), ...extra });
const request = (toolName, toolInput, extra = {}) => ({
  requestId: "req-00000001", provider: "claude", toolName, toolInput, toolInputPreview: null,
  toolInputSha256: sha(toolInput), truncated: false, cwd: null, ...extra
});
const live = () => new AbortController().signal;

function hooks({ protect = true, services = [], answers = {}, calls = [], timeoutMs = 200, provider = "claude",
  humanApprovalEnabled, resolveHumanAsk } = {}) {
  return new DecisionHooks({
    baseProtection: () => protect,
    services: () => services,
    call: async (pluginId, serviceId, method, params) => {
      calls.push({ pluginId, method, params });
      const reply = answers[pluginId];
      return typeof reply === "function" ? reply(params) : reply;
    },
    humanApprovalEnabled,
    resolveHumanAsk,
    session: (id) => id === "s1" ? { provider, role: "agent", cwd: project, configDirs: [], profile: "auto" }
      : id === "codex" ? { provider: "codex", role: "subagent", cwd: project, configDirs: [], profile: "auto" } : null,
    home,
    timeoutMs
  });
}

test("merge: any deny wins, else any ask, else an allow only from a plugin the person let allow, else nothing", () => {
  const allowed = service("a", { mayAllow: true });
  assert.equal(mergeDecisions([answer("allow", { service: allowed }), answer("deny"), answer("ask")], false).behavior, "deny");
  assert.equal(mergeDecisions([answer("allow", { service: allowed }), answer("ask")], false).behavior, "ask");
  assert.equal(mergeDecisions([answer("allow", { service: allowed }), answer(null)], false).behavior, "allow");
  assert.equal(mergeDecisions([answer("allow")], false).behavior, "none", "an allow without the confirmation is no opinion");
  assert.equal(mergeDecisions([answer("allow", { service: allowed })], true).behavior, "ask", "cut input is never allowed");
  assert.deepEqual(mergeDecisions([answer(null)], false), { behavior: "none" });
  assert.deepEqual(mergeDecisions([], false), { behavior: "none" });
  const denied = mergeDecisions([answer("deny", { reason: "Delete specific files instead.", service: service("Guard") })], false);
  assert.equal(denied.message, "CanvasTTY plugin \"Guard\" blocked this tool call (Delete specific files instead). If it is needed, ask the person.");
});

test("base protection runs first; its deny is final and plugins are not asked", async () => {
  const calls = [];
  const decisions = hooks({ services: [service("p", { mayAllow: true })], answers: { p: { verdict: "allow" } }, calls });
  const denied = await decisions.decide("s1", request("Write", { file_path: join(home, "Downloads", "hello.txt"), content: "hi" }), live());
  assert.equal(denied.behavior, "deny");
  assert.match(denied.message, /outside the project folder/u);
  assert.equal(calls.length, 0);
  assert.equal((await decisions.decide("s1", request("Bash", { command: "ls" }), live())).behavior, "allow");
  assert.equal(calls[0].params.tool.kind, "shell");
  assert.equal(calls[0].params.tool.command, "ls");
  assert.equal(calls[0].params.cwd, project);
  assert.equal((await decisions.decide("unknown", request("Bash", { command: "sudo ls" }), live())).behavior, "none");
  // Base protection off: the same write reaches the plugins, and with none there is no verdict.
  assert.equal((await hooks({ protect: false }).decide("s1", request("Write", { file_path: "/etc/hosts" }), live())).behavior, "none");
  // A settings read that fails counts as on.
  const broken = new DecisionHooks({ baseProtection: () => { throw new Error("settings"); }, services: () => [], call: async () => null,
    session: () => ({ provider: "claude", role: "agent", cwd: project, configDirs: [] }), home });
  assert.equal((await broken.decide("s1", request("Bash", { command: "sudo ls" }), live())).behavior, "deny");
});

test("timeouts, errors and unreadable answers ask the person and never allow", async () => {
  const allowing = { mayAllow: true };
  const cases = [
    [() => new Promise(() => undefined), /did not answer in time/u],
    [() => { throw new Error("boom"); }, /could not answer/u],
    [() => "yes", /could not be read/u],
    [() => ({ verdict: "maybe" }), /could not be read/u]
  ];
  for (const [reply, reason] of cases) {
    const decisions = hooks({ protect: false, services: [service("slow", allowing), service("fast", allowing)], answers: { slow: reply, fast: { verdict: "allow" } } });
    const result = await decisions.decide("s1", request("Bash", { command: "ls" }), live());
    assert.equal(result.behavior, "ask", String(reason));
    assert.match(result.message, reason);
  }
  // The gateway's abort (socket closed, deadline) is an ask too.
  const aborted = new AbortController();
  const pending = hooks({ protect: false, services: [service("slow")], answers: { slow: () => new Promise(() => undefined) }, timeoutMs: 5_000 })
    .decide("s1", request("Bash", { command: "ls" }), aborted.signal);
  aborted.abort();
  assert.equal((await pending).behavior, "ask");
});

test("cut input under base protection: a shell call, or a file write whose target is not visible, is denied, never let through", async () => {
  const cut = (toolName, preview) => request(toolName, null, { truncated: true, toolInputPreview: preview });
  const decisions = hooks();
  for (const [toolName, preview] of [
    ["Bash", "{\"command\":\"echo hi; sudo rm -rf / # " + "x".repeat(200)],
    ["exec_command", "{\"cmd\":[\"bash\",\"-lc\",\"" + "x".repeat(200)],
    ["Write", "{\"content\":\"" + "x".repeat(200)],
    ["apply_patch", "{\"command\":\"*** Begin Patch\\n*** Add File: /etc/x"]
  ]) {
    const result = await decisions.decide("s1", cut(toolName, preview), live());
    assert.equal(result.behavior, "deny", toolName);
    assert.equal(result.message, TOO_LARGE_MESSAGE, toolName);
  }
  // A file write whose path is at the start of the preview is judged by that path, as before.
  const inside = JSON.stringify({ file_path: join(project, "big.txt"), content: "x".repeat(300) }).slice(0, 200);
  assert.equal((await decisions.decide("s1", cut("Write", inside), live())).behavior, "none");
  // Tools the rules do not read, and base protection off, are unchanged.
  assert.equal((await decisions.decide("s1", cut("Read", "{\"file_path\":"), live())).behavior, "none");
  assert.equal((await hooks({ protect: false }).decide("s1", cut("Bash", "{\"command\":\"ls"), live())).behavior, "none");
});

test("a plugin list that cannot be read is the gateway's failure, not an empty list", async () => {
  const failing = new DecisionHooks({
    baseProtection: () => false, services: () => { throw new Error("plugins"); }, call: async () => null,
    session: () => ({ provider: "codex", role: "agent", cwd: project, configDirs: [] }), home
  });
  await assert.rejects(failing.decide("s1", request("Bash", { command: "ls" }), live()));
  assert.equal(failing.wanted("codex"), true, "the hook is installed when the list cannot be read");
  assert.ok(failing.budgetMs("codex") > 0);
  // A handler that throws is answered by the gateway as an ask marked unavailable (permission-gate-fail-closed tests).
});

test("appliesTo limits plugins; wanted() says whether a launch needs the hook", async () => {
  const calls = [];
  const decisions = hooks({ protect: false, services: [service("codex-only", { appliesTo: ["codex"] })], answers: { "codex-only": { verdict: "deny" } }, calls });
  assert.equal((await decisions.decide("s1", request("Bash", { command: "ls" }), live())).behavior, "none");
  assert.equal(calls.length, 0);
  assert.equal(decisions.wanted("claude"), false);
  assert.equal(decisions.wanted("codex"), true);
  assert.equal(hooks({ protect: true }).wanted("claude"), true);
});

test("the gate prints only what each CLI takes: deny for all; ask and allow for Claude Code", () => {
  const deny = { behavior: "deny", message: "No." };
  for (const provider of ["claude", "codex", "qwen"]) {
    assert.deepEqual(hookOutput(provider, deny), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "No." } });
    assert.equal(hookOutput(provider, null), null);
  }
  assert.equal(hookOutput("claude", { behavior: "ask", message: "" }).hookSpecificOutput.permissionDecision, "ask");
  assert.equal(hookOutput("claude", { behavior: "allow", message: "" }).hookSpecificOutput.permissionDecision, "allow");
  // Allow is Claude's alone; an ask that reached a CLI which cannot ask (the gateway ran out of time) is a deny.
  for (const provider of ["codex", "qwen"]) {
    assert.equal(hookOutput(provider, { behavior: "allow", message: "" }), null);
    const asked = hookOutput(provider, { behavior: "ask", message: "" }).hookSpecificOutput;
    assert.equal(asked.permissionDecision, "deny");
    assert.match(asked.permissionDecisionReason, /cannot ask the person from here, so it was not run/u);
  }
  // "none" is a real answer (no verdict), told apart from an unreadable one (null), and prints nothing.
  const none = parseDecision({ v: RUNTIME_PROTOCOL_VERSION, type: "permission_decision", requestId: "x", behavior: "none" }, "x");
  assert.deepEqual(none, { behavior: "none", message: "", unavailable: false });
  for (const provider of ["claude", "codex", "qwen"]) assert.equal(hookOutput(provider, none), null);
  assert.equal(parseDecision({ v: RUNTIME_PROTOCOL_VERSION, type: "permission_decision", requestId: "x", behavior: "maybe" }, "x"), null);
  const identity = { terminalSessionId: "t", provider: "claude", capabilityToken: "c" };
  const big = buildRequest({ tool_name: "Write", tool_input: { file_path: "/x", content: "x".repeat(50_000) } }, identity);
  assert.equal(big.truncated, true);
  assert.equal(big.toolInput, null);
  assert.ok(big.toolInputPreview.startsWith("{\"file_path\":\"/x\""));
});

function runGate(capability, input, provider = "claude") {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATE, "pretool"], {
      env: {
        PATH: process.env.PATH, HOME: home,
        [AGENT_RUNTIME_ENV.address]: capability.address,
        [AGENT_RUNTIME_ENV.terminalSessionId]: capability.terminalSessionId,
        [AGENT_RUNTIME_ENV.provider]: provider,
        [AGENT_RUNTIME_ENV.capabilityToken]: capability.capabilityToken
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (code) => resolve({ code, output: stdout.trim() ? JSON.parse(stdout) : null }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("end to end: the real gate and gateway, the example deny-rm plugin through the real supervisor, allow gating", POSIX, async (t) => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-decisions-plugin-"));
  const manager = new PluginManager(userData, async (_url, destination) => { await cp(example, destination, { recursive: true }); });
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: "9.9.9", locale: () => "en", stopGraceMs: 300,
    host: { storageGet: async () => null, storageSet: async () => undefined, emit: () => undefined }
  });
  manager.setServiceObserver((specs) => supervisor.sync(specs));
  const runtime = await mkdtemp(join(tmpdir(), "canvastty-decisions-rt-"));
  let protect = true;
  const decisions = new DecisionHooks({
    baseProtection: () => protect,
    services: () => manager.decisionServices(),
    call: (pluginId, serviceId, method, params, timeoutMs) => supervisor.hostCall(pluginId, serviceId, method, params, timeoutMs),
    session: (id) => id === "cc" || id === "cx" ? { provider: id === "cc" ? "claude" : "codex", role: "agent", cwd: project, configDirs: [] } : null,
    home
  });
  const gateway = new RuntimeGateway({ runtimeDirectory: runtime, onPermissionRequest: (id, req, signal) => decisions.decide(id, req, signal) });
  await gateway.start();
  t.after(async () => {
    await gateway.close();
    await supervisor.dispose();
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  });
  await manager.load();
  const { manifest } = await manager.install((await manager.previewInstall("https://github.com/example/deny-rm")).token);
  assert.equal(manager.decisionServices().length, 0, "install alone never lets a plugin decide");
  await assert.rejects(manager.setDecisionsMayAllow(manifest.id, true), /native code first/u);
  await manager.setNativeCodeTrusted(manifest.id, true);
  assert.deepEqual(manager.decisionServices(), [{ pluginId: manifest.id, pluginName: "Deny rm -rf", serviceId: "guard", timeoutMs: 5_000, mayAllow: false }]);

  const claude = gateway.registerSession("cc", "claude", false, undefined, true);
  const codex = gateway.registerSession("cx", "codex", false, undefined, true);
  const call = (capability, toolName, toolInput, provider) => runGate(capability, { session_id: "x", hook_event_name: "PreToolUse", cwd: project, tool_name: toolName, tool_input: toolInput }, provider);

  // Base protection: the write outside is refused, the marker never exists because nothing ran.
  const outside = await call(claude, "Bash", { command: `echo hi > ${join(home, "Downloads", "marker.txt")}` });
  assert.equal(outside.code, 0);
  assert.equal(outside.output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(outside.output.hookSpecificOutput.permissionDecisionReason, /outside the project folder/u);
  // Ordinary work passes with no output.
  assert.deepEqual(await call(claude, "Bash", { command: "ls" }), { code: 0, output: null });
  // The example plugin denies rm -rf at the top of the working folder, which base protection allows.
  const rmrf = await call(claude, "Bash", { command: "rm -rf build" });
  assert.equal(rmrf.output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(rmrf.output.hookSpecificOutput.permissionDecisionReason, /Deny rm -rf/u);
  assert.equal((await call(codex, "Bash", { command: "rm -rf build" }, "codex")).output.hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(await call(claude, "Bash", { command: "rm -rf build/cache" }), { code: 0, output: null });

  // Allow gating: a plugin's allow counts only after the second confirmation, and never past base protection.
  const allowAll = { ...manager.decisionServices()[0] };
  const allowing = new DecisionHooks({
    baseProtection: () => protect, services: () => [{ ...allowAll, mayAllow: manager.list()[0].decisionsMayAllow }],
    call: async () => ({ verdict: "allow", reason: "trusted" }),
    session: () => ({ provider: "claude", role: "agent", cwd: project, configDirs: [] }), home
  });
  assert.equal((await allowing.decide("cc", request("Bash", { command: "ls" }), live())).behavior, "none");
  await manager.setDecisionsMayAllow(manifest.id, true);
  assert.equal((await allowing.decide("cc", request("Bash", { command: "ls" }), live())).behavior, "allow");
  assert.equal((await allowing.decide("cc", request("Bash", { command: "sudo ls" }), live())).behavior, "deny");
  // Revoking native code trust revokes the allow confirmation with it.
  await manager.setNativeCodeTrusted(manifest.id, false);
  assert.equal(manager.list()[0].decisionsMayAllow, false);
  assert.equal(manager.decisionServices().length, 0);
  // The plugin's service is gone: with base protection off the same rm -rf now has no verdict at all.
  protect = false;
  assert.deepEqual(await call(claude, "Bash", { command: "rm -rf build" }), { code: 0, output: null });

  // A session launched without the decision hook cannot ask: the gateway closes the socket and the CLI goes on.
  const plain = gateway.registerSession("plain", "claude");
  assert.deepEqual(await runGate(plain, { tool_name: "Bash", tool_input: { command: "sudo ls" } }), { code: 0, output: null });
});

test("the gateway asks when the answer is late and never passes an allow of cut input", POSIX, async (t) => {
  const runtime = await mkdtemp(join(tmpdir(), "canvastty-decisions-gw-"));
  let handler = async () => ({ behavior: "allow" });
  const gateway = new RuntimeGateway({ runtimeDirectory: runtime, onPermissionRequest: (...args) => handler(...args) });
  await gateway.start();
  t.after(async () => { await gateway.close(); await rm(runtime, { recursive: true, force: true }); });
  const capability = gateway.registerSession("s", "claude", false, undefined, true);
  assert.equal((await runGate(capability, { tool_name: "Bash", tool_input: { command: "ls" } })).output.hookSpecificOutput.permissionDecision, "allow");
  const cut = await runGate(capability, { tool_name: "Write", tool_input: { file_path: "/x", content: "x".repeat(50_000) } });
  assert.equal(cut.output.hookSpecificOutput.permissionDecision, "ask");
  handler = async () => { throw new Error("broken"); };
  assert.equal((await runGate(capability, { tool_name: "Bash", tool_input: { command: "ls" } })).output.hookSpecificOutput.permissionDecision, "ask");
});

test("launch: the decision hook is added only when wanted, per provider, with or without status hooks", async (t) => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "canvastty-decisions-launch-"));
  t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const helper = { command: "/opt/CanvasTTY", args: ["/opt/CanvasTTY/hook-helper.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } };
  const permissionGate = { command: "/opt/CanvasTTY", args: ["/opt/CanvasTTY/permission-gate.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } };
  const adapters = new ProviderRuntimeLaunchAdapters({ helper, runtimeDirectory, openCodePluginPath: "/opt/CanvasTTY/opencode-plugin.mjs",
    kimiHomeDirectory: join(runtimeDirectory, "kimi"), hermesHomeDirectory: join(runtimeDirectory, "hermes"), grokHomeDirectory: join(runtimeDirectory, "grok"), permissionGate });
  const plain = adapters.prepare("claude", "t1", false, false);
  assert.deepEqual(plain.args, []);
  const claude = JSON.parse(adapters.prepare("claude", "t1", false, true).args[1]);
  assert.deepEqual(Object.keys(claude.hooks), ["PreToolUse"]);
  assert.equal(claude.hooks.PreToolUse[0].matcher, "Bash|Write|Edit|MultiEdit|NotebookEdit");
  assert.match(claude.hooks.PreToolUse[0].hooks[0].command, /permission-gate\.mjs['"] ['"]pretool['"]$/u);
  assert.ok(JSON.parse(adapters.prepare("claude", "t1", true, true).args[1]).hooks.Stop, "status hooks stay alongside");
  const codex = adapters.prepare("codex", "t2", false, true).args.join(" ");
  assert.match(codex, /hooks\.PreToolUse=\[\{matcher="Bash\|apply_patch\|Edit\|Write"/u);
  const qwen = adapters.prepare("qwen", "t3", false, true);
  const qwenSettings = JSON.parse(await readFile(qwen.environment.QWEN_CODE_SYSTEM_SETTINGS_PATH, "utf8"));
  assert.equal(qwenSettings.hooks.PreToolUse[0].hooks[0].timeout, 15_000);
  qwen.releaseConfiguration();
  assert.equal(adapters.prepare("opencode", "t4", false, true).environment[OPENCODE_DECISIONS_ENV], "1");
  assert.equal(adapters.prepare("opencode", "t4", false, false).environment[OPENCODE_DECISIONS_ENV], undefined);
  assert.equal(adapters.decisionsSupported("kimi"), false);
  assert.deepEqual(adapters.prepare("kimi", "t5", false, true).args, []);

  // The bridge registers a capability for the gate even while status hooks are off, and keeps it when they go off.
  const registered = [];
  const revoked = [];
  const gateway = {
    registerSession: (...args) => { registered.push(args); return { address: "/tmp/x.sock", terminalSessionId: args[0], provider: args[1], capabilityToken: "c".repeat(40) }; },
    revokeTerminalSession: (id) => revoked.push(id),
    currentStatus: () => null
  };
  const bridge = new AgentRuntimeBridge(gateway, { helper, runtimeDirectory, openCodePluginPath: "/opt/CanvasTTY/opencode-plugin.mjs",
    kimiHomeDirectory: join(runtimeDirectory, "kimi"), hermesHomeDirectory: join(runtimeDirectory, "hermes"), grokHomeDirectory: join(runtimeDirectory, "grok"),
    permissionGate, coreHooksEnabled: true, wantsDecisions: (provider) => provider === "claude" });
  const launched = bridge.prepareLaunch({ terminalSessionId: "a", provider: "claude", cwd: project });
  assert.equal(launched.decisions, true);
  assert.equal(registered[0][4], true);
  assert.equal(bridge.prepareLaunch({ terminalSessionId: "b", provider: "codex", cwd: project }).decisions, false);
  bridge.setCoreHooksEnabled(false);
  assert.deepEqual(revoked, ["b"], "the session with the decision hook keeps its lease");
});

test("OpenCode: the guard throws a deny, remembers an allow and answers OpenCode's prompt once", async () => {
  const env = {
    [OPENCODE_DECISIONS_ENV]: "1", [AGENT_RUNTIME_ENV.address]: "/tmp/x.sock", [AGENT_RUNTIME_ENV.terminalSessionId]: "t",
    [AGENT_RUNTIME_ENV.provider]: "opencode", [AGENT_RUNTIME_ENV.capabilityToken]: "c".repeat(40)
  };
  const replies = [];
  const client = { permission: { reply: async (body) => { replies.push(body); return { response: { ok: true } }; } } };
  let next = { behavior: "deny", message: "Not outside the project." };
  const sent = [];
  const decisions = createOpenCodeDecisions({ client, env, send: async (_address, message) => { sent.push(message); return next; } });
  await assert.rejects(decisions.guard({ tool: "write", callID: "c1" }, { args: { filePath: "/etc/hosts", content: "x" } }), /Not outside the project/u);
  assert.equal(sent[0].toolName, "edit");
  next = { behavior: "allow", message: "" };
  await decisions.guard({ tool: "bash", callID: "c2" }, { args: { command: "ls" } });
  assert.equal(await decisions.permissionAsked({ id: "r1", tool: { callID: "c2" } }), true);
  assert.deepEqual(replies, [{ requestID: "r1", reply: "once" }]);
  assert.equal(await decisions.permissionAsked({ id: "r2", tool: { callID: "c2" } }), false, "an allow is used once");
  next = { behavior: "ask", message: "" };
  await decisions.guard({ tool: "bash", callID: "c3" }, { args: { command: "ls" } });
  assert.equal(await decisions.permissionAsked({ id: "r3", tool: { callID: "c3" } }), false, "ask leaves OpenCode's own prompt");
  await decisions.guard({ tool: "read", callID: "c4" }, { args: { filePath: "/etc/hosts" } });
  assert.equal(sent.length, 3, "tools that neither run commands nor write files are not sent");
  assert.equal(createOpenCodeDecisions({ env: { ...env, [OPENCODE_DECISIONS_ENV]: "0" } }).enabled, false);
  assert.deepEqual(guardedCall("apply_patch", { patchText: "*** Begin Patch" }), { toolName: "apply_patch", toolInput: { patch: "*** Begin Patch" } });
  // multiedit: every edit's new text reaches the decision, as Claude's MultiEdit tool_input does.
  assert.deepEqual(guardedCall("multiedit", { filePath: "/p/a.ts", edits: [{ oldString: "a", newString: "TOKEN=1" }, { oldString: "b", newString: "rm -rf /" }, { newString: 5 }] }),
    { toolName: "edit", toolInput: { file_path: "/p/a.ts", content: "TOKEN=1\nrm -rf /" } });
});

test("manifest: decide needs decision:provide, lists pre-tool, and at most one service per plugin decides", () => {
  assert.deepEqual(validatePluginManifest(exampleManifest).services[0].decide, { events: ["pre-tool"], timeoutMs: 5_000 });
  const manifest = (services, permissions = ["decision:provide"]) => ({ ...exampleManifest, permissions, services });
  const guard = { id: "guard", title: "Guard", entry: "services/guard.mjs", decide: { events: ["pre-tool"], appliesTo: ["claude"] } };
  assert.deepEqual(validatePluginManifest(manifest([guard])).services[0].decide, { events: ["pre-tool"], appliesTo: ["claude"] });
  assert.throws(() => validatePluginManifest(manifest([guard], [])), /decision:provide/u);
  assert.throws(() => validatePluginManifest(manifest([{ ...guard, decide: { events: ["post-tool"] } }])), /pre-tool/u);
  assert.throws(() => validatePluginManifest(manifest([{ ...guard, decide: { events: ["pre-tool"], appliesTo: ["terminal"] } }])), /appliesTo/u);
  assert.throws(() => validatePluginManifest(manifest([{ ...guard, decide: { events: ["pre-tool"], allow: true } }])), /unsupported|unknown|not allowed|invalid/iu);
  assert.throws(() => validatePluginManifest(manifest([guard, { ...guard, id: "second" }])), /At most one plugin service may decide/u);
});

test("an ask for an agent that cannot ask is a deny with the reason; the service learns the profile and whether it can ask", async () => {
  const calls = [];
  const decisions = hooks({ protect: false, services: [service("p.guard")], answers: { "p.guard": { verdict: "ask", reason: "Force push" } }, calls });
  const codex = await decisions.decide("codex", request("Bash", { command: "git push --force" }), live());
  assert.equal(codex.behavior, "deny");
  assert.match(codex.message, /asks the person about this tool call \(Force push\)\. codex cannot ask the person from here, so it was not run/u);
  assert.deepEqual([calls[0].params.profile, calls[0].params.canAsk], ["auto", false]);
  const claude = await decisions.decide("s1", request("Bash", { command: "git push --force" }), live());
  assert.equal(claude.behavior, "ask", "Claude Code puts it in front of the person");
  assert.equal(calls[1].params.canAsk, true);
  // A service that runs out of time is an ask too: for Codex that is a deny, never a run.
  const slow = hooks({ protect: false, services: [service("p.slow")], answers: { "p.slow": () => new Promise(() => {}) }, timeoutMs: 20 });
  assert.equal((await slow.decide("codex", request("Bash", { command: "ls" }), live())).behavior, "deny");
});

test("trusted human approval resolves asks only, with explicit answers and the provider fallback on failure", async () => {
  const asking = [service("p.ask")];
  const answers = { "p.ask": { verdict: "ask", reason: "review this command" } };
  const humanCalls = [];
  const enabled = () => true;
  const allow = hooks({
    protect: false, provider: "opencode", services: asking, answers, humanApprovalEnabled: enabled,
    resolveHumanAsk: async (...args) => { humanCalls.push(args); return "allow"; }
  });
  const toolRequest = request("Bash", { command: "ls" });
  assert.equal(allow.budgetMs("opencode"), 60_000, "the launch budget reserves the human wait");
  assert.deepEqual(await allow.decide("s1", toolRequest, live()), { behavior: "allow", message: "Approved by the person." });
  assert.equal(humanCalls.length, 1);
  assert.equal(humanCalls[0][0], "s1");
  assert.equal(humanCalls[0][1], toolRequest);
  assert.equal(humanCalls[0][2].behavior, "ask");
  assert.ok(humanCalls[0][3] instanceof AbortSignal);

  const deny = hooks({
    protect: false, provider: "qwen", services: asking, answers, humanApprovalEnabled: enabled,
    resolveHumanAsk: async () => "deny"
  });
  assert.deepEqual(await deny.decide("s1", toolRequest, live()), { behavior: "deny", message: "Denied by the person." });

  let shouldNotAsk = 0;
  const pluginDeny = hooks({
    protect: false, provider: "opencode", services: asking, answers: { "p.ask": { verdict: "deny" } },
    humanApprovalEnabled: enabled, resolveHumanAsk: async () => { shouldNotAsk += 1; return "allow"; }
  });
  assert.equal((await pluginDeny.decide("s1", toolRequest, live())).behavior, "deny");
  const protectedDeny = hooks({
    services: asking, answers, humanApprovalEnabled: enabled,
    resolveHumanAsk: async () => { shouldNotAsk += 1; return "allow"; }
  });
  assert.equal((await protectedDeny.decide("s1", request("Write", { file_path: join(home, "Downloads", "x") }), live())).behavior, "deny");
  assert.equal(shouldNotAsk, 0, "plugin and base-protection denies remain final");

  const disabled = hooks({
    protect: false, provider: "opencode", services: asking, answers, humanApprovalEnabled: () => false,
    resolveHumanAsk: async () => { shouldNotAsk += 1; return "allow"; }
  });
  assert.equal((await disabled.decide("s1", toolRequest, live())).behavior, "deny", "disabled host preserves unsupported-provider fallback");
  assert.equal(disabled.budgetMs("opencode"), 3_000);
  assert.equal(shouldNotAsk, 0);

  for (const resolveHumanAsk of [async () => null, async () => { throw new Error("unavailable"); }]) {
    const failed = hooks({
      protect: false, provider: "opencode", services: asking, answers, humanApprovalEnabled: enabled, resolveHumanAsk
    });
    assert.equal((await failed.decide("s1", toolRequest, live())).behavior, "deny", "null and failure do not allow");
  }
  const claudeFallback = hooks({
    protect: false, services: asking, answers, humanApprovalEnabled: enabled, resolveHumanAsk: async () => null
  });
  assert.equal((await claudeFallback.decide("s1", toolRequest, live())).behavior, "ask", "Claude retains its native prompt");

  const controller = new AbortController();
  let resolverStarted;
  const started = new Promise((resolve) => { resolverStarted = resolve; });
  const aborted = hooks({
    protect: false, provider: "opencode", services: asking, answers, humanApprovalEnabled: enabled,
    resolveHumanAsk: async (_id, _request, _decision, signal) => {
      resolverStarted();
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve("allow"), { once: true }));
    }
  });
  const pending = aborted.decide("s1", toolRequest, controller.signal);
  await started;
  controller.abort();
  assert.equal((await pending).behavior, "deny", "an aborted resolver cannot approve; unsupported CLI fallback still blocks");
});


test("review context comes from the host for each plugin, never from agent tool input", async () => {
  const calls=[];
  const h=new DecisionHooks({baseProtection:()=>false,services:()=>[service("assistant"),service("other")],
    session:()=>({provider:"opencode",role:"subagent",cwd:project,configDirs:[]}),
    executionProtection:()=>({state:"unverified"}),
    launchOptions:(_id,plugin)=>plugin==="assistant"?{task:"Write src/format.js",dataClass:"D3"}:{},
    call:async(plugin,_service,_method,params)=>{calls.push({plugin,params});return null;}});
  await h.decide("child",request("Write",{file_path:"src/format.js",content:"x",launchOptions:{task:"forged"},executionProtection:{state:"applied",layer:"seatbelt"}}),live());
  assert.deepEqual(calls[0].params.executionProtection,{state:"unverified"});
  assert.deepEqual(calls[0].params.launchOptions,{task:"Write src/format.js",dataClass:"D3"});
  assert.deepEqual(calls[1].params.launchOptions,{});
});
