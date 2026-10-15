import assert from "node:assert/strict";
import test from "node:test";
import { codexComposerReady, codexPromptInput } from "../src/main/services/codexInput.ts";
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

const EMPTY_PLACEHOLDERS = [
  "Ask Codex to do anything", "Ask a follow-up question", "Find and fix a bug in @filename",
  "Implement {feature}", "Summarize recent commits", "Explain this codebase",
  "Write tests for @filename", "Improve documentation in @filename",
  "Use /skills to list available skills", "Run /review on my current changes",
  "Check recently modified functions for compatibility", "How many files have been modified?",
  "Will this algorithm scale well?",
];

test("all built-in empty composer placeholders release queued Codex input", async (t) => {
  for (const placeholder of ["", ...EMPTY_PLACEHOLDERS]) {
    await t.test(placeholder || "blank composer", async (t) => {
      const f = fixture(t, false);
      const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
      f.calls.at(-1).process.emitData(READY.replace("Ask Codex to do anything", placeholder));
      const input = codexPromptInput("fixture task");
      const delivery = await f.terminals.deliverInput(child.id, input, 200, undefined, true);
      assert.equal(delivery.delivered, true, delivery.reason);
      assert.deepEqual(f.writes, [input]);
    });
  }
});

test("placeholder prefixes do not make human drafts or startup gates ready", () => {
  for (const text of ["Implement a custom task", "Find and fix something else",
    "Write tests for my changes", "Summarize recent commits and then edit a file",
    "Ask Codex to do anything extra", "1. Implement {feature}"]) {
    assert.equal(codexComposerReady(`› ${text}`), false, text);
  }
  for (const placeholder of EMPTY_PLACEHOLDERS) {
    assert.equal(codexComposerReady(`Press enter to confirm\n› ${placeholder}`), false);
    assert.equal(codexComposerReady(`model: loading\n› ${placeholder}`), false);
  }
});

test("active MCP startup holds queued input but a final incomplete warning does not", async (t) => {
  for (const startup of ["Starting MCP servers (0/3)", "Booting MCP servers (1/2)"]) {
    await t.test(startup, async (t) => {
      const f = fixture(t, false);
      const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
      f.calls.at(-1).process.emitData(READY + `• ${startup}\r\n`);
      const result = await f.terminals.deliverInput(child.id, "must wait\r", 100, undefined, true);
      assert.equal(result.delivered, false);
      assert.deepEqual(f.writes, []);
      f.calls.at(-1).process.emitData(READY + "⚠ MCP startup incomplete (1 failed)\r\n");
      const resumed = await f.terminals.deliverInput(child.id, "task\r", 200, undefined, true);
      assert.equal(resumed.delivered, true, resumed.reason);
      assert.deepEqual(f.writes, ["task\r"]);
    });
  }
});

test("transcript suggestions never make a person's current draft ready", async (t) => {
  assert.equal(codexComposerReady("› Explain this codebase\n\n• reply\n\n› unfinished personal draft"), false);
  const f = fixture(t, false);
  const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
  f.calls.at(-1).process.emitData(READY + "\r\n• reply\r\n\r\n› unfinished personal draft");
  const result = await f.terminals.deliverInput(child.id, "must not append\r", 100, undefined, true);
  assert.equal(result.delivered, false);
  assert.deepEqual(f.writes, []);
});

test("narrow terminals accept wrapped and dim clipped placeholders without accepting clipped drafts", async (t) => {
  for (const mode of ["wrapped", "clipped", "draft"]) {
    await t.test(mode, async (t) => {
      const f = fixture(t, false);
      const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
      f.terminals.resize(child.id, 20, 24);
      const placeholder = "Check recently modified functions for compatibility";
      const text = mode === "wrapped" ? placeholder : placeholder.slice(0, 18);
      f.calls.at(-1).process.emitData(`\x1b[2J\x1b[H› ${mode === "clipped" ? "\x1b[2m" : ""}${text}\x1b[0m\r\n`);
      const result = await f.terminals.deliverInput(child.id, "task\r", 150, undefined, true);
      assert.equal(result.delivered, mode !== "draft", result.reason);
      assert.deepEqual(f.writes, mode === "draft" ? [] : ["task\r"]);
    });
  }
});
