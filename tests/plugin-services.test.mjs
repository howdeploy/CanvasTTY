import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginManager, validatePluginManifest } from "../src/main/services/PluginManager.ts";
import {
  PluginServiceSupervisor,
  entryGuardArguments,
  pluginServiceEnvironment
} from "../src/main/services/PluginServiceSupervisor.ts";

const example = new URL("../examples/plugins/service-echo/", import.meta.url);
const exampleManifest = JSON.parse(await readFile(new URL("canvastty.plugin.json", example), "utf8"));

const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Condition was not met in time.");
};

/** A supervisor over real child processes, with a host that records what services ask for. */
function supervisor(options = {}) {
  const storage = new Map();
  const events = [];
  const instance = new PluginServiceSupervisor({
    command: process.execPath,
    hostVersion: "9.9.9",
    locale: () => "en",
    requestTimeoutMs: 2_000,
    stopGraceMs: 300,
    restartDelaysMs: [30, 60],
    host: {
      storageGet: async (pluginId, key) => storage.get(`${pluginId}/${key}`) ?? null,
      storageSet: async (pluginId, key, value) => { storage.set(`${pluginId}/${key}`, value); },
      emit: (pluginId, serviceId, event, data) => events.push({ pluginId, serviceId, event, data })
    },
    ...options
  });
  return { instance, storage, events };
}

async function specFor(root, pluginId, serviceId, source, permissions = ["storage"]) {
  const entryPath = join(root, `${serviceId}.mjs`);
  await mkdir(root, { recursive: true });
  await writeFile(entryPath, source);
  return {
    pluginId,
    serviceId,
    root,
    entryPath,
    sha256: sha256(source),
    dataDir: join(root, "data"),
    permissions
  };
}

async function echoSpec(root, pluginId) {
  const source = await readFile(new URL("services/echo.mjs", example), "utf8");
  return specFor(root, pluginId, "echo", source);
}

/** Answers `env` with its environment keys, `size` with a big line, `hang` never, `crash` by exiting. */
const PROBE = `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "env") send({ id: m.id, result: { keys: Object.keys(process.env), cwd: process.cwd(), context: globalThis.context } });
  if (m.method === "canvastty.initialize") globalThis.context = m.params;
  if (m.method === "big") { process.stdout.write("x".repeat(m.params.bytes) + "\\n"); send({ id: m.id, result: "after" }); }
  if (m.method === "ping") send({ id: m.id, result: "pong" });
  if (m.method === "crash") process.exit(3);
  if (m.method === "host") {
    send({ id: 900 + m.id, method: m.params.method, params: m.params.params });
    send({ id: m.id, result: null });
  }
  if (m.id >= 900 && !m.method) process.stderr.write("host-reply " + JSON.stringify(m) + "\\n");
});
`;

/** Spawns and stays alive, but never reads stdin: every byte the host writes stays queued. */
const DEAF_PROBE = `setInterval(() => {}, 60_000);\n`;

test("manifest apiVersion 2 declares services; v1 manifests stay valid and cannot declare them", () => {
  const validated = validatePluginManifest(exampleManifest);
  assert.equal(validated.apiVersion, 2);
  assert.deepEqual(validated.services, exampleManifest.services);
  assert.equal(validatePluginManifest({ ...exampleManifest, apiVersion: 1, services: undefined }).apiVersion, 1);
  assert.throws(() => validatePluginManifest({ ...exampleManifest, apiVersion: 1 }), /require apiVersion 2/);
  assert.throws(() => validatePluginManifest({ ...exampleManifest, apiVersion: 3 }), /apiVersion must be 1 or 2/);
  const service = exampleManifest.services[0];
  assert.throws(() => validatePluginManifest({ ...exampleManifest, services: [{ ...service, entry: "services/echo.sh" }] }), /bundled JavaScript/);
  assert.throws(() => validatePluginManifest({ ...exampleManifest, services: [{ ...service, entry: "../echo.mjs" }] }));
  assert.throws(() => validatePluginManifest({ ...exampleManifest, services: [service, service] }), /duplicated/);
  assert.throws(() => validatePluginManifest({ ...exampleManifest, services: [{ ...service, provides: ["tools"] }] }), /unknown field/);
  assert.throws(() => validatePluginManifest({ ...exampleManifest, services: [{ ...service, module: "missing" }] }), /unknown module/);
  // A service-only plugin is a valid plugin.
  assert.equal(validatePluginManifest({ ...exampleManifest, contributions: [] }).services.length, 1);
  // In a modular plugin the service entry must be integrity-declared like every module file.
  const coreFiles = [{ path: "apps/echo.html", bytes: 1, sha256: "a".repeat(64) }];
  const modular = { ...exampleManifest, coreFiles, modules: [{ id: "extra", title: "Extra", defaultSelected: true, permissions: [], files: [{ path: "apps/x.js", bytes: 1, sha256: "b".repeat(64) }] }] };
  assert.equal(validatePluginManifest(modular).services.length, 1);
});

