import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { EvenG2Controller } from "../src/main/services/companion/EvenG2Controller.ts";

async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-even-test-"));
  const webRoot = join(directory, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<h1>Companion fixture</h1>");
  const sessions = ["one", "private"].map((id) => ({
    id,
    title: id,
    provider: "terminal",
    status: "idle",
    cwd: "/unshared/private/path",
  }));
  const writes = [],
    closed = [],
    creates = [],
    renames = [],
    opened = [];
  const terminals = {
    listMetadata: () => sessions.map((s) => ({ ...s })),
    getMetadata: (id) => sessions.find((s) => s.id === id) ?? null,
    geometry: () => ({ cols: 100, rows: 30 }),
    readBuffer: () => ({ buffer: "Ready\r\n", outputOffset: 7 }),
    inputChecked: (id, data) => {
      if (!sessions.some((s) => s.id === id)) return false;
      writes.push({ id, data });
      return true;
    },
    rename: (id, title) => {
      const session = sessions.find((s) => s.id === id);
      if (!session) throw Error("missing");
      session.title = title;
      renames.push({ id, title });
      return session;
    },
    dispose: (id) => {
      closed.push(id);
      const index = sessions.findIndex((s) => s.id === id);
      if (index >= 0) sessions.splice(index, 1);
    },
    create: (options) => {
      creates.push(options);
      const session = {
        id: "new-" + creates.length,
        title: "Created",
        provider: options.provider,
        status: "idle",
        cwd: options.cwd,
      };
      sessions.push(session);
      return session;
    },
  };
  let addresses = [
    { id: "test:127.0.0.1", name: "test", address: "127.0.0.1" },
  ];
  const options = {
    ...extra,
    userDataPath: directory,
    terminals,
    addresses: () => addresses,
    webRoot,
    speechWorker: join(directory, "missing-worker.py"),
    port: 0,
    limits: async () => ({ fetchedAt: Date.now(), providers: [] }),
    openBrowser: async (id) => {
      opened.push(id);
      return { title: "Project", url: "http://localhost:5173/page?secret=omit#omit" };
    },
  };
  const controller = new EvenG2Controller(options);
  await controller.load();
  t.after(async () => {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  });
  const enable = async (overrides) =>
    controller.command({
      type: "configure",
      config: {
        ...controller.state().config,
        enabled: true,
        workspace: directory,
        interfaceName: "test",
        sessionIds: ["one"],
        allowClose: true,
        ...overrides,
      },
    });
  const call = async (path, { token, body, raw = false } = {}) => {
    const response = await fetch(
      "http://127.0.0.1:" + controller.state().port + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(token ? { Authorization: "Bearer " + token } : {}),
          "Content-Type": "application/json",
        },
        body:
          body === undefined
            ? undefined
            : JSON.stringify(
                raw
                  ? body
                  : {
                      ...body,
                      requestId:
                        body.requestId || randomBytes(16).toString("hex"),
                      sentAt: body.sentAt ?? Date.now(),
                    },
              ),
      },
    );
    return { status: response.status, data: await response.json() };
  };
  const pending = async () => {
    await controller.command({ type: "begin-pairing" });
    const response = await call("/g2/api/pair", {
      body: { code: controller.state().pairing.code, name: "Even test" },
    });
    assert.equal(response.status, 202);
    return response.data;
  };
  const pair = async () => {
    const p = await pending();
    await controller.command({ type: "approve", id: p.id });
    return p;
  };
  return {
    controller,
    setAddresses: (value) => {
      addresses = value;
    },
    options,
    directory,
    enable,
    call,
    pending,
    pair,
    writes,
    closed,
    creates,
    renames,
    opened,
  };
}

test("integration defaults off; the short code creates no access before desktop approval", async (t) => {
  const f = await fixture(t);
  assert.equal(f.controller.state().listening, false);
  await f.enable();
  const pending = await f.pending();
  assert.equal(
    (await f.call("/g2/api/home", { token: pending.token })).status,
    401,
  );
  assert.equal(
    (
      await f.call("/g2/api/control", {
        token: pending.token,
        body: { sessionId: "one", action: "text", text: "not delivered" },
      })
    ).status,
    401,
  );
  assert.equal(
    (await f.call("/g2/api/pair-status", { token: pending.token })).data.state,
    "pending",
  );
  await f.controller.command({ type: "approve", id: pending.id });
  const home = await f.call("/g2/api/home", { token: pending.token });
  assert.equal(home.status, 200);
  assert.deepEqual(home.data.sessions, [
    { id: "one", title: "one", provider: "terminal", status: "idle" },
  ]);
  assert.equal(JSON.stringify(home).includes("/unshared"), false);
  assert.equal(f.writes.length, 0);
  assert.equal(home.data.speechAvailable, false);
  assert.equal(
    (await f.call("/g2/api/pair-status", { token: pending.token })).data.state,
    "approved",
  );
});

