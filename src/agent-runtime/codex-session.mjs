import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CODEX_STARTUP_FAILED_EXIT_CODE } from "./runtime-protocol.mjs";

const STOP_TIMEOUT = 750;
// Packaged helpers live beside app.asar, whose node_modules holds runtime dependencies.
const requireRuntime = createRequire(new URL("../app.asar/package.json", import.meta.url));
const LOCAL_ONLY = new Set(["--worktree", "--oss", "--local-provider", "-p", "--profile", "--add-dir", "--dangerously-bypass-hook-trust"]);
const COMMANDS = new Set(["agents", "exec", "e", "review", "login", "logout", "mcp", "plugin", "app-server",
  "remote-control", "completion", "update", "doctor", "sandbox", "debug", "apply", "a", "queue", "archive",
  "delete", "migrate-rollouts", "unarchive", "cloud", "exec-server", "features", "help"]);
const VALUES = new Set(["-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval", "-C", "--cd",
  "-i", "--image"]);

function privateServerVersion(output) {
  const version = /^codex(?:-cli)? (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(output.trim());
  return Boolean(version && (Number(version[1]) > 0 || Number(version[2]) >= 163));
}

function supportsPrivateServer(executable, env) {
  return new Promise(resolveSupported => execFile(executable, ["--version"], {
    env, timeout: 5000, maxBuffer: 4096, encoding: "utf8"
  }, (error, stdout) => resolveSupported(!error && privateServerVersion(stdout))));
}

/** Keep launch-local config on the owned backend; the official CLI remains its frontend. */
export function sessionArguments(args) {
  const frontend = [], backend = [];
  const permissionKeys = new Set();
  let resuming = false, resumeThread;
  let cwd = process.cwd(), sandbox, approval, automatic = false, bypass = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (typeof token !== "string" || token.includes("\0")) throw new Error("Invalid Codex argument.");
    const separator = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = separator < 0 ? token : token.slice(0, separator);
    // shortcut: local-only CLI modes retain their original launch; translate their config before exposing RPC.
    if (LOCAL_ONLY.has(flag) || COMMANDS.has(token) || ["-h", "--help", "-V", "--version"].includes(flag)) return null;
    if (flag === "--remote" || flag === "--remote-auth-token-env") throw new Error("CanvasTTY owns this Codex endpoint.");
    if (token === "resume") resuming = true;
    else if (resuming && !resumeThread && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(token)) resumeThread = token;
    const value = () => {
      const result = separator < 0 ? args[++i] : token.slice(separator + 1);
      if (typeof result !== "string" || !result || result.includes("\0")) throw new Error("Missing Codex argument value.");
      return result;
    };
    if (flag === "--no-daemon") continue;
    if (flag === "-c" || flag === "--config") {
      const entry = value(), equals = entry.indexOf("=");
      if (equals < 1) throw new Error("Invalid Codex configuration override.");
      backend.push("-c", entry);
      const key = entry.slice(0, equals).trim();
      if (["approval_policy", "approvals_reviewer", "sandbox_mode", "sandbox_workspace_write", "sandbox_workspace_write.writable_roots"].includes(key)) permissionKeys.add(key);
      if (key === "permissions" || key.startsWith("permissions.")) return null;
      // Remote TUI requires workspace roots to be configured on the server.
      if (key !== "sandbox_workspace_write" && key !== "sandbox_workspace_write.writable_roots") frontend.push("-c", entry);
    } else if (VALUES.has(flag)) {
      const entry = value();
      frontend.push(flag, entry);
      if (flag === "-s" || flag === "--sandbox") sandbox = entry;
      if (flag === "-a" || flag === "--ask-for-approval") approval = entry;
      if (flag === "-C" || flag === "--cd") cwd = resolve(entry);
      if (flag === "-m" || flag === "--model") backend.push("-c", `model=${JSON.stringify(entry)}`);
    } else {
      frontend.push(token);
      if (flag === "--approve-for-me") automatic = true;
      if (["--dangerously-bypass-approvals-and-sandbox", "--yolo", "-yolo"].includes(flag)) bypass = true;
      if (flag === "--search") backend.push("-c", 'web_search="live"');
      if (flag === "--strict-config") backend.push(flag);
      if (flag === "--enable" || flag === "--disable") {
        const entry = value();
        frontend.pop();
        frontend.push(flag, entry);
        backend.push(flag, entry);
      }
    }
  }
  if (automatic && (bypass || sandbox || approval)) throw new Error("Conflicting Codex permission modes.");
  if (bypass && approval) throw new Error("Conflicting Codex permission modes.");
  if (sandbox && !["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) throw new Error("Invalid Codex sandbox.");
  if (approval && !["on-request", "never"].includes(approval)) throw new Error("Invalid Codex approval policy.");
  if (automatic || bypass || sandbox) permissionKeys.add("sandbox_mode");
  if (automatic || bypass || approval) permissionKeys.add("approval_policy");
  if (automatic) permissionKeys.add("approvals_reviewer");
  if (automatic) backend.push("-c", 'approvals_reviewer="auto_review"', "-c", 'approval_policy="on-request"', "-c", 'sandbox_mode="workspace-write"');
  else {
    if (bypass || sandbox) backend.push("-c", `sandbox_mode=${JSON.stringify(bypass ? "danger-full-access" : sandbox)}`);
    if (bypass || approval) backend.push("-c", `approval_policy=${JSON.stringify(bypass ? "never" : approval)}`);
  }
  // shortcut: the stock remote picker cannot preserve a launch profile; use the original picker until its RPC supports this.
  if (resuming && !resumeThread) return null;
  return { frontend, backend, cwd, resumeThread, permissionKeys };
}

class CodexResumeError extends Error {
  constructor(stage, reason) {
    super(`CanvasTTY could not prepare the private Codex session (${stage}: ${reason}).`);
  }
}

export function codexSessionFailure(error) {
  return error instanceof CodexResumeError ? error.message
    : "CanvasTTY could not start the private Codex session. Check the CLI version and launch options.";
}

async function prepareResume(socket, configuration, signal) {
  if (!configuration.resumeThread || !configuration.permissionKeys.size) return;
  if (signal.aborted) throw new CodexResumeError("connect", "cancelled");
  const { Client, WebSocket, buildConnector } = requireRuntime("undici");
  // The Unix listener speaks WebSocket; app-server proxy relays bytes without framing them.
  const connect = buildConnector({ socketPath: socket });
  let connection;
  const client = new Client("http://localhost", {
    connect(options, callback) {
      connect(options, (error, connected) => {
        connection = connected;
        callback(error, connected);
      });
    }
  });
  let websocket, pending, connectionError;
  let stage = "connect";
  let nextId = 0;
  const fail = (reason) => {
    connectionError ??= new CodexResumeError(stage, reason);
    pending?.(connectionError);
  };
  const aborted = () => fail("cancelled");
  const disconnected = () => fail("connection closed");
  const wait = (send) => new Promise((resolveResult, reject) => {
    if (signal.aborted) return reject(new CodexResumeError(stage, "cancelled"));
    if (connectionError) return reject(connectionError);
    const timer = setTimeout(() => finish(new CodexResumeError(stage, "timed out")), 15_000);
    const finish = (error, result) => {
      clearTimeout(timer);
      pending = undefined;
      if (error) reject(error); else resolveResult(result);
    };
    pending = finish;
    try { send(); } catch { finish(new CodexResumeError(stage, "request could not be sent")); }
  });
  const opened = () => pending?.();
  const response = ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { fail("invalid response"); return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) { fail("invalid response"); return; }
    if (message.id !== nextId || "method" in message) return;
    if ("error" in message) fail(stage === "thread/resume"
      && message.error?.message === `thread ${configuration.resumeThread} already has an active writer`
      ? "conversation is already open in another Codex process" : "request rejected");
    else if (!("result" in message)) fail("invalid response");
    else pending?.(null, message.result);
  };
  const request = (method, params) => {
    stage = method;
    const id = ++nextId;
    return wait(() => websocket.send(JSON.stringify({ id, method, params })));
  };
  try {
    websocket = new WebSocket("ws://localhost/rpc", { dispatcher: client });
    websocket.addEventListener("open", opened, { once: true });
    websocket.addEventListener("message", response);
    websocket.addEventListener("error", disconnected);
    websocket.addEventListener("close", disconnected);
    signal.addEventListener("abort", aborted, { once: true });
    await wait(() => {});
    await request("initialize", { clientInfo: { name: "canvastty_session_launcher", version: "1.0" }, capabilities: { experimentalApi: true } });
    websocket.send(JSON.stringify({ method: "initialized", params: {} }));
    const result = await request("config/read", { cwd: configuration.cwd, includeLayers: false });
    const config = result?.config;
    const params = { threadId: configuration.resumeThread, excludeTurns: true };
    const names = { approval_policy: "approvalPolicy", approvals_reviewer: "approvalsReviewer", sandbox_mode: "sandbox" };
    for (const key of configuration.permissionKeys) {
      const source = key.startsWith("sandbox_workspace_write") ? "sandbox_workspace_write" : key;
      if (config?.[source] == null) throw new CodexResumeError(stage, "selected permissions were not resolved");
      if (names[key]) params[names[key]] = config[key];
      else params.config = { sandbox_workspace_write: config.sandbox_workspace_write };
    }
    const resumed = await request("thread/resume", params);
    if (resumed?.thread?.id !== configuration.resumeThread) throw new CodexResumeError(stage, "thread ID did not match");
  } catch (error) {
    throw error instanceof CodexResumeError ? error : new CodexResumeError(stage, "preparation failed");
  } finally {
    signal.removeEventListener("abort", aborted);
    if (websocket) {
      websocket.removeEventListener("open", opened);
      websocket.removeEventListener("message", response);
      websocket.removeEventListener("error", disconnected);
      websocket.removeEventListener("close", disconnected);
      websocket.close();
    }
    // Upgraded WebSockets no longer belong to the dispatcher; release them on cancellation too.
    connection?.destroy();
    await client.destroy();
  }
}

function childState(command, args, options) {
  const child = spawn(command, args, options);
  const state = { child, done: false };
  state.closed = new Promise(resolveExit => {
    child.once("error", () => { state.done = true; resolveExit(1); });
    child.once("exit", (code, signal) => {
      state.done = true;
      resolveExit(code ?? (128 + (constants.signals[signal] ?? 1)));
    });
  });
  return state;
}

async function listenerReady(socket) {
  // Codex publishes the socket after bind; a raw connection would fail its WebSocket handshake.
  try { return (await stat(socket)).isSocket(); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

async function stopChild(state, group = false, timeoutMs = STOP_TIMEOUT) {
  if (!state?.child.pid) return;
  const signal = kind => {
    try { process.kill(group ? -state.child.pid : state.child.pid, kind); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  if (group || !state.done) {
    signal("SIGTERM");
    // The owned group may still hold tools after its app-server process exits.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { process.kill(group ? -state.child.pid : state.child.pid, 0); }
      catch (error) { if (error.code === "ESRCH") return; throw error; }
      await delay(25);
    }
    signal("SIGKILL");
  }
  await state.closed;
}

/** The pipe belongs to the launcher; EOF also closes the backend after a launcher SIGKILL. */
async function runOwnedBackend(executable, args) {
  if (!isAbsolute(executable) || executable.includes("\0") || process.stdin.isTTY) {
    throw new Error("A Codex backend needs an absolute executable and a launcher pipe.");
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let stop;
  const disconnected = new Promise(resolveStop => { stop = resolveStop; });
  const handlers = new Map(["SIGTERM", "SIGHUP"].map(name => [name, () => stop(128 + constants.signals[name])]));
  const onEnd = () => stop(1);
  for (const [name, handler] of handlers) process.on(name, handler);
  process.stdin.once("end", onEnd);
  process.stdin.once("error", onEnd);
  process.stdin.resume();
  let backend;
  try {
    backend = childState(executable, args, { env, detached: true, stdio: ["ignore", "inherit", "inherit"] });
    return await Promise.race([backend.closed, disconnected]);
  } finally {
    try { await stopChild(backend, true); }
    finally {
      process.stdin.destroy();
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onEnd);
      for (const [name, handler] of handlers) process.removeListener(name, handler);
    }
  }
}

export async function runCodexSession(executable, args, environment = process.env) {
  if (!isAbsolute(executable) || executable.includes("\0")) throw new Error("Codex requires an absolute executable path.");
  let configuration = sessionArguments(args);
  const env = { ...environment };
  delete env.ELECTRON_RUN_AS_NODE;
  if (configuration && !(await supportsPrivateServer(executable, env))) configuration = null;
  let directory, backend, frontend, interrupted;
  const controller = new AbortController();
  let stop;
  const stopping = new Promise(resolveStop => { stop = resolveStop; });
  const handlers = new Map(["SIGTERM", "SIGHUP"].map(name => [name, () => {
    interrupted ??= 128 + constants.signals[name];
    controller.abort();
    stop();
  }]));
  // The PTY delivers Ctrl+C to the CLI as well; let it interrupt the current turn.
  handlers.set("SIGINT", () => {
    if (frontend && !frontend.done) return;
    interrupted ??= 130;
    controller.abort();
    stop();
  });
  for (const [name, handler] of handlers) process.on(name, handler);
  try {
    if (configuration === null) {
      frontend = childState(executable, args, { stdio: "inherit", env });
    } else {
      directory = await mkdtemp(join(tmpdir(), "ctty-tui-"));
      await chmod(directory, 0o700);
      const socket = join(directory, "rpc.sock");
      if (Buffer.byteLength(socket) > 100) throw new Error("Temporary folder is too long for a Codex Unix socket.");
      backend = childState(process.execPath, [fileURLToPath(import.meta.url), "--owned-backend", executable, "--",
        "app-server", "--listen", `unix://${socket}`, ...configuration.backend], {
        cwd: configuration.cwd, env: { ...env, ELECTRON_RUN_AS_NODE: "1", CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1" },
        detached: true, stdio: ["pipe", "pipe", "pipe"]
      });
      // Upstream diagnostics may contain private request context; drain without copying it.
      backend.child.stdout.resume();
      backend.child.stderr.resume();
      const deadline = Date.now() + 15_000;
      while (!interrupted && !backend.done && !(await listenerReady(socket))) {
        if (Date.now() >= deadline) throw new Error("Codex server did not become ready.");
        await delay(50);
      }
      if (interrupted) return interrupted;
      if (backend.done) throw new Error("Codex server exited during startup.");
      await chmod(socket, 0o600);
      await prepareResume(socket, configuration, controller.signal);
      if (interrupted) return interrupted;
      frontend = childState(executable, ["--remote", `unix://${socket}`, ...configuration.frontend], {
        cwd: configuration.cwd, env, stdio: "inherit"
      });
    }
    return await Promise.race([
      frontend.closed,
      ...(backend ? [backend.closed.then(() => 1)] : []),
      stopping.then(() => interrupted)
    ]);
  } catch (error) {
    if (interrupted) return interrupted;
    if (frontend) throw error;
    console.error(codexSessionFailure(error));
    return CODEX_STARTUP_FAILED_EXIT_CODE;
  } finally {
    try { await Promise.all([stopChild(frontend), stopChild(backend, false, STOP_TIMEOUT * 2)]); }
    finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      for (const [name, handler] of handlers) process.removeListener(name, handler);
    }
  }
}

export async function selfCheck() {
  const { default: assert } = await import("node:assert/strict");
  assert.equal(privateServerVersion("codex-cli 0.163.0\n"), true);
  assert.equal(privateServerVersion("codex-cli 0.160.1\n"), false);
  assert.equal(privateServerVersion("unexpected output"), false);
  const thread = "12345678-1234-4234-8234-123456789abc";
  const config = sessionArguments(["--no-daemon", "--approve-for-me", "-c", "hooks.Stop=[]", "resume", thread]);
  assert.deepEqual(config.frontend, ["--approve-for-me", "-c", "hooks.Stop=[]", "resume", thread]);
  assert.ok(config.backend.includes('approvals_reviewer="auto_review"'));
  assert.ok(config.backend.includes("hooks.Stop=[]"));
  assert.throws(() => sessionArguments(["--remote", "unix:///another.sock"]));
  assert.throws(() => sessionArguments(["--approve-for-me", "--sandbox", "read-only"]));
  assert.equal(sessionArguments(["--profile", "custom"]), null);
  assert.equal(sessionArguments(["--dangerously-bypass-hook-trust"]), null);
  assert.equal(sessionArguments(["--approve-for-me", "resume"]), null);
  assert.equal(config.resumeThread, thread);
  assert.deepEqual([...config.permissionKeys].sort(), ["approval_policy", "approvals_reviewer", "sandbox_mode"]);
  assert.equal(sessionArguments(["--add-dir", "/extra"]), null);
  const roots = sessionArguments(["-c", 'sandbox_workspace_write.writable_roots=["/other"]']);
  assert.deepEqual(roots.frontend, []);
  assert.ok(roots.backend.includes('sandbox_workspace_write.writable_roots=["/other"]'));
  if (process.platform === "win32") return;

  const { createServer } = await import("node:http");
  const { createHash } = await import("node:crypto");
  const directory = await mkdtemp(join(tmpdir(), "ctty-resume-check-"));
  const socket = join(directory, "rpc.sock");
  const server = createServer();
  const connections = new Set(), requests = [], fixtureErrors = [];
  let mode = "success", cancel;
  const frame = (value) => {
    const payload = Buffer.from(JSON.stringify(value));
    const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
    header[0] = 0x81;
    if (header.length === 2) header[1] = payload.length;
    else { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
    return Buffer.concat([header, payload]);
  };
  server.on("upgrade", (request, connection) => {
    const scenario = mode, received = [];
    requests.push(received);
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
    connection.on("error", () => {});
    if (scenario === "handshake") { connection.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); return; }
    const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    connection.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    connection.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      try {
        while (buffered.length >= 2) {
          const opcode = buffered[0] & 15;
          let length = buffered[1] & 127, offset = length === 126 ? 4 : 2;
          assert.notEqual(length, 127, "the fixture only accepts bounded RPC messages");
          if (buffered.length < offset) return;
          if (length === 126) length = buffered.readUInt16BE(2);
          assert.ok(buffered[1] & 128, "WebSocket clients must mask their frames");
          if (buffered.length < offset + 4 + length) return;
          const mask = buffered.subarray(offset, offset + 4);
          const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
          buffered = buffered.subarray(offset + 4 + length);
          if (opcode === 8) { connection.end(Buffer.from([0x88, 0])); return; }
          assert.equal(opcode, 1);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
          const message = JSON.parse(payload.toString());
          received.push(message);
          if (scenario === "closed") { connection.destroy(); return; }
          if (scenario === "cancelled") { cancel(); return; }
          if (!("id" in message)) continue;
          // Notifications and unrelated replies must not complete the pending RPC.
          connection.write(frame({ method: "configWarning", params: {} }));
          connection.write(frame({ id: 999, result: {} }));
          if (scenario === "rejected") { connection.write(frame({ id: message.id, error: { message: "PRIVATE SERVER DETAIL" } })); continue; }
          if (scenario === "writer-conflict" && message.method === "thread/resume") {
            connection.write(frame({ id: message.id, error: { message: `thread ${message.params.threadId} already has an active writer` } }));
            continue;
          }
          if (scenario === "invalid") { connection.write(frame(null)); continue; }
          const config = { approval_policy: "on-request", approvals_reviewer: "auto_review", sandbox_mode: "workspace-write",
            sandbox_workspace_write: { writable_roots: ["/other"] } };
          const result = message.method === "config/read" ? { config }
            : message.method === "thread/resume" ? { thread: { id: scenario === "mismatch" ? "other-thread" : message.params.threadId } } : {};
          connection.write(frame({ id: message.id, result }));
        }
      } catch (error) { fixtureErrors.push(error); connection.destroy(); }
    });
  });
  try {
    assert.equal(await listenerReady(socket), false);
    await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(socket, resolveListen); });
    assert.equal(await listenerReady(socket), true);
    const configuration = sessionArguments(["--approve-for-me", "-c", 'sandbox_workspace_write.writable_roots=["/other"]', "resume", thread]);
    await Promise.all([prepareResume(socket, configuration, new AbortController().signal),
      prepareResume(socket, configuration, new AbortController().signal)]);
    assert.equal(requests.length, 2, "each resume has its own WebSocket");
    for (const received of requests) {
      assert.deepEqual(received.map(value => value.method), ["initialize", "initialized", "config/read", "thread/resume"]);
      assert.deepEqual(received.at(-1).params, { threadId: thread, excludeTurns: true, approvalPolicy: "on-request",
        approvalsReviewer: "auto_review", sandbox: "workspace-write", config: { sandbox_workspace_write: { writable_roots: ["/other"] } } });
    }
    for (const [scenario, reason] of [["handshake", "connection closed"], ["closed", "connection closed"],
      ["rejected", "request rejected"], ["writer-conflict", "conversation is already open in another Codex process"],
      ["invalid", "invalid response"], ["mismatch", "thread ID did not match"], ["cancelled", "cancelled"]]) {
      mode = scenario;
      const controller = new AbortController();
      cancel = () => controller.abort();
      await assert.rejects(prepareResume(socket, configuration, controller.signal), error => {
        assert.ok(error instanceof CodexResumeError);
        const stage = mode === "handshake" ? "connect" : ["mismatch", "writer-conflict"].includes(mode) ? "thread/resume" : "initialize";
        assert.equal(error.message, `CanvasTTY could not prepare the private Codex session (${stage}: ${reason}).`);
        assert.ok(!codexSessionFailure(error).includes("PRIVATE SERVER DETAIL"));
        return true;
      });
    }
    const beforeSkipped = requests.length;
    await prepareResume(socket, sessionArguments([]), new AbortController().signal);
    await prepareResume(socket, sessionArguments(["resume", thread]), new AbortController().signal);
    await assert.rejects(prepareResume(socket, configuration, AbortSignal.abort()), /cancelled/);
    assert.equal(requests.length, beforeSkipped, "new, unchanged and cancelled sessions do not connect");
    assert.deepEqual(fixtureErrors, []);
    assert.ok(!codexSessionFailure(new Error("PRIVATE SERVER DETAIL")).includes("PRIVATE SERVER DETAIL"));
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  }

  const owned = childState(process.execPath, [fileURLToPath(import.meta.url), "--owned-backend", "/bin/sh", "--",
    "-c", 'trap "" TERM HUP; printf "%s\\n" "$$"; while :; do sleep 1; done'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detached: true, stdio: ["pipe", "pipe", "pipe"]
  });
  owned.child.stderr.resume();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Backend lifetime check timed out.")), 5_000); });
  try {
    const started = new Promise(resolveStarted => {
      let output = "";
      owned.child.stdout.on("data", data => {
        output += data.toString();
        if (output.includes("\n")) resolveStarted(Number(output.trim()));
      });
    });
    const pid = await Promise.race([started, timeout, owned.closed.then(() => { throw new Error("Backend exited before it was ready."); })]);
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    // Killing the launcher closes this same pipe, even though the supervisor is detached.
    owned.child.stdin.destroy();
    await Promise.race([owned.closed, timeout]);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "even a backend ignoring TERM must release its process after launcher EOF");
  } finally {
    clearTimeout(timer);
    await stopChild(owned, false, STOP_TIMEOUT * 2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "--self-check") await selfCheck();
    else {
      if (!["--backend", "--owned-backend"].includes(process.argv[2]) || process.argv[4] !== "--") throw new Error("Invalid launcher arguments.");
      process.exitCode = process.argv[2] === "--owned-backend"
        ? await runOwnedBackend(process.argv[3], process.argv.slice(5))
        : await runCodexSession(process.argv[3], process.argv.slice(5));
    }
  } catch (error) {
    if (process.argv[2] === "--self-check") console.error(error);
    else process.stderr.write(`${codexSessionFailure(error)}\n`);
    process.exitCode = 1;
  }
}
