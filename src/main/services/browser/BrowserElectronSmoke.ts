import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, View, webContents } from "electron";
import type { NativeImage } from "electron";
import type { BrowserActor, BrowserCommand, BrowserElementRef, BrowserResult } from "../../../shared/contracts.ts";
import type { BrowserService } from "../BrowserService.ts";
import { BROWSER_CANVAS_WHEEL_IDLE_MS } from "./BrowserCanvasFreeze.ts";
import {
  waitForBrowserSmokeWheelReady,
  runBrowserSmokeCleanup,
  requireBrowserSmokeScrollBaseline,
  type BrowserSmokePageState,
  type BrowserSmokeWheelReadiness
} from "./BrowserSmokeReadiness.ts";

const READY_TIMEOUT_MS = 12_000;
const CLEANUP_TIMEOUT_MS = 1_000;
const WHEEL_IDLE_SETTLE_MS = BROWSER_CANVAS_WHEEL_IDLE_MS * 2;
const SENTINEL = "canvastty-secret-must-not-leak";
const LAYERING_OVERLAY_ID = "canvastty-native-layering-smoke-overlay";
// The layering fixture's geometry depends on the window, and the window's size otherwise comes from the
// display. This content size fits the smallest CI screen (GitHub's macOS runners: 1024 x 768) on every
// platform; see ensureLayeringWindowSize and zoomOutUntilBrowserClearsCanvasHud.
const LAYERING_WINDOW_CONTENT_SIZE = { width: 1020, height: 640 };
const ZOOM_OUT_LABELS = ["Zoom out", "Отдалить"];

export async function runBrowserElectronSmoke(
  service: BrowserService,
  origin: string,
  userDataPath: string
): Promise<void> {
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.protocol !== "http:" || parsedOrigin.hostname !== "127.0.0.1") {
    throw new Error("Browser smoke fixture must be an HTTP loopback origin.");
  }
  if (process.env.CANVASTTY_BROWSER_SMOKE_LAYERING_ONLY === "1") {
    // The complete smoke additionally requires active physical desktop input.
    // Keep that prerequisite and its checks intact in the default mode.
    await assertNativeBrowserCanvasOverlayLayering(service, origin);
    return;
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

    await assertNativeBrowserCanvasOverlayLayering(service, origin);
  } finally {
    service.core.agentDisconnected(actor);
  }
}

/**
 * Exercise the real React BrowserCard, its native WebContentsView and the
 * renderer's persistent shortcut overlay together. The main renderer capture
 * below only proves that the DOM overlay was painted into that renderer; the
 * native view hierarchy and bounds assertions prove the separate native child
 * is hidden whenever it would cover that DOM rectangle.
 */
