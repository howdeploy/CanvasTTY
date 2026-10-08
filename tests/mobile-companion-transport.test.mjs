import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { EvenG2Controller } from "../src/main/services/companion/EvenG2Controller.ts";
import { HumanQuestionService } from "../src/main/services/HumanQuestionService.ts";
import { sealLocal, unsealLocal, localOrigin, validateLocalConnection } from "../src/shared/localLink.ts";
import { connectionFromCode, localFetcher } from "../integrations/even-g2/src/local-fetch.mjs";

async function fixture(t, { lan = false, httpsOrigin = "", questions: withQuestions = false, experimentalEnabled = () => true, notifications = () => [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-mobile-test-"));
  const webRoot = join(directory, "g2"), mobileRoot = join(directory, "mobile");
  await mkdir(webRoot);
  await mkdir(mobileRoot);
  await writeFile(join(mobileRoot, "index.html"), "<h1>Mobile</h1>");
  await writeFile(join(directory, "private.txt"), "not public");
  let symlinkAvailable = true;
  try {
    await symlink(join(directory, "private.txt"), join(mobileRoot, "escape.txt"));
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error;
    symlinkAvailable = false;
  }
  const writes = [];
  const sessions = [{ id: "one", title: "One", provider: "terminal", status: "idle", startedAt: 100, exitCode: null, revision: 2 }];
  const questions = withQuestions ? new HumanQuestionService({
    getSession: id => { const row = sessions.find(row => row.id === id); return row ? { ...row, turnEpoch: 1 } : null; },
    redact: value => value,
  }) : undefined;
  const terminals = {
    redactSecrets: value => value,
    listMetadata: () => sessions.map((s) => ({ ...s, cwd: "/private/workspace" })),
    geometry: () => ({ cols: 80, rows: 24 }),
    readBuffer: () => ({ buffer: "hello", outputOffset: 5 }),
    inputChecked: (id, data) => { writes.push({ id, data }); return true; },
    dispose: (id) => { sessions.splice(sessions.findIndex((s) => s.id === id), 1); },
    rename: (id, title) => { const s = sessions.find((s) => s.id === id); s.title = title; return s; },
    create: ({ provider }) => { const s = { id: "new", title: "New", provider, status: "idle", startedAt: 200, exitCode: null, revision: 1 }; sessions.push(s); return s; },
  };
  const controller = new EvenG2Controller({
    experimentalEnabled,
    notifications,
    humanQuestions: questions,
    userDataPath: directory, webRoot, mobileRoot, terminals, speechWorker: join(directory, "missing.py"),
    port: 0, addresses: () => [{ id: "test:127.0.0.1", name: "test", address: "127.0.0.1" }], localDiscovery: false,
    providerAvailability: () => ({}),
    limits: async () => ({ fetchedAt: Date.now(), providers: [] }),
    openBrowser: async () => ({ title: "", url: "" }),
  });
  await controller.load();
  t.after(async () => { questions?.close(); await controller.close(); await rm(directory, { recursive: true, force: true }); });
  const tailnetOrigin = "https://computer.tailnet.ts.net";
  const configuredOrigin = lan ? "" : httpsOrigin || tailnetOrigin;
  await controller.command({ type: "configure", config: {
    ...controller.state().config, enabled: true, workspace: directory,
    interfaceName: "test", publicOrigin: configuredOrigin,
    sessionIds: ["one"], allowClose: true, allowCreate: true, allowBrowser: true,
  } });
  const origin = lan ? controller.state().transport.origin : configuredOrigin;
  const base = `http://127.0.0.1:${controller.state().port}`;
  const direct = (path, body, token, host = new URL(origin).host) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(base + path, {
      method: payload === undefined ? "GET" : "POST",
      headers: { Host: host, "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    }, res => {
      const parts = [];
      res.on("data", part => parts.push(part));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        resolve({ status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? JSON.parse(text) : text });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
  const fetcher = (url, options = {}) => fetch(base + new URL(url).pathname + new URL(url).search, {
    ...options,
    headers: { ...Object.fromEntries(new Headers(options.headers)), Host: new URL(origin).host },
  });
  const pair = async () => {
    await controller.command({ type: "begin-pairing", target: "phone" });
    const code = controller.state().pairing.code;
    if (configuredOrigin === tailnetOrigin) assert.equal((await direct("/g2/api/pair", { code })).status, 403);
    const bootstrap = await connectionFromCode(code, { origins: [origin], fetcher, allowLoopback: origin.startsWith("http:") });
    const send = localFetcher(bootstrap.connection, { fetcher, allowLoopback: origin.startsWith("http:") });
    const response = await send(origin + "/g2/api/pair", {
      method: "POST", body: JSON.stringify({ code: bootstrap.code, name: "Even App", clientType: "even-g2", target: "even-g2", summaryOnly: false }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    const connection = validateLocalConnection(send.connection(), origin.startsWith("http:"));
    assert.equal(connection.deviceId, body.id);
    return { ...body, connection };
  };
  const encrypted = async ({ connection, token }, action, id = randomBytes(16).toString("hex")) => {
    const request = { version: 1, id, sentAt: Date.now(), action };
    const packet = await sealLocal(connection, { path: "/g2/api/mobile", method: "POST", token,
      body: request, sentAt: Date.now() }, "request");
    const response = await direct("/g2/link", packet);
    assert.equal(response.status, 200);
    return unsealLocal(connection, response.body, "response");
  };
  const encryptedPath = async ({ connection, token }, path, method = "GET", body) => {
    const packet = await sealLocal(connection, {
      path, method, token, ...(body === undefined ? {} : { body }), sentAt: Date.now(),
    }, "request");
    const response = await direct("/g2/link", packet);
    assert.equal(response.status, 200);
    return unsealLocal(connection, response.body, "response");
  };
  return { controller, direct, pair, encrypted, encryptedPath, writes, sessions, questions, directory, origin, base, symlinkAvailable };
}

test("HTTPS origin pairs over proxied routes, encrypted mobile forwards; plaintext bearer cannot act", async (t) => {
  const f = await fixture(t, { notifications: (channel, id) => channel === "phone" && id === "one"
    ? [{ id: "notice-1", kind: "done", at: 200, message: "/private notification body" }] : [] });
  const discover = await f.direct("/g2/discover");
  assert.equal(discover.status, 200);
  const pending = await f.pair();
  const action = { type: "session.interrupt", sessionId: "one" };
  assert.equal((await f.encrypted(pending, action)).status, 401);
  assert.equal(f.writes.length, 0);
  await f.controller.command({ type: "approve", id: pending.id });
  assert.equal((await f.direct("/g2/api/mobile", { version: 1, id: randomBytes(16).toString("hex"), sentAt: Date.now(), action }, pending.token)).status, 403);
  assert.equal(f.controller.state().peers[0].lastSeen, 0);
  const overview = await f.encrypted(pending, { type: "sessions.overview" });
  assert.equal(overview.status, 200);
  const lastSeen = f.controller.state().peers[0].lastSeen;
  assert.ok(lastSeen > 0 && lastSeen <= Date.now());
  const first = await f.encrypted(pending, action, "a".repeat(32));
  const repeated = await f.encrypted(pending, action, "a".repeat(32));
  assert.equal(first.status, 200);
  assert.equal(repeated.status, 200);
  assert.deepEqual(f.writes, [{ id: "one", data: "\x03" }]);
  assert.deepEqual(overview.body.sessions, [{ id: "one", title: "One", provider: "terminal", status: "idle", startedAt: 100, exitCode: null, revision: 2, attention: [{ id: "notice-1", kind: "done", at: 200 }] }]);
  assert.equal(overview.body.providers.terminal, false);
  assert.deepEqual(overview.body.permissions, {
    allowInput: false, allowCreate: false, allowClose: true, allowInterrupt: true, allowRename: true,
  });
  assert.equal(JSON.stringify(overview).includes("/private"), false);
  assert.equal((await f.encrypted(pending, { type: "browser.open", sessionId: "one" })).status, 400);
  assert.equal((await f.encrypted(pending, { type: "session.key", sessionId: "one", key: "bad" })).status, 400);
  await f.controller.command({ type: "revoke", id: pending.id });
  await assert.rejects(f.encrypted(pending, action));
  assert.equal(f.writes.length, 1);
});

test("phone grants cannot be escalated into terminal input, key presses, or new sessions", async (t) => {
  const f = await fixture(t, { questions: true });
  f.sessions[0].provider = "codex";
  assert.equal(f.controller.canReply("one"), false);
  const pending = await f.pair();
  await f.controller.command({ type: "approve", id: pending.id });
  assert.equal(f.controller.canReply("one"), true);
  assert.equal(f.controller.canReply("private"), false);
  const answer = f.questions.request("one", { question: "Approve this request?", options: ["Approve once", "Deny"] });
  const view = await f.encrypted(pending, { type: "session.read", sessionId: "one" });
  const reply = { type: "session.reply", sessionId: "one", requestId: view.body.question.id, answer: 0 };
  assert.equal(view.body.question.question, "Approve this request?");
  assert.equal((await f.encrypted(pending, reply)).status, 200);
  assert.deepEqual(await answer, { answer: "Approve once", selectedIndex: 0 });
  assert.equal((await f.encrypted(pending, reply)).body.error, "stale-request", "a new receipt cannot answer a consumed question");

  const saved = JSON.parse(await readFile(join(f.directory, "even-g2.json"), "utf8"));
  assert.equal(saved.peers[0].clientType, "phone", "the host stores the phone capability independently of transport");
  for (const action of [
    { type: "session.input", sessionId: "one", text: "whoami" },
    { type: "session.key", sessionId: "one", key: "enter" },
    { type: "session.create", provider: "terminal" },
  ]) {
    assert.ok((await f.encrypted(pending, action)).status >= 400, action.type);
  }
  assert.equal(f.writes.length, 0);
  for (const { path, body } of [
    { path: "/g2/api/home" },
    { path: "/g2/api/terminal?id=one" },
    { path: "/g2/api/control", body: { sessionId: "one", action: "text", text: "whoami" } },
    { path: "/g2/api/create", body: { provider: "terminal" } },
    { path: "/g2/api/browser", body: { sessionId: "one" } },
  ]) {
    assert.equal((await f.direct(path, body, pending.token)).status, 403, `phone cannot use ${path}`);
  }
});

test("a desktop-selected phone client uses encrypted summary routes over LAN", async (t) => {
  const f = await fixture(t, { lan: true });
  assert.match(f.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const phone = await f.pair();
  await f.controller.command({ type: "approve", id: phone.id });

  assert.equal((await f.direct("/g2/api/home", undefined, phone.token)).status, 403);
  assert.equal((await f.direct("/g2/api/mobile", { version: 1, id: "a".repeat(32), sentAt: Date.now(), action: { type: "sessions.overview" } }, phone.token)).status, 403);
  const overview = await f.encrypted(phone, { type: "sessions.overview" });
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.body.permissions, {
    allowInput: false, allowCreate: false, allowClose: true, allowInterrupt: true, allowRename: true,
  });

  const legacyRoute = await f.encryptedPath(phone, "/g2/api/home");
  assert.equal(legacyRoute.status, 403);
  const legacyTerminal = await f.encryptedPath(phone, "/g2/api/terminal?id=one");
  assert.equal(legacyTerminal.status, 403);
  assert.equal(f.writes.length, 0);
});

test("a desktop-selected phone client keeps summary-only routes behind a private HTTPS origin", async (t) => {
  const f = await fixture(t, { httpsOrigin: "https://192.168.1.55:8443" });
  const phone = await f.pair();
  await f.controller.command({ type: "approve", id: phone.id });

  const overview = await f.encrypted(phone, { type: "sessions.overview" });
  assert.equal(overview.status, 200);
  assert.equal((await f.encryptedPath(phone, "/g2/api/home")).status, 403);
  assert.equal(f.writes.length, 0);
});

test("Tailnet peer cannot access legacy G2 API through bearer or encrypted link", async (t) => {
  const f = await fixture(t);
  const peer = await f.pair();
  const pendingPacket = await sealLocal(peer.connection, {
    path: "/g2/api/pair-status", method: "GET", token: peer.token, sentAt: Date.now(),
  }, "request");
  const pendingResponse = await f.direct("/g2/link", pendingPacket);
  assert.deepEqual((await unsealLocal(peer.connection, pendingResponse.body, "response")).body, { state: "pending" });
  await f.controller.command({ type: "approve", id: peer.id });
  assert.equal(f.controller.state().peers[0].grant.allowBrowser, false, "a web transport never grants the project browser");
  assert.equal(f.controller.state().config.allowBrowser, true, "the person's LAN choice is kept for a later switch back");

  const legacy = [
    { path: "/g2/api/home", method: "GET" },
    { path: "/g2/api/terminal?id=one", method: "GET" },
    { path: "/g2/api/browser", method: "POST", body: { sessionId: "one", requestId: randomBytes(16).toString("hex"), sentAt: Date.now() } },
    { path: "/g2/api/voice", method: "POST", body: { sessionId: "one", requestId: randomBytes(16).toString("hex"), sentAt: Date.now() } },
  ];
  for (const { path, method, body } of legacy) {
    assert.equal((await f.direct(path, body, peer.token)).status, 403, `direct ${path}`);
    const packet = await sealLocal(peer.connection, { path, method, body, token: peer.token, sentAt: Date.now() }, "request");
    const encrypted = await f.direct("/g2/link", packet);
    assert.equal(encrypted.status, 200);
    assert.equal((await unsealLocal(peer.connection, encrypted.body, "response")).status, 403, `encrypted ${path}`);
  }
  const probe = await sealLocal(peer.connection, {
    path: "/g2/api/home", method: "GET", token: "", sentAt: Date.now(),
  }, "request");
  const response = await f.direct("/g2/link", probe);
  assert.equal((await unsealLocal(peer.connection, response.body, "response")).status, 401);
  assert.equal((await f.direct("/g2/api/pair-status", undefined, peer.token)).status, 403);
});

test("phone control actions stay scoped and idempotent, while creation is denied", async (t) => {
  const f = await fixture(t);
  const paired = await f.pair();
  await f.controller.command({ type: "approve", id: paired.id });
  const action = { type: "session.interrupt", sessionId: "one" };
  const created = await f.encrypted(paired, action, "c".repeat(32));
  const repeated = await f.encrypted(paired, action, "c".repeat(32));
  assert.equal(created.status, 200);
  assert.deepEqual(repeated, created);
  assert.deepEqual(f.writes, [{ id: "one", data: "\x03" }]);
  const overview = await f.encrypted(paired, { type: "sessions.overview" });
  assert.deepEqual(overview.body.sessions.map((s) => s.id), ["one"]);
  assert.equal(overview.body.providers.terminal, false);
  const stored = JSON.parse(await readFile(join(f.directory, "even-g2.json"), "utf8"));
  assert.deepEqual(stored.peers[0].grant.sessionIds, ["one"]);
  assert.equal((await f.encrypted(paired, { type: "session.create", provider: "terminal" })).status, 400);
  await f.controller.command({ type: "configure", config: { ...f.controller.state().config, allowInput: false } });
  assert.ok((await f.encrypted(paired, { type: "session.rename", sessionId: "one", title: "x" })).status >= 400);
  assert.equal(f.writes.length, 1);
});

test("USB loopback mode keeps mobile pairing read-only and blocks legacy routes", async (t) => {
  const f = await fixture(t);
  const origin = f.base;
  for (const invalid of [
    origin.replace("127.0.0.1", "localhost"),
    origin.replace("127.0.0.1", "192.168.1.2"),
    `http://127.0.0.1:${f.controller.state().port + 1}`,
    `http://user@127.0.0.1:${f.controller.state().port}`,
    origin + "/mobile/",
    origin + "?code=123456",
    origin + "#fragment",
  ]) {
    await assert.rejects(f.controller.command({ type: "configure", config: {
      ...f.controller.state().config, publicOrigin: invalid,
    } }), `invalid origin ${invalid}`);
  }
  await f.controller.command({ type: "configure", config: {
    ...f.controller.state().config, publicOrigin: origin, allowInput: false,
    allowCreate: false, allowClose: false, allowBrowser: true,
  } });
  assert.equal(f.controller.state().transport.kind, "usb");
  assert.equal(f.controller.state().config.allowBrowser, true, "the stored LAN choice is kept; the USB grant withholds it");
  assert.equal((await f.direct("/mobile/", undefined, undefined, "localhost:" + f.controller.state().port)).status, 403);
  assert.equal((await f.direct("/mobile/", undefined, undefined, new URL(origin).host)).status, 200);
  await f.controller.command({ type: "begin-pairing" });
  const code = f.controller.state().pairing.code;
  const fetcher = (url, options = {}) => fetch(new URL(url).href, options);
  const bootstrap = await connectionFromCode(code, { origins: [origin], fetcher, allowLoopback: true });
  const send = localFetcher(bootstrap.connection, { fetcher, allowLoopback: true });
  const response = await send("/g2/api/pair", {
    method: "POST", body: JSON.stringify({ code, name: "USB browser" }),
  });
  assert.equal(response.status, 202);
  const { id, token } = await response.json();
  const connection = validateLocalConnection(send.connection(), true);
  const encryptedRequest = async (path, method = "GET", body) => {
    const packet = await sealLocal(connection, { path, method, body, token, sentAt: Date.now() }, "request");
    const forwarded = await f.direct("/g2/link", packet, undefined, new URL(origin).host);
    assert.equal(forwarded.status, 200);
    return unsealLocal(connection, forwarded.body, "response");
  };
  assert.equal((await encryptedRequest("/g2/api/pair-status")).body.state, "pending");
  assert.equal((await encryptedRequest("/g2/api/mobile", "POST", {
    version: 1, id: randomBytes(16).toString("hex"), sentAt: Date.now(),
    action: { type: "sessions.overview" },
  })).status, 401);
  await f.controller.command({ type: "approve", id });
  assert.equal(f.controller.state().peers[0].grant.allowBrowser, false);
  const overview = await encryptedRequest("/g2/api/mobile", "POST", {
    version: 1, id: randomBytes(16).toString("hex"), sentAt: Date.now(),
    action: { type: "sessions.overview" },
  });
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.body.sessions.map((session) => session.id), ["one"]);
  assert.equal((await encryptedRequest("/g2/api/mobile", "POST", {
    version: 1, id: randomBytes(16).toString("hex"), sentAt: Date.now(),
    action: { type: "session.key", sessionId: "one", key: "enter" },
  })).status >= 400, true);
  assert.equal((await encryptedRequest("/g2/api/home")).status, 403);
  assert.equal((await f.direct("/g2/api/home", undefined, token, new URL(origin).host)).status, 403);
  assert.equal(f.writes.length, 0);
  await f.controller.command({ type: "revoke", id });
  await assert.rejects(encryptedRequest("/g2/api/mobile", "POST", {
    version: 1, id: randomBytes(16).toString("hex"), sentAt: Date.now(),
    action: { type: "sessions.overview" },
  }));
});

test("Tailscale connection allows only exact HTTPS origin; mobile static stays within build root", async (t) => {
  const f = await fixture(t);
  assert.equal(localOrigin(f.origin), f.origin);
  for (const invalid of ["https://evil.example", "https://computer.tailnet.ts.net:444", "http://computer.tailnet.ts.net:80", "https://computer.tailnet.ts.net.evil.test"])
    assert.throws(() => localOrigin(invalid));
  const page = await fetch(f.base + "/mobile/", { headers: { Host: f.origin.slice(8) } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Mobile/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  if (f.symlinkAvailable) {
    const escaped = await f.direct("/mobile/escape.txt");
    assert.equal(escaped.status, 404);
  }
  assert.equal((await f.direct("/mobile/", undefined, undefined, "evil.test")).status, 403);
});

test("phone opt-out blocks pairing, saved peers, mobile files and human replies at runtime", async t => {
  let enabled = true;
  const f = await fixture(t, { lan: true, questions: true, experimentalEnabled: () => enabled });
  const phone = await f.pair();
  await f.controller.command({ type: "approve", id: phone.id });
  assert.equal((await f.encrypted(phone, { type: "sessions.overview" })).status, 200);
  enabled = false;
  assert.equal(f.controller.canReply("one"), false);
  await assert.rejects(f.controller.command({ type: "begin-pairing", target: "phone" }), /disabled/);
  assert.equal((await f.direct("/mobile/")).status, 403);
  assert.equal((await f.direct("/g2/api/pair-status", undefined, phone.token)).status, 403);
  assert.equal((await f.direct("/g2/api/mobile", {}, phone.token)).status, 403);
  // Device access is rejected before decrypting/forwarding an existing saved phone's packet.
  await assert.rejects(f.encrypted(phone, { type: "session.interrupt", sessionId: "one" }));
  assert.equal(f.writes.length, 0);
  enabled = true;
  assert.equal((await f.encrypted(phone, { type: "sessions.overview" })).status, 200);
});

test("phone companion fails closed without an injected opt-in", async t => {
  const f = await fixture(t, { experimentalEnabled: null });
  await assert.rejects(f.pair(), /disabled/);
  assert.equal((await f.direct("/mobile/")).status, 403);
});
