import assert from "node:assert/strict";
import test from "node:test";
import {
  fileCardToRootReference,
  isFileRootUsable
} from "../src/renderer/src/features/files/fileCardRestore.ts";

test("maps a persisted session card to a session root reference", () => {
  assert.deepEqual(
    fileCardToRootReference({ root: { rootType: "session", sessionId: "session-1" }, folderPath: null }),
    { rootType: "session", sessionId: "session-1" }
  );
});

test("maps a folder card to a folder reference and prefers the persisted folder path", () => {
  assert.deepEqual(
    fileCardToRootReference({ root: { rootType: "folder" }, folderPath: "/tmp/canvastty-project" }),
    { rootType: "folder", folderPath: "/tmp/canvastty-project" }
  );
  // Falls back to a path embedded in the root reference when the card field is empty.
  assert.deepEqual(
    fileCardToRootReference({ root: { rootType: "folder", folderPath: "/tmp/notes" }, folderPath: null }),
    { rootType: "folder", folderPath: "/tmp/notes" }
  );
});

test("a folder card that never picked a folder has no restorable root", () => {
  assert.equal(fileCardToRootReference({ root: { rootType: "folder" }, folderPath: null }), null);
  assert.equal(
    fileCardToRootReference({ root: { rootType: "folder", folderPath: null }, folderPath: null }),
    null
  );
});

test("only a non-null, explicitly available descriptor is usable", () => {
  assert.equal(isFileRootUsable(null), false);
  assert.equal(
    isFileRootUsable({ rootId: "r", label: "root", available: false, rootType: "folder" }),
    false
  );
  assert.equal(
    isFileRootUsable({ rootId: "r", label: "root", available: true, rootType: "folder" }),
    true
  );
  assert.equal(
    isFileRootUsable({ rootId: "r", label: "root", available: true, rootType: "session" }),
    true
  );
});
