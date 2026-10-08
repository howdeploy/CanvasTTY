import assert from "node:assert/strict";
import test from "node:test";
import { aggregateTaskChildren, directTaskEdges, taskBudgetLabel } from "../src/renderer/src/features/workspace/workspaceTaskGraph.ts";
import { taskTreeBounds, arrangeTaskTree } from "../src/renderer/src/features/workspace/workspaceTaskLayout.ts";
import { DraftRevision, shouldHydrateDraft } from "../src/renderer/src/features/workspace/workspaceAsyncState.ts";

const item = (id, parentId, x = 0, y = 0, width = 200, height = 120) => ({
  id, parentId, bounds: { position: { x, y }, size: { width, height } }
});

test("task graph ignores absent parents and aggregates completed turns and approval waits", () => {
  const sessions = [
    { id: "root", status: "working" },
    { id: "working", parentSessionId: "root", status: "working" },
    { id: "approval", parentSessionId: "root", status: "needs_approval" },
    { id: "finished", parentSessionId: "root", status: "idle", turnCompleted: true },
    { id: "failed", parentSessionId: "root", status: "unavailable" },
    { id: "orphan", parentSessionId: "missing", status: "idle" }
  ];
  assert.deepEqual(directTaskEdges(sessions).map(({ childId, state }) => [childId, state]), [
    ["working", "working"], ["approval", "waiting"], ["finished", "done"], ["failed", "failed"]
  ]);
  assert.deepEqual(aggregateTaskChildren(sessions.slice(1, 5)), { total: 4, working: 1, waiting: 1, done: 1, failed: 1 });
});

test("gather task keeps its root anchored, includes grandchildren, and leaves other trees alone", () => {
  const root = item("root", undefined, 230, 70);
  const items = [root, item("a", "root"), item("b", "root", 0, 0, 150, 330), item("grandchild", "a"), item("other")];
  const placements = taskTreeBounds(root, items);
  assert.deepEqual(placements.get("root"), root.bounds);
  assert.deepEqual([...placements.keys()].sort(), ["a", "b", "grandchild", "root"]);
  const rows = [...placements.values()];
  for (let a = 0; a < rows.length; a += 1) for (let b = a + 1; b < rows.length; b += 1) {
    const first = rows[a], second = rows[b];
    const overlap = first.position.x < second.position.x + second.size.width
      && second.position.x < first.position.x + first.size.width
      && first.position.y < second.position.y + second.size.height
      && second.position.y < first.position.y + first.size.height;
    assert.equal(overlap, false);
  }
});

test("malformed cyclic parent metadata still produces a finite placement for every card", () => {
  const result = arrangeTaskTree([item("a", "b"), item("b", "a"), item("self", "self")], { x: 10, y: 20 });
  assert.equal(result.size, 3);
  for (const value of result.values()) {
    assert.equal(Number.isFinite(value.position.x) && Number.isFinite(value.position.y), true);
  }
});

test("budget refresh cannot overwrite a newer local draft", () => {
  const revision = new DraftRevision();
  const request = revision.capture();
  assert.equal(shouldHydrateDraft(request, request, false, false), true);
  revision.advance();
  assert.equal(shouldHydrateDraft(request, revision.capture(), true, true), false);
  assert.equal(shouldHydrateDraft(revision.capture(), revision.capture(), true, true), false);
});

test("Windows budget summary distinguishes blocked input from suspended processes", () => {
  const limit = { tokens: 100, costUsd: 1, durationMs: 120000, paused: true, warning: false };
  assert.match(taskBudgetLabel({ ...limit, processesKeepRunning: true }, "en").text, /input blocked/);
  assert.match(taskBudgetLabel(limit, "en").text, /paused/);
  assert.match(taskBudgetLabel({ ...limit, paused: false }, "en").text, /100 tokens.*\$1.00.*2:00/);
});
