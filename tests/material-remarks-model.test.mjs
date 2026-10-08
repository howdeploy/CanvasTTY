import assert from "node:assert/strict";
import test from "node:test";
import {
  anchorPercentages,
  containedRect,
  dragAnchor,
  POINT_DRAG_THRESHOLD,
  referenceCounts,
  remarkAnchorKey,
  remarkAnchorLabel,
  remarkDraftWithoutLostMaterials,
  remarksByMaterial,
  remarkStatusClass
} from "../src/renderer/src/features/materials/materialRemarksModel.ts";
import { remarkDrawable, remarkPickable } from "../src/renderer/src/features/materials/materialCardModel.ts";
import { normalizeAnchor } from "../src/main/services/materials/materialState.ts";

test("an image sits letterboxed inside its box, and a drag inside it becomes a clamped share of the picture", () => {
  const rect = containedRect({ width: 400, height: 300 }, { width: 1600, height: 900 });
  assert.deepEqual(rect, { left: 0, top: 37.5, width: 400, height: 225 });
  assert.deepEqual(containedRect({ width: 400, height: 300 }, null), { left: 0, top: 0, width: 400, height: 300 });
  assert.deepEqual(dragAnchor({ x: 100, y: 93.75 }, { x: 300, y: 500 }, rect), { kind: "region", x: 0.25, y: 0.25, width: 0.5, height: 0.75 });
  assert.deepEqual(dragAnchor({ x: 200, y: 150 }, { x: 200 + POINT_DRAG_THRESHOLD - 1, y: 150 }, rect), { kind: "point", x: 0.5, y: 0.5 });
  assert.equal(dragAnchor({ x: -50, y: 20 }, { x: -10, y: 280 }, rect), null);
  assert.deepEqual(anchorPercentages({ kind: "region", x: 0.25, y: 0.1, width: 0.5, height: 0.333333 }), { left: "25%", top: "10%", width: "50%", height: "33.3333%" });
  assert.equal(anchorPercentages({ kind: "lines", start: 1, end: 2 }), null);
});

test("edge regions pass storage validation", () => {
  const rect = { left: 0, top: 0, width: 320, height: 320 };
  for (const [start, end] of [
    [{ x: 10, y: 10 }, { x: 320, y: 180 }],
    [{ x: 10, y: 10 }, { x: 180, y: 320 }],
    [{ x: 320, y: 320 }, { x: 10, y: 10 }]
  ]) {
    const anchor = dragAnchor(start, end, rect);
    assert.equal(anchor.kind, "region");
    assert.deepEqual(normalizeAnchor(anchor), anchor);
  }
});

test("remarks are grouped per material in their numbered order", () => {
  const remark = (number, materialId) => ({ id: `r${number}`, number, target: { materialId, versionId: "v", anchor: { kind: "whole" } } });
  const grouped = remarksByMaterial([remark(3, "a"), remark(1, "b"), remark(2, "a")]);
  assert.deepEqual([...grouped.keys()], ["b", "a"]);
  assert.deepEqual(grouped.get("a").map((item) => item.number), [2, 3]);
  assert.equal(grouped.get("missing"), undefined);
  const referring = (number, materialId, referenceId) => ({ ...remark(number, materialId), reference: { materialId: referenceId, versionId: "v", anchor: { kind: "whole" } } });
  assert.deepEqual([...referenceCounts([referring(1, "a", "b"), referring(2, "c", "b"), referring(3, "a", "a"), remark(4, "b")])], [["b", 2]]);
});

test("remark anchors read the same in the editor for every kind, and every status has its colour class", () => {
  assert.deepEqual([
    { kind: "lines", start: 3, end: 3 },
    { kind: "lines", start: 3, end: 5 },
    { kind: "page", page: 2 },
    { kind: "time", start: 62, end: null },
    { kind: "time", start: 62, end: 75.5 },
    { kind: "region", x: 0, y: 0, width: 1, height: 1 },
    { kind: "point", x: 0, y: 0 },
    { kind: "whole" }
  ].map((anchor) => remarkAnchorLabel(anchor, "en")), [
    "Remark on lines 3", "Remark on lines 3–5", "Remark on page 2", "Remark on the time 1:02", "Remark on the time 1:02–1:15.5",
    "Remark on an area", "Remark on a point", "Remark on the whole file"
  ]);
  assert.equal(remarkStatusClass("sent"), "material-remark-status material-remark-status--sent");
});

test("remarks are placed on ready image and file materials, and references can be picked on the same kinds", () => {
  const material = (kind, overrides = {}) => ({ kind, state: "ready", ...overrides });
  assert.deepEqual(["image", "text", "video", "audio", "pdf", "file"].map((kind) => remarkDrawable(material(kind))), [true, false, false, false, false, true]);
  assert.equal(remarkDrawable(material("image", { state: "missing" })), false);
  assert.equal(remarkPickable(material("image")), true);
  assert.equal(remarkPickable(material("file")), true);
  assert.equal(remarkPickable(material("pdf")), false);
});

test("an anchor key is stable across equal objects and changes with the anchor", () => {
  const first = { kind: "region", x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
  const same = { kind: "region", x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
  assert.equal(remarkAnchorKey(first), remarkAnchorKey(same));
  assert.notEqual(remarkAnchorKey(first), remarkAnchorKey({ kind: "whole" }));
  assert.notEqual(remarkAnchorKey(first), remarkAnchorKey({ ...first, x: 0.5 }));
});

test("a draft loses its reference with the referenced material and dies with its own", () => {
  const draft = {
    materialId: "m-1",
    anchor: { kind: "whole" },
    reference: { materialId: "m-2", anchor: { kind: "point", x: 0.1, y: 0.2 } },
    picking: true
  };
  const both = new Set(["m-1", "m-2"]);
  assert.equal(remarkDraftWithoutLostMaterials(draft, both), draft);
  const withoutReference = remarkDraftWithoutLostMaterials(draft, new Set(["m-1"]));
  assert.deepEqual(withoutReference, { ...draft, reference: null, picking: false });
  assert.equal(remarkDraftWithoutLostMaterials(draft, new Set(["m-2"])), null);
});

test("a perfectly straight drag still lands as a point instead of nothing", () => {
  const rect = { left: 0, top: 0, width: 400, height: 300 };
  const horizontal = dragAnchor({ x: 40, y: 150 }, { x: 340, y: 150 }, rect);
  const vertical = dragAnchor({ x: 200, y: 30 }, { x: 200, y: 270 }, rect);
  assert.deepEqual(horizontal, { kind: "point", x: 0.1, y: 0.5 });
  assert.deepEqual(vertical, { kind: "point", x: 0.5, y: 0.1 });
});

test("deleting a remark asks first, and a failed delete is reported", async () => {
  const { readFile } = await import("node:fs/promises");
  const panel = await readFile(new URL("../src/renderer/src/features/materials/RemarkPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /remarkDeleteConfirm/);
  assert.match(panel, /setConfirmingDelete\(true\)/);
  const app = await readFile(new URL("../src/renderer/src/App.tsx", import.meta.url), "utf8");
  const del = app.indexOf('action === "delete"');
  assert.match(app.slice(del, del + 220), /catch\(\(\) => showToast/);
});
