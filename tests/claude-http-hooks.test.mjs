import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";

import { AGENT_RUNTIME_ENV, CAPTURE_RESULT_ENV, CLAUDE_HTTP_HOOK, normalizedActionHashFromHook } from "../src/agent-runtime/runtime-protocol.mjs";
import { AgentRuntimeBridge } from "../src/main/services/agent-runtime/AgentRuntimeBridge.ts";
import {
  ClaudeHttpHookPolicy,
  ClaudeVersions,
  blockingSetting,
  compareVersions
} from "../src/main/services/agent-runtime/ClaudeHttpHooks.ts";
import { ProviderRuntimeLaunchAdapters } from "../src/main/services/agent-runtime/ProviderRuntimeLaunch.ts";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import { claudeCoreSettingsKey } from "../src/main/services/terminalLaunch.ts";

const POSIX = { skip: process.platform === "win32" ? "the loopback listener is POSIX-only" : false };
const helperPath = new URL("../src/agent-runtime/hook-helper.mjs", import.meta.url).pathname;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-http-hooks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function startGateway(t, options = {}) {
  const root = await fixture(t);
  const signals = [];
  const gateway = new RuntimeGateway({
    runtimeDirectory: root,
    httpHooks: true,
    onSignal: (id, signal) => signals.push({ id, signal }),
    ...options
  });
  await gateway.start();
  t.after(() => gateway.close());
  return { gateway, signals, root };
}

/** A raw POST with exactly these headers (fetch would add Sec-Fetch-Mode). */
function post(base, path, { headers = {}, body = "{}", method = "POST" } = {}) {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method, headers: { host: url.host, ...headers } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: text }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

function hookHeaders(capability, extra = {}) {
  return {
    "content-type": "application/json",
    [CLAUDE_HTTP_HOOK.sessionHeader]: capability.terminalSessionId,
    [CLAUDE_HTTP_HOOK.capabilityHeader]: capability.capabilityToken,
    ...extra
  };
}

