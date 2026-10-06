import assert from "node:assert/strict";
import test from "node:test";
import { findAll, importWithFakeReact } from "./helpers/fake-react.mjs";

const { RemarkPanel, __render, __flush, __unmount } = await importWithFakeReact(
  "src/renderer/src/features/materials/RemarkPanel.tsx", "RemarkPanel"
);

function fixture(t, status) {
  t.after(__unmount);
  const actions = [];
  const props = {
    locale: "en",
    remark: {
      id: "remark", number: 1, target: { materialId: "material", versionId: "version", anchor: { kind: "whole" } },
      reference: null, text: "Fix the fixture", status, createdAt: 1, updatedAt: 1, handoffIds: [], report: null
    },
    handoff: null, referenceName: null, stale: false, onAction: (action) => actions.push(action), onClose() {}
  };
  const render = () => __render(() => RemarkPanel(props));
  render();
  __flush();
  return { actions, render };
}

function danger(tree) {
  return findAll(tree, (node) => node.type === "button" && node.props.className === "material-remark-panel__danger")[0];
}

for (const status of ["open", "reopened", "sent", "reported", "accepted"]) {
  test(`delete confirms a ${status} remark`, (t) => {
    const { actions, render } = fixture(t, status);
    danger(render()).props.onClick();
    assert.deepEqual(actions, []);
    __flush();
    danger(render()).props.onClick();
    assert.deepEqual(actions, ["delete"]);
  });
}

test("cancel preserves a sent remark", (t) => {
  const { actions, render } = fixture(t, "sent");
  danger(render()).props.onClick();
  __flush();
  const cancel = findAll(render(), (node) => node.type === "button" && node.props.children === "Cancel")[0];
  assert.ok(cancel);
  cancel.props.onClick();
  __flush();
  danger(render()).props.onClick();
  assert.deepEqual(actions, []);
});
