import assert from "node:assert/strict";
import test from "node:test";
import { stickyNoteWheelAttributes } from "../src/renderer/src/features/notes/stickyNoteWheelAttributes.ts";
import { routeCanvasWheelEvent } from "../src/renderer/src/features/workspace/canvasWheelRouting.ts";

class TestElement {
  constructor(attributes = {}, parent = null) {
    this.attributes = attributes;
    this.parent = parent;
    this.dataset = Object.fromEntries(Object.entries(attributes)
      .filter(([name]) => name.startsWith("data-"))
      .map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
  }

  closest(selector) {
    const match = selector.match(/^\[([^=\]]+)(?:="([^"]+)")?\]$/);
    if (!match) throw new Error(`Unsupported test selector: ${selector}`);
    const [, name, expected] = match;
    for (let element = this; element; element = element.parent) {
      if (name in element.attributes && (expected === undefined || element.attributes[name] === expected)) {
        return element;
      }
    }
    return null;
  }
}

function dispatchWheel(target, applyCanvasWheel) {
  let defaultPrevented = false;
  let propagationStopped = false;
  const event = {
    target,
    clientX: 40,
    clientY: 60,
    deltaX: 0,
    deltaY: 24,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    preventDefault() { defaultPrevented = true; },
    stopPropagation() { propagationStopped = true; }
  };
  const canvasClaimed = routeCanvasWheelEvent(event, {
    focusedWidgetId: null,
    captureMode: "off",
    wheelOverrideActive: false,
    navigationOverrideActive: false,
    getBounds: () => ({ width: 800, height: 600 }),
    applyCanvasWheel
  });
  return { canvasClaimed, defaultPrevented, propagationStopped };
}

test("sticky-note editor keeps its wheel while header and canvas background navigate", () => {
  const priorElement = globalThis.Element;
  globalThis.Element = TestElement;
  try {
    const attributes = stickyNoteWheelAttributes("note-1");
    const card = new TestElement(attributes.card);
    const editor = new TestElement(attributes.editor, card);
    const header = new TestElement({}, card);
    const background = new TestElement();
    const canvasEvents = [];
    const applyCanvasWheel = (input) => canvasEvents.push(input);

    assert.equal(card.dataset.canvasWidgetId, "note:note-1");
    assert.equal(card.dataset.canvasWidgetFocusable, undefined);
    assert.deepEqual(dispatchWheel(editor, applyCanvasWheel), {
      canvasClaimed: false,
      defaultPrevented: false,
      propagationStopped: false
    });
    assert.deepEqual(dispatchWheel(header, applyCanvasWheel), {
      canvasClaimed: true,
      defaultPrevented: true,
      propagationStopped: true
    });
    assert.deepEqual(dispatchWheel(background, applyCanvasWheel), {
      canvasClaimed: true,
      defaultPrevented: true,
      propagationStopped: true
    });
    assert.equal(canvasEvents.length, 2);
    assert.deepEqual(canvasEvents[0], {
      clientX: 40,
      clientY: 60,
      deltaX: 0,
      deltaY: 24,
      ctrlKey: false,
      metaKey: false
    });
  } finally {
    if (priorElement === undefined) delete globalThis.Element;
    else globalThis.Element = priorElement;
  }
});
