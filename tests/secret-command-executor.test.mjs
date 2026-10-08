import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as connectSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { secretApiRequestExecutor } from "../src/main/services/SecretCommandExecutor.ts";
import {
  buildProviderApiUrl,
  normalizePublicHttpsBaseUrl,
  performSecretApiRequest,
  SECRET_API_REQUEST_WORKER_SOURCE
} from "../src/main/services/SecretApiRequestWorker.mjs";

const fixtureSecret = `SYNTHETIC_SECRET_${randomUUID()}`;

test("typed API requests use only the selected profile URL and protocol authentication", async () => {
  const cases = [
    ["openai-compatible", "OPENAI_API_KEY", { Authorization: `Bearer ${fixtureSecret}` }],
    ["anthropic-compatible", "ANTHROPIC_API_KEY", { "x-api-key": fixtureSecret, "anthropic-version": "2023-06-01" }],
    ["google", "GOOGLE_API_KEY", { "x-goog-api-key": fixtureSecret }]
  ];
  for (const [protocol, secretId, expectedAuth] of cases) {
    let seen;
    const result = await performSecretApiRequest({
      secretId,
      profile: { protocol, baseUrl: "https://api.example.com/v1" },
      method: "POST",
      path: "/responses?limit=1",
      body: { input: "hello" }
    }, fixtureSecret, async (url, options) => {
      seen = { url, options };
      return new Response(`{"echo":"${fixtureSecret}"}`, { status: 200 });
    });
    assert.equal(seen.url, "https://api.example.com/v1/responses?limit=1");
    assert.deepEqual(seen.options.headers, { Accept: "application/json", "Content-Type": "application/json", ...expectedAuth });
    assert.equal(seen.options.redirect, "error");
    assert.equal(result.status, 200);
    assert.equal(result.body, `{"echo":"${fixtureSecret}"}`);
    assert.equal(seen.url.includes(fixtureSecret), false);
    assert.equal(seen.options.body.includes(fixtureSecret), false);
  }
});

test("profile URLs must be public HTTPS and request paths cannot escape the selected profile", async () => {
  for (const baseUrl of [
    "http://api.example.com/v1", "https://localhost/v1", "https://127.0.0.1/v1",
    "https://api.example.com:8443/v1", "https://user:pass@api.example.com/v1", "https://api.example.test/v1"
  ]) assert.throws(() => normalizePublicHttpsBaseUrl(baseUrl), /public HTTPS/u, baseUrl);
  assert.equal(normalizePublicHttpsBaseUrl("https://API.EXAMPLE.COM/v1/"), "https://api.example.com/v1");
  assert.equal(buildProviderApiUrl("https://api.example.com/v1", "models"), "https://api.example.com/v1/models");

  let fetched = false;
  for (const path of ["//attacker.example/collect", "../outside", "https://attacker.example/", "/%2e%2e/outside"]) {
    await assert.rejects(performSecretApiRequest({
      secretId: "OPENAI_API_KEY", profile: { protocol: "openai-compatible", baseUrl: "https://api.example.com/v1" },
      method: "GET", path
    }, fixtureSecret, async () => { fetched = true; return new Response("unexpected"); }));
  }
  await assert.rejects(performSecretApiRequest({
    secretId: "OPENAI_API_KEY", profile: { protocol: "openai-compatible", baseUrl: "https://api.example.com/v1" },
    method: "GET", path: "models", headers: { Authorization: "attacker-controlled" }
  }, fixtureSecret, async () => { fetched = true; return new Response("unexpected"); }), /API request is invalid/u);
  assert.equal(fetched, false);
});

test("the fixed worker caps response bytes before returning them", async () => {
  const result = await performSecretApiRequest({
    secretId: "OPENAI_API_KEY", profile: { protocol: "openai-compatible", baseUrl: "https://api.example.com/v1" },
    method: "GET", path: "models"
  }, fixtureSecret, async () => new Response("x".repeat(40 * 1024), { status: 200 }));
  assert.equal(Buffer.byteLength(result.body), 32 * 1024);
  assert.equal(result.truncated, true);
});

const responseLimit = 32 * 1024;
const responseFixtureInput = { secretId: "OPENAI_API_KEY", profile: { protocol: "openai-compatible", baseUrl: "https://api.example.com/v1" }, method: "GET", path: "models" };

