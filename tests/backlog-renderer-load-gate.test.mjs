import test from "node:test";
import assert from "node:assert/strict";
import { InspectorLoadGate } from "../src/renderer/src/features/workspace/inspectorLoadGate.ts";

test("inspector load gate coalesces active-tab requests to the newest request", () => {
  const gate = new InspectorLoadGate();

  assert.equal(gate.begin({ tab: "timeline" }, true), true);
  assert.equal(gate.begin({ tab: "usage" }, false), false);
  assert.equal(gate.begin({ tab: "tasks" }, true), false);
  assert.equal(gate.begin({ tab: "budget" }, true), false);
  assert.deepEqual(gate.finish(), { tab: "budget" });
  assert.equal(gate.begin({ tab: "budget" }, true), true);
  assert.deepEqual(gate.finish(), null);
});

test("inspector load gate discards queued work when the inspector closes", () => {
  const gate = new InspectorLoadGate();

  assert.equal(gate.begin({ tab: "timeline" }, true), true);
  assert.equal(gate.begin({ tab: "tasks" }, true), false);
  gate.cancel();
  assert.equal(gate.begin({ tab: "usage" }, true), true);
  assert.deepEqual(gate.finish(), null);
});
