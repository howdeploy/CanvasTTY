import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

async function preloadHarness({ reducedMotion = false } = {}) {
  const listeners = new Map();
  const timers = new Map();
  const frames = new Map();
  const ipcListeners = new Map();
  const navigation = [];
  let replyNative = null;
  let nextId = 1;
  let now = 0;
  let hudVisible = false;
  let paintedHudVisible = false;
  let hudStyle = null;
  const hudFading = () => hudVisible && hudStyle?.opacity === "0" && hudStyle?.transition === "opacity 150ms ease-out";
  const document = {
    hasFocus: () => true, visibilityState: "visible", scrollingElement: null,
    addEventListener() {},
    documentElement: { append: (element) => { hudVisible = true; hudStyle = element.style; } },
    createElement: () => ({ style: {setProperty(key,value) {this[key] = value;}}, setAttribute() {},
      attachShadow: () => ({ append() {} }), remove: () => { hudVisible = false; } })
  };
  const window = { matchMedia: () => ({matches:reducedMotion}), innerWidth: 900, innerHeight: 600,
    addEventListener: (name, listener) => listeners.set(name, listener) };
  window.top = window;
  const ipcRenderer = {
    on: (channel, listener) => ipcListeners.set(channel, listener),
    sendSync: () => ({ generation: 1, owner: "page", idleMs: 250, canGoBack: true, canGoForward: true, nativeGesture: replyNative }),
    send: (_channel, payload) => {
      if (payload.historySwipe) navigation.push({ direction: payload.historySwipe, paintedHudVisible });
    }
  };
  const result = await build({ entryPoints: ["src/preload/browser.ts"], bundle: true,
    platform: "node", format: "cjs", write: false, external: ["electron"] });
  vm.runInNewContext(result.outputFiles[0].text, {
    require: () => ({ ipcRenderer }), window, document, Element: class {},
    performance: { now: () => now },
    setTimeout: (callback, delay) => { const id = nextId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (callback) => { const id = nextId++; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id)
  });
  return {
    navigation,
    replyNative: (gesture) => {replyNative = gesture;},
    native(phase, id = 1, claimed = false) {
      ipcListeners.get("browser:history-gesture")?.({}, {id, phase, claimed});
    },
    swipe(expectHud = true) {
      for (let i = 0; i < 4; i++) {
        now += 20;
        listeners.get("wheel")({ isTrusted: true, deltaX: -50, deltaY: 0, deltaMode: 0,
          ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
          composedPath: () => [], preventDefault() {}, stopImmediatePropagation() {} });
      }
      paintedHudVisible = hudVisible && !hudFading();
      assert.equal(paintedHudVisible, expectHud, "gesture indicator visibility");
    },
    idle() {
      const callbacks = [...timers.values()]; timers.clear();
      for (const {callback, delay} of callbacks) { now += delay; callback(); }
    },
    frame() {
      const callbacks = [...frames.values()]; frames.clear();
      for (const callback of callbacks) callback();
      paintedHudVisible = hudVisible && !hudFading();
    },
    blur: () => listeners.get("blur")(),
    hudFading,
    hudVisible: () => hudVisible
  };
}

test("ending a swipe starts a 150 ms fade before navigation and cleans it up without a browser event", async () => {
  const page = await preloadHarness();
  page.swipe();
  page.idle();
  assert.equal(page.hudFading(), true, "start dismissal without waiting for a browser event");
  assert.equal(page.navigation.length, 0, "navigation must wait for dismissal to start painting");
  page.frame();
  page.frame();
  assert.deepEqual(page.navigation, [{ direction: "back", paintedHudVisible: false }]);
  assert.equal(page.hudVisible(), true, "navigation dispatch does not wait for fade completion");
  page.idle();
  assert.equal(page.hudVisible(), false, "remove the faded HUD independently of browser completion");
});

test("losing focus cancels navigation queued after HUD dismissal", async () => {
  const page = await preloadHarness();
  page.swipe(); page.idle(); page.blur(); page.frame(); page.frame();
  assert.equal(page.hudVisible(), false);
  assert.deepEqual(page.navigation, []);
});

test("native release starts HUD dismissal immediately and inertia cannot reopen it or postpone navigation", async () => {
  const page = await preloadHarness();
  page.native("active"); page.swipe();
  page.native("ended");
  assert.equal(page.hudFading(), true, "finger release does not wait for wheel idle");
  page.frame(); page.frame();
  assert.deepEqual(page.navigation, [{ direction: "back", paintedHudVisible: false }]);
  page.native("ended", 1, true);
  page.swipe(false); page.idle(); page.frame(); page.frame();
  assert.equal(page.hudVisible(), false, "momentum keeps the HUD dismissed");
  assert.equal(page.navigation.length, 1);
});

test("native finger contact holds the HUD through a pause and cancellation does not navigate", async () => {
  const page = await preloadHarness();
  page.native("active"); page.swipe(); page.idle();
  assert.equal(page.hudVisible(), true, "no debounce while fingers remain down");
  page.native("cancelled"); page.frame(); page.frame();
  assert.equal(page.hudVisible(), false);
  assert.equal(page.navigation.length, 0);
});

test("a new document ignores the previous history swipe's momentum, then accepts a new physical gesture", async () => {
  const page = await preloadHarness();
  page.replyNative({id:1,phase:"ended",claimed:true});
  page.swipe(false); page.idle(); page.frame(); page.frame();
  assert.deepEqual(page.navigation, []);
  page.replyNative({id:2,phase:"active",claimed:false});
  page.native("active", 2); page.swipe(); page.native("ended", 2);
  page.frame(); page.frame();
  assert.deepEqual(page.navigation, [{direction:"back",paintedHudVisible:false}]);
});

test("reduced motion dismisses without a fade and still dispatches asynchronously", async () => {
  const page = await preloadHarness({reducedMotion:true});
  page.native("active"); page.swipe(); page.native("ended");
  assert.equal(page.hudVisible(), false);
  assert.equal(page.navigation.length, 0);
  page.frame(); page.frame();
  assert.equal(page.navigation.length, 1);
});
