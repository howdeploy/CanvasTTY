import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

async function preloadHarness() {
  const listeners = new Map();
  const timers = new Map();
  const frames = new Map();
  const navigation = [];
  let nextId = 1;
  let now = 0;
  let hudVisible = false;
  let paintedHudVisible = false;
  const document = {
    hasFocus: () => true, visibilityState: "visible", scrollingElement: null,
    addEventListener() {},
    documentElement: { append: () => { hudVisible = true; } },
    createElement: () => ({ style: {}, setAttribute() {},
      attachShadow: () => ({ append() {} }), remove: () => { hudVisible = false; } })
  };
  const window = { innerWidth: 900, innerHeight: 600,
    addEventListener: (name, listener) => listeners.set(name, listener) };
  window.top = window;
  const ipcRenderer = {
    sendSync: () => ({ generation: 1, owner: "page", idleMs: 250, canGoBack: true, canGoForward: true }),
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
    swipe() {
      for (let i = 0; i < 4; i++) {
        now += 20;
        listeners.get("wheel")({ isTrusted: true, deltaX: -50, deltaY: 0, deltaMode: 0,
          ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
          composedPath: () => [], preventDefault() {}, stopImmediatePropagation() {} });
      }
      paintedHudVisible = hudVisible;
      assert.equal(paintedHudVisible, true, "the gesture painted its indicator");
    },
    idle() {
      const callbacks = [...timers.values()]; timers.clear();
      for (const {callback, delay} of callbacks) { now += delay; callback(); }
    },
    frame() {
      const callbacks = [...frames.values()]; frames.clear();
      for (const callback of callbacks) callback();
      paintedHudVisible = hudVisible;
    },
    blur: () => listeners.get("blur")(),
    hudVisible: () => hudVisible
  };
}

test("ending a swipe hides and paints the HUD before asynchronously requesting navigation", async () => {
  const page = await preloadHarness();
  page.swipe();
  page.idle();
  assert.equal(page.hudVisible(), false, "hide without waiting for a browser event");
  assert.equal(page.navigation.length, 0, "navigation must wait for the cleared HUD to paint");
  page.frame();
  page.frame();
  assert.deepEqual(page.navigation, [{ direction: "back", paintedHudVisible: false }]);
});

test("losing focus cancels navigation queued after HUD dismissal", async () => {
  const page = await preloadHarness();
  page.swipe(); page.idle(); page.blur(); page.frame(); page.frame();
  assert.equal(page.hudVisible(), false);
  assert.deepEqual(page.navigation, []);
});