test("text is written once; changed payload, missing freshness, stale and unshared requests never write", async (t) => {
  const f = await fixture(t);
  await f.enable();
  const { token } = await f.pair();
  const body = {
    sessionId: "one",
    action: "text",
    text: "literal /g2 ctrl-c",
    requestId: randomBytes(16).toString("hex"),
    sentAt: Date.now(),
  };
  const results = await Promise.all([
    f.call("/g2/api/control", { token, body }),
    f.call("/g2/api/control", { token, body }),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200],
  );
  assert.deepEqual(f.writes, [
    { id: "one", data: "\x1b[200~literal /g2 ctrl-c\x1b[201~\r" },
  ]);
  assert.equal(
    (
      await f.call("/g2/api/control", {
        token,
        body: { ...body, text: "changed" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call("/g2/api/control", {
        token,
        body: { ...body, sessionId: "private" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call("/g2/api/control", {
        token,
        body: { ...body, sentAt: Date.now() - 121000 },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call("/g2/api/create", {
        token,
        body: { provider: "terminal" },
        raw: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.call("/g2/api/terminal?id=private", { token })).status,
    409,
  );
  assert.equal(f.writes.length, 1);
  assert.equal(f.creates.length, 0);
});

test("creation is scoped to the chosen folder and device; close and browser use real acknowledgements", async (t) => {
  const f = await fixture(t);
  await f.enable();
  const first = await f.pair(),
    second = await f.pair();
  const body = {
    provider: "terminal",
    requestId: randomBytes(16).toString("hex"),
    sentAt: Date.now(),
  };
  const created = await f.call("/g2/api/create", { token: first.token, body });
  assert.equal(created.status, 201);
  await f.call("/g2/api/create", { token: first.token, body });
  assert.equal(f.creates.length, 1);
  assert.equal(f.creates[0].cwd, f.directory);
  assert.equal(f.creates[0].profile, "normal");
  assert.equal(
    (await f.call("/g2/api/home", { token: second.token })).data.sessions
      .length,
    1,
  );
  const browser = await f.call("/g2/api/browser", {
    token: first.token,
    body: { sessionId: created.data.session.id },
  });
  assert.deepEqual(browser.data, {
    opened: true,
    title: "Project",
    url: "http://localhost:5173/page",
  });
  const close = {
    sessionId: created.data.session.id,
    requestId: randomBytes(16).toString("hex"),
    sentAt: Date.now(),
  };
  assert.equal(
    (await f.call("/g2/api/session-close", { token: first.token, body: close }))
      .status,
    200,
  );
  assert.equal(
    (await f.call("/g2/api/session-close", { token: first.token, body: close }))
      .status,
    200,
  );
  assert.deepEqual(f.closed, [created.data.session.id]);
});

test("readonly scope is enforced even when a phone bypasses disabled buttons", async (t) => {
  const f = await fixture(t);
  await f.enable({
    allowInput: false,
    allowClose: false,
    allowCreate: false,
    allowBrowser: false,
  });
  const { token } = await f.pair();
  for (const [path, body, status, error] of [
    ["control", { sessionId: "one", action: "text", text: "no" }, 403, "not-permitted"],
    ["session-close", { sessionId: "one" }, 409, "request-failed"],
    ["create", { provider: "codex" }, 409, "request-failed"],
    ["browser", { sessionId: "one" }, 409, "request-failed"],
  ]) {
    const reply = await f.call("/g2/api/" + path, { token, body });
    assert.deepEqual(reply, { status, data: { error } }, path);
  }
  assert.equal(f.writes.length + f.closed.length + f.creates.length + f.opened.length, 0);
});

test("peer persistence contains only a private token hash and revocation survives restart", async (t) => {
  const f = await fixture(t);
  await f.enable();
  const { token, id } = await f.pair();
  const path = join(f.directory, "even-g2.json"),
    saved = await readFile(path, "utf8");
  assert.equal(saved.includes(token), false);
  assert.match(saved, /tokenHash/);
  assert.match(saved, /transportVersion/);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  await f.controller.command({ type: "revoke", id });
  assert.equal((await f.call("/g2/api/home", { token })).status, 401);
  await f.controller.command({
    type: "configure",
    config: { ...f.controller.state().config, enabled: false },
  });
  assert.equal(f.controller.state().listening, false);
  const restored = new EvenG2Controller(f.options);
  await restored.load();
  assert.equal(restored.state().listening, false);
  assert.deepEqual(restored.state().peers, []);
  await restored.close();
});

test("legacy shared-key peers are invalidated on upgrade and must pair again", async (t) => {
  const f = await fixture(t);
  await f.enable();
  const { token } = await f.pair();
  const path = join(f.directory, "even-g2.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  delete saved.peers[0].transportVersion;
  await writeFile(path, JSON.stringify(saved));
  await f.controller.close();

  const restored = new EvenG2Controller(f.options);
  await restored.load();
  assert.deepEqual(restored.state().peers, []);
  const response = await fetch(
    "http://127.0.0.1:" + restored.state().port + "/g2/api/home",
    { headers: { Authorization: "Bearer " + token } },
  );
  assert.equal(response.status, 401);
  await restored.close();
});

test("wrong-code attempts are bounded and rejecting the claim invalidates its pending token", async (t) => {
  const f = await fixture(t);
  await f.enable();
  await f.controller.command({ type: "begin-pairing" });
  const code = f.controller.state().pairing.code;
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await f.call("/g2/api/pair", { body: { code: "invalid" } })).status,
      403,
    );
  assert.equal((await f.call("/g2/api/pair", { body: { code } })).status, 403);
  const pending = await f.pending();
  await f.controller.command({ type: "reject" });
  assert.equal(
    (await f.call("/g2/api/pair-status", { token: pending.token })).data.state,
    "rejected",
  );
  assert.equal(
    (await f.call("/g2/api/home", { token: pending.token })).status,
    401,
  );
});

test("loss of the selected network closes its listener and invalidates an outstanding code", async (t) => {
  const f = await fixture(t);
  await f.enable();
  await f.controller.command({ type: "begin-pairing" });
  const prior = f.controller.state().transport.origin;
  f.setAddresses([]);
  await f.controller.command({ type: "refresh" });
  assert.equal(f.controller.state().listening, false);
  assert.equal(f.controller.state().transport.origin, "");
  assert.equal(f.controller.state().pairing, null);
  await assert.rejects(fetch(prior + "/g2/api/home"));
  f.setAddresses([
    { id: "test:127.0.0.1", name: "test", address: "127.0.0.1" },
  ]);
  await f.controller.command({ type: "refresh" });
  const current = f.controller.state();
  assert.equal(current.listening, true);
  assert.match(current.transport.origin, /127\.0\.0\.1/);
  assert.equal((await fetch(current.transport.origin + "/g2/")).status, 200);
  assert.equal(
    (await fetch(current.transport.origin + "/g2/api/home")).status,
    401,
  );
});

test("an old ADB configuration never silently exposes its existing grants on a LAN", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.directory, "even-g2.json"),
    JSON.stringify({
      version: 1,
      config: {
        ...f.controller.state().config,
        enabled: true,
        selectedSerial: "old-phone",
        adbPath: "/old/adb",
      },
      peers: [
        {
          id: "a".repeat(32),
          tokenHash: "b".repeat(64),
          name: "Old peer",
          grant: { sessionIds: ["one"], allowInput: true },
        },
      ],
    }),
  );
  const restored = new EvenG2Controller(f.options);
  await restored.load();
  assert.equal(restored.state().config.enabled, false);
  assert.equal(restored.state().listening, false);
  assert.deepEqual(restored.state().peers, []);
  await restored.close();
});

test("microphone diagnostics require pairing and remain bounded in the desktop state", async (t) => {
  const f = await fixture(t);
  await f.enable();
  const pending = await f.pending();
  const body = {
    clientVersion: "0.4.1",
    microphone: "unknown",
    error: "No microphone acknowledgement",
    diagnostics: [
      null,
      {},
      ...Array.from(
        { length: 30 },
        (_, i) => "mic:" + i + " " + ".".repeat(240),
      ),
    ],
  };
  assert.equal(
    (await f.call("/g2/api/device-state", { token: pending.token, body }))
      .status,
    401,
  );
  await f.controller.command({ type: "approve", id: pending.id });
  assert.equal(
    (await f.call("/g2/api/device-state", { token: pending.token, body }))
      .status,
    200,
  );
  const telemetry = f.controller.state().peers[0].telemetry;
  assert.equal(telemetry.error, body.error);
  assert.equal(telemetry.microphone, "unknown");
  assert.equal(telemetry.diagnostics.length, 24);
  assert.ok(
    telemetry.diagnostics.every(
      (line) => typeof line === "string" && line.length <= 180,
    ),
  );
});

test("HTTPS mode serves the connector on loopback independently of LAN discovery", async (t) => {
  const f = await fixture(t);
  f.setAddresses([]);
  await f.enable({ publicOrigin: "https://bridge.example.test/" });
  const state = f.controller.state();
  assert.equal(state.transport.kind, "https");
  assert.equal(state.transport.origin, "https://bridge.example.test");
  assert.equal(state.listening, true);
  assert.equal(
    (await fetch("http://127.0.0.1:" + state.port + "/g2/")).status,
    200,
  );
  assert.equal((await f.call("/g2/api/home")).status, 401);
  const { token } = await f.pair();
  assert.equal((await f.call("/g2/api/home", { token })).status, 200);
  await f.controller.command({ type: "refresh" });
  assert.equal(f.controller.state().listening, true);
  await f.controller.command({
    type: "configure",
    config: { ...state.config, enabled: false },
  });
  assert.equal(f.controller.state().listening, false);
});

test("confirmed rename is idempotent and never becomes terminal input", async (t) => {
  const f = await fixture(t);
  await f.enable();
  const { token } = await f.pair();
  const body = {
    sessionId: "one",
    title: "  Бот   поддержки ",
    requestId: randomBytes(16).toString("hex"),
    sentAt: Date.now(),
  };
  const reply = await f.call("/g2/api/session-rename", { token, body });
  assert.equal(reply.status, 200);
  assert.equal(reply.data.session.title, "Бот поддержки");
  await f.call("/g2/api/session-rename", { token, body });
  assert.equal(f.renames.length, 1);
  assert.equal(f.writes.length, 0);
  assert.equal(
    (await f.call("/g2/api/home", { token })).data.sessions[0].title,
    "Бот поддержки",
  );
  // Legacy endpoints intentionally hide detailed CompanionError codes.
  for (const rejected of [
    ...["", "x".repeat(81), "\x1b[31m"].map((title) => ({ sessionId: "one", title })),
    { sessionId: "private", title: "No" }
  ]) {
    assert.deepEqual(await f.call("/g2/api/session-rename", { token, body: rejected }),
      { status: 409, data: { error: "request-failed" } });
  }
  assert.equal(f.renames.length, 1);
  assert.equal(f.writes.length, 0);
});

test("voice used for a rename is only a preview and cannot be replayed as a shell instruction", async (t) => {
  const speech = {
    available: true,
    model: "Test recognizer",
    configure() {},
    async inspect() {},
    cancel() {},
    cancelAll() {},
    async run(body, accept) {
      return {
        accepted: await accept("Бот поддержки", () => false),
        transcript: "Бот поддержки",
      };
    },
  };
  const f = await fixture(t, { speech });
  await f.enable();
  const { token } = await f.pair();
  const body = {
    sessionId: "one",
    purpose: "rename",
    audio: Buffer.alloc(8000).toString("base64"),
    requestId: randomBytes(16).toString("hex"),
    sentAt: Date.now(),
  };
  const result = await f.call("/g2/api/voice", { token, body });
  assert.equal(result.status, 200);
  assert.equal(result.data.transcript, "Бот поддержки");
  assert.equal(f.writes.length, 0);
  assert.equal(f.renames.length, 0);
  assert.equal(
    (await f.call("/g2/api/home", { token })).data.sessions[0].title,
    "one",
  );
  assert.equal(
    (
      await f.call("/g2/api/voice", {
        token,
        body: { ...body, purpose: "input" },
      })
    ).status,
    409,
  );
  assert.equal(f.writes.length, 0);
});

test("local encrypted pairing and session rename use the real controller with unchanged authorization", async (t) => {
  const { localFetcher, connectionFromCode } =
    await import("../integrations/even-g2/src/local-fetch.mjs");
  const f = await fixture(t);
  await f.enable();
  const origin = f.controller.state().transport.origin;
  await f.controller.command({ type: "begin-pairing" });
  const resolved = await connectionFromCode(f.controller.state().pairing.code, {
    origins: [origin], allowLoopback: true,
  });
  const send = localFetcher(resolved.connection, { allowLoopback: true });
  const pairedResponse = await send(origin + "/g2/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: f.controller.state().pairing.code,
      name: "Local test",
    }),
  });
  assert.equal(pairedResponse.status, 202);
  const pair = await pairedResponse.json();
  const options = { headers: { Authorization: "Bearer " + pair.token } };
  assert.equal((await send(origin + "/g2/api/home", options)).status, 401);
  await f.controller.command({ type: "approve", id: pair.id });
  const home = await (await send(origin + "/g2/api/home", options)).json();
  assert.deepEqual(
    home.sessions.map((s) => s.id),
    ["one"],
  );
  const renamed = await send(origin + "/g2/api/session-rename", {
    ...options,
    method: "POST",
    body: JSON.stringify({
      sessionId: "one",
      title: "Локальная сессия",
      requestId: randomBytes(16).toString("hex"),
      sentAt: Date.now(),
    }),
  });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).session.title, "Локальная сессия");
  assert.deepEqual(f.writes, []);
  await f.controller.command({ type: "revoke", id: pair.id });
  await assert.rejects(send(origin + "/g2/api/home", options));
  assert.equal((await f.call("/g2/api/home", { token: pair.token })).status, 401);
});

test("device transport keys isolate active peers, revoke immediately, and re-pair with a fresh key", async (t) => {
  const { localFetcher, connectionFromCode } =
    await import("../integrations/even-g2/src/local-fetch.mjs");
  const { sealLocal, unsealLocal } = await import("../src/shared/localLink.ts");
  const f = await fixture(t);
  await f.enable();
  const origin = f.controller.state().transport.origin;
  const pairLocal = async (name, fetcher = fetch) => {
    await f.controller.command({ type: "begin-pairing" });
    const resolved = await connectionFromCode(f.controller.state().pairing.code, {
      origins: [origin], allowLoopback: true,
    });
    const send = localFetcher(resolved.connection, {
      allowLoopback: true,
      fetcher,
    });
    const response = await send(origin + "/g2/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: resolved.code, name }),
    });
    assert.equal(response.status, 202);
    const credentials = await response.json();
    const connection = send.connection();
    await f.controller.command({ type: "approve", id: credentials.id });
    assert.equal((await send(origin + "/g2/api/home", {
      headers: { Authorization: "Bearer " + credentials.token },
    })).status, 200);
    return { send, connection, ...credentials };
  };
  const a = await pairLocal("Synthetic A");
  let capturedB = null;
  const b = await pairLocal("Synthetic B", async (url, options) => {
    if (url.endsWith("/g2/link")) capturedB = JSON.parse(options.body);
    return fetch(url, options);
  });
  assert.notEqual(a.connection.deviceId, b.connection.deviceId);
  assert.notEqual(a.connection.key, b.connection.key);
  assert.ok(capturedB);
  await assert.rejects(unsealLocal({
    ...a.connection,
    deviceId: b.connection.deviceId,
  }, capturedB, "request"));

  const forged = await sealLocal({
    ...a.connection,
    deviceId: b.connection.deviceId,
  }, {
    path: "/g2/api/home",
    method: "GET",
    token: b.token,
    sentAt: Date.now(),
  }, "request");
  const rejected = await fetch(origin + "/g2/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(forged),
  });
  assert.equal(rejected.status, 409);

  const legacyShared = await sealLocal({
    version: 1,
    computer: a.connection.computer,
    key: randomBytes(32).toString("hex"),
    origins: [origin],
  }, {
    path: "/g2/api/home",
    method: "GET",
    token: b.token,
    sentAt: Date.now(),
  }, "request");
  const legacyResponse = await fetch(origin + "/g2/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(legacyShared),
  });
  assert.equal(legacyResponse.status, 409);

  await f.controller.command({ type: "revoke", id: a.id });
  await assert.rejects(a.send(origin + "/g2/api/home", {
    headers: { Authorization: "Bearer " + a.token },
  }));
  assert.equal((await b.send(origin + "/g2/api/home", {
    headers: { Authorization: "Bearer " + b.token },
  })).status, 200);

  const a2 = await pairLocal("Synthetic A re-paired");
  assert.notEqual(a2.connection.deviceId, a.connection.deviceId);
  assert.notEqual(a2.connection.key, a.connection.key);
  const oldKeyPacket = await sealLocal({
    ...a.connection,
    deviceId: a2.connection.deviceId,
  }, {
    path: "/g2/api/home",
    method: "GET",
    token: a2.token,
    sentAt: Date.now(),
  }, "request");
  const oldKeyResponse = await fetch(origin + "/g2/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(oldKeyPacket),
  });
  assert.equal(oldKeyResponse.status, 409);
  assert.equal((await a2.send(origin + "/g2/api/home", {
    headers: { Authorization: "Bearer " + a2.token },
  })).status, 200);
});

