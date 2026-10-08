import assert from "node:assert/strict";
import test from "node:test";
import { acceptLoopSignal } from "../src/main/services/AssistantLoopSignal.ts";

function deps(record, overrides = {}) {
  const consumed = [], marked = [];
  return {
    consumed, marked,
    installRecord: (id) => id === "canvastty-assistant" ? record : null,
    session: () => ({ provider: "codex", exitCode: null, status: "working", role: "subagent" }),
    turnEpoch: () => 3,
    consumeEvidence: (id, evidence, epoch) => { consumed.push([id, evidence, epoch]); return evidence === "valid"; },
    markLoopDetected: (id) => { marked.push(id); return true; },
    ...overrides
  };
}
const signal = { sessionId: "worker", evidenceId: "valid", kind: "no-file-progress", reason: "steady\u0007" };
const official = { sourceUrl: "https://github.com/BIackFIame/canvastty-plugin-assistant.git", enabled: true, nativeCodeTrusted: true };

test("loop.detected is accepted from the installed Assistant and strips its single-use evidence", () => {
  const d = deps(official);
  const accepted = acceptLoopSignal(d, "canvastty-assistant", "assistant", signal, (text) => text);
  assert.equal(accepted.sessionId, "worker");
  assert.equal(accepted.label, "No observed file progress");
  assert.equal(accepted.reason, "steady");
  assert.equal("evidenceId" in accepted.data, false);
  assert.deepEqual(d.marked, ["worker"]);
});

test("a plugin that only declares the Assistant id cannot mark a session as looping", () => {
  for (const record of [
    { ...official, sourceUrl: "https://github.com/someone/canvastty-plugin-assistant.git" },
    { ...official, sourceUrl: "https://github.com/BIackFIame/canvastty-plugin-other.git" },
    { ...official, enabled: false },
    { ...official, nativeCodeTrusted: false },
    null
  ]) {
    const d = deps(record);
    assert.equal(acceptLoopSignal(d, "canvastty-assistant", "assistant", signal, (text) => text), null, JSON.stringify(record));
    assert.deepEqual(d.consumed, [], "an unverified sender never spends host evidence");
    assert.deepEqual(d.marked, []);
  }
  const d = deps(official);
  assert.equal(acceptLoopSignal(d, "canvastty-assistant", "other-service", signal, (text) => text), null);
  assert.equal(acceptLoopSignal(d, "another-plugin", "assistant", signal, (text) => text), null);
  assert.equal(acceptLoopSignal(d, "canvastty-assistant", "assistant", { ...signal, evidenceId: "forged" }, (text) => text), null);
  assert.deepEqual(d.marked, []);
});