test("native code trust is separate from install, pins the entry hash, and is revoked by disable, module change and file change", async () => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-services-"));
  const observed = [];
  const manager = new PluginManager(userData, async (_url, destination) => {
    await cp(example, destination, { recursive: true });
  });
  manager.setServiceObserver(async (specs) => { observed.push(specs); });
  try {
    await manager.load();
    const preview = await manager.previewInstall("https://github.com/example/service-echo");
    const installed = await manager.install(preview.token);
    assert.equal(installed.nativeCodeTrusted, false);
    assert.deepEqual(manager.trustedServiceSpecs(), [], "installation never enables native code");
    assert.deepEqual(observed.at(-1), []);

    const trusted = await manager.setNativeCodeTrusted(installed.manifest.id, true);
    assert.equal(trusted.nativeCodeTrusted, true);
    const [spec] = manager.trustedServiceSpecs();
    const entry = await readFile(new URL("services/echo.mjs", example));
    assert.equal(spec.sha256, sha256(entry));
    assert.equal(spec.root, join(userData, "plugins", "com.example.service-echo"));
    assert.equal(spec.entryPath, join(spec.root, "services", "echo.mjs"));
    assert.equal(spec.dataDir, join(userData, "plugin-data", "com.example.service-echo"));
    assert.deepEqual(observed.at(-1), [spec], "the supervisor learns about the grant after it is durable");
    manager.assertService(installed.manifest.id, "echo");
    assert.throws(() => manager.assertService(installed.manifest.id, "other"), /does not exist/);

    // Survives a restart while the file is unchanged.
    const reloaded = new PluginManager(userData);
    await reloaded.load();
    assert.equal(reloaded.list()[0].nativeCodeTrusted, true);
    assert.equal(reloaded.trustedServiceSpecs().length, 1);

    // A changed entry file revokes the grant on the next start.
    await writeFile(spec.entryPath, `${entry}\n// changed\n`);
    const changed = new PluginManager(userData);
    await changed.load();
    assert.equal(changed.list()[0].nativeCodeTrusted, false);
    assert.deepEqual(changed.trustedServiceSpecs(), []);
    await writeFile(spec.entryPath, entry);

    // Disabling revokes, and enabling again does not restore it.
    await manager.setNativeCodeTrusted(installed.manifest.id, true);
    await manager.setEnabled(installed.manifest.id, false);
    assert.deepEqual(observed.at(-1), []);
    await manager.setEnabled(installed.manifest.id, true);
    assert.equal(manager.list()[0].nativeCodeTrusted, false);
    assert.deepEqual(manager.trustedServiceSpecs(), []);
    await assert.rejects(manager.setEnabled(installed.manifest.id, false).then(() => (
      manager.setNativeCodeTrusted(installed.manifest.id, true)
    )), /disabled/);
    await manager.setEnabled(installed.manifest.id, true);

    // Uninstall stops services before the files and the data folder are removed.
    await manager.setNativeCodeTrusted(installed.manifest.id, true);
    await mkdir(spec.dataDir, { recursive: true });
    let filesPresentWhenStopped = null;
    manager.setServiceObserver(async (specs) => {
      observed.push(specs);
      if (specs.length === 0 && filesPresentWhenStopped === null) {
        filesPresentWhenStopped = await stat(spec.entryPath).then(() => true, () => false);
      }
    });
    await manager.uninstall(installed.manifest.id);
    assert.equal(filesPresentWhenStopped, true);
    await assert.rejects(stat(spec.dataDir), /ENOENT/);
    assert.deepEqual(manager.trustedServiceSpecs(), []);
  } finally {
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
  }
});

