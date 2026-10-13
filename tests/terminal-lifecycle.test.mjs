import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import * as terminalShortcuts from "../src/renderer/src/features/terminal/terminalShortcuts.ts";
import { keyboardPresetShortcuts } from "../src/shared/contracts.ts";
import { matchesShortcut } from "../src/renderer/src/lib/shortcuts.ts";

const terminalCardPath = new URL(
  "../src/renderer/src/features/terminal/TerminalCard.tsx",
  import.meta.url
);
const appStylesPath = new URL("../src/renderer/src/styles/app.css", import.meta.url);
const terminalManagerPath = new URL("../src/main/services/TerminalManager.ts", import.meta.url);
const contractsPath = new URL("../src/shared/contracts.ts", import.meta.url);

// Runs the card's actual keyboard setup (paste and Claude draft helpers plus the xterm key handler) against fakes.
// scope.screen, when given, is the fake .xterm-screen the Claude draft highlight layer is added to.
function terminalKeyHandler(source, scope) {
  const setup = source.match(/^    const pasteClipboard[\s\S]*?^    terminal\.attachCustomKeyEventHandler\(\(event\) => \{[\s\S]*?^    \}\);/m)?.[0];
  assert.ok(setup, "the terminal's actual keyboard handler must be located");
  let handler;
  const listeners = { write: [] };
  // The fake is extended in place: tests compare it with terminalRef.current.
  const terminal = Object.assign(scope.terminal ?? {}, {
    hasSelection: scope.terminal?.hasSelection ?? (() => false),
    attachCustomKeyEventHandler: (attached) => { handler = attached; },
    onWriteParsed: (listener) => { listeners.write.push(listener); return { dispose() {} }; },
    onResize: () => ({ dispose() {} }),
    element: {
      addEventListener: (type, listener) => { if (type === "mousedown") scope.onMouseDown?.(listener); },
      removeEventListener() {}
    }
  });
  const values = {
    ...terminalShortcuts, matchesShortcut,
    nativeEditorRef: { current: null },
    shortcutsRef: { current: keyboardPresetShortcuts("macos") },
    sessionExited: { current: false },
    sessionStartedAt: { current: 1 },
    terminalRef: { current: terminal },
    terminalHost: { current: null },
    claudeDraftSelected: { current: false },
    claudeDraftRef: { current: scope.session?.claudeDraft === true },
    document: { createElement: () => ({ className: "", hidden: false, style: {}, parentElement: null }) },
    screen: undefined,
    ...scope,
    terminal
  };
  delete values.onMouseDown;
  new Function(...Object.keys(values), stripTypeScriptTypes(setup))(...Object.values(values));
  scope.repaint = () => listeners.write.forEach((listener) => listener());
  return handler;
}

test("actual Codex handler preserves Enter modifiers before xterm can collapse them", async () => {
  const source = await readFile(terminalCardPath, "utf8");
  const body = source.match(/terminal\.attachCustomKeyEventHandler\(\(event\) => \{([\s\S]*?)^    \}\);/m)?.[1];
  assert.ok(body);
  const writes = [];
  const window = { canvasTTY: {
    window: { isMacOS: true },
    terminal: { input: (id, sequence) => writes.push([id, sequence]) }
  } };
  const handler = terminalKeyHandler(source, { window, session: { id: "draft", provider: "codex" } });
  for (const code of ["Enter", "NumpadEnter"]) {
    for (const [modifiers, sequence] of [
      [{}, "\r"], [{ shiftKey: true }, "\u001b[13;2u"], [{ metaKey: true }, "\u001b[13;9u"],
      [{ ctrlKey: true }, "\u001b[13;5u"], [{ altKey: true }, "\u001b[13;3u"],
      [{ metaKey: true, shiftKey: true }, "\u001b[13;10u"]
    ]) {
      let prevented = false;
      let stopped = false;
      const event = { type: "keydown", key: "Enter", code, ctrlKey: false, altKey: false,
        shiftKey: false, metaKey: false, ...modifiers,
        preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } };
      assert.equal(handler(event), false, "xterm must not encode these keys as identical CR bytes");
      assert.deepEqual([prevented, stopped, writes.pop()], [true, true, ["draft", sequence]]);
    }
  }
  for (const modifiers of [{ type: "keyup" }, { isComposing: true }]) {
    assert.equal(handler({ type: "keydown", key: "Enter", code: "Enter", ctrlKey: false, altKey: false,
      shiftKey: false, metaKey: false, ...modifiers }), true);
  }
  assert.deepEqual(writes, []);
});

