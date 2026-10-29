import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { BUNDLED_CANVAS_BACKGROUND_IDS } from "../src/shared/contracts.ts";

const BUNDLED_THEMES = ["sakura", "matrix", "forest-cabin", "gold-black", "cat", "gothic-eclipse"];

/** Width and height from an AVIF file's `ispe` (image spatial extents) property. */
function avifDimensions(buf) {
  const at = buf.indexOf("ispe", 0, "ascii");
  assert.ok(at > 0, "AVIF must carry an ispe property");
  return { width: buf.readUInt32BE(at + 8), height: buf.readUInt32BE(at + 12) };
}

test("verify bundled theme backgrounds exist as 1536x1024 AVIF", () => {
  const backgroundsDir = path.resolve("src/renderer/src/assets/theme-backgrounds");

  for (const theme of BUNDLED_THEMES) {
    const filePath = path.join(backgroundsDir, `${theme}.avif`);
    assert.ok(fs.existsSync(filePath), `${theme}.avif should exist in repo`);
    assert.equal(fs.existsSync(path.join(backgroundsDir, `${theme}.png`)), false, `${theme}.png should not ship next to the AVIF`);

    const buf = fs.readFileSync(filePath);
    // ISO-BMFF: size, "ftyp", major brand "avif"
    assert.equal(buf.toString("ascii", 4, 12), "ftypavif", `${theme}.avif must be an AVIF file`);
    const { width, height } = avifDimensions(buf);
    assert.equal(width, 1536, `${theme}.avif width should be 1536 (got ${width})`);
    assert.equal(height, 1024, `${theme}.avif height should be 1024 (got ${height})`);
    assert.ok(buf.length < 1_000_000, `${theme}.avif should stay small (${buf.length} bytes)`);
  }
});

test("verify appSkins.css defines rules for all bundled themes", () => {
  const cssPath = path.resolve("src/renderer/src/styles/appSkins.css");
  const css = fs.readFileSync(cssPath, "utf8");

  for (const theme of BUNDLED_THEMES) {
    assert.match(
      css,
      new RegExp(`\\[data-theme-background="${theme}"\\]`),
      `appSkins.css should have rule for [data-theme-background="${theme}"]`
    );
    assert.match(
      css,
      new RegExp(`url\\(["']?\\.\\./assets/theme-backgrounds/${theme}\\.avif["']?\\)`),
      `appSkins.css should reference ../assets/theme-backgrounds/${theme}.avif`
    );
  }

  // Preserve the complete background image without cropping it.
  assert.match(css, /\.workspace\[data-theme-background\]/);
  assert.match(css, /background-size:\s*contain/);
  assert.match(css, /background-position:\s*center/);
  assert.match(css, /background-repeat:\s*no-repeat/);

  // Pattern suppression
  assert.match(css, /\.workspace\[data-theme-background\]::before\s*\{[^}]*display:\s*none\s*!important/);
});

test("verify WorkspaceCanvas.tsx source-level wiring and background theme scoping", () => {
  const tsxPath = path.resolve("src/renderer/src/features/workspace/WorkspaceCanvas.tsx");
  const tsx = fs.readFileSync(tsxPath, "utf8");

  // Verify CANVAS_OVERLAY_PLACEMENTS is defined with CanvasOverlayPlacement type
  assert.match(
    tsx,
    /const\s+CANVAS_OVERLAY_PLACEMENTS:\s*readonly\s+CanvasOverlayPlacement\[\]\s*=/,
    "WorkspaceCanvas.tsx should declare CANVAS_OVERLAY_PLACEMENTS with CanvasOverlayPlacement[]"
  );

  // Check data-theme-background attribute is attached to workspace element
  assert.match(
    tsx,
    /data-theme-background=\{themeBackground \?\? \(packBackground \? "custom" : undefined\)\}/,
    "WorkspaceCanvas.tsx should attach bundled or imported theme background"
  );

  // Background rendering must use its own persisted selection.
  assert.match(
    tsx,
    /BUNDLED_CANVAS_BACKGROUND_IDS[^\n]*\.includes\(settings\.canvasBackground\)/,
    "WorkspaceCanvas.tsx should resolve bundled backgrounds from settings.canvasBackground"
  );
  assert.match(tsx, /isPixelSkinPackId\(settings\.canvasBackground\) \? settings\.canvasBackground : null/);
  assert.deepEqual(
    [...BUNDLED_CANVAS_BACKGROUND_IDS].sort(),
    BUNDLED_THEMES.slice().sort(),
    "BUNDLED_CANVAS_BACKGROUND_IDS must contain exactly the bundled themes"
  );
});
