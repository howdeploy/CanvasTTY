import assert from "node:assert/strict";
import test from "node:test";
import { codexComposerReady, codexPromptInput } from "../src/main/services/codexInput.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, echoPromptInput, fakeSpawner } from "./helpers/terminal.mjs";

const READY = "\x1b[2J\x1b[H>_ OpenAI Codex\r\n\r\n› \x1b[2mAsk Codex to do anything\x1b[22m\r\n";
const KIMI_READY = "\x1b[2J\x1b[HKimi Code 2.4.0\r\n╭──────────────────────╮\r\n│ >                    │\r\n╰──────────────────────╯\r\n\x1b[3;6H";

function fixture(t, autoReady = true) {
  const writes = [];
  const calls = [];
  const spawn = fakeSpawner(calls, { onWrite: (text) => writes.push(text) });
  const terminals = new TerminalManager(() => {}, availableRegistry(), undefined, undefined, true,
    (...args) => {
      const process = spawn(...args);
      const provider = args[0].split("/").at(-1);
      const ready = provider === "kimi" ? KIMI_READY : provider === "claude" ? "\x1b[2J\x1b[H❯ " : READY;
      echoPromptInput(process, provider, ready);
      if (autoReady) {
        queueMicrotask(() => process.emitData(ready));
      }
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
  assert.deepEqual(f.writes, [`\x1b[200~${prompt}\x1b[201~`, "\r"]);
});

test("Codex follow-up submits after paste but submit=false only pastes", async (t) => {
  const f = fixture(t);
  const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
  await f.control.send(child.id, "Первая строка\nВторая строка");
  await f.control.send(child.id, "Только вставить", false);
  assert.deepEqual(f.writes, ["\x1b[200~Первая строка\nВторая строка\x1b[201~", "\r", "\x1b[200~Только вставить\x1b[201~"]);
});

test("other providers retain their existing delivery bytes", async (t) => {
  const f = fixture(t);
  const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "qwen", cwd: process.cwd(), profile: "normal", initialPrompt: "first" });
  await f.control.send(child.id, "second");
  await f.control.send(child.id, "draft", false);
  assert.deepEqual(f.writes, ["first\r", "second\r", "draft"]);
});

for (const provider of ["claude", "kimi"]) {
  test(`${provider} initial prompts and follow-ups separate pasted text from submission`, async (t) => {
    const f = fixture(t);
    const child = await f.control.spawn({ parentSessionId: f.parent.id, provider, cwd: process.cwd(), profile: "normal", initialPrompt: "first\nline" });
    await f.control.send(child.id, "next\nline");
    await f.control.send(child.id, "draft", false);
    assert.deepEqual(f.writes, ["\x1b[200~first\nline\x1b[201~", "\r", "\x1b[200~next\nline\x1b[201~", "\r", "\x1b[200~draft\x1b[201~"]);
  });
}

