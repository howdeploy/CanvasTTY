import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { NdjsonLineReader } from "./ndjson.mjs";
import { reportLifecycle } from "./runtime-client.mjs";
import { windowsBatchShellCommand } from "./windows-batch.mjs";
import { AGENT_RUNTIME_ENV, MAX_CHANNEL_MESSAGE_BYTES, normalizeThreadId, RUNTIME_PROTOCOL_VERSION } from "./runtime-protocol.mjs";

const recipe = JSON.parse(process.argv[2] ?? "null");
const provider = process.env[AGENT_RUNTIME_ENV.provider];
const name = provider === "kimi" ? "Kimi" : "Grok";
const address = process.env[AGENT_RUNTIME_ENV.address];
const sessionIdentity = {
  v: RUNTIME_PROTOCOL_VERSION, type: "channel-subscribe", provider,
  terminalSessionId: process.env[AGENT_RUNTIME_ENV.terminalSessionId],
  capabilityToken: process.env[AGENT_RUNTIME_ENV.capabilityToken]
};
if (!recipe || typeof recipe.executable !== "string" || !isAbsolute(recipe.executable)
  || !Array.isArray(recipe.args) || recipe.args.some(arg => typeof arg !== "string" || arg.includes("\0"))
  || !address || !sessionIdentity.terminalSessionId || !sessionIdentity.capabilityToken
  || !["grok", "kimi"].includes(provider)
  || !["native", "batch"].includes(recipe.launcher)
  || (recipe.launcher === "batch" && (typeof recipe.commandPrompt !== "string" || !isAbsolute(recipe.commandPrompt)))) {
  throw new Error(`${name} ACP requires a valid CanvasTTY runtime launch.`);
}

// Resume belongs to ACP session/load, never the TUI's interactive session picker.
const resumeFlags = provider === "kimi" ? ["--resume", "-r", "--session", "-S"] : ["--resume", "-r"];
const args = recipe.args.filter((arg, index, all) => !["--continue", "-c", ...resumeFlags].includes(arg)
  && !resumeFlags.includes(all[index - 1]));
let model = recipe.model;
if (provider === "kimi") {
  // Kimi's ACP command ignores root TUI flags. Only translate flags we can preserve through ACP.
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["--model", "-m"].includes(arg) && args[index + 1]) {
      const value = args[++index];
      model = recipe.model ?? value;
      continue;
    }
    if (!["--yolo", "-y", "--auto", "--plan"].includes(arg)) {
      throw new Error(`Kimi ACP cannot preserve launch option ${arg}; disable its ACP adapter for this launch.`);
    }
  }
}
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const childArgs = provider === "kimi" ? ["acp"] : ["--no-auto-update", ...args, "agent", "stdio"];
const batch = recipe.launcher === "batch";
const child = spawn(batch ? recipe.commandPrompt : recipe.executable,
  batch ? ["/d", "/s", "/c", windowsBatchShellCommand(recipe.executable, childArgs)] : childArgs,
  { env: environment, stdio: ["pipe", "pipe", "pipe"], ...(batch ? { windowsVerbatimArguments: true } : {}) });
