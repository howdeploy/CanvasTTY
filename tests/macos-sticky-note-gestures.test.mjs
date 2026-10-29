import assert from "node:assert/strict";
import test from "node:test";
import { importWithFakeReact, findAll } from "./helpers/fake-react.mjs";

const react = await importWithFakeReact("src/renderer/src/features/notes/StickyNoteCard.tsx", "StickyNoteCard");
const initial = { position: { x: 100, y: 200 }, size: { width: 300, height: 220 } };
const event = (x, y, extra = {}) => ({
  type: "pointermove", pointerId: 1, button: 0, buttons: 1, clientX: x, clientY: y,
  target: { closest: () => null }, currentTarget: { setPointerCapture() {} },
  preventDefault() {}, stopPropagation() {}, ...extra
});

function noteGesture({ platform = "darwin", zoom = 1, direction = "se", snapEnabled = false } = {}) {
  react.__reset();
  const previousWindow = globalThis.window;
  globalThis.window = { canvasTTY: { window: { platform, isMacOS: platform === "darwin" } } };
  const commits = [];
  const props = {
    note: { id: "note-a", text: "", ...initial }, locale: "en", camera: { get: () => ({ zoom }) },
    stackIndex: 1, editRequest: 0, snapEnabled, getSnapTargets: () => [], onTextChange() {}, onClose() {},
    onBoundsChange(id, bounds) { commits.push({ id, bounds }); }
  };
  let tree;
  const render = () => { react.__flush(); tree = react.__render(react.StickyNoteCard, props); };
  const handlers = (kind) => kind === "drag"
    ? findAll(tree, (node) => node.type === "header")[0].props
    : findAll(tree, (node) => node.props?.className?.endsWith(`resize-handle--${direction}`))[0].props;
  render(); render();
  return {
    handlers, render, commits,
    bounds() { render(); return findAll(tree, (node) => node.type === "article")[0].props.style; },
    close() { react.__unmount(); globalThis.window = previousWindow; }
  };
}

for (const kind of ["drag", "resize"]) {
  test(`Mac note fast ${kind} commits release coordinates at every canvas zoom`, () => {
    for (const zoom of [0.5, 1, 2]) {
      const h = noteGesture({ zoom });
      try {
        const handlers = h.handlers(kind);
        handlers.onPointerDown(event(10, 20));
        handlers.onPointerUp(event(110, 80, { type: "pointerup", buttons: 0 }));
        const bounds = kind === "drag"
          ? { position: { x: 100 + 100 / zoom, y: 200 + 60 / zoom }, size: initial.size }
          : { position: initial.position, size: { width: 300 + 100 / zoom, height: 220 + 60 / zoom } };
        assert.deepEqual(h.commits, [{ id: "note-a", bounds }]);
        handlers.onLostPointerCapture(event(110, 80));
        assert.equal(h.bounds().transform, `translate(${bounds.position.x}px, ${bounds.position.y}px)`);
        assert.equal(h.bounds().width, bounds.size.width, "capture loss after release does not undo a commit");
      } finally { h.close(); }
    }
  });

  for (const cancel of ["onPointerCancel", "onLostPointerCapture"]) {
    test(`Mac note ${kind} ${cancel} restores original bounds without saving`, () => {
      const h = noteGesture({ zoom: 0.5 });
      try {
        const handlers = h.handlers(kind);
        handlers.onPointerDown(event(10, 20));
        handlers.onPointerMove(event(110, 80));
        handlers[cancel](event(0, 0, { type: cancel === "onPointerCancel" ? "pointercancel" : "lostpointercapture", buttons: 0 }));
        handlers.onPointerUp(event(200, 100, { type: "pointerup", buttons: 0 }));
        assert.deepEqual(h.commits, []);
        assert.equal(h.bounds().transform, "translate(100px, 200px)");
        assert.equal(h.bounds().width, 300);
        assert.equal(h.bounds().height, 220);
        handlers.onPointerDown(event(110, 80));
        handlers.onPointerUp(event(110, 80, { type: "pointerup", buttons: 0 }));
        assert.deepEqual(h.commits, [{ id: "note-a", bounds: initial }], "next click cannot persist the cancelled preview");
      } finally { h.close(); }
    });
  }

  test(`Mac note ${kind} ignores hover and other pointers`, () => {
    const h = noteGesture();
    try {
      const handlers = h.handlers(kind);
      handlers.onPointerDown(event(10, 20));
      handlers.onPointerMove(event(110, 80, { buttons: 0 }));
      handlers.onPointerUp(event(110, 80, { pointerId: 2, type: "pointerup", buttons: 0 }));
      handlers.onPointerCancel(event(0, 0, { pointerId: 2, type: "pointercancel", buttons: 0 }));
      handlers.onLostPointerCapture(event(0, 0, { pointerId: 2 }));
      assert.equal(h.bounds().transform, "translate(100px, 200px)");
      assert.equal(h.bounds().width, 300);
      assert.deepEqual(h.commits, []);
      handlers.onPointerUp(event(110, 80, { type: "pointerup", buttons: 0 }));
      assert.equal(h.commits.length, 1, "the original pointer still owns the gesture");
    } finally { h.close(); }
  });

  for (const platform of ["win32", "linux"]) {
    test(`${platform} note ${kind} keeps pointermove finalization and cancellation behavior`, () => {
      const h = noteGesture({ platform });
      try {
        const handlers = h.handlers(kind);
        handlers.onPointerDown(event(10, 20));
        handlers.onPointerMove(event(60, 50));
        handlers.onPointerUp(event(110, 80, { type: "pointerup", buttons: 0 }));
        const bounds = kind === "drag"
          ? { position: { x: 150, y: 230 }, size: initial.size }
          : { position: initial.position, size: { width: 350, height: 250 } };
        assert.deepEqual(h.commits, [{ id: "note-a", bounds }]);
        handlers.onPointerDown(event(10, 20));
        handlers.onPointerMove(event(60, 50));
        handlers.onPointerCancel(event(0, 0, { type: "pointercancel", buttons: 0 }));
        assert.equal(h.commits.length, 2, "legacy cancellation continues its existing save path");
      } finally { h.close(); }
    });
  }
}

test("Mac note release still applies move snapping and west/north resize constraints", () => {
  const moved = noteGesture({ snapEnabled: true });
  try {
    const handlers = moved.handlers("drag");
    handlers.onPointerDown(event(10, 20));
    handlers.onPointerUp(event(123, 94, { type: "pointerup", buttons: 0 }));
    assert.deepEqual(moved.commits[0].bounds.position, { x: 210, y: 270 });
  } finally { moved.close(); }
  const resized = noteGesture({ direction: "nw" });
  try {
    const handlers = resized.handlers("resize");
    handlers.onPointerDown(event(10, 20));
    handlers.onPointerUp(event(260, 220, { type: "pointerup", buttons: 0 }));
    assert.deepEqual(resized.commits[0].bounds, {
      position: { x: 220, y: 280 }, size: { width: 180, height: 140 }
    });
  } finally { resized.close(); }
});
