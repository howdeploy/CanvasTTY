import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPinnedInputRefresh, limitPinnedTerminalInput, pinnedTerminalInput } from "../src/renderer/src/features/terminal/terminalPinnedInput.ts";

function buffer(overrides = {}) {
  const lines = new Map([[12, { text: "  ask something   ", isWrapped: false }]]);
  return {
    type: "normal",
    baseY: 10,
    viewportY: 3,
    cursorY: 2,
    cursorX: 15,
    getLine(index) {
      const line = lines.get(index);
      return line === undefined ? undefined : {
        isWrapped: line.isWrapped,
        translateToString: (trimRight) => trimRight ? line.text.trimEnd() : line.text
      };
    },
    ...overrides
  };
}

function wrappedBuffer() {
  const lines = new Map([
    [10, { text: "prompt> abcdef", isWrapped: false }],
    [11, { text: "ghijklmnop", isWrapped: true }],
    [12, { text: "qrstuv   ", isWrapped: true }]
  ]);
  return buffer({
    baseY: 10,
    cursorY: 1,
    cursorX: 4,
    getLine(index) {
      const line = lines.get(index);
      return line === undefined ? undefined : {
        isWrapped: line.isWrapped,
        translateToString: (trimRight) => trimRight ? line.text.trimEnd() : line.text
      };
    }
  });
}

test("a scrolled normal terminal pins its complete live cursor line", () => {
  assert.deepEqual(pinnedTerminalInput(buffer(), 6), {
    rows: ["  ask something"], cursorRow: 0, cursorColumn: 15
  });
});

test("wrapped input keeps every physical row and the cursor's row and column", () => {
  assert.deepEqual(pinnedTerminalInput(wrappedBuffer(), 6), {
    rows: ["prompt> abcdef", "ghijklmnop", "qrstuv"],
    cursorRow: 1,
    cursorColumn: 4
  });
});

test("scrolling slightly up never duplicates an input line that is still visible", () => {
  assert.equal(pinnedTerminalInput(buffer({ viewportY: 9 }), 4), null);
  assert.equal(pinnedTerminalInput(buffer({ viewportY: 9 }), 0), null);
  assert.notEqual(pinnedTerminalInput(buffer({ viewportY: 8 }), 4), null);
  // A partially visible wrapped draft must not be copied into a second input strip.
  assert.equal(pinnedTerminalInput({ ...wrappedBuffer(), viewportY: 9 }, 2), null);
  assert.notEqual(pinnedTerminalInput({ ...wrappedBuffer(), viewportY: 7 }, 3), null);
});

test("reserved input rows do not keep a pinned copy alive after its source becomes visible", () => {
  const nearBottom = buffer({ viewportY: 9 });
  assert.notEqual(pinnedTerminalInput(nearBottom, 3), null);
  const pinnedRows = 1;
  assert.equal(pinnedTerminalInput(nearBottom, 3 + pinnedRows), null);
});

test("long wrapped input is bounded while keeping the cursor and nearby rows visible", () => {
  const input = {
    rows: Array.from({ length: 20 }, (_, index) => `row-${index}`),
    cursorRow: 17,
    cursorColumn: 6
  };
  assert.deepEqual(limitPinnedTerminalInput(input, 5), {
    rows: ["row-15", "row-16", "row-17", "row-18", "row-19"],
    cursorRow: 2,
    cursorColumn: 6
  });
});

test("the pinned row disappears at the live bottom and in alternate-screen TUIs", () => {
  assert.equal(pinnedTerminalInput(buffer({ viewportY: 10 }), 6), null);
  assert.equal(pinnedTerminalInput(buffer({ type: "alternate" }), 6), null);
});

test("a missing cursor row does not leave a stale pinned input", () => {
  assert.equal(pinnedTerminalInput(buffer({ getLine: () => undefined }), 6), null);
});

test("TerminalCard refreshes and reserves room for the pinned logical line", async () => {
  const source = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  assert.match(source, /scrollOnUserInput:\s*false/);
  assert.match(source, /pinnedTerminalInput\(terminal\.buffer\.active, terminal\.rows \+ pinnedRows\)/);
  assert.match(source, /limitPinnedTerminalInput\(completePinned, maxPinnedRows\)/);
  assert.match(source, /host\.clientHeight[^\n]*\/\s*2/);
  assert.match(source, /host\.append\(pinnedInput\)/);
  assert.match(source, /terminal-card__surface--pinned-input/);
  assert.match(source, /--pinned-input-height/);
  assert.match(source, /--pinned-cursor-column/);
  assert.match(source, /terminal\.onScroll\(updatePinnedInput\)/);
  assert.match(source, /terminal\.onCursorMove\(updatePinnedInput\)/);
  assert.match(source, /terminal\.onWriteParsed\(updatePinnedInput\)/);
});

test("the pinned input uses reserved terminal space and does not intercept selection", async () => {
  const css = await readFile(new URL("../src/renderer/src/styles/app.css", import.meta.url), "utf8");
  assert.match(css, /\.terminal-card__surface\.terminal-card__surface--pinned-input \.xterm\s*\{[^}]*height:\s*calc\(100%\s*-\s*var\(--pinned-input-height/s);
  assert.match(css, /\.terminal-card__pinned-input\s*\{[^}]*position:\s*absolute;[^}]*bottom:\s*0;[^}]*pointer-events:\s*none;/s);
  assert.match(css, /\.terminal-card__pinned-input-row--cursor::after\s*\{[^}]*left:\s*calc\(var\(--pinned-cursor-column\)[^}]*width:\s*calc\(100%\s*\/\s*var\(--pinned-terminal-columns\)/s);
  assert.match(css, /font-variant-ligatures:\s*none/);
});

test("pinned input does no hidden work and coalesces visible parser events into one frame", () => {
  let live = false;
  let calls = 0;
  let serial = 0;
  const frames = new Map();
  const refresh = createPinnedInputRefresh({
    isLive: () => live,
    refresh: () => { calls++; },
    requestFrame: (callback) => { frames.set(++serial, callback); return serial; },
    cancelFrame: (frame) => frames.delete(frame)
  });
  for (let index = 0; index < 1000; index++) refresh.schedule();
  assert.equal(frames.size, 0);
  assert.equal(calls, 0);
  live = true;
  for (let index = 0; index < 1000; index++) refresh.schedule();
  assert.equal(frames.size, 1);
  const callback = frames.get(serial); frames.clear(); callback();
  assert.equal(calls, 1);
  refresh.schedule();
  live = false;
  const hiddenCallback = frames.get(serial); frames.clear(); hiddenCallback();
  assert.equal(calls, 1, "suspending before the frame suppresses the pending DOM refresh");
  live = true;
  refresh.schedule();
  const resumedCallback = frames.get(serial); frames.clear(); resumedCallback();
  assert.equal(calls, 2, "resume schedules a fresh view of the current buffer");
});

test("disposing a pinned input refresh cancels pending work and prevents late callbacks", () => {
  let callback;
  let cancelled;
  let calls = 0;
  const refresh = createPinnedInputRefresh({
    isLive: () => true,
    refresh: () => { calls++; },
    requestFrame: (frameCallback) => { callback = frameCallback; return 7; },
    cancelFrame: (frame) => { cancelled = frame; }
  });
  refresh.schedule();
  refresh.dispose();
  assert.equal(cancelled, 7);
  callback();
  refresh.schedule();
  assert.equal(calls, 0);
});