async function assertNativeBrowserCanvasOverlayLayering(service: BrowserService, origin: string): Promise<void> {
  const owner = BrowserWindow.getAllWindows().find((candidate) => candidate.getParentWindow() === null);
  if (!owner) throw new Error("Browser layering smoke could not resolve the application window.");
  // This correctness fixture must paint even if the desktop occludes its test
  // window. The production window policy is untouched outside this smoke.
  owner.webContents.setBackgroundThrottling(false);
  const fixtureUrl = `${origin}/`;
  await ensureLayeringWindowSize(owner);

  // Seed the service with the loopback page before asking the app's launcher to
  // mount BrowserCard. App.openBrowser() then reuses this tab, so no default
  // external start page or provider account is touched by the UI path.
  await service.open(fixtureUrl);
  await waitUntil(async () => service.getState().tabs.some((tab) => tab.url === fixtureUrl && tab.status === "ready"));
  await setShortcutHintsThroughSettingsUi(owner, false);
  await waitUntil(async () => owner.webContents.executeJavaScript(
    `Boolean(document.querySelector(".launcher-button--browser"))`
  ));

  await owner.webContents.executeJavaScript(
    `document.querySelector(".launcher-button--browser").click(); void 0`
  );
  await zoomOutUntilBrowserClearsCanvasHud(owner);
  // The service still holds the viewport the earlier steps set directly, and that view is visible, so the
  // baseline is reached only once the BrowserCard's own report has placed the native page on its viewport.
  const baselineStage = await waitForBrowserLayeringStage(owner, fixtureUrl, "baseline", ({ native, dom }) => (
    native?.effectiveVisible === true && dom.page !== null && dom.hints === null
      && sameRectangle(native.pageBounds, dom.page, 2)
      && dom.card !== null && dom.overlays.every((overlay) => !rectanglesOverlap(overlay, dom.card!))
  ));

  const page = webContents.getAllWebContents().find((candidate) => candidate.getURL() === fixtureUrl);
  if (!page) throw new Error("Browser layering smoke could not find its loopback WebContents.");
  await owner.webContents.executeJavaScript(
    `document.querySelector(".browser-card__viewport").click(); void 0`
  );
  const baselineNative = browserNativeViewState(owner, fixtureUrl);
  const baselineDom = await browserLayeringDomState(owner);
  if (!baselineNative?.effectiveVisible || !baselineDom.page || !baselineStage.native
    || !sameRectangle(baselineNative.pageBounds, baselineStage.native.pageBounds, 2)) {
    throw new Error("The local Browser page was not live before creating the overlay overlap.");
  }
  if (!sameRectangle(baselineNative.pageBounds, baselineDom.page, 2)) {
    throw new Error(`Native Browser bounds do not match the BrowserCard viewport: ${JSON.stringify({
      native: baselineNative.pageBounds,
      dom: baselineDom.page
    })}.`);
  }
  const baselinePageBounds = baselineNative.pageBounds;
  const baselinePageState = await page.executeJavaScript(`({
    url: location.href,
    title: document.title,
    scrollX: window.scrollX,
    scrollY: window.scrollY
  })`) as { url: string; title: string; scrollX: number; scrollY: number };

  // Measure the actual DOM target while the app's real setting UI is on. The
  // initial BrowserCard geometry already overlaps this hint rectangle, so no
  // synthetic resize or forced native visibility change is needed.
  await setShortcutHintsThroughSettingsUi(owner, true);
  const measuredStage = await waitForBrowserLayeringStage(owner, fixtureUrl, "measured", ({ dom }) => (
    dom.hints !== null
  ));
  const targetHints = measuredStage.dom.hints;
  if (!targetHints) throw new Error("Could not measure the real shortcut overlay target.");
  const hiddenStage = await waitForBrowserLayeringStage(owner, fixtureUrl, "hidden", ({ native, dom }) => (
    native !== null && dom.page !== null && dom.hints !== null
      && rectanglesOverlap(dom.page, dom.hints)
      && rectanglesOverlap(native.paintBounds, dom.hints)
      && !native.effectiveVisible
      && dom.wheelOwner === "canvas"
  ));
  const overlapNative = hiddenStage.native;
  const overlapDom = hiddenStage.dom;
  if (!overlapNative || !overlapDom.page || !overlapDom.hints) {
    throw new Error("Browser layering smoke lost the native view or DOM overlay during overlap.");
  }
  if (!sameRectangle(overlapNative.pageBounds, baselinePageBounds, 1)
    || !rectanglesOverlap(overlapNative.paintBounds, targetHints)
    || !rectanglesOverlap(overlapNative.paintBounds, overlapDom.hints)) {
    throw new Error(`The hidden native view no longer occupies the measured DOM overlay region: ${JSON.stringify({
      native: overlapNative,
      measuredOverlay: targetHints,
      overlay: overlapDom.hints
    })}.`);
  }

  const marker = createLayeringOverlayMarker(overlapNative.paintBounds, overlapDom.page, overlapDom.hints);
  if (!rectangleContains(overlapDom.hints, marker.bounds)
    || !rectangleContains(overlapDom.page, marker.bounds)
    || !rectangleContains(overlapNative.paintBounds, marker.bounds)) {
    throw new Error(`The DOM overlay marker is outside the actual native page paint region: ${JSON.stringify({
      marker: marker.bounds,
      page: overlapDom.page,
      hints: overlapDom.hints,
      nativePaintBounds: overlapNative.paintBounds
    })}.`);
  }
  try {
    const beforeMarker = await owner.webContents.capturePage();
    await installLayeringOverlayMarker(owner, marker.bounds);
    await owner.webContents.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
    );
    const afterMarker = await owner.webContents.capturePage();
    const rendererSize = await owner.webContents.executeJavaScript(
      "({ width: window.innerWidth, height: window.innerHeight })"
    ) as { width: number; height: number };
    assertRendererCaptureShowsMarker(beforeMarker, afterMarker, marker.center, rendererSize);
    const hiddenNative = browserNativeViewState(owner, fixtureUrl);
    if (!hiddenNative || hiddenNative.effectiveVisible) {
      throw new Error("The native Browser view became visible while the DOM overlay was active.");
    }
  } finally {
    await owner.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(LAYERING_OVERLAY_ID)})?.remove();
      void 0`).catch(() => undefined);
  }

  await setShortcutHintsThroughSettingsUi(owner, false);
  const restoredStage = await waitForBrowserLayeringStage(owner, fixtureUrl, "restored", ({ native, dom }) => (
    native?.effectiveVisible === true && dom.hints === null
      && sameRectangle(native.pageBounds, baselinePageBounds, 1)
  ));
  const restoredNative = restoredStage.native;
  const restoredPageState = await page.executeJavaScript(`({
    url: location.href,
    title: document.title,
    scrollX: window.scrollX,
    scrollY: window.scrollY
  })`) as { url: string; title: string; scrollX: number; scrollY: number };
  if (!restoredNative || !sameRectangle(restoredNative.pageBounds, baselinePageBounds, 1)
    || JSON.stringify(restoredPageState) !== JSON.stringify(baselinePageState)) {
    throw new Error(`The live Browser did not restore at the same bounds and page state: ${JSON.stringify({
      baseline: { bounds: baselinePageBounds, page: baselinePageState },
      restored: { bounds: restoredNative?.pageBounds, page: restoredPageState }
    })}.`);
  }
  console.log("CANVASTTY_BROWSER_SMOKE_STEP native-dom-overlay-live-restore");
}

interface SmokeRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BrowserNativeViewState {
  pageBounds: SmokeRectangle;
  paintBounds: SmokeRectangle;
  effectiveVisible: boolean;
}

interface BrowserLayeringDomState {
  card: SmokeRectangle | null;
  page: SmokeRectangle | null;
  hints: SmokeRectangle | null;
  wheelOwner: string | null;
  /** Every other canvas HUD panel; any of them over the card correctly hides the native page. */
  overlays: SmokeRectangle[];
}

interface BrowserLayeringSnapshot {
  native: BrowserNativeViewState | null;
  dom: BrowserLayeringDomState;
}

async function waitForBrowserLayeringStage(
  owner: BrowserWindow,
  url: string,
  stage: "baseline" | "measured" | "hidden" | "restored",
  check: (snapshot: BrowserLayeringSnapshot) => boolean
): Promise<BrowserLayeringSnapshot> {
  let snapshot: BrowserLayeringSnapshot = {
    native: null,
    dom: { card: null, page: null, hints: null, wheelOwner: null, overlays: [] }
  };
  try {
    await waitUntil(async () => {
      snapshot = {
        native: browserNativeViewState(owner, url),
        dom: await browserLayeringDomState(owner)
      };
      return check(snapshot);
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Browser layering stage "${stage}" did not complete; last bounds/visibility snapshot: ${JSON.stringify(snapshot)}; ${reason}`);
  }
  console.log(`CANVASTTY_BROWSER_SMOKE_STEP native-dom-overlay-${stage} ${JSON.stringify(snapshot)}`);
  return snapshot;
}

