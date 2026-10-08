import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  CanvasNavigationInputController,
  CanvasNavigationOverrideTracker,
  shouldPreventCanvasNavigationInput
} from "../src/main/services/CanvasNavigationOverride.ts";

import { trackTerminalEditFocus } from "../src/renderer/src/lib/shortcuts.ts";

const input = (type, key, modifiers = {}) => ({
  type,
  key,
  code: key === " " ? "Space" : key,
  alt: false,
  control: false,
  meta: false,
  shift: false,
  ...modifiers
});

const pointer = (button, pressed, modifiers = {}) => ({
  button,
  pressed,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...modifiers
});

test("mouse-button overrides activate on press and release without keyboard modifiers", () => {
  const tracker = new CanvasNavigationOverrideTracker("Mouse3");
  assert.deepEqual(tracker.updatePointer(pointer("Mouse3", true)), {
    active: true,
    changed: true,
    reserved: true
  });
  assert.equal(tracker.ownsMouseButton("Mouse3"), true);
  assert.deepEqual(tracker.updatePointer(pointer("Mouse3", false)), {
    active: false,
    changed: true,
    reserved: true
  });
  assert.equal(tracker.ownsMouseButton("Mouse3"), false);
});

test("controller tracks Electron side buttons for wheel and full-navigation bindings", () => {
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.setIgnoreMenuShortcuts = () => undefined;
  const states = [];
  const controller = new CanvasNavigationInputController({
    wheelBinding: "Mouse4",
    navigationBinding: "Mouse4"
  }, (state) => states.push(state));
  controller.attach(contents);

  let prevented = false;
  contents.emit("before-mouse-event", { preventDefault: () => { prevented = true; } }, {
    type: "mouseDown",
    button: "back",
    modifiers: []
  });
  assert.equal(controller.wheelActive, true);
  assert.equal(controller.active, true);
  assert.equal(controller.ownsAnyMouseButton("back"), true);
  assert.equal(prevented, true);
  prevented = false;
  contents.emit("before-mouse-event", { preventDefault: () => { prevented = true; } }, {
    type: "mouseUp",
    button: "back",
    modifiers: []
  });
  assert.equal(prevented, true);
  assert.deepEqual(states, [
    { wheelActive: true, navigationActive: true },
    { wheelActive: false, navigationActive: false }
  ]);
});

test("the owner renderer receives a bound mouse event so its DOM drag can start", () => {
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.setIgnoreMenuShortcuts = () => undefined;
  const controller = new CanvasNavigationInputController({
    wheelBinding: null,
    navigationBinding: "Mouse4"
  }, () => undefined);
  controller.attach(contents, { preventMouseBindings: false });

  let prevented = false;
  contents.emit("before-mouse-event", { preventDefault: () => { prevented = true; } }, {
    type: "mouseDown",
    button: "back",
    modifiers: []
  });
  assert.equal(controller.active, true);
  assert.equal(prevented, false);
});

test("modifier-only override activates immediately and permits extra zoom modifiers", () => {
  const tracker = new CanvasNavigationOverrideTracker("Alt");
  assert.deepEqual(tracker.update(input("keyDown", "Alt", { alt: true })), {
    active: true,
    changed: true,
    reserved: true
  });
  assert.deepEqual(tracker.update(input("keyDown", "Meta", { alt: true, meta: true })), {
    active: true,
    changed: false,
    reserved: false
  });
  assert.deepEqual(tracker.update(input("keyUp", "Alt", { meta: true })), {
    active: false,
    changed: true,
    reserved: true
  });
});

test("owned modifiers keep their keyup observable while owned ordinary keys are prevented", () => {
  assert.equal(shouldPreventCanvasNavigationInput(input("keyDown", "Alt"), {
    active: true,
    changed: true,
    reserved: true
  }), false);
  assert.equal(shouldPreventCanvasNavigationInput(input("keyDown", " "), {
    active: true,
    changed: true,
    reserved: true
  }), true);
});

