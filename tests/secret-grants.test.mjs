import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { registerBacklogIpc } from "../src/main/ipc/registerBacklogIpc.ts";
import { SecretGrantService } from "../src/main/services/SecretGrantService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { PROVIDER_SECRET_IDS as CONTRACT_SECRET_IDS } from "../src/shared/contracts.ts";
import { BACKLOG_IPC } from "../src/shared/backlog.ts";
import { PROVIDER_SECRET_IDS as CATALOG_SECRET_IDS, validateOrchestrationArguments } from "../src/agent-browser/orchestration-catalog.mjs";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

function setup(overrides = {}) {
  let now = 1_000;
  let active = true;
  const executions = [];
  const observedExecutionSecrets = [];
  const events = [];
  const secret = "unit-test-secret-7342";
  const service = new SecretGrantService({
    getSecret: async (id) => id === "OPENAI_API_KEY" ? secret : null,
    getSession: (sessionId) => sessionId === "session-a" && active
      ? { provider: "codex", cwd: "/project", profile: "normal", active: true }
      : null,
    getTurnIdentity: () => "fixture-launch:turn-1",
    rememberSecret: (value) => events.push(["remember", value]),
    redact: (value) => value.replaceAll(secret, "[masked]"),
    execute: async (request) => {
      executions.push(request);
      observedExecutionSecrets.push(request.secret);
      return { status: 200, body: `received ${request.secret}`, truncated: false };
    },
    onRequest: (request) => events.push(["request", request]),
    onDecision: (decision) => events.push(["decision", decision]),
    onRevoke: (revoke) => events.push(["revoke", revoke]),
    now: () => now,
    ...overrides
  });
  return {
    service,
    executions,
    observedExecutionSecrets,
    events,
    secret,
    setNow(value) { now = value; },
    endSession() { active = false; }
  };
}

test("secret tool catalog stays aligned with configured provider secret IDs", () => {
  assert.deepEqual([...CATALOG_SECRET_IDS], [...CONTRACT_SECRET_IDS]);
  assert.equal(validateOrchestrationArguments("request_secret", {
    secretId: "OPENAI_API_KEY", reason: "Use the configured key for one API check."
  }).ok, true);
  assert.equal(validateOrchestrationArguments("request_secret", {
    secretId: "HOME", reason: "Read a local system variable."
  }).ok, false);
  assert.equal(validateOrchestrationArguments("run_secret_command", {
    command: "/usr/bin/awk", args: [], secretIds: ["OPENAI_API_KEY"]
  }).ok, false, "cached clients cannot invoke the removed executable tool");
  const api = validateOrchestrationArguments("run_secret_request", {
    secretId: "OPENAI_API_KEY", method: "POST", path: "responses", body: { input: "hello" }
  });
  assert.equal(api.ok, true);
  assert.deepEqual(api.value.body, { input: "hello" }, "the bridge preserves typed JSON bodies");
  assert.equal(validateOrchestrationArguments("run_secret_request", {
    secretId: "OPENAI_API_KEY", method: "POST", path: "responses", headers: { Authorization: "Bearer attacker" }
  }).ok, false);
});

test("only a host-resolved profile using the granted key selects the API origin", async () => {
  let secretReads = 0;
  let resolvedUrl = "";
  const { service } = setup({
    getSecret: async () => { secretReads += 1; return "unit-test-secret-7342"; },
    getApiProfiles: () => [{ id: "team-profile", name: "Team gateway", protocol: "openai-compatible", baseUrl: "https://api.example.com/v1", secretRef: "OPENAI_API_KEY" }],
    execute: async (request) => {
      resolvedUrl = request.apiProfile.baseUrl;
      return { status: 200, body: "ok", truncated: false };
    }
  });
  const pending = service.requestSecret("session-a", "OPENAI_API_KEY", "Use the approved key for one API check.");
  service.approve(pending.id, "session");
  await assert.rejects(service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", apiProfileId: "team-profile", method: "GET", path: "models", baseUrl: "https://attacker.example"
  }), /request is invalid/u);
  assert.equal(secretReads, 0, "invalid caller-supplied origins are rejected before loading the key");
  await service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", apiProfileId: "team-profile", method: "GET", path: "models"
  });
  assert.equal(resolvedUrl, "https://api.example.com/v1");
  assert.equal(secretReads, 1);
});