test("a module change revokes native code trust", async () => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-service-modules-"));
  const files = {
    "apps/echo.html": await readFile(new URL("apps/echo.html", example)),
    "services/echo.mjs": await readFile(new URL("services/echo.mjs", example)),
    "services/extra.mjs": Buffer.from("process.stdin.resume();\n")
  };
  const asset = (path) => ({ path, bytes: files[path].length, sha256: sha256(files[path]) });
  const manifest = {
    ...exampleManifest,
    coreFiles: [asset("apps/echo.html"), asset("services/echo.mjs")],
    modules: [{ id: "extra", title: "Extra", defaultSelected: true, permissions: [], files: [asset("services/extra.mjs")] }],
    services: [...exampleManifest.services, { id: "extra", title: "Extra", entry: "services/extra.mjs", module: "extra" }]
  };
  const unlisted = { ...manifest, coreFiles: [asset("apps/echo.html")] };
  let served = unlisted;
  const manager = new PluginManager(
    userData,
    async (_url, destination) => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "canvastty.plugin.json"), JSON.stringify(served));
    },
    async (_url, destination, requested) => {
      for (const file of requested) {
        await mkdir(join(destination, file.path, ".."), { recursive: true });
        await writeFile(join(destination, file.path), files[file.path]);
      }
    }
  );
  try {
    await manager.load();
    // A service entry must be integrity-declared by coreFiles or its module.
    await assert.rejects(manager.previewInstall("https://github.com/example/service-echo"), /Service entry must belong/);
    served = manifest;
    const installed = await manager.install((await manager.previewInstall("https://github.com/example/service-echo")).token);
    await manager.setNativeCodeTrusted(installed.manifest.id, true);
    assert.deepEqual(manager.trustedServiceSpecs().map((spec) => spec.serviceId), ["echo", "extra"]);
    const updated = await manager.setModules(installed.manifest.id, []);
    assert.equal(updated.nativeCodeTrusted, false);
    assert.deepEqual(updated.manifest.services.map((service) => service.id), ["echo"]);
    assert.deepEqual(manager.trustedServiceSpecs(), []);
  } finally {
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
  }
});

test("the supervisor runs the example service, relays requests, storage and events, and stops it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-service-echo-"));
  const { instance, storage, events } = supervisor();
  t.after(async () => { await instance.dispose(); await rm(root, { recursive: true, force: true }); });
  const spec = await echoSpec(root, "com.example.a");
  await instance.sync([spec]);
  const reply = await instance.request("com.example.a", "echo", "echo", { text: "hi" });
  assert.deepEqual(reply, { echo: { text: "hi" }, count: 1, serviceId: "echo" });
  assert.equal((await instance.request("com.example.a", "echo", "echo", { text: "again" })).count, 2);
  assert.equal(storage.get("com.example.a/count"), 2);
  await waitFor(() => events.length === 2);
  assert.deepEqual(events[1], { pluginId: "com.example.a", serviceId: "echo", event: "echoed", data: { count: 2 } });
  const report = instance.report("com.example.a");
  assert.equal(report.services[0].state, "running");
  assert.ok(report.log.some((entry) => entry.source === "service" && entry.message === "echo ready for com.example.a"));
  assert.ok((await stat(spec.dataDir)).isDirectory());

  // Host-reserved methods cannot be sent from UI.
  await assert.rejects(instance.request("com.example.a", "echo", "canvastty.initialize", {}), /method is invalid/);

  await instance.sync([]);
  assert.equal(instance.report("com.example.a").services.length, 0);
  await assert.rejects(instance.request("com.example.a", "echo", "echo", { text: "late" }), /not running/);
});

