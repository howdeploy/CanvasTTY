import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { SettingsStore, normalizeSettings } from "../src/main/services/SettingsStore.ts";
import {
  CANVAS_LAUNCHER_ITEMS,
  DATA_CLASSES,
  DATA_CLASS_RANK,
  PROVIDER_DATA_HANDLING,
  dataClassSatisfies,
  providerMaxDataClass
} from "../src/shared/contracts.ts";

// Expected derived tiers for every provider's DEFAULT data-handling path.
const EXPECTED_MAX = {
  codex: "D1",
  claude: "D1",
  grok: "D1",
  qwen: "D1",
  kimi: "D1",
  opencode: "D0",
  hermes: "D0",
  omp: "D0",
  pi: "D0",
  cursor: "D0",
  minimax: "D1",
  devin: "D2",
  antigravity: "D2"
};

// The profile fields that produce those tiers, restated independently so the
// matrix and the table cannot drift apart silently.
const EXPECTED_PROFILES = {
  codex: { training: "opt-out", retention: "persistent", thirdPartyProcessing: "yes", contractualMode: "consumer" },
  claude: { training: "opt-out", retention: "persistent", thirdPartyProcessing: "yes", contractualMode: "consumer" },
  grok: { training: "opt-out", retention: "bounded", thirdPartyProcessing: "yes", contractualMode: "consumer" },
  qwen: { training: "may-train", retention: "persistent", thirdPartyProcessing: "yes", contractualMode: "consumer" },
  kimi: { training: "may-train", retention: "persistent", thirdPartyProcessing: "yes", contractualMode: "consumer" },
  opencode: { training: "unknown", retention: "unknown", thirdPartyProcessing: "unknown", contractualMode: "consumer" },
  hermes: { training: "unknown", retention: "unknown", thirdPartyProcessing: "unknown", contractualMode: "consumer" },
  omp: { training: "unknown", retention: "unknown", thirdPartyProcessing: "unknown", contractualMode: "consumer" },
  pi: { training: "unknown", retention: "unknown", thirdPartyProcessing: "unknown", contractualMode: "consumer" },
  cursor: { training: "unknown", retention: "persistent", thirdPartyProcessing: "yes", contractualMode: "consumer" },
  minimax: { training: "may-train", retention: "unknown", thirdPartyProcessing: "yes", contractualMode: "api" },
  devin: { training: "none", retention: "bounded", thirdPartyProcessing: "yes", contractualMode: "business" },
  antigravity: { training: "none", retention: "bounded", thirdPartyProcessing: "yes", contractualMode: "consumer" }
};

test("the provider tier matrix is derived from the profile table and cannot drift", () => {
  const providers = Object.keys(EXPECTED_MAX);
  assert.deepEqual(
    [...providers].sort(),
    CANVAS_LAUNCHER_ITEMS.filter((id) => id !== "terminal").sort()
  );
  for (const provider of providers) {
    const profile = PROVIDER_DATA_HANDLING[provider];
    assert.ok(profile, provider);
    assert.equal(providerMaxDataClass(provider), EXPECTED_MAX[provider], provider);

    const expected = EXPECTED_PROFILES[provider];
    assert.equal(profile.training, expected.training, `${provider} training`);
    assert.equal(profile.retention, expected.retention, `${provider} retention`);
    assert.equal(profile.thirdPartyProcessing, expected.thirdPartyProcessing, `${provider} thirdPartyProcessing`);
    assert.equal(profile.contractualMode, expected.contractualMode, `${provider} contractualMode`);

    // Fact must stay distinguishable from guess: every entry carries a
    // verification date and at least one https source.
    assert.equal(profile.verifiedAt, "2026-09-21", provider);
    assert.ok(Array.isArray(profile.sources) && profile.sources.length > 0, provider);
    for (const source of profile.sources) assert.match(source, /^https:\/\//u, provider);
  }
});

test("dataClassSatisfies answers every class pair by rank", () => {
  assert.deepEqual(DATA_CLASSES, ["D0", "D1", "D2", "D3"]);
  assert.deepEqual(DATA_CLASSES.map((dataClass) => DATA_CLASS_RANK[dataClass]), [0, 1, 2, 3]);
  for (const required of DATA_CLASSES) {
    for (const allowed of DATA_CLASSES) {
      assert.equal(
        dataClassSatisfies(required, allowed),
        DATA_CLASS_RANK[required] <= DATA_CLASS_RANK[allowed],
        `${required} against ${allowed}`
      );
    }
  }
});

test("defaultDataClass defaults to D2, round-trips, and falls back on invalid tiers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-settings-dataclass-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory, "en");
  const loaded = await store.load();
  assert.equal(loaded.defaultDataClass, "D2");

  await store.update({ defaultDataClass: "D3" });
  const persisted = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
  assert.equal(persisted.settingsVersion, 24);
  assert.equal(persisted.defaultDataClass, "D3");
  assert.equal((await new SettingsStore(directory, "en").load()).defaultDataClass, "D3");

  // An unparseable tier reads as confidential, never as public.
  assert.equal((await store.update({ defaultDataClass: "top-secret" })).defaultDataClass, "D2");
  assert.equal(normalizeSettings({ defaultDataClass: "D9" }, loaded).defaultDataClass, "D2");
  assert.equal(normalizeSettings({ defaultDataClass: 7 }, loaded).defaultDataClass, "D2");
});