test("typed provider API requests fail closed until human approval and return no secret material", async () => {
  const { service, executions, observedExecutionSecrets, events, secret } = setup();
  await assert.rejects(service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", method: "GET", path: "models"
  }), /Human approval is required/u);

  const request = service.requestSecret("session-a", "OPENAI_API_KEY", "Use the project API to check a model response.");
  assert.equal(request.secretId, "OPENAI_API_KEY");
  assert.equal("value" in request, false);
  assert.deepEqual(service.pending(["other-session"]), []);
  assert.deepEqual(service.pending(["session-a"]).map(({ id }) => id), [request.id]);
  service.approve(request.id, "turn");
  const result = await service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", method: "GET", path: "models"
  });
  assert.deepEqual(result, { status: 200, body: "received [masked]", truncated: false });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(executions.length, 1);
  assert.deepEqual(observedExecutionSecrets, [secret]);
  assert.equal(executions[0].secret, secret, "only the host executor receives the secret for the fixed helper");
  assert.equal(executions[0].cwd, "/project");
  assert.equal(executions[0].launchProfile, "normal");
  assert.equal(executions[0].apiProfile.baseUrl, "https://api.openai.com/v1");
  assert.equal(executions[0].path, "models");
  assert.equal(events.some(([type]) => type === "remember"), true, "register the key with the redactor before execution");
  assert.equal(service.listGrants()[0].secretId, "OPENAI_API_KEY");
});

test("grant expiry is checked for every run and turn/session end revoke the right scopes", async () => {
  const { service, setNow, events } = setup();
  const short = service.requestSecret("session-a", "OPENAI_API_KEY", "Check current usage.");
  service.approve(short.id, "10m");
  setNow(1_000 + 10 * 60_000);
  assert.equal(service.listGrants().length, 0, "expired grants disappear before an API request triggers its own expiry check");
  await assert.rejects(service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", method: "GET", path: "models"
  }), /Human approval is required/u);

  const turn = service.requestSecret("session-a", "OPENAI_API_KEY", "Use for this turn.");
  service.approve(turn.id, "turn");
  service.turnEnded("session-a");
  assert.equal(service.listGrants().length, 0);
  assert.ok(events.some(([type, event]) => type === "revoke" && event.reason === "turn-ended"));

  const session = service.requestSecret("session-a", "OPENAI_API_KEY", "Use for this session.");
  service.approve(session.id, "session");
  service.turnEnded("session-a");
  assert.equal(service.listGrants().length, 1, "session grant survives turn completion");
  service.sessionEnded("session-a");
  assert.equal(service.listGrants().length, 0);
});

test("completed-turn pending requests retain their original TTL and lose turn authority permanently", () => {
  const { service, setNow, events } = setup({
    getSession: () => ({ provider: "codex", cwd: "/project", profile: "normal", active: true })
  });
  const ended = service.requestSecret("session-a", "OPENAI_API_KEY", "Await human approval.");
  const other = service.requestSecret("session-b", "OPENAI_API_KEY", "Independent request.");
  setNow(ended.expiresAt - 1);
  service.turnEnded("session-a");
  const remaining = service.pending(["session-a"])[0];
  assert.deepEqual(remaining, { ...ended, turnAvailable: false });
  assert.deepEqual(service.pending(["session-b"]), [other], "another session retains its turn option");
  assert.throws(() => service.approve(ended.id, "turn"), /unavailable/u, "even the same reported identity cannot revive an ended request");
  const duplicate = service.requestSecret("session-a", "OPENAI_API_KEY", "Retry the request.");
  assert.deepEqual(duplicate, remaining, "duplicate requests do not refresh TTL or capture a new turn");
  service.turnEnded("session-a");
  assert.deepEqual(service.pending(["session-a"]), [remaining], "repeated idle signals do not refresh TTL");
  assert.equal(events.some(([type, event]) => type === "decision" && event.request.id === ended.id), false,
    "ending the turn is not a human denial or request revocation");
  setNow(ended.expiresAt);
  assert.deepEqual(service.pending(), []);
  assert.throws(() => service.approve(ended.id, "10m"), /expired/u);
  assert.ok(events.some(([type, event]) => type === "decision" && event.request.id === ended.id && event.decision === "expired"));
});