test("plugins are isolated: one plugin cannot reach another plugin's service or storage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-service-isolation-"));
  const { instance, storage } = supervisor();
  t.after(async () => { await instance.dispose(); await rm(root, { recursive: true, force: true }); });
  await instance.sync([await specFor(join(root, "a"), "com.example.a", "probe", PROBE)]);
  await assert.rejects(instance.request("com.example.b", "probe", "ping", null), /not running/);
  assert.equal(await instance.request("com.example.a", "probe", "ping", null), "pong");
  // A service cannot choose whose storage it writes: the host binds its own plugin id.
  await instance.request("com.example.a", "probe", "host", {
    method: "storage.set",
    params: { key: "k", value: 1, pluginId: "com.example.b" }
  });
  await waitFor(() => storage.has("com.example.a/k"));
  assert.equal(storage.has("com.example.b/k"), false);
});

test("services get a minimal environment, the plugin root as cwd and the init context", async (t) => {
  const environment = pluginServiceEnvironment({
    PATH: "/usr/bin",
    HOME: "/home/me",
    LC_ALL: "C",
    OPENAI_API_KEY: "sk-secret",
    GITHUB_TOKEN: "ghp-secret",
    CANVASTTY_RUNTIME_TOKEN: "internal",
    CANVASTTY_AGENT_SOCKET: "/tmp/socket",
    NODE_OPTIONS: "--require /tmp/inject.js"
  });
  assert.deepEqual(environment, { PATH: "/usr/bin", HOME: "/home/me", LC_ALL: "C", ELECTRON_RUN_AS_NODE: "1" });

  const root = await mkdtemp(join(tmpdir(), "canvastty-service-env-"));
  const { instance } = supervisor({
    environment: { ...process.env, OPENAI_API_KEY: "sk-secret", CANVASTTY_RUNTIME_TOKEN: "internal" }
  });
  t.after(async () => { await instance.dispose(); await rm(root, { recursive: true, force: true }); });
  const spec = await specFor(root, "com.example.a", "probe", PROBE);
  await instance.sync([spec]);
  const probe = await instance.request("com.example.a", "probe", "env", null);
  assert.equal(probe.keys.includes("OPENAI_API_KEY"), false);
  assert.equal(probe.keys.includes("CANVASTTY_RUNTIME_TOKEN"), false);
  assert.equal(probe.keys.some((key) => key.startsWith("CANVASTTY_")), false);
  assert.equal(await realpath(probe.cwd), await realpath(root));
  assert.deepEqual(probe.context, {
    apiVersion: 2,
    pluginId: "com.example.a",
    serviceId: "probe",
    dataDir: spec.dataDir,
    locale: "en",
    hostVersion: "9.9.9"
  });
});

test("the host API is minimal: unknown methods and storage without permission are refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-service-host-api-"));
  const { instance } = supervisor();
  t.after(async () => { await instance.dispose(); await rm(root, { recursive: true, force: true }); });
  await instance.sync([await specFor(root, "com.example.a", "probe", PROBE, [])]);
  await instance.request("com.example.a", "probe", "host", { method: "secrets.get", params: { key: "x" } });
  await instance.request("com.example.a", "probe", "host", { method: "storage.get", params: { key: "x" } });
  await waitFor(() => instance.report("com.example.a").log.filter((entry) => entry.message.startsWith("host-reply")).length === 2);
  const replies = instance.report("com.example.a").log.filter((entry) => entry.message.startsWith("host-reply")).map((entry) => entry.message);
  assert.match(replies[0], /-32601/);
  assert.match(replies[1], /storage permission/);
});

