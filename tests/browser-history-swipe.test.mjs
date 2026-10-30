import assert from "node:assert/strict";
import test from "node:test";
import { BrowserHistorySwipe } from "../src/preload/BrowserHistorySwipe.ts";

const input = (deltaX, extra = {}) => ({ deltaX, deltaY: 0, deltaMode: 0,
  ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  canGoBack: true, canGoForward: true, scrollable: false, ...extra });

test("swipe previews both history directions and commits only beyond the threshold", () => {
  for (const [delta, direction] of [[-60, "back"], [60, "forward"]]) {
    const swipe = new BrowserHistorySwipe();
    assert.equal(swipe.update(input(delta)).direction, direction);
    assert.equal(swipe.finish(), null);
    swipe.reset();
    swipe.update(input(delta));
    swipe.update(input(delta));
    assert.equal(swipe.update(input(delta)).progress, 1);
    assert.equal(swipe.finish(), direction);
    assert.equal(swipe.finish(), null, "one navigation per gesture including momentum");
  }
});

test("vertical scrolling, scrollable content, modifiers and unavailable history never become swipes", () => {
  for (const extra of [{deltaY: 200}, {scrollable: true}, {ctrlKey: true}, {metaKey: true},
    {altKey: true}, {shiftKey: true}, {deltaMode: 1}, {canGoBack: false}]) {
    const swipe = new BrowserHistorySwipe();
    assert.equal(swipe.update(input(-200, extra)), null);
    assert.equal(swipe.update(input(-200)), null, "do not steal an ongoing scroll at its boundary");
    assert.equal(swipe.finish(), null);
  }
  const forward = new BrowserHistorySwipe();
  assert.equal(forward.update(input(200, {canGoForward: false})), null);
  assert.equal(forward.finish(), null);
});

test("reversing a swipe below threshold cancels navigation; reset allows a new gesture", () => {
  const swipe = new BrowserHistorySwipe();
  swipe.update(input(-200));
  assert.equal(swipe.update(input(140)).progress < 1, true);
  assert.equal(swipe.finish(), null);
  swipe.reset();
  assert.equal(swipe.update(input(200)).direction, "forward");
  assert.equal(swipe.finish(), "forward");
});