test("controller tracks wheel-only and full overrides independently without hiding modifier keyup", () => {
  const contents = new EventEmitter();
  const ignored = [];
  contents.isDestroyed = () => false;
  contents.setIgnoreMenuShortcuts = (active) => ignored.push(active);
  const activeStates = [];
  const controller = new CanvasNavigationInputController({
    wheelBinding: "Meta",
    navigationBinding: "Alt"
  }, (state) => activeStates.push(state));
  controller.attach(contents);

  let prevented = false;
  contents.emit("before-input-event", { preventDefault: () => { prevented = true; } }, input(
    "keyDown",
    "Meta",
    { meta: true }
  ));
  assert.equal(prevented, false);
  assert.deepEqual(ignored, []);

  contents.emit("before-input-event", { preventDefault: () => { prevented = true; } }, input(
    "keyDown",
    "h",
    { code: "KeyH", meta: true }
  ));
  assert.equal(prevented, false);

  contents.emit("before-input-event", { preventDefault: () => { prevented = true; } }, input(
    "keyUp",
    "Meta"
  ));
  assert.equal(prevented, false);
  assert.deepEqual(ignored, []);
  assert.deepEqual(activeStates, [
    { wheelActive: true, navigationActive: false },
    { wheelActive: false, navigationActive: false }
  ]);
});

test("standalone Alt and ordinary-key chords retain menu shortcut capture", () => {
  const contents = new EventEmitter();
  const ignored = [];
  contents.isDestroyed = () => false;
  contents.setIgnoreMenuShortcuts = (active) => ignored.push(active);
  const controller = new CanvasNavigationInputController({
    wheelBinding: null,
    navigationBinding: "Alt"
  }, () => undefined);
  controller.attach(contents);

  contents.emit("before-input-event", { preventDefault: () => undefined }, input(
    "keyDown",
    "Alt",
    { alt: true }
  ));
  contents.emit("before-input-event", { preventDefault: () => undefined }, input("keyUp", "Alt"));
  assert.deepEqual(ignored, [true, false]);

  controller.setBindings({ wheelBinding: "Meta+Space", navigationBinding: null });
  contents.emit("before-input-event", { preventDefault: () => undefined }, input(
    "keyDown",
    "Meta",
    { meta: true }
  ));
  contents.emit("before-input-event", { preventDefault: () => undefined }, input(
    "keyDown",
    " ",
    { meta: true }
  ));
  contents.emit("before-input-event", { preventDefault: () => undefined }, input("keyUp", "Meta"));
  assert.deepEqual(ignored, [true, false, true, false]);
});

test("modifier-only Meta full override does not swallow ordinary Command shortcuts", () => {
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.setIgnoreMenuShortcuts = () => undefined;
  const controller = new CanvasNavigationInputController({
    wheelBinding: null,
    navigationBinding: "Meta"
  }, () => undefined);
  controller.attach(contents);

  let prevented = false;
  contents.emit("before-input-event", { preventDefault: () => { prevented = true; } }, input(
    "keyDown",
    "Meta",
    { meta: true }
  ));
  assert.equal(controller.active, true);
  assert.equal(prevented, false);
  contents.emit("before-input-event", { preventDefault: () => { prevented = true; } }, input(
    "keyDown",
    "c",
    { code: "KeyC", meta: true }
  ));
  assert.equal(prevented, false);
});

