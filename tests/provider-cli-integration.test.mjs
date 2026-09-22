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
        ["codex", "claude", "qwen", "kimi", "opencode", "hermes", "grok"].map((provider) => [provider, unavailable(provider)])
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
      ["codex", "claude", "qwen", "kimi", "opencode", "grok"].map((provider) => ({
        provider,
        state: "unavailable",
        reason: "cli-not-found"
      }))
    );
  } finally {
    service.dispose();
  }
});

test("limit cache is invalidated after CLI recheck and installed Qwen stays protocol-unavailable", async () => {
  let qwenInstalled = false;
  const registry = {
    get(provider) {
      if (provider === "qwen" && qwenInstalled) {
        return { state: "available", provider, executable: "/tools/qwen", launcher: "native", environment: {}, checked: [] };
      }
      return unavailable(provider);
    }
  };
  const service = new LimitsService(registry, "test");
  try {
    const first = await service.get();
    assert.equal(first.providers.find((entry) => entry.provider === "qwen").reason, "cli-not-found");
    qwenInstalled = true;
    await service.providerClisRefreshed();
    const second = await service.get();
    assert.equal(second.providers.find((entry) => entry.provider === "qwen").reason, "unsupported-protocol");
  } finally {
    service.dispose();
  }
});

test("installed Qwen reports its real provider-neutral quota limitation", async () => {
  const registry = unavailableRegistry();
  const service = new LimitsService({
    get(provider) {
      if (provider !== "qwen") return registry.get(provider);
      return Object.freeze({
        state: "available",
        provider,
        executable: "/resolved/qwen",
        launcher: "native",
        environment: Object.freeze({ PATH: "/resolved:/usr/bin" }),
        checked: Object.freeze([{ path: "/resolved/qwen", result: "selected" }])
      });
    },
    snapshot: registry.snapshot
  }, "test");
  try {
    const qwen = (await service.get()).providers.find((provider) => provider.provider === "qwen");
    assert.ok(qwen);
    assert.deepEqual(qwen, {
      provider: "qwen",
      state: "unavailable",
      source: "qwen-cli",
      reason: "unsupported-protocol",
      checkedAt: qwen.checkedAt
    });
  } finally {
    service.dispose();
  }
});