function runHelper(capability, state, event, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helperPath, state, event], {
      env: {
        ...process.env,
        ...env,
        [AGENT_RUNTIME_ENV.address]: capability.address,
        [AGENT_RUNTIME_ENV.terminalSessionId]: capability.terminalSessionId,
        [AGENT_RUNTIME_ENV.provider]: capability.provider,
        [AGENT_RUNTIME_ENV.capabilityToken]: capability.capabilityToken
      },
      stdio: ["pipe", "ignore", "ignore"]
    });
    child.stdin.end(input);
    child.on("close", resolve);
  });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("an HTTP lifecycle hook reports exactly what the command helper reports for the same input", POSIX, async (t) => {
  const { gateway, signals } = await startGateway(t);
  const base = gateway.httpHookBase;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/u);
  const inputs = [
    ["working", "UserPromptSubmit", { prompt: "stays local", prompt_id: "turn-1", session_id: "5F1C2A90-AA11-4B22-9C33-0D44E55F6677" }],
    ["working", "PostToolUse", { prompt_id: "turn-1", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "secret" } }],
    ["working", "PostToolUse", { prompt_id: "turn-1", tool_name: "Write", tool_input: { file_path: "/private/secrets.txt", content: "fixture secret content" }, tool_response: { filePath: "/private/secrets.txt", type: "create" } }],
    ["working", "PostToolUseFailure", { prompt_id: "turn-1", tool_name: "Bash", tool_input: { command: "npm test" }, error: "Exit code 1\nfixture secret error", is_interrupt: false }],
    ["working", "PostToolUseFailure", { prompt_id: "turn-1", tool_name: "Bash", tool_input: { command: "npm test" }, error: "fixture secret interrupt", is_interrupt: true }],
    ["needs_approval", "PermissionRequest", { prompt_id: "turn-1", tool_name: "Bash", tool_input: { command: "sudo something" } }],
    ["idle", "Stop", { prompt_id: "turn-1", session_id: "5f1c2a90-aa11-4b22-9c33-0d44e55f6677", last_assistant_message: `${"a".repeat(4095)}😀tail` }],
    ["idle", "Stop", { prompt_id: "x".repeat(161), session_id: "not-a-uuid", last_assistant_message: "short" }],
    ["needs_approval", "Notification", "not json at all"]
  ];
  for (const captureResult of [false, true]) {
    for (const [state, event, input] of inputs) {
      const raw = typeof input === "string" ? input : JSON.stringify(input);
      const viaHelper = gateway.registerSession("helper-session", "claude", captureResult);
      await runHelper(viaHelper, state, event, raw, captureResult ? { [CAPTURE_RESULT_ENV]: "1" } : {});
      const viaHttp = gateway.registerSession("http-session", "claude", captureResult);
      const response = await post(base, `${CLAUDE_HTTP_HOOK.pathPrefix}${state}/${event}`, { headers: hookHeaders(viaHttp), body: raw });
      assert.deepEqual(response, { status: 200, body: "{}" });
      await flush();
      const helperSignal = signals.filter((entry) => entry.id === "helper-session").at(-1)?.signal;
      const httpSignal = signals.filter((entry) => entry.id === "http-session").at(-1)?.signal;
      assert.ok(helperSignal, `${event} reached the gateway through the helper`);
      const { turnEpoch: _helperEpoch, ...helperContract } = helperSignal;
      const { turnEpoch: _httpEpoch, ...httpContract } = httpSignal;
      assert.deepEqual(httpContract, helperContract, `${state}/${event} capture=${captureResult}`);
      if (event === "PermissionRequest") assert.equal(helperSignal.toolOutcome, undefined, "permission prompts are not tool outcomes");
      if (event.startsWith("PostToolUse")) {
        assert.ok(helperSignal.toolOutcome, `${event} includes a completed-tool summary`);
        assert.equal(helperSignal.toolOutcome.normalizedActionHash,
          normalizedActionHashFromHook(input.tool_name, input.tool_input),
          "pretool activity and posttool outcome use the same action hash for identical hook inputs");
        assert.equal(JSON.stringify(helperSignal).includes("secret"), false, "tool response text stays local");
        assert.equal(JSON.stringify(helperSignal).includes("fixture secret"), false, "tool input and error text stay local");
        assert.equal(JSON.stringify(helperSignal).includes("/private/secrets.txt"), false, "file paths stay local");
        if (event === "PostToolUse" && input.tool_name === "Bash") {
          assert.equal(helperSignal.toolOutcome.outputHash, createHash("sha256").update(JSON.stringify(input.tool_response)).digest("hex"),
            "a successful tool's output is summarized only as a hash, so repeated output is recognizable");
        }
        if (event === "PostToolUseFailure") assert.equal(helperSignal.toolOutcome.outputHash, undefined, "errors keep only their error hash");
        if (input.tool_name === "Write") {
          assert.deepEqual(helperSignal.toolOutcome.changedPathHashes, [createHash("sha256").update("/private/secrets.txt").digest("hex")]);
        }
        if (event === "PostToolUseFailure" && input.is_interrupt === false) {
          assert.equal(helperSignal.toolOutcome.resultClass, "error");
          assert.match(helperSignal.toolOutcome.errorHash, /^[a-f0-9]{64}$/u);
        }
        if (input.is_interrupt === true) assert.equal(helperSignal.toolOutcome.resultClass, "unknown");
      }
      signals.length = 0;
    }
  }
  assert.equal(JSON.stringify(signals).includes("stays local"), false);
});

