import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AGENT_RUNTIME_ENV, CAPTURE_RESULT_ENV } from "../src/agent-runtime/runtime-protocol.mjs";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { AgentRuntimeBridge } from "../src/main/services/agent-runtime/AgentRuntimeBridge.ts";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import { applyRuntimeSignal } from "../src/main/services/agent-runtime/applyRuntimeSignal.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, inputReadySpawner } from "./helpers/terminal.mjs";

const POSIX = { timeout: 15_000, skip: process.platform === "win32" ? "Real Unix socket roundtrip; the Windows pipe transport has its own suite." : false };
const helper = fileURLToPath(new URL("../src/agent-runtime/hook-helper.mjs", import.meta.url));
const plugin = fileURLToPath(new URL("../src/agent-runtime/opencode-plugin.mjs", import.meta.url));

/** Runs a hook or plugin process the way the agent CLI would, with the launch's environment. */
function run(args, env, input = "") {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["pipe", "ignore", "pipe"] });
  const timeout = setTimeout(() => child.kill(), 5_000);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)); });
  });
}

const openCodeTurn = (answer) => `
  const { CanvasTTYLifecycle } = await import(${JSON.stringify(new URL("../src/agent-runtime/opencode-plugin.mjs", import.meta.url).href)});
  const hooks = await CanvasTTYLifecycle({ client: { session: { messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: ${JSON.stringify(answer)} }] }] }) } } });
  const event = (type, rest = {}) => hooks.event({ event: { type, properties: { sessionID: "worker-root", ...rest } } });
  await event("session.created", { info: { id: "worker-root" } });
  await event("session.status", { status: { type: "busy" } });
  await event("session.status", { status: { type: "idle" } });
  await event("session.idle");
`;

/** A real gateway, bridge and hook helper/plugin, with fake CLI PTYs; signals go through main's own glue. */
async function fixture(t, statusHooks) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "ctty-rt-")));
  const calls = [];
  let terminals;
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal: (id, signal) => applyRuntimeSignal(terminals, id, signal) });
  await gateway.start();
  const bridge = new AgentRuntimeBridge(gateway, {
    runtimeDirectory: join(root, "configs"), helper: { command: process.execPath, args: [helper] }, openCodePluginPath: plugin,
    coreHooksEnabled: statusHooks, environment: {},
    kimiHomeDirectory: join(root, "kimi"), hermesHomeDirectory: join(root, "hermes"), grokHomeDirectory: join(root, "grok")
  });
  terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, bridge, statusHooks, inputReadySpawner(calls));
  t.after(async () => {
    terminals.disposeAll();
    await gateway.close();
    await rm(root, { recursive: true, force: true });
  });
  const control = new AgentControlService(terminals, { waitTiming: { checkMs: 5, settleMs: 0, quietMs: 200 } });
  const parent = terminals.create({ provider: "codex", profile: "normal", cwd: root, role: "orchestrator", position: { x: 0, y: 0 } });
  // Status hooks are one switch: the bridge (hooks, leases) and the cards (status) follow it together, as in main.
  const setStatusHooks = (enabled) => {
    bridge.setCoreHooksEnabled(enabled);
    terminals.setLifecycleHooksEnabled(enabled);
  };
  return { root, calls, gateway, bridge, terminals, control, parent, setStatusHooks };
}

async function finishTurn(provider, env, answer) {
  if (provider === "codex") {
    await run([helper, "working", "UserPromptSubmit"], env, JSON.stringify({ turn_id: "fixture-turn" }));
    await run([helper, "idle", "Stop"], env, JSON.stringify({ turn_id: "fixture-turn", last_assistant_message: answer }));
  } else {
    await run(["--input-type=module", "-e", openCodeTurn(answer)], env);
  }
}

for (const provider of ["codex", "opencode"]) {
  test(`${provider} subagent's answer reaches wait_for_agent through its hooks while status hooks are on`, POSIX, async (t) => {
    const f = await fixture(t, true);
    const worker = await f.control.spawn({ parentSessionId: f.parent.id, provider, cwd: f.root });
    const env = f.calls.at(-1).options.env;
    assert.equal(env[CAPTURE_RESULT_ENV], "1");
    assert.ok(env[AGENT_RUNTIME_ENV.capabilityToken]);
    await f.terminals.deliverInput(worker.id, "worker task\r");
    await finishTurn(provider, env, "worker final answer");
    const waited = await f.control.waitFor(worker.id, { timeoutMs: 2_000 });
    assert.equal(waited.reason, "idle");
    assert.equal(waited.answer?.text, "worker final answer");
    assert.equal(waited.answerUnavailable, undefined);

    // Turning status hooks off revokes the lease: this launch has no hooks any more, and the result says so.
    f.setStatusHooks(false);
    assert.equal(f.gateway.currentStatus(worker.id), null);
    assert.equal((await f.control.result(worker.id)).answer?.text, "worker final answer", "an answer captured earlier stays");
    await f.terminals.deliverInput(worker.id, "next task\r");
    const after = await f.control.result(worker.id);
    assert.equal(after.answer, undefined);
    assert.equal(after.answerUnavailable?.reason, "status_hooks_off");
  });

  test(`${provider} subagent started with status hooks off gets no hooks, and the wait says its answer cannot be captured`, POSIX, async (t) => {
    const f = await fixture(t, false);
    const worker = await f.control.spawn({ parentSessionId: f.parent.id, provider, cwd: f.root });
    const launch = f.calls.at(-1);
    assert.equal(launch.options.env[AGENT_RUNTIME_ENV.capabilityToken], undefined, "no runtime lease");
    assert.deepEqual(launch.args.filter((arg) => typeof arg === "string" && /^hooks\./u.test(arg)), [], "no lifecycle hooks");
    await f.terminals.deliverInput(worker.id, "worker task\r");
    const waited = await f.control.waitFor(worker.id, { timeoutMs: 2_000 });
    assert.equal(waited.reason, "quiet");
    assert.equal(waited.status, "unavailable");
    assert.equal(waited.answer, undefined);
    assert.equal(waited.answerUnavailable?.reason, "status_hooks_off");
    assert.match(waited.answerUnavailable.message, /status hooks are off/u);

    // Turning them on applies to agents started or restarted afterwards.
    f.setStatusHooks(true);
    assert.equal((await f.control.result(worker.id)).answerUnavailable?.reason, "status_hooks_off");
    launch.process.emitExit(0);
    f.terminals.restart(worker.id);
    const restarted = f.calls.at(-1);
    assert.notEqual(restarted, launch);
    assert.ok(restarted.options.env[AGENT_RUNTIME_ENV.capabilityToken], "the restarted launch has its hooks");
    assert.equal((await f.control.result(worker.id)).answerUnavailable, undefined);
  });
}