test("Command+A dispatches native Codex selection and leaves other providers and CLI keys alone", async () => {
  const source = await readFile(terminalCardPath, "utf8");
  const body = source.match(/terminal\.attachCustomKeyEventHandler\(\(event\) => \{([\s\S]*?)^    \}\);/m)?.[1];
  assert.ok(body, "the terminal's actual keyboard handler must be located");
  const calls = [];
  const terminal = { clearSelection: () => calls.push("clear"), hasSelection: () => false };
  const window = { canvasTTY: {
    window: { isMacOS: true },
    terminal: { input: (id, sequence) => calls.push([id, sequence]) }
  } };
  const event = {
    type: "keydown", key: "ф", code: "KeyA", metaKey: true,
    ctrlKey: false, shiftKey: false, altKey: false,
    preventDefault: () => calls.push("prevent"),
    stopPropagation: () => calls.push("stop")
  };
  const codex = terminalKeyHandler(source, { window, session: { id: "codex-qa", provider: "codex" }, terminal });
  assert.equal(codex(event), false);
  assert.deepEqual(calls, ["prevent", "stop", "clear", ["codex-qa", "\u001b[97;9u"]]);
  calls.length = 0;
  // Claude's Command+A is CanvasTTY's own draft selection (its own test below).
  for (const provider of ["terminal", "gemini"]) {
    const handler = terminalKeyHandler(source, { window, session: { id: provider, provider }, terminal });
    assert.equal(handler(event), true);
  }
  for (const change of [
    { type: "keyup" }, { ctrlKey: true }, { shiftKey: true }, { altKey: true },
    { key: "F2", code: "F2", metaKey: false },
    { key: "Home", code: "Home", metaKey: false }
  ]) assert.equal(codex({ ...event, ...change }), true);
  assert.deepEqual(calls, []);
});

test("macOS Claude keeps Enter, Shift+Enter and Command+Enter distinct", async () => {
  const source = await readFile(terminalCardPath, "utf8");
  const writes = [];
  const window = { canvasTTY: {
    window: { isMacOS: true },
    terminal: { input: (id, sequence) => writes.push([id, sequence]) }
  } };
  const key = (handler, modifiers) => handler({ type: "keydown", key: "Enter", code: "Enter", ctrlKey: false,
    altKey: false, shiftKey: false, metaKey: false, ...modifiers, preventDefault() {}, stopPropagation() {} });
  const claude = terminalKeyHandler(source, { window, session: { id: "claude", provider: "claude" } });
  assert.equal(key(claude, {}), true, "plain Enter stays xterm's carriage return");
  assert.equal(key(claude, { shiftKey: true }), false);
  assert.equal(key(claude, { metaKey: true }), false);
  assert.equal(key(claude, { metaKey: true, isComposing: true }), true);
  assert.deepEqual(writes.splice(0), [["claude", "\u001b[13;2u"], ["claude", "\u001b[13;9u"]]);
  const linux = terminalKeyHandler(source, { window: { canvasTTY: { ...window.canvasTTY, window: { isMacOS: false } } },
    session: { id: "claude", provider: "claude" } });
  assert.equal(key(linux, { metaKey: true }), true, "other platforms keep their own Command+Enter");
  const terminal = terminalKeyHandler(source, { window, session: { id: "shell", provider: "terminal" } });
  assert.equal(key(terminal, { metaKey: true }), true);
  assert.deepEqual(writes, []);
});

