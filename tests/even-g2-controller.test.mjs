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
import { IPC } from "../src/shared/contracts.ts";
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
    renames = [];
  const terminals = {
    redactSecrets: value => value,
    listMetadata: () => sessions.map((s) => ({ ...s })),
    redactSecrets: text => text,
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
    experimentalEnabled: () => true,
    ...extra,
    userDataPath: directory,
    terminals,
    addresses: () => addresses,
    webRoot,
    speechWorker: join(directory, "missing-worker.py"),
    port: 0,
    limits: async () => ({ fetchedAt: Date.now(), providers: [] }),
    openBrowser: async () => ({
      title: "Project",
      url: "http://localhost:5173/page?secret=omit#omit",
    }),
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
  const pending = async (pairFields = {}) => {
    await controller.command({ type: "begin-pairing" });
    const response = await call("/g2/api/pair", {
      body: { code: controller.state().pairing.code, name: "Even test", ...pairFields },
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
    sessions,
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

test("pair requests cannot self-select phone mode; LAN G2 access follows desktop configuration", async t => {
  const f=await fixture(t);await f.enable();
  const pending=await f.pending({name:"CanvasTTY Web Companion",summaryOnly:true});
  await f.controller.command({type:"approve",id:pending.id});
  assert.equal((await f.call("/g2/api/pair-status",{token:pending.token})).data.state,"approved");
  assert.equal((await f.call("/g2/api/home",{token:pending.token})).status,200);
  assert.equal((await f.call("/g2/api/terminal?id=one",{token:pending.token})).status,200);
  assert.equal((await f.call("/g2/api/terminal?id=private",{token:pending.token})).status,409);
  const saved=JSON.parse(await readFile(join(f.directory,"even-g2.json"),"utf8"));
  assert.equal(saved.peers[0].clientType,"even-g2");
});

test("an Even G2 peer regains its desktop-approved routes after a phone-only transport round trip", async (t) => {
  const f = await fixture(t);
  await f.enable();
  const { token } = await f.pair();
  assert.equal((await f.call("/g2/api/home", { token })).status, 200);

  await f.controller.command({ type: "configure", config: {
    ...f.controller.state().config,
    publicOrigin: "https://computer.tailnet.ts.net",
  } });
  assert.equal((await f.call("/g2/api/home", { token })).status, 403,
    "the active HTTPS phone transport restricts every peer");

  await f.controller.command({ type: "configure", config: {
    ...f.controller.state().config,
    publicOrigin: "",
    interfaceName: "test",
  } });
  assert.equal((await f.call("/g2/api/home", { token })).status, 200,
    "returning to LAN restores the original host-approved Even G2 routes");
  assert.equal((await f.call("/g2/api/terminal?id=one", { token })).status, 200);
  const saved = JSON.parse(await readFile(join(f.directory, "even-g2.json"), "utf8"));
  assert.equal(saved.peers[0].clientType, "even-g2");
});

for (const mode of ["usb", "tailscale"]) test(`an Even G2 peer keeps its LAN permissions, including the project browser, after a ${mode} round trip`, async (t) => {
  const f = await fixture(t);
  await f.enable({ allowBrowser: true });
  const { token } = await f.pair();
  let home = await f.call("/g2/api/home", { token });
  assert.equal(home.status, 200);
  assert.equal(home.data.features.projectBrowser, true);

  const publicOrigin = mode === "usb" ? `http://127.0.0.1:${f.controller.state().port}` : "https://computer.tailnet.ts.net";
  // The settings screen submits the state it last read, as the person switches transports.
  await f.controller.command({ type: "configure", config: { ...f.controller.state().config, publicOrigin } });
  assert.equal(f.controller.state().peers[0].grant.allowBrowser, false, "web transports never grant the project browser");
  assert.equal((await f.call("/g2/api/home", { token })).status, 403, "the phone-only transport restricts the glasses");

  await f.controller.command({ type: "configure", config: { ...f.controller.state().config, publicOrigin: "", interfaceName: "test" } });
  home = await f.call("/g2/api/home", { token });
  assert.equal(home.status, 200, "returning to LAN restores the glasses' routes");
  assert.equal(home.data.features.projectBrowser, true, "returning to LAN restores the person's browser permission");
  assert.equal(f.controller.state().config.allowBrowser, true);
  assert.equal((await f.call("/g2/api/terminal?id=one", { token })).status, 200);
});

test("the desktop-selected phone pairing target is summary-only and ignores client role claims", async (t) => {
  const f = await fixture(t);
  await f.enable();
  await f.controller.command({ type: "begin-pairing", target: "phone" });
  const response = await f.call("/g2/api/pair", { body: {
    code: f.controller.state().pairing.code,
    name: "Phone client",
    clientType: "even-g2",
    target: "even-g2",
    summaryOnly: false,
  } });
  assert.equal(response.status, 202);
  const pending = response.data;
  await f.controller.command({ type: "approve", id: pending.id });
  assert.equal((await f.call("/g2/api/home", { token: pending.token })).status, 403);
  assert.equal((await f.call("/g2/api/terminal?id=one", { token: pending.token })).status, 403);
  const saved = JSON.parse(await readFile(join(f.directory, "even-g2.json"), "utf8"));
  assert.equal(saved.peers[0].clientType, "phone");
  await assert.rejects(f.controller.command({
    type: "set-peer-type", id: pending.id, clientType: "even-g2",
  }), /not-ambiguous/);
});

test("legacy summary-only peers stay restricted until the desktop resolves their device type", async (t) => {
  const f = await fixture(t);
  await f.enable();
  const { token, id } = await f.pair();
  const path = join(f.directory, "even-g2.json");
  const legacy = JSON.parse(await readFile(path, "utf8"));
  delete legacy.peers[0].clientType;
  legacy.peers[0].summaryOnly = true;
  await writeFile(path, JSON.stringify(legacy));
  await f.controller.close();

  const restored = new EvenG2Controller(f.options);
  await restored.load();
  t.after(() => restored.close());
  assert.equal(restored.state().peers[0].clientType, "phone");
  assert.equal(restored.state().peers[0].needsReclassification, true);
  const localCall = async (controller, route) => fetch(
    `http://127.0.0.1:${controller.state().port}${route}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal((await localCall(restored, "/g2/api/home")).status, 403);

  await restored.command({ type: "set-peer-type", id, clientType: "even-g2" });
  assert.equal((await localCall(restored, "/g2/api/home")).status, 200);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.peers[0].clientType, "even-g2");
  assert.equal(saved.peers[0].needsReclassification, undefined);
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
  for (const [path, body] of [
    ["control", { sessionId: "one", action: "text", text: "no" }],
    ["session-close", { sessionId: "one" }],
    ["create", { provider: "codex" }],
    ["browser", { sessionId: "one" }],
  ])
    assert.ok(
      (await f.call("/g2/api/" + path, { token, body })).status >= 400,
      path,
    );
  assert.equal(f.writes.length + f.closed.length + f.creates.length, 0);
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
  for (const title of ["", "x".repeat(81), "\x1b[31m"])
    assert.ok(
      (
        await f.call("/g2/api/session-rename", {
          token,
          body: { sessionId: "one", title },
        })
      ).status >= 400,
    );
  assert.ok(
    (
      await f.call("/g2/api/session-rename", {
        token,
        body: { sessionId: "private", title: "No" },
      })
    ).status >= 400,
  );
  assert.equal(f.renames.length, 1);
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

test("default experimental opt-out preserves Even G2 access and blocks phone pairing", async t => {
  const f = await fixture(t, { experimentalEnabled: undefined });
  await f.enable();
  const { token } = await f.pair();
  assert.equal((await f.call("/g2/api/home", { token })).status, 200);
  assert.equal((await f.call("/g2/api/terminal?id=one", { token })).status, 200);
  await assert.rejects(f.controller.command({ type: "begin-pairing", target: "phone" }), /disabled/);
  assert.equal(f.controller.canReply("one"), false);
});

test("saved phone peers remain blocked after restart without experimental opt-in", async t => {
  const f = await fixture(t);
  await f.enable({ allowInput: true });
  await f.controller.command({ type: "begin-pairing", target: "phone" });
  const response = await f.call("/g2/api/pair", { body: { code: f.controller.state().pairing.code, name: "Phone" } });
  const phone = response.data;
  await f.controller.command({ type: "approve", id: phone.id });
  assert.equal(f.controller.canReply("one"), true);
  await f.controller.close();
  const restored = new EvenG2Controller({ ...f.options, experimentalEnabled: undefined });
  await restored.load();
  t.after(() => restored.close());
  assert.equal(restored.state().peers[0].clientType, "phone");
  assert.equal(restored.canReply("one"), false);
  const result = await fetch(`http://127.0.0.1:${restored.state().port}/g2/api/pair-status`, { headers: { Authorization: `Bearer ${phone.token}` } });
  assert.equal(result.status, 403);
});


test("glasses clears resolved attention while retaining notification history", async t => {
  const history=[];let loopActive=false;
  const f=await fixture(t,{notifications:()=>history,loopWarningActive:()=>loopActive});
  await f.enable();const {token}=await f.pair(), session=f.sessions[0];
  session.exitCode=null;
  const poll=async()=>{const response=await f.call('/g2/api/terminal?id=one',{token});assert.equal(response.status,200);return response.data.attention;};
  const publish=kind=>{const event={id:String(history.length),sessionId:'one',title:'one',kind,at:Date.now()};history.push(event);return event;};
  session.status='needs_approval';const approval=publish('approval');assert.deepEqual(await poll(),approval);
  session.status='working';assert.equal(await poll(),null,'accepted approval is not replayed');
  session.status='needs_approval';const nextApproval=publish('approval');assert.deepEqual(await poll(),nextApproval,'new permission request remains visible');
  session.status='idle';session.turnCompleted=false;const response=publish('response');assert.deepEqual(await poll(),response);
  session.turnCompleted=true;assert.equal(await poll(),null,'completed turn no longer asks for a response');
  const done=publish('done');assert.deepEqual(await poll(),done);
  session.status='working';assert.equal(await poll(),null,'new task clears completion notice');
  session.status='failed';const failed=publish('failed');assert.deepEqual(await poll(),failed);
  session.status='idle';session.turnCompleted=false;assert.equal(await poll(),null);
  session.taskBudget={warning:true,paused:false};const budget=publish('budget');assert.deepEqual(await poll(),budget);
  session.taskBudget={warning:false,paused:true};assert.deepEqual(await poll(),budget);
  session.taskBudget={warning:false,paused:false};assert.equal(await poll(),null,'reset budget clears notice');
  session.status='working';loopActive=true;const loop=publish('loop');assert.deepEqual(await poll(),loop);
  loopActive=false;assert.equal(await poll(),null,'expired or replaced host epoch clears loop notice');
  loopActive=true;session.exitCode=0;assert.equal(await poll(),null,'exited agent cannot keep an active loop notice');
  assert.equal(history.length,7,'resolving current attention never deletes historical events');
});


for(const mode of ['text','voice'])test(`accepted glasses ${mode} input resolves response attention until a fresh answer; failed input preserves it`,async t=>{
 const history=[{id:'response-1',sessionId:'one',title:'one',kind:'response',at:1}];
 const speech={available:true,model:'fixture',configure(){},async inspect(){},cancel(){},cancelAll(){},async run(body,accept){return{accepted:await accept('next task',()=>false),transcript:'next task'};}};
 const f=await fixture(t,{notifications:()=>history,speech});await f.enable();const {token}=await f.pair();
 const poll=async()=>{const result=await f.call('/g2/api/terminal?id=one',{token});assert.equal(result.status,200);return result.data.attention;};
 const send=()=>f.call(mode==='text'?'/g2/api/control':'/g2/api/voice',{token,body:mode==='text'?{sessionId:'one',action:'text',text:'next task'}:{sessionId:'one',purpose:'input',audio:Buffer.alloc(8000).toString('base64')}});
 assert.deepEqual(await poll(),history[0]);
 const write=f.options.terminals.inputChecked;f.options.terminals.inputChecked=()=>false;
 assert.ok((await send()).status>=400);assert.deepEqual(await poll(),history[0],'no write means no resolved attention');
 f.options.terminals.inputChecked=write;assert.equal((await send()).status,200);
 assert.equal(f.sessions[0].status,'idle','fixture provider emits no working event');
 assert.equal(await poll(),null);assert.equal(await poll(),null,'old notice stays cleared while provider remains idle');
 f.controller.answer('one','fresh answer','new-turn',Date.now()+60_000);history.push({...history[0],id:'response-2'});
 assert.deepEqual(await poll(),history[1],'captured fresh answer permits new response attention');
 assert.equal(history.length,2,'attention history remains untouched');
});

test('fallback response attention returns after real working-to-idle progress without captured answers',async t=>{
 const event={id:'response',sessionId:'one',title:'one',kind:'response',at:1};
 const f=await fixture(t,{notifications:()=>[event]});await f.enable();const {token}=await f.pair();
 const poll=async()=>(await f.call('/g2/api/terminal?id=one',{token})).data.attention;
 assert.deepEqual(await poll(),event);
 await f.call('/g2/api/control',{token,body:{sessionId:'one',action:'text',text:'next task'}});
 assert.equal(await poll(),null);
 f.sessions[0].status='working';f.controller.observe(IPC.terminalSession,{session:f.sessions[0]});
 f.sessions[0].status='idle';f.controller.observe(IPC.terminalSession,{session:f.sessions[0]});
 assert.deepEqual(await poll(),event,'working flag must not leave fallback response notices permanently suppressed');
 await f.call('/g2/api/control',{token,body:{sessionId:'one',action:'text',text:'another task'}});assert.equal(await poll(),null);
 const output='\x1b[2J\x1b[HNew fallback reply';
 f.controller.observe(IPC.terminalData,{id:'one',data:output,outputOffset:7+output.length});
 assert.deepEqual(await poll(),event,'a changed parsed reply also resolves pending input without lifecycle hooks');
});


test('terminal navigation and interrupt keys do not acknowledge response attention; replayed text cannot acknowledge a fresh response',async t=>{
 const history=[{id:'response-1',sessionId:'one',kind:'response',title:'one',at:1}];
 const f=await fixture(t,{notifications:()=>history});await f.enable({allowInput:true});
 const {connectionFromCode,localFetcher}=await import('../integrations/even-g2/src/local-fetch.mjs');
 const origin=f.controller.state().transport.origin;await f.controller.command({type:'begin-pairing'});
 const bootstrap=await connectionFromCode(f.controller.state().pairing.code,{origins:[origin],allowLoopback:true});
 const encrypted=localFetcher(bootstrap.connection,{allowLoopback:true});
 const paired=await encrypted(origin+'/g2/api/pair',{method:'POST',body:JSON.stringify({code:bootstrap.code,name:'Input regression'})});
 assert.equal(paired.status,202);const {token,id}=await paired.json();await f.controller.command({type:'approve',id});
 const poll=async()=>(await f.call('/g2/api/terminal?id=one',{token})).data.attention;
 assert.deepEqual(await poll(),history[0]);
 const mobile=action=>encrypted(origin+'/g2/api/mobile',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({version:1,id:randomBytes(16).toString('hex'),sentAt:Date.now(),action})});
 for(const key of ['up','down','left','right','backspace','escape','ctrl-c','enter']) {
  const writes=f.writes.length;
  assert.equal((await mobile({type:'session.key',sessionId:'one',key})).status,403,'glasses credentials cannot enter the separate phone API');
  assert.equal(f.writes.length,writes);
  assert.deepEqual(await poll(),history[0],`${key} is navigation/control, not a submitted response`);
 }
 // PR7 keeps phone and glasses routes separate; use an explicitly paired phone for its interrupt action.
 await f.controller.command({type:'begin-pairing',target:'phone'});
 const phoneBootstrap=await connectionFromCode(f.controller.state().pairing.code,{origins:[origin],allowLoopback:true});
 const phoneSend=localFetcher(phoneBootstrap.connection,{allowLoopback:true});
 const phoneResponse=await phoneSend(origin+'/g2/api/pair',{method:'POST',body:JSON.stringify({code:phoneBootstrap.code,name:'Interrupt regression'})});
 assert.equal(phoneResponse.status,202);const phone=await phoneResponse.json();await f.controller.command({type:'approve',id:phone.id});
 const interrupted=await phoneSend(origin+'/g2/api/mobile',{method:'POST',headers:{Authorization:'Bearer '+phone.token},body:JSON.stringify({version:1,id:randomBytes(16).toString('hex'),sentAt:Date.now(),action:{type:'session.interrupt',sessionId:'one'}})});
 assert.equal(interrupted.status,200);assert.deepEqual(await poll(),history[0]);
 const body={sessionId:'one',action:'text',text:'answer',requestId:randomBytes(16).toString('hex'),sentAt:Date.now()};
 assert.equal((await f.call('/g2/api/control',{token,body})).status,200);assert.equal(await poll(),null);
 f.controller.answer('one','fresh answer','fresh',Date.now()+60000);history.push({...history[0],id:'response-2'});
 assert.deepEqual(await poll(),history[1]);const writes=f.writes.length;
 assert.equal((await f.call('/g2/api/control',{token,body})).status,200);assert.equal(f.writes.length,writes);
 assert.deepEqual(await poll(),history[1],'ledger replay does not acknowledge a newer response');
});

test('newest current attention survives newer resolved events without mutating history or resurrecting an acknowledged approval',async t=>{
 const history=[];let loopActive=false;
 const f=await fixture(t,{notifications:()=>history,loopWarningActive:()=>loopActive});
 f.sessions[0].provider='codex';f.sessions[0].status='needs_approval';f.sessions[0].exitCode=null;
 const menu='Would you like to run this command?\n$ npm test\n\n› 1. Yes, proceed (y)\n  2. No (esc)\n\nPress enter to confirm or esc to cancel';
 f.options.terminals.readBuffer=()=>({buffer:menu,outputOffset:menu.length});
 await f.enable();const {token}=await f.pair();
 const publish=kind=>{const event={id:String(history.length),sessionId:'one',title:'one',kind,at:history.length};history.push(event);return event;};
 const read=async()=>{const response=await f.call('/g2/api/terminal?id=one',{token});assert.equal(response.status,200);return response.data;};
 const approval=publish('approval');assert.deepEqual((await read()).attention,approval);
 f.sessions[0].taskBudget={warning:true,paused:false};const budget=publish('budget');assert.deepEqual((await read()).attention,budget);
 loopActive=true;const loop=publish('loop');assert.deepEqual((await read()).attention,loop);
 loopActive=false;assert.deepEqual((await read()).attention,budget);
 f.sessions[0].taskBudget.warning=false;assert.deepEqual((await read()).attention,approval,'resolved budget cannot hide pending approval');
 history.push({...approval,id:'foreign',sessionId:'private'});assert.deepEqual((await read()).attention,approval,'history callback cannot leak another session');
 const view=await read();assert.ok(view.interaction);
 assert.equal((await f.call('/g2/api/control',{token,body:{sessionId:'one',action:'choose',menuId:view.interaction.id,index:0}})).status,200);
 assert.equal((await read()).attention,null,'selected approval cannot return through history fallback');
 assert.deepEqual(history.map(e=>e.id),['0','1','2','foreign'],'search does not reverse or delete retained history');
});

test('response history fallback respects observed progress and submitted input even when intermediate states are not polled',async t=>{
 const response={id:'response',sessionId:'one',title:'one',kind:'response',at:1},history=[response];
 const f=await fixture(t,{notifications:()=>history});await f.enable();const {token}=await f.pair();
 const session=f.sessions[0],poll=async()=>(await f.call('/g2/api/terminal?id=one',{token})).data.attention;
 const status=value=>{session.status=value;f.controller.observe(IPC.terminalSession,{session});};
 assert.deepEqual(await poll(),response);
 status('failed');status('idle');assert.equal(await poll(),null,'failed→idle cannot revive an earlier response notice');
 status('working');status('idle');assert.deepEqual(await poll(),response,'fresh response can reuse a coalesced notification after real progress');
 session.taskBudget={warning:true,paused:false};const budget={...response,id:'budget',kind:'budget'};history.push(budget);
 assert.deepEqual(await poll(),budget);session.taskBudget.warning=false;assert.deepEqual(await poll(),response);
 assert.equal((await f.call('/g2/api/control',{token,body:{sessionId:'one',action:'text',text:'answered'}})).status,200);
 assert.equal(await poll(),null,'resolved newer budget must not resurrect a submitted response');
});
