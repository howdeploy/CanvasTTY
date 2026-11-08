import { createInterface } from "node:readline";

const kimi = process.env.CANVASTTY_RUNTIME_PROVIDER === "kimi";
if (process.argv.includes("--resume") || process.argv.includes("--continue") || process.argv.includes("--session")
  || (kimi ? process.argv.slice(2).join(" ") !== "acp" : process.argv.slice(-2).join(" ") !== "agent stdio")) {
  throw new Error("ACP backend received TUI resume arguments or the wrong subcommand");
}

const sessionId = "11111111-2222-4333-8444-555555555555";
const input = createInterface({ input: process.stdin });
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let promptId, approval = 0;
const decisions = [];
function permission() {
  approval++;
  send({ id: `permission-${approval}`, method: "session/request_permission", params: {
    sessionId, toolCall: { toolCallId: `tool-${approval}`, title: `command ${approval}`, kind: "execute", rawInput: { command: `echo ${approval}` } },
    options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Reject", kind: "reject_once" }]
  } });
}
function answer(text) {
  send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
  send({ id: promptId, result: { stopReason: "end_turn" } });
}
input.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    if (process.env.ELECTRON_RUN_AS_NODE) throw new Error("Electron process mode leaked into Grok");
    if (request.params.clientCapabilities.fs || request.params.clientCapabilities.terminal) throw new Error("Unsupported client capability advertised");
    send({ id: request.id, result: { protocolVersion: 1, authMethods: [{ id: kimi ? "login" : "cached_token" }], agentCapabilities: { loadSession: true } } });
  } else if (request.method === "authenticate") {
    if (request.params.methodId !== (kimi ? "login" : "cached_token")) throw new Error("Wrong ACP authentication method");
    if (process.env.GROK_ACP_TEST_AUTH_ERROR === "1") send({ id: request.id, error: { code: -32000, message: "Login required" } });
    else send({ id: request.id, result: {} });
  } else if (request.method === "session/list") {
    send({ id: request.id, result: { sessions: [{ sessionId, cwd: process.cwd(), updatedAt: "2026-11-08T15:00:00Z" }] } });
  } else if (["session/new", "session/load"].includes(request.method)) {
    if (kimi ? request.params._meta !== undefined : request.params._meta["x.ai/restore_code"] !== false) throw new Error("Wrong provider session metadata");
    if (request.method === "session/load") process.stderr.write(`loaded:${request.params.sessionId}\n`);
    send({ id: request.id, result: { sessionId } });
  } else if (request.method === "session/set_model") {
    process.stderr.write(`model:${request.params.modelId}\n`);
    send({ id: request.id, result: {} });
  } else if (request.method === "session/set_mode") {
    if (kimi && !["default", "plan", "auto", "yolo"].includes(request.params.modeId)) throw new Error("Wrong Kimi permission mode");
    process.stderr.write(`mode:${request.params.modeId}\n`);
    send({ id: request.id, result: {} });
  } else if (request.method === "session/set_config_option") {
    process.stderr.write(`effort:${request.params.value}\n`);
    send({ id: request.id, result: {} });
  } else if (request.method === "session/prompt") {
    promptId = request.id;
    const text = request.params.prompt[0].text;
    if (text === "permissions") { approval = 0; decisions.length = 0; permission(); }
    else if (text === "error") send({ id: promptId, error: { code: -32000, message: "Prompt rejected" } });
    else if (text === "malformed") send({ id: 99, method: "session/request_permission", params: { sessionId, options: [] } });
    else answer(`received:${text}`);
  } else if (request.method === "session/cancel") {
    if (promptId) send({ id: promptId, result: { stopReason: "cancelled" } });
  } else if (request.method) send({ id: request.id, result: {} });
  else if (String(request.id).startsWith("permission-")) {
    decisions.push(request.result.outcome);
    if (request.result.outcome.outcome === "cancelled") return;
    if (approval === 1) permission();
    else answer(`decisions:${decisions.map(item => item.optionId).join(",")}`);
  }
});
