import { CANVAS_LAUNCHER_ITEMS } from "../src/shared/contracts.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { CompanionSessions } from "../src/main/services/companion/CompanionSessions.ts";
import { SessionAccess } from "../src/main/services/companion/SessionAccess.ts";
import { RequestLedger } from "../src/main/services/companion/RequestLedger.ts";

function fixture() {
  const access = new SessionAccess(),
    writes = [],
    closed = [];
  const sessions = ["one", "private"].map((id) => ({
    id,
    title: id,
    provider: "codex",
    status: "idle",
    cwd: "/private/path",
    buffer: "PRIVATE BUFFER",
  }));
  const host = {
    list: () => sessions,
    read: async () => ({ body: "An answer", revision: "v1" }),
    input: (id, text) => {
      writes.push({ id, text });
      return true;
    },
    rename: (id, title) => {
      const session = sessions.find((s) => s.id === id);
      session.title = title;
      return session;
    },
    close: (id) => {
      closed.push(id);
      sessions.splice(
        sessions.findIndex((s) => s.id === id),
        1,
      );
    },
    create: (provider) => {
      const s = { id: "created", title: "New", provider, status: "idle" };
      sessions.push(s);
      return s;
    },
    openBrowser: async () => ({
      title: "Project",
      url: "https://example.test/app?token=PRIVATE#secret",
    }),
    limits: async () => ({ fetchedAt: 100_000, providers: [] }),
  };
  access.share({
    deviceId: "phone",
    sessionIds: ["one"],
    allowInput: true,
    allowCreate: true,
    allowClose: true,
    allowBrowser: true,
  });
  const service = new CompanionSessions(
    host,
    access,
    new RequestLedger(() => 100_000),
  );
  let sequence = 0;
  const request = (action) => ({
    version: 1,
    id: (++sequence).toString(16).padStart(32, "0"),
    sentAt: 100_000,
    action,
  });
  return { access, writes, closed, host, service, request };
}

test("only shared sessions and public metadata leave the host", async () => {
  const f = fixture();
  assert.deepEqual(
    await f.service.dispatch("phone", f.request({ type: "sessions.list" })),
    [{ id: "one", title: "one", provider: "codex", status: "idle" }],
  );
  await assert.rejects(
    f.service.dispatch(
      "phone",
      f.request({ type: "session.read", sessionId: "private" }),
    ),
    { code: "not-shared" },
  );
});

test("dictation is literal input; interrupt is a separate authorized action", async () => {
  const f = fixture();
  await f.service.dispatch(
    "phone",
    f.request({ type: "session.input", sessionId: "one", text: "/g2 ctrl-c" }),
  );
  assert.equal(f.writes[0].text, "\x1b[200~/g2 ctrl-c\x1b[201~\r");
  await f.service.dispatch(
    "phone",
    f.request({ type: "session.interrupt", sessionId: "one" }),
  );
  assert.equal(f.writes[1].text, "\x03");
});

test("read-only access cannot mutate a session", async () => {
  const f = fixture();
  f.access.share({
    ...f.access.get("phone"),
    allowInput: false,
    allowClose: false,
  });
  await assert.rejects(
    f.service.dispatch(
      "phone",
      f.request({ type: "session.close", sessionId: "one" }),
    ),
    { code: "not-permitted" },
  );
  await assert.rejects(
    f.service.dispatch(
      "phone",
      f.request({ type: "session.input", sessionId: "one", text: "hello" }),
    ),
    { code: "not-permitted" },
  );
  assert.equal(f.closed.length + f.writes.length, 0);
});

test("a repeated close does not close another terminal", async () => {
  const f = fixture(),
    request = f.request({ type: "session.close", sessionId: "one" });
  await f.service.dispatch("phone", request);
  await f.service.dispatch("phone", request);
  assert.deepEqual(f.closed, ["one"]);
});

test("revocation while a read is pending prevents returning its content", async () => {
  const f = fixture();
  let finish;
  f.host.read = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = f.service.dispatch(
    "phone",
    f.request({ type: "session.read", sessionId: "one" }),
  );
  await Promise.resolve();
  f.access.revoke("phone");
  finish({ body: "must not leave", revision: "v2" });
  await assert.rejects(pending, { code: "not-paired" });
});

test("browser replies omit URL queries and fragments; new sessions become shared only with their creator", async () => {
  const f = fixture();
  const browser = await f.service.dispatch(
    "phone",
    f.request({ type: "browser.open", sessionId: "one" }),
  );
  assert.deepEqual(browser, {
    title: "Project",
    url: "https://example.test/app",
  });
  const created = await f.service.dispatch(
    "phone",
    f.request({ type: "session.create", provider: "codex" }),
  );
  f.access.assertSession(f.access.get("phone"), created.id);
  assert.throws(() => f.access.get("other-phone"), { code: "not-paired" });
});

test("renaming updates shared metadata without writing to the PTY; read-only and private sessions are rejected", async () => {
  const f = fixture();
  const result = await f.service.dispatch(
    "phone",
    f.request({
      type: "session.rename",
      sessionId: "one",
      title: "  Бот   поддержки  ",
    }),
  );
  assert.equal(result.title, "Бот поддержки");
  assert.equal(f.writes.length, 0);
  assert.equal(result.cwd, undefined);
  await assert.rejects(
    f.service.dispatch(
      "phone",
      f.request({ type: "session.rename", sessionId: "private", title: "No" }),
    ),
    { code: "not-shared" },
  );
  f.access.share({ ...f.access.get("phone"), allowInput: false });
  await assert.rejects(
    f.service.dispatch(
      "phone",
      f.request({ type: "session.rename", sessionId: "one", title: "No" }),
    ),
    { code: "not-permitted" },
  );
});

test("every hotbar provider is created with scoped access; revoking creation blocks all of them", async () => {
  for (const provider of CANVAS_LAUNCHER_ITEMS) {
    const f = fixture();
    const result = await f.service.dispatch("phone", f.request({ type: "session.create", provider }));
    assert.equal(result.provider, provider);
    f.access.assertSession(f.access.get("phone"), result.id);
    f.access.share({ ...f.access.get("phone"), allowCreate: false });
    await assert.rejects(f.service.dispatch("phone", f.request({ type: "session.create", provider })), { code: "not-permitted" });
  }
});
