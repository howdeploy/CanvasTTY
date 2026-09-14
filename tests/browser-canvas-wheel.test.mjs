import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_CANVAS_WHEEL_IDLE_MS } from "../src/main/services/browser/BrowserCanvasFreeze.ts";
import * as browserWheelModule from "../src/main/services/browser/BrowserCanvasWheel.ts";

const {
  browserPageWheelClientPoint,
  browserCanvasNavigationPointerType,
  toCanvasPageWheelInput
} = browserWheelModule;

test("native Browser wheel ownership follows focus, capture mode, overrides, and zoom intent", () => {
  assert.equal(typeof browserWheelModule.browserWheelOwner, "function");
  const browserWheelOwner = browserWheelModule.browserWheelOwner;
  const base = {
    surface: "native",
    focused: true,
    captureMode: "off",
    wheelOverrideActive: false,
    canvasOverrideActive: false,
    ctrlKey: false,
    metaKey: false
  };

  assert.equal(browserWheelOwner(base), "page");
  assert.equal(browserWheelOwner({ ...base, captureMode: "key" }), "page");
  assert.equal(browserWheelOwner({ ...base, focused: false }), "canvas");
  assert.equal(browserWheelOwner({ ...base, captureMode: "always" }), "canvas");
  assert.equal(browserWheelOwner({ ...base, captureMode: "key", wheelOverrideActive: true }), "canvas");
  assert.equal(browserWheelOwner({ ...base, canvasOverrideActive: true }), "canvas");
  assert.equal(browserWheelOwner({ ...base, ctrlKey: true }), "canvas");
  assert.equal(browserWheelOwner({ ...base, metaKey: true }), "canvas");
  assert.equal(browserWheelOwner({ ...base, surface: "placeholder" }), "canvas");
  assert.equal(browserWheelOwner({ ...base, surface: "hidden" }), "canvas");
});

test("Browser wheel ownership sequence latches one tab-scoped owner across frames until idle", () => {
  assert.equal(typeof browserWheelModule.BrowserPageWheelSequence, "function");
  const sequence = new browserWheelModule.BrowserPageWheelSequence();

  const first = sequence.decide("page", 1_000);
  assert.deepEqual(first, { generation: 1, owner: "page" });
  // A new frame preload asks main again, but the shared tab sequence keeps the first owner.
  assert.deepEqual(sequence.decide("canvas", 1_120), first);
  assert.equal(sequence.touch(first.generation, 1_200), "page");
  assert.equal(sequence.touch(first.generation + 1, 1_210), null);
  assert.deepEqual(sequence.decide("canvas", 1_451), { generation: 2, owner: "canvas" });

  sequence.reset();
  assert.equal(sequence.touch(2, 1_452), null);
  assert.deepEqual(sequence.decide("page", 1_453), { generation: 3, owner: "page" });
});

test("the ownership reply carries the one shared idle window without changing the decision", () => {
  assert.equal(typeof browserWheelModule.browserPageWheelReply, "function");
  const decision = { generation: 7, owner: "canvas" };

  const reply = browserWheelModule.browserPageWheelReply(decision);

  // The preload holds no copy of this window: dropping the attachment here would
  // silently send every page back to its own stale boundary.
  assert.equal(reply.idleMs, BROWSER_CANVAS_WHEEL_IDLE_MS);
  assert.deepEqual(reply, { generation: 7, owner: "canvas", idleMs: BROWSER_CANVAS_WHEEL_IDLE_MS });
  // The decision the sequence compares by value must survive untouched.
  assert.deepEqual(decision, { generation: 7, owner: "canvas" });
});

test("browser page wheel input validates, normalizes delta modes, and clamps both axes", () => {
  assert.deepEqual(toCanvasPageWheelInput({
    deltaX: 2,
    deltaY: -3,
    deltaMode: 1,
    viewportWidth: 800,
    viewportHeight: 600,
    altKey: true,
    ctrlKey: false,
    metaKey: true,
    shiftKey: false
  }), {
    deltaX: 32,
    deltaY: -48,
    ctrlKey: false,
    metaKey: true
  });
  assert.deepEqual(toCanvasPageWheelInput({
    deltaX: 2,
    deltaY: -3,
    deltaMode: 2,
    viewportWidth: 800,
    viewportHeight: 600,
    altKey: false,
    ctrlKey: true,
    metaKey: false,
    shiftKey: true
  }), {
    deltaX: 1_200,
    deltaY: -1_200,
    ctrlKey: true,
    metaKey: false
  });
});

test("browser page pixel wheel preserves DOM direction and modifiers", () => {
  assert.deepEqual(toCanvasPageWheelInput({
    deltaX: -12,
    deltaY: 24,
    deltaMode: 0,
    viewportWidth: 800,
    viewportHeight: 600,
    altKey: false,
    ctrlKey: true,
    metaKey: false,
    shiftKey: true
  }), {
    deltaX: -12,
    deltaY: 24,
    ctrlKey: true,
    metaKey: false
  });
});