test("macOS Select All, Copy and Paste reach a focused terminal without capturing other Command shortcuts", () => {
  const contents = new EventEmitter();
  const ignored = [];
  contents.isDestroyed = () => false;
  contents.setIgnoreMenuShortcuts = (active) => ignored.push(active);
  const controller = new CanvasNavigationInputController({
    wheelBinding: null,
    navigationBinding: null
  }, () => undefined);
  controller.attach(contents, { captureMacEditShortcuts: true });
  controller.setTerminalEditFocus(contents, true);

  let prevented = false;
  const event = { preventDefault: () => { prevented = true; } };
  contents.emit("before-input-event", event, input("keyDown", "c", { code: "KeyC", meta: true }));
  contents.emit("before-input-event", event, input("keyUp", "c", { code: "KeyC", meta: true }));
  contents.emit("before-input-event", event, input("keyDown", "v", { code: "KeyV", meta: true }));
  contents.emit("before-input-event", event, input("keyUp", "v", { code: "KeyV", meta: true }));
  contents.emit("before-input-event", event, input("keyDown", "ф", { code: "KeyA", meta: true }));
  contents.emit("before-input-event", event, input("keyUp", "ф", { code: "KeyA", meta: true }));
  contents.emit("before-input-event", event, input("keyDown", "q", { code: "KeyQ", meta: true }));

  assert.equal(prevented, false);
  assert.deepEqual(ignored, [true, false, true, false, true, false]);
});

test("modified Command+A and non-macOS menu input keep their existing dispatch", () => {
  for (const captureMacEditShortcuts of [true, false]) {
    const contents = new EventEmitter();
    const ignored = [];
    contents.isDestroyed = () => false;
    contents.setIgnoreMenuShortcuts = (active) => ignored.push(active);
    const controller = new CanvasNavigationInputController({ wheelBinding: null, navigationBinding: null }, () => undefined);
    controller.attach(contents, { captureMacEditShortcuts });
    const event = { preventDefault: () => assert.fail("editing input must reach its focused native field") };
    const chords = [
      { meta: false, control: true }, { meta: true, control: true },
      { meta: true, alt: true }, { meta: true, shift: true }
    ];
    if (!captureMacEditShortcuts) chords.push({ meta: true });
    for (const modifiers of chords) {
      contents.emit("before-input-event", event, input("keyDown", "a", { code: "KeyA", ...modifiers }));
      contents.emit("before-input-event", event, input("keyUp", "a", { code: "KeyA", ...modifiers }));
    }
    assert.deepEqual(ignored, []);
  }
});

test("full override remains independent when both bindings are held", () => {
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.setIgnoreMenuShortcuts = () => undefined;
  const states = [];
  const controller = new CanvasNavigationInputController({
    wheelBinding: "Meta",
    navigationBinding: "Alt"
  }, (state) => states.push(state));
  controller.attach(contents);

  contents.emit("before-input-event", { preventDefault: () => undefined }, input(
    "keyDown",
    "Meta",
    { meta: true }
  ));
  contents.emit("before-input-event", { preventDefault: () => undefined }, input(
    "keyDown",
    "Alt",
    { meta: true, alt: true }
  ));
  contents.emit("before-input-event", { preventDefault: () => undefined }, input(
    "keyUp",
    "Meta",
    { alt: true }
  ));

  assert.deepEqual(states, [
    { wheelActive: true, navigationActive: false },
    { wheelActive: true, navigationActive: true },
    { wheelActive: false, navigationActive: true }
  ]);
  assert.equal(controller.wheelActive, false);
  assert.equal(controller.active, true);
});

test("identical bindings activate both modes and full navigation remains available", () => {
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.setIgnoreMenuShortcuts = () => undefined;
  const states = [];
  const controller = new CanvasNavigationInputController({
    wheelBinding: "Alt",
    navigationBinding: "Alt"
  }, (state) => states.push(state));
  controller.attach(contents);
  contents.emit("before-input-event", { preventDefault: () => undefined }, input(
    "keyDown",
    "Alt",
    { alt: true }
  ));
  assert.deepEqual(states, [{ wheelActive: true, navigationActive: true }]);
  assert.equal(controller.wheelActive, true);
  assert.equal(controller.active, true);
  controller.reset();
  assert.deepEqual(states.at(-1), { wheelActive: false, navigationActive: false });
});