test("pending requests retained after a turn can still be denied or cleared when the session closes", () => {
  const { service } = setup();
  const denied = service.requestSecret("session-a", "OPENAI_API_KEY", "Await a decision.");
  service.turnEnded("session-a");
  service.deny(denied.id);
  assert.deepEqual(service.pending(), []);
  assert.throws(() => service.approve(denied.id, "session"), /expired/u);
  const closed = service.requestSecret("session-a", "OPENAI_API_KEY", "Wait until card closes.");
  service.turnEnded("session-a");
  service.sessionEnded("session-a");
  assert.deepEqual(service.pending(), []);
  assert.throws(() => service.approve(closed.id, "session"), /expired/u);
});

test("pending requests deduplicate by original turn without borrowing authority or extending TTL", () => {
  let turn = "launch:turn-1";
  const { service, setNow } = setup({ getTurnIdentity: () => turn });
  const first = service.requestSecret("session-a", "OPENAI_API_KEY", "First turn.");
  service.turnEnded("session-a");
  assert.equal(service.requestSecret("session-a", "OPENAI_API_KEY", "Same ended origin.").id, first.id);
  turn = null;
  assert.equal(service.requestSecret("session-a", "OPENAI_API_KEY", "Idle repeat.").id, first.id);
  setNow(2_000); turn = "launch:turn-2";
  const second = service.requestSecret("session-a", "OPENAI_API_KEY", "Second turn.");
  assert.notEqual(second.id, first.id); assert.equal(second.turnAvailable, true);
  assert.equal(service.requestSecret("session-a", "OPENAI_API_KEY", "Repeated second turn.").id, second.id);
  assert.deepEqual(service.pending(), [{ ...first, turnAvailable: false }, second]);
  assert.equal("originTurnIdentity" in second, false); assert.equal("turnIdentity" in second, false);
  assert.throws(() => service.approve(first.id, "turn"), /unavailable/u);
  setNow(first.expiresAt);
  assert.deepEqual(service.pending(), [second], "the first request expires independently without changing the second TTL");
  service.approve(second.id, "turn");
  assert.equal(service.listGrants()[0].duration, "turn");
  turn = null;
  const unsupported = service.requestSecret("session-a", "OPENAI_API_KEY", "No observed turn.");
  assert.equal(service.requestSecret("session-a", "OPENAI_API_KEY", "Repeated unsupported request.").id, unsupported.id);
  turn = "launch:turn-3";
  const third = service.requestSecret("session-a", "OPENAI_API_KEY", "New observed turn.");
  assert.notEqual(third.id, unsupported.id);
  assert.equal(third.turnAvailable, true);
  assert.equal(service.pending().find(item => item.id === unsupported.id).turnAvailable, false);
  service.approve(unsupported.id, "session");
  assert.equal(service.listGrants()[0].duration, "session", "old requests retain deliberate longer-scope approval");
});

const deferredSecretTest = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const secretApiInput = { secretId: "OPENAI_API_KEY", method: "GET", path: "models" };

test("10m grant expiry aborts pending execution even when the executor ignores abort", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = deferredSecretTest(), response = deferredSecretTest(); let signal;
  const { service, setNow, events } = setup({ execute: request => { signal = request.signal; started.resolve(); return response.promise; } });
  const grant = service.approve(service.requestSecret("session-a", "OPENAI_API_KEY", "Bound execution.").id, "10m");
  setNow(grant.expiresAt - 40);
  const running = service.runSecretRequest("session-a", secretApiInput);
  await started.promise;
  const rejected = assert.rejects(running, /expired/u);
  setNow(grant.expiresAt); t.mock.timers.tick(40);
  assert.equal(signal.aborted, true, "the grant deadline, not the 30-second API timeout, aborts execution");
  await rejected;
  response.resolve({ status: 200, body: "unit-test-secret-7342 late output", truncated: false });
  assert.deepEqual(service.listGrants(), []);
  assert.equal(events.filter(([type, event]) => type === "revoke" && event.reason === "expired").length, 1);
  t.mock.timers.tick(30_000);
  assert.equal(events.filter(([type]) => type === "revoke").length, 1, "settled execution has no active expiry timer");
});

