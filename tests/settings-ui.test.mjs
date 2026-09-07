import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const settingsPanelPath = new URL("../src/renderer/src/features/settings/SettingsPanel.tsx", import.meta.url);
const agentHooksPath = new URL("../src/renderer/src/features/settings/AgentHooksSettings.tsx", import.meta.url);
const aboutPath = new URL("../src/renderer/src/features/settings/AboutSettings.tsx", import.meta.url);
const workspacePath = new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url);
const regionCardPath = new URL("../src/renderer/src/features/workspace/CanvasRegionCard.tsx", import.meta.url);
const contextMenuPath = new URL("../src/renderer/src/features/workspace/CanvasContextMenu.tsx", import.meta.url);
const commandPalettePath = new URL("../src/renderer/src/features/workspace/CanvasCommandPalette.tsx", import.meta.url);
const menuPrimitivesPath = new URL("../src/renderer/src/components/CanvasMenuPrimitives.tsx", import.meta.url);
const minimapPath = new URL("../src/renderer/src/features/workspace/CanvasMinimap.tsx", import.meta.url);
const homeZonePath = new URL("../src/renderer/src/features/home/HomeZone.tsx", import.meta.url);
const appStylesPath = new URL("../src/renderer/src/styles/app.css", import.meta.url);

test("About is the final Settings tab and owns the expandable hook FAQ", async () => {
  const [settings, about] = await Promise.all([
    readFile(settingsPanelPath, "utf8"),
    readFile(aboutPath, "utf8")
  ]);
  assert.ok(settings.indexOf('{ id: "about", icon: "info" }') > settings.indexOf('{ id: "plugins", icon: "blocks" }'));
  assert.match(settings, /section === "about" && <AboutSettings/);
  assert.match(about, /<details key=\{question\}>/);
  assert.match(about, /aboutFaqPluginHooksQuestion/);
});

test("Settings uses the approved icon-sidebar modal instead of the legacy horizontal tab sheet", async () => {
  const [settings, styles] = await Promise.all([
    readFile(settingsPanelPath, "utf8"),
    readFile(appStylesPath, "utf8")
  ]);
  assert.match(settings, /className="settings-panel__sidebar"/);
  assert.match(settings, /className="settings-panel__main"/);
  assert.match(settings, /className="settings-tabs__icon"/);
  assert.match(settings, /settings-panel__brand-icon"><UiIcon name="settings"/);
  assert.match(settings, /\{ id: "general", icon: "app-window" \}/);
  assert.doesNotMatch(settings, /\{ id: "general", icon: "settings" \}/);
  assert.match(settings, /SETTINGS_SECTIONS\.map\(\(\{ id, icon \}\)/);
  assert.match(settings, /className=\{`setting-group setting-group--field\$\{layout === "stacked" \? " setting-group--stacked" : ""\}`\}/);
  assert.doesNotMatch(settings, /settings-panel__topbar/);
  assert.match(styles, /\.settings-panel \{[^}]*grid-template-columns: 15\.5em minmax\(0, 1fr\);[^}]*background: var\(--surface\);[^}]*font-size: calc\(13px \* var\(--ui-scale, 1\)\)/);
  assert.match(styles, /\.settings-tabs \{[^}]*flex-direction: column/);
  assert.match(styles, /\.settings-tabs__button--active \.settings-tabs__icon \{[^}]*background: var\(--primary\)/);
  assert.match(styles, /\.setting-group--field \{[^}]*grid-template-columns: minmax\(11em, \.78fr\) minmax\(18em, 1\.22fr\)/);
  assert.match(styles, /\.setting-group--stacked \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.doesNotMatch(styles, /\.settings-tabs \{[^}]*grid-template-columns: repeat\(6/);
});

test("Hooks stays concise while detailed safety copy is available in About", async () => {
  const [hooks, styles] = await Promise.all([
    readFile(agentHooksPath, "utf8"),
    readFile(appStylesPath, "utf8")
  ]);
  assert.match(hooks, /pluginHookSecuritySummary/);
  assert.match(hooks, /<p className="agent-hooks__empty">\{t\(locale, "noOptionalPluginHooks"\)\}<\/p>/);
  assert.doesNotMatch(hooks, /agentHooksRestartNote|agentHooksProviderTrustNote|pluginHookActivationNote/);
  assert.doesNotMatch(hooks, /pluginHookSecurityWarning/);
  assert.match(styles, /\.agent-hooks__empty \{[^}]*padding: 0;[^}]*background: transparent;[^}]*text-align: left;/);
});

