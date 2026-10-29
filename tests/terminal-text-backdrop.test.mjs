import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/headless";
import { attachTerminalTextBackdrop, terminalTextRuns } from "../src/renderer/src/features/terminal/terminalTextBackdrop.ts";

function line(cells) {
  return { getCell: column => cells[column] && {
    getChars: () => cells[column][0], getWidth: () => cells[column][1],
    isBgDefault: () => !cells[column][2], isInverse: () => cells[column][3] ?? 0,
  } };
}

test("only visible words receive a backdrop; padding and empty rows stay clear", () => {
  const cells = [..."   hello   world    "].map(char => [char, 1]);
  assert.deepEqual(terminalTextRuns(line(cells), cells.length), [[3, 8], [11, 16]]);
  assert.deepEqual(terminalTextRuns(line([[" ", 1], ["", 1]]), 20), []);
  assert.deepEqual(terminalTextRuns(undefined, 20), []);
});

test("wide characters retain their second cell and runs stop at the viewport edge", () => {
  const cells = [["界", 2], ["", 0], ["A", 1], [" ", 1], ["界", 2], ["", 0]];
  assert.deepEqual(terminalTextRuns(line(cells), 6), [[0, 3], [4, 6]]);
  assert.deepEqual(terminalTextRuns(line(cells), 5), [[0, 3], [4, 5]]);
});

test("native ANSI backgrounds and inverse highlights do not receive a readability backdrop", () => {
  const cells = [["A", 1], ["B", 1, true], ["C", 1], ["D", 1, false, 1], ["E", 1]];
  assert.deepEqual(terminalTextRuns(line(cells), cells.length), [[0, 1], [2, 3], [4, 5]]);
});

test("real ANSI cells preserve native colors and bold while only transparent text receives a mask", async () => {
  const terminal = new xterm.Terminal({ cols: 80, rows: 4, allowProposedApi: true });
  try {
    await new Promise(resolve => terminal.write(
      "plain \x1b[38;2;238;238;238;48;2;118;154;213mRGB\x1b[0m " +
      "\x1b[30;47mBLACK\x1b[0m \x1b[7mINVERSE\x1b[0m \x1b[1mBOLD\x1b[0m", resolve));
    const row = terminal.buffer.active.getLine(0);
    assert.deepEqual(terminalTextRuns(row, terminal.cols), [[0, 5], [24, 28]]);
    assert.equal(row.getCell(6).getFgColor(), 0xeeeeee);
    assert.equal(row.getCell(6).getBgColor(), 0x769ad5);
    assert.equal(row.getCell(10).getFgColor(), 0);
    assert.equal(row.getCell(10).getBgColor(), 7);
    assert.ok(row.getCell(16).isInverse());
    assert.ok(row.getCell(24).isBold());
  } finally {
    terminal.dispose();
  }
});

test("mask updates coalesce terminal events and never run a background animation loop", t => {
  const frames = new Map(), callbacks = [], rectangles = [];
  let nextFrame = 0, disposed = 0, removed = false, enabled = true, clears = 0;
  for (const key of ["document", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "devicePixelRatio", "getComputedStyle"]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  const context = { setTransform() {}, clearRect() { clears++; }, beginPath() {},
    roundRect(...args) { rectangles.push(args); }, fill() {} };
  globalThis.document = { createElement: () => ({ setAttribute() {}, getContext: () => context, remove() { removed = true; } }) };
  globalThis.ResizeObserver = class { observe() {} disconnect() { disposed++; } };
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis.devicePixelRatio = 1;
  let strength = "0.86";
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => strength });
  const event = callback => { callbacks.push(callback); return { dispose() { disposed++; } }; };
  const screen = { clientWidth: 80, clientHeight: 20, checkVisibility: () => true, append() {} };
  const terminal = { element: { querySelector: () => screen }, cols: 8, rows: 1,
    buffer: { active: { viewportY: 0, getLine: () => line([..."  hi    "].map(char => [char, 1])) } },
    onRender: event, onScroll: event, onResize: event };
  const detach = attachTerminalTextBackdrop(terminal, {
    classList: { contains: name => enabled && name === "terminal-card__surface--ascii-readable" },
  });
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
  assert.equal(frames.size, 1);
  flush();
  assert.equal(frames.size, 0);
  assert.equal(rectangles.length, 1);
  assert.equal(rectangles[0][0], 19);
  assert.equal(context.fillStyle, "rgba(2, 4, 10, 0.86)");
  strength = "0.25";
  callbacks.forEach(callback => callback());
  assert.equal(frames.size, 1);
  flush();
  assert.equal(clears, 2);
  assert.equal(context.fillStyle, "rgba(2, 4, 10, 0.25)");
  enabled = false;
  callbacks[0]();
  assert.equal(frames.size, 0);
  enabled = true;
  callbacks[0]();
  detach();
  assert.equal(frames.size, 0);
  assert.equal(disposed, 4);
  assert.equal(removed, true);
});
