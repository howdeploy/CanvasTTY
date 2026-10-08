import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { BrowserCanvasGestureController } from '../src/main/services/browser/BrowserCanvasGestureController.ts';
import { BROWSER_CANVAS_WHEEL_IDLE_MS } from '../src/main/services/browser/BrowserCanvasFreeze.ts';

async function freezeSmokeHarness(t, { breakPlaceholder = false } = {}) {
  let listener = () => {}, controller, slowProbe = true;
  let viewport = { x: 0, y: 0, width: 0, height: 0, surface: 'native', canvasScale: 1 };
  const frames = [], intervals = new Set();
  const renderer = { window: { canvasTTY: { browser: { onCanvasFreezeFrame(fn) {
    listener = fn; return () => { listener = () => {}; };
  } } } } };
  const owner = {
    getParentWindow: () => null, isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    webContents: {
      async executeJavaScript(code) {
        const result = runInNewContext(code, renderer);
        // Model a slow renderer round trip after freeze activation, while the main process idle timer keeps running.
        if (slowProbe && code.includes('some((event) => event.active &&')) {
          slowProbe = false;
          await new Promise(resolve => setTimeout(resolve, BROWSER_CANVAS_WHEEL_IDLE_MS));
        }
        return result;
      },
      sendInputEvent(event) { controller.beginOwnerSequence({ x: event.x, y: event.y }); }
    }
  };
  const tab = { id: 'tab', view: { webContents: {
    isDestroyed: () => false,
    capturePage: async () => ({ getSize: () => ({ width: 2, height: 2 }), toJPEG: () => Buffer.from('fixture-frame') })
  } }, canvasSinkViewport: { preserve: () => true, restore: () => true } };
  controller = new BrowserCanvasGestureController({
    getOwner: () => owner, getViewport: () => viewport, getActiveTab: () => tab, getTab: () => tab,
    isVisible: () => true, isDisposed: () => false,
    getOverrideState: () => ({ wheelActive: false, navigationActive: false }),
    getCursorScreenPoint: () => ({ x: 400, y: 300 }),
    requestSurfaceSync: () => controller.surfaceDecision(tab.id, viewport, { width: 1000, height: 800 }),
    beforeSequenceEnd() {}, shouldDeferIdleEnd: () => false, sendWheel() {},
    sendFreezeFrame(event) { frames.push(event); listener(event); }
  }, { captureMode: 'off' });
  const service = { setViewport(next) {
    const previous = viewport; viewport = next; controller.viewportChanged(previous, next);
    if (breakPlaceholder && next.surface === 'placeholder') controller.endSequence(false);
    controller.surfaceDecision(tab.id, viewport, { width: 1000, height: 800 });
  } };
  const source = await readFile(new URL('../src/main/services/browser/BrowserElectronSmoke.ts', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('async function assertOwnerWheelFreezesCrossingBrowser'), source.indexOf('async function browserSmokePageState'));
  const assertion = runInNewContext(`${stripTypeScriptTypes(block)}; assertOwnerWheelFreezesCrossingBrowser`, {
    Error, BrowserWindow: { getAllWindows: () => [owner] }, BROWSER_CANVAS_WHEEL_IDLE_MS,
    setTimeout, clearTimeout,
    setInterval(callback, ms) { const id = setInterval(callback, ms); intervals.add(id); return id; },
    clearInterval(id) { clearInterval(id); intervals.delete(id); },
    async waitUntil(predicate) {
      const deadline = Date.now() + 2000;
      while (!await predicate()) {
        if (Date.now() > deadline) throw new Error('freeze condition timed out');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
  });
  t.after(() => { for (const id of intervals) clearInterval(id); controller.endSequence(false); });
  return { run: () => assertion(service), frames, intervals };
}

test('owner wheel smoke keeps a real gesture active across slow renderer probes and then observes idle', async t => {
  const h = await freezeSmokeHarness(t);
  await h.run();
  assert.equal(h.intervals.size, 0, 'wheel stream stops after the assertion');
  const active = h.frames.findIndex(event => event.active);
  assert.ok(active >= 0);
  assert.ok(h.frames.slice(active + 1).some(event => !event.active), 'normal idle expiration still occurs');
});

test('owner wheel smoke still rejects a transition that actually ends the gesture and stops its wheel stream', async t => {
  const h = await freezeSmokeHarness(t, { breakPlaceholder: true });
  await assert.rejects(h.run(), /Native\/placeholder transition ended/);
  assert.equal(h.intervals.size, 0, 'wheel stream stops on assertion failure');
});