test("result deadline check rejects late output before a delayed expiry timer runs", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = deferredSecretTest(), response = deferredSecretTest(); let signal;
  const { service, setNow } = setup({ execute: request => { signal = request.signal; started.resolve(); return response.promise; } });
  const grant = service.approve(service.requestSecret("session-a", "OPENAI_API_KEY", "Bound response.").id, "10m");
  const running = service.runSecretRequest("session-a", secretApiInput); await started.promise;
  setNow(grant.expiresAt); // Do not run timers: simulate a delayed event loop deadline callback.
  response.resolve({ status: 200, body: "unit-test-secret-7342 confidential output", truncated: false });
  await assert.rejects(running, error => /expired/u.test(error.message) && !/unit-test|confidential/u.test(error.message));
  assert.equal(signal.aborted, true);
});

test("successful short execution clears its expiry timer without revoking the live grant", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { service, setNow, events } = setup();
  const grant = service.approve(service.requestSecret("session-a", "OPENAI_API_KEY", "Short response.").id, "10m");
  setNow(grant.expiresAt - 40);
  assert.deepEqual(await service.runSecretRequest("session-a", secretApiInput), { status: 200, body: "received [masked]", truncated: false });
  t.mock.timers.tick(300_000);
  assert.equal(events.some(([type]) => type === "revoke"), false, "completed execution timers cannot revoke a grant later");
  assert.equal(service.listGrants().length, 1);
});

test("an older execution's expiry cannot revoke or abort a re-approved grant", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const starts = [deferredSecretTest(), deferredSecretTest()], responses = [deferredSecretTest(), deferredSecretTest()], signals = []; let count = 0;
  const { service, setNow } = setup({ execute: request => { const index = count++; signals.push(request.signal); starts[index].resolve(); return responses[index].promise; } });
  const grant = service.approve(service.requestSecret("session-a", "OPENAI_API_KEY", "First approval.").id, "10m");
  setNow(grant.expiresAt - 40);
  const oldRun = service.runSecretRequest("session-a", secretApiInput); await starts[0].promise;
  const replacement = service.approve(service.requestSecret("session-a", "OPENAI_API_KEY", "New approval.").id, "session");
  const newRun = service.runSecretRequest("session-a", secretApiInput); await starts[1].promise;
  const rejected = assert.rejects(oldRun, /expired/u);
  setNow(grant.expiresAt); t.mock.timers.tick(40); await rejected;
  assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
  assert.deepEqual(service.listGrants(), [replacement]);
  responses[1].resolve({ status: 200, body: "new approval result", truncated: false });
  assert.equal((await newRun).body, "new approval result");
  responses[0].resolve({ status: 200, body: "old output must not escape", truncated: false });
});

test("pre-canceled secret API request never reads a secret or starts its executor", async () => {
  let reads = 0;
  const { service, executions } = setup({ getSecret: async () => { reads += 1; return "fake-key"; } });
  service.approve(service.requestSecret("session-a", "OPENAI_API_KEY", "Cancelable call.").id, "session");
  const cancellation = new AbortController(); cancellation.abort(new Error("untrusted cancellation detail"));
  await assert.rejects(service.runSecretRequest("session-a", secretApiInput, cancellation.signal), /canceled/u);
  assert.equal(reads, 0); assert.equal(executions.length, 0); assert.equal(getEventListeners(cancellation.signal, "abort").length, 0);
  assert.equal(service.listGrants().length, 1);
});

