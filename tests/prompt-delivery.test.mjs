import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const frame = (provider, text = "") => provider === "kimi"
  ? `\x1b[2J\x1b[H╭────────────────────────────────────────╮\r\n│ > ${text.padEnd(36)} │\r\n╰────────────────────────────────────────╯\x1b[2;5H`
  : `\x1b[2J\x1b[H${provider === "claude" ? "❯" : "›"} ${text}\x1b[1;${3 + text.length}H`;

function fixture(t, provider = "codex") {
  const calls = [], writes = [];
  const manager = new TerminalManager(() => {}, availableRegistry(), undefined, undefined, true,
    fakeSpawner(calls, { onWrite: (data) => writes.push(data) }));
  const session = manager.create({ provider, cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  const pty = calls.at(-1).process;
  const draw = (text = "") => pty.emitData(frame(provider, text));
  draw();
  t.after(() => manager.disposeAll());
  return { manager, session, pty, writes, draw,
    send: (text = "task", submit = true, signal) => manager.deliverPrompt(session.id, text, submit, signal, { waitMs: 150 }) };
}

const until = async (condition) => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail("delivery did not reach the expected stage");
};

test("Codex, Claude and Kimi send Enter only after their active field acknowledges the paste", async t => {
  for (const provider of ["codex", "claude", "kimi"]) {
    const f = fixture(t, provider);
    const pending = f.send("first task");
    await until(() => f.writes.length === 1);
    assert.deepEqual(f.writes, ["\x1b[200~first task\x1b[201~"]);
    // Transcript echoes and unrelated redraws cannot acknowledge this input field.
    f.pty.emitData(`\x1b[10;1Hfirst task\x1b[1;3H`);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.writes.length, 1);
    f.draw("first task");
    await until(() => f.writes.length === 2);
    f.manager.applyProviderSignal(f.session.id, { kind: "lifecycle", state: "working", event: "UserPromptSubmit" });
    const result = await pending;
    assert.deepEqual(f.writes, ["\x1b[200~first task\x1b[201~", "\r"]);
    assert.equal(result.receipt.stage, "submitted");
    assert.equal(result.receipt.acceptance, "confirmed");
  }
});

test("missing paste acknowledgement returns a partial receipt and blocks a second task", async t => {
  const f = fixture(t, "claude");
  const result = await f.send();
  assert.equal(result.delivered, true);
  assert.equal(result.receipt.stage, "pasted");
  assert.match(result.receipt.reason, /Enter was not sent/);
  assert.equal((await f.send("second")).delivered, false);
  assert.equal(f.writes.length, 1);
});

test("a dim collapsed Claude paste is pending input, never an empty hint", async t => {
  const f = fixture(t, "claude");
  f.draw("\x1b[2m[Pasted text #1 +4 lines]\x1b[22m");
  assert.equal((await f.send()).delivered, false);
  assert.deepEqual(f.writes, []);
});

test("a written Enter remains unconfirmed until a native submission signal arrives", async t => {
  const f = fixture(t);
  const pending = f.send();
  await until(() => f.writes.length === 1);
  f.draw("task");
  const result = await pending;
  assert.equal(result.receipt.stage, "submitted");
  assert.equal(result.receipt.acceptance, "unconfirmed");
  f.manager.applyProviderSignal(f.session.id, { kind: "lifecycle", state: "working", event: "PostToolUse" });
  assert.equal(f.manager.lastPromptDelivery(f.session.id).acceptance, "unconfirmed");
  f.manager.applyProviderSignal(f.session.id, { kind: "lifecycle", state: "working", event: "UserPromptSubmit" });
  assert.equal(f.manager.lastPromptDelivery(f.session.id).acceptance, "confirmed");
});

test("a complete native Codex turn in one PTY chunk confirms acceptance without implying process exit", async t => {
  const f = fixture(t);
  const pending = f.send();
  await until(() => f.writes.length === 1);
  f.draw("task");
  await until(() => f.writes.length === 2);
  f.pty.emitData("\x1b]7501;state=working:app=codex\x07\x1b]7501;state=idle:app=codex\x07");
  const result = await pending;
  assert.equal(result.receipt.acceptance, "confirmed");
  assert.equal(result.receipt.evidence, "program-status");
  assert.equal(f.manager.getMetadata(f.session.id).exitCode, null);
  assert.equal(f.manager.getMetadata(f.session.id).status, "idle");
  assert.equal(f.manager.turnProgress(f.session.id).turnStartedSincePrompt, true);
});

