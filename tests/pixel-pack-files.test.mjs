import assert from "node:assert/strict";
import test from "node:test";
import { pixelPackSlotForFilename } from "../src/renderer/src/features/settings/pixelPackFiles.ts";

test("bulk PNG import maps standard and legacy filenames to ten slots", () => {
  assert.equal(pixelPackSlotForFilename("Sakura L1 Idle.PNG"), "minimal_idle");
  assert.equal(pixelPackSlotForFilename("matrix_l2_working.png"), "detailed_working");
  assert.equal(pixelPackSlotForFilename("forest_cabin_master_done.png"), "master_completed");
  assert.equal(pixelPackSlotForFilename("cat-minimal-complete.png"), "minimal_completed");
  assert.equal(pixelPackSlotForFilename("sakura_background.png"), "background");
  assert.equal(pixelPackSlotForFilename("background.png"), "background");
  assert.equal(pixelPackSlotForFilename("reference.png"), null);
});

test("live media filenames map to the same slots as legacy PNGs", () => {
  assert.equal(pixelPackSlotForFilename("minimal_working.apng"), "minimal_working");
  assert.equal(pixelPackSlotForFilename("detailed_idle.webp"), "detailed_idle");
  assert.equal(pixelPackSlotForFilename("background.MP4"), "background");
  assert.equal(pixelPackSlotForFilename("background.webm"), "background");
});
