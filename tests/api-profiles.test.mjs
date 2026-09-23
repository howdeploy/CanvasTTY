import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsStore, normalizeApiProfiles } from "../src/main/services/SettingsStore.ts";
import {
  API_PROFILE_PRESETS,
  API_PROFILE_PROTOCOLS,
  PROVIDER_SECRET_IDS
} from "../src/shared/contracts.ts";

const validProfile = {
  id: "openai",
  name: "OpenAI",
  protocol: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  secretRef: "OPENAI_API_KEY"
};

test("api profile presets only reference catalog secrets, protocols, and https endpoints", () => {
  assert.ok(API_PROFILE_PRESETS.length >= 10);
  for (const preset of API_PROFILE_PRESETS) {
    assert.ok(PROVIDER_SECRET_IDS.includes(preset.secretRef), preset.id);
    assert.ok(API_PROFILE_PROTOCOLS.includes(preset.protocol), preset.id);
    assert.ok(preset.id.length > 0 && preset.name.length > 0, preset.id);
    if (preset.baseUrl !== undefined) assert.match(preset.baseUrl, /^https:\/\//u);
  }
  const ids = API_PROFILE_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("valid profiles round-trip and invalid entries are dropped, not repaired", () => {
  const normalized = normalizeApiProfiles([
    validProfile,
    { ...validProfile, id: "openai" },
    { ...validProfile, id: "no-secret", secretRef: "NOT_A_KEY" },
    { ...validProfile, id: "bad-protocol", protocol: "grpc" },
    { ...validProfile, id: "no-name", name: "  " },
    { ...validProfile, id: "http-url", baseUrl: "http://insecure.example" },
    "nonsense"
  ], []);
  assert.deepEqual(normalized, [validProfile]);
});

test("optional fields fall away when empty", () => {
  const normalized = normalizeApiProfiles([
    { ...validProfile, defaultModel: "  " }
  ], []);
  assert.deepEqual(normalized, [{ ...validProfile }]);
  assert.equal("defaultModel" in normalized[0], false);
});

test("non-array input falls back to the provided default", () => {
  assert.deepEqual(normalizeApiProfiles(undefined, [validProfile]), [validProfile]);
  assert.deepEqual(normalizeApiProfiles("nope", []), []);
});

test("the profile catalog is capped at 32 entries", () => {
  const many = Array.from({ length: 40 }, (_value, index) => ({
    ...validProfile,
    id: `profile-${index}`,
    name: `Profile ${index}`
  }));
  assert.equal(normalizeApiProfiles(many, []).length, 32);
});

test("api profiles persist through the settings store and settingsVersion reaches 20", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-settings-apiprofiles-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory, "en");
  const loaded = await store.load();
  assert.deepEqual(loaded.apiProfiles, []);

  await store.update({ apiProfiles: [{ ...validProfile }, {
    id: "custom-anthropic",
    name: "Internal gateway",
    protocol: "anthropic-compatible",
    baseUrl: "https://gw.internal.example/anthropic",
    secretRef: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-6"
  }] });
  const reloaded = await new SettingsStore(directory, "en").load();
  assert.deepEqual(reloaded.apiProfiles[0], validProfile);
  assert.equal(reloaded.apiProfiles[1].defaultModel, "claude-sonnet-4-6");

  const persisted = JSON.parse(await (await import("node:fs/promises")).readFile(join(directory, "settings.json"), "utf8"));
  assert.equal(persisted.settingsVersion, 20);
  assert.equal(persisted.apiProfiles.length, 2);
});

test("legacy settings without apiProfiles migrate to an empty catalog", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-settings-apiprofiles-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "settings.json"), JSON.stringify({ settingsVersion: 19 }));
  const loaded = await new SettingsStore(directory, "en").load();
  assert.deepEqual(loaded.apiProfiles, []);
});
