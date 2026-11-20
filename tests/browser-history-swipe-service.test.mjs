import assert from "node:assert/strict";
import test from "node:test";
import { browserServiceHarness } from "./fixtures/browser-service-harness.mjs";

const wheel = { deltaX: -180, deltaY: 0, deltaMode: 0, viewportWidth: 900,
  viewportHeight: 600, ctrlKey: false, metaKey: false };

test("history swipe uses human navigation once and rejects foreign senders, stale generations and lost focus", async (t) => {
  const { BrowserService, FakeWindow, root, onCleanup } = await browserServiceHarness(t);
  const owner = new FakeWindow();
  const browser = new BrowserService(() => owner, { userDataPath: root, restoreTabs: false });
  onCleanup(() => browser.dispose());
  const state = await browser.newTab("https://fixture.test/");
  browser.setViewport({ x: 0, y: 120, width: 900, height: 600, surface: "native", showAgentPresence: false });
  browser.setInputFocused(true);
  const contents = browser.tabs.get(state.activeTabId).view.webContents;
  contents.navigationHistory = { canGoBack: () => true, canGoForward: () => true };
  const calls = [];
  browser.back = async (id) => calls.push(["back", id]);
  browser.forward = async (id) => calls.push(["forward", id]);
  const decision = browser.decidePageWheel(contents, wheel);
  assert.equal(decision.canGoBack, true);
  const request = { ...wheel, generation: decision.generation, historySwipe: "back" };
  browser.handlePageWheel(owner.webContents, request);
  browser.handlePageWheel(contents, { ...request, generation: 999 });
  owner.isFocused = () => false;
  browser.handlePageWheel(contents, request);
  assert.deepEqual(calls, []);
  owner.isFocused = () => true;
  browser.handlePageWheel(contents, request);
  browser.handlePageWheel(contents, request);
  assert.deepEqual(calls, [["back", state.activeTabId]]);
  // A new document's preload must not treat the old gesture's momentum as another swipe.
  browser.canvasGestures.endSequence(false);
  const tail = browser.decidePageWheel(contents, wheel);
  assert.equal(tail.canGoBack, false);
  browser.handlePageWheel(contents, { ...request, generation: tail.generation });
  assert.equal(calls.length, 1);
});

test("native release authorizes a held swipe after wheel idle and momentum cannot navigate twice", async (t) => {
  const { BrowserService, FakeWindow, root, onCleanup } = await browserServiceHarness(t);
  let now = 1000;
  const owner = new FakeWindow();
  const browser = new BrowserService(() => owner, {userDataPath:root,restoreTabs:false,now:()=>now});
  onCleanup(() => browser.dispose());
  const state = await browser.newTab("https://fixture.test/");
  browser.setViewport({x:0,y:120,width:900,height:600,surface:"native",showAgentPresence:false});
  browser.setInputFocused(true);
  const contents = browser.tabs.get(state.activeTabId).view.webContents;
  contents.navigationHistory = {canGoBack:()=>true,canGoForward:()=>true};
  const signals = [];
  contents.send = (channel, data) => signals.push({channel,data});
  const calls = [];
  browser.back = async (id) => calls.push(id);
  browser.handleNativeHistoryGesture({phase:1,momentumPhase:0,x:200,y:200});
  const decision = browser.decidePageWheel(contents, wheel);
  const id = decision.nativeGesture.id;
  assert.equal(decision.nativeGesture.phase, "active");
  browser.handlePageWheel(contents, {...wheel,generation:decision.generation,nativeGestureId:id,historySwipeClaimed:true});
  now += 1000;
  browser.handleNativeHistoryGesture({phase:8,momentumPhase:0,x:200,y:200});
  assert.equal(signals.at(-1).data.phase, "ended");
  const request = {...wheel,generation:decision.generation,nativeGestureId:id,historySwipe:"back"};
  browser.handlePageWheel(contents, request);
  browser.handleNativeHistoryGesture({phase:0,momentumPhase:1,x:200,y:200});
  browser.handlePageWheel(contents, request);
  assert.deepEqual(calls, [state.activeTabId]);
  assert.equal(browser.decidePageWheel(contents, wheel).nativeGesture.phase, "ended");
  browser.handleNativeHistoryGesture({phase:1,momentumPhase:0,x:200,y:200});
  const next = browser.decidePageWheel(contents, wheel);
  browser.handlePageWheel(contents, {...wheel,generation:next.generation,nativeGestureId:next.nativeGesture.id,historySwipeClaimed:true});
  owner.hide(); owner.show();
  browser.handleNativeHistoryGesture({phase:8,momentumPhase:0,x:200,y:200});
  browser.handlePageWheel(contents, {...request,generation:next.generation,nativeGestureId:next.nativeGesture.id});
  assert.deepEqual(calls, [state.activeTabId], "hiding the window cancels an unfinished native gesture");
});