test("a newly spawned Codex receives no prompt before its task composer is ready", async (t) => {
  const f = fixture(t, false);
  const result = f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan", initialPrompt: "DIAGNOSTIC_OK" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(f.writes, [], "a running PTY is not a ready Codex composer");
  f.calls.at(-1).process.emitData(READY);
  await result;
  assert.deepEqual(f.writes, ["\x1b[200~DIAGNOSTIC_OK\x1b[201~", "\r"]);
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
  assert.deepEqual(f.writes, ["\x1b[200~second\x1b[201~", "\r"]);
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

test("startup and confirmation rows above the composer hold delivery until they disappear", async t => {
  for (const startup of ["• Starting MCP servers (0/3)", "● Starting MCP servers (0/3)", "◦ Booting MCP servers (1/2)",
    "│ model: loading │\r\n╰────────────────╯", "Press enter to confirm", "Do you trust the contents of this folder?", "Update Model Permissions"]) {
    await t.test(startup, async t => {
      assert.equal(codexComposerReady(`${startup}\n› Ask Codex to do anything`, true), false);
      assert.equal(codexComposerReady(`${startup}\n› `), false);
      const f = fixture(t, false);
      const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
      f.calls.at(-1).process.emitData(`\x1b[2J\x1b[H${startup}\r\n› \x1b[2mAsk Codex to do anything\x1b[0m\r\n`);
      assert.equal((await f.terminals.deliverInput(child.id, "task\r", 100, undefined, true)).delivered, false);
      assert.deepEqual(f.writes, []);
      f.calls.at(-1).process.emitData(READY);
      assert.equal((await f.terminals.deliverInput(child.id, "task\r", 200, undefined, true)).delivered, true);
    });
  }
  assert.equal(codexComposerReady("• Starting MCP servers (0/3)\n› previous task\n• complete\n› "), true);
});

test("all supported Codex bullet markers distinguish progress from answer text", () => {
  for (const marker of ["•", "●", "◦", "*"]) {
    for (const history of ["", "› previous task\n• Previous answer.\n\n"]) {
      assert.equal(codexComposerReady(`${history}${marker} Starting MCP servers (0/3)\n› Ask Codex to do anything`, true), false);
      assert.equal(codexComposerReady(`${history}${marker} Instructions:\n  Press enter to confirm the documented operation.\n› Ask Codex to do anything`, true), true);
    }
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
      f.calls.at(-1).process.emitData(`\x1b[2J\x1b[H› ${mode !== "draft" ? "\x1b[2m" : ""}${text}\x1b[0m\r\n`);
      const result = await f.terminals.deliverInput(child.id, "task\r", 150, undefined, true);
      assert.equal(result.delivered, mode !== "draft", result.reason);
      assert.deepEqual(f.writes, mode === "draft" ? [] : ["task\r"]);
    });
  }
});

test("every submitted task rechecks the active composer; later drafts and menus receive no automated input", async (t) => {
  for (const text of ["› unfinished personal draft", "Press enter to confirm trust"]) {
    const f = fixture(t);
    const child = await f.control.spawn({parentSessionId:f.parent.id,provider:"codex",cwd:process.cwd(),profile:"plan"});
    await f.control.send(child.id,"first");
    f.calls.at(-1).process.emitData("\x1b[2J\x1b[H"+text+"\r\n");
    const result = await f.terminals.deliverInput(child.id,"second\r",30,undefined,true);
    assert.equal(result.delivered,false);
    assert.equal(f.writes.length,2,"a completed earlier turn is no proof of current readiness");
    f.calls.at(-1).process.emitData(READY);
    assert.equal((await f.terminals.deliverInput(child.id,"second\r",1000,undefined,true)).delivered,true);
  }
});

test("person input revokes automation ownership of a paste-only draft", async (t) => {
  const f = fixture(t);
  const child = await f.control.spawn({parentSessionId:f.parent.id,provider:"codex",cwd:process.cwd(),profile:"plan"});
  await f.control.send(child.id,"draft",false);
  f.terminals.input(child.id,"person edits");
  f.calls.at(-1).process.emitData("\x1b[2J\x1b[H› draft person edits\r\n");
  const count=f.writes.length;
  assert.equal((await f.terminals.deliverInput(child.id,"must not append\r",30,undefined,true)).delivered,false);
  assert.equal(f.writes.length,count);
});


test("unstyled text equal to a built-in suggestion never releases automated input", async t=>{
  for(const placeholder of EMPTY_PLACEHOLDERS) {
    assert.equal(codexComposerReady(`› ${placeholder}`,false),false,placeholder);
    assert.equal(codexComposerReady(`› ${placeholder}`,true),true,placeholder);
  }
  assert.equal(codexComposerReady("›",false),true,"a genuinely blank composer needs no placeholder styling");
  const f=fixture(t,false);
  const child=await f.control.spawn({parentSessionId:f.parent.id,provider:"codex",cwd:process.cwd(),profile:"plan"});
  f.calls.at(-1).process.emitData("\x1b[2J\x1b[H› Explain this codebase\r\n");
  const result=await f.terminals.deliverInput(child.id,"automated task\r",100,undefined,true);
  assert.equal(result.delivered,false);assert.deepEqual(f.writes,[]);
});