const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
const pending = new Map();
const approvals = [];
let nextId = 1, sessionId, busy = false, stopped = false, runtimeSocket, activeTurnId, accepted = false;
let signals = Promise.resolve(true), activePrompt = Promise.resolve();
const plain = value => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
const print = text => {
  if (!process.stdout.write(plain(text))) { child.stdout.pause(); child.stderr.pause(); }
};
process.stdout.on("drain", () => { child.stdout.resume(); child.stderr.resume(); });
const showPrompt = () => { if (!stopped) { terminal.setPrompt(approvals.length ? "Permission > " : `${name} > `); terminal.prompt(); } };
const write = message => {
  if (child.stdin.destroyed) throw new Error(`${name} ACP connection is closed.`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};
const lifecycle = (state, event) => {
  const signal = { state, event, turnId: activeTurnId ?? null, threadId: sessionId };
  signals = signals.then(() => reportLifecycle(signal));
  return signals;
};
const acceptPrompt = () => {
  if (!busy || accepted) return;
  accepted = true;
  void lifecycle("working", "AcpPromptAccepted");
};
const request = (method, params, timeoutMs = 30_000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = timeoutMs ? setTimeout(() => { pending.delete(id); reject(new Error(`${name} ACP ${method} timed out.`)); }, timeoutMs) : null;
  pending.set(id, { resolve, reject, timer });
  try { write({ id, method, params }); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
});
const cancelPermissions = () => {
  for (const approval of approvals.splice(0)) write({ id: approval.id, result: { outcome: { outcome: "cancelled" } } });
};
const stop = (message, code = 0) => {
  if (stopped) return;
  stopped = true;
  if (message) print(`\n${message}\n`);
  try {
    cancelPermissions();
    if (sessionId) write({ method: "session/cancel", params: { sessionId } });
  } catch { /* The backend may have exited first. */ }
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`${name} ACP stopped.`)); }
  pending.clear();
  runtimeSocket?.destroy();
  terminal.close();
  child.kill();
  const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
  force.unref();
  child.once("exit", () => clearTimeout(force));
  process.exitCode = code;
};
const fail = error => stop(`${name} ACP: ${error instanceof Error ? error.message : error}`, 1);

function displayPermission(approval) {
  print(`\n${name} requests permission: ${approval.toolCall.kind ?? "tool"}\n${approval.toolCall.title ?? ""}\n`);
  if (approval.toolCall.rawInput !== undefined) print(`${JSON.stringify(approval.toolCall.rawInput, null, 2)}\n`);
  for (const content of approval.toolCall.content ?? []) {
    if (content.type === "content" && content.content?.type === "text") print(`${content.content.text}\n`);
    if (content.type === "diff") print(`${content.path}\n${content.oldText ?? ""}\n→\n${content.newText ?? ""}\n`);
  }
  for (const location of approval.toolCall.locations ?? []) print(`${location.path}\n`);
  approval.options.forEach((option, index) => print(`${index + 1}. ${option.name} [${option.kind}]\n`));
  print("Choose a number and press Enter. Ctrl+C cancels the turn.\n");
  showPrompt();
}

async function prompt(text, deliveryId) {
  if (!sessionId || busy || approvals.length) throw new Error(`${name} ACP is not ready for another prompt.`);
  if (Buffer.byteLength(text, "utf8") > MAX_CHANNEL_MESSAGE_BYTES) throw new Error(`${name} ACP prompt exceeds the 512 KiB limit.`);
  busy = true;
  accepted = false;
  activeTurnId = randomUUID();
  print(`\nYou: ${text}\n\n`);
  try {
    if (!await lifecycle("working", "AcpPromptStart")) throw new Error("CanvasTTY could not record the ACP turn start.");
    const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, 0);
    if (!result || typeof result.stopReason !== "string") throw new Error("Invalid ACP prompt response.");
  } catch (error) {
    print(`\n${name} ACP task failed: ${error.message}\n`);
  } finally {
    cancelPermissions();
    busy = false;
    await lifecycle("idle", "Stop");
    if (deliveryId && runtimeSocket && !runtimeSocket.destroyed) {
      runtimeSocket.write(`${JSON.stringify({ v: RUNTIME_PROTOCOL_VERSION, type: "channel-forwarded", id: deliveryId })}\n`);
    }
    if (!stopped) { print("\n"); showPrompt(); }
  }
}

