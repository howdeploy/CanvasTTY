import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserWindow, webContents } from "electron";
import type { BrowserActor, BrowserCommand, BrowserElementRef, BrowserResult } from "../../../shared/contracts.ts";
import type { BrowserService } from "../BrowserService.ts";
import { BROWSER_CANVAS_WHEEL_IDLE_MS } from "./BrowserCanvasFreeze.ts";

const READY_TIMEOUT_MS = 12_000;
const WHEEL_IDLE_SETTLE_MS = BROWSER_CANVAS_WHEEL_IDLE_MS * 2;
const SENTINEL = "canvastty-secret-must-not-leak";

export async function runBrowserElectronSmoke(
  service: BrowserService,
  origin: string,
  userDataPath: string
): Promise<void> {
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.protocol !== "http:" || parsedOrigin.hostname !== "127.0.0.1") {
    throw new Error("Browser smoke fixture must be an HTTP loopback origin.");
  }
  const uploadPath = join(userDataPath, "fixture-upload.txt");
  await writeFile(uploadPath, "CanvasTTY upload fixture", { mode: 0o600 });
  service.setViewport({ x: 0, y: 0, width: 820, height: 620, surface: "native", canvasScale: 1 });

  const actor: Extract<BrowserActor, { kind: "agent" }> = {
    kind: "agent",
    agentId: "electron-smoke-agent",
    provider: "codex",
    terminalSessionId: "electron-smoke-terminal",
    connectionId: "electron-smoke-connection",
    cwd: userDataPath
  };
  service.core.agentConnected(actor);
  let request = 0;
  const execute = async <T = unknown>(
    type: BrowserCommand["type"],
    args: Omit<BrowserCommand, "type" | "requestId"> = {}
  ): Promise<BrowserResult<T>> => {
    console.log(`CANVASTTY_BROWSER_SMOKE_STEP ${request + 1} ${type}`);
    const result = await service.core.execute(actor, {
      type,
      requestId: `electron-smoke-${++request}`,
      timeoutMs: 5_000,
      ...args
    });
    if (!result.ok) throw new Error(`${type} failed: ${JSON.stringify(result.error)}`);
    return result as BrowserResult<T>;
  };

  try {
    const opened = await execute("browser_new_tab", { url: `${origin}/` });
    const tabId = opened.tabId;
    if (!tabId) throw new Error("Browser smoke did not create a tab.");
    await execute("browser_list_tabs");
    await waitUntil(async () => service.getState().tabs.find((tab) => tab.id === tabId)?.status === "ready");
    await assertFocusAwarePhysicalWheel(service, `${origin}/`);
    await assertBrowserOriginPanCrossesBoundary(service, `${origin}/`);
    await assertOwnerWheelFreezesCrossingBrowser(service);
    await assertRendererPanCrossesBrowser(service, `${origin}/`);

    service.setViewport({ x: 0, y: 0, width: 410, height: 310, surface: "native", canvasScale: 0.5 });
    await execute("browser_wait_for", {
      tabId,
      condition: "text",
      value: "Viewport width: 820",
      timeoutMs: 4_000
    });
    service.setViewport({ x: 0, y: 0, width: 820, height: 620, surface: "native", canvasScale: 1 });
    await execute("browser_wait_for", {
      tabId,
      condition: "text",
      value: "Viewport width: 820",
      timeoutMs: 4_000
    });

    const observed = await execute<{
      elements: Array<{ name: string; value?: string | null; ref: BrowserElementRef }>;
    }>("browser_observe", { tabId, limit: 200 });
    const elements = observed.data?.elements ?? [];
    const password = elements.find((element) => element.name === "Password");
    if (!password || password.value?.includes(SENTINEL)) {
      throw new Error("Password value leaked through browser_observe.");
    }
    const byName = (name: string): BrowserElementRef => {
      const element = elements.find((candidate) => candidate.name === name);
      if (!element) throw new Error(`Missing observed element: ${name}`);
      return element.ref;
    };
    const messageRef = byName("Message");
    const submitRef = byName("Submit");
    const selectRef = byName("Mode");
    const uploadRef = byName("Upload file");
    const dragSourceRef = byName("Drag source");
    const dragTargetRef = byName("Drag target");

    await execute("browser_hover", { tabId, ref: submitRef });
    await execute("browser_type", { tabId, ref: messageRef, text: "hello from agent" });
    await execute("browser_select", { tabId, ref: selectRef, values: ["safe"] });
    await execute("browser_upload", { tabId, ref: uploadRef, paths: [uploadPath] });
    await execute("browser_drag", {
      tabId,
      ref: dragSourceRef,
      targetRef: dragTargetRef,
      timeoutMs: 12_000
    });
    await execute("browser_wait_for", {
      tabId,
      condition: "text",
      value: "Drag completed",
      timeoutMs: 4_000
    });
    await execute("browser_click", { tabId, ref: submitRef });
    await execute("browser_wait_for", {
      tabId,
      condition: "text",
      value: "Submitted: hello from agent / safe",
      timeoutMs: 4_000
    });

    const page = await execute<{ text: string }>("browser_read_page", { tabId, limit: 500 });
    if (!page.data?.text.includes("Submitted: hello from agent / safe")) {
      throw new Error("Browser read_page missed the submitted fixture state.");
    }
    if (!page.data.text.includes("fixture-upload.txt")) {
      throw new Error("Browser upload did not reach the page file input.");
    }
    if (page.data.text.includes(SENTINEL)) throw new Error("Password value leaked through read_page.");
    const shot = await execute<{ mimeType: string; base64: string }>("browser_screenshot", { tabId });
    const screenshotBytes = Buffer.from(shot.data?.base64 ?? "", "base64").byteLength;
    if (!/^image\/(?:png|jpeg)$/.test(shot.data?.mimeType ?? "")
      || screenshotBytes < 1_000 || screenshotBytes > 340 * 1024) {
      throw new Error("Browser screenshot result is invalid.");
    }

    const dialogObservation = await execute<{
      elements: Array<{ name: string; ref: BrowserElementRef }>;
    }>("browser_observe", { tabId, limit: 200 });
    const alertRef = dialogObservation.data?.elements.find((element) => element.name === "Open dialog")?.ref;
    if (!alertRef) throw new Error("Dialog fixture was not observed.");
    await execute("browser_click", { tabId, ref: alertRef });
    await waitUntil(async () => service.getState().pendingDialog?.tabId === tabId);
    const pendingDialog = service.getState().pendingDialog;
    if (pendingDialog?.type !== "alert" || pendingDialog.message !== "CanvasTTY dialog fixture") {
      throw new Error(`Browser dialog metadata is invalid: ${JSON.stringify(pendingDialog)}`);
    }
    await execute("browser_handle_dialog", { tabId, accept: true });
    await execute("browser_wait_for", {
      tabId,
      condition: "text",
      value: "Dialog handled",
      timeoutMs: 4_000
    });

    const popupObservation = await execute<{
      elements: Array<{ name: string; ref: BrowserElementRef }>;
    }>("browser_observe", { tabId, limit: 200 });
    const popupRef = popupObservation.data?.elements.find((element) => element.name === "Open popup")?.ref;
    if (!popupRef) throw new Error("Popup fixture was not observed.");
    await execute("browser_click", { tabId, ref: popupRef });
    await waitUntil(async () => service.getState().tabs.length === 2);
    const popupTab = service.getState().tabs.find((tab) => tab.id !== tabId);
    if (!popupTab) throw new Error("Browser popup tab was not adopted by the browser core.");
    await waitUntil(async () => service.getState().tabs.find((tab) => tab.id === popupTab.id)?.status === "ready");
    const popupPage = await execute<{ text: string }>("browser_read_page", { tabId: popupTab.id, limit: 100 });
    if (!popupPage.data?.text.includes("Popup ready")) throw new Error("Browser popup content was not readable.");

    await execute("browser_activate_tab", { tabId });
    const downloadObservation = await execute<{
      elements: Array<{ name: string; ref: BrowserElementRef }>;
    }>("browser_observe", { tabId, limit: 200 });
    const downloadRef = downloadObservation.data?.elements.find(
      (element) => element.name === "Download fixture"
    )?.ref;
    if (!downloadRef) throw new Error("Download fixture was not observed.");
    await execute("browser_click", { tabId, ref: downloadRef });
    const download = await execute<{ status: string; fileName: string; savePath: string }>(
      "browser_download_wait",
      { tabId, timeoutMs: 5_000 }
    );
    if (download.data?.status !== "completed") throw new Error("Browser download did not complete.");
    if (download.data.fileName !== "fixture.txt"
      || await readFile(download.data.savePath, "utf8") !== "CanvasTTY download fixture") {
      throw new Error("Browser download contents are invalid.");
    }

    // Exercise wheel input after all ref-based controls have been used. Cached
    // refs deliberately keep their document identity, not a scroll-position lock.
    await execute("browser_scroll", { tabId, direction: "down" });
    await execute("browser_wait_for", {
      tabId,
      condition: "text",
      value: "Scroll completed",
      timeoutMs: 4_000
    });
    await execute("browser_scroll", { tabId, direction: "up" });

    await execute("browser_navigate", {
      tabId,
      url: `${origin}/next?q=visible&access_token=${SENTINEL}#fragment`
    });
    await waitUntil(async () => Boolean(
      service.getState().tabs.find((tab) => tab.id === tabId)?.url.includes("/next")
    ));
    const tabs = await execute<{ tabs: Array<{ id: string; url: string }> }>("browser_list_tabs");
    const safeUrl = tabs.data?.tabs.find((tab) => tab.id === tabId)?.url ?? "";
    if (safeUrl !== `${origin}/next`) {
      throw new Error(`Agent tab URL was not sanitized: ${safeUrl}`);
    }

    const stale = await service.core.execute(actor, {
      type: "browser_click",
      requestId: randomUUID(),
      tabId,
      ref: submitRef
    });
    if (stale.ok || stale.error?.code !== "STALE_REF") {
      throw new Error(`Old element reference was not rejected: ${JSON.stringify(stale)}`);
    }
  } finally {
    service.core.agentDisconnected(actor);
  }
}

