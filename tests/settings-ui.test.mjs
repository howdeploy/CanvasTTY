import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspacePath = new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url);
const regionCardPath = new URL("../src/renderer/src/features/workspace/CanvasRegionCard.tsx", import.meta.url);
const noteCardPath = new URL("../src/renderer/src/features/notes/StickyNoteCard.tsx", import.meta.url);

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

test("sticky note close is wired to deletion", async () => {
  const [workspace, noteCard] = await Promise.all([
    readFile(workspacePath, "utf8"),
    readFile(noteCardPath, "utf8")
  ]);
  assert.match(workspace, /onClose=\{onDeleteStickyNote\}/);
  assert.match(noteCard, /className="sticky-note-card__close"/);
  assert.match(noteCard, /onClose\(note\.id\)/);
  assert.match(noteCard, /aria-label=\{t\(locale, "close"\)\}/);
});

test("canvas activation raises a layer and keeps Browser occlusion screen-aware", async () => {
  const workspace = await readFile(workspacePath, "utf8");
  assert.match(workspace, /closest<HTMLElement>\("\[data-canvas-layer-id\]"\)/);
  assert.match(workspace, /raiseLayer\(layerId\)/);
  assert.match(workspace, /canvasLayerIsOccluded\(browserLayerId, layerOrder, boundsByLayer\)/);
  assert.match(workspace, /!browserOccluded/);
  assert.match(workspace, /canvasScreenRect\(renderedBrowserCanvas, current\)/);
  assert.match(workspace, /!browserUnderOverlay/);
});

test("region members preview with the region and commit bounds only on release", async () => {
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
