import assert from "node:assert/strict";
import test from "node:test";
import {
  constrainMaterialResize,
  MATERIAL_MAX_SIZE,
  MATERIAL_MIN_SIZE,
  materialCardSize,
  materialsAtPoint,
  materialType,
  materialUrl
} from "../src/shared/materials.ts";

test("file names map to an image or a plain file", () => {
  assert.deepEqual(materialType("Hero.PNG"), { kind: "image", mimeType: "image/png" });
  assert.deepEqual(materialType("clip.mov"), { kind: "file", mimeType: "application/octet-stream" });
  assert.deepEqual(materialType("voice.m4a"), { kind: "file", mimeType: "application/octet-stream" });
  assert.deepEqual(materialType("README.md"), { kind: "file", mimeType: "application/octet-stream" });
  assert.deepEqual(materialType("App.tsx"), { kind: "file", mimeType: "application/octet-stream" });
  assert.deepEqual(materialType("brief.pdf"), { kind: "file", mimeType: "application/octet-stream" });
  assert.deepEqual(materialType("archive.zip"), { kind: "file", mimeType: "application/octet-stream" });
  assert.deepEqual(materialType(".env"), { kind: "file", mimeType: "application/octet-stream" });
  assert.deepEqual(materialType("Makefile"), { kind: "file", mimeType: "application/octet-stream" });
});

test("material URLs name the live file with its revision or one pinned version", () => {
  assert.equal(materialUrl("a1", null, 3), "canvastty-material://a1/live?r=3");
  assert.equal(materialUrl("a1", "v-2"), "canvastty-material://a1/v/v-2");
});

test("image cards keep the picture's proportions inside the default box plus the header", () => {
  assert.deepEqual(materialCardSize("image", { width: 1920, height: 1080 }), { width: 440, height: 302 });
  assert.deepEqual(materialCardSize("image", { width: 300, height: 200 }), { width: 300, height: 254 });
  assert.deepEqual(materialCardSize("image", { width: 20, height: 4000 }), { width: MATERIAL_MIN_SIZE.width, height: 494 });
  assert.deepEqual(materialCardSize("image", null), { width: 420, height: 320 });
  assert.deepEqual(materialCardSize("audio", { width: 1, height: 1 }), { width: 420, height: 170 });
});

test("several materials are laid out four per row from the drop point", () => {
  const sizes = Array.from({ length: 5 }, (_, index) => ({ width: 100, height: index === 1 ? 120 : 80 }));
  const placed = materialsAtPoint(sizes, { x: 1000, y: 500 });
  assert.equal(placed.length, 5);
  assert.deepEqual(placed[0].position, { x: 1000, y: 500 });
  assert.equal(placed[3].position.x - placed[2].position.x, 124);
  assert.deepEqual(placed[4].position, { x: 1000, y: 500 + 120 + 24 });
  assert.deepEqual(materialsAtPoint([], { x: 0, y: 0 }), []);
});

test("resizing clamps to the material limits and keeps the opposite edge", () => {
  const resized = constrainMaterialResize({ position: { x: 100, y: 100 }, size: { width: 50, height: 60 } }, "nw");
  assert.deepEqual(resized.size, MATERIAL_MIN_SIZE);
  assert.deepEqual(resized.position, { x: 150 - MATERIAL_MIN_SIZE.width, y: 160 - MATERIAL_MIN_SIZE.height });
  const huge = constrainMaterialResize({ position: { x: 0, y: 0 }, size: { width: 9000, height: 9000 } }, "se");
  assert.deepEqual(huge, { position: { x: 0, y: 0 }, size: MATERIAL_MAX_SIZE });
});