test("cancellation during credential read settles promptly and prevents late execution", { timeout: 2_000 }, async () => {
  const read = deferredSecretTest(), started = deferredSecretTest();
  const { service, executions } = setup({ getSecret: () => { started.resolve(); return read.promise; } });
  service.approve(service.requestSecret("session-a", "OPENAI_API_KEY", "Cancelable read.").id, "session");
  const cancellation = new AbortController();
  const running = service.runSecretRequest("session-a", secretApiInput, cancellation.signal); await started.promise;
  const rejected = assert.rejects(running, /canceled/u); cancellation.abort();
  try { await rejected; } finally { read.resolve("unit-test-secret-7342"); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(executions.length, 0); assert.equal(service.listGrants().length, 1);
  assert.equal(getEventListeners(cancellation.signal, "abort").length, 0);
});

test("request cancellation aborts the worker, ignores its late output and preserves approval", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const response = deferredSecretTest(), started = deferredSecretTest(); let workerSignal;
  const { service, events } = setup({ execute: request => { workerSignal = request.signal; started.resolve(); return response.promise; } });
  service.approve(service.requestSecret("session-a", "OPENAI_API_KEY", "Cancelable worker.").id, "10m");
  const cancellation = new AbortController(), running = service.runSecretRequest("session-a", secretApiInput, cancellation.signal);
  await started.promise; const rejected = assert.rejects(running, /canceled/u);
  cancellation.abort(new Error("secret cancellation detail"));
  try { assert.equal(workerSignal.aborted, true); await rejected; }
  finally { response.resolve({ status: 200, body: "secret late output", truncated: false }); }
  await Promise.resolve(); await Promise.resolve();
  assert.equal(getEventListeners(cancellation.signal, "abort").length, 0);
  t.mock.timers.tick(600_000);
  assert.equal(events.some(([type]) => type === "revoke"), false, "canceled runs leave no deadline timer that can revoke approval");
  assert.equal(service.listGrants().length, 1);
});

test("success racing cancellation cannot escape, while ordinary success removes the listener", async () => {
  for (const cancel of [false, true]) {
    const response = deferredSecretTest(), started = deferredSecretTest();
    const { service } = setup({ execute: () => { started.resolve(); return response.promise; } });
    service.approve(service.requestSecret("session-a", "OPENAI_API_KEY", "Response race.").id, "session");
    const cancellation = new AbortController(), running = service.runSecretRequest("session-a", secretApiInput, cancellation.signal);
    await started.promise;
    response.resolve({ status: 200, body: "completed output", truncated: false });
    if (cancel) { cancellation.abort(); await assert.rejects(running, /canceled/u); }
    else assert.equal((await running).body, "completed output");
    assert.equal(getEventListeners(cancellation.signal, "abort").length, 0);
    assert.equal(service.listGrants().length, 1);
  }
});

test("request expiry, denial, invalid API requests, and missing isolation fail closed", async () => {
  const { service, setNow } = setup({ execute: undefined });
  const expired = service.requestSecret("session-a", "OPENAI_API_KEY", "One-off request.");
  setNow(expired.expiresAt);
  assert.deepEqual(service.pending(), []);
  assert.throws(() => service.approve(expired.id, "session"), /expired/u);

  const denied = service.requestSecret("session-a", "OPENAI_API_KEY", "Do not use automatically.");
  service.deny(denied.id);
  assert.equal(service.pending().length, 0);
  assert.throws(() => service.approve(denied.id, "session"), /expired/u);

  const request = service.requestSecret("session-a", "OPENAI_API_KEY", "Use approved key.");
  service.approve(request.id, "session");
  await assert.rejects(service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", method: "GET", path: "https://attacker.example/collect"
  }), /relative to the selected profile/u);
  await assert.rejects(service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", method: "GET", path: "models", headers: { Authorization: "attacker" }
  }), /request is invalid/u);
  await assert.rejects(service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", method: "GET", path: "models", apiProfileId: "anthropic"
  }), /different provider secret/u);
  await assert.rejects(service.runSecretRequest("session-a", {
    secretId: "DEVIN_API_KEY", method: "GET", path: "models"
  }), /not supported/u);
  await assert.rejects(service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", method: "GET", path: "models"
  }), /API requests are unavailable/u);
});

test("legacy arbitrary secret commands fail closed even after an approval is granted", async () => {
  const { service, executions } = setup();
  const request = service.requestSecret("session-a", "OPENAI_API_KEY", "Use for a bounded API request.");
  service.approve(request.id, "session");
  await assert.rejects(service.runSecretCommand("session-a", {
    command: "/usr/bin/awk", args: [`BEGIN { print ENVIRON["OPENAI_API_KEY"] }`], secretIds: ["OPENAI_API_KEY"]
  }), /Arbitrary secret-bearing commands are disabled/u);
  assert.deepEqual(executions, [], "rejected commands never reach the secret-bearing executor");
});

