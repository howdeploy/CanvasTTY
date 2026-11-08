import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SettingsStore, normalizeSettings } from "../src/main/services/SettingsStore.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { AgentRuntimeBridge } from "../src/main/services/agent-runtime/AgentRuntimeBridge.ts";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import { AgentBrowserBridge } from "../src/main/services/agent-browser/AgentBrowserBridge.ts";
import { claudeMcpArgs } from "../src/main/services/agent-browser/ProviderLaunch.ts";
import { NdjsonLineReader } from "../src/agent-runtime/ndjson.mjs";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const helper = { command: process.execPath, args: [fileURLToPath(new URL("../src/agent-runtime/claude-channel.mjs", import.meta.url))] };
const posix = { skip: process.platform === "win32" ? "Uses a Unix socket; Windows uses the existing pipe transport." : false };
const until = async (condition) => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Channel did not reach the expected state");
};

async function fixture(t, enabled = true) {
  const root = await mkdtemp("/tmp/ctty-ch-");
  const gateway = new RuntimeGateway({ runtimeDirectory: join(root, "runtime") });
  const children = [];
  let manager;
  t.after(async () => {
    manager?.disposeAll();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
    await gateway.close();
    await rm(root, { recursive: true, force: true });
  });
  await gateway.start();
  const runtime = new AgentRuntimeBridge(gateway, { runtimeDirectory: root, helper,
    openCodePluginPath: fileURLToPath(new URL("../src/agent-runtime/opencode-plugin.mjs", import.meta.url)),
    claudeChannelHelper: helper, coreHooksEnabled: false, claudeCodeMcpEnabled: enabled });
  const registry = availableRegistry();
  const browser = new AgentBrowserBridge({ isEnabled: false }, { runtimeDirectory: root, helper, orchestrationHelper: helper, providerClis: registry });
  const calls = [], writes = [];
  manager = new TerminalManager(() => {}, registry, browser, runtime, true, fakeSpawner(calls, { onWrite: data => writes.push(data) }));
  const create = (provider = "claude", role = "agent") => manager.create({ provider, role, cwd: root, profile: "normal", position: { x: 0, y: 0 } });
  const client = () => {
    const child = spawn(helper.command, helper.args, { env: calls.at(-1).options.env, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    const messages = [], reader = new NdjsonLineReader({ maxLineBytes: 512 * 1024 });
    child.stdout.on("data", chunk => { for (const line of reader.push(chunk)) messages.push(JSON.parse(line.toString())); });
    child.stderr.resume();
    const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    return { child, messages, send, ready: () => send({ method: "notifications/initialized" }) };
  };
  return { root, gateway, runtime, manager, calls, writes, create, client };
}

test("Claude MCP is opt-in, survives reload and rejects malformed persisted values", async t => {
  const root = await mkdtemp(join(tmpdir(), "ctty-ch-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SettingsStore(root, "en-US");
  await store.load();
  assert.equal(store.get().claudeCodeMcpEnabled, false);
  for (const enabled of [true, false]) {
    await store.update({ claudeCodeMcpEnabled: enabled });
    const next = new SettingsStore(root, "en-US");
    await next.load();
    assert.equal(next.get().claudeCodeMcpEnabled, enabled);
  }
  const old = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
  delete old.claudeCodeMcpEnabled;
  await writeFile(join(root, "settings.json"), JSON.stringify(old));
  const migrated = new SettingsStore(root, "en-US");
  await migrated.load();
  assert.equal(migrated.get().claudeCodeMcpEnabled, false);
  assert.equal(normalizeSettings({ ...old, claudeCodeMcpEnabled: "true" }, store.get()).claudeCodeMcpEnabled, false);
});

test("channel launch preserves browser and orchestration MCP servers without granting approval tools", () => {
  const args = claudeMcpArgs(helper, helper, helper);
  assert.deepEqual(Object.keys(JSON.parse(args[1]).mcpServers).sort(), ["canvastty_agents", "canvastty_browser", "canvastty_input"]);
  assert.ok(args.includes("--dangerously-load-development-channels"));
  assert.ok(args.includes("server:canvastty_input"));
  assert.deepEqual(args.slice(args.indexOf("--allowedTools")), ["--allowedTools", "mcp__canvastty_browser__*"]);
  assert.equal(claudeMcpArgs(helper).includes("--dangerously-load-development-channels"), false);
});

test("all Claude card launches get the channel with browser access off; other providers and opt-out do not", posix, async t => {
  const f = await fixture(t);
  for (const role of ["agent", "orchestrator"]) {
    f.create("claude", role);
    const args = f.calls.at(-1).args;
    assert.ok(args.includes("server:canvastty_input"));
    const servers = JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers;
    assert.ok(servers.canvastty_input);
    assert.equal(Boolean(servers.canvastty_agents), role === "orchestrator");
    assert.equal(servers.canvastty_browser, undefined);
  }
  f.create("codex");
  assert.equal(f.calls.at(-1).args.includes("--dangerously-load-development-channels"), false);
  f.runtime.setClaudeCodeMcpEnabled(false);
  f.create();
  assert.equal(f.calls.at(-1).args.includes("--dangerously-load-development-channels"), false);
});

test("initialized MCP forwards exact Unicode tasks without a composer or Enter, and keeps acceptance unconfirmed", posix, async t => {
  const f = await fixture(t);
  const session = f.create();
  const client = f.client();
  await until(() => client.messages.length > 0);
  assert.deepEqual(client.messages[0].result.capabilities, { experimental: { "claude/channel": {} } });
  const pending = f.manager.deliverPrompt(session.id, "Задача\nsecond line 🐈", true, undefined, { waitMs: 1_000 });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(client.messages.some(message => message.method === "notifications/claude/channel"), false);
  f.manager.input(session.id, "\x1b[I");
  client.ready();
  const delivered = await pending;
  assert.equal(delivered.receipt.stage, "submitted");
  assert.equal(delivered.receipt.acceptance, "unconfirmed");
  await until(() => client.messages.some(message => message.method === "notifications/claude/channel"));
  assert.equal(client.messages.at(-1).params.content, "Задача\nsecond line 🐈");
  assert.deepEqual(f.writes, ["\x1b[I"]);
  assert.equal((await f.manager.deliverPrompt(session.id, "follow-up", true, undefined, { waitMs: 1_000 })).delivered, true);
  await until(() => client.messages.at(-1).params?.content === "follow-up");
});

test("channel cancellation, disable and native approval never fall back to terminal input", posix, async t => {
  const f = await fixture(t);
  const session = f.create();
  const controller = new AbortController();
  const pending = f.manager.deliverPrompt(session.id, "cancelled", true, controller.signal, { waitMs: 1_000 });
  controller.abort();
  assert.equal((await pending).delivered, false);
  f.runtime.setClaudeCodeMcpEnabled(false);
  f.runtime.setClaudeCodeMcpEnabled(true);
  const result = await f.manager.deliverPrompt(session.id, "revoked", true, undefined, { waitMs: 1_000 });
  assert.equal(result.delivered, false);
  assert.match(result.reason, /disabled or revoked/);
  const active = f.create();
  f.manager.applyProviderSignal(active.id, { kind: "lifecycle", state: "needs_approval", event: "PermissionRequest" });
  assert.equal((await f.manager.deliverPrompt(active.id, "blocked", true, undefined, { waitMs: 1_000 })).delivered, false);
  assert.deepEqual(f.writes, []);
});

test("a different session's capability cannot subscribe, and stale cleanup cannot revoke a replacement", posix, async t => {
  const f = await fixture(t);
  const a = f.gateway.registerSession("a", "claude", false, undefined, false, undefined, false, true);
  const b = f.gateway.registerSession("b", "claude", false, undefined, false, undefined, false, true);
  const channel = f.gateway.promptChannel(a);
  const intruder = connect(a.address);
  const closed = once(intruder, "close");
  intruder.on("error", () => {});
  intruder.write(`${JSON.stringify({ v: 1, type: "channel-subscribe", terminalSessionId: "a", provider: "claude", capabilityToken: b.capabilityToken })}\n`);
  await closed;
  assert.equal(channel.ready(), false);
  const replacement = f.gateway.registerSession("a", "claude", false, undefined, false, undefined, false, true);
  f.gateway.revokeTerminalSession("a", a.capabilityToken);
  assert.equal(f.gateway.promptChannel(replacement).ready(), false);
  assert.throws(() => channel.send("stale"), /disabled or revoked/);
});

test("channel bounds each message and permits one unacknowledged write, then revokes an uncertain disconnected delivery", posix, async t => {
  const f = await fixture(t);
  const capability = f.gateway.registerSession("bounded", "claude", false, undefined, false, undefined, false, true);
  const channel = f.gateway.promptChannel(capability);
  const socket = connect(capability.address);
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  const messages = [], reader = new NdjsonLineReader({ maxLineBytes: 512 * 1024 });
  socket.on("data", chunk => { for (const line of reader.push(chunk)) messages.push(JSON.parse(line.toString())); });
  socket.write(`${JSON.stringify({ v: 1, type: "channel-subscribe", terminalSessionId: "bounded", provider: "claude", capabilityToken: capability.capabilityToken })}\n`);
  await until(() => channel.ready());
  assert.throws(() => channel.send("x".repeat(512 * 1024)), /message limit/);
  assert.equal(channel.ready(), true);
  channel.send("first");
  assert.equal(channel.ready(), false);
  assert.throws(() => channel.send("second"), /not ready/);
  await until(() => messages.some(message => message.type === "channel-prompt"));
  assert.equal(messages.at(-1).text, "first");
  socket.destroy();
  await until(() => { try { channel.ready(); return false; } catch { return true; } });
  assert.throws(() => channel.send("retry"), /disabled or revoked/);
});
