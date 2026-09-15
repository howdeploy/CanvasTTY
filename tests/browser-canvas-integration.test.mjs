import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { HOVER_FOCUS_DELAYS, shouldActivateCanvasFromClick } from "../src/renderer/src/features/workspace/focus.ts";

const browserCardPath = new URL("../src/renderer/src/features/browser/BrowserCard.tsx", import.meta.url);
const browserServicePath = new URL("../src/main/services/BrowserService.ts", import.meta.url);
const workspacePath = new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url);
const focusHookPath = new URL("../src/renderer/src/features/workspace/useCanvasWidgetFocus.ts", import.meta.url);
const iconPath = new URL("../src/renderer/src/components/UiIcon.tsx", import.meta.url);
const stylesPath = new URL("../src/renderer/src/styles/app.css", import.meta.url);

test("browser and terminal share canvas focus activation semantics", () => {
  assert.equal(shouldActivateCanvasFromClick("single", 1), true);
  assert.equal(shouldActivateCanvasFromClick("single", 2), false);
  assert.equal(shouldActivateCanvasFromClick("double", 1), false);
  assert.equal(shouldActivateCanvasFromClick("double", 2), true);
  assert.equal(shouldActivateCanvasFromClick("off", 1), false);
  assert.deepEqual(HOVER_FOCUS_DELAYS, { slow: 500, normal: 250, fast: 80 });
});

test("browser native input participates in selection and independent logical focus", async () => {
  const [card, service, workspace, focusHook] = await Promise.all([
    readFile(browserCardPath, "utf8"),
    readFile(browserServicePath, "utf8"),
    readFile(workspacePath, "utf8"),
    readFile(focusHookPath, "utf8")
  ]);

  assert.match(service, /contents\.on\("before-mouse-event"/);
  assert.match(service, /if \(pointerType === "down"\) \{[\s\S]*?contents\.focus\(\);[\s\S]*?this\.setInputFocused\(true\)/);
  assert.match(card, /window\.canvasTTY\.browser\.onCanvasPointer/);
  assert.match(card, /browser-card--selected/);
  assert.match(workspace, /selected=\{browserSelected && selectedBrowserId === entry\.id\}/);
  assert.match(workspace, /focusActivation=\{settings\.focusActivation\}/);
  assert.match(workspace, /focusController\.focusBrowser/);
  assert.match(focusHook, /HOVER_FOCUS_DELAYS\[settingsRef\.current\.hoverFocusSpeed\]/);
  assert.match(focusHook, /canvasWidgetFocusAfterClick/);
});

test("native Browser layout remains a BrowserService responsibility", async () => {
  const [card, service, styles] = await Promise.all([
    readFile(browserCardPath, "utf8"),
    readFile(browserServicePath, "utf8"),
    readFile(stylesPath, "utf8")
  ]);

  assert.doesNotMatch(card, /canvasMoving|manipulating|browser-card__motion-surface/);
  assert.match(card, /const rect = element\.getBoundingClientRect\(\);\s*const clipRect = element\.closest<HTMLElement>\("\.workspace"\)\?\.getBoundingClientRect\(\);/);
  assert.match(card, /clipBounds: \{/);
  assert.match(service, /clipBrowserViewportBounds\(this\.viewport, content\)/);
  assert.match(service, /if \(this\.clipTabId !== active\.id\)/);
  assert.match(service, /this\.applyPageScale\(active\)/);
  assert.match(service, /contents\.setZoomFactor\(pageScale\)/);
  // The page slot must stay declared by the card: anchored below the header and
  // carrying the page background. The horizontal insets are deliberately not
  // pinned - the page area is flush with the card edges and its corners are
  // rounded in the main process instead.
  assert.match(styles, /\.browser-card__viewport \{[^}]*inset: calc\(var\(--card-header-height\) \+ 86px\) [^;]*;[^}]*background: #272934;/);
});

test("background browser activation cannot focus an inactive CanvasTTY window", async () => {
  const source = await readFile(browserServicePath, "utf8");
  const focusStart = source.indexOf("focus(): void");
  const activateStart = source.indexOf("private async hostActivateTab");
  const focusRoute = source.slice(focusStart, source.indexOf("setInputFocused", focusStart));
  const activateRoute = source.slice(activateStart, source.indexOf("private async hostCloseTab", activateStart));

  assert.match(focusRoute, /owner\.isFocused\(\)/);
  assert.match(activateRoute, /owner\.isFocused\(\)/);
  assert.match(activateRoute, /tab\.view\.webContents\.focus\(\)/);
});

test("browser tab chrome highlights only the active tab", async () => {
  const [card, styles] = await Promise.all([
    readFile(browserCardPath, "utf8"),
    readFile(stylesPath, "utf8")
  ]);

  assert.match(card, /tab\.id === browser\.activeTabId \? "browser-card__tab--active" : ""/);
  assert.match(styles, /\.browser-card__tab \{[^}]*background: rgba\(255,255,255,\.025\);/);
  assert.match(styles, /\.browser-card__tab--active \{[^}]*background: rgba\(255,255,255,\.13\);/);
});

test("browser window actions are separated from tab actions and use the Lucide globe", async () => {
  const [card, icon] = await Promise.all([
    readFile(browserCardPath, "utf8"),
    readFile(iconPath, "utf8")
  ]);

  const headerStart = card.indexOf('className="browser-card__header"');
  const tabsStart = card.indexOf('className="browser-card__tabs"');
  assert.ok(headerStart >= 0 && tabsStart > headerStart);
  assert.match(card.slice(headerStart, tabsStart), /className="browser-card__hide"/);
  assert.doesNotMatch(card.slice(tabsStart, card.indexOf("<nav", tabsStart)), /browser-card__hide/);
  assert.match(icon, /globe\.svg/);
});