test("masked output is capped after redaction and revocation aborts an active API request", async () => {
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const { service, secret } = setup({
    execute: (request) => new Promise((resolve, reject) => {
      started();
      request.signal.addEventListener("abort", () => reject(new Error("canceled")), { once: true });
      void resolve;
    })
  });
  const request = service.requestSecret("session-a", "OPENAI_API_KEY", "Run once.");
  service.approve(request.id, "turn");
  const running = service.runSecretRequest("session-a", { secretId: "OPENAI_API_KEY", method: "GET", path: "models" });
  await waiting;
  service.turnEnded("session-a");
  await assert.rejects(running, /canceled/u);

  const outputService = setup({ execute: async () => ({ status: 200, body: `${"x".repeat(20_000)}unit-test-secret-7342`, truncated: false }) });
  const outputRequest = outputService.service.requestSecret("session-a", "OPENAI_API_KEY", "Check output cap.");
  outputService.service.approve(outputRequest.id, "session");
  const output = await outputService.service.runSecretRequest("session-a", {
    secretId: "OPENAI_API_KEY", method: "GET", path: "models"
  });
  assert.ok(Buffer.byteLength(output.body) <= 16 * 1024);
  assert.equal(output.body.includes(secret), false);
});

test("service retains complete UTF-8 tails within 16 KiB including the ellipsis", async () => {
  const cap = 16 * 1024;
  for (const character of ["é", "€", "🌍"]) {
    const width = Buffer.byteLength(character);
    for (let padding = 0; padding < width; padding += 1) {
      const tail = `${"z".repeat(padding)}tail`;
      const body = character.repeat(Math.ceil(20_000 / width)) + tail;
      const { service } = setup({ execute: async () => ({ status: 200, body, truncated: false }) });
      service.approve(service.requestSecret("session-a", "OPENAI_API_KEY", "Bound Unicode tail.").id, "session");
      const result = await service.runSecretRequest("session-a", secretApiInput);
      const expected = `…${character.repeat(Math.floor((cap - 3 - tail.length) / width))}${tail}`;
      assert.equal(result.body === expected, true, `${width}-byte character, padding ${padding}`);
      assert.ok(Buffer.byteLength(result.body) <= cap);
      assert.equal(result.body.includes("�"), false); assert.equal(result.truncated, true);
    }
    const exact = `${"a".repeat(cap % width)}${character.repeat(Math.floor(cap / width))}`;
    for (const truncated of [false, true]) {
      const { service } = setup({ execute: async () => ({ status: 200, body: exact, truncated }) });
      service.approve(service.requestSecret("session-a", "OPENAI_API_KEY", "Exact Unicode limit.").id, "session");
      assert.deepEqual(await service.runSecretRequest("session-a", secretApiInput), { status: 200, body: exact, truncated });
    }
  }
});

test("service measures the redacted output before applying its UTF-8 tail limit", async () => {
  const cap = 16 * 1024, masked = "[masked]", secret = "unit-test-secret-7342";
  const body = "é".repeat((cap - Buffer.byteLength(masked)) / 2) + secret;
  const { service } = setup({ execute: async () => ({ status: 200, body, truncated: false }) });
  service.approve(service.requestSecret("session-a", "OPENAI_API_KEY", "Mask before measuring.").id, "session");
  const result = await service.runSecretRequest("session-a", secretApiInput);
  assert.equal(result.body, body.replace(secret, masked));
  assert.equal(Buffer.byteLength(result.body), cap);
  assert.equal(result.truncated, false, "redaction shrinks an over-cap raw response to an exact-cap result");
  assert.equal(result.body.includes(secret), false);
});