test("browser page wheel clamps pixel deltas on both axes", () => {
  assert.deepEqual(toCanvasPageWheelInput({
    deltaX: 4_000,
    deltaY: -4_000,
    deltaMode: 0,
    viewportWidth: 800,
    viewportHeight: 600,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false
  }), {
    deltaX: 1_200,
    deltaY: -1_200,
    ctrlKey: false,
    metaKey: false
  });
});

test("browser page wheel input fails closed for malformed, unsupported, and zero payloads", () => {
  const valid = {
    deltaX: 0,
    deltaY: 1,
    deltaMode: 0,
    viewportWidth: 800,
    viewportHeight: 600,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false
  };
  assert.equal(toCanvasPageWheelInput({ ...valid, deltaMode: 3 }), null);
  assert.equal(toCanvasPageWheelInput({ ...valid, deltaY: Number.NaN }), null);
  assert.equal(toCanvasPageWheelInput({ ...valid, ctrlKey: "false" }), null);
  assert.equal(toCanvasPageWheelInput({ ...valid, deltaY: 0 }), null);
});

test("browser page wheel rejects invalid page viewport dimensions", () => {
  const input = {
    deltaX: 0,
    deltaY: 1,
    deltaMode: 2,
    viewportWidth: 800,
    viewportHeight: 600,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false
  };
  assert.equal(toCanvasPageWheelInput({ ...input, viewportWidth: 0 }), null);
  assert.equal(toCanvasPageWheelInput({ ...input, viewportHeight: -1 }), null);
});

test("Browser wheel point prefers screen coordinates over scale-distorted page coordinates", () => {
  assert.deepEqual(browserPageWheelClientPoint({
    screenX: 861,
    screenY: 486,
    clientX: 395,
    clientY: 167,
    topFrame: true,
    viewportWidth: 902,
    viewportHeight: 470
  }, {
    ownerScreenBounds: { x: 180, y: 71, width: 1_440, height: 900 },
    viewport: { x: 318, y: 261, width: 830, height: 433 }
  }), { x: 681, y: 415 });
});

test("Browser wheel point scales a top-frame fallback into owner DIP coordinates", () => {
  const point = browserPageWheelClientPoint({
    screenX: 0,
    screenY: 0,
    clientX: 395,
    clientY: 167,
    topFrame: true,
    viewportWidth: 902,
    viewportHeight: 470
  }, {
    ownerScreenBounds: { x: 180, y: 71, width: 1_440, height: 900 },
    viewport: { x: 318, y: 261, width: 830, height: 433 }
  });

  assert.ok(point);
  assert.ok(Math.abs(point.x - 681.470066518847) < 0.000_001);
  assert.ok(Math.abs(point.y - 414.85319148936173) < 0.000_001);
  assert.equal(browserPageWheelClientPoint({
    screenX: 0,
    screenY: 0,
    clientX: 10,
    clientY: 10,
    topFrame: false,
    viewportWidth: 902,
    viewportHeight: 470
  }, {
    ownerScreenBounds: { x: 180, y: 71, width: 1_440, height: 900 },
    viewport: { x: 318, y: 261, width: 830, height: 433 }
  }), null);
});

test("native Browser override drag stays canvas-owned after the chord is released", () => {
  assert.equal(browserCanvasNavigationPointerType({ type: "mouseDown", button: "left" }, true, false), "down");
  assert.equal(browserCanvasNavigationPointerType({ type: "mouseEnter" }, false, true), "move");
  assert.equal(browserCanvasNavigationPointerType({ type: "mouseMove" }, false, true), "move");
  assert.equal(browserCanvasNavigationPointerType({ type: "mouseUp", button: "left" }, false, true), "up");
  assert.equal(browserCanvasNavigationPointerType({ type: "mouseLeave" }, false, true), null);
  assert.equal(browserCanvasNavigationPointerType({ type: "mouseDown", button: "left" }, false, false), null);
});

test("native Browser middle and bound side-button drags keep their initiating button", () => {
  assert.equal(browserCanvasNavigationPointerType(
    { type: "mouseDown", button: "middle" },
    false,
    false
  ), "down");
  assert.equal(browserCanvasNavigationPointerType(
    { type: "mouseMove" },
    false,
    true,
    { activeButton: "middle" }
  ), "move");
  assert.equal(browserCanvasNavigationPointerType(
    { type: "mouseUp", button: "left" },
    false,
    true,
    { activeButton: "middle" }
  ), null);
  assert.equal(browserCanvasNavigationPointerType(
    { type: "mouseUp", button: "middle" },
    false,
    true,
    { activeButton: "middle" }
  ), "up");
  assert.equal(browserCanvasNavigationPointerType(
    { type: "mouseDown", button: "back" },
    false,
    false,
    { mouseBindingActive: true }
  ), "down");
});