test("worker truncation preserves complete UTF-8 characters across byte cap and stream chunks", async () => {
  for (const character of ["é", "€", "🌍"]) {
    const encoded = Buffer.from(character);
    for (let retained = 1; retained <= encoded.length; retained += 1) {
      const prefix = "a".repeat(responseLimit - retained);
      const chunks = [Buffer.from(prefix), ...Array.from(encoded, byte => Uint8Array.of(byte)), Buffer.from("tail")];
      let canceled = false;
      const result = await performSecretApiRequest(responseFixtureInput, fixtureSecret, async () => ({ status: 200, body: { getReader: () => ({
        read: async () => chunks.length ? { value: chunks.shift(), done: false } : { done: true },
        cancel: async () => { canceled = true; }
      }) } }));
      assert.equal(result.body, prefix + (retained === encoded.length ? character : ""), `${character}, ${retained} bytes fit`);
      assert.ok(Buffer.byteLength(result.body) <= responseLimit);
      assert.equal(result.body.includes("�"), false, "truncating a valid code point never manufactures a replacement");
      assert.equal(result.truncated, true); assert.equal(canceled, true);
    }
    const exact = "a".repeat(responseLimit - encoded.length) + character;
    const result = await performSecretApiRequest(responseFixtureInput, fixtureSecret, async () => new Response(exact));
    assert.deepEqual(result, { status: 200, body: exact, truncated: false });
  }
});

test("malformed UTF-8 replacement expansion remains within the decoded response byte limit", async () => {
  for (const bytes of [Buffer.alloc(responseLimit, 0xff), Buffer.concat([Buffer.alloc(responseLimit - 1, 0x61), Buffer.from([0xe2])])]) {
    const result = await performSecretApiRequest(responseFixtureInput, fixtureSecret, async () => new Response(bytes));
    assert.ok(Buffer.byteLength(result.body) <= responseLimit);
    assert.equal(result.truncated, true);
    assert.equal(result.body, bytes[0] === 0xff ? "�".repeat(Math.floor(responseLimit / 3)) : "a".repeat(responseLimit - 1));
  }
  const completeInvalid = await performSecretApiRequest(responseFixtureInput, fixtureSecret, async () => new Response(Uint8Array.of(0xff)));
  assert.deepEqual(completeInvalid, { status: 200, body: "�", truncated: false }, "small malformed data retains standard decoding semantics");
});

test("actual secret executor accepts fixed-worker bounded UTF-8 and malformed stream results", async () => {
  for (const suffix of [Buffer.from("é"), Buffer.from("€"), Buffer.from("🌍"), Buffer.alloc(responseLimit, 0xff)]) {
    const bytesExpression = suffix[0] === 0xff ? `Buffer.alloc(${responseLimit}, 0xff)`
      : `Buffer.concat([Buffer.alloc(${responseLimit - 1}, 0x61), Buffer.from(${JSON.stringify([...suffix])})])`;
    const script = `globalThis.fetch = async () => {
      const bytes = ${bytesExpression};
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.subarray(0, 32767)); controller.enqueue(bytes.subarray(32767)); controller.close();
      } }));
    }; ${SECRET_API_REQUEST_WORKER_SOURCE}`;
    // Keep ample room below Windows' 32,767 UTF-16 command-line limit, including quoting and executable path.
    assert.ok(JSON.stringify([process.execPath, "-e", script]).length < 16_000, "fixture command must fit Windows process creation limits");
    assert.equal(script.includes(fixtureSecret), false, "the synthetic secret still travels only on stdin");
    const executor = secretApiRequestExecutor({ containment: () => true,
      // Only fetch is replaced; the actual bundled worker and executor result validation run unchanged.
      wrap: request => ({ ...request, args: ["-e", script], cleanup() {} }) });
    const result = await executor({ secretId: "OPENAI_API_KEY", apiProfile: responseFixtureInput.profile, method: "GET", path: "models",
      secret: fixtureSecret, cwd: process.cwd(), launchProfile: "normal", provider: "codex", timeoutMs: 5_000, signal: new AbortController().signal });
    assert.equal(result.status, 200); assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(result.body) <= responseLimit);
    assert.equal(result.body, suffix[0] === 0xff ? "�".repeat(Math.floor(responseLimit / 3)) : "a".repeat(responseLimit - 1));
  }
});

