// Opt-in visible-window regression harness. Native input is delivered by the OS
// on a disposable desktop; executeJavaScript is only setup/measurement, never
// the measured pointer delivery path.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, nativeImage, screen, type BrowserWindow, type View, type WebContentsView } from "electron";
import type { BrowserCommand, BrowserResult, BrowserSnapshot, BrowserViewportBounds } from "../../../shared/contracts.ts";
import type { BrowserService } from "../BrowserService.ts";
import type { BrowserCanvasGestureController } from "./BrowserCanvasGestureController.ts";
import { clipBrowserViewportBounds } from "./BrowserViewport.ts";

const run = promisify(execFile);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
interface GeometryRuntime {
  viewport: BrowserViewportBounds;
  clipView: View;
  activeTabId: string;
  tabs: Map<string, { view: WebContentsView }>;
  canvasGestures: BrowserCanvasGestureController;
}
interface GeometryWorkspace {
  getState(): BrowserSnapshot;
  navigate(tabId: string, url: string): Promise<unknown>;
  open(url?: string): Promise<BrowserSnapshot>;
  executeHuman?(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult>;
  primaryInstance?: BrowserService;
  windows?: Map<string, { service: BrowserService }>;
}

export async function runBrowserGeometrySmoke(owner: BrowserWindow, input: unknown, origin: string): Promise<void> {
  assert.equal(process.env.CANVASTTY_GEOMETRY_DISPOSABLE_DESKTOP, "1", "requires an explicitly disposable desktop");
  const url = new URL(origin);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
  const root = process.env.CANVASTTY_GEOMETRY_ARTIFACTS!;
  assert.ok(root);
  await mkdir(root, { recursive: true });
  const workspace = input as GeometryWorkspace;
  assert.equal(app.getPath("userData"), process.env.CANVASTTY_GEOMETRY_USER_DATA);
  // UI setup stays on the loopback fixture, including the initial new-card URL.
  // Do not make the geometry matrix depend on a public search engine loading.
  if (workspace.primaryInstance && workspace.executeHuman) {
    const execute = workspace.executeHuman.bind(workspace);
    workspace.executeHuman = (command, signal) => execute(String(command.type) === "browser_new_window" && !command.url
      ? { ...command, url: origin } : command, signal);
  } else {
    const open = workspace.open.bind(workspace);
    workspace.open = (value) => open(value ?? origin);
  }
  const evaluate = (source: string) => owner.webContents.executeJavaScript(source);
  const rows: Record<string, unknown>[] = [];
  const failures: string[] = [];
  const wait = async (source: string) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(source)) return;
      await pause(50);
    }
    throw new Error(`Renderer condition timed out: ${source}`);
  };
  const services = (): BrowserService[] => workspace.windows
    ? [...workspace.windows.values()].map((entry) => entry.service)
    : [input as BrowserService];
  const runtimes = () => services().map((service) => service as unknown as GeometryRuntime)
    .filter((runtime) => runtime.tabs.has(runtime.activeTabId));
  const check = async (name: string, action: () => Promise<unknown>) => {
    try { rows.push({ name, status: "pass", detail: await action() }); }
    catch (error) { const message = String(error); failures.push(`${name}: ${message}`); rows.push({ name, status: "fail", message }); }
    console.log(`BROWSER_GEOMETRY_CHECK ${JSON.stringify(rows.at(-1))}`);
  };
  const nativeInput = async (kind: string, values: number[] = []) => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    await run(process.execPath, [process.env.CANVASTTY_GEOMETRY_INPUT!, kind, ...values.map(String)], { env, timeout: 15000 });
  };
  const toScreen = (x: number, y: number) => {
    const bounds = owner.getContentBounds();
    const point = { x: Math.round(bounds.x + x), y: Math.round(bounds.y + y) };
    return process.platform === "win32" ? screen.dipToScreenPoint(point) : point;
  };
  const drag = async (from: { x: number; y: number }, dx: number, dy: number) => {
    const a = toScreen(from.x, from.y), b = toScreen(from.x + dx, from.y + dy);
    await nativeInput("drag", [a.x, a.y, b.x, b.y]);
    await pause(100);
  };
  const screenshot = async (name: string, expectNative = true) => {
    const path = join(root, `${name}.png`);
    await run(process.execPath, [process.env.CANVASTTY_GEOMETRY_INPUT!, "screenshot", path],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 15000 });
    const image = nativeImage.createFromBuffer(await readFile(path));
    assert.ok(!image.isEmpty(), "desktop screenshot is not empty");
    const bitmap = image.toBitmap();
    let cyan = 0, magenta = 0;
    for (let i = 0; i < bitmap.length; i += 4) {
      if (bitmap[i] > 220 && bitmap[i + 1] > 220 && bitmap[i + 2] < 30) cyan++;
      if (bitmap[i] > 220 && bitmap[i + 1] < 30 && bitmap[i + 2] > 220) magenta++;
    }
    if (expectNative) assert.ok(cyan > 50 && magenta > 50, `native page fiducials must be visible in desktop composition: cyan=${cyan}, magenta=${magenta}`);
    return { file: `${name}.png`, size: image.getSize(), cyan, magenta };
  };
  const geometry = async () => {
    const result = [];
    // Read committed renderer frames after OS input, not an intermediate IPC
    // resize whose native bounds arrived before the page's layout update.
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    for (const runtime of runtimes()) {
      if (runtime.viewport.surface !== "native" || runtime.canvasGestures.isFreezeActive
        || !runtime.clipView.getVisible() || !clipBrowserViewportBounds(runtime.viewport, owner.getContentBounds())) continue;
      const tab = runtime.tabs.get(runtime.activeTabId)!;
      const page = await Promise.race([
        tab.view.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight}))))"),
        pause(2000).then(() => { throw new Error("Visible native page did not commit a frame"); })
      ]);
      const bounds = tab.view.getBounds();
      const clip = clipBrowserViewportBounds(runtime.viewport, owner.getContentBounds());
      if (!clip) continue;
      assert.deepEqual(runtime.clipView.getBounds(), clip);
      assert.deepEqual(bounds, { x: runtime.viewport.x - clip.x, y: runtime.viewport.y - clip.y,
        width: runtime.viewport.width, height: runtime.viewport.height });
      const zoom = tab.view.webContents.getZoomFactor();
      assert.ok(Math.abs(page.width - bounds.width / zoom) <= 2, JSON.stringify({ page, bounds, zoom }));
      assert.ok(Math.abs(page.height - bounds.height / zoom) <= 2, JSON.stringify({ page, bounds, zoom }));
      assert.ok(page.scrollWidth > page.width && page.scrollHeight > page.height, "fixture has both scrollbars");
      result.push({ viewport: runtime.viewport, clip, bounds, zoom, page });
    }
    return result;
  };
  try {
    owner.maximize(); owner.show(); owner.focus();
    // Wayland deliberately does not expose global window positions. Fullscreen
    // gives the isolated compositor a known origin for OS pointer delivery.
    if (process.env.CANVASTTY_GEOMETRY_BACKEND === "wayland") owner.setFullScreen(true);
    await wait('!!document.querySelector(\'button[aria-label="Browser"]\')');
    const actualUiScale = await evaluate("window.canvasTTY.settings.get().then(settings => settings.uiScale)");
    assert.equal(actualUiScale, Number(process.env.CANVASTTY_GEOMETRY_UI_SCALE));
    console.log(`BROWSER_GEOMETRY_ENV ${JSON.stringify({ userData: app.getPath("userData"), actualUiScale })}`);
    const count = Number(process.env.CANVASTTY_GEOMETRY_CARDS ?? "1");
    for (let i = 0; i < count; i++) {
      console.log(`BROWSER_GEOMETRY_OPEN_CARD ${i + 1}`);
      await evaluate('document.querySelector(\'button[aria-label="Browser"]\').click()');
      await wait(`document.querySelectorAll(".browser-card").length === ${i + 1}`);
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const snapshot = workspace.getState();
        const tab = snapshot.tabs.find((candidate) => candidate.id === snapshot.activeTabId);
        if (tab?.status === "ready" && tab.url.startsWith(origin)) { ready = true; break; }
        await pause(50);
      }
      assert.ok(ready, `card ${i + 1} loaded the loopback fixture`);
      console.log(`BROWSER_GEOMETRY_CARD_READY ${i + 1}`);
    }
    await pause(800);
    assert.equal(owner.isVisible(), true);
    // A compositor may consume the first physical click for activation even
    // after owner.focus(). Activate on empty canvas before measuring handles.
    const activation = await evaluate(`(() => { const r=document.querySelector(".workspace").getBoundingClientRect(); for (const y of [r.top+20,r.top+60,r.bottom-20]) for (const x of [r.left+r.width/2,r.left+40,r.right-40]) if(document.elementFromPoint(x,y)?.classList.contains("workspace")) return {x,y}; return null; })()`);
    assert.ok(activation, "empty canvas activation point is available");
    await drag(activation, 0, 0);
    await pause(150);
    await evaluate(`window.geometryDown = []; document.addEventListener("pointerdown", e => window.geometryDown.push({trusted:e.isTrusted, target:e.target.className, x:e.clientX, y:e.clientY, screenX:e.screenX, screenY:e.screenY}), true)`);
    // Capture call-time native geometry: this detects the old capture-before-sync
    // ordering without pretending a bounds check alone proves the rendered frame.
    for (const runtime of runtimes()) {
      const contents = runtime.tabs.get(runtime.activeTabId)!.view.webContents;
      const original = contents.capturePage.bind(contents);
      contents.capturePage = ((...args: Parameters<typeof contents.capturePage>) => {
        const bounds = runtime.tabs.get(runtime.activeTabId)!.view.getBounds();
        const expected = runtime.viewport;
        if (runtime.canvasGestures.isFreezeActive || runtime.canvasGestures.activeNativeSink
          || bounds.width !== expected.width || bounds.height !== expected.height) {
          failures.push(`capture with unsynchronized native geometry: ${JSON.stringify({ bounds, expected })}`);
        }
        return original(...args);
      }) as typeof contents.capturePage;
    }
    // Actual canvas zoom controls. Report measured zoom, not nominal values.
    const zoomActions = [null, "Zoom out", "Zoom out", "Zoom out", "Zoom out", "Zoom in", "Zoom in", "Zoom in", "Zoom in", "Zoom in"];
    for (const [zoomStep, action] of zoomActions.entries()) {
      if (action) await evaluate(`document.querySelector('button[title="${action}"]').click()`);
      await pause(350);
      const zoom = await evaluate('new DOMMatrixReadOnly(document.querySelector(".workspace__scene").style.transform).a');
      const label = `zoom-${Number(zoom).toFixed(3)}`;
      const hasNativePage = () => runtimes().some((runtime) => runtime.viewport.surface === "native"
        && runtime.clipView.getVisible() && clipBrowserViewportBounds(runtime.viewport, owner.getContentBounds()));
      if (hasNativePage()) await check(`${label}/native-geometry`, geometry);
      else rows.push({ name: `${label}/native-geometry`, status: "untested", reason: "no native page: summary, occlusion, or trusted canvas overlay guard" });
      const cards = await evaluate('[...document.querySelectorAll(".browser-card")].map(el=>({id:el.dataset.browserId??"default",rect:el.getBoundingClientRect().toJSON()}))');
      // Full edge matrix at initial zoom, just above/below summary, and enlarged
      // zoom. Intermediate steps still check native geometry and composition.
      for (let index = 0; [0, 1, 2, 3, 4, 9].includes(zoomStep) && index < cards.length; index++) {
        const cardRuntime = (workspace.windows?.get(cards[index].id)?.service ?? (!workspace.windows ? input : undefined)) as GeometryRuntime | undefined;
        for (const direction of ["n", "ne", "e", "se", "s", "sw", "w", "nw"]) {
          const name = `${label}/card-${index}/${direction}`;
          if (zoom >= 0.5 && !cardRuntime?.clipView.getVisible()) {
            rows.push({ name, status: "untested", reason: "native page is hidden by the existing canvas visibility guard" }); continue;
          }
          const source = `document.querySelectorAll(".browser-card")[${index}]`;
          // Use the inner part of a corner: its center can round onto the
          // card's clipped border at small zoom, especially on macOS.
          const fx = direction.length === 2 ? (direction.includes("e") ? 0.25 : 0.75) : 0.5;
          const fy = direction.length === 2 ? (direction.includes("s") ? 0.25 : 0.75) : 0.5;
          const handle = await evaluate(`(() => { const el=${source};const node=el.querySelector(".terminal-card__resize-handle--${direction}");const r=node.getBoundingClientRect();const x=r.x+r.width*${fx},y=r.y+r.height*${fy};return {x,y,occluded:document.elementFromPoint(x,y)!==node,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}; })()`);
          const content = owner.getContentBounds();
          if (handle.occluded || handle.x < 15 || handle.y < 50 || handle.x > content.width - 20 || handle.y > content.height - 20) {
            rows.push({ name, status: "untested", reason: handle.occluded ? "handle covered by a canvas overlay or another card" : "handle outside visible desktop/workspace" }); continue;
          }
          await check(name, async () => {
            await evaluate("window.geometryDown=[]");
            const dx = direction.includes("e") ? 10 : direction.includes("w") ? -10 : 0;
            const dy = direction.includes("s") ? 10 : direction.includes("n") ? -10 : 0;
            await drag(handle, dx, dy);
            const delivered = await evaluate("window.geometryDown");
            const after = await evaluate(`${source}.getBoundingClientRect().toJSON()`);
            assert.ok(delivered.some((event: {trusted:boolean;target:string}) => event.trusted && event.target.includes(`resize-handle--${direction}`)), JSON.stringify({ delivered, handle }));
            assert.ok(Math.abs((dx ? after.width - handle.width : after.height - handle.height) - 10) < 3, JSON.stringify({ handle, after }));
            await geometry();
            const restore = await evaluate(`(() => {const r=${source}.querySelector(".terminal-card__resize-handle--${direction}").getBoundingClientRect();return {x:r.x+r.width*${fx},y:r.y+r.height*${fy}};})()`);
            await drag(restore, -dx, -dy);
            return { delivered, deltaWidth: after.width - handle.width, deltaHeight: after.height - handle.height };
          });
        }
      }
      if (zoom >= 0.5 && hasNativePage()) await check(`${label}/desktop-composition`, () => screenshot(label));
      else if (zoom >= 0.5) rows.push({ name: `${label}/desktop-composition`, status: "untested",
        reason: "native page intentionally hidden by the existing overlay/occlusion guard", detail: await screenshot(label, false) });
      else await check(`${label}/summary-hidden`, async () => {
        for (const runtime of runtimes()) assert.equal(runtime.clipView.getVisible(), false);
        return { nativeViewsHidden: true };
      });
    }
    const ensureNativeSurface = async (): Promise<BrowserService> => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const service = services().reverse().find((candidate) => {
          const runtime = candidate as unknown as GeometryRuntime;
          return runtime.viewport.surface === "native" && runtime.clipView.getVisible()
            && !runtime.canvasGestures.isFreezeActive && clipBrowserViewportBounds(runtime.viewport, owner.getContentBounds());
        });
        if (service) return service;
        // Canvas-owned coarse wheels can cross into summary mode. Restore a
        // native page before the next independent probe; enlarged cards under
        // trusted overlays instead need a smaller zoom on hosted desktops.
        const zoom = await evaluate('new DOMMatrixReadOnly(document.querySelector(".workspace__scene").style.transform).a');
        const action = zoom < 0.5 ? "Zoom in" : "Zoom out";
        await evaluate(`document.querySelector('button[title="${action}"]').click()`);
        await pause(350);
      }
      throw new Error("No visible native page after restoring zoom for the next probe");
    };
    // Exercise a real service freeze/restore while crossing a clipping boundary.
    // This is a controlled geometry test; physical wheel/gesture coverage is
    // reported separately in the matrix, not inferred from these calls.
    await check("freeze-resize-restore", async () => {
      const service = await ensureNativeSurface();
      const runtime = service as unknown as GeometryRuntime;
      const before = { ...runtime.viewport };
      const page = runtime.tabs.get(runtime.activeTabId)!.view.webContents;
      await page.executeJavaScript("scrollTo(200,300)");
      runtime.canvasGestures.refreshFrame(); await pause(300);
      const visible = clipBrowserViewportBounds(before, owner.getContentBounds())!;
      const freezePoint = { x: visible.x + visible.width / 2, y: visible.y + visible.height / 2 };
      runtime.canvasGestures.beginOwnerSequence(freezePoint, true);
      assert.ok(runtime.canvasGestures.isFreezeActive);
      const heartbeat = setInterval(() => runtime.canvasGestures.beginOwnerSequence(freezePoint, true), 80);
      let freezeScreenshot;
      try {
        await wait('!!document.querySelector(".browser-card__freeze-frame")?.complete');
        const frame = await evaluate('(() => {const el=document.querySelector(".browser-card__freeze-frame");return {width:el.naturalWidth,height:el.naturalHeight,radius:getComputedStyle(el.parentElement).borderRadius};})()');
        assert.ok(frame.width > 4, "freeze frame contains a full page, not the native wheel sink");
        assert.ok(Math.abs(frame.width / frame.height - before.width / before.height) * before.height <= 2,
          `stable freeze frame matches the native viewport aspect: ${JSON.stringify({ frame, viewport: before })}`);
        assert.equal(frame.radius, "17px", "DOM freeze clipping matches the native page corners");
        freezeScreenshot = await screenshot("freeze-frame");
        assert.ok(runtime.canvasGestures.isFreezeActive, "captured the active frozen composition");
      } finally { clearInterval(heartbeat); }
      service.setViewport({ ...before, x: -30, width: before.width + 80, canvasScale: 0.75 });
      await pause(300);
      runtime.canvasGestures.endSequence(); await pause(400);
      await geometry();
      const scroll = await page.executeJavaScript("({x:scrollX,y:scrollY})");
      assert.deepEqual(scroll, { x: 200, y: 300 });
      service.setViewport(before); await pause(200);
      const restoredClip = clipBrowserViewportBounds(before, owner.getContentBounds())!;
      runtime.canvasGestures.beginOwnerSequence({ x: restoredClip.x + restoredClip.width / 2, y: restoredClip.y + restoredClip.height / 2 }, true);
      service.setViewport({ ...before, surface: "hidden" });
      assert.equal(runtime.canvasGestures.activeNativeSink, null);
      assert.equal(runtime.clipView.getVisible(), false, "hiding during a gesture must remove the native sink");
      service.setViewport(before); await pause(200);
      return { scrollPreserved: scroll, freezeScreenshot, restored: runtime.tabs.get(runtime.activeTabId)!.view.getBounds() };
    });
    const scene = () => evaluate('document.querySelector(".workspace__scene").style.transform');
    for (const focused of [true, false]) {
      await check(`native-wheel/${focused ? "focused-page" : "unfocused-canvas"}`, async () => {
        const service = await ensureNativeSurface(), runtime = service as unknown as GeometryRuntime;
        runtime.canvasGestures.endSequence();
        const contents = runtime.tabs.get(runtime.activeTabId)!.view.webContents;
        await contents.executeJavaScript("scrollTo(200,300)");
        service.setInputFocused(focused);
        await pause(400);
        // Chromium quantizes scroll offsets at fractional zoom. Compare with
        // the observed offset, not the requested integer scrollTo arguments.
        const scrollBefore = await contents.executeJavaScript("({x:scrollX,y:scrollY})");
        const clip = clipBrowserViewportBounds(runtime.viewport, owner.getContentBounds())!;
        const point = toScreen(clip.x + clip.width / 2, clip.y + clip.height / 2);
        const before = await scene();
        await nativeInput("scroll", [point.x, point.y, 0, 0]);
        await pause(600);
        const page = await contents.executeJavaScript("({x:scrollX,y:scrollY})");
        const after = await scene();
        if (focused) {
          assert.ok(page.y > scrollBefore.y, JSON.stringify({ scrollBefore, page }));
          assert.equal(after, before, "focused page scrolling must not move the canvas");
        } else {
          const scale = contents.getZoomFactor();
          assert.ok(Math.abs(page.x - scrollBefore.x) * scale <= 1.01
            && Math.abs(page.y - scrollBefore.y) * scale <= 1.01,
          `canvas wheel ownership preserves scroll within one native DIP: ${JSON.stringify({ scrollBefore, page, scale })}`);
          assert.notEqual(after, before, "OS wheel over the unfocused page moves the canvas");
        }
        await geometry();
        return { scrollBefore, page, before, after };
      });
    }
    await check("repeated-sink-scroll-quantization", async () => {
      const runtime = await ensureNativeSurface() as unknown as GeometryRuntime;
      const contents = runtime.tabs.get(runtime.activeTabId)!.view.webContents;
      const before = await contents.executeJavaScript("({x:scrollX,y:scrollY})");
      for (let iteration = 0; iteration < 5; iteration++) {
        const clip = clipBrowserViewportBounds(runtime.viewport, owner.getContentBounds())!;
        runtime.canvasGestures.beginOwnerSequence({ x: clip.x + clip.width / 2, y: clip.y + clip.height / 2 }, true);
        await pause(40);
        runtime.canvasGestures.endSequence();
        await pause(80);
      }
      const after = await contents.executeJavaScript("({x:scrollX,y:scrollY})");
      const scale = contents.getZoomFactor();
      assert.ok(Math.abs(after.x - before.x) * scale <= 1.01 && Math.abs(after.y - before.y) * scale <= 1.01,
        `scroll quantization must not accumulate across restores: ${JSON.stringify({ before, after, scale })}`);
      return { before, after, scale, restores: 5 };
    });
    await check("native-alt-navigation-drag", async () => {
      const runtime = await ensureNativeSurface() as unknown as GeometryRuntime;
      const clip = clipBrowserViewportBounds(runtime.viewport, owner.getContentBounds())!;
      const start = toScreen(clip.x + clip.width / 2, clip.y + clip.height / 2);
      const end = toScreen(clip.x + clip.width / 2 + 30, clip.y + clip.height / 2 + 20);
      const before = await scene();
      await nativeInput("alt-drag", [start.x, start.y, end.x, end.y]);
      await pause(400);
      const after = await scene();
      assert.notEqual(after, before, "OS Alt+drag over the native page reaches canvas navigation");
      await geometry();
      return { before, after };
    });
    for (const direction of ["n", "ne", "e", "se", "s", "sw", "w", "nw"]) {
      if (!rows.some((row) => row.status === "pass" && String(row.name).endsWith(`/${direction}`))) {
        failures.push(`No successful OS input delivery for ${direction}`);
      }
    }
  } catch (error) {
    failures.push(String(error));
  } finally {
    const report = { platform: process.platform, electron: process.versions.electron,
      backend: process.env.CANVASTTY_GEOMETRY_BACKEND, commit: process.env.CANVASTTY_GEOMETRY_COMMIT,
      uiScale: process.env.CANVASTTY_GEOMETRY_UI_SCALE, cards: process.env.CANVASTTY_GEOMETRY_CARDS,
      visibleWindow: owner.isVisible(), displays: screen.getAllDisplays().map(({size,scaleFactor})=>({size,scaleFactor})),
      input: "OS synthetic mouse/wheel/Alt; renderer pointerdown.isTrusted asserted",
      untested: ["physical mouse hardware", "physical touchpad and momentum", "mixed-DPI multi-monitor transitions", "GNOME/KDE Wayland compositors"],
      rows, failures };
    await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  }
  if (failures.length) throw new Error(`Browser geometry regression: ${failures.length} failure(s); see report.json`);
  console.log("CANVASTTY_BROWSER_GEOMETRY_READY");
  app.quit();
}