test("limits.get gives a service the account-free limits snapshot only with limits:read", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-service-limits-"));
  const calls = [];
  const snapshot = { state: "ready", snapshot: { fetchedAt: 1, providers: [] } };
  const { instance } = supervisor({ host: {
    storageGet: async () => null, storageSet: async () => {}, emit: () => {},
    limits: async (pluginId) => { calls.push(pluginId); return snapshot; }
  } });
  t.after(async () => { await instance.dispose(); await rm(root, { recursive: true, force: true }); });
  await instance.sync([
    await specFor(join(root, "a"), "com.example.a", "probe", PROBE, []),
    await specFor(join(root, "b"), "com.example.b", "probe", PROBE, ["limits:read"])
  ]);
  await instance.request("com.example.a", "probe", "host", { method: "limits.get", params: {} });
  await instance.request("com.example.b", "probe", "host", { method: "limits.get", params: {} });
  const reply = (pluginId) => instance.report(pluginId).log.find((entry) => entry.message.startsWith("host-reply"))?.message;
  await waitFor(() => reply("com.example.a") && reply("com.example.b"));
  assert.match(reply("com.example.a"), /limits:read permission/);
  assert.deepEqual(JSON.parse(reply("com.example.b").slice("host-reply ".length)).result, snapshot);
  assert.deepEqual(calls, ["com.example.b"]);
});

test("message sizes are bounded in both directions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-service-sizes-"));
  const { instance } = supervisor({ maxFrameBytes: 4_096 });
  t.after(async () => { await instance.dispose(); await rm(root, { recursive: true, force: true }); });
  await instance.sync([await specFor(root, "com.example.a", "probe", PROBE)]);
  await assert.rejects(
    instance.request("com.example.a", "probe", "ping", { text: "x".repeat(5_000) }),
    /1 MB message limit/
  );
  // An oversized line from the service is dropped; the service keeps answering.
  assert.equal(await instance.request("com.example.a", "probe", "big", { bytes: 20_000 }), "after");
  assert.ok(instance.report("com.example.a").log.some((entry) => /larger than 1 MB/.test(entry.message)));
  assert.equal(await instance.request("com.example.a", "probe", "ping", null), "pong");
});

test("stdin backpressure is capped in bytes, not just in pending request count", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-service-backpressure-"));
  // A tiny queue cap (two ~2 KB frames) that a service which never reads stdin fills almost at once.
  // requestTimeoutMs is left long (and irrelevant to what we assert) so a slow CI box never turns a
  // request that *did* get queued into a spurious timeout rejection during this test.
  const { instance } = supervisor({ maxQueuedBytes: 4_096, requestTimeoutMs: 60_000 });
  t.after(async () => { await instance.dispose(); await rm(root, { recursive: true, force: true }); });
  await instance.sync([await specFor(root, "com.example.a", "probe", DEAF_PROBE)]);

  const payload = { text: "x".repeat(2_000) };
  let rejectedForBackpressure = 0;
  // Far more requests than the byte cap could ever hold queued at once (the service never reads any of
  // them, so every request that IS queued stays pending forever). The busy check is synchronous
  // (thrown before any pending entry or timer is created), so the count below is fixed as soon as this
  // loop returns; we only need a microtask turn for the already-settled rejections to run their handler.
  for (let i = 0; i < 40; i += 1) {
    // Requests that got queued never settle from the deaf service; they are only ever rejected later,
    // by t.after's dispose() tearing the service down ("Plugin service stopped."), which this ignores.
    instance.request("com.example.a", "probe", "ping", payload).catch((error) => {
      if (/busy/.test(error.message)) rejectedForBackpressure += 1;
    });
  }
  // Let the synchronous rejections' .then handlers run (they need no I/O, just a microtask turn).
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(rejectedForBackpressure > 0, "later requests were rejected once the byte cap was reached");
  assert.ok(
    rejectedForBackpressure < 40,
    `expected some requests to still be queued before the cap, but all 40 were rejected as busy`
  );
});