/**
 * Pins the window to one content size on every platform. The 1440 x 900 default window is clamped by a smaller
 * display (macOS will not resize a window past its screen), and the fixture needs the card's place relative to
 * the canvas HUD to be the same everywhere: under the bottom-right shortcut hints, clear of everything else.
 */
async function ensureLayeringWindowSize(owner: BrowserWindow): Promise<void> {
  const { width, height } = LAYERING_WINDOW_CONTENT_SIZE;
  owner.setContentSize(width, height, false);
  await waitUntil(async () => {
    const inner = await owner.webContents.executeJavaScript(
      "({ width: window.innerWidth, height: window.innerHeight })"
    ) as { width: number; height: number };
    return inner.width === width && inner.height === height;
  });
}

/**
 * The card opens at a fixed focus zoom, 846 x 570 DIP on screen, which in a small window lies under the top-right
 * minimap and the bottom-left canvas controls; the app then correctly keeps the native page hidden. Zoom out with
 * the canvas's own control (about the viewport centre) until no HUD panel other than the shortcut hints, which
 * are off here, overlaps the card (the app hides the page when any part of the card is under one). In the
 * pinned window this leaves the page reaching under the hints' place.
 */
async function zoomOutUntilBrowserClearsCanvasHud(owner: BrowserWindow): Promise<void> {
  await waitUntil(async () => (await browserLayeringDomState(owner)).card !== null);
  // Four steps of 0.82 from the focus zoom stay above the canvas summary zoom, where the page is never shown.
  for (let step = 0; step < 4; step += 1) {
    const before = await browserLayeringDomState(owner);
    if (before.card && before.overlays.every((overlay) => !rectanglesOverlap(overlay, before.card!))) return;
    const clicked = await owner.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll(".canvas-controls button")]
        .find((candidate) => ${JSON.stringify(ZOOM_OUT_LABELS)}.includes(candidate.getAttribute("title") ?? ""));
      button?.click();
      return Boolean(button);
    })()`) as boolean;
    if (!clicked) throw new Error("Could not find the canvas zoom-out control.");
    await waitUntil(async () => {
      const after = await browserLayeringDomState(owner);
      return after.card !== null && before.card !== null && after.card.width < before.card.width - 1;
    });
  }
}

async function setShortcutHintsThroughSettingsUi(owner: BrowserWindow, visible: boolean): Promise<void> {
  await owner.webContents.executeJavaScript(`(() => {
    if (document.querySelector(".settings-panel--open")) return;
    const trigger = document.querySelector(".settings-button");
    if (!trigger) throw new Error("The HOME settings control is not mounted.");
    trigger.click();
  })()`);
  await waitUntil(async () => owner.webContents.executeJavaScript(
    `Boolean(document.querySelector(".settings-panel--open"))`
  ));
  await owner.webContents.executeJavaScript(
    `document.querySelector("#settings-tab-appearance")?.click(); void 0`
  );
  await waitUntil(async () => owner.webContents.executeJavaScript(
    `Boolean(document.querySelector("#settings-panel-appearance .setting-group"))`
  ));
  const desiredLabels = visible ? ["On", "Включено"] : ["Off", "Выключено"];
  const clickSetting = await owner.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector("#settings-panel-appearance");
    const group = [...(panel?.querySelectorAll(".setting-group") ?? [])].find((candidate) => {
      const label = candidate.querySelector(".setting-group__copy h3")?.textContent?.trim();
      return label === "Shortcut hint" || label === "Подсказка горячих клавиш";
    });
    const option = [...(group?.querySelectorAll(".segmented__button") ?? [])].find((button) =>
      ${JSON.stringify(desiredLabels)}.includes(button.textContent?.trim() ?? "")
    );
    if (!option) return false;
    option.click();
    return true;
  })()`);
  if (!clickSetting) throw new Error("Could not find the shortcut hint option in the Appearance settings UI.");

  await waitUntil(async () => owner.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector("#settings-panel-appearance");
    const group = [...(panel?.querySelectorAll(".setting-group") ?? [])].find((candidate) => {
      const label = candidate.querySelector(".setting-group__copy h3")?.textContent?.trim();
      return label === "Shortcut hint" || label === "Подсказка горячих клавиш";
    });
    const option = [...(group?.querySelectorAll(".segmented__button") ?? [])].find((button) =>
      ${JSON.stringify(desiredLabels)}.includes(button.textContent?.trim() ?? "")
    );
    return option?.classList.contains("segmented__button--active") === true;
  })()`));

  await owner.webContents.executeJavaScript(
    `document.querySelector(".settings-panel--open .settings-panel__close")?.click(); void 0`
  );
  await waitUntil(async () => owner.webContents.executeJavaScript(
    `!document.querySelector(".settings-panel--open")`
  ));
  await waitUntil(async () => {
    const dom = await browserLayeringDomState(owner);
    return visible ? dom.hints !== null : dom.hints === null;
  });
}

function browserNativeViewState(owner: BrowserWindow, url: string): BrowserNativeViewState | null {
  const findPath = (view: View, ancestors: View[] = []): View[] | null => {
    const path = [...ancestors, view];
    const contents = (view as View & { webContents?: { getURL(): string } }).webContents;
    if (contents?.getURL() === url) return path;
    for (const child of view.children) {
      const nested = findPath(child, path);
      if (nested) return nested;
    }
    return null;
  };
  let path: View[] | null = null;
  for (const child of owner.contentView.children) {
    path = findPath(child);
    if (path) break;
  }
  if (!path) return null;

  let x = 0;
  let y = 0;
  let paintBounds: SmokeRectangle | null = null;
  let effectiveVisible = true;
  for (const view of path) {
    const bounds = view.getBounds();
    x += bounds.x;
    y += bounds.y;
    const absolute = { x, y, width: bounds.width, height: bounds.height };
    paintBounds = paintBounds === null ? absolute : intersectRectangles(paintBounds, absolute);
    effectiveVisible = effectiveVisible && view.getVisible();
  }
  const pageBounds = path[path.length - 1]!.getBounds();
  // Convert the page's local bounds to the same main-window coordinate space as DOMClientRects.
  const absolutePageBounds = path.reduce((rect, view) => {
    const bounds = view.getBounds();
    return { ...rect, x: rect.x + bounds.x, y: rect.y + bounds.y };
  }, { x: 0, y: 0, width: pageBounds.width, height: pageBounds.height });
  return { pageBounds: absolutePageBounds, paintBounds: paintBounds ?? absolutePageBounds, effectiveVisible };
}

async function browserLayeringDomState(owner: BrowserWindow): Promise<BrowserLayeringDomState> {
  return owner.webContents.executeJavaScript(`(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return { x: value.left, y: value.top, width: value.width, height: value.height };
    };
    return {
      card: rect(".browser-card"),
      page: rect(".browser-card__viewport"),
      hints: rect(".shortcut-hints"),
      overlays: [...document.querySelectorAll(".canvas-overlay-slot > :not(.shortcut-hints)")]
        .map((element) => element.getBoundingClientRect())
        .filter((value) => value.width > 0 && value.height > 0)
        .map((value) => ({ x: value.left, y: value.top, width: value.width, height: value.height })),
      wheelOwner: document.querySelector(".browser-card")?.getAttribute("data-browser-canvas-wheel-owner") ?? null
    };
  })()`) as Promise<BrowserLayeringDomState>;
}

function intersectRectangles(left: SmokeRectangle, right: SmokeRectangle): SmokeRectangle {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  return { x, y, width: Math.max(0, rightEdge - x), height: Math.max(0, bottomEdge - y) };
}

function rectanglesOverlap(left: SmokeRectangle, right: SmokeRectangle): boolean {
  return intersectRectangles(left, right).width > 0 && intersectRectangles(left, right).height > 0;
}

function rectangleContains(outer: SmokeRectangle, inner: SmokeRectangle): boolean {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

function sameRectangle(left: SmokeRectangle, right: SmokeRectangle, tolerance = 0): boolean {
  return Math.abs(left.x - right.x) <= tolerance && Math.abs(left.y - right.y) <= tolerance
    && Math.abs(left.width - right.width) <= tolerance && Math.abs(left.height - right.height) <= tolerance;
}

function createLayeringOverlayMarker(
  nativePaintBounds: SmokeRectangle,
  pageBounds: SmokeRectangle,
  hintsBounds: SmokeRectangle
): { bounds: SmokeRectangle; center: { x: number; y: number } } {
  const overlap = intersectRectangles(intersectRectangles(nativePaintBounds, pageBounds), hintsBounds);
  if (overlap.width < 4 || overlap.height < 4) {
    throw new Error(`The native Browser, its DOM viewport, and the shortcut overlay do not share a usable paint area: ${JSON.stringify({
      nativePaintBounds,
      pageBounds,
      hintsBounds,
      overlap
    })}.`);
  }
  const left = Math.ceil(overlap.x);
  const top = Math.ceil(overlap.y);
  const availableWidth = Math.floor(overlap.x + overlap.width) - left;
  const availableHeight = Math.floor(overlap.y + overlap.height) - top;
  if (availableWidth < 4 || availableHeight < 4) {
    throw new Error(`The shared paint area has no integer-aligned four-pixel marker area: ${JSON.stringify({ overlap })}.`);
  }
  const width = Math.min(8, availableWidth);
  const height = Math.min(8, availableHeight);
  const bounds = {
    x: left + Math.floor((availableWidth - width) / 2),
    y: top + Math.floor((availableHeight - height) / 2),
    width,
    height
  };
  return {
    bounds,
    center: {
      x: bounds.x + Math.floor(bounds.width / 2),
      y: bounds.y + Math.floor(bounds.height / 2)
    }
  };
}

async function installLayeringOverlayMarker(owner: BrowserWindow, bounds: SmokeRectangle): Promise<void> {
  await owner.webContents.executeJavaScript(`(() => {
    const overlay = document.querySelector(".shortcut-hints");
    if (!overlay) throw new Error("The DOM shortcut overlay disappeared before capture.");
    const marker = document.createElement("button");
    marker.id = ${JSON.stringify(LAYERING_OVERLAY_ID)};
    marker.type = "button";
    marker.setAttribute("aria-label", "Native layering smoke overlay");
    Object.assign(marker.style, {
      position: "fixed",
      left: ${JSON.stringify(bounds.x)} + "px",
      top: ${JSON.stringify(bounds.y)} + "px",
      width: ${JSON.stringify(bounds.width)} + "px",
      height: ${JSON.stringify(bounds.height)} + "px",
      padding: "0",
      border: "0",
      zIndex: "2147483647",
      background: "rgb(255, 0, 255)",
      color: "white",
      pointerEvents: "auto"
    });
    overlay.append(marker);
    return true;
  })()`);
}

function assertRendererCaptureShowsMarker(
  before: NativeImage,
  after: NativeImage,
  center: { x: number; y: number },
  rendererViewport: { width: number; height: number }
): void {
  if (before.isEmpty() || after.isEmpty()) throw new Error("Renderer overlay capture was empty.");
  const viewport = before.getSize(1);
  const afterViewport = after.getSize(1);
  if (viewport.width !== afterViewport.width || viewport.height !== afterViewport.height) {
    throw new Error("Renderer overlay capture changed size during the layering smoke.");
  }
  if (!(rendererViewport.width > 0 && rendererViewport.height > 0)) {
    throw new Error("Renderer overlay capture has invalid viewport dimensions.");
  }
  const width = viewport.width;
  const height = viewport.height;
  const beforePixels = before.toBitmap({ scaleFactor: 1 });
  const afterPixels = after.toBitmap({ scaleFactor: 1 });
  if (beforePixels.length !== width * height * 4 || afterPixels.length !== width * height * 4) {
    throw new Error("Renderer overlay capture returned an unexpected bitmap layout.");
  }
  const pixelX = Math.floor(center.x * width / rendererViewport.width);
  const pixelY = Math.floor(center.y * height / rendererViewport.height);
  const index = (pixelY * width + pixelX) * 4;
  if (index < 0 || index + 4 > afterPixels.length) {
    throw new Error("The DOM overlay marker fell outside the renderer screenshot.");
  }
  const isMagenta = (pixels: Buffer): boolean => Math.abs(pixels[index]! - 255) <= 8
    && pixels[index + 1]! <= 8
    && Math.abs(pixels[index + 2]! - 255) <= 8
    && pixels[index + 3]! >= 240;
  if (isMagenta(beforePixels)) {
    throw new Error("The magenta DOM overlay marker was already present before installation.");
  }
  if (!isMagenta(afterPixels)) {
    throw new Error(`The renderer screenshot did not capture the magenta DOM marker: ${JSON.stringify({
      rgba: Array.from(afterPixels.subarray(index, index + 4))
    })}.`);
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
    await preparePhysicalWheelSmoke(owner, contents);
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
    // A hung renderer must not hide the original readiness/assertion failure during cleanup.
    await Promise.all([
      runBrowserSmokeCleanup(() => contents.executeJavaScript("window.scrollTo(0, 0)"), CLEANUP_TIMEOUT_MS),
      runBrowserSmokeCleanup(() => owner.webContents.executeJavaScript(`
        globalThis.__canvasttyWheelRelayOff?.();
        delete globalThis.__canvasttyWheelRelayOff;
        delete globalThis.__canvasttyWheelRelays;
      `), CLEANUP_TIMEOUT_MS)
    ]);
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
  let wheelPulse: ReturnType<typeof setInterval> | undefined;
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

    const sendWheel = (): void => owner.webContents.sendInputEvent({
      type: "mouseWheel",
      x: 400,
      y: 300,
      deltaX: 8,
      deltaY: 12
    });
    // Renderer round trips can exceed the idle boundary. Keep a real wheel stream active while
    // checking surface transitions, then stop it to test the normal idle end separately.
    sendWheel();
    wheelPulse = setInterval(sendWheel, Math.max(1, Math.floor(BROWSER_CANVAS_WHEEL_IDLE_MS / 5)));
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
    clearInterval(wheelPulse);
    wheelPulse = undefined;
    await waitUntil(async () => owner.webContents.executeJavaScript(`
      (() => {
        const events = globalThis.__canvasttyFreezeEvents ?? [];
        const activeIndex = events.findIndex((event) => event.active && event.dataUrlLength > 0);
        return activeIndex >= 0 && events.slice(activeIndex + 1).some((event) => !event.active);
      })()
    `));
  } finally {
    clearInterval(wheelPulse);
    service.setViewport({ x: 0, y: 0, width: 820, height: 620, surface: "native", canvasScale: 1 });
    await owner.webContents.executeJavaScript(`
      globalThis.__canvasttyFreezeOff?.();
      delete globalThis.__canvasttyFreezeOff;
      delete globalThis.__canvasttyFreezeEvents;
    `).catch(() => undefined);
  }
}

async function browserSmokePageState(contents: Electron.WebContents): Promise<BrowserSmokePageState> {
  return await contents.executeJavaScript(`({
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    focused: document.hasFocus(),
    width: window.innerWidth,
    height: window.innerHeight,
    scrollY: window.scrollY,
    maxScrollY: Math.max(0, (document.scrollingElement?.scrollHeight ?? 0)
      - (document.scrollingElement?.clientHeight ?? window.innerHeight))
  })`) as BrowserSmokePageState;
}

async function preparePhysicalWheelSmoke(
  owner: BrowserWindow,
  contents: Electron.WebContents
): Promise<void> {
  if (owner.isDestroyed() || contents.isDestroyed()) {
    throw new Error("Physical Browser wheel smoke cannot prepare a destroyed window or tab.");
  }
  owner.show();
  if (process.platform === "darwin") app.focus({ steal: true });
  owner.focus();
  let state: BrowserSmokeWheelReadiness | null = null;
  try {
    await waitForBrowserSmokeWheelReady(async () => {
      if (owner.isDestroyed() || contents.isDestroyed()) {
        throw new Error("Physical Browser wheel smoke window or tab was destroyed while preparing input.");
      }
      // Logical input ownership is independent of native window/page focus. Electron requires the
      // containing window to be focused before sendInputEvent can exercise real page wheel handling.
      if (owner.isVisible() && owner.isFocused()) contents.focus();
      state = {
        ownerVisible: owner.isVisible(),
        ownerFocused: owner.isFocused(),
        page: await browserSmokePageState(contents)
      };
      return state;
    }, READY_TIMEOUT_MS);
  } catch (error) {
    throw new Error(
      `Physical Browser wheel smoke prerequisites were not met within ${READY_TIMEOUT_MS} ms. `
      + "It requires an unlocked, active desktop, a visible focused window, and a loaded visible focused page. "
      + `A locked display or unavailable desktop focus prevents physical input. State: ${JSON.stringify(state)}. `
      + `Reason: ${error instanceof Error ? error.message : String(error)}.`,
      { cause: error }
    );
  }
}

async function sendWheelUntilPageScrolls(
  contents: Electron.WebContents,
  point: { x: number; y: number }
): Promise<number> {
  for (const deltaY of [-120, 120]) {
    await contents.executeJavaScript("window.scrollTo(0, 400)");
    const baseline = requireBrowserSmokeScrollBaseline(await browserSmokePageState(contents), point, 400);
    contents.sendInputEvent({ type: "mouseWheel", ...point, deltaX: 0, deltaY });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const scrollY = await contents.executeJavaScript("window.scrollY") as number;
      if (scrollY !== baseline) return scrollY;
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
