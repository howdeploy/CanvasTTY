import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { arrangeTaskTree, arrangeWorkspace, taskTreeBounds } from "../src/renderer/src/features/workspace/workspaceLayout.ts";
import { aggregateTaskChildren, directTaskEdges, elapsedLabel, taskBudgetLabel, taskCardState } from "../src/renderer/src/features/workspace/workspaceTaskGraph.ts";
import { prepareWorkspaceContextPreview, truncateContextPreview } from "../src/renderer/src/features/workspace/workspaceContextDrop.ts";

const card = (x = 0, y = 0, width = 220, height = 140) => ({ position: { x, y }, size: { width, height } });
const overlaps = (a, b) => a.position.x < b.position.x + b.size.width
  && a.position.x + a.size.width > b.position.x
  && a.position.y < b.position.y + b.size.height
  && a.position.y + a.size.height > b.position.y;
const assertNoOverlap = (placements) => {
  const values = [...placements.entries()];
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      assert.equal(overlaps(values[i][1], values[j][1]), false, `${values[i][0]} overlaps ${values[j][0]}`);
    }
  }
};

test("tree, status, project, and grid layouts keep mixed-size windows disjoint at 1–40 cards", () => {
  for (let count = 1; count <= 40; count += 1) {
    const items = Array.from({ length: count }, (_, index) => ({
      id: `session-${index}`,
      bounds: card(0, 0, 180 + (index % 4) * 35, 100 + (index % 5) * 27),
      ...(index > 0 && index % 3 !== 0 ? { parentId: `session-${Math.floor((index - 1) / 3)}` } : {}),
      status: ["working", "needs_approval", "done", "failed", "idle"][index % 5],
      project: ["/one", "/two", "/three"][index % 3]
    }));
    assertNoOverlap(arrangeTaskTree(items, { x: -200, y: 60 }));
    assertNoOverlap(arrangeWorkspace(items, "status", { x: -200, y: 60 }));
    assertNoOverlap(arrangeWorkspace(items, "project", { x: -200, y: 60 }));
    assertNoOverlap(arrangeWorkspace(items, "grid", { x: -200, y: 60 }));
  }
});

test("gathering a task reflows only its live descendants into a parent-rooted tree", () => {
  const items = [
    { id: "root", bounds: card(400, 300) },
    { id: "a", parentId: "root", bounds: card(-800, -100) },
    { id: "b", parentId: "root", bounds: card(950, 800) },
    { id: "c", parentId: "a", bounds: card(30, 1800) },
    { id: "unrelated", bounds: card(5000, 5000) }
  ];
  const result = taskTreeBounds(items[0], items);
  assert.deepEqual([...result.keys()].sort(), ["a", "b", "c", "root"]);
  assert.deepEqual(result.get("root").position, { x: 400, y: 300 });
  assertNoOverlap(result);
  assert.equal(result.has("unrelated"), false);
});

test("live parent-child status and elapsed summaries use the current session snapshot", () => {
  const children = [
    { id: "w", status: "working", turnCompleted: false, parentSessionId: "p" },
    { id: "a", status: "needs_approval", turnCompleted: false, parentSessionId: "p" },
    { id: "d", status: "idle", turnCompleted: true, parentSessionId: "p" },
    { id: "f", status: "failed", turnCompleted: false, parentSessionId: "p" }
  ];
  assert.equal(taskCardState(children[0]), "working");
  assert.deepEqual(aggregateTaskChildren(children), { total: 4, working: 1, waiting: 1, done: 1, failed: 1 });
  assert.deepEqual(directTaskEdges([{ id: "p" }, ...children]).map((edge) => [edge.parentId, edge.childId, edge.state]), [
    ["p", "w", "working"], ["p", "a", "waiting"], ["p", "d", "done"], ["p", "f", "failed"]
  ]);
  assert.equal(elapsedLabel(3_723_000), "1:02:03");
});

test("file and text drops show masked, explicitly truncated previews before paste", async () => {
  const calls = [];
  const backlog = { redactText: async (text) => { calls.push(["redact", text]); return text.replace("secret", "[masked]"); } };
  const terminal = { describeFileDrop: async (files, id) => {
    calls.push(["describe", files.length, id]);
    return { text: "secret file contents", paths: ["/work/a.ts"], outsideProject: [] };
  } };
  const preview = await prepareWorkspaceContextPreview("s1", {
    files: [new Blob(["file"])], text: "", url: ""
  }, backlog, terminal);
  assert.deepEqual(preview, {
    sessionId: "s1", text: "[masked] file contents", paths: ["/work/a.ts"], outsideProject: [], truncated: false
  });
  assert.deepEqual(calls, [["describe", 1, "s1"], ["redact", "secret file contents"]]);
  const clipped = truncateContextPreview("x".repeat(16_100));
  assert.equal(clipped.truncated, true);
  assert.match(clipped.text, /preview truncated/u);
  assert.equal(clipped.text.length <= 16_000, true);
});

// Interaction outcomes are owned by smoke-backlog-electron. Keep the source
// checks only for the render-subscription contract that it cannot observe.
test("card drag previews subscribe only the edge layer and preserve stable card props", async () => {
  const canvas = await readFile(new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url), "utf8");
  assert.match(canvas, /const EMPTY_TASK_CHILDREN: readonly SessionSnapshot\[\] = \[\]/u);
  assert.equal((canvas.match(/taskChildren=\{taskChildrenByParent\.get\(session\.id\) \?\? EMPTY_TASK_CHILDREN\}/gu) ?? []).length, 2,
    "regular and fullscreen cards share a stable empty children prop");
  assert.match(canvas, /const liveTaskBounds = useMemo\(createTaskBoundsPreviewStore, \[\]\)/u);
  assert.doesNotMatch(canvas, /setLiveTaskBounds/u, "card drag previews do not schedule a whole-canvas React state update");
  assert.match(canvas, /<TaskEdgeLayer edges=\{taskEdges\} sessions=\{sessionById\} previews=\{liveTaskBounds\}/u);
  assert.match(canvas, /useSyncExternalStore\(previews\.subscribe, previews\.getSnapshot, previews\.getSnapshot\)/u,
    "only task-edge geometry subscribes to per-card drag previews");
});

test("the task card does not claim a Windows budget pause suspended running processes", () => {
  const budget = { tokens: null, costUsd: null, durationMs: null, paused: true, warning: false };
  assert.equal(taskBudgetLabel(budget, "en").text, "Budget: paused");
  const inputOnly = taskBudgetLabel({ ...budget, processesKeepRunning: true }, "en");
  assert.equal(inputOnly.text, "Budget: input blocked");
  assert.match(inputOnly.title, /Windows cannot suspend running processes/u);
  assert.match(taskBudgetLabel({ ...budget, processesKeepRunning: true }, "ru").text, /ввод заблокирован/u);
  assert.equal(taskBudgetLabel({ ...budget, paused: false, tokens: 5, costUsd: 1.5, durationMs: 61_000 }, "en").text, "5 tokens · $1.50 · 1:01");
});