test("HOME and rename are independent shortcut settings with mouse capture", async () => {
  const settings = await readFile(settingsPanelPath, "utf8");
  assert.doesNotMatch(settings, /<SettingGroup label=\{t\(locale, "keyboardShortcuts"\)\}>/);
  assert.match(settings, /label=\{t\(locale, "homeShortcut"\)\} description=\{t\(locale, "homeShortcutDescription"\)\}/);
  assert.match(settings, /label=\{t\(locale, "renameWindow"\)\} description=\{t\(locale, "renameWindowDescription"\)\}/);
  assert.match(settings, /capturePointerShortcut\("home", event\)/);
  assert.match(settings, /capturePointerShortcut\("renameWindow", event\)/);
});

test("canvas overlays share configurable collision-safe corner slots", async () => {
  const [settings, workspace, minimap] = await Promise.all([
    readFile(settingsPanelPath, "utf8"),
    readFile(workspacePath, "utf8"),
    readFile(minimapPath, "utf8")
  ]);
  assert.match(settings, /settings\.minimapPlacement/);
  assert.match(settings, /settings\.minimapInteractionMode/);
  assert.match(settings, /settings\.shortcutHintsPlacement/);
  assert.match(settings, /settings\.canvasControlsPlacement/);
  assert.match(workspace, /CANVAS_OVERLAY_PLACEMENTS\.map/);
  assert.match(workspace, /<CanvasMinimap/);
  assert.match(workspace, /interactionMode=\{settings\.minimapInteractionMode\}/);
  assert.match(minimap, /setPointerCapture/);
  assert.match(minimap, /startCamera: cameraRef\.current/);
  assert.doesNotMatch(minimap, /state\?\.pointerId === event\.pointerId && !state\.moved/);
  assert.match(minimap, /\} else \{\s*dragState\.current = null;\s*navigate\(event\.clientX, event\.clientY\);\s*\}/);
  assert.match(minimap, /interactionMode === "drag"/);
  assert.match(minimap, /data-interaction-mode=\{interactionMode\}/);
  assert.match(minimap, /applyCamera\(\{/);
});

test("General keeps independent persistence controls", async () => {
  const settings = await readFile(settingsPanelPath, "utf8");
  assert.match(settings, /settings\.restoreTerminalSessions \? "save" : "discard"/);
  assert.match(settings, /restoreTerminalSessions: value === "save"/);
  assert.match(settings, /settings\.persistCanvasRegions \? "save" : "discard"/);
  assert.match(settings, /persistCanvasRegions: value === "save"/);
  assert.match(settings, /settings\.persistStickyNotes \? "save" : "discard"/);
  assert.match(settings, /persistStickyNotes: value === "save"/);
});

test("Appearance controls whole-row session status colors", async () => {
  const [settings, home, styles] = await Promise.all([
    readFile(settingsPanelPath, "utf8"),
    readFile(homeZonePath, "utf8"),
    readFile(appStylesPath, "utf8")
  ]);
  assert.match(settings, /value=\{settings\.sessionRowColorMode\}/);
  assert.match(settings, /sessionRowColorsByStatus/);
  assert.match(settings, /sessionRowColorsMonochrome/);
  assert.match(home, /data-session-row-colors=\{settings\.sessionRowColorMode\}/);
  assert.match(home, /data-session-tone=\{sessionStatusTone\(session\.status\)\}/);
  assert.match(styles, /data-session-tone="working"/);
  assert.match(styles, /data-session-tone="waiting"/);
});

test("empty-canvas context menu creates persisted named color regions", async () => {
  const workspace = await readFile(workspacePath, "utf8");
  assert.match(workspace, /onContextMenu=/);
  assert.match(workspace, /<CanvasRegionMenu/);
  assert.match(workspace, /canvasRegionAtPoint/);
  assert.match(workspace, /settings\.canvasRegions\.map/);
  assert.match(workspace, /onCreateCanvasRegion/);
});

test("one context dispatcher preserves native menus and routes regions and notes", async () => {
  const workspace = await readFile(workspacePath, "utf8");
  assert.match(workspace, /<CanvasContextMenu/);
  assert.match(workspace, /routeCanvasContextMenu/);
  assert.match(workspace, /textarea, input, \[contenteditable='true'\], \.terminal-card, \.plugin-canvas-card, \.browser-card/);
  assert.match(workspace, /data-sticky-note-id/);
  assert.match(workspace, /data-canvas-region-id/);
  assert.match(workspace, /onCreateStickyNote/);
});

test("sticky notes expose a top-right close button wired to deletion", async () => {
  const [workspace, noteCard, styles] = await Promise.all([
    readFile(workspacePath, "utf8"),
    readFile(new URL("../src/renderer/src/features/notes/StickyNoteCard.tsx", import.meta.url), "utf8"),
    readFile(appStylesPath, "utf8")
  ]);
  assert.match(workspace, /onClose=\{onDeleteStickyNote\}/);
  assert.match(noteCard, /className="sticky-note-card__close"/);
  assert.match(noteCard, /onClose\(note\.id\)/);
  assert.match(noteCard, /aria-label=\{t\(locale, "close"\)\}/);
  assert.match(styles, /\.sticky-note-card__header \{[^}]*justify-content: space-between/);
  assert.match(styles, /\.sticky-note-card__close \{/);
});

test("canvas windows use click-to-front stacking and Browser occlusion", async () => {
  const workspace = await readFile(workspacePath, "utf8");
  assert.match(workspace, /closest<HTMLElement>\("\[data-canvas-layer-id\]"\)/);
  assert.match(workspace, /raiseLayer\(layerId\)/);
  assert.match(workspace, /canvasLayerIsOccluded\(browserLayerId/);
  assert.match(workspace, /!browserOccluded/);
});

test("region members follow the region during the gesture and commit only at release", async () => {
  const [workspace, regionCard] = await Promise.all([
    readFile(workspacePath, "utf8"),
    readFile(regionCardPath, "utf8")
  ]);
  assert.match(regionCard, /onMovePreview\(region\.id, liveBounds\.current\)/);
  assert.match(regionCard, /onMovePreview\(region\.id, next\)/);
  assert.match(regionCard, /onBoundsChange\(region\.id, liveBounds\.current, "move"\);\s*onMovePreview\(region\.id, null\)/);
  assert.match(workspace, /sessionBounds: containedBounds\(sessions, startRegion\)/);
  assert.match(workspace, /renderedSessions/);
  assert.match(workspace, /renderedPluginCanvas/);
  assert.match(workspace, /renderedBrowserCanvas/);
  assert.match(workspace, /renderedStickyNotes/);
});

test("the redesigned menus use shared tokens, em geometry, and the configured UI scale", async () => {
  const [settings, styles, contextMenu, commandPalette, menuPrimitives] = await Promise.all([
    readFile(settingsPanelPath, "utf8"),
    readFile(appStylesPath, "utf8"),
    readFile(contextMenuPath, "utf8"),
    readFile(commandPalettePath, "utf8"),
    readFile(menuPrimitivesPath, "utf8")
  ]);
  assert.match(settings, /value=\{settings\.palette\}/);
  assert.match(settings, /min=\{UI_SCALE_MIN\}/);
  assert.match(settings, /canvasLauncherItems: setCanvasLauncherItemEnabled/);
  assert.match(styles, /\.canvas-menu, \.canvas-region-editor, \.canvas-command-palette \{ font-size: calc\(13px \* var\(--ui-scale, 1\)\); \}/);
  assert.match(styles, /\.canvas-menu \{[^}]*min-width: 19em;[^}]*padding: \.45em;[^}]*background: var\(--surface\);[^}]*box-shadow: var\(--shadow-lg\)/);
  assert.match(styles, /\.canvas-menu__row \{[^}]*font-weight: 400;/);
  assert.match(styles, /\.canvas-menu__icon \{[^}]*width: 1\.85em;[^}]*height: 1\.85em;[^}]*border-radius: \.55em;[^}]*color: var\(--secondary\);[^}]*background: var\(--surface-soft\)/);
  assert.match(styles, /\.canvas-menu__kbd \{[^}]*color: var\(--text-dark\);[^}]*background: var\(--secondary\)/);
  assert.match(styles, /\.canvas-menu__swatches \{[^}]*gap: \.45em/);
  assert.match(styles, /\.canvas-command-palette__footer \{[^}]*border-top:/);
  assert.match(menuPrimitives, /<span className="canvas-menu__icon">[\s\S]*<UiIcon name=\{icon\} size="1\.05em" \/>/);
  assert.match(contextMenu, /canvasMenuHere/);
  assert.match(contextMenu, /CANVAS_REGION_COLORS\.map/);
  assert.match(contextMenu, /canvas-menu__swatch--selected/);
  assert.match(contextMenu, /canvasMenuRegionContentsStay/);
  assert.match(commandPalette, /CanvasMenuLabel>\{t\(locale, "canvasMenuSessions"\)\}/);
  assert.match(commandPalette, /canvas-command-palette__footer/);
  assert.match(settings, /className="canvas-menu canvas-launcher-settings-menu"/);
  assert.match(settings, /icon=\{enabled \? "minus" : "plus"\}/);
  assert.match(settings, /layout="stacked"\s+label=\{t\(locale, "canvasLauncherItems"\)\}/);
  assert.match(settings, /layout="stacked"\s+label=\{t\(locale, "homeLauncherAgents"\)\}/);
  assert.match(settings, /layout="stacked"\s+label=\{t\(locale, "homeLimitProviders"\)\}/);
  assert.match(settings, /<CanvasMenuRow\s+icon="home"\s+muted/);
  assert.doesNotMatch(contextMenu, /canvas-menu__section|onChangeRegionColor\(\)/);
  const menuStyleStart = styles.indexOf(".canvas-menu, .canvas-region-editor, .canvas-command-palette");
  const menuStyleEnd = styles.indexOf(".sticky-note-card", menuStyleStart);
  const menuStyles = styles.slice(menuStyleStart, menuStyleEnd);
  assert.doesNotMatch(menuStyles, /#[\da-f]{3,8}|rgba?\(/i);
  assert.match(styles, /\.launcher-dock \{[^}]*font-size: calc\(13px \* var\(--ui-scale, 1\)\)/);
  assert.match(styles, /--card-header-height: calc\(54px \* var\(--ui-scale, 1\)\)/);
  assert.match(styles, /\.terminal-card__header \{[^}]*font-size: calc\(13px \* var\(--ui-scale, 1\)\)/);
  assert.match(styles, /\.plugin-canvas-card__header \{[^}]*font-size: calc\(13px \* var\(--ui-scale, 1\)\)/);
  assert.match(styles, /\.browser-card__header \{[^}]*font-size: calc\(13px \* var\(--ui-scale, 1\)\)/);
  assert.doesNotMatch(styles, /\.canvas-region-menu/);
});