test("modifier keyup clears the released modifier even when Electron keeps it in the snapshot", () => {
  const tracker = new CanvasNavigationOverrideTracker("Alt");
  tracker.update(input("keyDown", "Alt", { alt: true }));
  assert.deepEqual(tracker.update(input("keyUp", "Alt", { alt: true })), {
    active: false,
    changed: true,
    reserved: true
  });
});

test("modifier-key chord reserves its prefix and activates only when complete", () => {
  const tracker = new CanvasNavigationOverrideTracker("Alt+Space");
  assert.deepEqual(tracker.update(input("keyDown", "Alt", { alt: true })), {
    active: false,
    changed: false,
    reserved: true
  });
  assert.deepEqual(tracker.update(input("keyDown", " ", { alt: true })), {
    active: true,
    changed: true,
    reserved: true
  });
  assert.deepEqual(tracker.update(input("keyUp", " ", { alt: true })), {
    active: false,
    changed: true,
    reserved: true
  });
});

test("modifier-key chord does not reserve or arm its ordinary key without the modifiers", () => {
  const tracker = new CanvasNavigationOverrideTracker("Alt+Space");
  assert.deepEqual(tracker.update(input("keyDown", " ")), {
    active: false,
    changed: false,
    reserved: false
  });
  assert.deepEqual(tracker.update(input("keyDown", "Alt", { alt: true })), {
    active: false,
    changed: false,
    reserved: true
  });
  assert.deepEqual(tracker.update(input("keyUp", " ", { alt: true })), {
    active: false,
    changed: false,
    reserved: false
  });
});

test("an owned ordinary chord key remains reserved through keyup after modifier release", () => {
  const tracker = new CanvasNavigationOverrideTracker("Alt+Space");
  tracker.update(input("keyDown", "Alt", { alt: true }));
  tracker.update(input("keyDown", " ", { alt: true }));
  tracker.update(input("keyUp", "Alt"));
  assert.deepEqual(tracker.update(input("keyUp", " ")), {
    active: false,
    changed: false,
    reserved: true
  });
});

test("ordinary chord keys use the physical key code across layouts", () => {
  const tracker = new CanvasNavigationOverrideTracker("Alt+K");
  tracker.update(input("keyDown", "Alt", { alt: true }));
  assert.deepEqual(tracker.update(input("keyDown", "˚", { code: "KeyK", alt: true })), {
    active: true,
    changed: true,
    reserved: true
  });
});

test("blur reset and shortcut capture suspension clear active state", () => {
  const tracker = new CanvasNavigationOverrideTracker("Alt");
  tracker.update(input("keyDown", "Alt", { alt: true }));
  assert.deepEqual(tracker.reset(), { active: false, changed: true, reserved: false });

  tracker.setSuspended(true);
  assert.deepEqual(tracker.update(input("keyDown", "Alt", { alt: true })), {
    active: false,
    changed: false,
    reserved: false
  });
  tracker.setSuspended(false);
  assert.equal(tracker.active, false);
});

test("changing a binding resets pressed state instead of activating it retroactively", () => {
  const tracker = new CanvasNavigationOverrideTracker("Alt");
  tracker.update(input("keyDown", "Alt", { alt: true }));
  assert.deepEqual(tracker.setBinding("Ctrl+Alt"), {
    active: false,
    changed: true,
    reserved: false
  });
  assert.equal(tracker.active, false);
});