test("only supported provider secrets reach the fixed helper launch", async () => {
  let launched;
  let wrappedEnvironment;
  let wrapCalls = 0;
  let cleaned = 0;
  const executor = secretApiRequestExecutor({
    containment: () => true,
    wrap: (request) => {
      wrapCalls += 1;
      launched = { ...request, args: [...request.args], env: { ...request.env } };
      wrappedEnvironment = { ...request.env };
      return { ...request, env: wrappedEnvironment, cleanup: () => { cleaned += 1; } };
    }
  });
  await assert.rejects(executor({
    secretId: "DEVIN_API_KEY", apiProfile: { protocol: "openai-compatible", baseUrl: "https://api.example.com/v1" },
    method: "GET", path: "models", secret: fixtureSecret, cwd: process.cwd(), launchProfile: "normal", provider: "codex",
    timeoutMs: 5_000, signal: new AbortController().signal
  }), /not supported/u);
  assert.equal(wrapCalls, 0, "unsupported provider secrets are rejected before worker construction");

  await assert.rejects(executor({
    secretId: "OPENAI_API_KEY", apiProfile: { protocol: "openai-compatible", baseUrl: "http://127.0.0.1/v1" },
    method: "GET", path: "models", secret: fixtureSecret, cwd: process.cwd(), launchProfile: "normal", provider: "codex",
    timeoutMs: 5_000, signal: new AbortController().signal
  }), /Provider API request failed/u);
  assert.equal(wrapCalls, 1);
  assert.equal(launched.command, process.execPath);
  assert.deepEqual(launched.args, ["--use-env-proxy", "-e", SECRET_API_REQUEST_WORKER_SOURCE]);
  assert.equal(launched.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(launched.env.CANVASTTY_SECRET_ID, undefined);
  assert.equal(launched.env.OPENAI_API_KEY, undefined, "provider secrets are never copied into the worker environment");
  assert.equal(launched.env.CANVASTTY_SECRET_API_REQUEST, undefined);
  assert.equal(cleaned, 1);
  assert.deepEqual(Object.keys(wrappedEnvironment), [], "the wrapped environment is cleared after the worker exits");
});

test("a slow API worker receives the secret on stdin without exposing it through ps environment output", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "canvastty-secret-api-stdin-"));
  const readyPath = join(cwd, "worker-ready");
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let wrappedEnvironment;
  const script = `let input = "";
    process.stdin.on("data", chunk => { input += chunk.toString("utf8"); });
    process.stdin.on("end", () => {
      const payload = JSON.parse(input);
      require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ received: payload.secretId === "OPENAI_API_KEY" && typeof payload.secret === "string" && payload.secret.length > 0, pid: process.pid }));
      setTimeout(() => process.stdout.end(JSON.stringify({ ok: true, result: { status: 200, body: "ok", truncated: false } })), 750);
    });`;
  const executor = secretApiRequestExecutor({
    containment: () => true,
    wrap: (request) => {
      wrappedEnvironment = { ...request.env };
      return { ...request, args: ["-e", script], cleanup() {} };
    }
  });
  const request = executor({
    secretId: "OPENAI_API_KEY", apiProfile: { protocol: "openai-compatible", baseUrl: "https://api.example.com/v1" },
    method: "GET", path: "models", secret: fixtureSecret, cwd, launchProfile: "normal", provider: "codex",
    timeoutMs: 5_000, signal: new AbortController().signal
  });

  const deadline = Date.now() + 3_000;
  while (!existsSync(readyPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(readyPath), true, "worker started and received its stdin payload");
  const workerState = JSON.parse(await readFile(readyPath, "utf8"));
  assert.equal(workerState.received, true, "worker received the secret on stdin");
  assert.equal(Number.isInteger(workerState.pid), true);

  // The worker intentionally waits after consuming stdin so its live process environment can
  // be inspected while the request is still in flight.
  // Windows has no ps that prints another process's environment; the stdin delivery and the cleared wrapped
  // environment below are the platform-independent part of this guarantee.
  if (process.platform !== "win32") {
    const psArgs = process.platform === "darwin"
      ? ["-E", "-p", String(workerState.pid), "-o", "command="]
      : ["eww", "-p", String(workerState.pid), "-o", "command="];
    const processList = execFileSync("ps", psArgs, { encoding: "utf8" });
    assert.equal(processList.includes(fixtureSecret), false, "ps environment output must not contain the provider secret");
  }
  assert.equal(wrappedEnvironment.OPENAI_API_KEY, undefined);
  assert.equal(wrappedEnvironment.CANVASTTY_SECRET_ID, undefined);
  assert.deepEqual(await request, { status: 200, body: "ok", truncated: false });
});

