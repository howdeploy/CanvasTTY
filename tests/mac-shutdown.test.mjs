import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
const shutdown = source.slice(source.indexOf("async function shutdownServices"), source.indexOf("async function openPluginWindow"));

function fixture(platform, failure) {
  const calls = [];
  const action = (name) => () => {
    calls.push(name);
    if (failure === name) throw new Error(`fixture ${name} failed`);
  };
  const context = {
    process: { platform }, console: { warn: action("warning") }, clearTimeout, clearInterval,
    diagnostics: { record: (_level, _scope, event) => calls.push(event), flush: action("flush") },
    attentionNotifications: null, mascotManager: null, agentChatHistory: null, agentControl: null,
    updateTimer: null, updateInterval: null, browserRequests: new Map(),
    evenG2: { close: async () => action("companion")() },
    terminalManager: { shutdown: async () => action("terminals")(), waitForProcessExits: async () => { action("exits")(); return 0; } },
    usageHistory: { dispose: async () => action("history")() }, limitsService: { dispose: action("limits") },
    agentGateway: null, runtimeGateway: null, browserService: null, pluginServices: null, pluginManager: null,
    handoffService: { dispose: async () => action("handoff")() }, materialService: null
  };
  return { calls, context, run: runInNewContext(`${stripTypeScriptTypes(shutdown)}; shutdownServices`, context) };
}

test("Mac quit completes independent cleanup after a companion, history, handoff or exit-wait failure", async () => {
  for (const failure of ["companion", "terminals", "exits", "history", "limits", "handoff", "flush"]) {
    const { calls, run } = fixture("darwin", failure);
    await assert.doesNotReject(run(), failure);
    for (const step of ["terminals", "exits", "history", "limits", "handoff", "shutdown.completed", "flush"]) {
      assert.ok(calls.includes(step), `${failure}: ${step} still runs`);
    }
    assert.ok(calls.includes("warning"), `${failure}: the failure is reported`);
    assert.ok(calls.indexOf("history") < calls.indexOf("limits"), "history stops before limit requests abort");
  }
});

test("other platforms retain their existing shutdown rejection behavior", async () => {
  for (const platform of ["linux", "win32"]) {
    const { calls, run } = fixture(platform, "companion");
    await assert.rejects(run(), /fixture companion failed/);
    assert.ok(!calls.includes("terminals"));
  }
});

test("Mac quit waits for pending PTY exits before completing and flushing diagnostics", async () => {
  const { calls, context, run } = fixture("darwin");
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  context.terminalManager.waitForProcessExits = async () => { await gate; calls.push("exits.finished"); return 0; };
  const quitting = run();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.includes("handoff"), "other cleanup progresses while PTYs exit");
  assert.ok(!calls.includes("shutdown.completed"));
  assert.ok(!calls.includes("flush"));
  release(); await quitting;
  assert.ok(calls.indexOf("exits.finished") < calls.indexOf("shutdown.completed"));
  assert.ok(calls.indexOf("shutdown.completed") < calls.indexOf("flush"));
});