test("timeouts return errors, crashes restart with backoff, and repeated crashes stop restarts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-service-crash-"));
  const { instance } = supervisor({ maxRestarts: 2 });
  t.after(async () => { await instance.dispose(); await rm(root, { recursive: true, force: true }); });
  await instance.sync([await specFor(root, "com.example.a", "probe", PROBE)]);
  assert.equal(await instance.request("com.example.a", "probe", "ping", null), "pong");
  await assert.rejects(instance.hostCall("com.example.a", "probe", "canvastty.never-answered", null, 200), /timed out/);

  await assert.rejects(instance.request("com.example.a", "probe", "crash", null), /stopped/);
  assert.equal(instance.report("com.example.a").services[0].state, "backoff");
  await waitFor(() => instance.report("com.example.a").services[0].state === "running");
  assert.equal(instance.report("com.example.a").services[0].restarts, 1);
  assert.equal(await instance.request("com.example.a", "probe", "ping", null), "pong");

  await assert.rejects(instance.request("com.example.a", "probe", "crash", null), /stopped/);
  await waitFor(() => instance.report("com.example.a").services[0].state === "running");
  assert.equal(await instance.request("com.example.a", "probe", "ping", null), "pong");
  await assert.rejects(instance.request("com.example.a", "probe", "crash", null), /stopped/);
  const failed = instance.report("com.example.a").services[0];
  assert.equal(failed.state, "failed");
  assert.match(failed.lastError, /too often/);
  await assert.rejects(instance.request("com.example.a", "probe", "ping", null), /not running/);
});

test("a host reply to a service that crashed is not delivered to its restarted process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-service-stale-reply-"));
  let releaseSlow;
  const slowValue = new Promise((resolve) => { releaseSlow = resolve; });
  let slowStarted;
  const slowRequested = new Promise((resolve) => { slowStarted = resolve; });
  const { instance } = supervisor({
    host: {
      storageGet: async (_pluginId, key) => {
        if (key !== "slow") return "fast";
        slowStarted();
        return slowValue;
      },
      storageSet: async () => undefined,
      emit: () => undefined
    }
  });
  t.after(async () => { await instance.dispose(); await rm(root, { recursive: true, force: true }); });
  await instance.sync([await specFor(root, "com.example.a", "probe", PROBE)]);
  const hostReplies = () => instance.report("com.example.a").log.filter((entry) => entry.message.startsWith("host-reply"));

  await instance.request("com.example.a", "probe", "host", { method: "storage.get", params: { key: "slow" } });
  await slowRequested;
  await assert.rejects(instance.request("com.example.a", "probe", "crash", null), /stopped/);
  await waitFor(() => instance.report("com.example.a").services[0].state === "running");

  releaseSlow("stale");
  await slowValue;
  // A later host request to the new process is answered after the stale reply would have been
  // written, and the process logs replies in the order it reads them.
  await instance.request("com.example.a", "probe", "host", { method: "storage.get", params: { key: "fast" } });
  await waitFor(() => hostReplies().length > 0);
  assert.equal(hostReplies().length, 1);
  assert.match(hostReplies()[0].message, /"result":"fast"/);
  assert.doesNotMatch(hostReplies()[0].message, /stale/);
});

test("an entry that changed after it was trusted never runs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-service-hash-"));
  const { instance } = supervisor();
  t.after(async () => { await instance.dispose(); await rm(root, { recursive: true, force: true }); });
  const spec = await specFor(root, "com.example.a", "probe", PROBE);
  await writeFile(spec.entryPath, `${PROBE}\nprocess.stderr.write("tampered\\n");\n`);
  await instance.sync([spec]);
  const [status] = instance.report("com.example.a").services;
  assert.equal(status.state, "failed");
  assert.match(status.lastError, /changed after it was trusted/);
  await assert.rejects(instance.request("com.example.a", "probe", "ping", null), /not running/);
});

test("an entry swapped after the host checked it is not run: the child runs only the bytes that match the trusted hash", { skip: process.platform === "win32" }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-service-swap-")));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const marker = join(root, "tampered-ran");
  const tampered = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n${PROBE}`;
  const swapped = join(root, "swapped.mjs");
  await writeFile(swapped, tampered);
  // Stands in for a file replaced between the host's hash check and node reading it:
  // the "node" the supervisor starts first swaps the entry, then runs the real node.
  const wrapper = join(root, "node-with-swap.sh");
  await writeFile(wrapper, `#!/bin/sh\nfor entry; do :; done\ncp ${JSON.stringify(swapped)} "$entry"\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o700 });
  const { instance } = supervisor({ command: wrapper, restartDelaysMs: [10_000] });
  t.after(() => instance.dispose());
  const spec = await specFor(join(root, "plugin"), "com.example.a", "probe", PROBE);
  await instance.sync([spec]);
  const markerExists = () => stat(marker).then(() => true, () => false);
  const exited = () => instance.report("com.example.a").log.some((entry) => /exit|crash|stopped/i.test(entry.message));
  await waitFor(async () => (await markerExists()) || exited(), 5_000);
  assert.equal(await markerExists(), false, "the swapped entry must not run");
  await assert.rejects(instance.request("com.example.a", "probe", "ping", null));
});

