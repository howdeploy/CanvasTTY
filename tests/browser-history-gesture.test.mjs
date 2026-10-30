import assert from "node:assert/strict";
import test from "node:test";
import { BrowserHistoryGesture } from "../src/main/services/browser/BrowserHistoryGesture.ts";
const phase = (phase, momentumPhase = 0) => ({phase, momentumPhase, x: 200, y: 200});

test("physical release ends the gesture before independent momentum starts; navigation is tab-scoped and once", () => {
  const controller = new BrowserHistoryGesture();
  const begin = controller.observe(phase(1), "tab-a");
  const id = begin.gesture.id;
  controller.claim("tab-a", {nativeGestureId: id, historySwipeClaimed: true});
  assert.equal(controller.canNavigate("tab-a", id), false);
  assert.equal(controller.observe(phase(4), "tab-a"), null);
  assert.equal(controller.observe(phase(8), "tab-a").gesture.phase, "ended");
  assert.equal(controller.canNavigate("tab-b", id), false);
  assert.equal(controller.canNavigate("tab-a", id + 1), false);
  assert.equal(controller.canNavigate("tab-a", id), true);
  controller.consume();
  for (const momentum of [1, 4, 8]) {
    assert.equal(controller.observe(phase(0, momentum), "tab-a"), null);
    assert.equal(controller.canNavigate("tab-a", id), false);
  }
  const next = controller.observe(phase(1), "tab-a");
  assert.ok(next.gesture.id > id);
  assert.equal(next.gesture.phase, "active");
});

test("cancelled and unclaimed gestures do not navigate, and unphased wheels restore fallback", () => {
  const controller = new BrowserHistoryGesture();
  const id = controller.observe(phase(1), "tab-a").gesture.id;
  controller.observe(phase(8), "tab-a");
  assert.equal(controller.canNavigate("tab-a", id), false);
  controller.claim("tab-a", {nativeGestureId:id,historySwipeClaimed:true});
  assert.equal(controller.observe(phase(16), null).gesture.phase, "cancelled");
  controller.observe(phase(0,1), "tab-a");
  assert.equal(controller.canNavigate("tab-a", id), false);
  controller.observe(phase(0), "tab-a");
  assert.equal(controller.snapshot("tab-a"), null);
});