test("Command+A selects a macOS Claude draft that copy, cut, typing, paste and deletion act on as a whole", async () => {
  const source = await readFile(terminalCardPath, "utf8");
  const calls = [];
  const rule = "─".repeat(40);
  let rows = ["history", rule, "❯ first line", "  second line", rule, "  footer"];
  const terminal = {
    rows: rows.length,
    buffer: { active: { viewportY: 10, getLine: (index) => ({ translateToString: () => rows[index - 10] ?? "" }) } },
    selectLines: () => calls.push("xterm selection"),
    clearSelection: () => calls.push("xterm clear"),
    paste: (text) => calls.push(["paste", text]),
    modes: { bracketedPasteMode: true }
  };
  const screen = { clientHeight: 120, append(child) { child.parentElement = screen; screen.layer = child; } };
  let mouseDown;
  const window = { canvasTTY: {
    window: { isMacOS: true },
    clipboard: { hasImage: async () => false, readText: async () => "из буфера" },
    terminal: {
      input: (id, data) => calls.push(["input", data]),
      draftAction: async (id, action, followUp, paste) => { calls.push(["draft", action, followUp ?? "", ...(paste ? [paste] : [])]); return true; }
    }
  } };
  const scope = { window, terminal, screen, sessionStartedAt: { current: 1 },
    session: { id: "claude-card", provider: "claude", claudeDraft: true },
    onMouseDown: (listener) => { mouseDown = listener; } };
  const handler = terminalKeyHandler(source, scope);
  const key = (key, code, modifiers = {}) => handler({ type: "keydown", key, code, ctrlKey: false, shiftKey: false,
    altKey: false, metaKey: false, repeat: false, ...modifiers, preventDefault() {}, stopPropagation() {} });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const highlight = () => screen.layer.hidden ? null : [screen.layer.style.top, screen.layer.style.height];

  assert.equal(screen.layer.className, "terminal-card__draft-highlight");
  assert.equal(highlight(), null);
  assert.equal(key("ч", "KeyX", { metaKey: true }), false, "Command+X without a selection does nothing");
  assert.equal(key("ф", "KeyA", { metaKey: true }), false);
  assert.deepEqual(highlight(), ["40px", "40px"], "the visible prompt rows show the selection");
  rows = ["history", "more", rule, "❯ first line", "  second line", rule];
  scope.repaint();
  assert.deepEqual(highlight(), ["60px", "40px"], "the layer follows Claude's repaint");
  assert.equal(key("Shift", "ShiftLeft", { shiftKey: true }), true, "a modifier alone keeps the selection");
  assert.equal(key("с", "KeyC", { metaKey: true }), false);
  assert.equal(key("с", "KeyC", { metaKey: true }), false, "copying keeps the selection");
  assert.equal(key("с", "KeyC", { metaKey: true, repeat: true }), false, "a held shortcut acts once");
  assert.notEqual(highlight(), null);
  assert.equal(key("ж", "Semicolon"), false);
  await tick();
  assert.deepEqual(calls.splice(0), [["draft", "copy", ""], ["draft", "copy", ""], ["draft", "clear", "ж"]],
    "xterm's own selection is never used");
  assert.equal(highlight(), null);
  assert.equal(key("я", "KeyZ"), true, "typing after the replacement is ordinary input");

  for (const [press, expected] of [
    [() => key("ч", "KeyX", { metaKey: true }), [["draft", "cut", ""]]],
    [() => key("Backspace", "Backspace"), [["draft", "clear", ""]]],
    [() => key("Delete", "Delete"), [["draft", "clear", ""]]],
    // The main process types the clipboard right after the clear, in order with later keys.
    [() => key("м", "KeyV", { metaKey: true }), [["draft", "clear", "", "bracketed"]]]
  ]) {
    key("a", "KeyA", { metaKey: true });
    calls.length = 0;
    assert.equal(press(), false);
    for (let i = 0; i < 4; i += 1) await tick();
    assert.deepEqual(calls, expected);
    calls.length = 0;
  }

  key("a", "KeyA", { metaKey: true });
  assert.equal(key("a", "KeyA", { metaKey: true, repeat: true }), false);
  assert.equal(key("ч", "KeyX", { metaKey: true, repeat: true }), false, "holding Command+X cannot cut");
  assert.deepEqual(calls.splice(0), []);
  assert.equal(key("ArrowLeft", "ArrowLeft"), true, "other keys drop the selection and reach Claude");
  assert.equal(highlight(), null);
  key("a", "KeyA", { metaKey: true });
  assert.equal(key("Enter", "Enter", { metaKey: true }), false);
  assert.deepEqual(calls.splice(0), [["input", "\u001b[13;9u"]], "Command+Enter drops the selection, then sends");
  assert.equal(highlight(), null);
  key("a", "KeyA", { metaKey: true });
  mouseDown();
  assert.equal(highlight(), null);
  assert.equal(key("ж", "Semicolon"), true, "a click replaces the draft selection");
  assert.deepEqual(calls, []);

  key("a", "KeyA", { metaKey: true });
  scope.sessionStartedAt.current = 2;
  assert.equal(key("ж", "Semicolon"), true, "a restarted Claude has a new draft: no selection carries over");
  key("a", "KeyA", { metaKey: true });
  rows = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"];
  scope.repaint();
  assert.equal(highlight(), null);
  assert.equal(key("Backspace", "Backspace"), true, "with a dialog in place of the prompt the key is the dialog's");
  assert.equal(key("a", "KeyA", { metaKey: true }), false);
  assert.equal(key("Backspace", "Backspace"), true, "Command+A selects nothing without a prompt on screen");
  rows = ["history", rule, "❯ draft", rule];
  scope.repaint();
  key("a", "KeyA", { metaKey: true });
  rows = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"];
  key("a", "KeyA", { metaKey: true });
  rows = ["history", rule, "❯ draft", rule];
  scope.repaint();
  assert.equal(highlight(), null, "Command+A over a dialog drops an earlier selection instead of keeping it hidden");
  assert.equal(key("Backspace", "Backspace"), true);
  assert.deepEqual(calls, []);
});

