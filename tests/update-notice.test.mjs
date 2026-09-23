import assert from "node:assert/strict";
import test from "node:test";
import { updateNoticeAction, updateNoticeForStatus, updateNoticeKey } from "../src/renderer/src/lib/updateNotice.ts";

test("available and ready updates remain visible until the version is dismissed", () => {
  const available = { type: "available", version: "1.6.0", notes: "Changes" };
  const ready = { type: "ready", version: "1.6.0" };
  assert.deepEqual(updateNoticeForStatus(available, null), available);
  assert.deepEqual(updateNoticeForStatus(ready, null), ready);
  assert.equal(updateNoticeForStatus(available, updateNoticeKey(available)), null);
  assert.deepEqual(updateNoticeForStatus(ready, updateNoticeKey(available)), ready);
  assert.equal(updateNoticeForStatus(ready, updateNoticeKey(ready)), null);
  assert.deepEqual(updateNoticeForStatus({ type: "available", version: "1.7.0" }, updateNoticeKey(available)), { type: "available", version: "1.7.0" });
});

test("notice offers download, manual release, then installation", () => {
  assert.equal(updateNoticeAction({ type: "available", version: "1.6.0" }), "download");
  assert.equal(updateNoticeAction({ type: "available", version: "1.6.0", manualUrl: "https://example.invalid" }), "manual");
  assert.equal(updateNoticeAction({ type: "downloading", percent: 35 }), null);
  assert.equal(updateNoticeAction({ type: "ready", version: "1.6.0" }), "install");
  assert.deepEqual(updateNoticeForStatus({ type: "downloading", percent: 35 }, null), { type: "downloading", percent: 35 });
});

test("inactive and terminal states do not show an update notice", () => {
  for (const status of [
    { type: "idle" }, { type: "checking" },
    { type: "installing" }, { type: "upToDate" }, { type: "error", message: "offline" }
  ]) {
    assert.equal(updateNoticeForStatus(status, null), null);
  }
});