test("six digits establish SRP keys but terminal access still requires desktop approval", async (t) => {
  const srp = (await import("secure-remote-password/client.js")).default;
  const { PAIRING_IDENTITY } = await import("../src/shared/localDiscovery.ts");
  const { unsealLocal } = await import("../src/shared/localLink.ts");
  const f = await fixture(t);
  await f.enable();
  await f.controller.command({ type: "begin-pairing" });
  const code = f.controller.state().pairing.code;
  assert.match(code, /^\d{6}$/);
  const origin = f.controller.state().transport.origin;
  const post = async (path, body) => fetch(origin + path, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const ephemeral = srp.generateEphemeral();
  const response = await post("/g2/pair-start", { public: ephemeral.public });
  assert.equal(response.status, 200);
  const challenge = await response.json();
  const session = srp.deriveSession(ephemeral.secret, challenge.public, challenge.salt,
    PAIRING_IDENTITY, srp.derivePrivateKey(challenge.salt, PAIRING_IDENTITY, code));
  const finish = await post("/g2/pair-finish", { id: challenge.id, proof: session.proof });
  assert.equal(finish.status, 200);
  const reply = await finish.json();
  srp.verifySession(ephemeral.public, session, reply.proof);
  const resolved = await unsealLocal({ version: 1, computer: challenge.id,
    key: session.key, origins: [origin] }, reply.packet, "response");
  assert.equal(resolved.code, code);
  assert.match(resolved.connection.key, /^[a-f0-9]{64}$/);
  assert.equal(f.controller.state().pairing.pending, null);
  assert.equal((await fetch(origin + "/g2/api/home")).status, 401);
  assert.equal((await post("/g2/pair-finish", { id: challenge.id, proof: session.proof })).status, 403);
  await f.controller.command({ type: "cancel-pairing" });
  assert.equal((await post("/g2/pair-start", { public: ephemeral.public })).status, 403);
});

test("closing drains queued pairing diagnostics before fixture storage is removed", async (t) => {
  const f = await fixture(t);
  await f.enable();
  const log = join(f.directory, "even-g2-pairing.log");
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  // Hold the real file write behind an earlier queue item, regardless of filesystem speed.
  f.controller.diagnosticsWrite = f.controller.diagnosticsWrite.then(() => blocked);
  const before = f.controller.diagnosticsWrite;
  let closing;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await f.call("/g2/discover");
    t.mock.timers.tick(1_000);
    assert.notEqual(f.controller.diagnosticsWrite, before, "the request queued a real log write");
    let closed = false;
    closing = f.controller.close().then(() => { closed = true; });
    await new Promise(setImmediate);
    assert.equal(closed, false, "close must wait while the diagnostics write is held");
    release();
    await closing;
    assert.match(await readFile(log, "utf8"), /GET \/g2\/discover HTTP 200/u);
    await rm(f.directory, { recursive: true, force: true });
  } finally {
    release();
    await closing;
    await f.controller.diagnosticsWrite;
    t.mock.timers.reset();
  }
});

