import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const helperPath = fileURLToPath(new URL("../src/renderer/src/features/terminal/pluginReviewUiState.ts", import.meta.url));
const helperModule = await build({
  entryPoints: [helperPath],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent"
});
const { TaskReviewSessionTracker, virtualFileWindow } = await import(
  `data:text/javascript;base64,${Buffer.from(helperModule.outputFiles[0].text).toString("base64")}`
);

test("plugin review file window renders only nearby rows and preserves scroll geometry", () => {
  const atStart = virtualFileWindow(400, 0, 320, 56, 3);
  assert.equal(atStart.startIndex, 0);
  assert.ok(atStart.endIndex < 20);
  assert.equal(atStart.topSpacerHeight, 0);
  assert.equal(atStart.topSpacerHeight + atStart.endIndex * 56 + atStart.bottomSpacerHeight, 400 * 56);

  const inMiddle = virtualFileWindow(400, 200 * 56, 320, 56, 3);
  assert.ok(inMiddle.startIndex <= 200);
  assert.ok(inMiddle.endIndex > 205);
  assert.equal(inMiddle.topSpacerHeight, inMiddle.startIndex * 56);
  assert.equal(inMiddle.topSpacerHeight + (inMiddle.endIndex - inMiddle.startIndex) * 56 + inMiddle.bottomSpacerHeight, 400 * 56);

  const atEnd = virtualFileWindow(400, 399 * 56, 320, 56, 3);
  assert.equal(atEnd.endIndex, 400);
  assert.equal(atEnd.bottomSpacerHeight, 0);
  assert.deepEqual(virtualFileWindow(0, 0, 320, 56), {
    startIndex: 0, endIndex: 0, topSpacerHeight: 0, bottomSpacerHeight: 0
  });
});

test("plugin review session tracker refreshes once per relevant turn transition", () => {
  const tracker = new TaskReviewSessionTracker("task-root");
  tracker.include("agent-one");
  tracker.seedSubtree([
    { id: "agent-one", parentSessionId: "task-root" },
    { id: "nested-existing", parentSessionId: "agent-one" },
    { id: "unrelated", parentSessionId: "other-root" }
  ]);
  const event = (id, status, parentSessionId, turnCompleted) => ({ id, status, parentSessionId, turnCompleted });

  assert.equal(tracker.observe(event("unrelated", "done", "other-root")), false);
  assert.equal(tracker.observe(event("agent-one", "working", "task-root", false)), false);
  assert.equal(tracker.observe(event("agent-one", "working", "task-root", false)), false);
  assert.equal(tracker.observe(event("agent-one", "working", "task-root", true)), true);
  assert.equal(tracker.observe(event("agent-one", "working", "task-root", true)), false);
  assert.equal(tracker.observe(event("agent-one", "working", "task-root", false)), true);

  // Once a child has been announced within the task subtree, its descendants are in scope too.
  assert.equal(tracker.observe(event("nested-agent", "idle", "agent-one", false)), false);
  assert.equal(tracker.observe(event("nested-agent", "failed", "agent-one", false)), true);
  assert.equal(tracker.observe(event("nested-agent", "failed", "agent-one", false)), false);
  assert.equal(tracker.observe(event("nested-existing", "done", "agent-one", false)), true);
  assert.equal(tracker.observe(event("unrelated", "done", "other-root", false)), false);
});