test("the listener refuses browsers, other hosts, other routes and anyone without the session's capability", POSIX, async (t) => {
  const { gateway, signals } = await startGateway(t);
  const base = gateway.httpHookBase;
  const capability = gateway.registerSession("claude-one", "claude");
  const path = `${CLAUDE_HTTP_HOOK.pathPrefix}working/UserPromptSubmit`;
  const cases = [
    ["GET", { method: "GET" }, 405],
    ["preflight", { method: "OPTIONS" }, 405],
    ["Origin", { headers: hookHeaders(capability, { origin: "https://evil.example" }) }, 403],
    ["Referer", { headers: hookHeaders(capability, { referer: "https://evil.example/" }) }, 403],
    ["Sec-Fetch-Site", { headers: hookHeaders(capability, { "sec-fetch-site": "cross-site" }) }, 403],
    ["Sec-Fetch-Mode", { headers: hookHeaders(capability, { "sec-fetch-mode": "no-cors" }) }, 403],
    ["rebound Host", { headers: hookHeaders(capability, { host: "evil.example" }) }, 403],
    ["localhost Host", { headers: hookHeaders(capability, { host: `localhost:${new URL(base).port}` }) }, 403],
    ["form body", { headers: hookHeaders(capability, { "content-type": "text/plain" }) }, 415],
    ["no content type", { headers: { [CLAUDE_HTTP_HOOK.sessionHeader]: capability.terminalSessionId, [CLAUDE_HTTP_HOOK.capabilityHeader]: capability.capabilityToken } }, 415],
    ["unknown session", { headers: hookHeaders({ ...capability, terminalSessionId: "nobody" }) }, 401],
    ["wrong capability", { headers: hookHeaders({ ...capability, capabilityToken: "x".repeat(43) }) }, 401]
  ];
  for (const [name, options, status] of cases) {
    const response = await post(base, path, options);
    assert.equal(response.status, status, name);
  }
  for (const route of ["/claude/v1/working", "/claude/v1/busy/UserPromptSubmit", "/claude/v1/working/Bad-Event", "/claude/v1/working/X/Y", "/other"]) {
    assert.equal((await post(base, route, { headers: hookHeaders(capability) })).status, 404, route);
  }
  // Another provider's lease never takes Claude's HTTP hooks.
  const codex = gateway.registerSession("codex-one", "codex");
  assert.equal((await post(base, path, { headers: hookHeaders(codex) })).status, 401);
  await flush();
  assert.deepEqual(signals, []);
  assert.equal(gateway.httpHookBase, base);

  // Revoking the session revokes its capability at once.
  assert.equal((await post(base, path, { headers: hookHeaders(capability), body: '{"prompt_id":"t"}' })).status, 200);
  gateway.revokeTerminalSession("claude-one");
  assert.equal((await post(base, path, { headers: hookHeaders(capability) })).status, 401);
});

test("a known session without its capability marks HTTP unusable for later launches", POSIX, async (t) => {
  const { gateway } = await startGateway(t);
  const base = gateway.httpHookBase;
  const capability = gateway.registerSession("claude-one", "claude");
  const response = await post(base, `${CLAUDE_HTTP_HOOK.pathPrefix}working/PostToolUse`, {
    headers: hookHeaders({ ...capability, capabilityToken: "" })
  });
  assert.equal(response.status, 401);
  assert.equal(gateway.httpHookBase, null);
});

test("an input over 512 KB still reports its state, without any of its fields", POSIX, async (t) => {
  const { gateway, signals } = await startGateway(t);
  const capability = gateway.registerSession("claude-one", "claude", true);
  const body = JSON.stringify({ prompt_id: "turn-big", last_assistant_message: "x".repeat(600 * 1024) });
  const response = await post(gateway.httpHookBase, `${CLAUDE_HTTP_HOOK.pathPrefix}idle/Stop`, { headers: hookHeaders(capability), body });
  assert.equal(response.status, 200);
  await flush();
  assert.deepEqual(signals, [{ id: "claude-one", signal: { state: "idle", event: "Stop", turnId: null, turnEpoch: 0 } }]);
});

