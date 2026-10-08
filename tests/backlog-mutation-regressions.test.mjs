import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OrchestrationBudgetService } from "../src/main/services/OrchestrationBudgetService.ts";
import { SecretGrantService } from "../src/main/services/SecretGrantService.ts";

const directory = () => mkdtemp(join(tmpdir(), "canvastty-backlog-mutation-"));
const secretInput = { secretId: "OPENAI_API_KEY", method: "GET", path: "models" };

function secretService(overrides = {}) {
  return new SecretGrantService({
    getSecret: async () => "mutation-test-key",
    getSession: (sessionId) => sessionId === "agent"
      ? { provider: "codex", cwd: "/project", profile: "normal", active: true }
      : null,
    execute: async () => ({ status: 200, body: "ok", truncated: false }),
    ...overrides
  });
}

test("an 80% token budget warns once without pausing before the hard limit", async () => {
  const dir = await directory();
  let budget;
  try {
    const warnings = [];
    budget = new OrchestrationBudgetService(join(dir, "budget.json"), {
      onWarning: (snapshot) => warnings.push(snapshot.rootSessionId)
    });
    await budget.load();
    await budget.setLimits("root", { tokens: 100, costUsd: null, durationMs: null });
    const warning = budget.recordUsage("root", { tokens: 80, costUsd: null });
    assert.equal(warning.warning, true);
    assert.equal(warning.paused, false);
    budget.recordUsage("root", { tokens: 90, costUsd: null });
    assert.deepEqual(warnings, ["root"], "the warning fires once per budget crossing");
  } finally {
    await budget?.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

test("revoking a grant while its secret lookup is pending prevents API request execution", async () => {
  let finishSecret;
  let secretReadStarted;
  const secretStarted = new Promise((resolve) => { secretReadStarted = resolve; });
  const secretValue = new Promise((resolve) => { finishSecret = resolve; });
  let executions = 0;
  const service = secretService({
    getSecret: () => { secretReadStarted(); return secretValue; },
    execute: async () => { executions++; return { status: 200, body: "ok", truncated: false }; }
  });
  const request = service.requestSecret("agent", "OPENAI_API_KEY", "Use the provider key for one request.");
  service.approve(request.id, "session");
  const run = service.runSecretRequest("agent", secretInput);
  await secretStarted;
  service.revoke("agent", "OPENAI_API_KEY");
  finishSecret("mutation-test-key");
  await assert.rejects(run, /revoked or expired/u);
  assert.equal(executions, 0, "the approved command must not start after revocation");
});

test("expiry discovered while a secret API request is active aborts that request", async () => {
  let now = 1_000;
  let commandStarted;
  const started = new Promise((resolve) => { commandStarted = resolve; });
  const service = new SecretGrantService({
    getSecret: async () => "mutation-test-key",
    getSession: (sessionId) => sessionId === "agent"
      ? { provider: "codex", cwd: "/project", profile: "normal", active: true }
      : null,
    execute: ({ signal }) => new Promise((_resolve, reject) => {
      commandStarted();
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    now: () => now
  });
  const request = service.requestSecret("agent", "OPENAI_API_KEY", "Use the provider key for one request.");
  const grant = service.approve(request.id, "10m");
  const run = service.runSecretRequest("agent", { ...secretInput, timeoutMs: 1_000 });
  await started;
  now = grant.expiresAt;
  assert.deepEqual(service.listGrants(), [], "listing grants prunes the newly expired entry");
  await assert.rejects(run, /Provider API request was canceled/u);
});
