import assert from "node:assert/strict";
import test from "node:test";
import { LimitsService } from "../src/main/services/LimitsService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";

function unavailable(provider) {
  const checked = [{ path: `/missing/${provider}`, result: "missing" }];
  return Object.freeze({
    state: "unavailable",
    provider,
    reason: "cli-not-found",
    checked,
    diagnostic: `${provider} CLI was not found.\nChecked paths:\n  - /missing/${provider}: missing`
  });
}

function unavailableRegistry() {
  return {
    get: unavailable,
    snapshot() {
      return Object.fromEntries(
        ["codex", "claude", "kimi", "opencode", "hermes", "grok"].map((provider) => [provider, unavailable(provider)])
      );
    }
  };
}

test("missing provider creates a failed session without PTY or browser configuration", () => {
  let browserPrepareCalls = 0;
  const events = [];
  const manager = new TerminalManager(
    (channel, payload) => events.push({ channel, payload }),
    unavailableRegistry(),
    {
      prepareLaunch() {
        browserPrepareCalls += 1;
        throw new Error("Browser configuration must not be touched for a missing CLI.");
      }
    }
  );

  const session = manager.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 10, y: 20 }
  });

  assert.equal(session.status, "failed");
  assert.equal(session.exitCode, 127);
  assert.match(session.failureDetails, /\/missing\/codex: missing/u);
  assert.equal(session.buffer, "");
  assert.equal(browserPrepareCalls, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.session.failureDetails, session.failureDetails);
  manager.disposeAll();
});

test("limits short-circuit every missing provider to cli-not-found", async () => {
  const service = new LimitsService(unavailableRegistry(), "test");
  try {
    const snapshot = await service.get();
    assert.deepEqual(
      snapshot.providers.map(({ provider, state, reason }) => ({ provider, state, reason })),
      ["codex", "claude", "kimi", "opencode", "grok"].map((provider) => ({
        provider,
        state: "unavailable",
        reason: "cli-not-found"
      }))
    );
  } finally {
    service.dispose();
  }
});