test("a Claude card launched without the draft helper keeps xterm's own Command+A and clipboard keys", async () => {
  const source = await readFile(terminalCardPath, "utf8");
  const calls = [];
  const window = { canvasTTY: {
    window: { isMacOS: true },
    terminal: { input: (id, data) => calls.push(data), draftAction: async () => calls.push("draft") }
  } };
  const handler = terminalKeyHandler(source, { window, session: { id: "plugin-claude", provider: "claude" } });
  const key = (key, code, modifiers = {}) => handler({ type: "keydown", key, code, ctrlKey: false, shiftKey: false,
    altKey: false, metaKey: false, repeat: false, ...modifiers, preventDefault() {}, stopPropagation() {} });
  assert.equal(key("a", "KeyA", { metaKey: true }), true);
  assert.equal(key("Backspace", "Backspace"), true);
  assert.equal(key("x", "KeyX", { metaKey: true }), true);
  assert.deepEqual(calls, [], "no Ctrl+G, so Claude never opens the person's editor");
});

test("Claude prompt rows are found between the last two rules, and nothing is guessed without them", () => {
  const rule = "─".repeat(30);
  assert.deepEqual(terminalShortcuts.claudePromptRows(["a", rule, "❯ x", rule, "footer"]), { first: 2, last: 2 });
  assert.deepEqual(terminalShortcuts.claudePromptRows([rule, "old", rule, "❯ x", "  y", "  " + rule, ""]), { first: 3, last: 4 });
  assert.equal(terminalShortcuts.claudePromptRows(["❯ x", rule]), null);
  assert.equal(terminalShortcuts.claudePromptRows([rule, rule]), null);
  const commandA = { type: "keydown", key: "a", code: "KeyA", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
  for (const provider of ["codex", "terminal"]) {
    assert.equal(terminalShortcuts.claudeDraftKeyIntent(commandA, true, provider, false), null);
  }
  assert.equal(terminalShortcuts.claudeDraftKeyIntent(commandA, false, "claude", false), null, "macOS only");
  assert.equal(terminalShortcuts.claudeDraftKeyIntent({ ...commandA, isComposing: true }, true, "claude", false), null);
});

test("clipboard replies cannot paste into a restarted or exited session while normal text and image paste stay intact", async () => {
  const source = await readFile(terminalCardPath, "utf8");
  const body = source.match(/terminal\.attachCustomKeyEventHandler\(\(event\) => \{([\s\S]*?)^    \}\);/m)?.[1];
  assert.ok(body, "exercise the terminal's actual keyboard handler");
  const event = {
    type: "keydown", key: "м", code: "KeyV", metaKey: true,
    ctrlKey: false, shiftKey: false, altKey: false,
    preventDefault() {}, stopPropagation() {}
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  const fixture = () => {
    const image = deferred();
    const text = deferred();
    const calls = [];
    const reads = { image: 0, text: 0 };
    const terminal = { hasSelection: () => false, paste: (value) => calls.push(["text", value]) };
    const terminalRef = { current: terminal };
    const sessionExited = { current: false };
    const sessionStartedAt = { current: 1 };
    const window = { canvasTTY: {
      window: { isMacOS: true },
      clipboard: {
        hasImage: () => { reads.image++; return image.promise; },
        readText: () => { reads.text++; return text.promise; }
      },
      terminal: { input: (id, sequence) => calls.push([id, sequence]) }
    } };
    const handler = terminalKeyHandler(source, { window, session: { id: "same-card", provider: "codex" }, terminal,
      terminalRef, sessionExited, sessionStartedAt });
    return { handler, image, text, calls, reads, terminalRef, sessionExited, sessionStartedAt };
  };
  const normalText = fixture();
  assert.equal(normalText.handler(event), false);
  normalText.image.resolve(false);
  await tick();
  normalText.text.resolve("ordinary clipboard text");
  await tick();
  assert.deepEqual(normalText.calls, [["text", "ordinary clipboard text"]]);
  const normalImage = fixture();
  assert.equal(normalImage.handler(event), false);
  normalImage.image.resolve(true);
  await tick();
  assert.deepEqual(normalImage.calls, [["same-card", "\u0016"]]);
  assert.equal(normalImage.reads.text, 0);

  for (const imageValue of [false, true]) {
    const restarted = fixture();
    restarted.handler(event);
    restarted.sessionExited.current = true;
    restarted.sessionStartedAt.current = 2;
    restarted.sessionExited.current = false;
    restarted.image.resolve(imageValue);
    await tick();
    assert.deepEqual(restarted.calls, [], "first clipboard reply must not reach a later launch");
    assert.equal(restarted.reads.text, 0);
  }
  const restartedDuringText = fixture();
  restartedDuringText.handler(event);
  restartedDuringText.image.resolve(false);
  await tick();
  assert.equal(restartedDuringText.reads.text, 1);
  restartedDuringText.sessionExited.current = true;
  restartedDuringText.sessionStartedAt.current = 2;
  restartedDuringText.sessionExited.current = false;
  restartedDuringText.text.resolve("stale clipboard text");
  await tick();
  assert.deepEqual(restartedDuringText.calls, [], "second clipboard reply must not reach a later launch");

  for (const invalidate of [(run) => { run.sessionExited.current = true; }, (run) => { run.terminalRef.current = null; }]) {
    const run = fixture();
    run.handler(event);
    invalidate(run);
    run.image.resolve(true);
    await tick();
    assert.deepEqual(run.calls, [], "an exited or unmounted session rejects pending paste");
  }
  const alreadyExited = fixture();
  alreadyExited.sessionExited.current = true;
  assert.equal(alreadyExited.handler(event), false);
  assert.equal(alreadyExited.reads.image, 0);
  const nativeKeys = fixture();
  for (const change of [
    { metaKey: false, ctrlKey: true }, { altKey: true }, { shiftKey: true },
    { metaKey: false, key: "F2", code: "F2" }, { metaKey: false, key: "Home", code: "Home" }
  ]) assert.equal(nativeKeys.handler({ ...event, ...change }), true);
  assert.deepEqual(nativeKeys.reads, { image: 0, text: 0 });
  assert.deepEqual(nativeKeys.calls, []);
});

test("palette changes retheme the live xterm without recreating it", async () => {
  const source = await readFile(terminalCardPath, "utf8");
  const mountDependencies = effectDependenciesContaining(source, "new Terminal({");

  assert.equal(mountDependencies, "session.id");
  assert.match(source, /terminal\.options\.theme = terminalTheme\(palette, pixelSkinTheme\)/);
  assert.match(source, /\}, \[palette, pixelSkinTheme\]\);/);
});