function onMessage(message) {
  if (!message || message.jsonrpc !== "2.0") throw new Error("Invalid ACP JSON-RPC message.");
  if (typeof message.method === "string") {
    if (message.method === "session/request_permission" && message.id !== undefined) {
      const params = message.params;
      if (!params || !normalizeThreadId(provider, params.sessionId) || (sessionId && params.sessionId !== sessionId)
        || !params.toolCall || typeof params.toolCall !== "object" || Array.isArray(params.toolCall) || !Array.isArray(params.options)
        || params.options.length === 0 || params.options.length > 16 || approvals.length >= 8
        || approvals.some(approval => approval.id === message.id)
        || Buffer.byteLength(JSON.stringify(params)) > 64 * 1024
        || params.options.some(option => !option || typeof option.optionId !== "string" || !option.optionId || typeof option.name !== "string"
          || !["allow_once", "allow_always", "reject_once", "reject_always"].includes(option.kind))) {
        write({ id: message.id, result: { outcome: { outcome: "cancelled" } } });
        throw new Error("Invalid or oversized ACP permission request; it was not approved.");
      }
      approvals.push({ id: message.id, ...params });
      acceptPrompt();
      void lifecycle("needs_approval", "PermissionRequest");
      if (approvals.length === 1) displayPermission(approvals[0]);
    } else if (message.method === "session/update") {
      if (sessionId && message.params?.sessionId !== sessionId) return;
      const update = message.params?.update;
      if (["agent_message_chunk", "tool_call"].includes(update?.sessionUpdate)) acceptPrompt();
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") {
        print(update.content.text);
      } else if (update?.sessionUpdate === "tool_call") {
        print(`\n[${update.kind ?? "tool"}] ${update.title ?? ""}\n`);
      }
    } else if (message.id !== undefined) {
      // The agent runs its own filesystem and terminals; no client-side execution surface is advertised.
      write({ id: message.id, error: { code: -32601, message: "CanvasTTY ACP client does not implement this method." } });
    }
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timer);
  if (message.error) waiter.reject(new Error(`${message.error.message ?? "ACP error"}${message.error.data ? `: ${JSON.stringify(message.error.data)}` : ""}`));
  else waiter.resolve(message.result);
}

const lines = new NdjsonLineReader({ maxLineBytes: 8 * 1024 * 1024 });
child.stdout.on("data", chunk => {
  try { for (const line of lines.push(chunk)) if (line.length) onMessage(JSON.parse(line.toString("utf8"))); }
  catch (error) { fail(error); }
});
child.stderr.on("data", chunk => print(chunk.toString("utf8")));
child.on("error", error => fail(new Error(`Could not launch ${name}: ${error.message}`)));
child.stdin.on("error", fail);
child.on("exit", (code, signal) => { if (!stopped) stop(`${name} ACP backend exited (${signal ?? code}). Check ${name} login and ACP support.`, code || 1); });
process.stdout.on("error", fail);
terminal.on("line", line => {
  if (stopped || !line.trim()) return showPrompt();
  if (approvals.length) {
    const approval = approvals[0];
    const index = /^\d{1,2}$/.test(line.trim()) ? Number(line.trim()) - 1 : -1;
    if (!approval.options[index]) { print("Choose one of the displayed numbers.\n"); return showPrompt(); }
    approvals.shift();
    write({ id: approval.id, result: { outcome: { outcome: "selected", optionId: approval.options[index].optionId } } });
    if (approvals.length) displayPermission(approvals[0]);
    else { void lifecycle("working", "PostToolUse"); print("\n"); }
  } else if (busy || !sessionId) {
    print(`${name} ACP is busy or still connecting; this text was not sent.\n`);
  } else {
    activePrompt = prompt(line);
    void activePrompt.catch(fail);
  }
});
const cancelTurn = () => {
  if (!sessionId) return stop(`${name} ACP startup cancelled.`);
  if (!busy && !approvals.length) return stop();
  cancelPermissions();
  write({ method: "session/cancel", params: { sessionId } });
  print("\nCancelling the current turn…\n");
};
terminal.on("SIGINT", cancelTurn);
process.on("SIGINT", cancelTurn);
terminal.on("close", () => { if (!stopped) stop(); });
for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => stop());

