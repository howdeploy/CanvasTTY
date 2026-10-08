import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore, normalizeSettings } from "../src/main/services/SettingsStore.ts";
import { experimentalModelRouter } from "../src/main/services/ModelRouter.ts";
import { EnvironmentRegistry } from "../src/main/services/EnvironmentRegistry.ts";

test("experimental setting defaults off, rejects coercion and persists explicit on/off", async t => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-experimental-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = new SettingsStore(dir, "en");
  assert.equal((await settings.load()).experimentalBacklogEnabled, false);
  for (const value of [undefined, null, "true", 1, {}])
    assert.equal(normalizeSettings({ experimentalBacklogEnabled: value }, settings.get()).experimentalBacklogEnabled, false);
  await settings.update({ experimentalBacklogEnabled: true });
  assert.equal((await new SettingsStore(dir, "ru").load()).experimentalBacklogEnabled, true);
  await settings.update({ experimentalBacklogEnabled: false });
  assert.equal(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).experimentalBacklogEnabled, false);
  const legacy = settings.get(); delete legacy.experimentalBacklogEnabled;
  await writeFile(join(dir, "settings.json"), JSON.stringify(legacy));
  assert.equal((await new SettingsStore(dir, "en").load()).experimentalBacklogEnabled, false);
});

test("router makes no call by default, accepts opt-in, and rejects an answer after opt-out", async () => {
  let enabled = false, calls = 0;
  const answer = { candidateId: "fixture", reason: "fixture" };
  const router = { route: async () => { calls++; return answer; } };
  await assert.rejects(experimentalModelRouter(router).route({}), /disabled/);
  const gated = experimentalModelRouter(router, () => enabled);
  await assert.rejects(gated.route({}), /disabled/);
  assert.equal(calls, 0);
  enabled = true;
  assert.deepEqual(await gated.route({}), answer);
  const pending = experimentalModelRouter({ route: async () => { enabled = false; return answer; } }, () => enabled);
  await assert.rejects(pending.route({}), /disabled/);
  await assert.rejects(gated.route({}), /disabled/);
  assert.equal(calls, 1);
});

function environments(experimentalEnabled, answer) {
  const calls = [];
  const kinds = ["worktree", "container", "remote", "ssh", "ssh-host", "remote-container"];
  const registry = new EnvironmentRegistry({
    experimentalEnabled,
    providers: () => [{ pluginId: "fixture", pluginName: "Fixture", serviceId: "env", secrets: false, kinds: kinds.map(kind => ({ kind, label: kind, executionLocation: ["worktree", "container"].includes(kind) ? "local" : "remote" })) }],
    call: async (_plugin, _service, method, params) => {
      calls.push({ method, params });
      if (answer) return answer(method, params);
      return method.endsWith("prepare") ? { ref: {}, label: "Fixture" }
        : method.endsWith("resume") ? { ok: true }
        : method.endsWith("wrap") ? { command: process.execPath, args: [] } : {};
    },
    secret: async () => null,
  });
  return { registry, calls };
}
const ref = kind => ({ pluginId: "fixture", kind, ref: {}, label: "Fixture" });
const prepare = (registry, kind) => registry.prepare({ sessionId: "s", provider: "terminal", cwd: tmpdir(), choice: ref(kind) });
const wrap = (registry, kind) => registry.wrap(ref(kind), { sessionId: "s", provider: "terminal", launch: { command: process.execPath, args: [], env: {}, cwd: tmpdir() }, secretEnvNames: [], takenEnv: new Set(), path: process.env.PATH });

test("remote/SSH launch and restore fail closed by default; local worktrees and containers work", async () => {
  const { registry, calls } = environments();
  for (const kind of ["remote", "ssh", "ssh-host", "remote-container"]) {
    assert.equal(registry.available(ref(kind)), false);
    assert.throws(() => registry.normalizeChoice("terminal", ref(kind)), /disabled/);
    assert.equal((await prepare(registry, kind)).ok, false);
    assert.equal((await registry.resume(ref(kind), "s")).ok, false);
    assert.equal((await wrap(registry, kind)).ok, false);
  }
  assert.equal(calls.length, 0);
  for (const kind of ["worktree", "container"]) {
    assert.equal(registry.available(ref(kind)), true);
    assert.equal((await prepare(registry, kind)).ok, true);
    assert.equal((await wrap(registry, kind)).ok, true);
  }
});

test("remote opt-in is read at runtime and cleanup remains possible after opt-out", async () => {
  let enabled = true;
  const { registry, calls } = environments(() => enabled);
  assert.equal((await prepare(registry, "ssh-host")).ok, true);
  assert.equal((await registry.resume(ref("ssh-host"), "s")).ok, true);
  assert.equal((await wrap(registry, "ssh-host")).ok, true);
  enabled = false;
  assert.equal((await wrap(registry, "ssh-host")).ok, false);
  await registry.release(ref("ssh-host"), "s", { keepData: true, reason: "closed" });
  assert.equal(calls.at(-1).method, "canvastty.environment.release");
});

test("disabling during remote prepare/resume/wrap rejects the asynchronous result", async () => {
  for (const step of ["prepare", "resume", "wrap"]) {
    let enabled = true;
    const { registry, calls } = environments(() => enabled, method => {
      if (method.endsWith(step)) enabled = false;
      return step === "prepare" ? { ref: {}, label: "Fixture" } : step === "resume" ? { ok: true } : { command: process.execPath, args: [] };
    });
    const result = step === "prepare" ? await prepare(registry, "remote")
      : step === "resume" ? await registry.resume(ref("remote"), "s") : await wrap(registry, "remote");
    assert.equal(result.ok, false, step);
    assert.equal(calls.at(-1).method, "canvastty.environment.release");
  }
});
