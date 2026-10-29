import assert from "node:assert/strict";
import test from "node:test";
import { importWithFakeReact, findAll, change } from "./helpers/fake-react.mjs";

const react = await importWithFakeReact("src/renderer/src/features/notes/StickyNoteCard.tsx", "StickyNoteCard");

function noteEditor(platform = "darwin") {
  react.__reset();
  const timers = new Map();
  let nextTimer = 0;
  const previousWindow = globalThis.window;
  globalThis.window = {
    canvasTTY: { window: { platform, isMacOS: platform === "darwin" } },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {}
  };
  const saves = [];
  const props = {
    note: { id: "note-a", text: "", position: { x: 0, y: 0 }, size: { width: 300, height: 220 } },
    locale: "en", camera: { get: () => ({ zoom: 1 }) }, stackIndex: 1, editRequest: 0,
    snapEnabled: false, getSnapTargets: () => [], onBoundsChange() {}, onClose() {},
    onTextChange(id, text) { saves.push({ id, text }); }
  };
  let tree;
  const render = () => { react.__flush(); tree = react.__render(react.StickyNoteCard, props); };
  const editor = () => findAll(tree, (node) => node.type === "textarea")[0];
  const acknowledge = (text) => { props.note = { ...props.note, text }; render(); render(); };
  const type = (text) => { change(editor(), text); render(); };
  const debounce = () => {
    for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
    render();
  };
  render(); render();
  return {
    editor, type, acknowledge, debounce, saves, timers,
    unmount() { react.__unmount(); globalThis.window = previousWindow; }
  };
}

for (const finish of ["blur", "debounce", "unmount"]) {
  test(`Mac note preserves AB across a late A save response and ${finish} saves AB`, () => {
    const h = noteEditor();
    try {
      h.type("A"); h.debounce();
      assert.deepEqual(h.saves, [{ id: "note-a", text: "A" }]);
      h.type("AB");
      h.acknowledge("A");
      assert.equal(h.editor().props.value, "AB");
      assert.equal(h.timers.size, 1);
      if (finish === "blur") h.editor().props.onBlur();
      else if (finish === "debounce") h.debounce();
      else { h.unmount(); return assert.deepEqual(h.saves.map(({ text }) => text), ["A", "AB"]); }
      assert.deepEqual(h.saves.map(({ text }) => text), ["A", "AB"]);
      assert.equal(h.timers.size, 0);
      h.acknowledge("AB");
      h.editor().props.onBlur();
      assert.equal(h.saves.length, 2, "acknowledging the current draft does not save it twice");
      h.acknowledge("external update");
      assert.equal(h.editor().props.value, "external update", "a clean editor still receives external changes");
    } finally {
      h.unmount();
    }
  });
}

test("Mac note retains its newer submitted text when an earlier save responds", () => {
  const h = noteEditor();
  try {
    h.type("A"); h.debounce();
    h.type("AB"); h.debounce();
    h.acknowledge("A");
    assert.equal(h.editor().props.value, "AB");
    h.editor().props.onBlur();
    assert.deepEqual(h.saves.map(({ text }) => text), ["A", "AB"]);
    h.acknowledge("AB");
    assert.equal(h.editor().props.value, "AB");
  } finally { h.unmount(); }
});

test("Mac note preserves a newer edit that returns to the original empty text", () => {
  const h = noteEditor();
  try {
    h.type("A"); h.debounce();
    h.type("");
    h.acknowledge("A");
    assert.equal(h.editor().props.value, "");
    h.editor().props.onBlur();
    assert.deepEqual(h.saves.map(({ text }) => text), ["A", ""]);
    h.acknowledge("");
    h.acknowledge("external update");
    assert.equal(h.editor().props.value, "external update");
  } finally { h.unmount(); }
});

for (const platform of ["win32", "linux"]) {
  test(`${platform} keeps its existing note synchronization behavior`, () => {
    const h = noteEditor(platform);
    try {
      h.type("A"); h.debounce();
      h.type("AB"); h.acknowledge("A");
      assert.equal(h.editor().props.value, "A");
      h.editor().props.onBlur();
      assert.deepEqual(h.saves.map(({ text }) => text), ["A"]);
      assert.equal(h.timers.size, 0);
    } finally { h.unmount(); }
  });
}