test("real HTTP client pairs with six digits, rejects wrong PIN and waits for Mac approval", async (t) => {
  const { connectionFromCode, localFetcher } = await import("../integrations/even-g2/src/local-fetch.mjs");
  const { pairComputer } = await import("../integrations/even-g2/src/connect.mjs");
  const f = await fixture(t);
  await f.enable();
  await f.controller.command({ type: "begin-pairing" });
  const code = f.controller.state().pairing.code;
  const origin = f.controller.state().transport.origin;
  const options = { origins: [origin], allowLoopback: true };
  await assert.rejects(connectionFromCode(code === "000000" ? "000001" : "000000", options), /Код не принят/);
  const resolved = await connectionFromCode(code, options);
  assert.equal(resolved.code, code);
  const send = localFetcher(resolved.connection, { allowLoopback: true });
  let pendingObserved = false;
  const paired = await pairComputer(origin, code, { fetcher: send,
    onPending: () => {
      pendingObserved = true;
      const pending = f.controller.state().pairing.pending;
      assert.ok(pending);
      void f.controller.command({ type: "approve", id: pending.id });
    },
  });
  assert.ok(pendingObserved);
  assert.deepEqual(paired.home.sessions.map(s => s.id), ["one"]);
  const response = await send(origin + "/g2/api/control", { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + paired.token },
    body: JSON.stringify({ sessionId: "one", action: "text", text: "six-digit-check",
      requestId: randomBytes(16).toString("hex"), sentAt: Date.now() }),
  });
  assert.equal(response.status, 200);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].id, "one");
});