test("the entry guard hooks carry no static import the main bundle's CommonJS shim could land after", () => {
  // electron-vite's esm shim puts `__dirname`/`require` after the LAST match of this
  // pattern in the whole main bundle, string literals included. A static import inside
  // the hooks source once pulled the shim into the string and the app could not open.
  const staticImport = /(?<=\s|^|;)import\s*([\s"']*(?<imports>[\p{L}\p{M}\w\t\n\r $*,/{}@.]+)from\s*)?["']\s*(?<specifier>(?<="\s*)[^"]*[^\s"](?=\s*")|(?<='\s*)[^']*[^\s'](?=\s*'))\s*["'][\s;]*/gmu;
  const [, boot] = entryGuardArguments("file:///service.mjs", "0".repeat(64));
  const register = decodeURIComponent(boot.slice("data:text/javascript,".length));
  const hooksUrl = JSON.parse(register.match(/register\(("[^"]+")/)[1]);
  const hooks = decodeURIComponent(hooksUrl.slice("data:text/javascript,".length));
  assert.match(hooks, /createHash/);
  assert.deepEqual([...hooks.matchAll(staticImport)].map((match) => match[0]), []);
});

test("a verified entry still runs from its own location with the guard in place", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-service-guard-")));
  const { instance } = supervisor();
  t.after(async () => { await instance.dispose(); await rm(root, { recursive: true, force: true }); });
  const cjs = `
const { createInterface } = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "where") send({ id: m.id, result: { file: __filename, argv: process.argv[1] } });
});`;
  const spec = await specFor(root, "com.example.a", "probe", PROBE);
  const cjsSpec = { ...(await specFor(root, "com.example.b", "cjs", cjs)), entryPath: join(root, "cjs.cjs") };
  await writeFile(cjsSpec.entryPath, cjs);
  await instance.sync([spec, cjsSpec]);
  assert.equal(await instance.request("com.example.a", "probe", "ping", null), "pong");
  const where = await instance.request("com.example.b", "cjs", "where", null);
  assert.equal(where.file, cjsSpec.entryPath);
  assert.equal(where.argv, cjsSpec.entryPath);
});

test("a service that ignores shutdown is terminated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-service-stubborn-"));
  const { instance } = supervisor({ stopGraceMs: 200 });
  t.after(async () => { await instance.dispose(); await rm(root, { recursive: true, force: true }); });
  const spec = await specFor(root, "com.example.a", "stubborn", `
process.stdin.on("data", () => {});
process.stdin.on("end", () => {});
setInterval(() => {}, 1000);
`);
  await instance.sync([spec]);
  await waitFor(() => instance.report("com.example.a").services[0]?.state === "running");
  const started = Date.now();
  await instance.sync([]);
  assert.ok(Date.now() - started < 2_000);
  assert.ok(instance.report("com.example.a").log.some((entry) => entry.message === "Stopped."));
});

