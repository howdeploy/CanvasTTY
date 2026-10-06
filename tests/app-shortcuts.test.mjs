import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  displayCanvasNavigationBinding,
  handleMacNativeSelectAll,
  isRenameInputTarget,
  isShortcutCaptureTarget,
  matchesPhysicalOrLayoutKey,
  matchesPointerShortcut,
  matchesShortcut,
  shouldKeepNativeKeyboardInput,
  shortcutFromKeyboardEvent,
  shortcutFromPointerEvent
} from "../src/renderer/src/lib/shortcuts.ts";

const keyEvent = (key, modifiers = {}) => ({
  key,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...modifiers
});

test("captures and matches middle, back, and forward mouse buttons", () => {
  const pointerEvent = (button, modifiers = {}) => ({
    button,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers
  });
  assert.equal(shortcutFromPointerEvent(pointerEvent(1)), "Mouse3");
  assert.equal(shortcutFromPointerEvent(pointerEvent(3)), "Mouse4");
  assert.equal(shortcutFromPointerEvent(pointerEvent(4, { ctrlKey: true })), "Ctrl+Mouse5");
  assert.equal(shortcutFromPointerEvent(pointerEvent(0)), null);
  assert.equal(matchesPointerShortcut(pointerEvent(3), "Mouse4"), true);
});

test("captures plain defaults and canonical modifier order", () => {
  assert.equal(shortcutFromKeyboardEvent(keyEvent("Home")), "Home");
  assert.equal(shortcutFromKeyboardEvent(keyEvent("F2")), "F2");
  assert.equal(
    shortcutFromKeyboardEvent(keyEvent("r", { altKey: true, ctrlKey: true, shiftKey: true })),
    "Ctrl+Alt+Shift+R"
  );
});

test("ignores modifier-only and unsupported keys", () => {
  assert.equal(shortcutFromKeyboardEvent(keyEvent("Control", { ctrlKey: true })), null);
  assert.equal(shortcutFromKeyboardEvent(keyEvent("Unidentified")), null);
});

test("matches shortcuts without casing drift", () => {
  assert.equal(matchesShortcut(keyEvent("h", { ctrlKey: true }), "Ctrl+H"), true);
  assert.equal(matchesShortcut(keyEvent("h", { ctrlKey: true }), "Alt+H"), false);
});

test("a shortcut survives a non-Latin layout by preferring the physical key", () => {
  // Russian layout: the physical K key reports `key: "л"`. Recording and matching must
  // still agree on the same chord, otherwise no letter shortcut can be bound at all.
  const cyrillic = keyEvent("л", { code: "KeyK", ctrlKey: true });
  assert.equal(shortcutFromKeyboardEvent(cyrillic), "Ctrl+K");
  assert.equal(matchesShortcut(cyrillic, "Ctrl+K"), true);
  assert.equal(matchesPhysicalOrLayoutKey({ key: "л", code: "KeyK" }, "KeyK", "k"), true);
  assert.equal(matchesPhysicalOrLayoutKey({ key: "б", code: "Comma" }, "Comma", ","), true);
  // The `key` fallback still covers events that carry no usable code, so a mismatch in
  // both the code and the reported key is the only real negative.
  assert.equal(matchesPhysicalOrLayoutKey({ key: "л", code: "KeyX" }, "KeyK", "k"), false);
});

test("displays platform-neutral canvas navigation bindings with macOS key names", () => {
  assert.equal(displayCanvasNavigationBinding("Ctrl+Alt+Meta+Space", true), "Ctrl+Option+Command+Space");
  assert.equal(displayCanvasNavigationBinding("Ctrl+Alt", false), "Ctrl+Alt");
});

