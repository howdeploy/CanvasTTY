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
const terminalSkinsPath = new URL("../src/renderer/src/styles/terminalSkins.css", import.meta.url);
const ornateTerminalSkinsPath = new URL("../src/renderer/src/styles/ornateTerminalSkins.css", import.meta.url);
const appSkinsPath = new URL("../src/renderer/src/styles/appSkins.css", import.meta.url);
const terminalCardPath = new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url);
const pixelTerminalSkinsPath = new URL("../src/renderer/src/styles/pixelTerminalSkins.css", import.meta.url);

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

test("terminal border selection reaches cards with a preview for every choice", async () => {
  const [settings, workspace, card, styles, ornateStyles] = await Promise.all([
    readFile(settingsPanelPath, "utf8"),
    readFile(workspacePath, "utf8"),
    readFile(terminalCardPath, "utf8"),
    readFile(terminalSkinsPath, "utf8"),
    readFile(ornateTerminalSkinsPath, "utf8")
  ]);
  assert.match(settings, /onChange=\{\(terminalBorderSkin\) => void onChange\(\{ terminalBorderSkin \}\)\}/);
  assert.match(workspace, /borderSkin=\{settings\.terminalBorderSkin\}/);
  assert.match(card, /data-border-skin=\{borderSkin\}/);
  for (const skin of ["classic", "minimal", "glass", "cyber", "nord", "gradient", "cybercore", "titanium", "retro", "sakura", "matrix", "forest-cabin", "gold-black", "cat", "gothic-eclipse"]) {
    assert.match(settings, new RegExp(`\\["${skin}", "borderSkin`));
  }
  for (const skin of ["minimal", "glass", "cyber", "nord", "gradient"]) {
    assert.ok(styles.includes(`.terminal-card[data-border-skin="${skin}"]`));
    assert.ok(styles.includes(`.border-skin-preview[data-border-skin="${skin}"]`));
  }
  for (const skin of ["cybercore", "titanium", "retro"]) {
    assert.ok(ornateStyles.includes(`.terminal-card[data-border-skin="${skin}"]`));
    assert.ok(ornateStyles.includes(`.border-skin-preview[data-border-skin="${skin}"]`));
  }
  assert.doesNotMatch(settings, /\["botanical", "borderSkinBotanical"\]/);
  assert.doesNotMatch(ornateStyles, /data-border-skin="botanical"/);
});

test("pixel border skin preview is scoped, responsive, and bounds stage within modal", async () => {
  const [settings, pixelStyles] = await Promise.all([
    readFile(settingsPanelPath, "utf8"),
    readFile(pixelTerminalSkinsPath, "utf8")
  ]);

  // Check SettingsPanel contains the expected structure
  assert.match(settings, /className="pixel-skin-preview-tools"/);
  assert.match(settings, /className="pixel-skin-preview-tools__groups"/);
  assert.match(settings, /className="pixel-skin-preview-tools__group"/);
  assert.match(settings, /className="pixel-skin-preview-stage"/);
  assert.match(settings, /className="pixel-skin-preview-stage__screen"/);
  assert.match(settings, /className="pixel-skin-preview-stage__activity"/);

  // Tools container spans choices grid
  assert.match(pixelStyles, /\.pixel-skin-preview-tools \{[^}]*grid-column: 1 \/ -1;/);

  // Grouped controls wrap and button states
  assert.match(pixelStyles, /\.pixel-skin-preview-tools__groups \{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
  assert.match(pixelStyles, /\.pixel-skin-preview-tools__button:focus-visible \{/);
  assert.match(pixelStyles, /\.pixel-skin-preview-tools__button--active/);

  // Bounded 3:2 stage
  assert.match(pixelStyles, /\.pixel-skin-preview-stage \{[^}]*position: relative;[^}]*width: 100%;[^}]*max-width: 520px;[^}]*aspect-ratio: 3 \/ 2;[^}]*overflow: hidden;/);

  // Absolute inset stage canvas & aperture screen
  assert.match(pixelStyles, /\.pixel-skin-preview-stage \.terminal-skin-canvas \{[^}]*position: absolute;[^}]*inset: 0;/);
  assert.match(pixelStyles, /\.pixel-skin-preview-stage__screen \{[^}]*position: absolute;[^}]*z-index: 2;/);

  // Pixel thumbnail containment
  assert.match(pixelStyles, /\.border-skin-preview--pixel img \{[^}]*object-fit: contain;/);
  assert.match(settings, /slot = "detailed_idle"/);
  assert.match(settings, /readAsset\(id, slot\)/);
  assert.match(settings, /pixelSkinAssetFilename\(theme, "detailed", "idle"\)/);
  assert.doesNotMatch(pixelStyles, /sakura-frame\.png/);
});