test("end to end: trust starts the service, disable and uninstall stop it", async (t) => {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-services-e2e-"));
  const manager = new PluginManager(userData, async (_url, destination) => {
    await cp(example, destination, { recursive: true });
  });
  const { instance } = supervisor({
    host: {
      storageGet: (pluginId, key) => manager.storageGet(pluginId, key),
      storageSet: (pluginId, key, value) => manager.storageSet(pluginId, key, value),
      emit: () => undefined
    }
  });
  manager.setServiceObserver((specs) => instance.sync(specs));
  t.after(async () => {
    await instance.dispose();
    await manager.dispose();
    await rm(userData, { recursive: true, force: true });
  });
  await manager.load();
  const { manifest } = await manager.install((await manager.previewInstall("https://github.com/example/service-echo")).token);
  await assert.rejects(instance.request(manifest.id, "echo", "echo", { text: "x" }), /not running/);

  await manager.setNativeCodeTrusted(manifest.id, true);
  assert.equal((await instance.request(manifest.id, "echo", "echo", { text: "x" })).count, 1);
  assert.equal(await manager.storageGet(manifest.id, "count"), 1);

  await manager.setEnabled(manifest.id, false);
  await assert.rejects(instance.request(manifest.id, "echo", "echo", { text: "x" }), /not running/);
  assert.equal(instance.report(manifest.id).services.length, 0);

  await manager.setEnabled(manifest.id, true);
  await manager.setNativeCodeTrusted(manifest.id, true);
  assert.equal((await instance.request(manifest.id, "echo", "echo", { text: "x" })).count, 2);
  await manager.uninstall(manifest.id);
  await assert.rejects(instance.request(manifest.id, "echo", "echo", { text: "x" }), /not running/);
  assert.equal(instance.report(manifest.id).services.length, 0);
});

/**
 * Runs a trusted entry through a "node" that first changes the plugin files with `swap` (a shell snippet; `$entry`
 * is the entry path the supervisor passed, `$tampered` an untrusted module writing the marker), then runs the real
 * node. The untrusted module must never run, however the swap changes the path node resolves.
 */
async function assertSwapNeverRuns(t, { swap, extension = "mjs", command = process.execPath }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-service-resolve-")));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const marker = join(root, "tampered-ran");
  const cjs = extension === "cjs";
  const tamperedSource = cjs
    ? `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`
    : `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n${PROBE}`;
  await mkdir(join(root, "untrusted"), { recursive: true });
  const tampered = join(root, "untrusted", `probe.${extension}`);
  await writeFile(tampered, tamperedSource);
  const wrapper = join(root, "node-with-swap.sh");
  await writeFile(wrapper, `#!/bin/sh\nfor entry; do :; done\ntampered=${JSON.stringify(tampered)}\n${swap}\nexec ${JSON.stringify(command)} "$@"\n`, { mode: 0o700 });
  const { instance } = supervisor({ command: wrapper, restartDelaysMs: [10_000] });
  t.after(() => instance.dispose());
  const trusted = cjs ? `require("node:readline");\n` : PROBE;
  const base = await specFor(join(root, "plugin"), "com.example.a", "probe", trusted);
  const spec = cjs ? { ...base, entryPath: join(root, "plugin", "probe.cjs") } : base;
  if (cjs) await writeFile(spec.entryPath, trusted);
  await instance.sync([spec]);
  const markerExists = () => stat(marker).then(() => true, () => false);
  const exited = () => instance.report("com.example.a").log.some((entry) => /exit|crash|stopped/i.test(entry.message));
  await waitFor(async () => (await markerExists()) || exited(), 5_000);
  assert.equal(await markerExists(), false, "the untrusted module must not run");
}

test("an entry replaced by a symlink to another module after the host checked it is not run", { skip: process.platform === "win32" }, async (t) => {
  await assertSwapNeverRuns(t, { swap: `rm -f "$entry"; ln -s "$tampered" "$entry"` });
});

test("an entry whose folder is replaced by a symlink after the host checked it is not run", { skip: process.platform === "win32" }, async (t) => {
  await assertSwapNeverRuns(t, { swap: `dir=$(dirname "$entry"); mv "$dir" "$dir.trusted"; ln -s "$(dirname "$tampered")" "$dir"` });
});

test("a CommonJS entry swapped after the host checked it is not run, by content", { skip: process.platform === "win32" }, async (t) => {
  await assertSwapNeverRuns(t, { extension: "cjs", swap: `cp "$tampered" "$entry"` });
});

test("a CommonJS entry replaced by a symlink after the host checked it is not run", { skip: process.platform === "win32" }, async (t) => {
  await assertSwapNeverRuns(t, { extension: "cjs", swap: `rm -f "$entry"; ln -s "$tampered" "$entry"` });
});
