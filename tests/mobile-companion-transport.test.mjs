import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { EvenG2Controller } from "../src/main/services/companion/EvenG2Controller.ts";
import { sealLocal, unsealLocal, localOrigin, validateLocalConnection } from "../src/shared/localLink.ts";
import { connectionFromCode, localFetcher } from "../integrations/even-g2/src/local-fetch.mjs";

async function fixture(t) {
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
  const terminals = {
    listMetadata: () => sessions.map((s) => ({ ...s, cwd: "/private/workspace" })),
    getMetadata: (id) => sessions.find((s) => s.id === id) ?? null,
    geometry: () => ({ cols: 80, rows: 24 }),
    readBuffer: () => ({ buffer: "hello", outputOffset: 5 }),
    inputChecked: (id, data) => { writes.push({ id, data }); return true; },
    dispose: (id) => { sessions.splice(sessions.findIndex((s) => s.id === id), 1); },
    rename: (id, title) => { const s = sessions.find((s) => s.id === id); s.title = title; return s; },
    create: ({ provider }) => { const s = { id: "new", title: "New", provider, status: "idle", startedAt: 200, exitCode: null, revision: 1 }; sessions.push(s); return s; },
  };
  const controller = new EvenG2Controller({
    userDataPath: directory, webRoot, mobileRoot, terminals, speechWorker: join(directory, "missing.py"),
    port: 0, addresses: () => [], localDiscovery: false,
    providerAvailability: () => ({}),
    limits: async () => ({ fetchedAt: Date.now(), providers: [] }),
    openBrowser: async () => ({ title: "", url: "" }),
  });
  await controller.load();
  t.after(async () => { await controller.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = "https://computer.tailnet.ts.net";
  await controller.command({ type: "configure", config: {
    ...controller.state().config, enabled: true, workspace: directory, publicOrigin: origin,
    sessionIds: ["one"], allowClose: true, allowCreate: true, allowBrowser: true,
  } });
  const base = `http://127.0.0.1:${controller.state().port}`;
  const direct = (path, body, token, host = origin.slice(8)) => new Promise((resolve, reject) => {
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
    headers: { ...Object.fromEntries(new Headers(options.headers)), Host: origin.slice(8) },
  });
  const pair = async () => {
    await controller.command({ type: "begin-pairing" });
    const code = controller.state().pairing.code;
    assert.equal((await direct("/g2/api/pair", { code })).status, 403);
    const bootstrap = await connectionFromCode(code, { origins: [origin], fetcher });
    const send = localFetcher(bootstrap.connection, { fetcher });
    const response = await send(origin + "/g2/api/pair", {
      method: "POST", body: JSON.stringify({ code: bootstrap.code, name: "Web test" }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    const connection = validateLocalConnection(send.connection());
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
  return { controller, direct, pair, encrypted, writes, directory, origin, base, symlinkAvailable };
}

test("HTTPS origin pairs over proxied routes, encrypted mobile forwards; plaintext bearer cannot act", async (t) => {
  const f = await fixture(t);
  const discover = await f.direct("/g2/discover");
  assert.equal(discover.status, 200);
  const pending = await f.pair();
  const action = { type: "session.key", sessionId: "one", key: "enter" };
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
  assert.deepEqual(f.writes, [{ id: "one", data: "\r" }]);
  assert.deepEqual(overview.body.sessions, [{ id: "one", title: "One", provider: "terminal", status: "idle", startedAt: 100, exitCode: null, revision: 2 }]);
  assert.equal(overview.body.providers.terminal, true);
  assert.equal(JSON.stringify(overview).includes("/private"), false);
  assert.equal((await f.encrypted(pending, { type: "browser.open", sessionId: "one" })).status, 400);
  assert.equal((await f.encrypted(pending, { type: "session.key", sessionId: "one", key: "bad" })).status, 400);
  await f.controller.command({ type: "revoke", id: pending.id });
  await assert.rejects(f.encrypted(pending, action));
  assert.equal(f.writes.length, 1);
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
  assert.equal(f.controller.state().peers[0].grant.allowBrowser, true);

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

test("encrypted mutations stay scoped and idempotent, and created grants persist", async (t) => {
  const f = await fixture(t);
  const paired = await f.pair();
  await f.controller.command({ type: "approve", id: paired.id });
  const action = { type: "session.create", provider: "terminal" };
  const created = await f.encrypted(paired, action, "c".repeat(32));
  const repeated = await f.encrypted(paired, action, "c".repeat(32));
  assert.equal(created.status, 200);
  assert.deepEqual(repeated, created);
  assert.equal(created.body.id, "new");
  assert.deepEqual((await f.encrypted(paired, { type: "sessions.overview" })).body.sessions.map((s) => s.id), ["one", "new"]);
  const stored = JSON.parse(await readFile(join(f.directory, "even-g2.json"), "utf8"));
  assert.deepEqual(stored.peers[0].grant.sessionIds, ["one", "new"]);
  await f.controller.command({ type: "configure", config: { ...f.controller.state().config, allowInput: false } });
  assert.equal((await f.encrypted(paired, { type: "session.key", sessionId: "one", key: "enter" })).status, 403);
  assert.equal(f.writes.length, 0);
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
  assert.equal(f.controller.state().config.allowBrowser, false);
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
  })).status, 403);
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