test("application skin selection reaches the app root with previews", async () => {
  const [settings, app, styles] = await Promise.all([
    readFile(settingsPanelPath, "utf8"),
    readFile(new URL("../src/renderer/src/App.tsx", import.meta.url), "utf8"),
    readFile(appSkinsPath, "utf8")
  ]);
  assert.match(settings, /onChange=\{\(appSkin\) => void onChange\(\{ appSkin \}\)\}/);
  assert.match(app, /data-app-skin=\{settings\.appSkin\}/);
  for (const skin of ["classic", "atelier", "signal", "greenhouse", "midnight"]) {
    assert.match(settings, new RegExp(`\\["${skin}", "appSkin`));
    assert.ok(styles.includes(`data-preview-skin="${skin}"`));
  }
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

test("keyboard settings have their own section with independent HOME and rename mouse capture", async () => {
  const settings = await readFile(settingsPanelPath, "utf8");
  assert.doesNotMatch(settings, /<SettingGroup label=\{t\(locale, "keyboardShortcuts"\)\}>/);
  assert.match(settings, /section === "keyboardShortcuts"/);
  assert.match(settings, /home: "homeShortcut", renameWindow: "renameWindow"/);
  assert.match(settings, /\["keyboardCanvas", \["home", "renameWindow"/);
  assert.match(settings, /capturePointerShortcut\(action, event\)/);
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
  assert.match(minimap, /startCamera: camera\.get\(\)/);
  assert.doesNotMatch(minimap, /state\?\.pointerId === event\.pointerId && !state\.moved/);
  assert.match(minimap, /\} else \{\s*dragState\.current = null;\s*navigate\(event\.clientX, event\.clientY\);\s*\}/);
  assert.match(minimap, /interactionMode === "drag"/);
  assert.match(minimap, /data-interaction-mode=\{interactionMode\}/);
  assert.match(minimap, /onCameraChange\(\{/);
});

test("General keeps independent persistence controls", async () => {
  const settings = await readFile(settingsPanelPath, "utf8");
  assert.match(settings, /value=\{settings\.sessionRestoreMode\}/);
  assert.match(settings, /\["off", t\(locale, "doNotSave"\)\],\s*\["reopen", t\(locale, "sessionRestoreReopen"\)\],\s*\["continue", t\(locale, "sessionRestoreContinue"\)\]/);
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
  assert.match(workspace, /canvasLayerIsOccluded\(browserLayerId, layerOrder, boundsByLayer\)/);
  assert.match(workspace, /!browserOccluded/);
  // The HUD is a sibling of the transformed scene, so it needs its own screen-space term.
  assert.match(workspace, /canvasScreenRect\(renderedBrowserCanvas, current\)/);
  assert.match(workspace, /!browserUnderOverlay/);
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

test("the handoff dialog ships its focus-visible field styles", async () => {
  const styles = await readFile(appStylesPath, "utf8");
  assert.match(styles, /\.handoff-dialog__form textarea:focus-visible/);
  assert.match(styles, /\.handoff-dialog__actions button:focus-visible/);
});