test("startup phrases in completed transcript do not block the final ready composer", async (t) => {
  const phrases = ["Starting MCP servers", "Booting MCP servers", "Starting MCP servers (1/2)", "Booting MCP servers (1/2)", "Do you trust the contents", "Press enter to confirm", "Update Model Permissions", "model: loading"];
  for (const phrase of phrases) {
    assert.equal(codexComposerReady(`› explain ${phrase}?\n• prior answer quotes ${phrase}.\n\n› Ask Codex to do anything`,true),true);
    assert.equal(codexComposerReady(`› previous task\n• ${phrase} in the documented workflow.\n\n› Ask Codex to do anything`, true), true);
    assert.equal(codexComposerReady(`› previous task\n• Instructions:\n  ${phrase} in the documented workflow.\n\n› Ask Codex to do anything`, true), true);
    assert.equal(codexComposerReady(`› previous task\n• Instructions:\n  ${phrase}\n\n› Ask Codex to do anything`, true), true);
    assert.equal(codexComposerReady(`• ${phrase} in the documented workflow.\n\n› Ask Codex to do anything`, true), true);
    assert.equal(codexComposerReady(`• Instructions:\n  ${phrase}\n\n› Ask Codex to do anything`, true), true);
    assert.equal(codexComposerReady(`› Ask Codex to do anything\n${phrase}`,true),false);
  }
  const f=fixture(t,false);
  const child=await f.control.spawn({parentSessionId:f.parent.id,provider:"codex",cwd:process.cwd(),profile:"plan"});
  f.calls.at(-1).process.emitData("\x1b[2J\x1b[H› previous task\r\n• Press enter to confirm the documented operation.\r\n\r\n› \x1b[2mAsk Codex to do anything\x1b[22m\r\n");
  const result=await f.terminals.deliverInput(child.id,"follow-up\r",300,undefined,true);
  assert.equal(result.delivered,true,result.reason);
});

test("completed answers remain transcript after their original prompt leaves the viewport", async t => {
  const f = fixture(t, false);
  const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
  f.calls.at(-1).process.emitData("\x1b[2J\x1b[H› previous task\r\n" + "earlier output\r\n".repeat(30)
    + "• Instructions:\r\n  Press enter to confirm the documented operation.\r\n\r\n› \x1b[2mAsk Codex to do anything\x1b[22m\r\n");
  assert.equal((await f.terminals.deliverInput(child.id, "follow-up\r", 200, undefined, true)).delivered, true);
  assert.deepEqual(f.writes, ["follow-up\r"]);
});

test("post-turn MCP progress blocks delivery while transcript continuations do not", async t => {
  for (const live of [false, true]) {
    await t.test(live ? "live progress" : "completed multiline answer", async t => {
      const f = fixture(t, false);
      const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
      const rows = "› old task\r\n• Instructions:\r\n  Press enter to confirm the documented operation.\r\n\r\n"
        + (live ? "• Starting MCP servers (2/4): service-a, service-b (0s)\r\n" : "");
      f.calls.at(-1).process.emitData(`\x1b[2J\x1b[H${rows}› \x1b[2mAsk Codex to do anything\x1b[22m\r\n`);
      assert.equal((await f.terminals.deliverInput(child.id, "next task\r", 100, undefined, true)).delivered, !live);
      assert.deepEqual(f.writes, live ? [] : ["next task\r"]);
    });
  }
});

test("unstyled Braille is a draft even without other text", async t => {
  for (const draft of ["⠁⠃", "⣿⠿", "⠁\x1b[2mAsk Codex to do anything\x1b[22m"]) {
    await t.test(draft, async t => {
      const f = fixture(t, false);
      const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
      f.calls.at(-1).process.emitData(`\x1b[2J\x1b[H› ${draft}\r\n`);
      const result = await f.terminals.deliverInput(child.id, "must not submit\r", 50, undefined, true);
      assert.equal(result.delivered, false);
      assert.deepEqual(f.writes, []);
    });
  }
});

