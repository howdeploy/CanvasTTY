import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentRuntimeBridge } from "../src/main/services/agent-runtime/AgentRuntimeBridge.ts";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import { SettingsStore, normalizeSettings } from "../src/main/services/SettingsStore.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

for (const provider of ["grok", "kimi"]) {
const flag = `${provider}AcpEnabled`;
const helper = { command: process.execPath, args: [fileURLToPath(new URL(`../src/agent-runtime/${provider}-acp.mjs`, import.meta.url))], env: { ELECTRON_RUN_AS_NODE: "1" } };
const posix = { skip: process.platform === "win32" ? "Uses a Unix socket and an executable fake Grok; Windows uses the existing pipe and batch adapters." : false };
const until = async condition => {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("ACP did not reach the expected state");
};

async function fixture(t, enabled = true, authError = false) {
  const root = await mkdtemp("/tmp/ctty-acp-");
  const executable = join(root, provider);
  const source = await readFile(new URL("fixtures/grok-acp-agent.mjs", import.meta.url), "utf8");
  await writeFile(executable, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  const children = [], calls = [], writes = [];
  let manager;
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: join(root, "runtime"), onSignal: (id, signal) => {
    signals.push(signal);
    manager?.applyProviderSignal(id, { kind: "lifecycle", ...signal });
  } });
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
  const base = availableRegistry();
  const homeKey = provider === "grok" ? "GROK_HOME" : "KIMI_CODE_HOME";
  const registry = { ...base, get: id => id === provider ? { ...base.get(id), executable,
    environment: { PATH: process.env.PATH, [homeKey]: join(root, "account"), ...(authError ? { GROK_ACP_TEST_AUTH_ERROR: "1" } : {}) } } : base.get(id) };
  const runtime = new AgentRuntimeBridge(gateway, { runtimeDirectory: root,
    helper: { command: process.execPath, args: [fileURLToPath(new URL("../src/agent-runtime/hook-helper.mjs", import.meta.url))] },
    openCodePluginPath: fileURLToPath(new URL("../src/agent-runtime/opencode-plugin.mjs", import.meta.url)),
    grokHomeDirectory: join(root, "grok-home"), kimiHomeDirectory: join(root, "kimi-home"),
    [`${provider}AcpHelper`]: helper, [flag]: enabled });
  manager = new TerminalManager(() => {}, registry, undefined, runtime, true, fakeSpawner(calls, { onWrite: data => writes.push(data) }));
  const create = (extra = {}) => {
    const session = manager.create({ provider, cwd: root, profile: "normal", position: { x: 0, y: 0 }, ...extra });
    manager.resize(session.id, 80, 24);
    return session;
  };
  const launch = () => {
    const call = calls.at(-1);
    const child = spawn(call.command, call.args, { cwd: root, env: call.options.env, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    return { child, output: () => output };
  };
  const idle = id => manager.list().find(session => session.id === id)?.status === "idle";
  return { root, manager, gateway, runtime, calls, writes, signals, create, launch, idle, homeKey,
    setEnabled: value => runtime[provider === "grok" ? "setGrokAcpEnabled" : "setKimiAcpEnabled"](value) };
}

test(`${provider} ACP defaults off and persists independently from the other transports`, async t => {
  const root = await mkdtemp(join(tmpdir(), "ctty-acp-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SettingsStore(root, "en-US");
  await store.load();
  assert.equal(store.get()[flag], false);
  await store.update({ [flag]: true, claudeCodeMcpEnabled: false });
  const reloaded = new SettingsStore(root, "en-US");
  await reloaded.load();
  assert.equal(reloaded.get()[flag], true);
  assert.equal(reloaded.get().claudeCodeMcpEnabled, false);
  assert.equal(reloaded.get()[provider === "grok" ? "kimiAcpEnabled" : "grokAcpEnabled"], false);
  for (const invalid of [undefined, "true", 1]) assert.equal(normalizeSettings({ ...store.get(), [flag]: invalid }, store.get())[flag], false);
  await store.update({ [flag]: false });
  assert.equal(store.get()[flag], false);
});

test(`${provider}: opt-in selects ACP; opt-out preserves the native launch and restart reads the current switch`, posix, async t => {
  const f = await fixture(t, false);
  const session = f.create();
  assert.notEqual(f.calls.at(-1).command, helper.command);
  f.calls.at(-1).process.emitExit(0);
  f.setEnabled(true);
  f.manager.restart(session.id);
  f.manager.resize(session.id, 80, 24);
  assert.equal(f.calls.at(-1).command, helper.command);
  assert.equal(f.calls.at(-1).args[0], helper.args[0]);
  assert.equal(f.calls.at(-1).options.env[f.homeKey], join(f.root, "account"));
});

test(`${provider}: ACP sends exact repeated tasks without Enter, confirms acceptance and displays answers`, posix, async t => {
  const f = await fixture(t);
  const session = f.create();
  const adapter = f.launch();
  await until(() => adapter.output().includes("Session:"));
  assert.equal(f.idle(session.id), true);
  const delivered = await f.manager.deliverPrompt(session.id, "задача\nline 2 🐈", true, undefined, { waitMs: 1_000 });
  assert.equal(delivered.delivered, true);
  await until(() => f.signals.some(signal => signal.event === "Stop"));
  assert.equal(f.manager.lastPromptDelivery(session.id).acceptance, "confirmed");
  assert.match(adapter.output(), /received:задача\nline 2 🐈/);
  for (const text of ['Привет, «Ёж» 🦔\nC:\\Temp\\folder with spaces', "follow-up"]) {
    const previousStops = f.signals.filter(signal => signal.event === "Stop").length;
    await until(() => f.idle(session.id));
    const next = await f.manager.deliverPrompt(session.id, text, true, undefined, { waitMs: 1_000 });
    assert.equal(next.delivered, true);
    await until(() => f.signals.filter(signal => signal.event === "Stop").length > previousStops);
    assert.ok(adapter.output().includes(`received:${text}`));
  }
  assert.deepEqual(f.writes, []);
});

test(`${provider}: successive permissions require separate manual answers; orchestrator prompts cannot answer`, posix, async t => {
  const f = await fixture(t);
  const session = f.create();
  const adapter = f.launch();
  await until(() => adapter.output().includes("Session:"));
  await f.manager.deliverPrompt(session.id, "permissions", true, undefined, { waitMs: 1_000 });
  await until(() => adapter.output().includes("command 1"));
  await until(() => f.manager.list()[0].status === "needs_approval");
  assert.equal(adapter.output().includes("command 2"), false);
  assert.equal((await f.manager.deliverPrompt(session.id, "1", true, undefined, { waitMs: 100 })).delivered, false);
  adapter.child.stdin.write("1\n");
  await until(() => adapter.output().includes("command 2"));
  assert.equal(adapter.output().includes("decisions:"), false);
  adapter.child.stdin.write("2\n");
  await until(() => adapter.output().includes("decisions:once,deny"));
  await until(() => f.idle(session.id));
  assert.equal(f.signals.filter(signal => signal.event === "PermissionRequest").length, 2);
});

test(`${provider}: disabling ACP immediately blocks orchestration but preserves manual input and other channels`, posix, async t => {
  const f = await fixture(t);
  const session = f.create();
  const adapter = f.launch();
  await until(() => adapter.output().includes("Session:"));
  const claude = f.gateway.registerSession("claude", "claude", false, undefined, false, undefined, false, true);
  f.setEnabled(false);
  assert.equal(f.gateway.promptChannel(claude).ready(), false);
  const result = await f.manager.deliverPrompt(session.id, "blocked", true, undefined, { waitMs: 100 });
  assert.equal(result.delivered, false);
  assert.match(result.reason, /disabled or revoked/);
  adapter.child.stdin.write("manual task\n");
  await until(() => adapter.output().includes("received:manual task"));
  assert.equal(adapter.child.exitCode, null);
  assert.deepEqual(f.writes, []);
});

test(`${provider}: authentication errors never fall back to TUI injection`, posix, async t => {
  const f = await fixture(t, true, true);
  f.create();
  const adapter = f.launch();
  await once(adapter.child, "exit");
  assert.equal(adapter.child.exitCode, 1);
  assert.match(adapter.output(), /Login required/);
  assert.deepEqual(f.writes, []);
});

test(`${provider}: ACP loads the exact saved session and applies the requested model and supported mode`, posix, async t => {
  const f = await fixture(t);
  f.create({ profile: provider === "grok" ? "ask" : "plan", resumeThreadId: "11111111-2222-4333-8444-555555555555",
    model: `${provider}-test`, ...(provider === "grok" ? { effort: "high" } : {}) });
  const adapter = f.launch();
  await until(() => adapter.output().includes("Session:"));
  assert.match(adapter.output(), /loaded:11111111-2222-4333-8444-555555555555/);
  assert.ok(adapter.output().includes(`model:${provider}-test`));
  assert.match(adapter.output(), provider === "grok" ? /effort:high/ : /mode:plan/);
});

test(`${provider}: invalid permission requests fail closed`, posix, async t => {
  const f = await fixture(t);
  const session = f.create();
  const adapter = f.launch();
  await until(() => adapter.output().includes("Session:"));
  await f.manager.deliverPrompt(session.id, "malformed", true, undefined, { waitMs: 1_000 });
  await once(adapter.child, "exit");
  assert.equal(adapter.child.exitCode, 1);
  assert.match(adapter.output(), /was not approved/);
});
}