test("terminal copy shortcuts write the xterm selection without reaching the PTY", async () => {
  const source = await readFile(terminalCardPath, "utf8");

  assert.match(source, /terminal\.attachCustomKeyEventHandler/);
  assert.match(source, /window\.canvasTTY\.clipboard\.writeText\(terminal\.getSelection\(\)\)/);
  assert.match(source, /return false;/);
});

test("Command copy reaches a CLI-owned selection without sending Control-C", async () => {
  const source = await readFile(terminalCardPath, "utf8");
  assert.match(source, /shouldCopyTerminalSelection\(event, terminal\.hasSelection\(\) \|\| session\.provider === "codex", shortcutsRef\.current\)/);
  assert.match(source, /if \(terminal\.hasSelection\(\)\)[\s\S]*?writeText\(terminal\.getSelection\(\)\)[\s\S]*?else if \(session\.provider === "codex"\) window\.canvasTTY\.terminal\.input\(session\.id,[\s\S]*?"\\u0003" : "\\u001b\[99;9u"\)/);
});

test("terminal paste reads the trusted clipboard bridge and uses xterm paste semantics", async () => {
  const source = await readFile(terminalCardPath, "utf8");

  assert.match(source, /window\.canvasTTY\.clipboard\.readText\(\)/);
  assert.match(source, /terminal\.paste\(text\)/);
  assert.match(source, /window\.canvasTTY\.clipboard\.hasImage\(\)/);
  assert.match(source, /window\.canvasTTY\.terminal\.input\(session\.id, "\\u0016"\)/);
});

