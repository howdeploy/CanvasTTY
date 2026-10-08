import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptMaterialsSnapshot,
  EMPTY_MATERIALS_SNAPSHOT,
  withPendingBounds
} from "../src/renderer/src/features/materials/materialSnapshot.ts";
import {
  addResultNeedsNotice,
  formatBytes,
  latestVersionNumber,
  materialFailureKey,
  materialFolder,
  materialRejectionKey,
  materialRemovalLosesData,
  materialSubtitle
} from "../src/renderer/src/features/materials/materialCardModel.ts";

const bounds = (x, y, width = 300, height = 200) => ({ position: { x, y }, size: { width, height } });

function material(id, x, y, overrides = {}) {
  return { id, ...bounds(x, y), location: `/work/${id}.png`, versions: [], ...overrides };
}

test("a late snapshot never replaces a newer one", () => {
  const newer = { ...EMPTY_MATERIALS_SNAPSHOT, revision: 5 };
  const older = { ...EMPTY_MATERIALS_SNAPSHOT, revision: 4 };
  assert.equal(acceptMaterialsSnapshot(newer, older), newer);
  assert.equal(acceptMaterialsSnapshot(older, newer), newer);
});

test("a group drag keeps every moved card in place until main echoes its bounds", () => {
  const pending = new Map([["a", bounds(50, 50)], ["b", bounds(60, 60)]]);
  const echoedFirst = [material("a", 50, 50), material("b", 0, 0)];
  const shown = withPendingBounds(echoedFirst, pending);
  assert.deepEqual(shown.map((entry) => entry.position), [{ x: 50, y: 50 }, { x: 60, y: 60 }]);
  assert.deepEqual([...pending.keys()], ["b"]);
  withPendingBounds([material("a", 50, 50), material("b", 60, 60)], pending);
  assert.equal(pending.size, 0);
});

test("pending bounds of a removed card are dropped", () => {
  const pending = new Map([["gone", bounds(1, 1)]]);
  assert.deepEqual(withPendingBounds([material("a", 0, 0)], pending).map((entry) => entry.id), ["a"]);
  assert.equal(pending.size, 0);
});

test("an accepted snapshot keeps the bounds objects of unmoved cards", () => {
  const current = { ...EMPTY_MATERIALS_SNAPSHOT, revision: 1, materials: [material("a", 10, 10), material("b", 20, 20)] };
  const moved = material("b", 30, 30);
  const accepted = acceptMaterialsSnapshot(current, {
    ...EMPTY_MATERIALS_SNAPSHOT,
    revision: 2,
    materials: [material("a", 10, 10), moved]
  });
  assert.equal(accepted.materials[0].position, current.materials[0].position);
  assert.equal(accepted.materials[0].size, current.materials[0].size);
  assert.equal(accepted.materials[1].position, moved.position);
});

test("byte sizes and folders are formatted for the card", () => {
  assert.equal(formatBytes(512, "en"), "512 B");
  assert.equal(formatBytes(1536, "en"), "1.5 KB");
  assert.equal(formatBytes(1536, "ru"), "1,5 КБ");
  assert.equal(formatBytes(25 * 1024 * 1024, "en"), "25 MB");
  assert.equal(formatBytes(null, "en"), "");
  assert.equal(materialFolder("/work/site/hero.png"), "/work/site");
  assert.equal(materialFolder("C:\\work\\hero.png"), "C:\\work");
  assert.equal(materialFolder(null), null);
});

test("removal asks first only when CanvasTTY holds data the file on disk does not", () => {
  assert.equal(materialRemovalLosesData(material("a", 0, 0)), false);
  assert.equal(materialRemovalLosesData(material("a", 0, 0, { versions: [{ id: "v" }] })), true);
  assert.equal(materialRemovalLosesData(material("a", 0, 0, { location: null })), true);
});

test("failures and rejections map to explained messages; cancelling says nothing", () => {
  assert.equal(materialFailureKey("quota"), "materialFailureQuota");
  assert.equal(materialFailureKey("kind-mismatch"), "materialFailureKindMismatch");
  assert.equal(materialFailureKey("cancelled"), null);
  assert.equal(materialRejectionKey("not-a-file"), "materialsNotAFile");
  assert.equal(materialRejectionKey("empty-clipboard"), "materialsEmptyClipboard");
  assert.equal(addResultNeedsNotice({ added: ["a"], existing: [], rejected: [] }), false);
  assert.equal(addResultNeedsNotice({ added: [], existing: ["a"], rejected: [] }), true);
  assert.equal(addResultNeedsNotice({ added: ["a"], existing: [], rejected: [{ name: "x", reason: "limit" }] }), true);
});

test("the latest version number is shown on the card badge", () => {
  assert.equal(latestVersionNumber(material("a", 0, 0)), null);
  assert.equal(latestVersionNumber(material("a", 0, 0, { versions: [{ id: "v1", number: 1, current: true }] })), 1);
  assert.equal(latestVersionNumber(material("a", 0, 0, { versions: [{ id: "v1", number: 1, current: true }, { id: "v2", number: 2, current: false }] })), 2);
});

test("the card subtitle names the origin or falls back to the folder", () => {
  const base = { id: "m", position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, versions: [], location: "/work/site/hero.png" };
  assert.equal(materialSubtitle({ ...base, origin: null }, "en"), "/work/site");
  assert.equal(materialSubtitle({ ...base, location: null, origin: null }, "en"), "");
  assert.equal(materialSubtitle({ ...base, origin: { kind: "clipboard" } }, "ru"), "Из буфера обмена");
  assert.equal(materialSubtitle({ ...base, origin: { kind: "browser", url: "example.com/page" } }, "en"), "example.com/page");
});
