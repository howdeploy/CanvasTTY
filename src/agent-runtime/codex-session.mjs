import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { constants, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const STOP_TIMEOUT = 750;
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

async function prepareResume(executable, socket, configuration, env, signal) {
  if (!configuration.resumeThread || !configuration.permissionKeys.size) return;
  signal.throwIfAborted();
  // The official proxy supplies NDJSON over stdio for the private Unix WebSocket.
  const proxy = childState(executable, ["app-server", "proxy", "--sock", socket], {
    cwd: configuration.cwd, env, stdio: ["pipe", "pipe", "pipe"]
  });
  proxy.child.stderr.resume();
  proxy.child.stdin.on("error", () => {});
  const lines = createInterface({ input: proxy.child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 0;
  const rejectPending = () => { for (const reject of pending.values()) reject(new Error("Codex resume preparation disconnected.")); };
  proxy.closed.then(rejectPending);
  signal.addEventListener("abort", rejectPending);
  const request = (method, params) => new Promise((resolveResult, reject) => {
    signal.throwIfAborted();
    const id = ++nextId;
    const timer = setTimeout(() => finish(new Error("Codex resume preparation timed out.")), 15_000);
    const response = line => {
      let message;
      try { message = JSON.parse(line); } catch { finish(new Error("Invalid Codex response.")); return; }
      if (message.id === id && !("method" in message)) finish(message.error ? new Error("Codex rejected resume preparation.") : null, message.result);
    };
    const finish = (error, result) => {
      clearTimeout(timer);
      lines.removeListener("line", response);
      pending.delete(id);
      if (error) reject(error); else resolveResult(result);
    };
    pending.set(id, error => finish(error));
    lines.on("line", response);
    proxy.child.stdin.write(JSON.stringify({ id, method, params }) + "\n", error => { if (error) finish(error); });
  });
  try {
    await request("initialize", { clientInfo: { name: "canvastty_session_launcher", version: "1.0" }, capabilities: { experimentalApi: true } });
    proxy.child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const { config } = await request("config/read", { cwd: configuration.cwd, includeLayers: false });
    const params = { threadId: configuration.resumeThread, excludeTurns: true };
    const names = { approval_policy: "approvalPolicy", approvals_reviewer: "approvalsReviewer", sandbox_mode: "sandbox" };
    for (const key of configuration.permissionKeys) {
      const source = key.startsWith("sandbox_workspace_write") ? "sandbox_workspace_write" : key;
      if (config?.[source] == null) throw new Error("Codex did not resolve the selected launch permissions.");
      if (names[key]) params[names[key]] = config[key];
      else params.config = { sandbox_workspace_write: config.sandbox_workspace_write };
    }
    const result = await request("thread/resume", params);
    if (result?.thread?.id !== configuration.resumeThread) throw new Error("Codex resumed a different thread.");
  } finally {
    signal.removeEventListener("abort", rejectPending);
    lines.close();
    await stopChild(proxy);
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

function listenerReady(socket) {
  return new Promise(resolveReady => {
    const connection = createConnection(socket);
    const finish = result => { connection.destroy(); resolveReady(result); };
    connection.once("connect", () => finish(true));
    connection.once("error", () => finish(false));
    connection.setTimeout(200, () => finish(false));
  });
}

async function stopChild(state, group = false) {
  if (!state?.child.pid) return;
  const signal = kind => {
    try { process.kill(group ? -state.child.pid : state.child.pid, kind); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  if (group || !state.done) {
    signal("SIGTERM");
    // The owned group may still hold tools after its app-server process exits.
    const deadline = Date.now() + STOP_TIMEOUT;
    while (Date.now() < deadline) {
      try { process.kill(group ? -state.child.pid : state.child.pid, 0); }
      catch (error) { if (error.code === "ESRCH") return; throw error; }
      await delay(25);
    }
    signal("SIGKILL");
  }
  await state.closed;
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
      backend = childState(executable, ["app-server", "--listen", `unix://${socket}`, ...configuration.backend], {
        cwd: configuration.cwd, env: { ...env, CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1" },
        detached: true, stdio: ["ignore", "pipe", "pipe"]
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
      await prepareResume(executable, socket, configuration, env, controller.signal);
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
  } finally {
    try { await Promise.all([stopChild(frontend), stopChild(backend, true)]); }
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "--self-check") await selfCheck();
    else {
      if (process.argv[2] !== "--backend" || process.argv[4] !== "--") throw new Error("Invalid launcher arguments.");
      process.exitCode = await runCodexSession(process.argv[3], process.argv.slice(5));
    }
  } catch {
    process.stderr.write("CanvasTTY could not start the private Codex session. Check the CLI version and launch options.\n");
    process.exitCode = 1;
  }
}