test("six-digit handshakes enforce expiry and a bounded guess budget", async () => {
  const { LocalPairing } = await import("../src/main/services/companion/LocalPairing.ts");
  const srp = (await import("secure-remote-password/client.js")).default;
  const value = srp.generateEphemeral().public;
  const pair = new LocalPairing("001234", Date.now() + 5000);
  for (let i = 0; i < 10; i++) pair.start(value);
  assert.throws(() => pair.start(value), /unavailable/);
  assert.throws(() => new LocalPairing("001234", Date.now() - 1).start(value), /unavailable/);
  assert.throws(() => new LocalPairing("1234567", Date.now() + 5000));
});

test("HTTP creation uses the selected hotbar provider and the desktop workspace/profile", async (t) => {
  const { CANVAS_LAUNCHER_ITEMS } = await import("../src/shared/contracts.ts");
  const f = await fixture(t);
  await f.enable();
  const { token } = await f.pair();
  for (const provider of CANVAS_LAUNCHER_ITEMS) {
    const result = await f.call("/g2/api/create", { token, body: {
      provider, requestId: randomBytes(16).toString("hex"), sentAt: Date.now(),
    } });
    assert.equal(result.status, 201);
    assert.equal(f.creates.at(-1).provider, provider);
    assert.equal(f.creates.at(-1).profile, "normal");
    assert.equal(f.creates.at(-1).cwd, f.controller.state().config.workspace);
  }
});