test("native input keeps CLI keys on every platform while canvas keeps its shortcuts", (t) => {
  const previousElement = globalThis.Element;
  class ElementTarget extends EventTarget {
    constructor(nativeInput) {
      super();
      this.nativeInput = nativeInput;
    }
    closest() { return this.nativeInput ? this : null; }
  }
  globalThis.Element = ElementTarget;
  t.after(() => {
    if (previousElement === undefined) delete globalThis.Element;
    else globalThis.Element = previousElement;
  });
  const nativeInput = new ElementTarget(true);
  const canvas = new ElementTarget(false);
  for (const event of [
    keyEvent("F2"), keyEvent("Home"), keyEvent("f", { metaKey: true }),
    keyEvent("ArrowLeft", { altKey: true }), keyEvent("k", { ctrlKey: true })
  ]) {
    assert.equal(shouldKeepNativeKeyboardInput(nativeInput, true), true, event.key);
    assert.equal(shouldKeepNativeKeyboardInput(canvas, true), false, event.key);
    assert.equal(shouldKeepNativeKeyboardInput(nativeInput, false), true, event.key);
    assert.equal(shouldKeepNativeKeyboardInput(canvas, false), false, event.key);
  }
  assert.equal(shouldKeepNativeKeyboardInput(null, true), false);
  assert.equal(shouldKeepNativeKeyboardInput(new EventTarget(), true), false);
});

