import assert from "node:assert/strict";
import test from "node:test";
import { runShutdownSteps } from "../src/main/services/shutdownSteps.ts";

test("a failed shutdown step does not skip the steps after it", async () => {
  const calls = [], warnings = [];
  const failure = new Error("fixture close failed");
  await assert.doesNotReject(runShutdownSteps([
    { name: "Even G2", run: async () => { calls.push("Even G2"); throw failure; } },
    { name: "sync step", run: () => { calls.push("sync step"); throw failure; } },
    ...["terminal processes", "browser", "plugin services", "plugins", "materials"].map(name => ({ name, run: async () => { calls.push(name); } }))
  ], (message, error) => warnings.push({ message, error })));
  assert.deepEqual(calls, ["Even G2", "sync step", "terminal processes", "browser", "plugin services", "plugins", "materials"]);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0].error, failure);
  assert.match(warnings[0].message, /Even G2 failed/u);
});

test("shutdown steps run in order and each waits for the previous one", async () => {
  const events = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const done = runShutdownSteps([
    { name: "first", run: async () => { events.push("first:start"); await held; events.push("first:done"); } },
    { name: "second", run: () => { events.push("second"); } },
    { name: "absent service", run: () => undefined }
  ], () => assert.fail("no step failed"));
  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  release();
  await done;
  assert.deepEqual(events, ["first:start", "first:done", "second"]);
});

test("quitting still hangs up the terminals when the Even G2 companion fails to close", async () => {
  const { readFile } = await import("node:fs/promises");
  const { stripTypeScriptTypes } = await import("node:module");
  const { runInNewContext } = await import("node:vm");
  const main = (await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const start = main.indexOf("async function shutdownServices");
  const source = main.slice(start, main.indexOf("\n}\n", start) + 2);
  const calls = [];
  // The usage-history save finishes only after the limits service aborts its requests.
  let limitsAborted;
  const aborted = new Promise(resolve => { limitsAborted = resolve; });
  const service = (name, method, fail = false) => ({ [method]: async () => { calls.push(name); if (fail) throw new Error(`fixture ${name} failed`); } });
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const shutdownServices = runInNewContext(`${stripTypeScriptTypes(source)}; shutdownServices`, {
      runShutdownSteps, console, clearTimeout, clearInterval, Promise, Error,
      diagnostics: { record: () => undefined, flush: async () => { calls.push("diagnostics"); } },
      mascotManager: { dispose: () => { calls.push("mascots"); } },
      agentChatHistory: { dispose: () => { calls.push("chat history"); } },
      agentControl: service("agent control", "close"),
      updateTimer: null, updateInterval: null, browserRequests: new Map(),
      evenG2: service("Even G2", "close", true),
      terminalManager: { shutdown: async () => { calls.push("terminals"); }, waitForProcessExits: async () => 0 },
      usageHistory: { dispose: () => { calls.push("usage history"); return aborted.then(() => { calls.push("usage history saved"); }); } },
      limitsService: { dispose: () => { calls.push("limits"); limitsAborted(); } },
      agentGateway: service("agent gateway", "close"),
      runtimeGateway: service("runtime gateway", "close"),
      browserService: service("browser", "dispose"),
      pluginServices: service("plugin services", "dispose"),
      pluginManager: service("plugins", "dispose"),
      handoffService: service("handoff", "dispose"),
      materialService: service("materials", "dispose")
    });
    await shutdownServices();
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(calls, ["mascots", "chat history", "agent control", "Even G2", "terminals", "usage history", "limits",
    "usage history saved", "agent gateway", "runtime gateway", "browser", "plugin services", "plugins", "handoff", "materials",
    "diagnostics"]);
});
