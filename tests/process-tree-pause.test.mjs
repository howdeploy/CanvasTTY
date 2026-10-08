import assert from "node:assert/strict";
import test from "node:test";
import { ProcessTreePause } from "../src/main/services/ProcessTreePause.ts";

test("process-group pause signals only the host-owned PTY group and is idempotent", () => {
  const signals = [];
  const controller = new ProcessTreePause("linux", (groupId, signal) => signals.push([groupId, signal]));
  const first = { pid: 8451 };
  const second = { pid: 9120 };

  assert.deepEqual(controller.pause(first), { supported: true });
  assert.deepEqual(controller.pause(first), { supported: true });
  assert.deepEqual(controller.resume(second), { supported: true });
  assert.deepEqual(controller.resume(first), { supported: true });
  assert.deepEqual(signals, [[8451, "SIGSTOP"], [8451, "SIGCONT"]]);
});

test("process-group pause reports Windows as unsupported without signaling a pid", () => {
  let signaled = false;
  const controller = new ProcessTreePause("win32", () => { signaled = true; });
  const result = controller.pause({ pid: 8451 });
  assert.equal(result.supported, false);
  assert.match(result.failed, /Windows cannot safely suspend/u);
  assert.deepEqual(controller.resume({ pid: 8451 }), { supported: true }, "an unsupported platform has no stopped group to resume");
  assert.equal(signaled, false);
});

test("process-group pause reports operational failures and treats an exited process as complete", () => {
  const controller = new ProcessTreePause("linux", (_groupId, signal) => {
    if (signal === "SIGSTOP") throw Object.assign(new Error("gone"), { code: "ESRCH" });
    throw Object.assign(new Error("denied"), { code: "EPERM" });
  });
  assert.deepEqual(controller.pause({ pid: 8451 }), { supported: true });

  const failing = new ProcessTreePause("linux", () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  assert.deepEqual(failing.pause({ pid: 8452 }), {
    supported: true,
    failed: "Could not suspend the owned PTY process group (EPERM)."
  });
});

test("a failed resume retains ownership so cleanup or a later budget clear can retry", () => {
  let denyResume = true;
  const controller = new ProcessTreePause("linux", (_groupId, signal) => {
    if (signal === "SIGCONT" && denyResume) throw Object.assign(new Error("denied"), { code: "EPERM" });
  });
  const process = { pid: 8453 };
  assert.deepEqual(controller.pause(process), { supported: true });
  assert.deepEqual(controller.resume(process), {
    supported: true,
    failed: "Could not resume the owned PTY process group (EPERM)."
  });
  assert.equal(controller.isPaused(process), true);
  denyResume = false;
  assert.deepEqual(controller.resume(process), { supported: true });
  assert.equal(controller.isPaused(process), false);
});