test("legacy version-21 settings migrate to defaultDataClass D2 and persist version 24", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-settings-dataclass-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "settings.json"), JSON.stringify({ settingsVersion: 21 }));
  const loaded = await new SettingsStore(directory, "en").load();
  assert.equal(loaded.defaultDataClass, "D2");
  const persisted = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
  assert.equal(persisted.settingsVersion, 24);
  assert.equal(persisted.defaultDataClass, "D2");
});

function fakeSpawner(calls) {
  return (command, args, options) => {
    const process = {
      pid: 30_000 + calls.length,
      write() {},
      resize() {},
      kill() {},
      pause() {},
      resume() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; }
    };
    calls.push({ command, args, options });
    return process;
  };
}

function availableRegistry() {
  return {
    get(provider) {
      return {
        state: "available",
        provider,
        executable: `/resolved/${provider}`,
        launcher: "native",
        environment: { PATH: "/resolved:/usr/bin" },
        checked: [{ path: `/resolved/${provider}`, result: "selected" }]
      };
    },
    snapshot() { return {}; }
  };
}

function fixture(options) {
  const calls = [];
  const terminals = new TerminalManager(
    () => undefined,
    availableRegistry(),
    undefined,
    undefined,
    true,
    fakeSpawner(calls)
  );
  const control = new AgentControlService(terminals, undefined, options);
  return { calls, terminals, control };
}

function parentUnder(terminals) {
  return terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
}

test("spawn enforces the confidentiality tier before anything launches", () => {
  const { calls, terminals, control } = fixture();
  const parent = parentUnder(terminals);
  const before = calls.length;

  // D2 on a D1-capped provider names both sides of the violation and never
  // reaches the launch layer.
  assert.throws(
    () => control.spawn({ parentSessionId: parent.id, provider: "minimax", cwd: process.cwd(), dataClass: "D2" }),
    /Provider minimax handles at most D1; this task is D2\./u
  );
  // D3 is beyond every default cloud path; only self-hosted org overrides
  // reach it.
  assert.throws(
    () => control.spawn({ parentSessionId: parent.id, provider: "devin", cwd: process.cwd(), dataClass: "D3" }),
    /Provider devin handles at most D2; this task is D3\./u
  );
  assert.equal(calls.length, before);

  const child = control.spawn({
    parentSessionId: parent.id,
    provider: "minimax",
    cwd: process.cwd(),
    dataClass: "D1"
  });
  assert.equal(child.provider, "minimax");
  assert.equal(child.role, "subagent");

  // D0 (public) data may flow to any provider, including unverified ones.
  for (const provider of ["cursor", "opencode", "minimax", "devin"]) {
    const spawned = control.spawn({
      parentSessionId: parent.id,
      provider,
      cwd: process.cwd(),
      dataClass: "D0"
    });
    assert.equal(spawned.provider, provider);
  }
  assert.equal(calls.length, before + 5);
  terminals.disposeAll();
});

test("a defaultDataClass option classifies requests that carry no dataClass", () => {
  const { terminals, control } = fixture({ defaultDataClass: "D2" });
  const parent = parentUnder(terminals);
  assert.throws(
    () => control.spawn({ parentSessionId: parent.id, provider: "qwen", cwd: process.cwd() }),
    /Provider qwen handles at most D1; this task is D2\./u
  );
  const child = control.spawn({
    parentSessionId: parent.id,
    provider: "qwen",
    cwd: process.cwd(),
    dataClass: "D1"
  });
  assert.equal(child.provider, "qwen");
  terminals.disposeAll();
});