test("an input found over 512 KB only while it streams (no Content-Length) reports its state once", POSIX, async (t) => {
  const { gateway, signals } = await startGateway(t);
  const capability = gateway.registerSession("claude-one", "claude", true);
  const body = JSON.stringify({ prompt_id: "turn-big", last_assistant_message: "x".repeat(600 * 1024) });
  const response = await post(gateway.httpHookBase, `${CLAUDE_HTTP_HOOK.pathPrefix}idle/Stop`, {
    headers: hookHeaders(capability, { "transfer-encoding": "chunked" }), body
  });
  assert.equal(response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(signals, [{ id: "claude-one", signal: { state: "idle", event: "Stop", turnId: null, turnEpoch: 0 } }]);
});

test("hooks get their answer before the app reacts (HTTP and socket)", POSIX, async (t) => {
  let busyMs = 0;
  const { gateway } = await startGateway(t, {
    onSignal: () => {
      const until = Date.now() + busyMs;
      while (Date.now() < until) { /* a slow reaction in main */ }
    }
  });
  busyMs = 400;
  const capability = gateway.registerSession("claude-one", "claude");
  // The client runs in its own process, so the gateway's busy loop cannot hide when the answer left.
  const script = `
    const http = require("node:http");
    const started = performance.now();
    const request = http.request({ host: "127.0.0.1", port: ${new URL(gateway.httpHookBase).port}, path: "${CLAUDE_HTTP_HOOK.pathPrefix}working/PostToolUse", method: "POST",
      headers: ${JSON.stringify(hookHeaders(capability))} }, (response) => { response.resume(); response.on("end", () => { console.log(Math.round(performance.now() - started)); }); });
    request.end("{}");`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  await new Promise((resolve) => child.on("close", resolve));
  assert.ok(Number(out) < 300, `HTTP answer took ${out} ms while the reaction took 400 ms`);

  const socketCapability = gateway.registerSession("claude-two", "claude");
  const line = JSON.stringify({ v: 1, type: "lifecycle", terminalSessionId: socketCapability.terminalSessionId, provider: "claude",
    capabilityToken: socketCapability.capabilityToken, state: "working", event: "PostToolUse", turnId: null });
  const socketScript = `
    const net = require("node:net");
    const started = performance.now();
    const socket = net.createConnection(${JSON.stringify(socketCapability.address)}, () => socket.write(${JSON.stringify(line + "\n")}));
    socket.on("data", () => { console.log(Math.round(performance.now() - started)); socket.destroy(); });`;
  const socketChild = spawn(process.execPath, ["-e", socketScript], { stdio: ["ignore", "pipe", "inherit"] });
  let socketOut = "";
  socketChild.stdout.on("data", (chunk) => { socketOut += chunk; });
  await new Promise((resolve) => socketChild.on("close", resolve));
  assert.ok(Number(socketOut) < 300, `socket ack took ${socketOut} ms while the reaction took 400 ms`);
});

test("a failing reaction never reaches the hook", POSIX, async (t) => {
  const { gateway } = await startGateway(t, { onSignal: () => { throw new Error("boom"); } });
  const warn = t.mock.method(console, "warn", () => undefined);
  const capability = gateway.registerSession("claude-one", "claude");
  const response = await post(gateway.httpHookBase, `${CLAUDE_HTTP_HOOK.pathPrefix}working/PostToolUse`, { headers: hookHeaders(capability) });
  assert.equal(response.status, 200);
  await flush();
  assert.equal(warn.mock.callCount(), 1);
});

test("without httpHooks, or on Windows, there is no listener", async (t) => {
  const root = await fixture(t);
  const gateway = new RuntimeGateway({ runtimeDirectory: root });
  if (process.platform !== "win32") {
    await gateway.start();
    t.after(() => gateway.close());
  }
  assert.equal(gateway.httpHookBase, null);
  const windows = new RuntimeGateway({ platform: "win32", httpHooks: true });
  assert.equal(windows.httpHookBase, null);
});

const helper = Object.freeze({ command: "/opt/CanvasTTY/electron", args: ["/opt/CanvasTTY/agent-runtime/hook-helper.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } });
const gate = Object.freeze({ command: "/opt/CanvasTTY/electron", args: ["/opt/CanvasTTY/agent-runtime/permission-gate.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } });

test("Claude's lifecycle hooks become HTTP hooks except SessionStart; the decision hook stays a command", async (t) => {
  const root = await fixture(t);
  const adapters = new ProviderRuntimeLaunchAdapters({
    helper, permissionGate: gate, runtimeDirectory: root, openCodePluginPath: join(root, "opencode.mjs"), platform: "darwin"
  });
  const prepared = adapters.prepare("claude", "term-1", true, true, undefined, "http://127.0.0.1:43210");
  const settings = JSON.parse(prepared.args[1]);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].type, "command");
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /hook-helper\.mjs' 'idle' 'SessionStart'/u);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].type, "command");
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /permission-gate\.mjs' 'pretool'/u);
  for (const [event, state] of [["UserPromptSubmit", "working"], ["PermissionRequest", "needs_approval"], ["PostToolUse", "working"],
    ["Stop", "idle"], ["StopFailure", "idle"], ["SessionEnd", "idle"], ["Notification", "needs_approval"]]) {
    const hook = settings.hooks[event][0].hooks[0];
    assert.deepEqual(hook, {
      type: "http",
      url: `http://127.0.0.1:43210/claude/v1/${state}/${event}`,
      timeout: 3,
      headers: {
        "x-canvastty-session": "${CANVASTTY_RUNTIME_TERMINAL_SESSION_ID}",
        "x-canvastty-capability": "${CANVASTTY_RUNTIME_CAPABILITY}"
      },
      allowedEnvVars: ["CANVASTTY_RUNTIME_TERMINAL_SESSION_ID", "CANVASTTY_RUNTIME_CAPABILITY"]
    }, event);
  }
  assert.equal(settings.hooks.Notification[0].matcher, "permission_prompt");
  assert.throws(() => adapters.prepare("claude", "term-1", true, false, undefined, "http://evil.example:80"), /loopback/u);
  // Without a base the launch is byte-for-byte the helper one.
  assert.deepEqual(adapters.prepare("claude", "term-1", true, false).args, adapters.prepare("claude", "term-1", true, false, undefined, undefined).args);
  assert.equal(adapters.prepare("claude", "term-1", true, false).args[1].includes('"type":"http"'), false);
});

test("the bridge uses HTTP only for Claude, only when the policy allows and the listener runs", POSIX, async (t) => {
  const { gateway, root } = await startGateway(t);
  const verdicts = [];
  let allow = true;
  const bridge = new AgentRuntimeBridge(gateway, {
    helper, permissionGate: gate, runtimeDirectory: root, openCodePluginPath: join(root, "opencode.mjs"),
    claudeHttpHooks: (facts) => { verdicts.push(facts); return allow ? { ok: true } : { ok: false, reason: "no" }; }
  });
  const facts = { executable: "/bin/claude", profile: "default", environmentWrapped: false, env: {}, args: [], cwd: root };
  const launched = bridge.prepareLaunch({ terminalSessionId: "c1", provider: "claude", cwd: root, claudeHttp: facts });
  assert.equal(launched.httpHooks, true);
  assert.ok(launched.args[1].includes(`${gateway.httpHookBase}/claude/v1/idle/Stop`));
  assert.equal(launched.args.join(" ").includes(launched.environment[AGENT_RUNTIME_ENV.capabilityToken]), false);
  launched.cleanup();
  allow = false;
  const refused = bridge.prepareLaunch({ terminalSessionId: "c2", provider: "claude", cwd: root, claudeHttp: facts });
  assert.equal(refused.httpHooks, false);
  assert.equal(refused.args[1].includes('"type":"http"'), false);
  refused.cleanup();
  allow = true;
  const codex = bridge.prepareLaunch({ terminalSessionId: "x1", provider: "codex", cwd: root, claudeHttp: facts });
  assert.equal(codex.httpHooks, false);
  codex.cleanup();
  assert.equal(verdicts.length, 2);
});

/** What is at a path when `files` (path -> text) is the whole file system. */
const entryIn = (files) => (path) => files.has(path) || files.has(resolve(path)) ? "file"
  : [...files.keys()].some((file) => file.startsWith(`${path}/`) || file.startsWith(`${resolve(path)}${sep}`)) ? "directory" : null;

test("the policy's project walk costs one stat per folder without .claude and stops at the repository root or HOME", () => {
  const files = new Map([["/profile/work/a/.claude/settings.json", "{}"]]);
  const looked = [];
  const read = [];
  const entry = entryIn(files);
  const policy = new ClaudeHttpHookPolicy({
    platform: "darwin", home: "/profile", managedSettingsPaths: [], version: () => "2.1.281",
    readText: (path) => { read.push(path); return files.get(path) ?? null; },
    entry: (path) => { looked.push(path); return entry(path); }
  });
  const facts = { executable: "/bin/claude", profile: "default", environmentWrapped: false, env: { PATH: "/bin" }, args: [], cwd: "/profile/work/a/b/c" };
  assert.equal(policy.verdict(facts).ok, true);
  assert.deepEqual(looked, [
    "/profile/work/a/b/c/.claude", "/profile/work/a/b/c/.git", "/profile/work/a/b/.claude", "/profile/work/a/b/.git",
    "/profile/work/a/.claude", "/profile/work/a/.git", "/profile/work/.claude", "/profile/work/.git", "/profile/.claude", "/profile/.git"
  ], "never above HOME");
  assert.deepEqual(read, ["/profile/.claude/settings.json", "/profile/work/a/.claude/settings.json", "/profile/work/a/.claude/settings.local.json"],
    "settings files are read only where a .claude folder is");
});

test("the policy keeps the helper wherever an HTTP hook could not reach the gateway", () => {
  const files = new Map();
  const policy = (options = {}) => new ClaudeHttpHookPolicy({
    platform: "darwin", home: "/profile", managedSettingsPaths: ["/managed/managed-settings.json"],
    readText: (path) => files.get(resolve(path)) ?? null, version: () => "2.1.281", entry: entryIn(files), ...options
  });
  const facts = { executable: "/bin/claude", profile: "default", environmentWrapped: false, env: { PATH: "/bin" }, args: [], cwd: "/work/repo/sub" };
  assert.deepEqual(policy().verdict(facts), { ok: true });
  const refused = (value, options) => {
    const verdict = policy(options).verdict({ ...facts, ...value });
    assert.equal(verdict.ok, false, JSON.stringify(value));
    return verdict.reason;
  };
  assert.match(refused({}, { platform: "win32" }), /Windows/u);
  assert.match(refused({ environmentWrapped: true }), /environment/u);
  assert.match(refused({ profile: "auto" }), /sandbox/u);
  assert.match(refused({}, { version: () => "2.1.280" }), /older/u);
  assert.match(refused({}, { version: () => null }), /not known/u);
  assert.equal(policy({ version: () => "2.2.0" }).verdict(facts).ok, true);
  for (const name of ["HTTP_PROXY", "https_proxy", "ALL_PROXY"]) assert.match(refused({ env: { [name]: "http://proxy:3128" } }), /proxy/u);
  assert.equal(policy().verdict({ ...facts, env: { HTTP_PROXY: "" } }).ok, true);
  assert.match(refused({ args: ["--settings", JSON.stringify({ sandbox: { enabled: true } })] }), /sandbox/u);
  assert.match(refused({ args: [`--settings=${JSON.stringify({ allowedHttpHookUrls: [] })}`] }), /URLs/u);

  const withFile = (path, value) => {
    files.clear();
    files.set(resolve(path), JSON.stringify(value));
  };
  withFile("/managed/managed-settings.json", { httpHookAllowedEnvVars: ["X"] });
  assert.match(refused({}), /headers/u);
  withFile("/profile/.claude/settings.json", { env: { HTTPS_PROXY: "http://proxy" } });
  assert.match(refused({}), /HTTPS_PROXY/u);
  withFile("/custom/settings.json", { sandbox: { enabled: true } });
  assert.match(refused({ env: { CLAUDE_CONFIG_DIR: "/custom" } }), /sandbox/u);
  withFile("/work/repo/.claude/settings.local.json", { allowedHttpHookUrls: ["https://x/*"] });
  assert.match(refused({}), /URLs/u);
  // The project walk stops at the repository root.
  files.set(resolve("/work/repo/sub/.git"), "gitdir: /elsewhere");
  assert.equal(policy().verdict(facts).ok, true);
  files.clear();
  withFile("/work/repo/.claude/settings.json", { sandbox: { enabled: false }, env: { FOO: "1" } });
  assert.equal(policy().verdict(facts).ok, true);

  assert.equal(blockingSetting(null), null);
  assert.equal(compareVersions("2.1.281", "2.1.281"), 0);
  assert.ok(compareVersions("2.1.300", "2.1.281") > 0);
  assert.ok(compareVersions("2.10.0", "2.9.9") > 0);
  assert.ok(compareVersions("1.0", "2.1.281") < 0);
});

test("Claude's version comes from the native installer's layout without running it", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "versions"));
  const executable = join(root, "versions", "2.1.281");
  await writeFile(executable, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  const versions = new ClaudeVersions();
  assert.equal(versions.get(executable), "2.1.281");
  assert.equal(versions.get(join(root, "missing")), null);
});

test("a plugin's Claude settings may not restrict HTTP hooks", () => {
  assert.equal(claudeCoreSettingsKey({ allowedHttpHookUrls: [] }), "allowedHttpHookUrls");
  assert.equal(claudeCoreSettingsKey({ httpHookAllowedEnvVars: [] }), "httpHookAllowedEnvVars");
  assert.equal(claudeCoreSettingsKey({ env: { A: "1" } }), null);
});
