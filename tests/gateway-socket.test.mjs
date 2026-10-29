import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  closeServer,
  createPrivateUnixEndpoint,
  listenOnEndpoint,
  makePrivateDirectory,
  removeEndpoint,
  tokenDigest,
  tokenMatches
} from "../src/main/services/gatewaySocket.ts";

test("a short requested endpoint directory remains caller-owned", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp("/tmp/ctty-requested-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const created = await createPrivateUnixEndpoint(root, "g.sock", "ctty-test-");
  assert.equal(created.endpoint, join(root, "g.sock"));
  assert.equal(created.ownedRuntimeDirectory, null);
  await removeEndpoint(created.endpoint, created.ownedRuntimeDirectory, { socketFile: true });
  assert.equal((await stat(root)).mode & 0o777, 0o700);
});

test("a long TMPDIR falls back to a short private directory without reusing another gateway", { skip: process.platform === "win32" }, async () => {
  const previous = process.env.TMPDIR;
  const created = [];
  try {
    process.env.TMPDIR = `/tmp/${"long-".repeat(25)}`;
    created.push(await createPrivateUnixEndpoint(undefined, "r.sock", "ctty-test-"));
    created.push(await createPrivateUnixEndpoint(undefined, "r.sock", "ctty-test-"));
    assert.notEqual(created[0].ownedRuntimeDirectory, created[1].ownedRuntimeDirectory);
    for (const value of created) {
      assert.ok(Buffer.byteLength(value.endpoint, "utf8") <= 100);
      assert.equal((await stat(value.ownedRuntimeDirectory)).mode & 0o777, 0o700);
    }
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    for (const value of created) await removeEndpoint(value.endpoint, value.ownedRuntimeDirectory, { socketFile: true });
  }
});

test("a token matches only its own digest, and a missing digest never matches", () => {
  const digest = tokenDigest("secret-token");
  assert.equal(digest.length, 32);
  assert.equal(tokenMatches("secret-token", digest), true);
  assert.equal(tokenMatches("secret-tokeN", digest), false);
  assert.equal(tokenMatches("", digest), false);
  assert.equal(tokenMatches("secret-token", null), false);
  assert.equal(tokenMatches("secret-token", Buffer.alloc(16)), false);
});

test("an endpoint lives in a 0700 directory, its socket is 0600, and removal leaves nothing", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ctty-gw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "d");
  await makePrivateDirectory(directory);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const endpoint = join(directory, "s.sock");
  const server = createServer((socket) => socket.end("hi\n"));
  await listenOnEndpoint(server, endpoint);
  assert.equal((await stat(endpoint)).mode & 0o777, 0o600);
  const reply = await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let data = "";
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
  assert.equal(reply, "hi\n");
  await closeServer(server);
  await closeServer(server);
  await removeEndpoint(endpoint, directory, { socketFile: true });
  await assert.rejects(stat(directory), { code: "ENOENT" });
  await removeEndpoint(endpoint, directory, { socketFile: true });
});

test("a second listener on a taken endpoint fails instead of hanging", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ctty-gw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const endpoint = join(root, "s.sock");
  const first = createServer();
  await listenOnEndpoint(first, endpoint);
  t.after(() => closeServer(first));
  await assert.rejects(listenOnEndpoint(createServer(), endpoint), { code: "EADDRINUSE" });
});