async function assertFocusAwarePhysicalWheel(service: BrowserService, url: string): Promise<void> {
  const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
  const owner = BrowserWindow.getAllWindows().find((candidate) => candidate.getParentWindow() === null);
  if (!contents || !owner) throw new Error("Browser smoke could not resolve the wheel ownership WebContents.");
  await owner.webContents.executeJavaScript(`
    globalThis.__canvasttyWheelRelays = [];
    globalThis.__canvasttyWheelRelayOff = window.canvasTTY.browser.onCanvasWheel((event) => {
      globalThis.__canvasttyWheelRelays.push(event);
    });
    void 0;
  `);
  try {
    service.setCanvasWheelCaptureMode("off");
    service.setInputFocused(true);
    service.setViewport({ x: 0, y: 0, width: 820, height: 620, surface: "native", canvasScale: 1 });
    await waitForWheelIdle();
    const pageScrollY = await sendWheelUntilPageScrolls(contents, { x: 700, y: 300 });
    if (pageScrollY === 400) throw new Error("Focused Browser plain wheel did not scroll the page.");
    if (await wheelRelayCount(owner) !== 0) {
      throw new Error("Focused Browser plain wheel unexpectedly created a canvas relay.");
    }

    await waitForWheelIdle();
    service.setInputFocused(false);
    await contents.executeJavaScript("window.scrollTo(0, 400)");
    contents.sendInputEvent({ type: "mouseWheel", x: 700, y: 300, deltaX: 0, deltaY: -120 });
    await waitUntil(async () => await wheelRelayCount(owner) === 1);
    const unfocusedScrollY = await contents.executeJavaScript("window.scrollY");
    if (unfocusedScrollY !== 400) {
      throw new Error(`Unfocused Browser wheel leaked to page scrolling: scrollY=${String(unfocusedScrollY)}.`);
    }

    await waitForWheelIdle();
    service.setInputFocused(true);
    service.setViewport({ x: 0, y: 0, width: 820, height: 620, surface: "native", canvasScale: 1 });
    await contents.executeJavaScript("window.scrollTo(0, 400)");
    contents.sendInputEvent({
      type: "mouseWheel",
      x: 700,
      y: 300,
      deltaX: 0,
      deltaY: -120,
      modifiers: [process.platform === "darwin" ? "meta" : "control"]
    });
    await waitUntil(async () => await wheelRelayCount(owner) === 2);
    const modifiedScrollY = await contents.executeJavaScript("window.scrollY");
    if (modifiedScrollY !== 400) {
      throw new Error(`Modified Browser wheel leaked to page scrolling: scrollY=${String(modifiedScrollY)}.`);
    }
    const modifiedRelay = await owner.webContents.executeJavaScript(
      "globalThis.__canvasttyWheelRelays?.at(-1) ?? null"
    ) as { ctrlKey?: boolean; metaKey?: boolean } | null;
    if (!modifiedRelay || (!modifiedRelay.ctrlKey && !modifiedRelay.metaKey)) {
      throw new Error(`Modified Browser wheel lost its zoom modifier: ${JSON.stringify(modifiedRelay)}.`);
    }
  } finally {
    service.setInputFocused(false);
    service.setCanvasWheelCaptureMode("key");
    await waitForWheelIdle();
    service.setViewport({ x: 0, y: 0, width: 820, height: 620, surface: "native", canvasScale: 1 });
    await contents.executeJavaScript("window.scrollTo(0, 0)").catch(() => undefined);
    await owner.webContents.executeJavaScript(`
      globalThis.__canvasttyWheelRelayOff?.();
      delete globalThis.__canvasttyWheelRelayOff;
      delete globalThis.__canvasttyWheelRelays;
    `).catch(() => undefined);
  }
}

