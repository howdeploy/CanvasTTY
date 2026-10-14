import assert from "node:assert/strict";
import test from "node:test";
import { cardHasOptions, checkpointsItemShown } from "../src/renderer/src/features/terminal/cardOptions.ts";

const point = { id: "refs/canvastty/card/1-00000000-0000-0000-0000-000000000000", at: 1, kind: "before-turn" };

test("an auto or YOLO agent outside a Git root, with restore off and no plugin actions, has no options button", () => {
  for (const profile of ["auto", "yolo"]) {
    const shown = checkpointsItemShown({ ok: false, code: "not-git-root" }, profile);
    assert.equal(shown, false);
    assert.equal(cardHasOptions({ restoreEnabled: false, checkpointsShown: shown, pluginActions: 0 }), false, profile);
  }
});

test("the Rollback points item shows at a Git root for auto/YOLO agents, and for any agent once points exist", () => {
  assert.equal(checkpointsItemShown({ ok: true, checkpoints: [] }, "auto"), true);
  assert.equal(checkpointsItemShown({ ok: true, checkpoints: [] }, "yolo"), true);
  assert.equal(checkpointsItemShown({ ok: true, checkpoints: [] }, "normal"), false);
  assert.equal(checkpointsItemShown({ ok: true, checkpoints: [point] }, "normal"), true);
  assert.equal(cardHasOptions({ restoreEnabled: false, checkpointsShown: true, pluginActions: 0 }), true);
});

test("restore or a plugin action alone keeps the options button", () => {
  assert.equal(cardHasOptions({ restoreEnabled: true, checkpointsShown: false, pluginActions: 0 }), true);
  assert.equal(cardHasOptions({ restoreEnabled: false, checkpointsShown: false, pluginActions: 1 }), true);
});
