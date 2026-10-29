import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/headless";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalReplayState } from "../src/main/services/terminalReplayState.ts";
import { attachTerminalOutput } from "../src/renderer/src/features/terminal/terminalOutput.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";
import { IPC } from "../src/shared/contracts.ts";

const LIMIT = 240_000;
const MENU = "\x1b[2J\x1b[HВыберите вариант\r\n> Первый\r\n  Второй";
const write = (terminal, data) => new Promise((resolve) => terminal.write(data, resolve));

function session(t) {
  const calls = [];
  const listeners = new Set();
  const manager = new TerminalManager((channel, event) => {
    if (channel === IPC.terminalData) for (const listener of listeners) listener(event);
  }, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  const { id } = manager.create({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  t.after(() => manager.disposeAll());
  return { manager, id, listeners, data: (data) => calls[0].process.emitData(data) };
}

function terminal(t) {
  const instance = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  t.after(() => instance.dispose());
  return instance;
}

const screen = (terminal) => {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) => {
    const line = buffer.getLine(buffer.baseY + row);
    return Array.from({ length: terminal.cols }, (_, col) => {
      const cell = line.getCell(col);
      return [cell.getChars(), cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(),
        cell.getBgColorMode(), cell.getBgColor(), !!cell.isBold(), !!cell.isDim(), !!cell.isItalic(),
        !!cell.isUnderline(), !!cell.isInverse()];
    });
  });
};

async function replay(t, stream, chunks = [stream]) {
  const live = terminal(t);
  const fresh = terminal(t);
  const { manager, id, data } = session(t);
  for (const chunk of chunks) data(chunk);
  const snapshot = manager.readBuffer(id);
  assert.equal(snapshot.outputOffset, stream.length, "synthetic state never changes the producer offset");
  assert.equal(snapshot.buffer, stream.slice(-LIMIT), "the retained buffer remains raw and bounded");
  await Promise.all([write(live, stream), write(fresh, (snapshot.restorePrefix ?? "") + snapshot.buffer)]);
  return { live, fresh, snapshot };
}

test("a fresh card after history trimming retains the alternate-screen menu, bold and RGB/palette colors", async (t) => {
  const stream = "\x1b[?1049h\x1b[1;3;38;2;10;20;30;48;5;24m" + "X".repeat(LIMIT + 30) + MENU;
  const { live, fresh } = await replay(t, stream);
  assert.equal(fresh.buffer.active.type, "alternate");
  assert.deepEqual(screen(fresh), screen(live));
  assert.equal(fresh.buffer.active.getLine(0).getCell(0).isBold() !== 0, true);
});

test("an SGR sequence split exactly at the trim boundary resumes before the raw suffix", async (t) => {
  const removed = "\x1b[?1049h\x1b[1;38;2;";
  const retainedStart = "10;20;30m";
  const stream = removed + retainedStart + "X".repeat(LIMIT - retainedStart.length - MENU.length) + MENU;
  const { live, fresh, snapshot } = await replay(t, stream, [removed.slice(0, -3), removed.slice(-3), stream.slice(removed.length)]);
  assert.equal(snapshot.buffer.startsWith(retainedStart), true);
  assert.equal(snapshot.restorePrefix.endsWith("\x1b[1;38;2;"), true);
  assert.deepEqual(screen(fresh), screen(live));
});

for (const [name, opening, closing] of [["OSC", "\x1b]999999;", "\x07"], ["DCS", "\x1bPq", "\x1b\\"], ["SOS", "\x1bX", "\x1b\\"]]) {
  test(`${name} payload cut by trimming is consumed without leaking payload onto the screen`, async (t) => {
    const retained = "p".repeat(LIMIT - closing.length - 4) + closing + "MENU";
    const { live, fresh } = await replay(t, opening + "discarded" + retained);
    assert.deepEqual(screen(fresh), screen(live));
    assert.equal(fresh.buffer.active.getLine(0).translateToString(true), "MENU");
  });
}

test("a surrogate split at the trim boundary is reassembled into the original wide character", async (t) => {
  const cat = "🐈";
  const beginning = "\x1b[2J\x1b[H" + cat[0];
  const retained = cat[1] + "\x1b]999999;" + "p".repeat(LIMIT - 1 - 9 - 2 - 1) + "\x1b\\Z";
  assert.equal(retained.length, LIMIT);
  const { live, fresh } = await replay(t, beginning + retained);
  assert.deepEqual(screen(fresh), screen(live));
  assert.equal(fresh.buffer.active.getLine(0).translateToString(true), "🐈Z");
});

test("scroll margins, origin, no-wrap, paste and mouse modes survive a fresh attach", async (t) => {
  const mode = "\x1b[?1049h\x1b[3;20r\x1b[?6h\x1b[?7l\x1b[?2004h\x1b[?1003h\x1b[?1006h";
  const stream = mode + "X".repeat(LIMIT + 20) + "\x1b[2J\x1b[1;1HMenu";
  const { live, fresh } = await replay(t, stream);
  assert.deepEqual(fresh.modes, live.modes);
  assert.equal(fresh._core._bufferService.buffer.scrollTop, 2);
  assert.equal(fresh._core._bufferService.buffer.scrollBottom, 19);
  assert.equal(fresh._core.coreMouseService.activeEncoding, "SGR");
  assert.deepEqual(screen(fresh), screen(live));
});

test("entering and leaving the alternate screen restores the saved normal rendition", async (t) => {
  const stream = "\x1b[1;31m\x1b[?1049h\x1b[32m" + "X".repeat(LIMIT + 20) + "\x1b[?1049l" + MENU;
  const { live, fresh } = await replay(t, stream);
  assert.equal(fresh.buffer.active.type, "normal");
  assert.deepEqual(screen(fresh), screen(live));
});

test("a completed OSC/DCS is never replayed; pending metadata and repeated styles stay bounded", () => {
  const state = new TerminalReplayState();
  state.feed("\x1b]52;c;private clipboard\x07\x1b]2;title\x1b\\\x1bPqprivate payload\x1b\\");
  for (let index = 0; index < 20_000; index++) state.feed(`\x1b[${index % 2 ? "1;31" : "22;32"}m`);
  assert.ok(state.prefix().length < 100);
  assert.doesNotMatch(state.prefix(), /clipboard|title|payload|52;/u);
  state.feed("\x1b]52;c;" + "a".repeat(100_000));
  assert.ok(state.prefix().length < 100, "an oversized unfinished string is represented by a bounded harmless discard sequence");
  assert.doesNotMatch(state.prefix(), /52;/u);
});

test("every cut through CSI, OSC/DCS terminators, charsets, saved rendition and soft reset resumes safely", async (t) => {
  const cases = [
    "\x1b[?1049h\x1b[1;38;2;12;34;56m", "\x1b]2;title\x1b\\\x1b[1;31m",
    "\x1bPqpayload\x1b\\\x1b[1;31m", "\x1b(0\x0eqx\x0f\x1b(B\x1b[1;31m",
    "\x1b[?1049h\x1b[3;20r\x1b[?6h\x1b[?7l", "\x9b1;31m\x9d2;title\x9c",
    "\x1b[1;31m\x1b7\x1b[32m\x1b8", "\x1b[1;31m\x1b[?7l\x1b[?2004h\x1b[!p"
  ];
  const live = terminal(t);
  const fresh = terminal(t);
  for (const input of cases) for (let cut = 0; cut <= input.length; cut++) {
    live.reset();
    fresh.reset();
    const state = new TerminalReplayState();
    state.feed(input.slice(0, cut));
    await Promise.all([write(live, input + MENU), write(fresh, state.prefix() + input.slice(cut) + MENU)]);
    assert.equal(fresh.buffer.active.type, live.buffer.active.type, `buffer at cut ${cut}`);
    assert.deepEqual(fresh.modes, live.modes, `modes at cut ${cut}`);
    assert.deepEqual(screen(fresh), screen(live), `screen at cut ${cut} through ${JSON.stringify(input)}`);
  }
});

test("snapshot restore metadata does not duplicate a queued live batch or invent an offset gap", async (t) => {
  const { manager, id, data, listeners } = session(t);
  const fresh = terminal(t);
  const stream = "\x1b[?1049h\x1b[1;31m" + "X".repeat(LIMIT + 30) + MENU;
  data(stream);
  const writes = [];
  const detach = attachTerminalOutput({
    onData(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    readBuffer() { return Promise.resolve(manager.readBuffer(id)); }
  }, id, (chunk) => writes.push(chunk), assert.fail, () => { throw new Error("invented replay gap"); });
  t.after(detach);
  manager.flushOutput(id, manager.sessions.get(id));
  data("\r\nAFTER");
  manager.flushOutput(id, manager.sessions.get(id));
  await new Promise((resolve) => setImmediate(resolve));
  await write(fresh, writes.join(""));
  assert.equal(writes.join("").match(/AFTER/gu)?.length, 1);
  assert.equal(fresh.buffer.active.type, "alternate");
  assert.equal(fresh.buffer.active.getLine(0).getCell(0).isBold() !== 0, true);
});
