import test from "node:test";
import assert from "node:assert/strict";
import { SessionAccess } from "../src/main/services/companion/SessionAccess.ts";
import { RequestLedger } from "../src/main/services/companion/RequestLedger.ts";
import { parseCompanionRequest } from "../src/shared/companion.ts";

const request = (sentAt = 100_000) => ({
  version: 1,
  id: "a".repeat(32),
  sentAt,
  action: { type: "session.input", sessionId: "one", text: "hello" },
});
const grant = (deviceId = "phone") => ({
  deviceId,
  sessionIds: ["one"],
  allowInput: true,
  allowCreate: false,
  allowClose: false,
  allowBrowser: false,
});

test("unpaired devices and unshared sessions are rejected", () => {
  const access = new SessionAccess();
  assert.throws(() => access.get("unknown"), { code: "not-paired" });
  const allowed = access.share(grant());
  access.assertSession(allowed, "one");
  assert.throws(() => access.assertSession(allowed, "two"), {
    code: "not-shared",
  });
});

test("revocation or permission changes invalidate an in-flight grant", () => {
  const access = new SessionAccess();
  const old = access.share(grant());
  access.share({ ...grant(), allowInput: false });
  assert.throws(() => access.assertCurrent(old), { code: "not-permitted" });
  const current = access.get("phone");
  access.revoke("phone");
  assert.throws(() => access.assertCurrent(current), { code: "not-paired" });
});

test("a caller cannot expand a stored grant by mutating returned data", () => {
  const access = new SessionAccess(),
    original = grant();
  const returned = access.share(original);
  original.sessionIds.push("secret");
  returned.sessionIds.push("secret");
  assert.deepEqual(access.get("phone").sessionIds, ["one"]);
});

test("concurrent retry writes once and shares the result", async () => {
  let count = 0,
    finish;
  const ledger = new RequestLedger(() => 100_000);
  const operation = () => {
    count++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const first = ledger.run("phone", request(), operation),
    repeated = ledger.run("phone", request(), operation);
  await Promise.resolve();
  assert.equal(count, 1);
  finish({ delivered: true });
  assert.deepEqual(await first, await repeated);
  await ledger.run("phone", request(), operation);
  assert.equal(count, 1);
});

test("conflicting retry is rejected and receipt IDs are isolated per device", async () => {
  let count = 0;
  const ledger = new RequestLedger(() => 100_000),
    operation = async () => ++count;
  await ledger.run("phone", request(), operation);
  await assert.rejects(
    ledger.run(
      "phone",
      { ...request(), action: { type: "session.close", sessionId: "one" } },
      operation,
    ),
    { code: "request-conflict" },
  );
  await ledger.run("second-phone", request(), operation);
  assert.equal(count, 2);
});

test("capacity never evicts a valid receipt, and old requests fail after expiry", async () => {
  let now = 100_000,
    count = 0;
  const ledger = new RequestLedger(() => now, 1, 120_000),
    operation = async () => ++count;
  await ledger.run("phone", request(), operation);
  await assert.rejects(
    ledger.run("phone", { ...request(), id: "b".repeat(32) }, operation),
    { code: "busy" },
  );
  now = 220_001;
  await assert.rejects(ledger.run("phone", request(), operation), {
    code: "stale-request",
  });
  assert.equal(count, 1);
});

test("clock skew cannot expire a receipt while its request is still valid", async () => {
  let now = 100_000,
    count = 0;
  const ledger = new RequestLedger(() => now),
    future = request(129_000),
    operation = async () => ++count;
  await ledger.run("phone", future, operation);
  now = 221_000;
  await ledger.run("phone", future, operation);
  assert.equal(count, 1);
});

test("wire requests cannot choose filesystem paths, launch profiles, or terminal escape sequences", () => {
  assert.deepEqual(parseCompanionRequest(request()), request());
  for (const action of [
    { type: "session.create", provider: "codex", cwd: "/private" },
    { type: "session.create", provider: "codex", profile: "yolo" },
    { type: "session.input", sessionId: "one", text: "x\x1b[2J" },
    { type: "session.create", provider: "unexpected" },
    { type: "eval", code: "anything" },
  ])
    assert.throws(() => parseCompanionRequest({ ...request(), action }), {
      code: "invalid-request",
    });
});
