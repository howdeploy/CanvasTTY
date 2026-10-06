import assert from "node:assert/strict";
import test from "node:test";
import { findAll, importWithFakeReact } from "./helpers/fake-react.mjs";
import { modalFixture } from "./helpers/modal-focus.mjs";

const { HandoffDialog, __render, __flush, __unmount } = await importWithFakeReact(
  "src/renderer/src/features/materials/HandoffDialog.tsx", "HandoffDialog"
);

function fixture(t) {
  let closed = 0;
  const props = {
    locale: "en", initialRemarkIds: [], sessions: [], materials: [], remarks: [], handoffs: [], lastSessionId: null,
    onClose: () => { closed += 1; }, onSent() {}, onFocusSession() {}
  };
  return {
    ...modalFixture(t, HandoffDialog, props, { __render, __flush, __unmount }),
    closed: () => closed
  };
}

test("opening a handoff moves focus into the dialog", (t) => {
  const { doc, root, render } = fixture(t);
  render();
  assert.equal(doc.activeElement.key, root.controls[0].key);
});

test("Tab stays among enabled visible controls", (t) => {
  const { doc, root, render, key } = fixture(t);
  render();
  const enabled = root.controls.filter((element) => !element.disabled);
  root.controls.at(-1).disabled = false;
  root.controls.at(-1).hidden = true;
  enabled[0].focus();
  assert.equal(key("Tab", true).prevented, true);
  assert.equal(doc.activeElement.key, enabled.at(-1).key);
  assert.equal(key("Tab").prevented, true);
  assert.equal(doc.activeElement.key, enabled[0].key);
  enabled[1].focus();
  assert.equal(key("Tab").prevented, false);
});

test("focus cannot move behind the handoff", (t) => {
  const { doc, root, trigger, render } = fixture(t);
  render();
  trigger.focus();
  assert.equal(doc.activeElement.key, root.controls[0].key);
  doc.activeElement = doc.body;
  render();
  assert.equal(doc.activeElement.key, root.controls[0].key);
});

test("closing restores the connected trigger", (t) => {
  const { doc, root, trigger, render } = fixture(t);
  render();
  root.controls.at(-2).focus();
  __unmount();
  assert.equal(doc.activeElement.key, trigger.key);
});

test("closing skips a removed trigger", (t) => {
  const { doc, trigger, render } = fixture(t);
  render();
  trigger.isConnected = false;
  __unmount();
  assert.notEqual(doc.activeElement.key, trigger.key);
});

test("the handoff note has its visible label", (t) => {
  const { render } = fixture(t);
  const tree = render();
  const note = findAll(tree, (node) => node.type === "textarea")[0];
  assert.equal(typeof note.props["aria-labelledby"], "string");
  const label = findAll(tree, (node) => node.props?.id === note.props["aria-labelledby"])[0];
  assert.equal(label.props.children, "Additional note");
});

test("Escape closes only the handoff", (t) => {
  const { render, closed } = fixture(t);
  const tree = render();
  const section = findAll(tree, (node) => node.props?.role === "dialog")[0];
  let prevented = false;
  let stopped = false;
  section.props.onKeyDown({
    key: "Escape",
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; }
  });
  assert.equal(closed(), 1);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});