test("App restores native Command+A before its native-input guard without intercepting Codex or other keys", async (t) => {
  const source = await readFile(new URL("../src/renderer/src/App.tsx", import.meta.url), "utf8");
  const body = source.match(/const handleShortcut = \(event: KeyboardEvent\): void => \{([\s\S]*?)^    \};/m)?.[1];
  assert.ok(body, "exercise the actual App capture handler");
  const saved = new Map(["Element", "HTMLInputElement", "HTMLTextAreaElement"].map((name) => [name, globalThis[name]]));
  class ElementTarget extends EventTarget {
    constructor({ tag = "DIV", terminal = false, editable = null, capture = false, parent = null } = {}) {
      super(); Object.assign(this, { tagName: tag, terminal, editable, capture, parent });
    }
    get parentElement() { return this.parent; }
    get isContentEditable() {
      const state = this.editable?.toLowerCase();
      if (state === "false") return false;
      if (state === "true" || state === "" || state === "plaintext-only") return true;
      return this.parent?.isContentEditable ?? false;
    }
    closest(selector) {
      if (selector === ".xterm") return this.terminal ? this : this.parent?.closest(selector) ?? null;
      if (selector.includes("data-shortcut-capture")) return this.capture ? this : this.parent?.closest(selector) ?? null;
      if (selector.includes("data-terminal-rename")) return null;
      if (selector === "[contenteditable]") return this.editable !== null ? this : this.parent?.closest(selector) ?? null;
      if (this.tagName === "INPUT" || this.tagName === "TEXTAREA") return this;
      if (selector !== "input, textarea" && (this.terminal || this.editable === "true")) return this;
      return this.parent?.closest(selector) ?? null;
    }
  }
  class TextFieldTarget extends ElementTarget {
    constructor(tag) { super({ tag }); this.value = "фисв"; this.selectionStart = 4; this.selectionEnd = 4; }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
    type(text) { this.value = this.value.slice(0, this.selectionStart) + text + this.value.slice(this.selectionEnd); }
  }
  class InputTarget extends TextFieldTarget { constructor() { super("INPUT"); } }
  class TextareaTarget extends TextFieldTarget { constructor() { super("TEXTAREA"); } }
  globalThis.Element = ElementTarget;
  globalThis.HTMLInputElement = InputTarget;
  globalThis.HTMLTextAreaElement = TextareaTarget;
  t.after(() => { for (const [name, previous] of saved) { if (previous === undefined) delete globalThis[name]; else globalThis[name] = previous; } });
  const actions = [];
  const window = { canvasTTY: { window: { isMacOS: true } } };
  const settings = { shortcuts: { toggleFullscreen: "Meta+F", home: "Home", renameWindow: "F2" } };
  const createHandler = new Function("window", "settings", "performShortcut", "handleMacNativeSelectAll", "shouldKeepNativeKeyboardInput", "isShortcutCaptureTarget", "isRenameInputTarget", "matchesShortcut", "shortcutReferenceOpen", "handoffRemarkIds", `return (event) => {${body}}`);
  const handoffHandler = (handoffRemarkIds = null) => createHandler(window, settings, (action) => actions.push(action), handleMacNativeSelectAll,
    shouldKeepNativeKeyboardInput, isShortcutCaptureTarget, isRenameInputTarget, matchesShortcut, false, handoffRemarkIds);
  const handler = handoffHandler();
  const event = (target, changes = {}) => {
    const state = { prevented: false, stopped: false };
    return { ...keyEvent("ф", { code: "KeyA", metaKey: true }), target, repeat: false, state,
      preventDefault() { state.prevented = true; }, stopPropagation() { state.stopped = true; }, ...changes };
  };
  for (const field of [new InputTarget(), new TextareaTarget()]) {
    const input = event(field);
    handler(input);
    assert.deepEqual(input.state, { prevented: true, stopped: true });
    field.type("ч");
    assert.equal(field.value, "ч", "typing after Command+A replaces the entire native field");
  }
  const selected = [];
  const selectionDocument = { getSelection: () => ({ selectAllChildren: (element) => selected.push(element) }) };
  for (const mode of ["true", "", "plaintext-only", "TRUE"]) {
    const editable = new ElementTarget({ editable: mode });
    editable.ownerDocument = selectionDocument;
    const nested = new ElementTarget({ editable: "true", parent: new ElementTarget({ parent: editable }) });
    nested.ownerDocument = selectionDocument;
    handler(event(new ElementTarget({ parent: nested })));
    assert.equal(selected.at(-1), editable, `${mode} descendants select the entire editor, including nested editable elements`);
    const blocked = new ElementTarget({ editable: "false", parent: editable });
    const blockedEvent = event(new ElementTarget({ parent: blocked }));
    const previousSelections = selected.length;
    handler(blockedEvent);
    assert.equal(selected.length, previousSelections, "an explicit false island is not an editable field");
    assert.deepEqual(blockedEvent.state, { prevented: false, stopped: false });
    const independent = new ElementTarget({ editable: "plaintext-only", parent: blocked });
    independent.ownerDocument = selectionDocument;
    handler(event(new ElementTarget({ parent: independent })));
    assert.equal(selected.at(-1), independent, "an editor inside a false island selects its own contents");
  }
  const terminal = new TextareaTarget();
  terminal.terminal = true;
  const native = event(terminal);
  handler(native);
  assert.deepEqual(native.state, { prevented: false, stopped: false });
  assert.equal(terminal.selectionStart, 4, "xterm keeps the command for its native Codex handler");
  for (const change of [
    { metaKey: false, ctrlKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true },
    { code: "KeyC", key: "c" }, { code: "KeyV", key: "v" },
    { code: "F2", key: "F2", metaKey: false }, { code: "Home", key: "Home", metaKey: false }
  ]) {
    const field = new InputTarget();
    const input = event(field, change);
    handler(input);
    assert.deepEqual(input.state, { prevented: false, stopped: false });
    assert.equal(field.selectionStart, 4);
  }
  const captured = new InputTarget(); captured.capture = true;
  const captureEvent = event(captured); handler(captureEvent);
  assert.deepEqual(captureEvent.state, { prevented: false, stopped: false }, "shortcut recording still receives Command+A");
  window.canvasTTY.window.isMacOS = false;
  const otherPlatform = new InputTarget(); handler(event(otherPlatform));
  assert.equal(otherPlatform.selectionStart, 4);
  assert.deepEqual(actions, []);
  window.canvasTTY.window.isMacOS = true;
  const modalHandler = handoffHandler(["remark-1"]);
  for (const field of [new InputTarget(), new TextareaTarget()]) {
    const input = event(field);
    modalHandler(input);
    assert.deepEqual(input.state, { prevented: true, stopped: true });
    field.type("ч");
    assert.equal(field.value, "ч");
  }
  for (const changes of [
    { key: "Home", code: "Home", metaKey: false },
    { key: "F2", code: "F2", metaKey: false },
    { key: "f", code: "KeyF" }
  ]) modalHandler(event(new ElementTarget(), changes));
  assert.deepEqual(actions, []);
  handler(event(new ElementTarget(), { key: "Home", code: "Home", metaKey: false }));
  assert.deepEqual(actions, ["home"]);
});