async function start() {
  print(`${provider === "grok" ? "Grok Build" : name} · CanvasTTY ACP\nConnecting…\n`);
  const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "canvastty", version: "1.0.0" } });
  if (init?.protocolVersion !== 1) throw new Error(`${name} does not support ACP v1.`);
  const methods = new Set((init.authMethods ?? []).map(method => method.id));
  const methodId = provider === "kimi" ? (methods.has("login") ? "login" : null)
    : environment.XAI_API_KEY && methods.has("xai.api_key") ? "xai.api_key" : methods.has("cached_token") ? "cached_token" : null;
  if (methodId) await request("authenticate", { methodId, _meta: { headless: true } });
  else if (methods.size) throw new Error(`No supported ${name} authentication method. Run ${provider} login in this account profile first.`);
  let resume = recipe.resume;
  if (resume === true) {
    const listed = await request("session/list", { cwd: process.cwd() });
    resume = (listed.sessions ?? []).filter(item => item.cwd === process.cwd())
      .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0]?.sessionId;
    if (!resume) throw new Error(`No ${name} session found for this folder; start a new card instead of continuing.`);
  }
  const meta = provider === "grok"
    ? { "x.ai/restore_code": false, ...(recipe.profile !== "normal" ? { yoloMode: recipe.profile === "yolo", autoMode: recipe.profile === "auto" } : {}) }
    : undefined;
  const session = await request(resume ? "session/load" : "session/new", {
    cwd: process.cwd(), mcpServers: [], ...(meta ? { _meta: meta } : {}), ...(resume ? { sessionId: resume } : {})
  });
  sessionId = normalizeThreadId(provider, session.sessionId ?? resume);
  if (!sessionId) throw new Error(`${name} returned an invalid session identity.`);
  if (provider === "kimi") {
    const modeId = { normal: "default", plan: "plan", auto: "auto", yolo: "yolo" }[recipe.profile];
    if (!modeId) throw new Error(`Kimi ACP does not support the ${recipe.profile} profile.`);
    await request("session/set_mode", { sessionId, modeId });
  } else if (recipe.profile === "plan") await request("session/set_mode", { sessionId, modeId: "plan" });
  if (model) await request("session/set_model", { sessionId, modelId: model });
  if (recipe.effort) await request("session/set_config_option", { sessionId, configId: provider === "kimi" ? "thinking" : "reasoning_effort", value: recipe.effort });
  if (!await lifecycle("idle", "SessionStart")) throw new Error(`CanvasTTY could not register the ${name} ACP session.`);
  const socket = runtimeSocket = connect(address);
  const input = new NdjsonLineReader({ maxLineBytes: MAX_CHANNEL_MESSAGE_BYTES });
  socket.on("connect", () => socket.write(`${JSON.stringify(sessionIdentity)}\n`));
  socket.on("data", chunk => {
    try {
      for (const line of input.push(chunk)) {
        const event = JSON.parse(line.toString("utf8"));
        if (event.v !== RUNTIME_PROTOCOL_VERSION) throw new Error("Invalid CanvasTTY runtime version.");
        if (event.type === "channel-connected") continue;
        if (event.type !== "channel-prompt" || typeof event.text !== "string" || !/^[a-f0-9]{32}$/.test(event.id)) throw new Error("Invalid CanvasTTY task.");
        activePrompt = activePrompt.then(() => prompt(event.text, event.id));
        void activePrompt.catch(fail);
      }
    } catch (error) { fail(error); }
  });
  socket.on("error", () => socket.destroy());
  socket.on("close", () => { if (!stopped) print("\nACP task delivery disconnected or disabled. Manual input remains available; restart the card to reconnect.\n"); });
  print(`Session: ${sessionId}\n`);
  showPrompt();
}
void start().catch(fail);
