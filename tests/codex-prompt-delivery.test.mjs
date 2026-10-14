import assert from "node:assert/strict";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const READY = "\x1b[2J\x1b[H>_ OpenAI Codex\r\n\r\n› Ask Codex to do anything\r\n";

function fixture(t, autoReady = true) {
  const writes = [];
  const calls = [];
  const spawn = fakeSpawner(calls, { onWrite: (text) => writes.push(text) });
  const terminals = new TerminalManager(() => {}, availableRegistry(), undefined, undefined, true,
    (...args) => {
      const process = spawn(...args);
      if (autoReady) queueMicrotask(() => process.emitData(READY));
      return process;
    });
  t.after(() => terminals.disposeAll());
  const parent = terminals.create({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  return { writes, calls, terminals, parent, control: new AgentControlService(terminals) };
}

test("Codex spawn sends the initial multiline prompt as an explicit paste followed by Enter", async (t) => {
  const f = fixture(t);
  const prompt = "Прочитай структуру проекта.\nНичего не изменяй.";
  await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan", initialPrompt: prompt });
  assert.deepEqual(f.writes, [`\x1b[200~${prompt}\x1b[201~\r`]);
});

test("Codex follow-up submits after paste but submit=false only pastes", async (t) => {
  const f = fixture(t);
  const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
  await f.control.send(child.id, "Первая строка\nВторая строка");
  await f.control.send(child.id, "Только вставить", false);
  assert.deepEqual(f.writes, ["\x1b[200~Первая строка\nВторая строка\x1b[201~\r", "\x1b[200~Только вставить\x1b[201~"]);
});

test("other providers retain their existing delivery bytes", async (t) => {
  const f = fixture(t);
  const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "qwen", cwd: process.cwd(), profile: "normal", initialPrompt: "first" });
  await f.control.send(child.id, "second");
  await f.control.send(child.id, "draft", false);
  assert.deepEqual(f.writes, ["first\r", "second\r", "draft"]);
});

test("a newly spawned Codex receives no prompt before its task composer is ready", async (t) => {
  const f = fixture(t, false);
  const result = f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan", initialPrompt: "DIAGNOSTIC_OK" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(f.writes, [], "a running PTY is not a ready Codex composer");
  f.calls.at(-1).process.emitData(READY);
  await result;
  assert.deepEqual(f.writes, ["\x1b[200~DIAGNOSTIC_OK\x1b[201~\r"]);
});

test("a restarted Codex cannot become ready from the previous launch's screen", async (t) => {
  const f = fixture(t, false);
  const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
  f.calls.at(-1).process.emitData(READY);
  await f.control.send(child.id, "first");
  f.calls.at(-1).process.emitExit(0);
  f.terminals.restart(child.id);
  f.writes.length = 0;
  const sent = f.control.send(child.id, "second");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(f.writes, [], "old scrollback is not readiness for the new process");
  f.calls.at(-1).process.emitData(READY);
  await sent;
  assert.deepEqual(f.writes, ["\x1b[200~second\x1b[201~\r"]);
});

test("startup readiness times out without writing any input", async (t) => {
  const f = fixture(t, false);
  const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
  const delivery = await f.terminals.deliverInput(child.id, "must not reach a startup menu\r", 30, undefined, true);
  assert.equal(delivery.delivered, false);
  assert.match(delivery.reason, /did not become ready/);
  assert.deepEqual(f.writes, []);
});

test("readiness is retained within a launch so submit=false drafts can still be extended", async (t) => {
  const f = fixture(t);
  const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
  await f.control.send(child.id, "draft", false);
  f.calls.at(-1).process.emitData("\x1b[2J\x1b[H› draft\r\n");
  await f.control.send(child.id, " continuation", false);
  assert.deepEqual(f.writes, ["\x1b[200~draft\x1b[201~", "\x1b[200~ continuation\x1b[201~"]);
});


test("startup menus are never treated as the task composer", async (t) => {
  const f = fixture(t, false);
  const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
  f.calls.at(-1).process.emitData(`${READY}Press enter to confirm trust\r\n`);
  const delivery = await f.terminals.deliverInput(child.id, "task\r", 30, undefined, true);
  assert.equal(delivery.delivered, false);
  assert.deepEqual(f.writes, []);
});

test("cancelled input stays discarded when the Codex composer appears later", async (t) => {
  const f = fixture(t, false);
  const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
  const controller = new AbortController();
  const sent = f.control.send(child.id, "cancelled task", true, controller.signal);
  controller.abort();
  await assert.rejects(sent, /cancelled/);
  f.calls.at(-1).process.emitData(READY);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(f.writes, []);
});

test("input waiting for a Codex composer never reaches a restarted process", async (t) => {
  const f = fixture(t, false);
  const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
  const sent = f.control.send(child.id, "obsolete task");
  const rejected = assert.rejects(sent, /restarted/);
  f.calls.at(-1).process.emitExit(0);
  f.terminals.restart(child.id);
  f.calls.at(-1).process.emitData(READY);
  await rejected;
  assert.deepEqual(f.writes, []);
});
