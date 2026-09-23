import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsStore, normalizeRemoteHosts } from "../src/main/services/SettingsStore.ts";
import { RemoteHostsService } from "../src/main/services/RemoteHostsService.ts";

const validHost = {
  id: "gpu-box",
  label: "GPU box",
  sshHost: "gpu.internal.example"
};

test("valid hosts round-trip and optional fields fall away when absent", () => {
  const normalized = normalizeRemoteHosts([
    validHost,
    {
      id: "build-farm",
      label: "Build farm",
      sshHost: "192.168.1.40",
      sshUser: "deploy",
      sshPort: 2222,
      priority: 10,
      maxSessions: 8
    }
  ], []);
  assert.deepEqual(normalized, [
    validHost,
    {
      id: "build-farm",
      label: "Build farm",
      sshHost: "192.168.1.40",
      sshUser: "deploy",
      sshPort: 2222,
      priority: 10,
      maxSessions: 8
    }
  ]);
  assert.equal("sshUser" in normalized[0], false);
  assert.equal("sshPort" in normalized[0], false);
});

test("invalid host entries are dropped, not repaired", () => {
  const normalized = normalizeRemoteHosts([
    validHost,
    { ...validHost, id: "bad-port", sshPort: 70000 },
    { ...validHost, id: "zero-port", sshPort: 0 },
    { ...validHost, id: "empty-label", label: "   " },
    { ...validHost, id: "gpu-box" },
    { ...validHost, id: "spaced-host", sshHost: "gpu.internal.example -oProxyCommand=evil" },
    { ...validHost, id: "newline-host", sshHost: "gpu.internal.example\n" },
    { ...validHost, id: "spaced-user", sshUser: "deploy bot" },
    { ...validHost, id: "bad-priority", priority: 101 },
    { ...validHost, id: "fractional-priority", priority: 1.5 },
    { ...validHost, id: "bad-sessions", maxSessions: 65 },
    { ...validHost, id: "empty-sessions", maxSessions: 0 },
    { ...validHost, id: "no-host", sshHost: "" },
    "nonsense"
  ], []);
  assert.deepEqual(normalized, [validHost]);
});

test("non-array input falls back to the provided default", () => {
  assert.deepEqual(normalizeRemoteHosts(undefined, [validHost]), [validHost]);
  assert.deepEqual(normalizeRemoteHosts("nope", []), []);
});

test("the remote host registry is capped at 512 entries", () => {
  const many = Array.from({ length: 520 }, (_value, index) => ({
    ...validHost,
    id: `host-${index}`,
    label: `Host ${index}`
  }));
  assert.equal(normalizeRemoteHosts(many, []).length, 512);
});

test("remote hosts persist through the settings store and settingsVersion reaches 24", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-settings-remotehosts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory, "en");
  const loaded = await store.load();
  assert.deepEqual(loaded.remoteHosts, []);

  const hosts = [
    { ...validHost },
    {
      id: "build-farm",
      label: "Build farm",
      sshHost: "192.168.1.40",
      sshUser: "deploy",
      sshPort: 2222,
      priority: 10,
      maxSessions: 8
    }
  ];
  await store.update({ remoteHosts: hosts });
  const reloaded = await new SettingsStore(directory, "en").load();
  assert.deepEqual(reloaded.remoteHosts, hosts);

  const persisted = JSON.parse(await (await import("node:fs/promises")).readFile(join(directory, "settings.json"), "utf8"));
  assert.equal(persisted.settingsVersion, 24);
  assert.equal(persisted.remoteHosts.length, 2);
});

test("legacy settings without remoteHosts migrate to an empty registry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-settings-remotehosts-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "settings.json"), JSON.stringify({ settingsVersion: 20 }));
  const loaded = await new SettingsStore(directory, "en").load();
  assert.deepEqual(loaded.remoteHosts, []);
});

test("a zero exit code reports a reachable host with detail ok", async () => {
  const calls = [];
  const service = new RemoteHostsService((host, command, timeoutMs) => {
    calls.push({ host, command, timeoutMs });
    return Promise.resolve({ code: 0, stdout: "canvastty-probe\n", stderr: "" });
  });
  const status = await service.checkConnectivity(validHost);
  assert.deepEqual(status, { hostId: "gpu-box", reachable: true, detail: "ok" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].command, ["echo", "canvastty-probe"]);
  assert.equal(calls[0].timeoutMs, 8000);
  assert.equal(calls[0].host, validHost);
});

test("a failing exit code reports an unreachable host with a stderr excerpt", async () => {
  const service = new RemoteHostsService(() => (
    Promise.resolve({ code: 255, stdout: "", stderr: "ssh: connect to host gpu.internal.example port 22: Connection refused\r\n" })
  ));
  const status = await service.checkConnectivity(validHost);
  assert.equal(status.hostId, "gpu-box");
  assert.equal(status.reachable, false);
  assert.equal(status.detail, "ssh: connect to host gpu.internal.example port 22: Connection refused");
});

test("detail excerpts are trimmed to 300 characters", async () => {
  const service = new RemoteHostsService(() => (
    Promise.resolve({ code: 255, stdout: "", stderr: "x".repeat(1_000) })
  ));
  const status = await service.checkConnectivity(validHost);
  assert.equal(status.reachable, false);
  assert.equal(status.detail.length, 300);
});

test("a throwing runner reports an unreachable host instead of rejecting", async () => {
  const service = new RemoteHostsService(() => Promise.reject(new Error("probe timed out")));
  const status = await service.checkConnectivity(validHost);
  assert.equal(status.hostId, "gpu-box");
  assert.equal(status.reachable, false);
  assert.equal(status.detail, "probe timed out");
});

test("an invalid host object never reaches the runner and explains why", async () => {
  let calls = 0;
  const service = new RemoteHostsService(() => {
    calls += 1;
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  });
  const status = await service.checkConnectivity({ ...validHost, sshHost: "gpu.internal.example rm -rf" });
  assert.equal(status.hostId, "gpu-box");
  assert.equal(status.reachable, false);
  assert.match(status.detail, /sshHost/);
  assert.equal(calls, 0);
});

test("constructing the service is inert and only probes on demand", async () => {
  const service = new RemoteHostsService();
  assert.equal(typeof service.checkConnectivity, "function");
});