test("a Bonjour name that cannot be published leaves the listener up and is retried only after a pause", async (t) => {
  let starts = 0;
  const discovery = { host: "", stop() {}, async start() { starts += 1; throw new Error("local-discovery-unavailable"); } };
  const f = await fixture(t, { localDiscovery: discovery });
  await f.enable();
  assert.equal(f.controller.state().error, "", "not a listener failure");
  assert.ok(f.controller.state().port > 0);
  assert.equal((await f.call("/g2/discover")).status < 500, true, "the listener answers");
  const before = starts;
  await f.controller.reconcileNetwork();
  await f.controller.reconcileNetwork();
  assert.equal(starts, before, "no new dns-sd round on every tick");
});

test("pairing diagnostics are written in batches, not on every unauthenticated request", async (t) => {
  const f = await fixture(t);
  await f.enable();
  const log = join(f.directory, "even-g2-pairing.log");
  for (let i = 0; i < 10; i++) await f.call("/g2/discover");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(readFile(log, "utf8"), /ENOENT/u, "not written per request");
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 10);
});

test("a configure that cannot be saved changes nothing; a revoke that cannot be saved still holds and is saved later", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await f.enable();
  const device = await f.pair();
  const { chmod } = await import("node:fs/promises");
  await chmod(f.directory, 0o500);
  try {
    await assert.rejects(f.enable({ allowClose: false }));
    assert.equal(f.controller.state().config.allowClose, true, "the configuration that could not be saved was not applied");
    await assert.rejects(f.controller.command({ type: "revoke", id: device.id }));
    assert.equal(f.controller.state().peers?.some?.((peer) => peer.id === device.id) ?? false, false, "revoked at once");
  } finally {
    await chmod(f.directory, 0o700);
  }
  await f.controller.close();
  const saved = JSON.parse(await readFile(join(f.directory, "even-g2.json"), "utf8"));
  assert.deepEqual(saved.peers.map((peer) => peer.id), [], "the revoke reached the disk once it could");
});