test("macOS Command+C/V/A keep the Edit menu in ordinary fields and plugin pages; only a focused terminal captures them", () => {
  const top = { name: "top" };
  const pluginFrame = { name: "plugin iframe" };
  const contents = new EventEmitter();
  const ignored = [];
  contents.isDestroyed = () => false;
  contents.setIgnoreMenuShortcuts = (active) => ignored.push(active);
  contents.mainFrame = top;
  contents.focusedFrame = top;
  const controller = new CanvasNavigationInputController({ wheelBinding: null, navigationBinding: null }, () => undefined);
  controller.attach(contents, { captureMacEditShortcuts: true });
  const event = { preventDefault: () => assert.fail("editing keys are never cancelled") };
  const pressV = () => {
    contents.emit("before-input-event", event, input("keyDown", "v", { code: "KeyV", meta: true }));
    contents.emit("before-input-event", event, input("keyUp", "v", { code: "KeyV", meta: true }));
  };

  // An app field (no terminal focus reported): the menu's native Paste must run.
  pressV();
  assert.deepEqual(ignored, [], "an ordinary field keeps Edit > Paste");

  // A plugin page's field: the iframe has focus, even if a terminal had focus before.
  controller.setTerminalEditFocus(contents, true);
  contents.focusedFrame = pluginFrame;
  pressV();
  assert.deepEqual(ignored, [], "a plugin iframe keeps Edit > Paste");

  // Back in the terminal: captured for xterm's own paste.
  contents.focusedFrame = top;
  pressV();
  assert.deepEqual(ignored, [true, false]);

  // Focus leaves the terminal while the capture is held: it is released at once.
  contents.emit("before-input-event", event, input("keyDown", "c", { code: "KeyC", meta: true }));
  controller.setTerminalEditFocus(contents, false);
  assert.deepEqual(ignored, [true, false, true, false]);
  pressV();
  assert.deepEqual(ignored, [true, false, true, false]);
});


test("focused shortcut recorders receive Command+A/C/V while ordinary fields keep native editing", (t) => {
  const previousElement = globalThis.Element;
  class FakeElement {
    constructor(selector) { this.selector = selector; }
    closest(query) { return query.includes(this.selector) ? this : null; }
  }
  globalThis.Element = FakeElement;
  t.after(() => {
    if (previousElement === undefined) delete globalThis.Element;
    else globalThis.Element = previousElement;
  });
  const top = {};
  const contents = new EventEmitter();
  const ignored = [];
  contents.isDestroyed = () => false;
  contents.setIgnoreMenuShortcuts = (active) => ignored.push(active);
  contents.mainFrame = top;
  contents.focusedFrame = top;
  const controller = new CanvasNavigationInputController({ wheelBinding: "Meta", navigationBinding: "Alt" }, () => undefined);
  controller.attach(contents, { captureMacEditShortcuts: true });
  // The canvas-navigation recorder suspends these bindings while listening for its new chord.
  controller.setShortcutCaptureActive(true);
  const listeners = new Map();
  const doc = {
    activeElement: new FakeElement("input"),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    defaultView: { addEventListener() {}, removeEventListener() {} }
  };
  const stop = trackTerminalEditFocus(doc, (focused) => controller.setTerminalEditFocus(contents, focused));
  t.after(stop);
  const pressEditKeys = () => {
    for (const key of ["a", "c", "v"]) {
      const event = { preventDefault: () => assert.fail("the renderer must receive recorder keyboard events") };
      contents.emit("before-input-event", event, input("keyDown", key, { code: `Key${key.toUpperCase()}`, meta: true }));
      contents.emit("before-input-event", event, input("keyUp", key, { code: `Key${key.toUpperCase()}`, meta: true }));
    }
  };
  pressEditKeys();
  assert.deepEqual(ignored, [], "ordinary inputs retain the native Edit menu");
  doc.activeElement = new FakeElement('[data-shortcut-capture="true"]');
  listeners.get("focusin")();
  pressEditKeys();
  assert.deepEqual(ignored, [true, false, true, false, true, false], "all three chords bypass the menu for the recorder");
  ignored.length = 0;
  contents.focusedFrame = {};
  pressEditKeys();
  assert.deepEqual(ignored, [], "a focused plugin frame still uses native editing even with a stale recorder report");
  contents.focusedFrame = top;
  doc.activeElement = new FakeElement("textarea");
  listeners.get("focusin")();
  pressEditKeys();
  assert.deepEqual(ignored, [], "leaving the recorder restores native editing");
});