async function assertBrowserOriginPanCrossesBoundary(service: BrowserService, url: string): Promise<void> {
  const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
  const owner = BrowserWindow.getAllWindows().find((candidate) => candidate.getParentWindow() === null);
  if (!contents || !owner) throw new Error("Browser smoke could not resolve the Browser-origin pan WebContents.");
  await owner.webContents.executeJavaScript(`
    globalThis.__canvasttyBrowserOriginFreezeEvents = [];
    globalThis.__canvasttyBrowserOriginWheelRelays = [];
    globalThis.__canvasttyBrowserOriginFreezeOff = window.canvasTTY.browser.onCanvasFreezeFrame((event) => {
      globalThis.__canvasttyBrowserOriginFreezeEvents.push({
        active: event.active,
        generation: event.generation,
        dataUrlLength: event.dataUrl?.length ?? 0
      });
    });
    globalThis.__canvasttyBrowserOriginWheelOff = window.canvasTTY.browser.onCanvasWheel((event) => {
      globalThis.__canvasttyBrowserOriginWheelRelays.push(event);
    });
    void 0;
  `);
  try {
    service.setCanvasWheelCaptureMode("off");
    service.setInputFocused(false);
    service.setViewport({ x: 200, y: 120, width: 300, height: 240, surface: "native", canvasScale: 1 });
    await waitUntil(async () => owner.webContents.executeJavaScript(
      "globalThis.__canvasttyBrowserOriginFreezeEvents?.some((event) => event.dataUrlLength > 0) === true"
    ));
    await waitForWheelIdle();
    await contents.executeJavaScript(`
      window.scrollTo(0, 400);
      globalThis.__canvasttySinkResizeCount = 0;
      globalThis.__canvasttySinkResizeListener = () => { globalThis.__canvasttySinkResizeCount += 1; };
      window.addEventListener('resize', globalThis.__canvasttySinkResizeListener);
      void 0;
    `);
    const initialPageMetrics = await browserPageMetrics(contents);
    contents.sendInputEvent({ type: "mouseWheel", x: 100, y: 40, deltaX: 12, deltaY: 18 });
    await waitUntil(async () => owner.webContents.executeJavaScript(
      "globalThis.__canvasttyBrowserOriginFreezeEvents?.some((event) => event.active) === true"
    ));
    assertStableSinkPageMetrics(initialPageMetrics, await browserPageMetrics(contents), "native sink activation");
    service.setViewport({ x: 520, y: 320, width: 300, height: 240, surface: "native", canvasScale: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    contents.sendInputEvent({ type: "mouseWheel", x: 2, y: 2, deltaX: 10, deltaY: 14 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    contents.sendInputEvent({ type: "mouseWheel", x: 2, y: 2, deltaX: 8, deltaY: 12 });
    await waitUntil(async () => await wheelRelayCount(owner, "__canvasttyBrowserOriginWheelRelays") === 3);
    assertStableSinkPageMetrics(
      initialPageMetrics,
      await browserPageMetrics(contents),
      "continued native sink wheel sequence"
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    const endedTooEarly = await owner.webContents.executeJavaScript(`
      (() => {
        const events = globalThis.__canvasttyBrowserOriginFreezeEvents ?? [];
        const active = events.findIndex((event) => event.active);
        return active >= 0 && events.slice(active + 1).some((event) => !event.active);
      })()
    `);
    if (endedTooEarly) throw new Error("Browser-origin canvas sequence ended at the old native boundary.");
    await waitUntil(async () => owner.webContents.executeJavaScript(`
      (() => {
        const events = globalThis.__canvasttyBrowserOriginFreezeEvents ?? [];
        const active = events.findIndex((event) => event.active);
        return active >= 0 && events.slice(active + 1).some((event) => !event.active);
      })()
    `));
    assertStableSinkPageMetrics(
      initialPageMetrics,
      await browserPageMetrics(contents),
      "native sink restoration"
    );

    service.setViewport({ x: 200, y: 120, width: 150, height: 120, surface: "native", canvasScale: 0.5 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await contents.executeJavaScript(`
      window.scrollTo(0, 400);
      globalThis.__canvasttySinkResizeCount = 0;
    `);
    const scaledPageMetrics = await browserPageMetrics(contents);
    contents.sendInputEvent({ type: "mouseWheel", x: 50, y: 40, deltaX: 6, deltaY: 9 });
    await waitUntil(async () => await wheelRelayCount(owner, "__canvasttyBrowserOriginWheelRelays") === 4);
    assertStableSinkPageMetrics(
      scaledPageMetrics,
      await browserPageMetrics(contents),
      "scaled native sink activation"
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    contents.sendInputEvent({ type: "mouseWheel", x: 2, y: 2, deltaX: 5, deltaY: 7 });
    await waitUntil(async () => await wheelRelayCount(owner, "__canvasttyBrowserOriginWheelRelays") === 5);
    await waitForWheelIdle();
    assertStableSinkPageMetrics(
      scaledPageMetrics,
      await browserPageMetrics(contents),
      "scaled native sink restoration"
    );
  } finally {
    service.setCanvasWheelCaptureMode("key");
    await waitForWheelIdle();
    service.setViewport({ x: 0, y: 0, width: 820, height: 620, surface: "native", canvasScale: 1 });
    await contents.executeJavaScript(`
      if (globalThis.__canvasttySinkResizeListener) {
        window.removeEventListener('resize', globalThis.__canvasttySinkResizeListener);
      }
      delete globalThis.__canvasttySinkResizeListener;
      delete globalThis.__canvasttySinkResizeCount;
      window.scrollTo(0, 0);
    `).catch(() => undefined);
    await owner.webContents.executeJavaScript(`
      globalThis.__canvasttyBrowserOriginFreezeOff?.();
      globalThis.__canvasttyBrowserOriginWheelOff?.();
      delete globalThis.__canvasttyBrowserOriginFreezeOff;
      delete globalThis.__canvasttyBrowserOriginWheelOff;
      delete globalThis.__canvasttyBrowserOriginFreezeEvents;
      delete globalThis.__canvasttyBrowserOriginWheelRelays;
    `).catch(() => undefined);
  }
}

interface BrowserPageMetrics {
  width: number;
  height: number;
  scrollY: number;
  resizeCount: number;
}

async function browserPageMetrics(contents: Electron.WebContents): Promise<BrowserPageMetrics> {
  return await contents.executeJavaScript(`({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollY: window.scrollY,
    resizeCount: globalThis.__canvasttySinkResizeCount ?? 0
  })`) as BrowserPageMetrics;
}

function assertStableSinkPageMetrics(
  expected: BrowserPageMetrics,
  actual: BrowserPageMetrics,
  phase: string
): void {
  if (
    actual.width !== expected.width
    || actual.height !== expected.height
    || actual.scrollY !== expected.scrollY
    || actual.resizeCount !== expected.resizeCount
  ) {
    throw new Error(
      `Browser page metrics changed during ${phase}: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}.`
    );
  }
}

async function assertRendererPanCrossesBrowser(service: BrowserService, url: string): Promise<void> {
  const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
  const owner = BrowserWindow.getAllWindows().find((candidate) => candidate.getParentWindow() === null);
  if (!contents || !owner) throw new Error("Browser smoke could not resolve the pan boundary WebContents.");
  await owner.webContents.executeJavaScript(`
    globalThis.__canvasttyPanBoundaryEvents = [];
    globalThis.__canvasttyPanBoundaryOff = window.canvasTTY.browser.onCanvasNavigationPointer((event) => {
      globalThis.__canvasttyPanBoundaryEvents.push(event.type);
    });
    void 0;
  `);
  try {
    service.setRendererCanvasGestureActive(true);
    contents.sendInputEvent({ type: "mouseMove", x: 400, y: 300 });
    contents.sendInputEvent({ type: "mouseUp", button: "left", x: 400, y: 300, clickCount: 1 });
    await waitUntil(async () => owner.webContents.executeJavaScript(
      "globalThis.__canvasttyPanBoundaryEvents?.includes('up') === true"
    ));
    const events = await owner.webContents.executeJavaScript(
      "globalThis.__canvasttyPanBoundaryEvents ?? []"
    ) as unknown;
    if (!Array.isArray(events) || !events.includes("move") || events.at(-1) !== "up") {
      throw new Error(`Renderer pan did not cross the native Browser boundary: ${JSON.stringify(events)}.`);
    }
  } finally {
    service.setRendererCanvasGestureActive(false);
    await owner.webContents.executeJavaScript(`
      globalThis.__canvasttyPanBoundaryOff?.();
      delete globalThis.__canvasttyPanBoundaryOff;
      delete globalThis.__canvasttyPanBoundaryEvents;
    `).catch(() => undefined);
  }
}

async function assertOwnerWheelFreezesCrossingBrowser(service: BrowserService): Promise<void> {
  const owner = BrowserWindow.getAllWindows().find((candidate) => candidate.getParentWindow() === null);
  if (!owner) throw new Error("Browser smoke could not resolve the owner window for freeze validation.");
  await owner.webContents.executeJavaScript(`
    globalThis.__canvasttyFreezeEvents = [];
    globalThis.__canvasttyFreezeOff = window.canvasTTY.browser.onCanvasFreezeFrame((event) => {
      globalThis.__canvasttyFreezeEvents.push({
        active: event.active,
        generation: event.generation,
        dataUrlLength: event.dataUrl?.length ?? 0
      });
    });
    void 0;
  `);
  try {
    const initialViewport = {
      x: 500,
      y: 200,
      width: 200,
      height: 200,
      surface: "native" as const,
      canvasScale: 1
    };
    service.setViewport(initialViewport);
    await waitUntil(async () => owner.webContents.executeJavaScript(
      "globalThis.__canvasttyFreezeEvents?.some((event) => event.dataUrlLength > 0) === true"
    ));

    owner.webContents.sendInputEvent({
      type: "mouseWheel",
      x: 400,
      y: 300,
      deltaX: 8,
      deltaY: 12
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    service.setViewport({ ...initialViewport, x: 403 });
    await waitUntil(async () => owner.webContents.executeJavaScript(
      "globalThis.__canvasttyFreezeEvents?.some((event) => event.active && event.dataUrlLength > 0) === true"
    ));
    service.setViewport({ ...initialViewport, x: 403, surface: "placeholder" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    service.setViewport({ ...initialViewport, x: 403, surface: "native" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const endedDuringPlaceholder = await owner.webContents.executeJavaScript(`
      (() => {
        const events = globalThis.__canvasttyFreezeEvents ?? [];
        const activeIndex = events.findIndex((event) => event.active && event.dataUrlLength > 0);
        return activeIndex >= 0 && events.slice(activeIndex + 1).some((event) => !event.active);
      })()
    `);
    if (endedDuringPlaceholder) {
      throw new Error("Native/placeholder transition ended the active canvas wheel sequence.");
    }
    await waitUntil(async () => owner.webContents.executeJavaScript(`
      (() => {
        const events = globalThis.__canvasttyFreezeEvents ?? [];
        const activeIndex = events.findIndex((event) => event.active && event.dataUrlLength > 0);
        return activeIndex >= 0 && events.slice(activeIndex + 1).some((event) => !event.active);
      })()
    `));
  } finally {
    service.setViewport({ x: 0, y: 0, width: 820, height: 620, surface: "native", canvasScale: 1 });
    await owner.webContents.executeJavaScript(`
      globalThis.__canvasttyFreezeOff?.();
      delete globalThis.__canvasttyFreezeOff;
      delete globalThis.__canvasttyFreezeEvents;
    `).catch(() => undefined);
  }
}

async function sendWheelUntilPageScrolls(
  contents: Electron.WebContents,
  point: { x: number; y: number }
): Promise<number> {
  for (const deltaY of [-120, 120]) {
    await contents.executeJavaScript("window.scrollTo(0, 400)");
    contents.sendInputEvent({ type: "mouseWheel", ...point, deltaX: 0, deltaY });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const scrollY = await contents.executeJavaScript("window.scrollY") as number;
      if (scrollY !== 400) return scrollY;
    }
  }
  return 400;
}

async function wheelRelayCount(
  owner: BrowserWindow,
  key: "__canvasttyWheelRelays" | "__canvasttyBrowserOriginWheelRelays" = "__canvasttyWheelRelays"
): Promise<number> {
  return owner.webContents.executeJavaScript(`globalThis.${key}?.length ?? 0`) as Promise<number>;
}

async function waitForWheelIdle(): Promise<void> {
  // The page preload and main process expire ownership independently. Allow
  // both event loops a complete idle interval before starting a new sequence.
  await new Promise((resolve) => setTimeout(resolve, WHEEL_IDLE_SETTLE_MS));
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(`Browser fixture did not reach the expected state in ${READY_TIMEOUT_MS} ms.`);
}