test("orchestration exposes secret request/run tools to agents but not read-only reviewers", async (t) => {
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.disposeAll());
  const cwd = process.cwd();
  const at = { x: 0, y: 0 };
  const root = terminals.create({ provider: "codex", profile: "normal", cwd, position: at, role: "orchestrator" });
  const control = new AgentControlService(terminals);
  const agent = await control.spawn({ parentSessionId: root.id, provider: "opencode", cwd });
  const reviewer = await control.spawn({ parentSessionId: root.id, provider: "opencode", cwd, profile: "plan", readOnlyReview: true });
  const grants = new SecretGrantService({
    getSecret: async () => "not-returned",
    getSession: (sessionId) => {
      const metadata = terminals.getMetadata(sessionId);
      return metadata ? { provider: metadata.provider, cwd: metadata.cwd, profile: metadata.profile, active: metadata.exitCode === null } : null;
    },
    execute: async () => ({ status: 200, body: "", truncated: false })
  });
  const handler = new ScopedOrchestrationHandler(control, null, undefined, { secretGrants: grants });
  const secretToolNames = handler.listTools(agent.id).map((tool) => tool.name).filter((name) => name.includes("secret"));
  assert.deepEqual(secretToolNames, ["request_secret", "run_secret_request"]);
  assert.deepEqual(handler.listTools(reviewer.id), []);
  const response = await handler.execute(agent.id, {
    id: "request-secret",
    tool: "request_secret",
    arguments: { secretId: "OPENAI_API_KEY", reason: "Verify the configured provider key." }
  });
  assert.equal(response.pendingApproval, true);
  assert.equal(grants.pending([agent.id]).length, 1);
  await assert.rejects(handler.execute(agent.id, {
    id: "run-secret",
    tool: "run_secret_request",
    arguments: { secretId: "OPENAI_API_KEY", method: "GET", path: "models" }
  }), /Human approval is required/u);
});

test("secret approval IPC is main-window-only and cannot cross task roots", async (t) => {
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.disposeAll());
  const cwd = process.cwd();
  const at = { x: 0, y: 0 };
  const firstRoot = terminals.create({ provider: "codex", profile: "normal", cwd, position: at, role: "orchestrator" });
  const secondRoot = terminals.create({ provider: "codex", profile: "normal", cwd, position: at, role: "orchestrator" });
  const control = new AgentControlService(terminals);
  const child = await control.spawn({ parentSessionId: firstRoot.id, provider: "opencode", cwd });
  const otherChild = await control.spawn({ parentSessionId: secondRoot.id, provider: "opencode", cwd });
  const service = new SecretGrantService({
    getSecret: async () => "never-return-this",
    getTurnIdentity: () => "trusted-fixture-launch:turn-1",
    getSession: (sessionId) => {
      const metadata = terminals.getMetadata(sessionId);
      return metadata ? { provider: metadata.provider, cwd: metadata.cwd, profile: metadata.profile, active: metadata.exitCode === null } : null;
    },
    execute: async () => ({ status: 200, body: "", truncated: false })
  });
  const mainFrame = {};
  const webContents = { mainFrame };
  const mainWindow = { webContents };
  const handlers = new Map();
  registerBacklogIpc({ handle: (channel, callback) => handlers.set(channel, callback) }, {
    usagePrices: { get: () => [], set: async (rows) => rows }, board: {subscribe:()=>()=>{}}, budgets: {}, flows: {},
    taskRoot: (id) => control.taskRoot(id), attention: {}, secretGrants: service, terminals, timeline: {},
    checkpoints: {}, workspace: {}, getMainWindow: () => mainWindow
  });
  const trusted = { sender: webContents, senderFrame: mainFrame };
  const request = service.requestSecret(child.id, "OPENAI_API_KEY", "Run a scoped project check.");
  const foreignRequest = service.requestSecret(otherChild.id, "OPENAI_API_KEY", "This is a different task.");
  assert.deepEqual((await handlers.get(BACKLOG_IPC.secretRequests)(trusted, firstRoot.id)).map((row) => row.id), [request.id]);
  assert.throws(() => handlers.get(BACKLOG_IPC.approveSecretRequest)(trusted, firstRoot.id, foreignRequest.id, "session"), /request is outside this task/u);
  assert.throws(() => handlers.get(BACKLOG_IPC.secretRequests)({ sender: {}, senderFrame: mainFrame }, firstRoot.id), /Untrusted backlog caller/u);
  const grant = await handlers.get(BACKLOG_IPC.approveSecretRequest)(trusted, firstRoot.id, request.id, "turn");
  assert.equal(grant.sessionId, child.id);
  assert.equal("value" in grant, false);
  assert.throws(() => handlers.get(BACKLOG_IPC.revokeSecretGrant)(trusted, firstRoot.id, otherChild.id, "OPENAI_API_KEY"), /outside this task/u);
});