for (const [elapsed, expected] of [[320, 1], [501, 0]]) {
  test(`unphased swipe completion after ${elapsed} ms respects the animation grace window`, async (t) => {
    const { BrowserService, FakeWindow, root, onCleanup } = await browserServiceHarness(t);
    let now = 1000;
    const owner = new FakeWindow();
    const browser = new BrowserService(() => owner, {userDataPath:root,restoreTabs:false,now:()=>now});
    onCleanup(() => browser.dispose());
    const state = await browser.newTab("https://fixture.test/");
    browser.setViewport({x:0,y:120,width:900,height:600,surface:"native",showAgentPresence:false});
    browser.setInputFocused(true);
    const contents = browser.tabs.get(state.activeTabId).view.webContents;
    contents.navigationHistory = {canGoBack:()=>true,canGoForward:()=>true};
    const calls = [];
    browser.back = async (id) => calls.push(id);
    const decision = browser.decidePageWheel(contents, wheel);
    now += elapsed;
    browser.handlePageWheel(contents, {...wheel,generation:decision.generation,historySwipe:"back"});
    assert.equal(calls.length, expected);
  });
}

test("Duo releases held keys and mouse buttons on the original tab when the tab changes or control ends", async (t) => {
  const { BrowserService, FakeWindow, root, onCleanup } = await browserServiceHarness(t);
  const owner = new FakeWindow();
  const browser = new BrowserService(() => owner, { userDataPath: root, restoreTabs: false });
  onCleanup(() => browser.dispose());

  const first = (await browser.newTab("https://first.test/")).activeTabId;
  const second = (await browser.newTab("https://second.test/")).activeTabId;
  const firstEvents = [], secondEvents = [];
  browser.tabs.get(first).view.webContents.sendInputEvent = event => firstEvents.push(event);
  browser.tabs.get(second).view.webContents.sendInputEvent = event => secondEvents.push(event);

  const input = [
    { type: "keyDown", key: "Shift" },
    { type: "mouseDown", x: .25, y: .5, button: "right" }
  ];
  const assertReleased = events => {
    const [key, mouse] = events.slice(-2);
    assert.equal(key.type, "keyUp");
    assert.equal(key.keyCode, events[0].keyCode);
    assert.equal(mouse.type, "mouseUp");
    assert.equal(mouse.button, "right");
    assert.equal(mouse.x, events[2].x);
    assert.equal(mouse.y, events[2].y);
  };

  await browser.selectTab(first);
  await browser.duoDocumentResource("browser-input", [first, input]);
  await browser.selectTab(second);
  assertReleased(firstEvents);
  assert.deepEqual(secondEvents, []);
  await assert.rejects(browser.duoDocumentResource("browser-input", [first, input]), /Invalid shared browser input/);

  await browser.duoDocumentResource("browser-input", [second, input]);
  await browser.duoDocumentResource("browser-release", []);
  assertReleased(secondEvents);
  const total = secondEvents.length;
  await browser.duoDocumentResource("browser-release", []);
  assert.equal(secondEvents.length, total);
});
