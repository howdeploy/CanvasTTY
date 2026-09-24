import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  localOrigin,
  randomLocalHex,
  sealLocal,
  unsealLocal,
  validateLocalRequest,
} from "../src/shared/localLink.ts";
import { LocalLink } from "../src/main/services/companion/LocalLink.ts";
import { localFetcher } from "../integrations/even-g2/src/local-fetch.mjs";
import { SpeechSetup } from "../src/main/services/companion/SpeechSetup.ts";
import { createHash } from "node:crypto";
const connection = () => ({
  version: 1,
  computer: randomLocalHex(),
  key: randomLocalHex(),
  deviceId: randomLocalHex(16),
  origins: [
    "http://192.168.2.3:3481",
    "http://[fdea::123]:3481",
    "http://example.local:3481",
  ],
});
test("local endpoints reject public, loopback and credential URLs", () => {
  for (const url of [
    "https://example.com:3481",
    "http://example.com:3481",
    "http://8.8.8.8:3481",
    "http://127.0.0.1:3481",
    "http://192.168.1.1:3481/secret",
    "http://u:p@192.168.1.1:3481",
    "http://192.168.1.1:3481?x=1",
    "http://[2001:db8::1]:3481",
  ])
    assert.throws(() => localOrigin(url));
});
test("local encryption binds computer, packet and direction, and hides bearer and PCM", async () => {
  const c = connection();
  const p = await sealLocal(
    c,
    { token: "secret bearer", audio: "PCM" },
    "request",
  );
  assert.ok(!JSON.stringify(p).includes("secret"));
  assert.equal((await unsealLocal(c, p, "request")).audio, "PCM");
  await assert.rejects(
    unsealLocal({ ...c, computer: randomLocalHex() }, p, "request"),
  );
  await assert.rejects(unsealLocal(c, p, "response"));
  await assert.rejects(
    unsealLocal(c, { ...p, id: randomLocalHex(16) }, "request"),
  );
  assert.throws(() =>
    validateLocalRequest({
      path: "//example.com",
      method: "GET",
      token: "",
      sentAt: Date.now(),
    }),
  );
});
test("local address fallback probes without credentials and never retries an uncertain mutation", async () => {
  const c = connection();
  let actual = 0,
    probes = 0;
  const fetcher = async (url, options) => {
    const p = JSON.parse(options.body),
      r = await unsealLocal(c, p, "request");
    if (r.token === "") probes++;
    if (url.startsWith(c.origins[0])) throw new Error("VPN blocks IPv4");
    if (r.token) {
      actual++;
      throw new Error("Reply lost after write");
    }
    return new Response(
      JSON.stringify(
        await sealLocal(c, { status: 401, body: {} }, "response", p.id),
      ),
    );
  };
  const send = localFetcher(c, { fetcher });
  await assert.rejects(
    send(c.origins[0] + "/g2/api/control", {
      method: "POST",
      headers: { Authorization: "Bearer " + "b".repeat(64) },
      body: JSON.stringify({ action: "text" }),
    }),
    /локальной связи/,
  );
  assert.equal(actual, 1);
  assert.equal(probes, 3);
});
test("local encrypted duplicate is idempotent and identity survives restart", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "local-link-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const link = new LocalLink(path);
  await link.load();
  const id = randomLocalHex(16);
  const c = link.deviceConnection(id, ["http://192.168.1.2:3481"]);
  const next = new LocalLink(path);
  await next.load();
  assert.deepEqual(next.deviceConnection(id, c.origins), c);
  const packet = await sealLocal(
    c,
    { path: "/g2/api/home", method: "GET", token: "", sentAt: Date.now() },
    "request",
  );
  let calls = 0;
  const forward = async () => {
    calls++;
    return { status: 401, body: {} };
  };
  await Promise.all([
    link.receive(packet, forward, () => true),
    link.receive(packet, forward, () => true),
  ]);
  assert.equal(calls, 1);
});
test("legacy shared transport identity rotates before deriving device keys", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "local-link-legacy-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const computer = randomLocalHex(), oldKey = randomLocalHex();
  await writeFile(join(path, "even-g2-local.json"), JSON.stringify({ computer, key: oldKey }));
  const link = new LocalLink(path);
  await link.load();
  const device = link.deviceConnection(randomLocalHex(16), []);
  assert.equal(device.computer, computer);
  assert.notEqual(device.key, oldKey);
  const migrated = JSON.parse(await readFile(join(path, "even-g2-local.json"), "utf8"));
  assert.equal(migrated.version, 2);
  assert.notEqual(migrated.key, oldKey);
});
test("bootstrap keys cannot forward authenticated API actions and are cleared after pairing", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "local-link-bootstrap-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const link = new LocalLink(path);
  await link.load();
  const id = randomLocalHex(), key = randomLocalHex();
  const connection = link.bootstrapConnection(id, key, ["http://192.168.1.2:3481"]);
  link.registerBootstrap(id, key, Date.now() + 120_000);
  let forwarded = 0;
  const packet = await sealLocal(connection, {
    path: "/g2/api/control",
    method: "POST",
    token: randomLocalHex(),
    body: { sessionId: "one", action: "text", text: "blocked" },
    sentAt: Date.now(),
  }, "request");
  const reply = await link.receive(packet, async () => {
    forwarded++;
    return { status: 200, body: {} };
  }, () => false);
  assert.equal((await unsealLocal(connection, reply, "response")).status, 409);
  assert.equal(forwarded, 0);
  link.clearBootstraps();
  await assert.rejects(link.receive(packet, async () => ({ status: 200, body: {} }), () => false));
});
test("speech preparation checks model bytes before accepting a download; bad download stays unavailable", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "speech-setup-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const binary = join(path, "helper");
  await writeFile(binary, "fixture");
  const data = Buffer.from("model-fixture");
  const model = {
    name: "Test",
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    url: "https://model.example/pinned",
  };
  const setup = new SpeechSetup({
    userDataPath: path,
    binary,
    model,
    fetcher: async () => new Response(data),
  });
  await setup.prepare();
  assert.equal(setup.state().phase, "ready");
  const bad = new SpeechSetup({
    userDataPath: join(path, "bad"),
    binary,
    model,
    fetcher: async () => new Response(Buffer.alloc(data.length)),
  });
  await assert.rejects(bad.prepare());
  assert.equal(bad.state().phase, "error");
});