test("an Enter write failure keeps the acknowledged paste and refuses another automatic task", async t => {
  const f = fixture(t);
  const write = f.pty.write;
  f.pty.write = data => { if (data === "\r") throw new Error("PTY closed"); write(data); };
  const pending = f.send();
  await until(() => f.writes.length === 1);
  f.draw("task");
  const result = await pending;
  assert.equal(result.receipt.stage, "pasted");
  assert.match(result.receipt.reason, /submit key could not be written/);
  assert.equal((await f.send("must not append")).delivered, false);
  assert.equal(f.writes.length, 1);
});

test("material handoff paste and Enter reserve their draft against other prompt senders", async t => {
  const f = fixture(t);
  assert.equal((await f.manager.deliverInput(f.session.id, "\x1b[200~material\x1b[201~", 0)).delivered, true);
  assert.equal((await f.send("must not interleave")).delivered, false);
  assert.equal((await f.manager.deliverInput(f.session.id, "\r", 0)).delivered, true);
  assert.deepEqual(f.writes, ["\x1b[200~material\x1b[201~", "\r"]);
});

test("manual input, cancellation and restart between paste and Enter never submit the staged task", async t => {
  for (const action of ["manual", "cancel", "restart"]) {
    const f = fixture(t), abort = new AbortController();
    const pending = f.send("task", true, abort.signal);
    await until(() => f.writes.length === 1);
    if (action === "manual") f.manager.input(f.session.id, "human edit");
    else if (action === "cancel") abort.abort();
    else { f.pty.emitExit(0); f.manager.restart(f.session.id); }
    f.draw("task");
    const result = await pending;
    assert.equal(result.receipt.stage, "pasted");
    assert.ok(!f.writes.includes("\r"), action);
  }
});

test("the queue retains the entire paste/observe/Enter transaction and supports owned paste-only drafts", async t => {
  const f = fixture(t);
  const first = f.send("one"), second = f.send("two");
  await until(() => f.writes.length === 1);
  f.draw("one");
  await until(() => f.writes.includes("\r"));
  f.manager.applyProviderSignal(f.session.id, { kind: "lifecycle", state: "working", event: "UserPromptSubmit" });
  await first;
  f.draw();
  await until(() => f.writes.length === 3);
  assert.deepEqual(f.writes.slice(0, 3), ["\x1b[200~one\x1b[201~", "\r", "\x1b[200~two\x1b[201~"]);
  f.draw("two");
  await until(() => f.writes.length === 4);
  f.manager.applyProviderSignal(f.session.id, { kind: "lifecycle", state: "working", event: "UserPromptSubmit" });
  await second;
  assert.equal(f.manager.turnProgress(f.session.id).turnStartedSincePrompt, true, "a follow-up can start without an idle status between turns");
  f.draw();
  const draft = await f.send("draft", false);
  assert.equal(draft.receipt.stage, "pasted");
  f.draw("draft");
  const extension = f.send(" continued");
  await until(() => f.writes.length === 6);
  f.draw("draft continued");
  await extension;
  assert.deepEqual(f.writes.slice(-3), ["\x1b[200~draft\x1b[201~", "\x1b[200~ continued\x1b[201~", "\r"]);
});

test("the archive's unstyled Codex placeholder needs current native idle and untouched input", async t => {
  const f = fixture(t);
  const archiveFrame = "\x1b[2J\x1b[H\x1b[1m\x1b[97m›\x1b[m Ask Codex to do anything\x1b[1;3H";
  f.pty.emitData("\x1b]7501;state=idle:app=codex\x07" + archiveFrame);
  const pending = f.send("task");
  await until(() => f.writes.length === 1);
  f.draw("task");
  await pending;
  f.manager.input(f.session.id, "Ask Codex to do anything");
  f.pty.emitData(archiveFrame);
  const count = f.writes.length;
  assert.equal((await f.send("must not append")).delivered, false);
  assert.equal(f.writes.length, count);
});