test("executor preserves UTF-8 response characters split across worker pipe chunks", async () => {
  const body = "Привет 🌍 — café";
  const fixture = `const envelope = Buffer.from(JSON.stringify({ok:true,result:{status:200,body:${JSON.stringify(body)},truncated:false}}));
    const split = envelope.indexOf(Buffer.from('🌍')) + 1;
    process.stdout.write(envelope.subarray(0, split));
    setTimeout(() => process.stdout.end(envelope.subarray(split)), 150);`;
  const executor = secretApiRequestExecutor({
    containment: () => true,
    // This fixture substitutes the trusted worker's stdout transport; the production launch
    // is separately checked to contain only the fixed host worker source.
    wrap: request => ({ ...request, args: ["-e", fixture], cleanup() {} })
  });
  const result = await executor({
    secretId: "OPENAI_API_KEY", apiProfile: { protocol: "openai-compatible", baseUrl: "https://api.example.com/v1" },
    method: "GET", path: "models", secret: fixtureSecret, cwd: process.cwd(), launchProfile: "normal", provider: "codex",
    timeoutMs: 5_000, signal: new AbortController().signal
  });
  assert.deepEqual(result, { status: 200, body, truncated: false });
});

test("fixed worker fetch honors the host isolation HTTPS proxy", async (t) => {
  const electronPath = join(process.cwd(), "node_modules", "electron", "dist", process.platform === "darwin"
    ? "Electron.app/Contents/MacOS/Electron"
    : process.platform === "win32" ? "electron.exe" : "electron");
  if (!existsSync(electronPath)) {
    t.skip("Electron's bundled Node runtime is unavailable for the proxy fixture");
    return;
  }
  const fixtureRoot = await mkdtemp(join(tmpdir(), "canvastty-secret-proxy-"));
  const keyPath = join(fixtureRoot, "fixture-key.pem");
  const certPath = join(fixtureRoot, "fixture-cert.pem");
  const configPath = join(fixtureRoot, "fixture-openssl.cnf");
  const serverSockets = new Set();
  let proxyConnections = 0;
  let receivedRequest;
  let tlsServer;
  let proxyServer;
  t.after(async () => {
    for (const socket of serverSockets) socket.destroy();
    await Promise.all([closeServer(proxyServer), closeServer(tlsServer)]);
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  // Host OpenSSL defaults can duplicate extensions supplied on the command line,
  // producing a certificate that Electron correctly rejects (notably with LibreSSL).
  await writeFile(configPath, [
    "[req]", "distinguished_name = subject", "x509_extensions = fixture_extensions",
    "[subject]", "[fixture_extensions]", "subjectAltName = DNS:api.example.com",
    "basicConstraints = critical,CA:TRUE", ""
  ].join("\n"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", "/CN=api.example.com", "-config", configPath
    ], { stdio: "ignore" });
  } catch {
    t.skip("OpenSSL is unavailable for the local synthetic HTTPS certificate fixture");
    return;
  }
  const originalExecPath = process.execPath;
  Object.defineProperty(process, "execPath", { value: electronPath });
  t.after(() => Object.defineProperty(process, "execPath", { value: originalExecPath }));
  try {
    tlsServer = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (request, response) => {
      receivedRequest = { url: request.url, authorization: request.headers.authorization };
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"ok\":true}");
    });
    const tlsPort = await listenServer(tlsServer);
    proxyServer = createHttpServer();
    proxyServer.on("connect", (request, client, head) => {
      if (request.url !== "api.example.com:443") { client.destroy(); return; }
      proxyConnections += 1;
      const upstream = connectSocket(tlsPort, "127.0.0.1");
      serverSockets.add(upstream);
      serverSockets.add(client);
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once("error", () => client.destroy());
      client.once("error", () => upstream.destroy());
    });
    const proxyPort = await listenServer(proxyServer);
    const executor = secretApiRequestExecutor({
      containment: () => true,
      wrap: (request) => ({
        ...request,
        env: {
          ...request.env,
          HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
          HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
          NO_PROXY: "",
          no_proxy: "",
          NODE_EXTRA_CA_CERTS: certPath
        },
        cleanup() {}
      })
    });
    const result = await executor({
      secretId: "OPENAI_API_KEY", apiProfile: { protocol: "openai-compatible", baseUrl: "https://api.example.com/v1" },
      method: "GET", path: "models", secret: fixtureSecret, cwd: process.cwd(), launchProfile: "normal", provider: "codex",
      timeoutMs: 10_000, signal: new AbortController().signal
    });
    assert.deepEqual(result, { status: 200, body: "{\"ok\":true}", truncated: false });
    assert.equal(proxyConnections, 1, "the fixed worker tunneled through the host isolation proxy");
    assert.deepEqual(receivedRequest, { url: "/v1/models", authorization: `Bearer ${fixtureSecret}` });
  } finally {
    Object.defineProperty(process, "execPath", { value: originalExecPath });
  }
});

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}