test("a blank first composer row does not hide a multiline draft", async t => {
  for (const tail of ["  personal draft", "\r\n  personal draft", "\r\n\r\n  personal draft", "  ›", "  › Ask Codex to do anything", "  " + "x".repeat(18) + "›",
    "\r\n  GPT-6 Sol medium · /fixture"]) {
    await t.test(JSON.stringify(tail), async t => {
      assert.equal(codexComposerReady(`› \n${tail.replaceAll("\r", "")}`), false);
      const f = fixture(t, false);
      const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
      f.terminals.resize(child.id, 20, 24);
      f.calls.at(-1).process.emitData(`\x1b[2J\x1b[H› \r\n${tail}\r\n`);
      assert.equal((await f.terminals.deliverInput(child.id, "must not append\r", 50, undefined, true)).delivered, false);
      assert.deepEqual(f.writes, []);
    });
  }
  const f = fixture(t, false);
  const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
  f.terminals.resize(child.id, 20, 24);
  f.calls.at(-1).process.emitData("\x1b[2J\x1b[H› \r\n\r\n  \x1b[33mGPT-6 Sol medium\x1b[0m · \x1b[32m/fixture\x1b[0m\r\n");
  assert.equal((await f.terminals.deliverInput(child.id, "task\r", 200, undefined, true)).delivered, true);
});

for (const humanInput of ["typed amendment", "\r", "\x1b[200~spoken task\x1b[201~\r"]) {
  test(`checked human input revokes automation draft ownership (${JSON.stringify(humanInput)})`, async t => {
    const f = fixture(t, false);
    const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
    f.calls.at(-1).process.emitData(READY);
    assert.equal((await f.terminals.deliverInput(child.id, codexPromptInput("automation draft", false), 200, undefined, true)).delivered, true);
    assert.equal(f.terminals.inputChecked(child.id, humanInput), true);
    f.calls.at(-1).process.emitData("\x1b[2J\x1b[H› personal unfinished task\r\n");
    const before = f.writes.length;
    const sent = await f.terminals.deliverInput(child.id, codexPromptInput("next automation"), 100, undefined, true);
    assert.equal(sent.delivered, false);
    assert.equal(f.writes.length, before);
    f.calls.at(-1).process.emitData(READY);
    assert.equal((await f.terminals.deliverInput(child.id, codexPromptInput("new owned draft", false), 200, undefined, true)).delivered, true);
    assert.equal((await f.terminals.deliverInput(child.id, codexPromptInput(" continued"), 200, undefined, true)).delivered, true);
  });
}


test("clipped transcript continuations remain deliverable without a visible prompt or bullet", async t => {
  for (const prefix of ["", "› old task\r\n"]) {
    const f = fixture(t, false);
    const child = await f.control.spawn({ parentSessionId: f.parent.id, provider: "codex", cwd: process.cwd(), profile: "plan" });
    f.calls.at(-1).process.emitData("\x1b[2J\x1b[H" + prefix + "• Instructions:\r\n"
      + "  prior transcript paragraph\r\n".repeat(35)
      + "  Press enter to confirm the documented operation.\r\n\r\n› \x1b[2mAsk Codex to do anything\x1b[22m\r\n");
    assert.equal((await f.terminals.deliverInput(child.id, "follow-up\r", 200, undefined, true)).delivered, true);
    assert.deepEqual(f.writes, ["follow-up\r"]);
  }
  for (const phrase of ["Press enter to confirm", "Do you trust the contents", "Update Model Permissions", "model: loading"]) {
    assert.equal(codexComposerReady(`  ${phrase} in a historical paragraph.\n› Ask Codex to do anything`, true), true);
    assert.equal(codexComposerReady(`${phrase}\n› Ask Codex to do anything`, true), false);
    assert.equal(codexComposerReady(`  │ ${phrase}\n› Ask Codex to do anything`, true), false);
  }
  assert.equal(codexComposerReady("  Starting MCP servers (1/2)\n› Ask Codex to do anything", true), false);
});
