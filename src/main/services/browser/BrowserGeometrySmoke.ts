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
    workspace.executeHuman = (command, signal) => execute(command.type === "browser_new_window" && !command.url
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
  const screenshot = async (name: string) => {
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
    assert.ok(cyan > 50 && magenta > 50, `native page fiducials must be visible in desktop composition: cyan=${cyan}, magenta=${magenta}`);
    return { file: `${name}.png`, size: image.getSize(), cyan, magenta };
  };
  const geometry = async () => {
    const result = [];
    for (const runtime of runtimes()) {
      if (runtime.viewport.surface !== "native" || runtime.canvasGestures.isFreezeActive) continue;
      const tab = runtime.tabs.get(runtime.activeTabId)!;
      const bounds = tab.view.getBounds();
      const clip = clipBrowserViewportBounds(runtime.viewport, owner.getContentBounds());
      if (!clip) continue;
      assert.deepEqual(runtime.clipView.getBounds(), clip);
      assert.deepEqual(bounds, { x: runtime.viewport.x - clip.x, y: runtime.viewport.y - clip.y,
        width: runtime.viewport.width, height: runtime.viewport.height });
      const page = await tab.view.webContents.executeJavaScript("({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight})");
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
      const snapshot = workspace.getState();
      await workspace.navigate(snapshot.activeTabId!, `${origin}/?card=${i}`);
    }
    await pause(800);
    assert.equal(owner.isVisible(), true);
    await evaluate(`window.geometryDown = []; document.addEventListener("pointerdown", e => window.geometryDown.push({trusted:e.isTrusted, target:e.target.className}), true)`);
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
      await check(`${label}/native-geometry`, geometry);
      const cards = await evaluate('[...document.querySelectorAll(".browser-card")].map(el=>({id:el.dataset.browserId??"default",rect:el.getBoundingClientRect().toJSON()}))');
      // Full edge matrix at initial zoom, just above/below summary, and enlarged
      // zoom. Intermediate steps still check native geometry and composition.
      for (let index = 0; [0, 3, 4, 9].includes(zoomStep) && index < cards.length; index++) {
        for (const direction of ["n", "ne", "e", "se", "s", "sw", "w", "nw"]) {
          const name = `${label}/card-${index}/${direction}`;
          const source = `document.querySelectorAll(".browser-card")[${index}]`;
          const handle = await evaluate(`(() => { const el=${source};const node=el.querySelector(".terminal-card__resize-handle--${direction}");const r=node.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,occluded:document.elementFromPoint(x,y)!==node,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}; })()`);
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
            const restore = await evaluate(`(() => {const r=${source}.querySelector(".terminal-card__resize-handle--${direction}").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
            await drag(restore, -dx, -dy);
            return { delivered, deltaWidth: after.width - handle.width, deltaHeight: after.height - handle.height };
          });
        }
      }
      if (zoom >= 0.5) await check(`${label}/desktop-composition`, () => screenshot(label));
      else await check(`${label}/summary-hidden`, async () => {
        for (const runtime of runtimes()) assert.equal(runtime.clipView.getVisible(), false);
        return { nativeViewsHidden: true };
      });
    }
    // Exercise a real service freeze/restore while crossing a clipping boundary.
    // This is a controlled geometry test; physical wheel/gesture coverage is
    // reported separately in the matrix, not inferred from these calls.
    await check("freeze-resize-restore", async () => {
      const service = services().reverse().find((candidate) => {
        const viewport = (candidate as unknown as GeometryRuntime).viewport;
        return viewport.surface === "native" && clipBrowserViewportBounds(viewport, owner.getContentBounds());
      })!;
      const runtime = service as unknown as GeometryRuntime;
      const before = { ...runtime.viewport };
      const page = runtime.tabs.get(runtime.activeTabId)!.view.webContents;
      await page.executeJavaScript("scrollTo(200,300)");
      runtime.canvasGestures.refreshFrame(); await pause(300);
      const visible = clipBrowserViewportBounds(before, owner.getContentBounds())!;
      runtime.canvasGestures.beginOwnerSequence({ x: visible.x + visible.width / 2, y: visible.y + visible.height / 2 }, true);
      assert.ok(runtime.canvasGestures.isFreezeActive);
      service.setViewport({ ...before, x: -30, width: before.width + 80, canvasScale: 0.75 });
      await pause(300);
      runtime.canvasGestures.endSequence(); await pause(400);
      await geometry();
      const scroll = await page.executeJavaScript("({x:scrollX,y:scrollY})");
      assert.deepEqual(scroll, { x: 200, y: 300 });
      service.setViewport(before); await pause(200);
      return { scrollPreserved: scroll, restored: runtime.tabs.get(runtime.activeTabId)!.view.getBounds() };
    });
    const selectedService = () => services().reverse().find((candidate) => {
      const viewport = (candidate as unknown as GeometryRuntime).viewport;
      return viewport.surface === "native" && clipBrowserViewportBounds(viewport, owner.getContentBounds());
    })!;
    const scene = () => evaluate('document.querySelector(".workspace__scene").style.transform');
    for (const focused of [true, false]) {
      await check(`native-wheel/${focused ? "focused-page" : "unfocused-canvas"}`, async () => {
        const service = selectedService(), runtime = service as unknown as GeometryRuntime;
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
          assert.deepEqual(page, scrollBefore, "canvas wheel ownership preserves page scroll");
          assert.notEqual(after, before, "OS wheel over the unfocused page moves the canvas");
        }
        await geometry();
        return { scrollBefore, page, before, after };
      });
    }
    await check("native-alt-navigation-drag", async () => {
      const runtime = selectedService() as unknown as GeometryRuntime;
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