test("terminal mouse coordinates are adapted for a transformed canvas", async () => {
  const source = await readFile(terminalCardPath, "utf8");

  assert.match(source, /attachTerminalMouseCoordinateAdapter\(\s*screen/);
  assert.match(source, /captureCanvasWheelRef\.current/);
  assert.match(source, /data-canvas-zoom-surface="application"/);
});

test("logical focus moves keyboard input independently of terminal selection", async () => {
  const source = await readFile(terminalCardPath, "utf8");

  assert.match(source, /if \(focused && !renaming && !summaryMode\) terminal\.focus\(\)/);
  assert.match(source, /else if \(!focused\) \{\s*terminal\.blur\(\)/);
  assert.match(source, /terminal-card--selected/);
});

test("terminal uses one block cursor instead of overlaying a bar on provider cursor cells", async () => {
  const source = await readFile(terminalCardPath, "utf8");

  assert.match(source, /cursorStyle: "block"/);
  assert.doesNotMatch(source, /cursorStyle: "bar"/);
});

test("Grok waits for the measured xterm grid before its first TUI draw", async () => {
  const [card, manager, contracts, styles] = await Promise.all([
    readFile(terminalCardPath, "utf8"),
    readFile(terminalManagerPath, "utf8"),
    readFile(contractsPath, "utf8"),
    readFile(appStylesPath, "utf8")
  ]);

  assert.match(contracts, /INITIAL_TERMINAL_COLS = 80/);
  assert.match(contracts, /INITIAL_TERMINAL_ROWS = 24/);
  assert.match(card, /new Terminal\(\{\s*cols: INITIAL_TERMINAL_COLS,\s*rows: INITIAL_TERMINAL_ROWS/);
  assert.match(card, /fitTerminalPreservingViewport[\s\S]*?reportGrid\(terminal\.cols, terminal\.rows\)/);
  assert.match(card, /terminal-card--\$\{session\.provider\}/);
  assert.match(card, /attachTerminalOutput\([\s\S]*?session\.id/);
  assert.match(manager, /this\.spawnPty\([\s\S]*?cols,\s*rows,\s*cwd/);
  assert.match(manager, /session\.cols = safeCols;\s*session\.rows = safeRows/);
  assert.match(manager, /request\.provider === "grok"[\s\S]*?awaitingInitialResize: awaitMeasuredGrid/);
  assert.match(manager, /if \(session\.awaitingInitialResize\) \{\s*this\.launchAwaitingSession\(id, session\)/);
  assert.match(manager, /session\.metadata\.cwd,\s*session\.cols,\s*session\.rows/);
  assert.match(manager, /session\.metadata\.provider === "grok"[\s\S]*?session\.awaitingInitialResize = true/);
  assert.match(styles, /\.terminal-card--grok \.terminal-card__surface \{ padding: 6px 8px 8px; \}/);
});

test("programmatic hover focus does not leak focus reports into the agent TUI", async () => {
  const source = await readFile(terminalCardPath, "utf8");

  assert.match(source, /focusChangeSource === "hover"/);
  assert.match(source, /suppressFocusReport\.current/);
  assert.match(source, /TERMINAL_FOCUS_IN/);
  assert.match(source, /TERMINAL_FOCUS_OUT/);
});

test("PTY output is batched before crossing into the renderer", async () => {
  const source = await readFile(terminalManagerPath, "utf8");

  assert.match(source, /const OUTPUT_BATCH_MS = 16/);
  assert.match(source, /session\.pendingOutput\.push\(data\)/);
  assert.match(source, /session\.pendingOutput\.join\(""\)/);
  assert.match(source, /bufferChunks\.slice\(session\.bufferStart\)\.join\(""\)/);
});

test("session metadata revisions advance before lifecycle events cross IPC", async () => {
  const source = await readFile(terminalManagerPath, "utf8");

  assert.match(source, /revision: 0/);
  // The revision must advance before the session event is emitted, with only the
  // emit-scoped bookkeeping in between; a bounded gap keeps a reordering that
  // moves the emit away from the bump failing here.
  assert.match(source, /metadata\.revision \+= 1;[\s\S]{0,120}?this\.emit\(IPC\.terminalSession/);
});

test("revoking lifecycle hooks makes live agent status unavailable until a restarted session gets a new parser", async () => {
  const source = await readFile(terminalManagerPath, "utf8");

  assert.match(source, /setLifecycleHooksEnabled\(enabled: boolean\): void/);
  assert.match(source, /this\.lifecycleHooksEnabled = next;\s*if \(next\) return;/);
  assert.match(source, /session\.lifecycle = null;/);
  assert.match(source, /session\.metadata\.provider === "terminal"/);
  assert.match(source, /session\.metadata\.status = "unavailable";\s*this\.emitSession\(session\.metadata\)/);
  assert.match(source, /if \(!this\.lifecycleHooksEnabled \|\| !session/);
  assert.match(source, /session\.lifecycle = this\.lifecycleHooksEnabled\s*\? createProviderLifecycleParser/);
});

test("only explicit turn-stop hooks set completed art and a new turn clears it", async () => {
  const [card, manager, main] = await Promise.all([
    readFile(terminalCardPath, "utf8"),
    readFile(terminalManagerPath, "utf8"),
    readFile(new URL("../src/main/index.ts", import.meta.url), "utf8")
  ]);
  assert.match(main, /state: signal\.state,\s*event: signal\.event/);
  assert.match(manager, /\["Stop", "StopFailure", "StopCancelled"\]\.includes\(signal\.event \?\? ""\)/);
  assert.match(manager, /nextStatus === "working" \? false : completed \|\| Boolean\(session\.metadata\.turnCompleted\)/);
  assert.match(card, /pixelSkinStateForSession\(session\.status, session\.turnCompleted\)/);
  assert.match(card, /artState=\{pixelArtState\}/);
});

test("terminal viewport keeps the palette background after row-sized fits", async () => {
  const [source, styles] = await Promise.all([
    readFile(terminalCardPath, "utf8"),
    readFile(appStylesPath, "utf8")
  ]);

  assert.match(source, /"--terminal-background": terminalBackground/);
  assert.match(styles, /\.terminal-card__surface \.xterm-viewport \{ background-color: var\(--terminal-background, #202430\); \}/);
});

test("terminal fits preserve the active scrollback viewport", async () => {
  const source = await readFile(terminalCardPath, "utf8");

  assert.match(source, /fitTerminalPreservingViewport\(terminal, \(\) => fitAddon\.fit\(\)\)/);
  assert.doesNotMatch(source, /const fit = \(\): void => \{\s*try \{\s*fitAddon\.fit\(\)/);
});

test("renaming is inline and does not join the xterm mount dependencies", async () => {
  const source = await readFile(terminalCardPath, "utf8");
  const mountDependencies = effectDependenciesContaining(source, "new Terminal({");

  assert.equal(mountDependencies, "session.id");
  assert.match(source, /window\.canvasTTY\.terminal\.rename|onRename\(session\.id, title\)/);
  assert.match(source, /data-terminal-rename="true"/);
  // The rename field is seeded once from the visible title, never re-synced from a prop.
  assert.doesNotMatch(source, /defaultValue=\{session\.title\}/);
  assert.match(source, /input\.value = initial/);
  assert.match(source, /renameCommit\(/);
  assert.match(source, /autoFocus/);
  assert.match(source, /terminalRef\.current\?\.blur\(\)/);
  assert.doesNotMatch(source, /requestAnimationFrame\(\(\) => \{\s*renameInput/);
  assert.match(source, /visibleTerminalTitle\(\{ \.\.\.titleSource, cwdLabel: compactPath\(session\.cwd\) \}\)/);
});

test("late input and resize events are guarded after PTY exit", async () => {
  const source = await readFile(terminalManagerPath, "utf8");

  assert.match(source, /session\.metadata\.exitCode !== null/);
  assert.match(source, /tryPtyOperation\(\(\) => process\.write\(data\)\)/);
  assert.match(source, /tryPtyOperation\(\(\) => process\.resize\(safeCols, safeRows\)\)/);
});

test("an exited PTY can restart in place without recreating its xterm card", async () => {
  const [card, manager] = await Promise.all([
    readFile(terminalCardPath, "utf8"),
    readFile(terminalManagerPath, "utf8")
  ]);

  assert.match(manager, /restart\(id: string, options: \{ resume\?: boolean \} = \{\}\): SessionSnapshot/);
  assert.match(manager, /session\.metadata\.exitCode === null/);
  assert.match(manager, /session\.metadata\.status = initialSessionStatus\(session\.metadata\.provider\)/);
  assert.match(manager, /session\.metadata\.failureDetails = null/);
  assert.match(manager, /if \(launched\.process\) this\.bindProcess\(id, session, launched\.process\)/);
  assert.match(card, /shouldRestartExitedTerminal\(event, sessionExited\.current, shortcutsRef\.current\)/);
  assert.match(card, /onRestart\(session\.id, resume\)/);
});

test("failed PTYs preserve their final sanitized output as failure details", async () => {
  const source = await readFile(terminalManagerPath, "utf8");

  // Masked whole before the last lines are chosen (a cut inside a secret would leave its tail readable).
  assert.match(source, /terminalFailureDetails\(this\.redactSecrets\(current\.bufferChunks\.slice\(current\.bufferStart\)\.join\(""\)\)\)/);
  assert.match(source, /current\.metadata\.failureDetails = exitCode === 0/);
});

function effectDependenciesContaining(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Could not find ${marker}`);

  const effectStart = source.lastIndexOf("useEffect(() => {", markerIndex);
  assert.notEqual(effectStart, -1, "Could not find the xterm mount effect");

  const dependencyStart = source.indexOf("}, [", markerIndex);
  const dependencyEnd = source.indexOf("]);", dependencyStart);
  assert.notEqual(dependencyStart, -1, "Could not find the xterm mount dependencies");
  assert.notEqual(dependencyEnd, -1, "Could not parse the xterm mount dependencies");

  return source.slice(dependencyStart + 4, dependencyEnd).trim();
}
